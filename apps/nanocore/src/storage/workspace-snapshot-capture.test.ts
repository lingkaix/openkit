// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import * as durableBytes from '@openkit/storage';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBetterAuth } from '../auth/better-auth.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { isScopeAdmitted, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { createLightApp, createRecord } from '../generative-kernel/commands.js';
import { readAssistantTaskHandoffSource } from '../internal-agents/assistant-handoff-source.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { publishWorkspaceNotebook } from '../knowledge/notebook-publication.js';
import { readWorkspaceNotebookAdmission } from '../knowledge/notebook-workspace-admission.js';
import { AutomationStore } from '../lib/automation-store.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { projectOperationError } from '../operation-error.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { claimOrRefuseGrant, pendingRequestItemId } from '../runtime/pending-requests.js';
import { startRecurringScheduleService } from '../runtime/recurring-schedule-service.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from '../runtime/scheduler-dispatch-loop.js';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from '../runtime/worker-backend-sessions.js';
import { recordWorkspaceApplyPlan } from '../runtime/workspace-apply-plans.js';
import { recordWorkspaceApplyResult } from '../runtime/workspace-apply-results.js';
import * as schedulerRecords from '../scheduler-records.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { createTestGatewayConfig } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { listWorkspaceDeletionRequests } from '../workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  getWorkspaceRegistryLifecycleFact,
} from '../workspace-sharing.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import * as databaseOwner from './db.js';
import { bindWorkspaceSqlite, openCoreDb, openWorkspaceDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import * as migrationOwner from './migrate.js';
import { createWorkspaceBackup, readBlockers } from './workspace-backup.js';
import {
  type VerifiedWorkspaceBackupBundle,
  withVerifiedWorkspaceBackupBundle,
  withVerifiedWorkspaceSnapshotSource,
} from './workspace-backup-bundle.js';
import * as captureProtection from './workspace-capture-protection.js';
import { inspectCapture, protectCapture } from './workspace-capture-protection.js';
import { nativeProductScope } from './workspace-file-records.js';
import { readRecoveryAdmission } from './workspace-recovery-admissions.js';

const namespaceSyncFault = vi.hoisted(() => ({
  beforeSync: undefined as ((descriptor: number) => void) | undefined,
}));

// Inject at the public filesystem durability boundary, without substituting a namespace owner.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      namespaceSyncFault.beforeSync?.(args[0]);
      return actual.fsyncSync(...args);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (namespaceSyncFault.beforeSync) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          namespaceSyncFault.beforeSync?.(handle.fd);
          await sync();
        };
      }
      return handle;
    },
  };
});

const roots: string[] = [];
const databaseHandles: { readonly sqlite: Database.Database }[] = [];
const workspaceId = DEMO_WORKSPACE_ID;
const release = { version: '0.1.0-c-a-oracle', buildId: 'independent-snapshot-oracle' };
const formats = {
  'drizzle.workspace': 16,
  'drizzle.app.1': 1,
  'drizzle.app.2': 2,
  'drizzle.app.3': 3,
  'drizzle.app.4': 4,
  'drizzle.app.5': 5,
  'light-app.kernel.1': 1,
  'light-app.kernel.2': 2,
};
const unavailable = { kind: 'unavailable', reason: 'unavailable', actions: [] };

/** Computes expected identity from fixture bytes without the subject's digest helper. */
function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Observes source bytes and names without following links or initializing missing authority. */
function tree(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [
        path.slice(root.length),
        entry.isFile()
          ? digest(readFileSync(path))
          : entry.isDirectory()
            ? 'directory'
            : 'nonregular',
      ];
    })
  );
}

/** A read-only existing database observation proves the actual native rows in the cut. */
function databaseRows(bytes: Buffer | string, root: string): Record<string, unknown[]> {
  const path = typeof bytes === 'string' ? bytes : join(root, `observe-${randomUUID()}.sqlite`);
  if (typeof bytes !== 'string') writeFileSync(path, bytes);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ])
    );
  } finally {
    db.close();
  }
}

/** Reads only the callback-owned, independently verified file interface. */
async function bytes(bundle: VerifiedWorkspaceBackupBundle, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of bundle.readFile(path)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Uses the existing native demo builder, then real owner operations for every scenario. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'c-a-snapshot-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  databaseHandles.push(coreDb);
  const ownerId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: ownerId });
  const mutationAdmission = new WorkspaceMutationAdmission();
  const stagingParent = join(root, 'staging');
  mkdirSync(stagingParent);
  const policy = {
    stagingParent,
    admission: new FileStorageAdmission(root, () => 0n),
    expectedRelease: release,
    supportedDatabaseFormats: formats,
  };
  const source = { kind: 'live-workspace' as const, dataRoot, coreDb, store, mutationAdmission };
  const deploymentId = readDataRootLayoutMarker(dataRoot).deploymentId;
  const input = (backupId = allocateEntityId('wsbak')) => ({
    ...policy,
    source,
    workspaceId,
    expectedSourceDeploymentId: deploymentId,
    backupId,
    purpose: 'backup' as const,
    bundleRoot: join(dataRoot, 'server', 'backups', 'workspaces', workspaceId, backupId),
  });
  const read = <T>(
    backupId: string,
    consume: (bundle: VerifiedWorkspaceBackupBundle) => Promise<T>
  ) =>
    withVerifiedWorkspaceSnapshotSource(
      { ...policy, dataRoot, source: { kind: 'local-snapshot' as const, workspaceId, backupId } },
      consume
    );
  return {
    root,
    dataRoot,
    workspaceRoot: join(dataRoot, 'workspaces', workspaceId),
    store,
    coreDb,
    ownerId,
    mutationAdmission,
    policy,
    source,
    input,
    read,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Each refusal must settle while its blocker remains unresolved, without elapsed-time polling. */
async function refusal(f: Fixture, input = f.input()) {
  const before = tree(f.workspaceRoot);
  const result = await createWorkspaceBackup(input).then(
    () => null,
    (error: unknown) => error
  );
  expect(result).toMatchObject({ code: 'workspace_blocked' });
  expect(tree(f.workspaceRoot)).toEqual(before);
  expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
  const db = openWorkspaceDb(f.dataRoot, workspaceId);
  try {
    expect(inspectCapture(db, workspaceId, input.backupId)).toBeNull();
  } finally {
    db.sqlite.close();
  }
  expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
  return result;
}

afterEach(async () => {
  namespaceSyncFault.beforeSync = undefined;
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const db of databaseHandles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('C-a snapshot authoritative blockers', () => {
  it('lists every live Turn and refuses without interrupting, waiting or accepting pins', async () => {
    const f = await fixture();
    const first = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'First live work', {
      kind: 'user',
      id: f.ownerId,
    });
    const otherThread = await f.store.createThread(workspaceId, 'Second active thread');
    const second = await f.store.createTurn(workspaceId, otherThread.id, 'Second live work', {
      kind: 'user',
      id: f.ownerId,
    });
    const blockers = readBlockers({ ...f, workspaceId });
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn',
          reason: 'active-work',
          reference: { threadId: first.threadId, turnId: first.id },
        }),
        expect.objectContaining({
          kind: 'turn',
          reason: 'active-work',
          reference: { threadId: second.threadId, turnId: second.id },
        }),
      ])
    );
    await refusal(f);
    expect(f.store.getTurnById(first.id)).toEqual(first);
    expect(f.store.getTurnById(second.id)).toEqual(second);
    f.coreDb.sqlite.close();
  });

  it('collapses hidden blocker cardinality to one identical identity-free sentinel', async () => {
    const f = await fixture();
    const privateThread = await f.store.createThread(
      workspaceId,
      'Private secret title',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: f.ownerId }
    );
    const first = await f.store.createTurn(workspaceId, privateThread.id, 'Private secret input', {
      kind: 'user',
      id: f.ownerId,
    });
    const select = () => readBlockers({ ...f, workspaceId, canReadThread: () => false });
    expect(select()).toEqual([unavailable]);
    const queued = createSchedulerAdmissionEntry(f.coreDb, {
      queueEntryId: randomUUID(),
      backendId: 'nanohost',
      workspaceId,
      threadId: privateThread.id,
      turnId: first.id,
      turnInput: 'Private queued input',
      requestedAgentId: 'agent_private',
      triggerActor: { kind: 'user', id: f.ownerId },
    });
    createSchedulerExecutionAttempt(f.coreDb, {
      entry: queued,
      attemptId: allocateEntityId('attempt'),
      preparationInput: { admission: queued },
      now: () => new Date().toISOString(),
    });
    expect(select()).toEqual([unavailable]);
    expect(JSON.stringify(select())).not.toContain(privateThread.id);
    expect(JSON.stringify(select())).not.toContain(first.id);
    f.coreDb.sqlite.close();
  });

  it('keeps queued admission and sealed Turn history inert but an open attempt blocks', async () => {
    const f = await fixture();
    const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'History with queued work', {
      kind: 'user',
      id: f.ownerId,
    });
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      queueEntryId: randomUUID(),
      backendId: 'nanohost',
      workspaceId,
      threadId: DEMO_THREAD_ID,
      turnId: turn.id,
      turnInput: 'Queued only',
      requestedAgentId: 'agent_fixture',
      triggerActor: { kind: 'user', id: f.ownerId },
    });
    await f.store.completeTurn(turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);
    const attempt = createSchedulerExecutionAttempt(f.coreDb, {
      entry,
      attemptId: allocateEntityId('attempt'),
      preparationInput: { admission: entry },
      now: () => new Date().toISOString(),
    });
    expect(readBlockers({ ...f, workspaceId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'worker-attempt',
          reference: expect.objectContaining({ attemptId: attempt.attemptId }),
        }),
      ])
    );
    await refusal(f);
    f.coreDb.sqlite.close();
  });

  it('distinguishes passive Pending history from an undisposed claimed execution', async () => {
    const f = await fixture();
    const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Approval history', {
      kind: 'user',
      id: f.ownerId,
    });
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    const requestId = randomUUID();
    try {
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId,
        workspaceId,
        threadId: DEMO_THREAD_ID,
        raisingTurnId: turn.id,
        requestItemId: pendingRequestItemId(requestId, 'request'),
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: f.ownerId,
        governedIntent: { operation: 'fixture.effect', input: 'Approval history only' },
        approval: {
          kind: 'destructive-action',
          title: 'Retained approval',
          description: 'Do not execute during backup.',
        },
        now: new Date().toISOString(),
      });
      await f.store.completeTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      expect(readBlockers({ ...f, workspaceId })).toEqual([]);
      claimOrRefuseGrant(
        db.sqlite,
        requestId,
        { kind: 'user', id: f.ownerId },
        new Date().toISOString(),
        () => ({ outcome: 'claim' })
      );
      expect(readBlockers({ ...f, workspaceId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'pending-request',
            reference: expect.objectContaining({ pendingRequestId: requestId }),
          }),
        ])
      );
      await refusal(f);
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });

  it('blocks unsettled CapabilityCall publication even after the Turn is terminal', async () => {
    const f = await fixture();
    const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Unsettled effect', {
      kind: 'user',
      id: f.ownerId,
    });
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      await startCapabilityCall({
        workspaceDb: db,
        workspaceId,
        threadId: DEMO_THREAD_ID,
        turnId: turn.id,
        callId: allocateEntityId('cap'),
        authorityActor: { kind: 'user', id: f.ownerId },
        family: 'llm',
        operation: 'responses.create',
        capabilityId: 'llm.responses',
        requestId: randomUUID(),
        redactionClass: 'metadata-only',
      });
      await f.store.completeTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      expect(readBlockers({ ...f, workspaceId })).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'publication' })])
      );
      await refusal(f);
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });

  it('blocks an unfinished capture and fails closed on unreadable native authority', async () => {
    const f = await fixture();
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    const captureId = allocateEntityId('wsbak');
    try {
      protectCapture(db, workspaceId, captureId);
      expect(readBlockers({ ...f, workspaceId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'snapshot', reference: { backupId: captureId } }),
        ])
      );
      await refusal(f);
      const spy = vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation(() => {
        throw new Error('Private unreadable authority path');
      });
      expect(readBlockers({ ...f, workspaceId })).toEqual([unavailable]);
      spy.mockRestore();
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
});

describe('C-a manual recovery closure after restart', () => {
  it.each([
    'manual-active-capture',
    'prepared-MOVE',
  ] as const)('reconstructs %s exclusion before Core recurrence while a healthy sibling remains usable', async (kind) => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Healthy recurring sibling');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    const siblingThread = await f.store.createThread(sibling.id, 'Sibling recurring destination');
    const retainedSession = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId,
      threadId: DEMO_THREAD_ID,
      agentId: 'agent_codex_host',
      status: 'closed',
      message: 'Retained before manual capture quarantine.',
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
    });
    const beforeTime = '2026-10-27T00:00:00.000Z';
    const due = '2099-01-01T00:00:00.000Z';
    const schedules = new AutomationStore(f.coreDb, f.mutationAdmission, () => beforeTime);
    const target = schedules.createAutomation(f.ownerId, {
      workspaceId,
      threadId: DEMO_THREAD_ID,
      name: 'Manual recovery target recurrence',
      intervalSeconds: 60,
      prompt: 'Do not mutate quarantined target.',
    });
    const targetActive = schedules.updateAutomation(f.ownerId, target.id, {
      expectedRevision: target.revision,
      status: 'active',
      scheduledAt: due,
    });
    const healthy = schedules.createAutomation(f.ownerId, {
      workspaceId: sibling.id,
      threadId: siblingThread.id,
      name: 'Healthy sibling recurrence',
      intervalSeconds: 60,
      prompt: 'Healthy sibling may progress.',
    });
    schedules.updateAutomation(f.ownerId, healthy.id, {
      expectedRevision: healthy.revision,
      status: 'active',
      scheduledAt: due,
    });
    const input = { ...f.input(), purpose: 'move' as const };
    if (kind === 'prepared-MOVE') {
      const captured = await createWorkspaceBackup(input);
      expect(captured.disposition).toBe('prepared');
      expect(readRecoveryAdmission(f.coreDb, input.backupId)).toMatchObject({
        state: 'prepared',
        purpose: 'move',
      });
    } else {
      const db = openWorkspaceDb(f.dataRoot, workspaceId);
      try {
        protectCapture(db, workspaceId, input.backupId);
      } finally {
        db.sqlite.close();
      }
    }
    const beforeAdmission = readRecoveryAdmission(f.coreDb, input.backupId);
    const inspectDb = bindWorkspaceSqlite(
      new Database(workspaceDbPath(f.dataRoot, workspaceId), {
        readonly: true,
        fileMustExist: true,
      }),
      f.dataRoot,
      workspaceId
    );
    const beforePin = inspectCapture(inspectDb, workspaceId, input.backupId);
    inspectDb.sqlite.close();
    expect(beforePin).toMatchObject({ state: 'active' });
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    const coreDb = openCoreDb(f.dataRoot);
    databaseHandles.push(coreDb);
    const mutationAdmission = new WorkspaceMutationAdmission();
    const store = new FsStore({ dataRoot: f.dataRoot });
    store.setWorkspaceMutationAdmission(mutationAdmission);
    // Existing recovery census owns quarantine and the reconstructed process-local gate.
    (
      restoreWorkspaceRecoveryAdmission as (
        core: typeof coreDb,
        gate?: WorkspaceMutationAdmission
      ) => void
    )(coreDb, mutationAdmission);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
    expect(scopeAdmissionFailures(f.dataRoot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'workspace', id: workspaceId, check: 'recovery' }),
      ])
    );
    expect(mutationAdmission.isClosed(workspaceId)).toBe(true);
    expect(mutationAdmission.enter(workspaceId)).toBeNull();
    expect(isScopeAdmitted(f.dataRoot, 'workspace', sibling.id)).toBe(true);
    expect(mutationAdmission.isClosed(sibling.id)).toBe(false);
    const targetCoreRows = () =>
      Object.fromEntries(
        Object.entries(databaseRows(coreDb.sqlite.name, f.root)).map(([table, rows]) => [
          table,
          rows.filter((row) => {
            const value = row as Record<string, unknown>;
            return value.workspace_id === workspaceId || value.workspaceId === workspaceId;
          }),
        ])
      );
    const beforeRows = targetCoreRows();
    const beforeSource = tree(f.workspaceRoot);
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    const database = `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`;
    const client = getControlStoreWorkerClient();
    const coldOpenAndCheckpoint = async (selectedWorkspaceId: string) => {
      const scope = nativeProductScope(f.dataRoot, {
        kind: 'workspace',
        workspaceId: selectedWorkspaceId,
      });
      const selectedDatabase = `workspace:${scope.path}`;
      await client.open({
        database: selectedDatabase,
        path: scope.path,
        dataRoot: f.dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      // This command is attempted only if the real cold open acknowledged.
      return client.checkpoint(selectedDatabase);
    };
    await expect(coldOpenAndCheckpoint(workspaceId)).rejects.toMatchObject({
      code: 'workspace_frozen',
    });
    await expect(
      store.updateAgentSession(retainedSession.id, { message: 'Must not settle through capture.' })
    ).rejects.toThrow();
    expect(
      post.mock.calls.filter(
        ([message]) =>
          message !== null && typeof message === 'object' && message.database === database
      )
    ).toHaveLength(0);
    expect(tree(f.workspaceRoot)).toEqual(beforeSource);
    await expect(coldOpenAndCheckpoint(sibling.id)).resolves.toBeDefined();
    const siblingDatabase = `workspace:${workspaceDbPath(f.dataRoot, sibling.id)}`;
    const siblingOperations = post.mock.calls.flatMap(([message]) =>
      message !== null && typeof message === 'object' && message.database === siblingDatabase
        ? [message.operation]
        : []
    );
    expect(siblingOperations).toContain('open');
    expect(siblingOperations).toContain('checkpoint');
    expect(tree(f.workspaceRoot)).toEqual(beforeSource);
    const restartedSchedules = new AutomationStore(coreDb, mutationAdmission, () => due);
    expect(() =>
      restartedSchedules.createAutomation(f.ownerId, {
        workspaceId,
        threadId: DEMO_THREAD_ID,
        name: 'Must remain refused',
        intervalSeconds: 60,
        prompt: 'No restart bypass.',
      })
    ).toThrow(/fenced/);
    expect(() =>
      restartedSchedules.updateAutomation(f.ownerId, target.id, {
        expectedRevision: targetActive.revision,
        status: 'paused',
      })
    ).toThrow(/fenced/);
    const candidates = restartedSchedules.collectScanCandidates(due);
    expect(candidates.map((candidate) => candidate.scheduleId)).toEqual([healthy.id]);
    expect(targetCoreRows()).toEqual(beforeRows);
    expect(tree(f.workspaceRoot)).toEqual(beforeSource);
    expect(readRecoveryAdmission(coreDb, input.backupId)).toEqual(beforeAdmission);
    const retainedDb = bindWorkspaceSqlite(
      new Database(workspaceDbPath(f.dataRoot, workspaceId), {
        readonly: true,
        fileMustExist: true,
      }),
      f.dataRoot,
      workspaceId
    );
    databaseHandles.push(retainedDb);
    expect(inspectCapture(retainedDb, workspaceId, input.backupId)).toEqual(beforePin);
    expect(mutationAdmission.isClosed(workspaceId)).toBe(true);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
    const siblingRelease = mutationAdmission.enter(sibling.id);
    expect(siblingRelease).not.toBeNull();
    siblingRelease!();
  });
});

describe('C-a additional owner families', () => {
  it('treats future timers and queued occurrences as inert under the dispatch fence', async () => {
    const f = await fixture();
    const now = '2026-10-27T01:00:00.000Z';
    const schedules = new AutomationStore(f.coreDb, f.mutationAdmission, () => now);
    const schedule = schedules.createAutomation(f.ownerId, {
      workspaceId,
      threadId: DEMO_THREAD_ID,
      name: 'Future schedule',
      intervalSeconds: 60,
      prompt: 'Future work',
    });
    schedules.updateAutomation(f.ownerId, schedule.id, {
      expectedRevision: schedule.revision,
      status: 'active',
      scheduledAt: '2026-10-28T01:00:00.000Z',
    });
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);
    expect(schedules.collectScanCandidates(now)).toEqual([]);
    const due = schedules.createAutomation(f.ownerId, {
      workspaceId,
      threadId: DEMO_THREAD_ID,
      name: 'Queued occurrence',
      intervalSeconds: 60,
      prompt: 'Queued only',
    });
    schedules.updateAutomation(f.ownerId, due.id, {
      expectedRevision: due.revision,
      status: 'active',
      scheduledAt: now,
    });
    expect(schedules.collectScanCandidates(now)).toHaveLength(1);
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);

    const release = f.mutationAdmission.enter(workspaceId)!;
    const capture = f.input();
    try {
      const error = await createWorkspaceBackup(capture).then(
        () => null,
        (failure: unknown) => failure
      );
      expect(error).toMatchObject({ code: 'workspace_blocked' });
      expect(existsSync(join(capture.bundleRoot, 'seal.json'))).toBe(false);
    } finally {
      release();
    }
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);
  });

  it('refuses active recurring preparation without waiting for or interrupting its publisher', async () => {
    const f = await fixture();
    const now = '2026-10-27T01:00:00.000Z';
    const schedules = new AutomationStore(f.coreDb, f.mutationAdmission, () => now);
    const created = schedules.createAutomation(f.ownerId, {
      workspaceId,
      threadId: DEMO_THREAD_ID,
      name: 'Current preparation',
      intervalSeconds: 60,
      prompt: 'Prepare owned recurring work',
    });
    schedules.updateAutomation(f.ownerId, created.id, {
      expectedRevision: created.revision,
      status: 'active',
      scheduledAt: now,
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const service = startRecurringScheduleService({
      schedules,
      store: f.store,
      now: () => now,
      prepare: async () => {
        enter();
        await barrier;
        return { kind: 'recovery_required' };
      },
      setInterval: () => undefined,
      clearInterval: () => undefined,
    });
    const running = service.runOnce();
    try {
      await entered;
      const input = f.input();
      const rejected = await createWorkspaceBackup(input).then(
        () => null,
        (error: unknown) => error
      );
      expect(rejected).toMatchObject({ code: 'workspace_blocked' });
      expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
      expect(schedules.getAutomation(created.id).status).toBe('active');
      const db = openWorkspaceDb(f.dataRoot, workspaceId);
      try {
        expect(inspectCapture(db, workspaceId, input.backupId)).toBeNull();
      } finally {
        db.sqlite.close();
      }
    } finally {
      release();
      service.stop();
      await running;
    }
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
  });

  it('keeps physical residency blocked after terminal work until cleanup is proved', async () => {
    const f = await fixture();
    const turn = await f.store.createTurn(
      workspaceId,
      DEMO_THREAD_ID,
      'Physical cleanup must remain explicit',
      { kind: 'user', id: f.ownerId }
    );
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      queueEntryId: randomUUID(),
      backendId: 'nanohost',
      workspaceId,
      threadId: DEMO_THREAD_ID,
      turnId: turn.id,
      turnInput: 'Physical lifecycle fixture',
      requestedAgentId: 'agent_fixture',
      triggerActor: { kind: 'user', id: f.ownerId },
    });
    const attemptId = allocateEntityId('attempt');
    const agentSessionId = allocateEntityId('as');
    const now = () => new Date().toISOString();
    recordTestExecutionAttempt(f.coreDb, {
      entry,
      attemptId,
      agentSessionId,
      inputRef: 'aepsnap_cleanup_fixture',
      bindingRef: 'lease-binding:cleanup-fixture',
      sessionCompatibilityKey: 'cleanup-fixture',
      now,
    });
    const deploymentId = readDataRootLayoutMarker(f.dataRoot).deploymentId;
    const target = allocateNanoHostRuntimeTargetConnectionGeneration(f.coreDb, {
      deploymentId,
      identityId: 'snapshot-cleanup-fixture',
      observedAt: now(),
      targetId: 'snapshot-cleanup-target',
    });
    upsertNanoHostRuntimeTarget(f.coreDb, {
      ...target,
      freshEmpty: true,
      observedAt: now(),
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
    recordWorkerBackendSessionMaterializing(f.coreDb, {
      backendLineage: {
        kind: 'reference',
        imageRef: `registry.invalid/fixture@sha256:${'b'.repeat(64)}`,
      },
      backendVersion: 'fixture',
      identity: {
        agentSessionId,
        backendKind: 'openshell',
        backendSessionId: 'snapshot-cleanup-session',
        deploymentId,
        packageSnapshotId: 'aepsnap_cleanup_fixture',
        runtimeTargetId: target.targetId,
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/cleanup-fixture',
        transientProviderInstanceId: null,
      },
      lineage: { workspaceId, threadId: DEMO_THREAD_ID, turnId: turn.id },
      now,
      sandboxBindingRef: 'lease-binding:cleanup-fixture',
    });
    transitionWorkerBackendSessionState(f.coreDb, {
      attemptId,
      fromState: 'materializing',
      toState: 'cleanup-pending',
      now,
    });
    await f.store.completeTurn(turn.id, { status: 'interrupted', completedAt: now() });
    expect(readBlockers({ ...f, workspaceId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'worker-residency',
          reason: 'cleanup-unproved',
          reference: { agentSessionId },
        }),
      ])
    );
    await refusal(f);
    transitionWorkerBackendSessionState(f.coreDb, {
      attemptId,
      fromState: 'cleanup-pending',
      toState: 'physical-cleaned',
      now,
    });
    transitionWorkerBackendSessionState(f.coreDb, {
      attemptId,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
      now,
    });
    expect(
      readBlockers({ ...f, workspaceId }).filter((blocker) => blocker.kind === 'worker-residency')
    ).toEqual([]);
  });

  it('blocks an approved apply Plan until its exact finished Result exists', async () => {
    const f = await fixture();
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    const createdAt = new Date().toISOString();
    const reviewId = `review-${randomUUID()}`;
    const changeSetId = `change-${randomUUID()}`;
    try {
      recordWorkspaceApplyPlan(db, {
        id: `plan-${randomUUID()}`,
        workspaceId,
        reviewId,
        changeSetId,
        strategy: 'filesystem',
        approvalState: 'approved',
        plannedWrites: ['docs/accepted.md'],
        baselineChecks: [],
        pathConflicts: [],
        binaryRisks: [],
        permissionChanges: [],
        policyChecks: [],
        createdAt,
      });
      expect(readBlockers({ ...f, workspaceId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'synchronization', reference: { reviewId } }),
        ])
      );
      await refusal(f);
      recordWorkspaceApplyResult(db, {
        actor: { kind: 'user', id: f.ownerId },
        requestId: randomUUID(),
        result: {
          id: `result-${randomUUID()}`,
          workspaceId,
          reviewId,
          changeSetId,
          status: 'applied',
          appliedPaths: ['docs/accepted.md'],
          skippedPaths: [],
          conflictRecords: [],
          verification: [],
          commitIds: [],
          appliedAt: createdAt,
        },
      });
      expect(readBlockers({ ...f, workspaceId })).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });
});

describe('C-a frozen scheduler pre-post ordering', () => {
  it.each([
    'revoked-authority',
    'publication-pending',
  ] as const)('skips %s without Core denial or Workspace preparation until an explicit unfrozen pass', async (kind) => {
    const f = await fixture();
    const agentId = 'agent_frozen_dispatch_fixture';
    const turnInput = 'Queued work must remain untouched during target capture.';
    const turn = await f.store.createTurn(
      workspaceId,
      DEMO_THREAD_ID,
      turnInput,
      { kind: 'user', id: f.ownerId },
      null,
      { status: 'pending', agentId }
    );
    const executor = new SimulatedTurnExecutor({ coreDb: f.coreDb });
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      queueEntryId: randomUUID(),
      requestId: randomUUID(),
      backendId: executor.id,
      workspaceId,
      threadId: DEMO_THREAD_ID,
      turnId: turn.id,
      turnInput,
      requestedAgentId: agentId,
      triggerActor: { kind: 'user', id: f.ownerId },
    });
    if (kind === 'revoked-authority') {
      const disabled = f.coreDb.sqlite.transaction(() =>
        disableCanonicalUser(f.coreDb, f.ownerId)
      )();
      expect(disabled).toMatchObject({
        changed: true,
        user: { userId: f.ownerId, status: 'disabled' },
      });
    }
    f.store.setWorkspaceMutationAdmission(f.mutationAdmission);
    const claims = getSchedulerPreparationClaims(f.coreDb);
    expect(claims.size).toBe(0);
    const claim = vi.spyOn(claims, 'set');
    const beforeCore = databaseRows(f.coreDb.sqlite.name, f.root);
    const beforeWorkspace = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const deny = vi.spyOn(schedulerRecords, 'denySchedulerAdmissionEntry');
    const open = vi.spyOn(databaseOwner, 'openWorkspaceDb');
    const read = vi.spyOn(databaseOwner, 'openWorkspaceReadDb');
    const migrate = vi.spyOn(migrationOwner, 'applyScopedMigrations');
    const prepare = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const start = vi.spyOn(executor, 'startTurn');
    const backend = (['submit', 'inspect', 'cancel', 'release'] as const).map((method) =>
      vi.spyOn(executor, method)
    );
    const input = {
      agentManifests: [],
      coreDb: f.coreDb,
      store: f.store,
      turnExecutor: executor,
      executionBackend: executor.executionBackend,
      providerRegistry: new ProviderRegistry([]),
      gatewayConfig: createTestGatewayConfig(),
      callerQueueEntryId: entry.queueEntryId,
      maxDispatches: 1,
    };
    const frozen = f.mutationAdmission.tryFreeze(workspaceId, () => []);
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('Fixture did not acquire its target freeze.');
    try {
      const skipped = await runSchedulerDispatchLoop(input);
      expect(skipped.startedTurns).toEqual([]);
      expect(skipped.terminalResult.status).toBe('queued');
      expect(requireSchedulerAdmissionEntry(f.coreDb, entry.queueEntryId)).toEqual(entry);
      expect(databaseRows(f.coreDb.sqlite.name, f.root)).toEqual(beforeCore);
      expect(databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root)).toEqual(beforeRows);
      expect(tree(f.workspaceRoot)).toEqual(beforeWorkspace);
      expect(deny).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(migrate).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      for (const effect of backend) expect(effect).not.toHaveBeenCalled();
      expect(claims.size).toBe(0);
      expect(claim).not.toHaveBeenCalled();
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
    } finally {
      frozen.release();
    }
    // Freeze does not schedule a retry. Only this explicit later pass may observe
    // the real revocation or inspect the receipt-free publication boundary.
    expect(requireSchedulerAdmissionEntry(f.coreDb, entry.queueEntryId)).toEqual(entry);
    const resumed = await runSchedulerDispatchLoop(input);
    expect(resumed.startedTurns).toEqual([]);
    if (kind === 'revoked-authority') {
      expect(resumed.terminalResult).toMatchObject({
        status: 'denied',
        entry: {
          queueEntryId: entry.queueEntryId,
          status: 'denied',
          denialReason: 'authority-denied',
        },
      });
      expect(deny).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(migrate).not.toHaveBeenCalled();
    } else {
      expect(resumed.terminalResult).toEqual({
        status: 'queued',
        reason: 'entry-publication-pending',
      });
      expect(requireSchedulerAdmissionEntry(f.coreDb, entry.queueEntryId)).toEqual(entry);
      expect(deny).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(migrate).not.toHaveBeenCalled();
      expect(databaseRows(f.coreDb.sqlite.name, f.root)).toEqual(beforeCore);
      expect(databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root)).toEqual(beforeRows);
      expect(tree(f.workspaceRoot)).toEqual(beforeWorkspace);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    for (const effect of backend) expect(effect).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const released = f.mutationAdmission.tryFreeze(workspaceId, () => []);
    expect(released.status).toBe('frozen');
    if (released.status === 'frozen') released.release();
  });
});

describe('C-a observational cross-Workspace scheduler probes', () => {
  it('keeps healthy B publication-pending while the activation census only reads frozen A', async () => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Healthy dispatch B');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    const thread = await f.store.createThread(sibling.id, 'B awaits its own publication');
    const turnInput = 'A missing publication remains pending without touching frozen A.';
    const agentId = 'agent_cross_probe_fixture';
    const turn = await f.store.createTurn(
      sibling.id,
      thread.id,
      turnInput,
      { kind: 'user', id: f.ownerId },
      null,
      { status: 'pending', agentId }
    );
    const executor = new SimulatedTurnExecutor({ coreDb: f.coreDb });
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      queueEntryId: randomUUID(),
      requestId: randomUUID(),
      backendId: executor.id,
      workspaceId: sibling.id,
      threadId: thread.id,
      turnId: turn.id,
      turnInput,
      requestedAgentId: agentId,
      triggerActor: { kind: 'user', id: f.ownerId },
    });
    f.store.setWorkspaceMutationAdmission(f.mutationAdmission);
    const claims = getSchedulerPreparationClaims(f.coreDb);
    expect(claims.size).toBe(0);
    const claim = vi.spyOn(claims, 'set');
    const beforeCore = databaseRows(f.coreDb.sqlite.name, f.root);
    const beforeA = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const writable = vi.spyOn(databaseOwner, 'openWorkspaceDb');
    const migrate = vi.spyOn(migrationOwner, 'applyScopedMigrations');
    const observations: { workspaceId: string; readonly: boolean; queryOnly: unknown }[] = [];
    const realRead = databaseOwner.openWorkspaceReadDb;
    vi.spyOn(databaseOwner, 'openWorkspaceReadDb').mockImplementation((dataRoot, selected) => {
      const db = realRead(dataRoot, selected);
      observations.push({
        workspaceId: selected,
        readonly: db.sqlite.readonly,
        queryOnly: db.sqlite.pragma('query_only', { simple: true }),
      });
      return db;
    });
    const prepare = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const start = vi.spyOn(executor, 'startTurn');
    const backend = (['submit', 'inspect', 'cancel', 'release'] as const).map((method) =>
      vi.spyOn(executor, method)
    );
    const frozen = f.mutationAdmission.tryFreeze(workspaceId, () => []);
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('Fixture did not freeze A.');
    try {
      const result = await runSchedulerDispatchLoop({
        agentManifests: [],
        coreDb: f.coreDb,
        store: f.store,
        turnExecutor: executor,
        executionBackend: executor.executionBackend,
        providerRegistry: new ProviderRegistry([]),
        gatewayConfig: createTestGatewayConfig(),
        callerQueueEntryId: entry.queueEntryId,
        maxDispatches: 1,
      });
      expect(result).toEqual({
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'entry-publication-pending' },
      });
      expect(requireSchedulerAdmissionEntry(f.coreDb, entry.queueEntryId)).toEqual(entry);
      expect(writable.mock.calls.filter(([, selected]) => selected === workspaceId)).toEqual([]);
      expect(
        migrate.mock.calls.filter(
          ([db]) => db.scope === 'workspace' && db.workspaceId === workspaceId
        )
      ).toEqual([]);
      expect(observations).toEqual(
        expect.arrayContaining([
          { workspaceId, readonly: true, queryOnly: 1 },
          { workspaceId: sibling.id, readonly: true, queryOnly: 1 },
        ])
      );
      expect(databaseRows(f.coreDb.sqlite.name, f.root)).toEqual(beforeCore);
      expect(databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root)).toEqual(beforeRows);
      expect(tree(f.workspaceRoot)).toEqual(beforeA);
      expect(prepare).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      for (const effect of backend) expect(effect).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(claims.size).toBe(0);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      const availableB = f.mutationAdmission.tryFreeze(sibling.id, () => []);
      expect(availableB.status).toBe('frozen');
      if (availableB.status === 'frozen') availableB.release();
    } finally {
      frozen.release();
    }
  });

  it('reads cross-source handoff provenance without writable-opening or migrating its frozen parent Workspace', async () => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Receiving worker B');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    const thread = await f.store.createThread(
      sibling.id,
      'Cross-source receiving worker',
      undefined,
      'conversation',
      { visibility: 'workspace', threadSource: 'worker', parentThreadId: DEMO_THREAD_ID }
    );
    const worker = await f.store.createTurn(
      sibling.id,
      thread.id,
      'An unconfirmed handoff is not provenance.',
      { kind: 'user', id: f.ownerId },
      null,
      { status: 'pending', agentId: 'agent_cross_probe_fixture' }
    );
    const receiving = {
      workspaceId: sibling.id,
      threadId: thread.id,
      turnId: worker.id,
      requestId: randomUUID(),
    };
    const receivingDb = databaseOwner.openWorkspaceReadDb(f.dataRoot, sibling.id);
    databaseHandles.push(receivingDb);
    f.store.setWorkspaceMutationAdmission(f.mutationAdmission);
    const beforeCore = databaseRows(f.coreDb.sqlite.name, f.root);
    const beforeA = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const writable = vi.spyOn(databaseOwner, 'openWorkspaceDb');
    const migrate = vi.spyOn(migrationOwner, 'applyScopedMigrations');
    const observations: { workspaceId: string; readonly: boolean; queryOnly: unknown }[] = [];
    const realRead = databaseOwner.openWorkspaceReadDb;
    vi.spyOn(databaseOwner, 'openWorkspaceReadDb').mockImplementation((dataRoot, selected) => {
      const db = realRead(dataRoot, selected);
      observations.push({
        workspaceId: selected,
        readonly: db.sqlite.readonly,
        queryOnly: db.sqlite.pragma('query_only', { simple: true }),
      });
      return db;
    });
    const frozen = f.mutationAdmission.tryFreeze(workspaceId, () => []);
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('Fixture did not freeze source A.');
    try {
      expect(readAssistantTaskHandoffSource(f.store, receivingDb, receiving)).toBeNull();
      expect(observations).toContainEqual({ workspaceId, readonly: true, queryOnly: 1 });
      expect(writable.mock.calls.filter(([, selected]) => selected === workspaceId)).toEqual([]);
      expect(
        migrate.mock.calls.filter(
          ([db]) => db.scope === 'workspace' && db.workspaceId === workspaceId
        )
      ).toEqual([]);
      expect(databaseRows(f.coreDb.sqlite.name, f.root)).toEqual(beforeCore);
      expect(databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root)).toEqual(beforeRows);
      expect(tree(f.workspaceRoot)).toEqual(beforeA);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
    } finally {
      frozen.release();
    }
    // Releasing source exclusion cannot manufacture a confirmed Pending/Item handoff.
    expect(readAssistantTaskHandoffSource(f.store, receivingDb, receiving)).toBeNull();
  });
});

describe('C-a private target refusal ordering', () => {
  it('keeps private and missing opaque Turn denials ahead of frozen disclosure while authorized siblings work', async () => {
    const f = await fixture();
    const email = 'frozen-member@example.invalid';
    const { user: member } = await createBetterAuth(f.coreDb, { env: {} }).api.signUpEmail({
      body: { email, name: 'Ordinary Workspace member', password: randomUUID() },
    });
    const invitation = f.coreDb.sqlite.transaction(() =>
      createWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId,
        inviterUserId: f.ownerId,
        inviteeEmail: email,
      })
    )();
    expect(invitation.kind).toBe('created');
    if (invitation.kind !== 'created') throw new Error('Real owner invitation was not created.');
    const accepted = f.coreDb.sqlite.transaction(() =>
      acceptWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId,
        invitationId: invitation.invitation.invitationId,
        inviteeUserId: member.id,
        expectedRevision: invitation.invitation.revision,
      })
    )();
    expect(accepted.kind).toBe('accepted');
    const privateThread = await f.store.createThread(
      workspaceId,
      'Never reveal this private Thread',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: f.ownerId }
    );
    const privateTurn = await f.store.createTurn(
      workspaceId,
      privateThread.id,
      'Private feedback target',
      { kind: 'user', id: f.ownerId }
    );
    await f.store.completeTurn(privateTurn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const sibling = await f.store.createWorkspace('Authorized sibling feedback');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    const siblingThread = await f.store.createThread(sibling.id, 'Sibling feedback remains live');
    const siblingTurn = await f.store.createTurn(
      sibling.id,
      siblingThread.id,
      'Sibling feedback target',
      { kind: 'user', id: f.ownerId }
    );
    await f.store.completeTurn(siblingTurn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const invoke = createOperationInvocation({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      fileAdmission: f.policy.admission,
      workspaceMutationAdmission: f.mutationAdmission,
      inflightCommands: new WeakMap(),
    });
    const context = (userId: string) => ({
      kind: 'public' as const,
      actor: { kind: 'session' as const, userId },
    });
    const feedback = {
      turnId: privateTurn.id,
      rating: 'good' as const,
      note: 'Explicit authorized feedback',
    };
    const denial = async (turnId: string) => {
      const result = await invoke(
        'turn.feedback',
        { ...feedback, turnId },
        context(member.id)
      ).then(
        () => null,
        (error: unknown) => projectOperationError(error)
      );
      expect(result).not.toBeNull();
      return result;
    };
    const missingTurnId = allocateEntityId('tu');
    const privateBefore = await denial(privateTurn.id);
    expect(privateBefore).toMatchObject({ status: 404, code: 'not_found' });
    const missingBefore = await denial(missingTurnId);
    expect(missingBefore).toMatchObject({ status: 403, code: 'workspace_access_denied' });
    const beforeTarget = tree(f.workspaceRoot);
    const beforePrivateTurn = f.store.getTurnById(privateTurn.id);
    const beforeCore = databaseRows(f.coreDb.sqlite.name, f.root);
    const frozen = f.mutationAdmission.tryFreeze(workspaceId, () => []);
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('Fixture did not freeze the private target.');
    try {
      expect(await denial(privateTurn.id)).toEqual(privateBefore);
      expect(await denial(missingTurnId)).toEqual(missingBefore);
      await expect(invoke('turn.feedback', feedback, context(f.ownerId))).rejects.toMatchObject({
        status: 409,
        code: 'workspace_frozen',
        details: { workspaceId, retryable: true },
      });
      expect(tree(f.workspaceRoot)).toEqual(beforeTarget);
      expect(databaseRows(f.coreDb.sqlite.name, f.root)).toEqual(beforeCore);
      expect(f.store.getTurnById(privateTurn.id)).toEqual(beforePrivateTurn);
      const changedSibling = await invoke(
        'turn.feedback',
        {
          ...feedback,
          turnId: siblingTurn.id,
          note: 'Sibling remains authorized while private target is frozen',
        },
        context(f.ownerId)
      );
      expect(changedSibling).toMatchObject({
        turnId: siblingTurn.id,
        rating: 'good',
        note: 'Sibling remains authorized while private target is frozen',
      });
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      expect(tree(f.workspaceRoot)).toEqual(beforeTarget);
    } finally {
      frozen.release();
    }
    const changed = await invoke('turn.feedback', feedback, context(f.ownerId));
    expect(changed).toMatchObject(feedback);
  }, 120_000);
});

describe('C-a nonwaiting native holds', () => {
  it('releases only capture ownership when deletion independently closes the same gate', async () => {
    const admission = new WorkspaceMutationAdmission();
    const freeze = admission.tryFreeze(workspaceId, () => []);
    expect(freeze.status).toBe('frozen');
    if (freeze.status !== 'frozen') throw new Error('Expected idle capture admission.');
    await admission.close(workspaceId);
    freeze.release();
    freeze.release();
    expect(admission.isClosed(workspaceId)).toBe(true);
    expect(admission.enter(workspaceId)).toBeNull();
    const siblingRelease = admission.enter(allocateEntityId('ws'));
    expect(siblingRelease).not.toBeNull();
    siblingRelease!();
  });

  it('preserves pre-existing native session and terminal settlement under an ordinary deletion closure', async () => {
    const f = await fixture();
    f.store.setWorkspaceMutationAdmission(f.mutationAdmission);
    const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Already admitted work', {
      kind: 'user',
      id: f.ownerId,
    });
    const session = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId,
      threadId: DEMO_THREAD_ID,
      agentId: 'agent_codex_host',
      status: 'ready',
      message: 'Awaiting final physical settlement.',
      createdAt: turn.startedAt!,
      updatedAt: turn.startedAt!,
    });
    const artifacts = f.store.listArtifacts(workspaceId);
    await f.mutationAdmission.close(workspaceId);
    await expect(
      f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'No new ordinary work', {
        kind: 'user',
        id: f.ownerId,
      })
    ).rejects.toMatchObject({ code: 'workspace_frozen' });
    const settled = await f.store.updateAgentSession(session.id, {
      status: 'closed',
      message: 'Physical settlement acknowledged under deletion.',
    });
    expect(settled).toMatchObject({
      status: 'closed',
      message: 'Physical settlement acknowledged under deletion.',
    });
    await expect(
      f.store.updateTurn(turn.id, {
        status: 'interrupted',
        completedAt: new Date(Date.parse(turn.startedAt!) + 1_000).toISOString(),
        error: { code: 'workspace_access_denied', message: 'Workspace deletion fenced output.' },
      })
    ).resolves.toMatchObject({
      status: 'interrupted',
      error: { code: 'workspace_access_denied' },
    });
    await expect(
      getControlStoreWorkerClient().checkpoint(
        `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`
      )
    ).resolves.toBeDefined();
    expect(f.store.listArtifacts(workspaceId)).toEqual(artifacts);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
    await shutdownControlStoreWorkerClient();
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    expect(reopened.getAgentSession(session.id)).toEqual(settled);
    expect(reopened.getTurnById(turn.id)).toMatchObject({
      status: 'interrupted',
      error: { code: 'workspace_access_denied' },
    });
    expect(f.mutationAdmission.enter(workspaceId)).toBeNull();
  });

  it('refuses a direct native checkpoint during capture without posting or deferred replay', async () => {
    const f = await fixture();
    const retainedSession = await f.store.createAgentSession({
      id: allocateEntityId('as'),
      workspaceId,
      threadId: DEMO_THREAD_ID,
      agentId: 'agent_codex_host',
      status: 'closed',
      message: 'Original closed session.',
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
    });
    const sibling = await f.store.createWorkspace('Direct native sibling');
    await f.store.createThread(sibling.id, 'Initialize the sibling native writer');
    const client = getControlStoreWorkerClient();
    const database = `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`;
    const siblingDatabase = `workspace:${workspaceDbPath(f.dataRoot, sibling.id)}`;
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const nativeBackup = Database.prototype.backup;
    let first = true;
    const copy = vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      ...args: Parameters<Database.Database['backup']>
    ) {
      if (first) {
        first = false;
        enter();
        await barrier;
      }
      return Reflect.apply(nativeBackup, this, args);
    });
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    const checkpointPosts = (selected: string) =>
      post.mock.calls.filter(
        ([message]) =>
          message !== null &&
          typeof message === 'object' &&
          message.operation === 'checkpoint' &&
          message.database === selected
      );
    const capturing = createWorkspaceBackup(f.input());
    let attempted: Promise<{ result: unknown } | { error: unknown }> | undefined;
    let attemptedSession: Promise<{ result: unknown } | { error: unknown }> | undefined;
    let captured: Awaited<typeof capturing>;
    try {
      await Promise.race([
        entered,
        capturing.then(() => {
          throw new Error('Capture did not reach its native copy boundary.');
        }),
      ]);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      const beforeSessionWrite = tree(f.workspaceRoot);
      // This bypasses every Store wrapper and reaches the existing native client owner.
      attempted = client.checkpoint(database).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      attemptedSession = f.store
        .updateAgentSession(retainedSession.id, { message: 'Must not be replayed after capture.' })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        );
      const siblingAck = client.checkpoint(siblingDatabase);
      const refusal = await Promise.race([
        attempted,
        siblingAck.then(() => ({ waitingForCaptureRelease: true })),
      ]);
      expect(refusal).toMatchObject({ error: { code: 'workspace_frozen' } });
      expect(
        await Promise.race([
          attemptedSession,
          siblingAck.then(() => ({ waitingForCaptureRelease: true })),
        ])
      ).toMatchObject({ error: { code: 'workspace_frozen' } });
      await expect(siblingAck).resolves.toBeDefined();
      expect(tree(f.workspaceRoot)).toEqual(beforeSessionWrite);
      expect(checkpointPosts(database)).toHaveLength(0);
      expect(checkpointPosts(siblingDatabase)).toHaveLength(1);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
    } finally {
      resume();
      copy.mockRestore();
      captured = await capturing;
      await attempted;
      await attemptedSession;
    }
    expect(captured.disposition).toBe('sealed');
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    // Release must not retry the refused request or retain its finite admission slot.
    expect(checkpointPosts(database)).toHaveLength(0);
    expect(f.store.getAgentSession(retainedSession.id)).toEqual(retainedSession);
    await expect(client.checkpoint(database)).resolves.toBeDefined();
    expect(checkpointPosts(database)).toHaveLength(1);
  }, 120_000);

  it.each([
    'target',
    'global',
  ] as const)('refuses a competing %s hold and allows a sibling native ACK', async (kind) => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Healthy sibling');
    const client = getControlStoreWorkerClient();
    const database = workspaceDbPath(f.dataRoot, workspaceId);
    const release = await client.pauseForDataRootBackup(kind === 'target' ? database : undefined);
    try {
      expect(client.tryPauseForWorkspaceCapture(database)).toBeNull();
      if (kind === 'target') {
        const changed = await f.store.createThread(
          sibling.id,
          'Sibling acknowledged during target hold'
        );
        expect(f.store.getThread(kind === 'target' ? sibling.id : workspaceId, changed.id)).toEqual(
          changed
        );
      }
    } finally {
      release();
    }
    const admitted = client.tryPauseForWorkspaceCapture(database);
    expect(admitted).not.toBeNull();
    const resume = await admitted!;
    resume();
    resume();
    const changed = await f.store.createThread(workspaceId, 'Target acknowledged after release');
    expect(f.store.getThread(workspaceId, changed.id)).toEqual(changed);
    f.coreDb.sqlite.close();
  });
});

/** Composes the ordinary public lifecycle operation with real authority, request and registry owners. */
function deletionOperations(f: Fixture) {
  const cleanup = vi.fn(async (_workspaceId: string) => {
    throw new Error('Unexpected external MCP cleanup.');
  });
  const invoke = createOperationInvocation({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
    fileAdmission: f.policy.admission,
    workspaceMutationAdmission: f.mutationAdmission,
    closeWorkspaceMcpSessions: cleanup,
    inflightCommands: new WeakMap(),
    repositoryWorkspaceDb: (selected) => {
      const db = openWorkspaceDb(f.dataRoot, selected);
      databaseHandles.push(db);
      return db;
    },
  });
  const context = { kind: 'public' as const, actor: { kind: 'local' as const, userId: f.ownerId } };
  const registry = getWorkspaceRegistryLifecycleFact(f.coreDb, workspaceId)!;
  const request = {
    workspaceId,
    requestId: randomUUID(),
    expectedRegistryRevision: registry.registryRevision,
    confirmation: `permanently-delete-workspace:${workspaceId}:${registry.registryRevision}`,
  };
  return { cleanup, invoke, context, request, registry };
}

describe('C-a capture and existing deletion ownership', () => {
  it('protects an active backup pin from deletion after early freeze release until immutable copy completes', async () => {
    const f = await fixture();
    const immutableRoot = join(f.workspaceRoot, 'evidence', 'backend', 'sha256');
    const beforeObjects = tree(immutableRoot);
    const turn = await f.store.createTurn(
      workspaceId,
      DEMO_THREAD_ID,
      'A native retained payload must outlive the mutable capture fence.',
      { kind: 'user', id: f.ownerId }
    );
    await f.store.completeTurn(turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);
    // Select a real newly-published native Item/event payload in its create-only owner family.
    // Managed Knowledge originals retain their separate fallback-copy/expiry policy.
    const retained = Object.entries(tree(immutableRoot)).find(
      ([path, hash]) => hash.startsWith('sha256:') && beforeObjects[path] === undefined
    );
    expect(retained).toBeDefined();
    const sourcePath = join(immutableRoot, retained![0]);
    const original = readFileSync(sourcePath);
    expect(retained![0]).toBe(`/${digest(original).slice('sha256:'.length)}`);
    const deletion = deletionOperations(f);
    const input = f.input();
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    databaseHandles.push(db);
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const realCopy = durableBytes.copyVerifiedFile;
    let intercepted = false;
    const copy = vi.spyOn(durableBytes, 'copyVerifiedFile').mockImplementation(async (value) => {
      if (
        !intercepted &&
        (value.expectedSha256 === digest(original) || value.sourcePath === sourcePath)
      ) {
        intercepted = true;
        expect(readFileSync(value.sourcePath)).toEqual(original);
        enter();
        await barrier;
      }
      return realCopy(value);
    });
    const capturing = createWorkspaceBackup(input);
    let captured: Awaited<typeof capturing>;
    try {
      await Promise.race([
        entered,
        capturing.then(() => {
          throw new Error('Capture did not reach the protected immutable-byte copy boundary.');
        }),
      ]);
      expect(intercepted).toBe(true);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
      expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({ state: 'active' });
      const beforeSource = tree(f.workspaceRoot);
      const sourceInode = lstatSync(f.workspaceRoot).ino;
      const beforeCore = databaseRows(f.coreDb.sqlite.name, f.root);
      await expect(
        deletion.invoke('workspace.delete', deletion.request, deletion.context)
      ).rejects.toMatchObject({
        code: 'workspace_blocked',
        status: 409,
        details: { workspaceId, operation: 'delete', retryable: false },
      });
      expect(listWorkspaceDeletionRequests(f.dataRoot, workspaceId)).toEqual([]);
      expect(getWorkspaceRegistryLifecycleFact(f.coreDb, workspaceId)).toEqual(deletion.registry);
      expect(databaseRows(f.coreDb.sqlite.name, f.root)).toEqual(beforeCore);
      expect(deletion.cleanup).not.toHaveBeenCalled();
      expect(lstatSync(f.workspaceRoot).ino).toBe(sourceInode);
      expect(tree(f.workspaceRoot)).toEqual(beforeSource);
      expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({ state: 'active' });
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    } finally {
      resume();
      copy.mockRestore();
      captured = await capturing;
    }
    expect(captured.disposition).toBe('sealed');
    expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({ state: 'finished' });
    // The same ordinary request is now admitted. Stop at the external cleanup boundary,
    // avoiding the independent deletion recovery/format migration owned by the later lane.
    await expect(
      deletion.invoke('workspace.delete', deletion.request, deletion.context)
    ).rejects.toThrow();
    expect(deletion.cleanup).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(listWorkspaceDeletionRequests(f.dataRoot, workspaceId)).toEqual([
      expect.objectContaining({ requestId: deletion.request.requestId, phase: 'requested' }),
    ]);
  }, 120_000);

  it.each([
    'capture-first',
    'queued-before-freeze',
  ] as const)('refuses ordinary deletion at %s without stealing the capture fence', async (order) => {
    const f = await fixture();
    const deletion = deletionOperations(f);
    const sibling = await f.store.createWorkspace('Sibling remains admitted during lifecycle race');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    expect(listWorkspaceDeletionRequests(f.dataRoot, workspaceId)).toEqual([]);
    let releaseQueue: () => void = () => undefined;
    let queued: Promise<unknown> | undefined;
    let deleting: Promise<{ error?: unknown; result?: unknown }> | undefined;
    let restoreSerialization = () => {};
    if (order === 'queued-before-freeze') {
      const barrier = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      let queueEntered!: () => void;
      const ready = new Promise<void>((resolve) => {
        queueEntered = resolve;
      });
      queued = f.mutationAdmission.runDeletionExclusive(workspaceId, async () => {
        queueEntered();
        await barrier;
      });
      await ready;
      const runExclusive = f.mutationAdmission.runDeletionExclusive.bind(f.mutationAdmission);
      let ownerEntered!: () => void;
      const atOwner = new Promise<void>((resolve) => {
        ownerEntered = resolve;
      });
      const serialized = vi
        .spyOn(f.mutationAdmission, 'runDeletionExclusive')
        .mockImplementation(<T>(selected: string, operation: () => Promise<T>): Promise<T> => {
          ownerEntered();
          return runExclusive(selected, operation);
        });
      restoreSerialization = () => serialized.mockRestore();
      deleting = deletion.invoke('workspace.delete', deletion.request, deletion.context).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      await Promise.race([
        atOwner,
        deleting.then(() => {
          throw new Error(
            'Deletion did not reach its existing serialized owner while admission was open.'
          );
        }),
      ]);
    }
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const nativeBackup = Database.prototype.backup;
    let first = true;
    const copy = vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      ...args: Parameters<Database.Database['backup']>
    ) {
      if (first) {
        first = false;
        enter();
        await barrier;
      }
      return Reflect.apply(nativeBackup, this, args);
    });
    const capturing = createWorkspaceBackup(f.input());
    let captured: Awaited<typeof capturing> | undefined;
    let captureFailure: unknown;
    try {
      await Promise.race([
        entered,
        capturing.then(() => {
          throw new Error('Capture did not reach its native copy boundary.');
        }),
      ]);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      if (!deleting)
        deleting = deletion.invoke('workspace.delete', deletion.request, deletion.context).then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        );
      releaseQueue();
      if (queued) await queued;
      const refusal = await deleting;
      expect(refusal.error).toMatchObject({
        code: 'workspace_frozen',
        status: 409,
        details: { workspaceId, operation: 'delete', retryable: true },
      });
      expect(refusal.result).toBeUndefined();
      expect(deletion.cleanup).not.toHaveBeenCalled();
      expect(listWorkspaceDeletionRequests(f.dataRoot, workspaceId)).toEqual([]);
      expect(getWorkspaceRegistryLifecycleFact(f.coreDb, workspaceId)).toEqual(deletion.registry);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      expect(f.mutationAdmission.enter(workspaceId)).toBeNull();
      const siblingThread = await deletion.invoke(
        'thread.create',
        {
          workspaceId: sibling.id,
          name: 'Sibling native acknowledgement',
          visibility: 'workspace',
          requestId: randomUUID(),
        },
        deletion.context
      );
      expect(f.store.getThread(sibling.id, siblingThread.id).name).toBe(
        'Sibling native acknowledgement'
      );
    } finally {
      releaseQueue();
      if (queued) await queued;
      resume();
      copy.mockRestore();
      restoreSerialization();
      await capturing.then(
        (result) => {
          captured = result;
        },
        (error: unknown) => {
          captureFailure = error;
        }
      );
    }
    expect(captureFailure).toBeUndefined();
    expect(captured?.disposition).toBe('sealed');
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    expect(listWorkspaceDeletionRequests(f.dataRoot, workspaceId)).toEqual([]);
  }, 120_000);

  it('blocks capture from an unfinished requested deletion after reopen without accepting a second request', async () => {
    const f = await fixture();
    const deletion = deletionOperations(f);
    await expect(
      deletion.invoke('workspace.delete', deletion.request, deletion.context)
    ).rejects.toThrow();
    expect(deletion.cleanup).toHaveBeenCalledOnce();
    const requests = listWorkspaceDeletionRequests(f.dataRoot, workspaceId);
    expect(requests).toEqual([
      expect.objectContaining({ requestId: deletion.request.requestId, phase: 'requested' }),
    ]);
    expect(getWorkspaceRegistryLifecycleFact(f.coreDb, workspaceId)).toEqual(deletion.registry);
    await shutdownControlStoreWorkerClient();
    const coreDb = openCoreDb(f.dataRoot);
    databaseHandles.push(coreDb);
    const store = new FsStore({ dataRoot: f.dataRoot });
    const mutationAdmission = new WorkspaceMutationAdmission();
    const input = { ...f.input(), source: { ...f.source, coreDb, store, mutationAdmission } };
    expect(readBlockers({ coreDb, store, workspaceId }).length).toBeGreaterThan(0);
    await expect(createWorkspaceBackup(input)).rejects.toMatchObject({ code: 'workspace_blocked' });
    expect(listWorkspaceDeletionRequests(f.dataRoot, workspaceId)).toEqual(requests);
    expect(getWorkspaceRegistryLifecycleFact(coreDb, workspaceId)).toEqual(deletion.registry);
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      expect(inspectCapture(db, workspaceId, input.backupId)).toBeNull();
    } finally {
      db.sqlite.close();
    }
    expect(mutationAdmission.isClosed(workspaceId)).toBe(false);
  });
});

describe('C-a independent sealed generations', () => {
  it.each([
    'closed-writer',
    'restart',
  ] as const)('creates a brand-new capture after %s without a warming mutation', async (kind) => {
    const f = await fixture();
    let source = f.source;
    if (kind === 'closed-writer') {
      await getControlStoreWorkerClient().close(
        `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`
      );
    } else {
      await shutdownControlStoreWorkerClient();
      f.coreDb.sqlite.close();
      const coreDb = openCoreDb(f.dataRoot);
      databaseHandles.push(coreDb);
      source = {
        ...f.source,
        coreDb,
        store: new FsStore({ dataRoot: f.dataRoot }),
        mutationAdmission: new WorkspaceMutationAdmission(),
      };
    }
    // Neither branch performs a product mutation or native open to warm the source.
    const input = { ...f.input(), source };
    const db = bindWorkspaceSqlite(
      new Database(workspaceDbPath(f.dataRoot, workspaceId), {
        readonly: true,
        fileMustExist: true,
      }),
      f.dataRoot,
      workspaceId
    );
    databaseHandles.push(db);
    expect(inspectCapture(db, workspaceId, input.backupId)).toBeNull();
    expect(readBlockers({ ...source, workspaceId })).toEqual([]);
    const captured = await createWorkspaceBackup(input);
    expect(captured.disposition).toBe('sealed');
    expect(captured.manifest.backupId).toBe(input.backupId);
    expect(captured.manifest.capture.consistency).toBe('workspace-consistent');
    expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({ state: 'finished' });
    expect(source.mutationAdmission.isClosed(workspaceId)).toBe(false);
    await f.read(input.backupId, async (bundle) =>
      expect(bundle.manifestDigest).toBe(captured.report.manifestDigest)
    );
  }, 120_000);

  it('retains MOVE admission closure after the active capture pin commits but its acknowledgement is lost', async () => {
    const f = await fixture();
    const input = { ...f.input(), purpose: 'move' as const };
    const realProtect = captureProtection.protectCapture;
    let calls = 0;
    const pin = vi
      .spyOn(captureProtection, 'protectCapture')
      .mockImplementation((db, selected, captureId) => {
        if (captureId !== input.backupId) return realProtect(db, selected, captureId);
        calls += 1;
        expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
        const retained = realProtect(db, selected, captureId);
        expect(retained.state).toBe('active');
        throw new Error('Injected lost acknowledgement after the active MOVE pin committed.');
      });
    try {
      await expect(createWorkspaceBackup(input)).rejects.toThrow();
    } finally {
      pin.mockRestore();
    }
    expect(calls).toBe(1);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
    expect(f.mutationAdmission.enter(workspaceId)).toBeNull();
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    databaseHandles.push(db);
    expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({
      captureId: input.backupId,
      workspaceId,
      state: 'active',
      endedAt: null,
    });
    expect(readBlockers({ ...f, workspaceId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'snapshot', reference: { backupId: input.backupId } }),
      ])
    );
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
  });

  it('preserves exact mutable and Light App cuts, reuses immutable objects and survives source deletion', async () => {
    const f = await fixture();
    const authored = Buffer.from('Exact binary Source\0\xff');
    await captureWorkspaceSourceFixture({
      ...f,
      userId: f.ownerId,
      content: authored,
      source: {
        id: allocateEntityId('ks'),
        workspaceId,
        kind: 'document',
        title: 'Independent retained original',
        uri: null,
        contentDigest: digest(authored),
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const context = {
      ...f,
      workspaceId,
      actor: { kind: 'user' as const, id: f.ownerId },
      requestId: randomUUID(),
      inflightCommands: new WeakMap(),
    };
    const app = await createLightApp(context, {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Snapshot business data',
      purpose: 'Verify actual mutable SQLite cuts.',
      collections: [
        {
          name: 'notes',
          type: 'base',
          description: 'Notes.',
          fields: [{ name: 'text', type: 'text', required: true, description: 'Authored text.' }],
          indexes: [],
        },
      ],
    });
    await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'notes',
      app.schemaRevision,
      { text: 'First captured row' }
    );
    const mutablePath = join(f.workspaceRoot, 'files', 'authored.bin');
    mkdirSync(dirname(mutablePath), { recursive: true });
    writeFileSync(mutablePath, 'First mutable head', { mode: 0o640 });
    const beforeFirstWorkspace = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const beforeFirstApp = databaseRows(
      join(f.workspaceRoot, 'light-apps', app.appId, 'data.sqlite'),
      f.root
    );
    const firstGitHeads = Object.entries(tree(f.workspaceRoot)).filter(
      ([path, hash]) =>
        hash.startsWith('sha256:') &&
        /^\/knowledge\/notebook\.git\/(?:HEAD$|refs\/|packed-refs$)/.test(path)
    );
    const first = await createWorkspaceBackup(f.input());
    expect(first.disposition).toBe('sealed');
    expect(first.manifest.capture.consistency).toBe('workspace-consistent');
    const originalObjectStats = tree(
      join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId)
    );
    const objectIdentity = new Map<string, number>();
    for (const path of Object.keys(originalObjectStats)) {
      const absolute = join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId, path);
      if (lstatSync(absolute).isFile()) objectIdentity.set(absolute, lstatSync(absolute).ino);
    }
    await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'notes',
      app.schemaRevision,
      { text: 'Second captured row' }
    );
    await f.store.createThread(workspaceId, 'Second captured native thread');
    writeFileSync(mutablePath, 'Second mutable head');
    const laterSource = Buffer.from('A later published Source changes the Notebook head.');
    await captureWorkspaceSourceFixture({
      ...f,
      userId: f.ownerId,
      content: laterSource,
      source: {
        id: allocateEntityId('ks'),
        workspaceId,
        kind: 'document',
        title: 'Later published Source',
        uri: null,
        contentDigest: digest(laterSource),
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const beforeSecondWorkspace = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const beforeSecondApp = databaseRows(
      join(f.workspaceRoot, 'light-apps', app.appId, 'data.sqlite'),
      f.root
    );
    const secondGitHeads = Object.entries(tree(f.workspaceRoot)).filter(
      ([path, hash]) =>
        hash.startsWith('sha256:') &&
        /^\/knowledge\/notebook\.git\/(?:HEAD$|refs\/|packed-refs$)/.test(path)
    );
    expect(secondGitHeads).not.toEqual(firstGitHeads);
    const second = await createWorkspaceBackup(f.input());
    const backupRoot = join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId);
    const firstCopies = Object.values(originalObjectStats).filter(
      (value) => value === digest(authored)
    );
    const secondCopies = Object.values(tree(backupRoot)).filter(
      (value) => value === digest(authored)
    );
    expect(firstCopies).toHaveLength(1);
    expect(secondCopies).toHaveLength(1);
    expect(second.disposition).toBe('sealed');
    const appPath = `light-apps/${app.appId}/data.sqlite`;
    const firstCut = await f.read(first.manifest.backupId, async (bundle) => ({
      app: databaseRows(await bytes(bundle, appPath), f.root),
      workspace: databaseRows(await bytes(bundle, 'db/workspace.sqlite'), f.root),
      mutable: await bytes(bundle, 'files/authored.bin'),
    }));
    const secondCut = await f.read(second.manifest.backupId, async (bundle) => ({
      app: databaseRows(await bytes(bundle, appPath), f.root),
      workspace: databaseRows(await bytes(bundle, 'db/workspace.sqlite'), f.root),
      mutable: await bytes(bundle, 'files/authored.bin'),
    }));
    expect(firstGitHeads.length).toBeGreaterThan(0);
    for (const [generation, heads] of [
      [first, firstGitHeads],
      [second, secondGitHeads],
    ] as const) {
      await f.read(generation.manifest.backupId, async (bundle) => {
        for (const [path, expectedDigest] of heads)
          expect(digest(await bytes(bundle, path.slice(1)))).toBe(expectedDigest);
      });
    }
    expect(firstCut.app).toEqual(beforeFirstApp);
    expect(secondCut.app).toEqual(beforeSecondApp);
    // The snapshot owner adds its own capture pin; every other canonical native row is exact.
    const withoutCapturePin = ({
      workspace_capture_records: _pins,
      ...records
    }: Record<string, unknown[]>) => records;
    expect(withoutCapturePin(firstCut.workspace)).toEqual(withoutCapturePin(beforeFirstWorkspace));
    expect(withoutCapturePin(secondCut.workspace)).toEqual(
      withoutCapturePin(beforeSecondWorkspace)
    );
    expect(firstCut.mutable.toString()).toBe('First mutable head');
    expect(secondCut.mutable.toString()).toBe('Second mutable head');
    expect(JSON.stringify(firstCut.app)).toContain('First captured row');
    expect(JSON.stringify(firstCut.app)).not.toContain('Second captured row');
    expect(JSON.stringify(secondCut.app)).toContain('Second captured row');
    expect(JSON.stringify(firstCut.workspace)).not.toContain('Second captured native thread');
    expect(JSON.stringify(secondCut.workspace)).toContain('Second captured native thread');
    for (const manifest of [first.manifest, second.manifest])
      expect(manifest.inventory.some((entry) => /-(wal|shm)$/.test(entry.path))).toBe(false);
    // Reuse must preserve previously owned objects, not replace them with source links.
    for (const [path, inode] of objectIdentity)
      if (existsSync(path)) expect(lstatSync(path).ino).toBe(inode);
    expect(
      second.manifest.inventory.find((entry) => entry.path === 'files/authored.bin')?.mode
    ).toBe(0o640);
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    rmSync(f.workspaceRoot, { recursive: true });
    for (const generation of [first, second])
      await f.read(generation.manifest.backupId, async (bundle) => {
        for (const entry of bundle.manifest.inventory) {
          const actual = await bytes(bundle, entry.path);
          expect(actual.length).toBe(entry.bytes);
          expect(digest(actual)).toBe(entry.sha256);
        }
      });
  }, 120_000);

  it('does not read or change an unrelated unavailable Workspace while capturing the target', async () => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Unavailable sibling must stay isolated');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    const siblingRegistry = getWorkspaceRegistryLifecycleFact(f.coreDb, sibling.id);
    expect(siblingRegistry).toMatchObject({ status: 'active', ownerUserId: f.ownerId });
    const siblingDatabase = workspaceDbPath(f.dataRoot, sibling.id);
    await getControlStoreWorkerClient().close(`workspace:${siblingDatabase}`);
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);
    writeFileSync(siblingDatabase, 'Deliberately unreadable sibling authority');
    const before = tree(join(f.dataRoot, 'workspaces', sibling.id));
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);
    const capture = await createWorkspaceBackup(f.input());
    expect(capture.disposition).toBe('sealed');
    expect(tree(join(f.dataRoot, 'workspaces', sibling.id))).toEqual(before);
    expect(getWorkspaceRegistryLifecycleFact(f.coreDb, sibling.id)).toEqual(siblingRegistry);
    expect(capture.manifest.workspaceId).toBe(workspaceId);
    expect(JSON.stringify(capture.manifest)).not.toContain(sibling.id);
  });

  it('retains callback-owned verified copies after source removal and closes them after return', async () => {
    const f = await fixture();
    const capture = await createWorkspaceBackup(f.input());
    let retained: VerifiedWorkspaceBackupBundle | undefined;
    await f.read(capture.manifest.backupId, async (bundle) => {
      retained = bundle;
      const file = bundle.manifest.inventory[0]!;
      const expected = await bytes(bundle, file.path);
      rmSync(join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId), { recursive: true });
      expect(await bytes(bundle, file.path)).toEqual(expected);
    });
    await expect(bytes(retained!, retained!.manifest.inventory[0]!.path)).rejects.toThrow();
    f.coreDb.sqlite.close();
  });

  it('refuses a local pool presented as a standalone flat bundle before callback', async () => {
    const f = await fixture();
    await createWorkspaceBackup(f.input());
    const consume = vi.fn(async () => undefined);
    await expect(
      withVerifiedWorkspaceBackupBundle(
        {
          ...f.policy,
          bundleRoot: join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId),
        },
        consume
      )
    ).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
    f.coreDb.sqlite.close();
  });

  it.each([
    'missing',
    'corrupt',
    'linked',
  ] as const)('refuses a %s local digest object before invoking its reader', async (fault) => {
    const f = await fixture();
    const captured = await createWorkspaceBackup(f.input());
    const entry = captured.manifest.inventory[0]!;
    const backupRoot = join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId);
    const object = Object.entries(tree(backupRoot)).find(([, hash]) => hash === entry.sha256)?.[0];
    expect(object).toBeDefined();
    const path = join(backupRoot, object!);
    if (fault === 'corrupt') {
      chmodSync(path, 0o600);
      writeFileSync(path, 'Corrupt retained object');
    } else {
      rmSync(path);
      if (fault === 'linked') {
        const outside = join(f.root, 'replacement-object');
        writeFileSync(outside, 'Outside substitute');
        symlinkSync(outside, path);
      }
    }
    const consume = vi.fn(async () => undefined);
    await expect(f.read(captured.manifest.backupId, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
  });

  it('replays one capture identity after reopen and refuses changed purpose', async () => {
    const f = await fixture();
    const input = f.input();
    const first = await createWorkspaceBackup(input);
    await shutdownControlStoreWorkerClient();
    const reopenedCore = openCoreDb(f.dataRoot);
    databaseHandles.push(reopenedCore);
    const reopenedInput = {
      ...input,
      source: {
        ...input.source,
        coreDb: reopenedCore,
        store: new FsStore({ dataRoot: f.dataRoot }),
      },
    };
    const reopened = await createWorkspaceBackup(reopenedInput);
    expect(reopened.report).toEqual(first.report);
    expect(reopened.manifest).toEqual(first.manifest);
    await expect(
      createWorkspaceBackup({ ...reopenedInput, purpose: 'move' })
    ).rejects.toMatchObject({
      code: 'request-conflict',
    });
    await f.read(first.manifest.backupId, async (bundle) =>
      expect(bundle.manifestDigest).toBe(first.report.manifestDigest)
    );
    f.coreDb.sqlite.close();
  });

  it('refuses first-generation pool entry sync failure without sealing or damaging a control generation', async () => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Previously sealed control generation');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    const controlId = allocateEntityId('wsbak');
    const controlRoot = join(f.dataRoot, 'server', 'backups', 'workspaces', sibling.id);
    const control = await createWorkspaceBackup({
      ...f.input(controlId),
      workspaceId: sibling.id,
      bundleRoot: join(controlRoot, controlId),
    });
    expect(control.disposition).toBe('sealed');
    const beforeControl = tree(controlRoot);
    const input = f.input();
    const pool = dirname(input.bundleRoot);
    expect(existsSync(pool)).toBe(false);
    let committedPin: ReturnType<typeof protectCapture> | undefined;
    const realProtect = captureProtection.protectCapture;
    const pin = vi
      .spyOn(captureProtection, 'protectCapture')
      .mockImplementation((db, selected, captureId) => {
        const retained = realProtect(db, selected, captureId);
        if (selected === workspaceId && captureId === input.backupId) committedPin = retained;
        return retained;
      });
    let failed = false;
    namespaceSyncFault.beforeSync = (descriptor) => {
      if (
        !failed &&
        fstatSync(descriptor).isDirectory() &&
        realpathSync(`/proc/self/fd/${descriptor}`) === dirname(pool) &&
        existsSync(pool)
      ) {
        failed = true;
        expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
        throw new Error('Injected synchronization failure for the new Workspace pool entry.');
      }
    };
    let failure: unknown;
    let result: Awaited<ReturnType<typeof createWorkspaceBackup>> | undefined;
    try {
      await createWorkspaceBackup(input).then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          failure = error;
        }
      );
    } finally {
      namespaceSyncFault.beforeSync = undefined;
      pin.mockRestore();
    }
    expect(failed).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect(result).toBeUndefined();
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    const db = bindWorkspaceSqlite(
      new Database(workspaceDbPath(f.dataRoot, workspaceId), {
        readonly: true,
        fileMustExist: true,
      }),
      f.dataRoot,
      workspaceId
    );
    databaseHandles.push(db);
    expect(inspectCapture(db, workspaceId, input.backupId)).toEqual(committedPin ?? null);
    if (committedPin) expect(committedPin.state).toBe('active');
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const hold = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
      workspaceDbPath(f.dataRoot, workspaceId)
    );
    expect(hold).not.toBeNull();
    const release = await hold!;
    release();
    expect(tree(controlRoot)).toEqual(beforeControl);
    await withVerifiedWorkspaceSnapshotSource(
      {
        ...f.policy,
        dataRoot: f.dataRoot,
        source: { kind: 'local-snapshot', workspaceId: sibling.id, backupId: controlId },
      },
      async (bundle) => {
        expect(bundle.manifestDigest).toBe(control.report.manifestDigest);
        for (const entry of bundle.manifest.inventory)
          expect(digest(await bytes(bundle, entry.path))).toBe(entry.sha256);
      }
    );
  }, 120_000);

  it('rechecks current authority after awaited database preparation before sealing', async () => {
    const f = await fixture();
    const input = f.input();
    let authorized = true;
    const check = vi.fn(() => {
      if (!authorized) throw new Error('Current authority was revoked.');
    });
    const original = Database.prototype.backup;
    const intercept = vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      ...args: Parameters<Database.Database['backup']>
    ) {
      const result = await Reflect.apply(original, this, args);
      authorized = false;
      return result;
    });
    try {
      await expect(
        createWorkspaceBackup({ ...input, source: { ...input.source, currentAuthority: check } })
      ).rejects.toThrow();
      expect(check.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    } finally {
      intercept.mockRestore();
    }
  });

  it('keeps manual unfinished capture inspectable after native-copy failure and cold reopen', async () => {
    const f = await fixture();
    const previous = await createWorkspaceBackup(f.input());
    const input = f.input();
    const intercept = vi
      .spyOn(Database.prototype, 'backup')
      .mockRejectedValueOnce(new Error('Injected native SQLite backup failure.'));
    try {
      await expect(createWorkspaceBackup(input)).rejects.toThrow();
    } finally {
      intercept.mockRestore();
    }
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const nextHold = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
      workspaceDbPath(f.dataRoot, workspaceId)
    );
    expect(nextHold).not.toBeNull();
    (await nextHold!)();
    await shutdownControlStoreWorkerClient();
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({
        captureId: input.backupId,
        state: 'active',
      });
    } finally {
      db.sqlite.close();
    }
    expect(readBlockers({ ...f, workspaceId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'snapshot', reference: { backupId: input.backupId } }),
      ])
    );
    await f.read(previous.manifest.backupId, async (bundle) =>
      expect(bundle.manifestDigest).toBe(previous.report.manifestDigest)
    );
  });

  it.each([
    'before-commit',
    'lost-ack',
  ] as const)('preserves truthful manual completion and the predecessor at %s after seal publication', async (cut) => {
    const f = await fixture();
    const previous = await createWorkspaceBackup(f.input());
    const input = f.input();
    const realComplete = captureProtection.completeCapture;
    let calls = 0;
    let publishedDigest: string | undefined;
    const completion = vi
      .spyOn(captureProtection, 'completeCapture')
      .mockImplementation((db, selectedWorkspaceId, captureId) => {
        if (captureId !== input.backupId) return realComplete(db, selectedWorkspaceId, captureId);
        calls += 1;
        expect(selectedWorkspaceId).toBe(workspaceId);
        const seal = JSON.parse(readFileSync(join(input.bundleRoot, 'seal.json'), 'utf8')) as {
          backupId: string;
          manifestDigest: string;
        };
        expect(seal.backupId).toBe(input.backupId);
        publishedDigest = seal.manifestDigest;
        if (cut === 'lost-ack') {
          const committed = realComplete(db, selectedWorkspaceId, captureId);
          expect(committed.state).toBe('finished');
        }
        throw new Error('Injected capture completion boundary failure.');
      });
    try {
      await expect(createWorkspaceBackup(input)).rejects.toThrow();
    } finally {
      completion.mockRestore();
    }
    expect(calls).toBe(1);
    expect(publishedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const held = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
      workspaceDbPath(f.dataRoot, workspaceId)
    );
    expect(held).not.toBeNull();
    const release = await held!;
    release();
    release();
    await shutdownControlStoreWorkerClient();
    const reopenedCore = openCoreDb(f.dataRoot);
    databaseHandles.push(reopenedCore);
    const reopenedStore = new FsStore({ dataRoot: f.dataRoot });
    const reopenedInput = {
      ...input,
      source: { ...input.source, coreDb: reopenedCore, store: reopenedStore },
    };
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      const retained = inspectCapture(db, workspaceId, input.backupId);
      expect(retained).toMatchObject({
        captureId: input.backupId,
        workspaceId,
        state: cut === 'lost-ack' ? 'finished' : 'active',
      });
      await f.read(previous.manifest.backupId, async (bundle) =>
        expect(bundle.manifestDigest).toBe(previous.report.manifestDigest)
      );
      if (cut === 'lost-ack') {
        await f.read(input.backupId, async (bundle) =>
          expect(bundle.manifestDigest).toBe(publishedDigest)
        );
        const before = tree(join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId));
        const replay = await createWorkspaceBackup(reopenedInput);
        expect(replay.disposition).toBe('sealed');
        expect(replay.report.manifestDigest).toBe(publishedDigest);
        expect(tree(join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId))).toEqual(
          before
        );
      } else {
        // Manual ownership requires explicit recovery; retry is not permission to synthesize its finish.
        await expect(createWorkspaceBackup(reopenedInput)).rejects.toThrow();
        expect(readBlockers({ coreDb: reopenedCore, store: reopenedStore, workspaceId })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'snapshot', reference: { backupId: input.backupId } }),
          ])
        );
      }
      expect(inspectCapture(db, workspaceId, input.backupId)).toEqual(retained);
    } finally {
      db.sqlite.close();
    }
  });

  it('excludes a real mutable Notebook publication during capture and preserves its selected head', async () => {
    const f = await fixture();
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    databaseHandles.push(db);
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.workspaceRoot, 'knowledge', 'notebook.git'),
    });
    const baseRevision = notebook.publishedRevision();
    const originalIndex = notebook.readRevision(baseRevision).files['index.md']!;
    const request = {
      workspaceId,
      requestId: randomUUID(),
      baseRevision,
      summary: 'Publish after the snapshot cut.',
      changes: [
        { path: 'index.md', content: `${originalIndex}\nA later authorized Notebook head.\n` },
      ],
    };
    const actor = { kind: 'user' as const, id: f.ownerId };
    const config = createInMemoryRuntimeConfigSnapshot({ dataRoot: f.dataRoot });
    const dependencies = {
      store: f.store,
      workspaceDb: db,
      notebook,
      producer: actor,
      actor,
      inflightCommands: new WeakMap(),
      revalidate: () =>
        readWorkspaceNotebookAdmission({
          store: f.store,
          coreDb: f.coreDb,
          workspaceDb: db,
          notebook,
          actor,
          requestActor: { kind: 'local', userId: f.ownerId },
          request,
          runtimeConfigManager: { current: () => config },
          workspaceMutationAdmission: f.mutationAdmission,
        }),
    };
    const heads = Object.entries(tree(f.workspaceRoot)).filter(
      ([path, hash]) =>
        hash.startsWith('sha256:') &&
        /^\/knowledge\/notebook\.git\/(?:HEAD$|refs\/|packed-refs$)/.test(path)
    );
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const nativeBackup = Database.prototype.backup;
    let first = true;
    const copy = vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      ...args: Parameters<Database.Database['backup']>
    ) {
      if (first) {
        first = false;
        enter();
        await barrier;
      }
      return Reflect.apply(nativeBackup, this, args);
    });
    const capturing = createWorkspaceBackup(f.input());
    let captured: Awaited<typeof capturing>;
    try {
      await Promise.race([
        entered,
        capturing.then(() => {
          throw new Error('Capture did not reach the native mutable-copy boundary.');
        }),
      ]);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      const before = tree(join(f.workspaceRoot, 'knowledge', 'notebook.git'));
      await expect(publishWorkspaceNotebook(dependencies, request)).rejects.toThrow();
      expect(notebook.publishedRevision()).toBe(baseRevision);
      expect(tree(join(f.workspaceRoot, 'knowledge', 'notebook.git'))).toEqual(before);
    } finally {
      resume();
      copy.mockRestore();
      captured = await capturing;
    }
    try {
      expect(captured.disposition).toBe('sealed');
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
      const published = await publishWorkspaceNotebook(dependencies, request);
      expect(published.outcome).toBe('published');
      expect(notebook.publishedRevision()).not.toBe(baseRevision);
      await f.read(captured.manifest.backupId, async (bundle) => {
        for (const [path, hash] of heads)
          expect(digest(await bytes(bundle, path.slice(1)))).toBe(hash);
      });
    } finally {
      db.sqlite.close();
    }
  }, 120_000);

  it('rejects a linked mutable source, preserves the previous seal, and releases target admission', async () => {
    const f = await fixture();
    const first = await createWorkspaceBackup(f.input());
    const outside = join(f.root, 'outside-secret');
    writeFileSync(outside, 'Never capture outside authority');
    const files = join(f.workspaceRoot, 'files');
    mkdirSync(files, { recursive: true });
    symlinkSync(outside, join(files, 'linked'));
    const rejected = f.input();
    await expect(createWorkspaceBackup(rejected)).rejects.toThrow();
    expect(existsSync(join(rejected.bundleRoot, 'seal.json'))).toBe(false);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('Never capture outside authority');
    await f.read(first.manifest.backupId, async (bundle) =>
      expect(bundle.manifestDigest).toBe(first.report.manifestDigest)
    );
    f.coreDb.sqlite.close();
  });
});
