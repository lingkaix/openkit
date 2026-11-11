// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { type Worker as NativeWorker, Worker } from 'node:worker_threads';
import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { requireAdministratorOperation } from '../auth/operation-authorizer.js';
import { acquireDataRootLock } from '../bootstrap/lock.js';
import { isScopeAdmitted, refuseScope, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import {
  publishWorkspaceResourceCatalog,
  readWorkspaceResourceCatalog,
} from '../catalog/resource-catalog.js';
import { createChannelServices } from '../channel-services.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import {
  compactWorkspaceEvidenceBundles,
  recordWorkspaceEvidenceBundle,
} from '../evidence-bundles.js';
import { AutomationStore } from '../lib/automation-store.js';
import { cleanCancelledAdmissionTaskCheckpoints } from '../runtime/cancelled-admission-checkpoint-cleanup.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { pendingRequestItemId } from '../runtime/pending-requests.js';
import { upsertWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  beginWorkspaceDeletion,
  completeWorkspaceDeletion,
  getWorkspaceRegistryLifecycleFact,
} from '../workspace-sharing.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  inventoryRegularFiles,
  verifyDataRootBackupManifest,
  writeHotDataRootBackup,
} from './data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { coreDbPath, readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import {
  parseWorkspaceBackupManifest,
  withVerifiedWorkspaceBackupBundle,
} from './workspace-backup-bundle.js';
import { protectCapture } from './workspace-capture-protection.js';
import { nativeProductScope, readNativeTurnHistory } from './workspace-file-records.js';
import { inspectWorkspaceRecoveryAtCore } from './workspace-move.js';
import {
  bindWorkspaceRecoveryNativeOwner,
  readRecoveryAdmission,
  resumeWorkspaceRecoveryOwner,
} from './workspace-recovery-admissions.js';
import {
  runWorkspaceRecoveryCli,
  type WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';
import { WorkspaceRecoveryError } from './workspace-recovery-error.js';
import {
  abandonWorkspaceRecoveryAtCore,
  activateWorkspaceRecoveryAtCore,
  admitWorkspaceBackup,
  admitWorkspaceBackupAtCore,
  finishWorkspaceRecoveryAtCore,
} from './workspace-restore.js';

const registrationInterception = vi.hoisted(() => ({
  selected: undefined as
    | {
        corePath: string;
        admissionId: string;
        workspaceId: string;
        gate: SharedArrayBuffer;
      }
    | undefined,
  worker: undefined as NativeWorker | undefined,
  replied: false,
}));

// As in the native client tests, the real entry and real SQL remain in use.
// Only the selected real host's covering COMMIT can withhold its actual reply.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const selected = registrationInterception.selected;
        if (!selected) {
          super(filename, options);
          return;
        }
        const prelude = `
          const { workerData } = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const execute = Database.prototype.exec;
          const gate = workerData.gate;
          Database.prototype.exec = function(sql) {
            const result = execute.call(this, sql);
            if (/^COMMIT$/i.test(sql) && this.name === workerData.corePath && Atomics.load(gate, 2)) {
              const admission = this.prepare(
                'SELECT state, workspace_id FROM workspace_recovery_admissions WHERE admission_id=?'
              ).get(workerData.admissionId);
              if (admission?.state === 'finished' && admission.workspace_id === workerData.workspaceId &&
                  Atomics.load(gate, 0) === 0) {
                Atomics.store(gate, 3, this.pragma('synchronous', { simple: true }));
                if (this.inTransaction) throw new Error('Registration COMMIT is still active.');
                // Publish readiness only after the observer's metadata is complete.
                Atomics.store(gate, 0, 1);
                Atomics.wait(gate, 1, 0);
              }
            }
            return result;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        const require = createRequire(import.meta.url);
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            ...selected,
            gate: new Int32Array(selected.gate),
            databaseModule: require.resolve('better-sqlite3'),
          },
        });
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...args) => {
          if (
            message.operation === 'recovery-target-registration' &&
            message.database === `core:${selected.corePath}` &&
            message.input?.admissionId === selected.admissionId &&
            message.input?.workspaceId === selected.workspaceId
          ) {
            if (registrationInterception.worker)
              throw new Error('Duplicate selected native registration post.');
            registrationInterception.worker = this;
            Atomics.store(new Int32Array(selected.gate), 2, 1);
            this.on('message', (reply) => {
              if (reply.id === message.id) registrationInterception.replied = true;
            });
          }
          return post(message, ...args);
        };
      }
    },
  };
});

const workspaceId = DEMO_WORKSPACE_ID;
const release = { releaseTag: 'v0.1.0-rc.11', sourceCommit: '1'.repeat(40) };
const roots: string[] = [];
const readmissionCleanups: (() => void)[] = [];
// Coordinator's release-policy addendum extends the callable stub without changing the binary grammar.
const runCli: (
  argv: readonly string[],
  write?: (line: string) => void,
  deps?: { releaseIdentityPath?: string }
) => Promise<WorkspaceRecoveryCliReport> = runWorkspaceRecoveryCli;

afterEach(async () => {
  registrationInterception.selected = undefined;
  registrationInterception.worker = undefined;
  registrationInterception.replied = false;
  await shutdownControlStoreWorkerClient();
  for (const cleanup of readmissionCleanups.splice(0).reverse()) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Hashes fixture-owned bytes independently of the bundle parser. */
function sha(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Reads retained rows without creating or migrating an absent authority. */
function rows(path: string, table: string): unknown[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

/** Copies a stopped owner's actual files, preserving required modes and omitting empty directories. */
function copyInventory(source: string, target: string, relative = '') {
  const result: { path: string; bytes: number; sha256: string; mode: number }[] = [];
  for (const name of readdirSync(join(source, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    if (/^(indexes|logs|projections)(\/|$)/.test(path)) continue;
    const from = join(source, path);
    const stat = statSync(from);
    if (stat.isDirectory()) result.push(...copyInventory(source, target, path));
    else {
      expect(stat.isFile()).toBe(true);
      const to = join(target, path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
      chmodSync(to, stat.mode & 0o777);
      const bytes = readFileSync(to);
      result.push({ path, bytes: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 });
    }
  }
  return result;
}

/** Makes a sealed input through existing native and hot-backup owners, independently of D0 capture. */
async function fixture(channelHistory = false, unfinished = false) {
  const root = mkdtempSync(join(tmpdir(), 'd0-restore-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const core = openCoreDb(dataRoot);
  const ownerId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: ownerId });
  const credential = createOpenKitAccessTokenRecord(core, {
    ownerUserId: ownerId,
    scope: 'workspace',
    workspaceIds: [workspaceId],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  core.sqlite.close();
  const db = openWorkspaceDb(dataRoot, workspaceId);
  try {
    recordWorkspaceEvidenceBundle(db, {
      id: 'evb_expiring',
      workspaceId,
      threadId: null,
      goalId: null,
      turnId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'diagnostic',
      summary: 'Old diagnostic',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [],
      contentDigests: [],
      retentionClass: 'ephemeral-diagnostic',
      sensitivityClass: 'restricted',
      importStatus: 'collected',
      requiredFeatures: [],
      createdAt: '2020-01-01T00:00:00.000Z',
    });
  } finally {
    db.sqlite.close();
  }
  let capturedTurnId: string | undefined;
  let capturedCallId: string | undefined;
  let capturedCaptureId: string | undefined;
  if (unfinished) {
    const turn = await store.createTurn(workspaceId, DEMO_THREAD_ID, 'Captured unfinished Turn', {
      kind: 'user',
      id: ownerId,
    });
    capturedTurnId = turn.id;
    expect(['completed', 'interrupted', 'cancelled', 'failed']).not.toContain(turn.status);
    const history = openWorkspaceDb(dataRoot, workspaceId);
    try {
      await openTestNativeWorkspace(history);
      capturedCallId = (
        await startCapabilityCall({
          authorityActor: { kind: 'user', id: ownerId },
          capabilityId: 'mcp.recovery.probe',
          family: 'mcp',
          operation: 'mcp.call-tool',
          redactionClass: 'metadata-only',
          workspaceDb: history,
          workspaceId,
        })
      ).id;
      capturedCaptureId = randomUUID();
      protectCapture(history, workspaceId, capturedCaptureId);
    } finally {
      history.sqlite.close();
    }
  }
  const pendingId = randomUUID();
  if (channelHistory) {
    const turn = await store.createTurn(workspaceId, DEMO_THREAD_ID, 'Historical channel request', {
      kind: 'user',
      id: ownerId,
    });
    const pendingDb = openWorkspaceDb(dataRoot, workspaceId);
    const now = new Date().toISOString();
    const itemId = pendingRequestItemId(pendingId, 'request');
    const questions = [
      {
        id: 'color',
        header: 'Color',
        question: 'Choose a color.',
        options: null,
        isOther: true,
        isSecret: false,
      },
    ];
    try {
      await raiseRecordedPendingRequest(
        store,
        pendingDb.sqlite,
        {
          requestId: pendingId,
          workspaceId,
          threadId: DEMO_THREAD_ID,
          raisingTurnId: turn.id,
          requestItemId: itemId,
          kind: 'user-input',
          requesterKind: 'person',
          responsibleUserId: ownerId,
          questions,
          questionDigest: 'd0-recovery-channel-question',
          now,
        },
        {
          id: itemId,
          owner: { kind: 'workspace', workspaceId },
          threadId: DEMO_THREAD_ID,
          turnId: turn.id,
          responsibleUserId: ownerId,
          type: 'user-input-request',
          status: 'completed',
          userInputRequestId: pendingId,
          prompt: 'Choose a color.',
          questions,
          createdAt: now,
          completedAt: now,
        }
      );
    } finally {
      pendingDb.sqlite.close();
    }
  }
  const channelQuery = {
    actor: { kind: 'session' as const, userId: ownerId },
    workspaceId,
    threadId: DEMO_THREAD_ID,
    pendingRequestId: pendingId,
  };
  // Exercise the actual channel admission owner without contacting an external transport.
  const inspectChannel = () => {
    const channelDb = openCoreDb(dataRoot);
    try {
      const channels = createChannelServices({
        coreDb: channelDb,
        store,
        mode: 'server',
        openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
        invokePending: async () => {
          throw new Error('An inspection must not dispatch a channel effect.');
        },
      });
      return channels.inspectPending(channelQuery);
    } finally {
      channelDb.sqlite.close();
    }
  };
  if (channelHistory)
    expect(inspectChannel()).toMatchObject({ status: 'available', responseAllowed: true });
  await shutdownControlStoreWorkerClient();
  const sourceDeploymentId = readDataRootLayoutMarker(dataRoot).deploymentId;
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId },
  });
  const parent = join(root, 'parent');
  await writeHotDataRootBackup({
    dataRoot,
    backupRoot: parent,
    backupId: allocateEntityId('drb'),
    sourceDeploymentId,
    startedAt: '2026-10-21T10:00:00.000Z',
    completedAt: '2026-10-21T10:00:00.000Z',
  });
  const bundleRoot = join(root, 'bundle');
  mkdirSync(bundleRoot, { mode: 0o700 });
  const inventory = copyInventory(join(parent, 'workspaces', workspaceId), bundleRoot);
  const sourceDb = new Database(workspaceDbPath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  let capturedRevision: number;
  try {
    capturedRevision = sourceDb
      .prepare('SELECT revision FROM control_workspaces WHERE id=?')
      .pluck()
      .get(workspaceId) as number;
  } finally {
    sourceDb.close();
  }
  const manifest = parseWorkspaceBackupManifest({
    format: 'openkit-workspace-backup',
    version: 1,
    purpose: 'backup',
    backupId: allocateEntityId('wsbak'),
    workspaceId,
    sourceDeploymentId,
    knowledgeBaseIds: [knowledgeBaseId],
    capturedRevision,
    priorMoves: [],
    release: { version: release.releaseTag, buildId: release.sourceCommit },
    requiredFeatures: [],
    databaseFormats: [{ path: 'db/workspace.sqlite', markers: { 'drizzle.workspace': 24 } }],
    capture: {
      startedAt: '2026-10-21T10:00:00.000Z',
      completedAt: '2026-10-21T10:00:00.000Z',
      consistency: 'quiescent',
    },
    inventory,
    inventoryDigest: sha(JSON.stringify(inventory)),
    coverage: {
      includedAuthorities: ['workspace-control', 'workspace-content', 'knowledge'],
      snapshotRoots: ['db', 'knowledge', 'evidence', 'config'],
      omittedProjections: ['indexes', 'logs', 'projections'],
      omittedVolumes: [],
      externalDependencies: [],
    },
    accounts: { ownerId, memberIds: [ownerId], privateAudienceRefs: [] },
  });
  const writeManifest = (value = manifest) => {
    const raw = JSON.stringify(value);
    writeFileSync(join(bundleRoot, 'manifest.json'), raw, { mode: 0o600 });
    writeFileSync(
      join(bundleRoot, 'seal.json'),
      JSON.stringify({
        format: 'openkit-workspace-backup-seal',
        version: 1,
        backupId: value.backupId,
        purpose: value.purpose,
        manifestDigest: sha(raw),
      }),
      { mode: 0o600 }
    );
  };
  writeManifest();
  const releaseIdentityPath = join(root, 'release-identity.json');
  writeFileSync(releaseIdentityPath, JSON.stringify(release), { mode: 0o600 });
  mkdirSync(join(root, 'staging'));
  await withVerifiedWorkspaceBackupBundle(
    {
      bundleRoot,
      stagingParent: join(root, 'staging'),
      admission: new FileStorageAdmission(root, () => 0n),
      expectedRelease: manifest.release,
      supportedDatabaseFormats: { 'drizzle.workspace': 24 },
    },
    async (verified) => {
      expect(verified.manifest).toEqual(manifest);
    }
  );
  const requestId = randomUUID();
  const argv = [
    'restore',
    '--data-root',
    dataRoot,
    '--bundle-root',
    bundleRoot,
    '--workspace-id',
    workspaceId,
    '--request-id',
    requestId,
  ];
  return {
    root,
    dataRoot,
    store,
    ownerId,
    credential,
    bundleRoot,
    manifest,
    writeManifest,
    releaseIdentityPath,
    requestId,
    argv,
    inspectChannel,
    capturedTurnId,
    capturedCallId,
    capturedCaptureId,
  };
}

/** Refusal oracles name the exact product code and reject disclosure or a success report. */
async function refuses(f: Awaited<ReturnType<typeof fixture>>, code: string, argv = f.argv) {
  const output: string[] = [];
  const error: unknown = await runCli(argv, (line) => output.push(line), f).catch(
    (value: unknown) => value
  );
  expect(error).toBeInstanceOf(WorkspaceRecoveryError);
  expect((error as WorkspaceRecoveryError).code).toBe(code);
  expect(output).toEqual([]);
  expect(String(error)).not.toContain(f.root);
}

/** Reaches boot quarantine through a real interrupted restore, with stale live read models. */
async function readmissionFixture(
  priorRecovery = false,
  interruption: 'before-target-rename' | 'after-target-rename' = 'before-target-rename',
  prepareCurrent?: (f: Awaited<ReturnType<typeof fixture>>, siblingId: string) => Promise<void>
) {
  const f = await fixture();
  let foreignRuntimeConfigManager: ReturnType<typeof createRuntimeConfigManager> | undefined;
  if (priorRecovery) {
    const foreignDataRoot = join(f.root, 'foreign-data-root');
    await createDemoStore({ dataRoot: foreignDataRoot });
    foreignRuntimeConfigManager = createRuntimeConfigManager({ dataRoot: foreignDataRoot });
  }
  const sibling = await f.store.createWorkspace('Readmission healthy sibling');
  const registry = openCoreDb(f.dataRoot);
  try {
    recordWorkspaceOwnerMembership({
      coreDb: registry,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
  } finally {
    registry.sqlite.close();
  }
  await prepareCurrent?.(f, sibling.id);
  const staleThread = await f.store.createThread(workspaceId, 'Newer than the restored snapshot');
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot: f.dataRoot });
  const configPath = join(f.dataRoot, 'workspaces', workspaceId, 'config/workspace.jsonc');
  const config = parseJsoncObject(readFileSync(configPath, 'utf8'), configPath);
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      workspace: {
        ...(config.workspace as Record<string, unknown>),
        name: 'Current recovered configuration',
      },
    })
  );
  await shutdownControlStoreWorkerClient();
  const input = {
    command: 'restore' as const,
    dataRoot: f.dataRoot,
    bundleRoot: f.bundleRoot,
    workspaceId,
    requestId: f.requestId,
    acknowledgeLostSafety: false,
    expectedRelease: f.manifest.release,
  };
  const priorRequestId = priorRecovery ? randomUUID() : undefined;
  if (priorRequestId) {
    await expect(
      admitWorkspaceBackup({ ...input, requestId: priorRequestId })
    ).resolves.toMatchObject({
      disposition: 'restored',
      workspaceId,
    });
  }
  let interrupted = false;
  await expect(
    admitWorkspaceBackup(input, {
      atBoundary: (point) => {
        if (point !== interruption) return;
        interrupted = true;
        throw new Error('Interrupt canonical placement for boot readmission.');
      },
    })
  ).rejects.toMatchObject({ code: 'recovery-required' });
  expect(interrupted).toBe(true);
  const core = openCoreDb(f.dataRoot);
  readmissionCleanups.push(() => core.sqlite.close());
  const lock = acquireDataRootLock(f.dataRoot, { bootId: randomUUID() });
  readmissionCleanups.push(() => lock.release());
  const gate = new WorkspaceMutationAdmission();
  restoreWorkspaceRecoveryAdmission(core, gate);
  f.store.setWorkspaceMutationAdmission(gate);
  const prepared = readRecoveryAdmission(core, f.requestId)!;
  expect(prepared.state).toBe('prepared');
  const freeze = resumeWorkspaceRecoveryOwner(core, prepared, gate, () => []);
  if (freeze.status !== 'frozen') throw new Error('Expected the boot-restored recovery freeze.');
  readmissionCleanups.push(() => freeze.release());
  const owner = {
    core,
    actor: { kind: 'local' as const, userId: ensureLocalUser(core) },
    fileAdmission: new FileStorageAdmission(f.dataRoot, () => 128n * 1024n * 1024n),
    native: { gate, freeze },
  };
  const activation = {
    requestId: f.requestId,
    store: f.store,
    runtimeConfigManager,
    currentAuthority: () => {},
  };
  return {
    ...f,
    sibling,
    staleThread,
    runtimeConfigManager,
    configPath,
    input,
    gate,
    freeze,
    owner,
    activation,
    priorRequestId,
    foreignRuntimeConfigManager,
  };
}

describe('D0-2 same-deployment restore', () => {
  it('retains the actual committed registration after its native host loses the FULL reply, then resolves by explicit selected replay', async () => {
    const f = await readmissionFixture(false, 'after-target-rename');
    await shutdownControlStoreWorkerClient();
    const gate = new Int32Array(new SharedArrayBuffer(16));
    registrationInterception.selected = {
      corePath: coreDbPath(f.dataRoot),
      admissionId: f.requestId,
      workspaceId,
      gate: gate.buffer as SharedArrayBuffer,
    };
    const client = getControlStoreWorkerClient(f.gate);
    const publish = client.recoveryTargetRegistration.bind(client);
    let nativeFailure: unknown;
    const publication = vi
      .spyOn(client, 'recoveryTargetRegistration')
      .mockImplementation(async (...args) => {
        try {
          return await publish(...args);
        } catch (error) {
          nativeFailure = error;
          throw error;
        }
      });
    const core = f.owner.core;
    core.sqlite.pragma('query_only = ON');
    const selected = {
      dataRoot: f.dataRoot,
      workspaceId,
      selection: { kind: 'admission' as const, requestId: f.requestId },
    };
    const placed = inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId));
    const before = readRecoveryAdmission(core, f.requestId)!;
    const tuple = () =>
      Object.fromEntries(
        [
          'workspace_recovery_admissions',
          'workspace_registry',
          'workspace_members',
          'recurring_schedules',
          'recurring_occurrences',
          'recurring_expired_ranges',
          'scheduler_admission_entries',
          'scheduler_execution_attempts',
          'audit_events',
        ].map((table) => [table, rows(coreDbPath(f.dataRoot), table)])
      );
    let settled = false;
    let command: Promise<unknown> | undefined;
    try {
      command = finishWorkspaceRecoveryAtCore(f.owner, selected).then(
        (result) => {
          settled = true;
          return { result };
        },
        (error) => {
          settled = true;
          return { error };
        }
      );
      while (Atomics.load(gate, 0) === 0 && !settled) await nextTurn();
      expect(
        Atomics.load(gate, 0),
        'Selected registration did not reach its actual native post-COMMIT gate.'
      ).toBe(1);
      expect(settled).toBe(false);
      expect(registrationInterception.replied).toBe(false);
      expect(Atomics.load(gate, 3)).toBe(2);
      const committed = tuple();
      const finished = readRecoveryAdmission(core, f.requestId)!;
      expect(finished).toMatchObject({ state: 'finished', revision: before.revision + 1 });
      expect(finished.proof.result).toMatchObject({ disposition: 'restored', workspaceId });
      expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
      const host = registrationInterception.worker;
      expect(host).toBeDefined();
      await host!.terminate();
      expect(await command).toHaveProperty('error');
      expect(nativeFailure).toMatchObject({ code: 'unavailable', commit: 'unknown' });
      expect(registrationInterception.replied).toBe(false);
      expect(tuple()).toEqual(committed);
      expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
      expect(f.gate.ownsFreeze(workspaceId, f.freeze)).toBe(true);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      registrationInterception.selected = undefined;
      await shutdownControlStoreWorkerClient();
      expect(inspectWorkspaceRecoveryAtCore(core, selected)).toMatchObject({
        command: 'inspect',
        disposition: 'restored',
        workspaceId,
        selection: selected.selection,
      });
      const replayPublication = vi.spyOn(
        getControlStoreWorkerClient(f.gate),
        'recoveryTargetRegistration'
      );
      try {
        const replay = await finishWorkspaceRecoveryAtCore(f.owner, selected);
        expect(replay).toEqual({
          ...finished.proof.result,
          command: 'finish',
          selection: selected.selection,
        });
        expect(replayPublication).not.toHaveBeenCalled();
      } finally {
        replayPublication.mockRestore();
      }
      expect(publication).toHaveBeenCalledTimes(1);
      expect(tuple()).toEqual(committed);
      expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
    } finally {
      registrationInterception.selected = undefined;
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      if (registrationInterception.worker) await registrationInterception.worker.terminate();
      await command;
      publication.mockRestore();
    }
  }, 120_000);

  it.each(['credential-revoked', 'freeze-released', 'registry-deleted'] as const)(
    'refuses selected registration after %s while its actual Core post is deferred',
    async (fault) => {
      const f = await readmissionFixture(false, 'after-target-rename');
      const core = f.owner.core;
      const token = createOpenKitAccessTokenRecord(core, {
        ownerUserId: f.ownerId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const actor = {
        kind: 'token' as const,
        userId: token.record.ownerUserId,
        tokenId: token.tokenId,
        tokenScope: token.record.scope,
        tokenWorkspaceIds: token.record.workspaceIds,
      };
      const owner = {
        ...f.owner,
        actor,
        currentAuthority: () => requireAdministratorOperation(core, actor, 'api.call'),
      };
      owner.currentAuthority();
      const client = getControlStoreWorkerClient(f.gate);
      const scope = nativeProductScope(f.dataRoot, { kind: 'server' });
      const database = `core:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: f.dataRoot,
        create: false,
        initialize: 'core',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      let release = await client.pauseForDataRootBackup(database);
      const selected = {
        dataRoot: f.dataRoot,
        workspaceId,
        selection: { kind: 'admission' as const, requestId: f.requestId },
      };
      const tuple = () =>
        Object.fromEntries(
          [
            'workspace_recovery_admissions',
            'workspace_registry',
            'workspace_members',
            'recurring_schedules',
            'recurring_occurrences',
            'recurring_expired_ranges',
            'scheduler_admission_entries',
            'scheduler_execution_attempts',
            'audit_events',
          ].map((table) => [table, rows(scope.path, table)])
        );
      const before = tuple();
      let expected = before;
      const placed = inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId));
      core.sqlite.pragma('query_only = ON');
      const publication = vi.spyOn(client, 'recoveryTargetRegistration');
      const actualOpen = client.open.bind(client);
      let upstreamOpenRejected = false;
      let upstreamOpenFailure: unknown;
      const opening = vi.spyOn(client, 'open').mockImplementation((...args) => {
        const operation = actualOpen(...args);
        void operation.catch((error: unknown) => {
          if (args[0].database === database) {
            upstreamOpenRejected = true;
            upstreamOpenFailure = error;
          }
        });
        return operation;
      });
      const posts = vi.spyOn(Worker.prototype, 'postMessage');
      const registrationPosts = () =>
        posts.mock.calls.filter(
          ([message]) =>
            message.operation === 'recovery-target-registration' &&
            message.database === database &&
            message.input?.admissionId === f.requestId &&
            message.input?.workspaceId === workspaceId
        );
      let settled = false;
      const command = finishWorkspaceRecoveryAtCore(owner, selected).then(
        (result) => {
          settled = true;
          return { result };
        },
        (error) => {
          settled = true;
          return { error };
        }
      );
      try {
        // A failed open can enter producer cleanup, whose real close waits for this
        // posting hold. Observe that rejection before joining the whole producer.
        while (!publication.mock.calls.length && !settled && !upstreamOpenRejected)
          await nextTurn();
        expect(
          upstreamOpenFailure,
          'Actual selected Core open rejected before registration.'
        ).toBeUndefined();
        expect(publication).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        expect(registrationPosts()).toEqual([]);
        if (fault === 'credential-revoked') {
          const writer = openCoreDb(f.dataRoot);
          try {
            revokeOpenKitAccessTokenRecord(writer, token.tokenId);
          } finally {
            writer.sqlite.close();
          }
        } else if (fault === 'freeze-released') f.freeze.release();
        else {
          const writer = openCoreDb(f.dataRoot);
          try {
            // Change the actual Core lifecycle through its domain owners. This
            // adversarial current fact is not a public deletion/file-closure fixture.
            writer.sqlite
              .transaction(() => {
                const registry = getWorkspaceRegistryLifecycleFact(writer, workspaceId)!;
                const deleting = beginWorkspaceDeletion({
                  coreDb: writer,
                  workspaceId,
                  originalOwnerUserId: f.ownerId,
                  expectedRegistryRevision: registry.registryRevision,
                });
                completeWorkspaceDeletion({
                  coreDb: writer,
                  workspaceId,
                  originalOwnerUserId: f.ownerId,
                  expectedRegistryRevision: deleting.registryRevision,
                });
              })
              .immediate();
          } finally {
            writer.sqlite.close();
          }
          expected = tuple();
          expect(expected.workspace_recovery_admissions).toEqual(
            before.workspace_recovery_admissions
          );
          expect(expected.workspace_registry).toContainEqual(
            expect.objectContaining({
              workspace_id: workspaceId,
              status: 'deleted',
            })
          );
        }
        release();
        release = () => {};
        expect(await command).toHaveProperty('error');
        expect(registrationPosts()).toHaveLength(fault === 'freeze-released' ? 0 : 1);
        expect(tuple()).toEqual(expected);
        expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
        expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
        expect(readRecoveryAdmission(core, f.requestId)?.state).toBe('prepared');
      } finally {
        release();
        await command;
        opening.mockRestore();
        publication.mockRestore();
        posts.mockRestore();
      }
    },
    120_000
  );

  it.each(['descriptive-extensions', 'unknown-core'] as const)(
    'selected registration preserves retained report compatibility for %s before committing its result',
    async (shape) => {
      const f = await readmissionFixture(false, 'after-target-rename');
      const retained = readRecoveryAdmission(f.owner.core, f.requestId)!;
      expect(retained.state).toBe('prepared');
      expect(retained.proof.candidateDigest).toBeTypeOf('string');
      const rawProof = f.owner.core.sqlite
        .prepare('SELECT proof_json FROM workspace_recovery_admissions WHERE admission_id=?')
        .pluck()
        .get(f.requestId) as string;
      const parent = verifyDataRootBackupManifest({
        backupRoot: join(dirname(f.dataRoot), 'parent'),
      }).manifest;
      const capture = {
        ...retained.proof.capture,
        futureCaptureDescription: { label: 'Original retained capture description' },
        coverage: {
          ...retained.proof.capture.coverage,
          futureCoverageDescription: { label: 'Original retained coverage description' },
        },
        source: {
          kind: 'data-root-backup' as const,
          dataRootBackupId: parent.id,
          consistency: parent.consistency,
          futureSourceDescription: { label: 'Original verified parent description' },
        },
      };
      const result = {
        ...retained.proof.result,
        capture,
        command:
          shape === 'unknown-core' ? 'unsupported-future-command' : retained.proof.result.command,
        futureReportDescription: { label: 'Original retained report description' },
      } as typeof retained.proof.result;
      const injected = { ...retained.proof, capture, result };
      // Retained-content fault/format specimen after genuine placement, following
      // the existing recovery-admission owner's corruption fixture. No authority changes.
      const changed = f.owner.core.sqlite
        .prepare(`UPDATE workspace_recovery_admissions
      SET proof_json=? WHERE admission_id=? AND workspace_id=? AND state='prepared'
      AND revision=? AND candidate_ref=? AND proof_json=?`)
        .run(
          JSON.stringify(injected),
          f.requestId,
          retained.workspace_id,
          retained.revision,
          retained.candidate_ref,
          rawProof
        );
      expect(changed.changes).toBe(1);
      const installed = readRecoveryAdmission(f.owner.core, f.requestId)!;
      expect(installed.state).toBe(retained.state);
      expect(installed.revision).toBe(retained.revision);
      expect(installed.candidate_ref).toBe(retained.candidate_ref);
      // Setup guards read real retained content, independent of the later expected snapshot.
      expect(installed.proof.result.command).toBe(
        shape === 'unknown-core' ? 'unsupported-future-command' : retained.proof.result.command
      );
      const descriptions = {
        futureCaptureDescription: { label: 'Original retained capture description' },
        coverage: {
          futureCoverageDescription: { label: 'Original retained coverage description' },
        },
        source: {
          kind: 'data-root-backup',
          dataRootBackupId: parent.id,
          consistency: parent.consistency,
          futureSourceDescription: { label: 'Original verified parent description' },
        },
      };
      expect(installed.proof.capture).toMatchObject(descriptions);
      expect(installed.proof.result).toMatchObject({
        capture: descriptions,
        futureReportDescription: { label: 'Original retained report description' },
      });
      expect(installed.proof).toEqual(injected);
      const client = getControlStoreWorkerClient(f.owner.native.gate);
      const publish = client.recoveryTargetRegistration.bind(client);
      let selectedCalls = 0;
      let nativeRefusal: unknown;
      const publication = vi
        .spyOn(client, 'recoveryTargetRegistration')
        .mockImplementation(async (...args) => {
          if (
            args[0] === `core:${coreDbPath(f.dataRoot)}` &&
            args[1].admissionId === f.requestId &&
            args[1].workspaceId === workspaceId
          ) {
            selectedCalls++;
            try {
              return await publish(...args);
            } catch (error) {
              nativeRefusal = error;
              throw error;
            }
          }
          return publish(...args);
        });
      onTestFinished(() => {
        try {
          expect(
            selectedCalls,
            'Selected registration must reach its real native method once.'
          ).toBe(1);
          if (shape === 'unknown-core')
            expect(nativeRefusal).toMatchObject({
              commit: 'not-committed',
              domain: {
                operation: 'recovery-target-registration',
                code: 'recovery-required',
                status: 409,
              },
            });
        } finally {
          publication.mockRestore();
        }
      });
      const before = readRecoveryAdmission(f.owner.core, f.requestId)!;
      const tuple = () =>
        Object.fromEntries(
          [
            'workspace_recovery_admissions',
            'workspace_registry',
            'workspace_members',
            'recurring_schedules',
            'recurring_occurrences',
            'recurring_expired_ranges',
            'scheduler_admission_entries',
            'scheduler_execution_attempts',
            'audit_events',
          ].map((table) => [table, rows(coreDbPath(f.dataRoot), table)])
        );
      const original = tuple();
      const placed = inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId));
      const selected = {
        dataRoot: f.dataRoot,
        workspaceId,
        selection: { kind: 'admission' as const, requestId: f.requestId },
      };
      f.owner.core.sqlite.pragma('query_only = ON');
      if (shape === 'unknown-core') {
        await expect(finishWorkspaceRecoveryAtCore(f.owner, selected)).rejects.toBeInstanceOf(
          Error
        );
        expect(tuple()).toEqual(original);
        expect(readRecoveryAdmission(f.owner.core, f.requestId)).toEqual(before);
      } else {
        const result = await finishWorkspaceRecoveryAtCore(f.owner, selected);
        const expected = {
          ...before.proof.result,
          disposition: 'restored',
          droppedSourceMemberIds: [],
          nextAction: 'none',
        };
        expect(result).toEqual({ ...expected, command: 'finish', selection: selected.selection });
        const finished = readRecoveryAdmission(f.owner.core, f.requestId)!;
        expect(finished).toMatchObject({ state: 'finished', revision: before.revision + 1 });
        expect(finished.proof).toEqual({ ...before.proof, result: expected });
        const committed = tuple();
        await expect(finishWorkspaceRecoveryAtCore(f.owner, selected)).resolves.toEqual(result);
        expect(tuple()).toEqual(committed);
      }
      expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
    },
    120_000
  );

  it('rolls restore pause history, queued and denied cancellation, Audit and result back together after late admission failure', async () => {
    let scheduleId = '';
    let queuedId = '';
    let deniedId = '';
    let cancelledId = '';
    let siblingQueueId = '';
    const f = await readmissionFixture(false, 'after-target-rename', async (current, siblingId) => {
      const core = openCoreDb(current.dataRoot);
      try {
        const instant = new Date(Date.now() - 30 * 60_000).toISOString();
        const schedules = new AutomationStore(
          core,
          new WorkspaceMutationAdmission(),
          () => instant
        );
        const schedule = await schedules.createAutomation(current.ownerId, {
          name: 'Current overdue definition',
          workspaceId,
          threadId: DEMO_THREAD_ID,
          intervalSeconds: 60,
          prompt: 'Restored work must stay interrupted.',
        });
        await schedules.updateAutomation(current.ownerId, schedule.id, {
          expectedRevision: 1,
          status: 'active',
          scheduledAt: instant,
        });
        scheduleId = schedule.id;
        const siblingThread = await current.store.createThread(siblingId, 'Current sibling queue');
        for (const [kind, selectedWorkspaceId, threadId] of [
          ['queued', workspaceId, DEMO_THREAD_ID],
          ['denied', workspaceId, DEMO_THREAD_ID],
          ['cancelled', workspaceId, DEMO_THREAD_ID],
          ['sibling', siblingId, siblingThread.id],
        ] as const) {
          const queueEntryId = randomUUID();
          createSchedulerAdmissionEntry(core, {
            backendId: 'nanohost',
            queueEntryId,
            requestId: randomUUID(),
            requestedAgentId: 'agent_codex_host',
            triggerActor: { kind: 'user', id: current.ownerId },
            turnInput: 'Retain the original recovery queue boundary.',
            workspaceId: selectedWorkspaceId,
            threadId,
            turnId: allocateEntityId('tu'),
          });
          if (kind === 'queued') queuedId = queueEntryId;
          if (kind === 'denied') {
            deniedId = queueEntryId;
            denySchedulerAdmissionEntry(core, { queueEntryId, denialReason: 'authority-denied' });
          }
          if (kind === 'cancelled') {
            cancelledId = queueEntryId;
            cancelSchedulerAdmissionEntry(core, { workspaceId, queueEntryId });
          }
          if (kind === 'sibling') siblingQueueId = queueEntryId;
        }
      } finally {
        core.sqlite.close();
      }
    });
    const core = f.owner.core;
    const corePath = coreDbPath(f.dataRoot);
    const tuple = () =>
      Object.fromEntries(
        [
          'workspace_recovery_admissions',
          'workspace_registry',
          'workspace_members',
          'recurring_schedules',
          'recurring_occurrences',
          'recurring_expired_ranges',
          'scheduler_admission_entries',
          'scheduler_execution_attempts',
          'audit_events',
        ].map((table) => [table, rows(corePath, table)])
      );
    const before = tuple();
    const prepared = readRecoveryAdmission(core, f.requestId)!;
    const placed = inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId));
    const sibling = inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.sibling.id));
    core.sqlite.exec(`CREATE TRIGGER restore_terminal_failure
      BEFORE UPDATE OF state ON workspace_recovery_admissions WHEN NEW.state='finished'
      BEGIN SELECT RAISE(ABORT, 'RESTORE_TERMINAL_FAULT'); END`);
    const selected = {
      dataRoot: f.dataRoot,
      workspaceId,
      selection: { kind: 'admission' as const, requestId: f.requestId },
    };
    await expect(finishWorkspaceRecoveryAtCore(f.owner, selected)).rejects.toBeInstanceOf(Error);
    expect(tuple()).toEqual(before);
    expect(readRecoveryAdmission(core, f.requestId)).toEqual(prepared);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.sibling.id))).toEqual(sibling);
    expect(f.gate.ownsFreeze(workspaceId, f.freeze)).toBe(true);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
    core.sqlite.exec('DROP TRIGGER restore_terminal_failure');
    core.sqlite.pragma('query_only = ON');
    const result = await finishWorkspaceRecoveryAtCore(f.owner, selected);
    expect(result).toMatchObject({
      disposition: 'restored',
      workspaceId,
      selection: selected.selection,
    });
    const committed = tuple();
    expect(committed.recurring_schedules).toContainEqual(
      expect.objectContaining({
        id: scheduleId,
        status: 'paused',
        revision: 3,
        next_scheduled_at: null,
      })
    );
    expect(committed.recurring_occurrences!.length).toBeGreaterThan(
      before.recurring_occurrences!.length
    );
    expect(committed.recurring_expired_ranges!.length).toBeGreaterThan(
      before.recurring_expired_ranges!.length
    );
    expect(committed.audit_events!.length).toBeGreaterThan(before.audit_events!.length);
    for (const queue_entry_id of [queuedId, deniedId, cancelledId])
      expect(committed.scheduler_admission_entries).toContainEqual(
        expect.objectContaining({
          queue_entry_id,
          status: 'cancelled',
        })
      );
    expect(committed.scheduler_admission_entries).toContainEqual(
      (before.scheduler_admission_entries as { queue_entry_id: string }[]).find(
        (row) => row.queue_entry_id === siblingQueueId
      )
    );
    expect(committed.workspace_registry).toEqual(before.workspace_registry);
    expect(committed.workspace_members).toEqual(before.workspace_members);
    const finished = readRecoveryAdmission(core, f.requestId)!;
    expect(finished).toMatchObject({ state: 'finished', revision: prepared.revision + 1 });
    expect(finished.proof.result).toMatchObject({ disposition: 'restored', workspaceId });
    await expect(finishWorkspaceRecoveryAtCore(f.owner, selected)).resolves.toEqual(result);
    expect(tuple()).toEqual(committed);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.sibling.id))).toEqual(sibling);
  }, 120_000);

  it('finishes the exact placed restore through the native Core owner with query-only Main', async () => {
    const f = await readmissionFixture(false, 'after-target-rename');
    const core = f.owner.core;
    const before = readRecoveryAdmission(core, f.requestId)!;
    const corePath = coreDbPath(f.dataRoot);
    const registry = rows(corePath, 'workspace_registry');
    const members = rows(corePath, 'workspace_members');
    const sibling = rows(workspaceDbPath(f.dataRoot, f.sibling.id), 'control_workspaces');
    const placed = inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId));
    expect(before.state).toBe('prepared');
    expect(before.proof.result.disposition).toBe('quarantined');
    expect(existsSync(before.candidate_ref)).toBe(false);
    core.sqlite.pragma('query_only = ON');
    expect(() =>
      core.sqlite
        .prepare('UPDATE workspace_recovery_admissions SET revision=revision WHERE admission_id=?')
        .run(f.requestId)
    ).toThrow(/readonly/i);
    const selection = { kind: 'admission' as const, requestId: f.requestId };
    const result = await finishWorkspaceRecoveryAtCore(f.owner, {
      dataRoot: f.dataRoot,
      workspaceId,
      selection,
    });
    expect(result).toMatchObject({
      command: 'finish',
      disposition: 'restored',
      workspaceId,
      selection,
      nextAction: 'none',
    });
    const finished = readRecoveryAdmission(core, f.requestId)!;
    expect(finished).toMatchObject({
      admission_id: before.admission_id,
      workspace_id: workspaceId,
      state: 'finished',
      revision: before.revision + 1,
      candidate_ref: before.candidate_ref,
    });
    expect(finished.proof).toEqual({
      ...before.proof,
      result: {
        ...before.proof.result,
        disposition: 'restored',
        droppedSourceMemberIds: [],
        nextAction: 'none',
      },
    });
    expect(rows(corePath, 'workspace_registry')).toEqual(registry);
    expect(rows(corePath, 'workspace_members')).toEqual(members);
    expect(rows(workspaceDbPath(f.dataRoot, f.sibling.id), 'control_workspaces')).toEqual(sibling);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', workspaceId))).toEqual(placed);
    expect(f.gate.ownsFreeze(workspaceId, f.freeze)).toBe(true);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
    await expect(
      finishWorkspaceRecoveryAtCore(f.owner, { dataRoot: f.dataRoot, workspaceId, selection })
    ).resolves.toEqual(result);
    expect(readRecoveryAdmission(core, f.requestId)).toEqual(finished);
  }, 120_000);

  it('selected abandon closes an unsealed native candidate before terminal authority or byte retirement', async () => {
    const f = await fixture();
    const core = openCoreDb(f.dataRoot);
    readmissionCleanups.push(() => core.sqlite.close());
    const lock = acquireDataRootLock(f.dataRoot, { bootId: randomUUID() });
    readmissionCleanups.push(() => lock.release());
    const gate = new WorkspaceMutationAdmission();
    const freeze = gate.tryFreeze(workspaceId, () => []);
    if (freeze.status !== 'frozen') throw new Error('Expected the original target freeze.');
    readmissionCleanups.push(() => freeze.release());
    const owner = {
      core,
      actor: { kind: 'local' as const, userId: ensureLocalUser(core) },
      fileAdmission: new FileStorageAdmission(f.dataRoot, () => 128n * 1024n * 1024n),
      native: { gate, freeze },
    };
    const client = getControlStoreWorkerClient(gate);
    const preparationFailure = new Error('Interrupted candidate preparation.');
    const closeFailure = new Error('Candidate native close is unavailable.');
    let candidateDatabase = '';
    let refuseClose = true;
    let closed = false;
    const cleanup = vi.spyOn(client, 'recoveryCleanup').mockImplementationOnce(async (database) => {
      candidateDatabase = database;
      throw preparationFailure;
    });
    const actualClose = client.close.bind(client);
    const closing = vi.spyOn(client, 'close').mockImplementation(async (...args) => {
      if (args[0] !== candidateDatabase) return actualClose(...args);
      const owned = readRecoveryAdmission(core, f.requestId)!;
      // Scoped Freeze requires actual writer exclusion before the first terminal Core effect.
      expect(owned.state).toBe('prepared');
      expect(existsSync(owned.candidate_ref)).toBe(true);
      if (refuseClose) throw closeFailure;
      await actualClose(...args);
      closed = true;
      expect(readRecoveryAdmission(core, f.requestId)?.state).toBe('prepared');
      expect(existsSync(owned.candidate_ref)).toBe(true);
    });
    try {
      await expect(
        admitWorkspaceBackupAtCore(owner, {
          command: 'restore',
          dataRoot: f.dataRoot,
          bundleRoot: f.bundleRoot,
          workspaceId,
          requestId: f.requestId,
          acknowledgeLostSafety: false,
          expectedRelease: f.manifest.release,
        })
      ).rejects.toBe(closeFailure);
      await expect(cleanup.mock.results[0]!.value).rejects.toBe(preparationFailure);
      const prepared = readRecoveryAdmission(core, f.requestId)!;
      expect(prepared.state).toBe('prepared');
      expect(prepared.proof.candidateDigest).toBeUndefined();
      expect(candidateDatabase).toBe(
        `workspace:${join(prepared.candidate_ref, 'db/workspace.sqlite')}`
      );
      const candidateBefore = inventoryRegularFiles(prepared.candidate_ref);
      const selected = {
        command: 'abandon' as const,
        dataRoot: f.dataRoot,
        workspaceId,
        selection: { kind: 'admission' as const, requestId: f.requestId },
      };
      await expect(abandonWorkspaceRecoveryAtCore(owner, selected)).rejects.toThrow();
      expect(readRecoveryAdmission(core, f.requestId)).toEqual(prepared);
      expect(inventoryRegularFiles(prepared.candidate_ref)).toEqual(candidateBefore);
      expect(closed).toBe(false);
      expect(gate.ownsFreeze(workspaceId, freeze)).toBe(true);
      refuseClose = false;
      await expect(abandonWorkspaceRecoveryAtCore(owner, selected)).resolves.toMatchObject({
        disposition: 'abandoned',
      });
      expect(closed).toBe(true);
      expect(readRecoveryAdmission(core, f.requestId)?.state).toBe('abandoned');
      expect(existsSync(prepared.candidate_ref)).toBe(false);
      // Native close can checkpoint SQLite; retained non-database content must stay exact.
      expect(
        inventoryRegularFiles(join(dirname(prepared.candidate_ref), 'abandoned')).filter(
          (entry) => !entry.path.startsWith('db/')
        )
      ).toEqual(candidateBefore.filter((entry) => !entry.path.startsWith('db/')));
    } finally {
      cleanup.mockRestore();
      closing.mockRestore();
    }
  }, 120_000);

  it.each(['before-target-rename', 'after-target-rename'] as const)(
    'readmission: selected abandon validates and reopens the preserved predecessor after %s',
    async (interruption) => {
      const f = await readmissionFixture(false, interruption);
      const prepared = readRecoveryAdmission(f.owner.core, f.requestId)!;
      const candidate = existsSync(prepared.candidate_ref)
        ? prepared.candidate_ref
        : join(f.dataRoot, 'workspaces', workspaceId);
      const retainedCandidate = inventoryRegularFiles(candidate);
      const selected = {
        command: 'abandon' as const,
        dataRoot: f.dataRoot,
        workspaceId,
        selection: { kind: 'admission' as const, requestId: f.requestId },
      };
      const result = await abandonWorkspaceRecoveryAtCore(f.owner, selected);
      expect(result).toMatchObject({ disposition: 'abandoned', nextAction: 'none' });
      const abandoned = readRecoveryAdmission(f.owner.core, f.requestId);
      expect(abandoned?.state).toBe('abandoned');
      // Target Admission requires retirement to preserve owned bytes, including retained holds.
      expect(inventoryRegularFiles(join(dirname(prepared.candidate_ref), 'abandoned'))).toEqual(
        retainedCandidate
      );
      await expect(
        finishWorkspaceRecoveryAtCore(f.owner, { ...selected, command: 'finish' })
      ).rejects.toBeInstanceOf(WorkspaceRecoveryError);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      expect(() => f.store.getWorkspace(workspaceId)).toThrow();
      refuseScope(f.dataRoot, { scope: 'workspace', id: f.sibling.id, check: 'database' });
      const independent = scopeAdmissionFailures(f.dataRoot).filter(
        (failure) => failure.id !== workspaceId || failure.check !== 'recovery'
      );
      let checkedAuthority = false;
      expect(
        activateWorkspaceRecoveryAtCore(f.owner, {
          ...f.activation,
          currentAuthority: () => {
            checkedAuthority = true;
            expect(f.gate.enter(workspaceId)).toBeNull();
            expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
          },
        })
      ).toEqual(result);
      expect(checkedAuthority).toBe(true);
      expect(readRecoveryAdmission(f.owner.core, f.requestId)).toEqual(abandoned);
      expect(scopeAdmissionFailures(f.dataRoot)).toEqual(independent);
      // Same-Deployment Restore step 5 requires canonical authority, not the retired candidate.
      expect(f.store.getThread(workspaceId, f.staleThread.id)).toMatchObject({
        id: f.staleThread.id,
      });
      expect(
        f.runtimeConfigManager
          .current()
          .workspaceConfigs.find((entry) => entry.workspaceId === workspaceId)?.config.workspace
          .name
      ).toBe('Current recovered configuration');
      f.freeze.release();
      await expect(f.store.createThread(workspaceId, 'Work after abandon')).resolves.toMatchObject({
        name: 'Work after abandon',
      });
    },
    120_000
  );

  it('readmission: an abandoned result cannot admit invalid predecessor Store or config', async () => {
    const f = await readmissionFixture(false, 'after-target-rename');
    const result = await abandonWorkspaceRecoveryAtCore(f.owner, {
      command: 'abandon',
      dataRoot: f.dataRoot,
      workspaceId,
      selection: { kind: 'admission', requestId: f.requestId },
    });
    const assertClosed = () => {
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      expect(f.gate.enter(workspaceId)).toBeNull();
      expect(() => f.store.getWorkspace(workspaceId)).toThrow();
    };
    // Same-Deployment Restore step 5 requires actual canonical Store validation after abandon.
    const native = new Database(workspaceDbPath(f.dataRoot, workspaceId), { fileMustExist: true });
    const retainedThread = native
      .prepare('SELECT record_json FROM control_threads WHERE id=?')
      .pluck()
      .get(f.staleThread.id) as string;
    try {
      native
        .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
        .run('{}', f.staleThread.id);
      expect(() => activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toThrow();
      assertClosed();
    } finally {
      native
        .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
        .run(retainedThread, f.staleThread.id);
      native.close();
    }
    const config = readFileSync(f.configPath);
    writeFileSync(f.configPath, '{ invalid predecessor config');
    expect(() => activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toThrow();
    assertClosed();
    writeFileSync(f.configPath, config);
    expect(activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toEqual(result);
    expect(f.store.getThread(workspaceId, f.staleThread.id).id).toBe(f.staleThread.id);
  }, 120_000);

  it('readmission: opens only the validated finished target and preserves independent scope failures', async () => {
    const f = await readmissionFixture();
    const result = await admitWorkspaceBackupAtCore(f.owner, f.input);
    expect(result).toMatchObject({ disposition: 'restored', workspaceId });
    const finished = readRecoveryAdmission(f.owner.core, f.requestId);
    expect(finished?.state).toBe('finished');
    expect(() => f.store.getWorkspace(workspaceId)).toThrow();
    await expect(f.store.createThread(workspaceId, 'Still closed')).rejects.toBeInstanceOf(Error);
    const siblingBefore = f.store.getWorkspace(f.sibling.id);
    const configBefore = f.runtimeConfigManager.current();
    expect(
      configBefore.workspaceConfigs.find((entry) => entry.workspaceId === workspaceId)?.config
        .workspace.name
    ).not.toBe('Current recovered configuration');
    const refusedSibling = allocateEntityId('ws');
    refuseScope(f.dataRoot, { scope: 'workspace', id: refusedSibling, check: 'database' });
    refuseScope(f.dataRoot, { scope: 'workspace', id: workspaceId, check: 'index' });
    const independent = scopeAdmissionFailures(f.dataRoot).filter(
      (failure) =>
        failure.scope !== 'workspace' || failure.id !== workspaceId || failure.check !== 'recovery'
    );
    let checkedAuthority = false;
    const activated = activateWorkspaceRecoveryAtCore(f.owner, {
      ...f.activation,
      currentAuthority: () => {
        checkedAuthority = true;
        expect(f.gate.enter(workspaceId)).toBeNull();
        expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      },
    });
    expect(activated).toEqual(result);
    expect(checkedAuthority).toBe(true);
    expect(readRecoveryAdmission(f.owner.core, f.requestId)).toEqual(finished);
    expect(scopeAdmissionFailures(f.dataRoot)).toEqual(independent);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(true);
    // Same-Deployment Restore step 5 requires the restored authority, never the predecessor cache.
    expect(f.store.getWorkspace(workspaceId).id).toBe(workspaceId);
    expect(() => f.store.getThread(workspaceId, f.staleThread.id)).toThrow();
    expect(
      f.runtimeConfigManager
        .current()
        .workspaceConfigs.find((entry) => entry.workspaceId === workspaceId)?.config.workspace.name
    ).toBe('Current recovered configuration');
    expect(
      f.runtimeConfigManager
        .current()
        .workspaceConfigs.find((entry) => entry.workspaceId === f.sibling.id)
    ).toEqual(configBefore.workspaceConfigs.find((entry) => entry.workspaceId === f.sibling.id));
    expect(f.store.getWorkspace(f.sibling.id)).toEqual(siblingBefore);
    f.freeze.release();
    const ordinary = f.gate.enter(workspaceId);
    expect(ordinary).toBeTypeOf('function');
    ordinary!();
    await expect(
      f.store.createThread(workspaceId, 'Recovered target accepts fresh work')
    ).resolves.toMatchObject({ name: 'Recovered target accepts fresh work' });
    await expect(
      f.store.createThread(f.sibling.id, 'Sibling remains usable')
    ).resolves.toMatchObject({ name: 'Sibling remains usable' });
  }, 120_000);

  it('readmission: terminal placement cannot override stale ownership, lost authority or invalid target', async () => {
    const f = await readmissionFixture(true);
    const assertClosed = () => {
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      expect(f.gate.enter(workspaceId)).toBeNull();
      expect(() => f.store.getWorkspace(workspaceId)).toThrow();
    };
    expect(() => activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toThrow(
      WorkspaceRecoveryError
    );
    assertClosed();
    // A previous result cannot settle the later recovery which owns the resumed boot closure.
    expect(readRecoveryAdmission(f.owner.core, f.priorRequestId!)?.state).toBe('finished');
    expect(() =>
      activateWorkspaceRecoveryAtCore(f.owner, { ...f.activation, requestId: f.priorRequestId! })
    ).toThrow(WorkspaceRecoveryError);
    assertClosed();
    const result = await admitWorkspaceBackupAtCore(f.owner, f.input);
    const finished = readRecoveryAdmission(f.owner.core, f.requestId);
    expect(result.disposition).toBe('restored');
    expect(() =>
      activateWorkspaceRecoveryAtCore(f.owner, {
        ...f.activation,
        runtimeConfigManager: f.foreignRuntimeConfigManager!,
      })
    ).toThrow(WorkspaceRecoveryError);
    assertClosed();
    expect(() =>
      activateWorkspaceRecoveryAtCore(f.owner, { ...f.activation, requestId: randomUUID() })
    ).toThrow(WorkspaceRecoveryError);
    const foreignGate = new WorkspaceMutationAdmission();
    const foreign = foreignGate.tryFreeze(workspaceId, () => []);
    if (foreign.status !== 'frozen') throw new Error('Expected the independent foreign freeze.');
    try {
      expect(() =>
        activateWorkspaceRecoveryAtCore(
          { ...f.owner, native: { gate: f.gate, freeze: foreign } },
          f.activation
        )
      ).toThrow(WorkspaceRecoveryError);
    } finally {
      foreign.release();
    }
    expect(() =>
      activateWorkspaceRecoveryAtCore(f.owner, {
        ...f.activation,
        currentAuthority: () => {
          throw new Error('Current administrator authority was revoked.');
        },
      })
    ).toThrow();
    assertClosed();
    // Same-Deployment Restore step 5 requires an authoritative open, not just valid config.
    const native = new Database(workspaceDbPath(f.dataRoot, workspaceId), { fileMustExist: true });
    const retainedThread = native
      .prepare('SELECT record_json FROM control_threads WHERE id=?')
      .pluck()
      .get(DEMO_THREAD_ID) as string;
    expect(JSON.parse(retainedThread)).toMatchObject({ id: DEMO_THREAD_ID });
    try {
      native
        .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
        .run('{}', DEMO_THREAD_ID);
      expect(() => activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toThrow();
      assertClosed();
    } finally {
      native
        .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
        .run(retainedThread, DEMO_THREAD_ID);
      native.close();
    }
    const config = readFileSync(f.configPath);
    writeFileSync(f.configPath, '{ invalid restored config');
    expect(() => activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toThrow();
    expect(readFileSync(f.configPath, 'utf8')).toBe('{ invalid restored config');
    assertClosed();
    writeFileSync(f.configPath, config);
    refuseScope(f.dataRoot, { scope: 'workspace', id: workspaceId, check: 'retired' });
    expect(() => activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toThrow();
    expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual({
      scope: 'workspace',
      id: workspaceId,
      check: 'retired',
    });
    f.freeze.release();
    expect(() => activateWorkspaceRecoveryAtCore(f.owner, f.activation)).toThrow();
    assertClosed();
    expect(readRecoveryAdmission(f.owner.core, f.requestId)).toEqual(finished);
  }, 120_000);

  it('prepares an admitted frozen target under the existing root lock without publishing it', async () => {
    const f = await fixture();
    const gate = new WorkspaceMutationAdmission();
    const freeze = gate.tryFreeze(workspaceId, () => []);
    if (freeze.status !== 'frozen') throw new Error('Expected an admitted target freeze.');
    const core = openCoreDb(f.dataRoot);
    const lock = acquireDataRootLock(f.dataRoot, { bootId: randomUUID() });
    try {
      getControlStoreWorkerClient(gate);
      let preparedCapacityChecks = 0;
      const owner = {
        core,
        actor: { kind: 'local' as const, userId: ensureLocalUser(core) },
        fileAdmission: new FileStorageAdmission(
          f.dataRoot,
          () => 128n * 1024n * 1024n,
          () => {
            if (readRecoveryAdmission(core, f.requestId)?.state === 'prepared')
              preparedCapacityChecks++;
            return 512n * 1024n * 1024n;
          }
        ),
        native: { gate, freeze },
      };
      const input = {
        command: 'restore' as const,
        dataRoot: f.dataRoot,
        bundleRoot: f.bundleRoot,
        workspaceId,
        requestId: f.requestId,
        acknowledgeLostSafety: false,
        expectedRelease: f.manifest.release,
      };
      const path = workspaceDbPath(f.dataRoot, workspaceId);
      const original = sha(readFileSync(path));
      const registry = rows(coreDbPath(f.dataRoot), 'workspace_registry');
      const wrongRoot = join(f.root, 'unrelated-target');
      await expect(
        admitWorkspaceBackupAtCore(owner, { ...input, dataRoot: wrongRoot })
      ).rejects.toBeInstanceOf(WorkspaceRecoveryError);
      expect(existsSync(wrongRoot)).toBe(false);
      expect(readRecoveryAdmission(core, f.requestId)).toBeUndefined();
      let reachedPlacement = false;
      let capacityChecksBeforePlacement = 0;
      let ordinary: Promise<unknown> | undefined;
      await expect(
        admitWorkspaceBackupAtCore(owner, input, {
          atBoundary: (point) => {
            if (point !== 'before-target-rename') return;
            reachedPlacement = true;
            capacityChecksBeforePlacement = preparedCapacityChecks;
            ordinary = f.store
              .createThread(workspaceId, 'Ordinary mutation remains frozen')
              .catch((error: unknown) => error);
            throw new Error('Stop admitted preparation before canonical placement.');
          },
        })
      ).rejects.toBeInstanceOf(Error);
      expect(reachedPlacement).toBe(true);
      expect(capacityChecksBeforePlacement).toBeGreaterThan(0);
      expect(await ordinary).toMatchObject({ code: 'workspace_frozen' });
      expect(gate.ownsFreeze(workspaceId, freeze)).toBe(true);
      const owned = readRecoveryAdmission(core, f.requestId)!;
      expect(owned).toMatchObject({ state: 'prepared', workspace_id: workspaceId });
      expect(owned.proof.manifest).toEqual(f.manifest);
      expect(owned.proof.result.disposition).toBe('quarantined');
      expect(owned.proof.candidateDigest).toBe(
        createHash('sha256')
          .update(JSON.stringify(inventoryRegularFiles(owned.candidate_ref)))
          .digest('hex')
      );
      expect(sha(readFileSync(path))).toBe(original);
      expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(registry);
      await expect(admitWorkspaceBackup(input)).rejects.toMatchObject({ code: 'root-locked' });
    } finally {
      freeze.release();
      core.sqlite.close();
      lock.release();
    }
  }, 120_000);

  it('rejoins the exact Core recovery owner after boot without clearing scoped quarantine', async () => {
    const f = await fixture();
    let reachedPlacement = false;
    await expect(
      admitWorkspaceBackup(
        {
          command: 'restore',
          dataRoot: f.dataRoot,
          bundleRoot: f.bundleRoot,
          workspaceId,
          requestId: f.requestId,
          acknowledgeLostSafety: false,
          expectedRelease: f.manifest.release,
        },
        {
          atBoundary: (point) => {
            if (point !== 'before-target-rename') return;
            reachedPlacement = true;
            throw new Error('Interrupt a real prepared recovery before canonical placement.');
          },
        }
      )
    ).rejects.toMatchObject({ code: 'recovery-required' });
    expect(reachedPlacement).toBe(true);
    const core = openCoreDb(f.dataRoot);
    try {
      const owned = readRecoveryAdmission(core, f.requestId)!;
      expect(owned.state).toBe('prepared');
      const gate = new WorkspaceMutationAdmission();
      restoreWorkspaceRecoveryAdmission(core, gate);
      const failures = scopeAdmissionFailures(f.dataRoot);
      expect(failures).toContainEqual({ scope: 'workspace', id: workspaceId, check: 'recovery' });
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      const inspect = vi.fn(() => {
        expect(gate.enter(workspaceId)).toBeNull();
        return [];
      });
      expect(gate.tryFreeze(workspaceId, inspect)).toEqual({ status: 'busy' });
      const client = getControlStoreWorkerClient(gate);
      const scope = nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId });
      const command = {
        database: `workspace:${scope.path}`,
        path: scope.path,
        dataRoot: f.dataRoot,
        productOwner: scope.owner,
        contentMount: scope.contentMount,
        create: false,
        initialize: 'workspace' as const,
      };
      await expect(client.open(command)).rejects.toMatchObject({ code: 'workspace_frozen' });
      expect(() =>
        resumeWorkspaceRecoveryOwner(
          core,
          { ...owned, revision: owned.revision + 1 },
          gate,
          inspect
        )
      ).toThrow(WorkspaceRecoveryError);
      expect(() =>
        resumeWorkspaceRecoveryOwner(core, { ...owned, admission_id: randomUUID() }, gate, inspect)
      ).toThrow(WorkspaceRecoveryError);
      expect(inspect).not.toHaveBeenCalled();
      const resumed = resumeWorkspaceRecoveryOwner(core, owned, gate, inspect);
      if (resumed.status !== 'frozen') throw new Error('Expected the exact boot recovery owner.');
      const native = bindWorkspaceRecoveryNativeOwner(core, owned, gate, resumed);
      expect(native.candidate.freeze).toBe(resumed);
      expect(native.canonical?.freeze).toBe(resumed);
      expect(scopeAdmissionFailures(f.dataRoot)).toEqual(failures);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
      const siblingId = allocateEntityId('ws');
      const sibling = gate.enter(siblingId);
      expect(sibling).toBeTypeOf('function');
      sibling!();
      expect(isScopeAdmitted(f.dataRoot, 'workspace', siblingId)).toBe(true);
      resumed.release();
      expect(gate.ownsFreeze(workspaceId, resumed)).toBe(false);
      expect(gate.enter(workspaceId)).toBeNull();
      const retried = resumeWorkspaceRecoveryOwner(core, owned, gate, inspect);
      if (retried.status !== 'frozen') throw new Error('Expected an explicit exact-owner retry.');
      resumed.release();
      expect(gate.ownsFreeze(workspaceId, retried)).toBe(true);
      retried.release();
      // A superseding independent refusal is a negative fault, never recovery authority.
      refuseScope(f.dataRoot, { scope: 'workspace', id: workspaceId, check: 'retired' });
      expect(() => resumeWorkspaceRecoveryOwner(core, owned, gate, inspect)).toThrow(
        WorkspaceRecoveryError
      );
      expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual({
        scope: 'workspace',
        id: workspaceId,
        check: 'retired',
      });
      expect(gate.enter(workspaceId)).toBeNull();
      expect(readRecoveryAdmission(core, f.requestId)).toEqual(owned);
    } finally {
      core.sqlite.close();
    }
  }, 120_000);

  it('keeps native recovery authority exact through freeze, rebinding and deferred posting', async () => {
    const f = await fixture();
    let reachedPlacement = false;
    await expect(
      admitWorkspaceBackup(
        {
          command: 'restore',
          dataRoot: f.dataRoot,
          bundleRoot: f.bundleRoot,
          workspaceId,
          requestId: f.requestId,
          acknowledgeLostSafety: false,
          expectedRelease: f.manifest.release,
        },
        {
          atBoundary: (point) => {
            if (point === 'before-target-rename') {
              reachedPlacement = true;
              throw new Error('Stop the valid private candidate before placement.');
            }
          },
        }
      )
    ).rejects.toMatchObject({ code: 'recovery-required' });
    expect(reachedPlacement).toBe(true);
    const core = openCoreDb(f.dataRoot);
    const owned = readRecoveryAdmission(core, f.requestId)!;
    expect(owned.state).toBe('prepared');
    const gate = new WorkspaceMutationAdmission();
    const otherGate = new WorkspaceMutationAdmission();
    const frozen = gate.tryFreeze(workspaceId, () => []);
    const other = otherGate.tryFreeze(workspaceId, () => []);
    if (frozen.status !== 'frozen' || other.status !== 'frozen')
      throw new Error('Expected independent admitted freezes.');
    const client = getControlStoreWorkerClient(gate);
    const canonicalScope = nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId });
    const privateRoot = dirname(dirname(owned.candidate_ref));
    const candidateScope = nativeProductScope(
      privateRoot,
      { kind: 'workspace', workspaceId },
      owned.candidate_ref
    );
    const canonicalCommand = {
      database: `workspace:${canonicalScope.path}`,
      path: canonicalScope.path,
      dataRoot: f.dataRoot,
      productOwner: canonicalScope.owner,
      contentMount: canonicalScope.contentMount,
      create: false,
      initialize: 'workspace' as const,
    };
    const candidateCommand = {
      database: `workspace:${candidateScope.path}`,
      path: candidateScope.path,
      dataRoot: privateRoot,
      productOwner: candidateScope.owner,
      contentMount: candidateScope.contentMount,
      create: false,
      initialize: 'workspace' as const,
    };
    const canonicalBefore = rows(canonicalScope.path, 'control_workspaces');
    const threadsBefore = rows(canonicalScope.path, 'control_threads');
    const candidateBefore = rows(candidateScope.path, 'control_workspaces');
    try {
      const native = bindWorkspaceRecoveryNativeOwner(core, owned, gate, frozen);
      if (!native.canonical) throw new Error('Restore must retain its canonical native binding.');
      await client.open(canonicalCommand, native.canonical);
      await client.close(canonicalCommand.database, native.canonical);
      await client.open(candidateCommand, native.candidate);
      await client.close(candidateCommand.database, native.candidate);
      await client.open(candidateCommand, native.candidate);
      await expect(
        f.store.createThread(workspaceId, 'Ordinary publisher stays frozen')
      ).rejects.toMatchObject({
        code: 'workspace_frozen',
      });
      await expect(client.open(candidateCommand)).rejects.toMatchObject({
        code: 'workspace_frozen',
      });
      await expect(client.open(canonicalCommand, native.candidate)).rejects.toBeInstanceOf(Error);
      const foreign = bindWorkspaceRecoveryNativeOwner(core, owned, otherGate, other);
      await expect(client.open(candidateCommand, foreign.candidate)).rejects.toBeInstanceOf(Error);
      expect(() =>
        bindWorkspaceRecoveryNativeOwner(
          core,
          { ...owned, revision: owned.revision + 1 },
          gate,
          frozen
        )
      ).toThrow(WorkspaceRecoveryError);
      const replacement = bindWorkspaceRecoveryNativeOwner(core, owned, gate, frozen);
      await expect(client.open(candidateCommand, native.candidate)).rejects.toBeInstanceOf(Error);
      await client.open(candidateCommand, replacement.candidate);
      const resume = await client.pauseForDataRootBackup(candidateCommand.database);
      let settled = false;
      const queued = client
        .write(
          candidateCommand.database,
          [
            {
              mode: 'run',
              sql: 'UPDATE control_workspaces SET revision=revision+1 WHERE id=?',
              parameters: [workspaceId],
            },
          ],
          replacement.candidate
        )
        .then(
          () => ({ accepted: true }),
          (error: unknown) => ({ accepted: false, error })
        )
        .finally(() => {
          settled = true;
        });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        frozen.release();
      } finally {
        resume();
      }
      expect(await queued).toMatchObject({ accepted: false, error: expect.any(Error) });
      await expect(client.open(candidateCommand, replacement.candidate)).rejects.toBeInstanceOf(
        Error
      );
      await client.close(candidateCommand.database);
      expect(rows(candidateScope.path, 'control_workspaces')).toEqual(candidateBefore);
      expect(rows(canonicalScope.path, 'control_workspaces')).toEqual(canonicalBefore);
      expect(rows(canonicalScope.path, 'control_threads')).toEqual(threadsBefore);
      expect(readRecoveryAdmission(core, f.requestId)).toEqual(owned);
    } finally {
      frozen.release();
      other.release();
      core.sqlite.close();
    }
  }, 120_000);

  it('WM target admission: candidate metadata refusal preserves the original Workspace and history', async () => {
    const f = await fixture();
    const originalPath = workspaceDbPath(f.dataRoot, workspaceId);
    const originalIdentity = statSync(originalPath);
    const originalBytes = sha(readFileSync(originalPath));
    const originalWorkspace = rows(originalPath, 'control_workspaces');
    const originalThreads = rows(originalPath, 'control_threads');
    const originalTurns = rows(originalPath, 'control_turns');
    const originalRegistry = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    const originalMembers = rows(coreDbPath(f.dataRoot), 'workspace_members');
    // Fault only the verified candidate's metadata transition after valid owner-created setup.
    const candidatePath = join(f.bundleRoot, 'db/workspace.sqlite');
    const candidate = new Database(candidatePath, { fileMustExist: true });
    try {
      candidate.exec(`CREATE TRIGGER refuse_candidate_metadata BEFORE UPDATE ON control_workspaces
        BEGIN SELECT RAISE(ABORT, 'CANDIDATE_METADATA_FAULT'); END`);
    } finally {
      candidate.close();
    }
    const bytes = readFileSync(candidatePath);
    const inventory = f.manifest.inventory.map((entry) =>
      entry.path === 'db/workspace.sqlite'
        ? { ...entry, bytes: bytes.length, sha256: sha(bytes) }
        : entry
    );
    f.writeManifest({ ...f.manifest, inventory, inventoryDigest: sha(JSON.stringify(inventory)) });
    await refuses(f, 'recovery-required');
    await expect(
      runCli(
        [
          'inspect',
          '--data-root',
          f.dataRoot,
          '--workspace-id',
          workspaceId,
          '--request-id',
          f.requestId,
        ],
        () => {},
        f
      )
    ).resolves.toMatchObject({ disposition: 'quarantined', workspaceId });
    // Target Admission's pre-publication refusal must leave the live authority and exact history intact.
    const currentIdentity = statSync(originalPath);
    expect({ dev: currentIdentity.dev, ino: currentIdentity.ino }).toEqual({
      dev: originalIdentity.dev,
      ino: originalIdentity.ino,
    });
    expect(sha(readFileSync(originalPath))).toBe(originalBytes);
    expect(rows(originalPath, 'control_workspaces')).toEqual(originalWorkspace);
    expect(rows(originalPath, 'control_threads')).toEqual(originalThreads);
    expect(rows(originalPath, 'control_turns')).toEqual(originalTurns);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(originalRegistry);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_members')).toEqual(originalMembers);
  });

  it('WM restore step 3: a current-safety copy failure refuses even with lost-safety acknowledgement', async () => {
    const f = await fixture();
    const originalPath = workspaceDbPath(f.dataRoot, workspaceId);
    const original = statSync(originalPath);
    const before = sha(readFileSync(originalPath));
    const safety = rows(originalPath, 'evidence_bundles');
    const authority = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    // Refuse only the private candidate's copy after valid current safety has been read.
    const candidatePath = join(f.bundleRoot, 'db/workspace.sqlite');
    const candidate = new Database(candidatePath, { fileMustExist: true });
    try {
      candidate.exec(`CREATE TRIGGER refuse_current_safety BEFORE INSERT ON evidence_bundles
        BEGIN SELECT RAISE(ABORT, 'CURRENT_SAFETY_COPY_FAULT'); END`);
    } finally {
      candidate.close();
    }
    const bytes = readFileSync(candidatePath);
    const inventory = f.manifest.inventory.map((entry) =>
      entry.path === 'db/workspace.sqlite'
        ? { ...entry, bytes: bytes.length, sha256: sha(bytes) }
        : entry
    );
    f.writeManifest({ ...f.manifest, inventory, inventoryDigest: sha(JSON.stringify(inventory)) });
    await refuses(f, 'recovery-required', [...f.argv, '--acknowledge-lost-safety']);
    // Same-Deployment Restore step 3 preserves provable safety; acknowledgement covers loss only.
    expect(statSync(originalPath).ino).toBe(original.ino);
    expect(sha(readFileSync(originalPath))).toBe(before);
    expect(rows(originalPath, 'evidence_bundles')).toEqual(safety);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(authority);
  }, 120_000);

  it('WM restore step 3: unavailable current config refuses replacement even with lost-safety acknowledgement', async () => {
    const f = await fixture();
    const originalPath = workspaceDbPath(f.dataRoot, workspaceId);
    const original = statSync(originalPath);
    const before = sha(readFileSync(originalPath));
    const safety = rows(originalPath, 'evidence_bundles');
    const authority = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    const configPath = join(f.dataRoot, 'workspaces', workspaceId, 'config/workspace.jsonc');
    // Current safety is readable; only the subsequent current-file copy is unavailable.
    rmSync(configPath);
    await refuses(f, 'recovery-required', [...f.argv, '--acknowledge-lost-safety']);
    expect(statSync(originalPath).ino).toBe(original.ino);
    expect(sha(readFileSync(originalPath))).toBe(before);
    expect(rows(originalPath, 'evidence_bundles')).toEqual(safety);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(authority);
    expect(existsSync(configPath)).toBe(false);
  }, 120_000);

  it('WM restore preparation: a refused recovery Audit publishes no replacement or success', async () => {
    const f = await fixture(false, true);
    const originalPath = workspaceDbPath(f.dataRoot, workspaceId);
    const original = statSync(originalPath);
    const before = sha(readFileSync(originalPath));
    const authority = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    const candidatePath = join(f.bundleRoot, 'db/workspace.sqlite');
    const candidate = new Database(candidatePath, { fileMustExist: true });
    try {
      candidate.exec(`CREATE TRIGGER refuse_recovery_audit BEFORE INSERT ON audit_events
        WHEN NEW.action = 'workspace.restore'
        BEGIN SELECT RAISE(ABORT, 'RECOVERY_AUDIT_FAULT'); END`);
    } finally {
      candidate.close();
    }
    const bytes = readFileSync(candidatePath);
    const inventory = f.manifest.inventory.map((entry) =>
      entry.path === 'db/workspace.sqlite'
        ? { ...entry, bytes: bytes.length, sha256: sha(bytes) }
        : entry
    );
    f.writeManifest({ ...f.manifest, inventory, inventoryDigest: sha(JSON.stringify(inventory)) });
    await refuses(f, 'recovery-required');
    // Same-Deployment Restore publishes only after complete private preparation, including Audit.
    expect(statSync(originalPath).ino).toBe(original.ino);
    expect(sha(readFileSync(originalPath))).toBe(before);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(authority);
    await expect(
      runCli(
        [
          'inspect',
          '--data-root',
          f.dataRoot,
          '--workspace-id',
          workspaceId,
          '--request-id',
          f.requestId,
        ],
        () => {},
        f
      )
    ).resolves.toMatchObject({ disposition: 'quarantined', workspaceId });
  });

  it('WM restore step 4: a captured unfinished Turn without a Pending Request is interrupted without replacement work', async () => {
    const f = await fixture(false, true);
    expect(f.capturedTurnId).toBeDefined();
    const dbPath = workspaceDbPath(f.dataRoot, workspaceId);
    // Warm the public metadata path after fixture shutdown, without prescribing its connection owner.
    const preparing = vi.spyOn(Database.prototype, 'prepare');
    onTestFinished(() => preparing.mockRestore());
    const before = f.store.getTurnMetadata(workspaceId, DEMO_THREAD_ID, f.capturedTurnId!);
    const readers = [
      ...new Set(
        (preparing.mock.contexts as Database.Database[]).filter(
          (sqlite) => sqlite.readonly && sqlite.name === dbPath
        )
      ),
    ];
    preparing.mockRestore();
    expect(before.status).toBe('running');
    expect(readers).toHaveLength(1);
    const reader = readers[0]!;
    const wasRetained = reader.open;
    const original = statSync(dbPath);
    let closedAt: { dev: number; ino: number } | undefined;
    const close = reader.close;
    const closing = vi.spyOn(reader, 'close').mockImplementation(function (
      this: Database.Database
    ) {
      if (this === reader) {
        const current = statSync(dbPath, { throwIfNoEntry: false });
        if (current) closedAt = { dev: current.dev, ino: current.ino };
      }
      return close.call(this);
    });
    onTestFinished(() => closing.mockRestore());
    expect(rows(dbPath, 'pending_requests')).toEqual([]);
    const beforeTurns = rows(dbPath, 'control_turns');
    const beforeAdmissions = rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries');
    const beforeAttempts = rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts');
    await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({
      disposition: 'restored',
      workspaceId,
    });
    // COORD07:1x: retained readers close while the final path still names the predecessor.
    expect(reader.open).toBe(false);
    if (wasRetained) expect(closedAt).toEqual({ dev: original.dev, ino: original.ino });
    const replacement = statSync(dbPath);
    expect({ dev: replacement.dev, ino: replacement.ino }).not.toEqual({
      dev: original.dev,
      ino: original.ino,
    });
    const restored = readNativeTurnHistory(
      nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId }),
      f.capturedTurnId!
    )!.turn;
    expect(restored).toMatchObject({
      id: f.capturedTurnId,
      owner: { kind: 'workspace', workspaceId },
      threadId: DEMO_THREAD_ID,
      status: 'interrupted',
      completedAt: expect.any(String),
    });
    expect(f.store.getTurnMetadata(workspaceId, DEMO_THREAD_ID, f.capturedTurnId!)).toMatchObject({
      id: f.capturedTurnId,
      owner: { kind: 'workspace', workspaceId },
      threadId: DEMO_THREAD_ID,
      status: 'interrupted',
      completedAt: restored.completedAt,
    });
    expect(rows(dbPath, 'control_turns')).toHaveLength(beforeTurns.length);
    expect(rows(dbPath, 'pending_requests')).toEqual([]);
    expect(rows(dbPath, 'control_executions')).toEqual([]);
    expect(rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries')).toEqual(beforeAdmissions);
    expect(rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts')).toEqual(beforeAttempts);
    // Restore step 4 retains uncertain effects as unknown and closes captured protection without replay.
    expect(rows(dbPath, 'capability_calls')).toEqual([
      expect.objectContaining({
        call_id: f.capturedCallId,
        status: 'unknown',
        error_code: 'capability_call_recovered_after_restart',
      }),
    ]);
    expect(rows(dbPath, 'workspace_capture_records')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capture_id: f.capturedCaptureId, state: 'finished' }),
      ])
    );
    expect(rows(dbPath, 'audit_events')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability_call_id: f.capturedCallId,
          action: 'capability.finish',
          outcome: 'unknown',
        }),
        expect.objectContaining({ action: 'workspace.restore', outcome: 'succeeded' }),
      ])
    );
  }, 120_000);

  it.each([
    {
      history: 'absent',
      outcome: 'succeeded',
      decision: 'removable',
      reason: 'cancelled-admission',
    },
    {
      history: 'retained-turn',
      outcome: 'succeeded',
      decision: 'refused',
      reason: 'mismatched-turn-lineage',
    },
    { history: 'corrupt', outcome: 'blocked', decision: 'refused', reason: 'unreadable-history' },
  ] as const)(
    'WM restore / scheduler maintenance: $history predecessor history preserves the global absence proof',
    async ({ history, outcome, decision, reason }) => {
      const f = await fixture();
      const sibling = await f.store.createWorkspace('Healthy checkpoint-maintenance sibling');
      const thread = await f.store.createThread(sibling.id, 'Failed pre-admission Task');
      const identity = {
        workspaceId: sibling.id,
        threadId: thread.id,
        turnId: allocateEntityId('tu'),
      };
      const requestId = randomUUID();
      // The Turn is newer than the backup cut and survives restore only in the predecessor.
      if (history === 'retained-turn') {
        await f.store.createTurn(
          workspaceId,
          DEMO_THREAD_ID,
          'Retained contradictory Turn',
          { kind: 'user', id: f.ownerId },
          null,
          { turnId: identity.turnId }
        );
      }
      await shutdownControlStoreWorkerClient();
      const core = openCoreDb(f.dataRoot);
      const siblingDb = openWorkspaceDb(f.dataRoot, sibling.id);
      try {
        recordWorkspaceOwnerMembership({
          coreDb: core,
          workspaceId: sibling.id,
          ownerUserId: f.ownerId,
        });
        const queueEntryId = `restore-maintenance-${requestId}`;
        createSchedulerAdmissionEntry(core, {
          backendId: 'nanohost',
          queueEntryId,
          requestId,
          requestedAgentId: 'agent_codex_host',
          triggerActor: { kind: 'user', id: f.ownerId },
          turnInput: 'Cancelled before Turn publication.',
          ...identity,
        });
        cancelSchedulerAdmissionEntry(core, { queueEntryId, workspaceId: sibling.id });
        await openTestNativeWorkspace(siblingDb);
        await upsertWorkerCheckpoint(siblingDb, {
          ...identity,
          requestId,
          requestInputHash: `sha256:${requestId}`,
          stage: 'failed',
          stopReason: 'error',
          workerSessionId: null,
          goalId: null,
          taskId: null,
          iteration: 0,
          contextDigest: null,
        });
      } finally {
        await shutdownControlStoreWorkerClient();
        siblingDb.sqlite.close();
        core.sqlite.close();
      }
      const backupRoot = join(f.root, 'checkpoint-backups');
      if (history === 'absent') {
        await expect(
          cleanCancelledAdmissionTaskCheckpoints({
            dataRoot: f.dataRoot,
            backupRoot,
            checkpoints: [identity],
          })
        ).resolves.toMatchObject({
          outcome: 'succeeded',
          rows: [{ ...identity, decision: 'removable', reason: 'cancelled-admission' }],
        });
      }
      // Enumerate only this finite fixture tree; recovery decides predecessor placement.
      const databasePaths = () =>
        readdirSync(f.root, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name === 'workspace.sqlite')
          .map((entry) => join(entry.parentPath, entry.name));
      const databasePathsBefore = new Set(databasePaths());
      const canonicalRootsBefore = readdirSync(join(f.dataRoot, 'workspaces')).sort();
      const originalWorkspaceBytes = sha(readFileSync(workspaceDbPath(f.dataRoot, workspaceId)));
      await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({ disposition: 'restored' });
      const predecessors = databasePaths()
        .filter((path) => !databasePathsBefore.has(path))
        .filter((path) =>
          rows(path, 'control_workspaces').some(
            (row) =>
              typeof row === 'object' && row !== null && 'id' in row && row.id === workspaceId
          )
        );
      expect(predecessors).toHaveLength(1);
      const predecessorDb = predecessors[0]!;
      expect(sha(readFileSync(predecessorDb))).toBe(originalWorkspaceBytes);
      expect(rows(predecessorDb, 'control_workspaces')).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: workspaceId })])
      );
      if (history === 'retained-turn') {
        expect(rows(predecessorDb, 'control_turns')).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: identity.turnId })])
        );
        expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_turns')).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: identity.turnId })])
        );
      }
      if (history === 'corrupt') {
        // Corrupt stopped retained metadata; production writers and constraints stay unchanged.
        const db = new Database(predecessorDb, { fileMustExist: true });
        try {
          db.pragma('ignore_check_constraints = ON');
          expect(
            db
              .prepare('UPDATE control_threads SET record_json = ? WHERE id = ?')
              .run('{', DEMO_THREAD_ID).changes
          ).toBe(1);
        } finally {
          db.close();
        }
      }
      const predecessorBytes = sha(readFileSync(predecessorDb));
      const siblingPath = workspaceDbPath(f.dataRoot, sibling.id);
      const checkpointsBefore = rows(siblingPath, 'worker_turn_checkpoints');
      const siblingTurnsBefore = rows(siblingPath, 'control_turns');
      const admissionsBefore = rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries');
      const attemptsBefore = rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts');
      const result = await cleanCancelledAdmissionTaskCheckpoints({
        dataRoot: f.dataRoot,
        backupRoot,
        checkpoints: [identity],
      });
      expect(result).toMatchObject({
        applied: false,
        backupRoot: null,
        outcome,
        removedCount: 0,
        rows: [{ ...identity, decision, reason }],
      });
      expect(rows(siblingPath, 'worker_turn_checkpoints')).toEqual(checkpointsBefore);
      expect(rows(siblingPath, 'control_turns')).toEqual(siblingTurnsBefore);
      expect(rows(coreDbPath(f.dataRoot), 'scheduler_admission_entries')).toEqual(admissionsBefore);
      expect(rows(coreDbPath(f.dataRoot), 'scheduler_execution_attempts')).toEqual(attemptsBefore);
      expect(sha(readFileSync(predecessorDb))).toBe(predecessorBytes);
      expect(readdirSync(join(f.dataRoot, 'workspaces')).sort()).toEqual(canonicalRootsBefore);
      expect(existsSync(backupRoot)).toBe(false);
    },
    120_000
  );

  it('WM 377–381: current registry, membership, grants, restrictions, holds and expiry win over backup state', async () => {
    const f = await fixture();
    const core = openCoreDb(f.dataRoot);
    revokeOpenKitAccessTokenRecord(core, f.credential.tokenId);
    const currentOwner = allocateEntityId('usr');
    const changedAt = new Date().toISOString();
    core.sqlite.transaction(() => {
      core.sqlite
        .prepare(`INSERT INTO users
        (id, kind, display_name, email, email_verified, created_at, updated_at, status)
        VALUES (?, 'human', 'Current owner', ?, 0, ?, ?, 'active')`)
        .run(currentOwner, `${currentOwner}@example.invalid`, Date.now(), Date.now());
      core.sqlite
        .prepare(`INSERT INTO workspace_members
        (workspace_id,user_id,status,invitation_id,joined_at,removed_at,revision,created_at,updated_at)
        VALUES (?,?,'active',NULL,?,NULL,1,?,?)`)
        .run(workspaceId, currentOwner, changedAt, changedAt, changedAt);
      core.sqlite
        .prepare(`UPDATE workspace_registry SET owner_user_id=?, revision=revision+1, updated_at=?
        WHERE workspace_id=?`)
        .run(currentOwner, changedAt, workspaceId);
      core.sqlite
        .prepare(`UPDATE workspace_members SET status='removed', removed_at=?, revision=revision+1,
        updated_at=? WHERE workspace_id=? AND user_id=?`)
        .run(changedAt, changedAt, workspaceId, f.ownerId);
    })();
    core.sqlite.close();
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      recordWorkspaceEvidenceBundle(db, {
        id: 'evb_current_hold',
        workspaceId,
        threadId: null,
        goalId: null,
        turnId: null,
        agentSessionId: null,
        backendType: null,
        sourceKind: 'legal-hold',
        summary: 'Current hold',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [],
        contentDigests: [],
        retentionClass: 'legal-hold',
        sensitivityClass: 'restricted',
        importStatus: 'collected',
        requiredFeatures: [],
        createdAt: new Date().toISOString(),
      });
      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb: db,
          workspaceId,
          olderThan: '2021-01-01T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 1 });
    } finally {
      db.sqlite.close();
    }
    const configPath = join(f.dataRoot, 'workspaces', workspaceId, 'config/workspace.jsonc');
    const policy = managedThreadPolicy({
      workspaceId,
      threadId: DEMO_THREAD_ID,
      userId: f.ownerId,
    });
    const priorConfig = WorkspaceConfigSchema.parse(
      parseJsoncObject(readFileSync(configPath, 'utf8'))
    );
    const config = WorkspaceConfigSchema.parse({
      ...priorConfig,
      schemaVersion: 1,
      requiredFeatures: [
        ...new Set([...(priorConfig.requiredFeatures ?? []), WORKSPACE_RESOURCE_POLICY_FEATURE]),
      ],
      workspace: {
        ...priorConfig.workspace,
        name: 'Current restricted Workspace',
        policy: { mediation: policy },
      },
    });
    const configBytes = Buffer.from(
      `// Current post-capture policy: 🌍\r\n${JSON.stringify(config, null, 2)}\r\n`,
      'utf8'
    );
    writeFileSync(configPath, configBytes);
    const capturedCatalog = readWorkspaceResourceCatalog(f.dataRoot, workspaceId);
    const currentCatalog = {
      ...capturedCatalog,
      revision: capturedCatalog.revision + 1,
      recoveryNote: 'Current post-capture catalog',
      mcp: { ...capturedCatalog.mcp, recoveryNote: 'Retained current annotation' },
    };
    publishWorkspaceResourceCatalog({
      dataRoot: f.dataRoot,
      workspaceId,
      expectedRevision: capturedCatalog.revision,
      catalog: currentCatalog,
    });
    const current = Object.fromEntries(
      ['workspace_registry', 'workspace_members', 'openkit_access_tokens'].map((table) => [
        table,
        rows(coreDbPath(f.dataRoot), table),
      ])
    );
    const safety = rows(workspaceDbPath(f.dataRoot, workspaceId), 'evidence_bundles');
    const output: string[] = [];
    // The public CLI accepts a relative root with the same current-safety obligations.
    const relativeRoot = relative(process.cwd(), f.dataRoot);
    const argv = f.argv.map((value) => (value === f.dataRoot ? relativeRoot : value));
    const promise = runCli(argv, (line) => output.push(line), f);
    await expect(promise).resolves.toMatchObject({
      command: 'restore',
      disposition: 'restored',
      workspaceId,
      restrictedRecovery: false,
      capture: { backupId: f.manifest.backupId, sourceDeploymentId: f.manifest.sourceDeploymentId },
    });
    const report = await promise;
    for (const [table, expected] of Object.entries(current))
      expect(rows(coreDbPath(f.dataRoot), table)).toEqual(expected);
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'evidence_bundles')).toEqual(safety);
    expect(readFileSync(configPath)).toEqual(configBytes);
    expect(
      WorkspaceConfigSchema.parse(parseJsoncObject(readFileSync(configPath, 'utf8'))).workspace
        .policy?.mediation
    ).toEqual(policy);
    expect(readWorkspaceResourceCatalog(f.dataRoot, workspaceId)).toEqual(currentCatalog);
    expect(output.map((line) => JSON.parse(line))).toEqual([report]);
    expect(output.join('')).not.toContain(f.root);
  }, 120_000);

  it('WM 377: a verified bundle from another deployment refuses deployment-mismatch before replacement', async () => {
    const f = await fixture();
    f.writeManifest({ ...f.manifest, sourceDeploymentId: allocateEntityId('dep') });
    const before = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces');
    await refuses(f, 'deployment-mismatch');
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces')).toEqual(before);
  }, 120_000);

  it('WM 381, 385, 389: lost safety without acknowledgement stays quarantined and creates no replacement', async () => {
    const f = await fixture();
    rmSync(workspaceDbPath(f.dataRoot, workspaceId));
    await refuses(f, 'safety-unproved');
    expect(existsSync(workspaceDbPath(f.dataRoot, workspaceId))).toBe(false);
    await expect(
      runCli(
        [
          'inspect',
          '--data-root',
          f.dataRoot,
          '--workspace-id',
          workspaceId,
          '--request-id',
          f.requestId,
        ],
        () => {},
        f
      )
    ).resolves.toMatchObject({
      command: 'inspect',
      disposition: 'quarantined',
      workspaceId,
      selection: { kind: 'admission', requestId: f.requestId },
    });
  }, 120_000);

  it('WM 385–387: acknowledged restricted recovery records the exact backup and bounded loss window', async () => {
    const f = await fixture(true);
    const core = openCoreDb(f.dataRoot);
    const instant = new Date().toISOString();
    const schedules = new AutomationStore(core, new WorkspaceMutationAdmission(), () => instant);
    const schedule = await schedules.createAutomation(f.ownerId, {
      name: 'Current automation',
      workspaceId,
      threadId: DEMO_THREAD_ID,
      intervalSeconds: 60,
      prompt: 'Must not run after restricted recovery',
    });
    await schedules.updateAutomation(f.ownerId, schedule.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: instant,
    });
    core.sqlite.close();
    rmSync(workspaceDbPath(f.dataRoot, workspaceId));
    const before = Date.now();
    const promise = runCli([...f.argv, '--acknowledge-lost-safety'], () => {}, f);
    await expect(promise).resolves.toMatchObject({
      disposition: 'restored',
      workspaceId,
      restrictedRecovery: {
        backupId: f.manifest.backupId,
        captureStartedAt: f.manifest.capture.startedAt,
      },
    });
    const report = await promise;
    expect(report.restrictedRecovery).not.toBe(false);
    if (report.restrictedRecovery === false)
      throw new Error('Restricted recovery was not reported.');
    expect(Date.parse(report.restrictedRecovery.lossDetectedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(report.restrictedRecovery.lossDetectedAt)).toBeLessThanOrEqual(Date.now());
    expect(rows(coreDbPath(f.dataRoot), 'recurring_schedules')).toEqual([
      expect.objectContaining({ id: schedule.id, status: 'paused', next_scheduled_at: null }),
    ]);
    expect(f.inspectChannel()).toMatchObject({ status: 'unavailable' });
    const audit = rows(workspaceDbPath(f.dataRoot, workspaceId), 'audit_events');
    expect(
      audit.some(
        (row) =>
          JSON.stringify(row).includes(f.manifest.backupId) &&
          JSON.stringify(row).includes(
            report.restrictedRecovery === false ? '' : report.restrictedRecovery.captureStartedAt
          )
      )
    ).toBe(true);
  }, 120_000);

  it('WM 389 / exact-command restart: committed restore wins before rereading a subsequently damaged bundle', async () => {
    const f = await fixture();
    const first = runCli(f.argv, () => {}, f);
    await expect(first).resolves.toMatchObject({ disposition: 'restored', workspaceId });
    const committed = await first;
    writeFileSync(join(f.bundleRoot, 'manifest.json'), 'AFTER-COMMIT-DAMAGE');
    const before = rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces');
    await expect(runCli(f.argv, () => {}, f)).resolves.toEqual(committed);
    expect(rows(workspaceDbPath(f.dataRoot, workspaceId), 'control_workspaces')).toEqual(before);
  }, 120_000);

  it('WM 389 / command identity: changed backup under the same request refuses request-conflict', async () => {
    const f = await fixture();
    await expect(runCli(f.argv, () => {}, f)).resolves.toMatchObject({ disposition: 'restored' });
    f.writeManifest({ ...f.manifest, backupId: allocateEntityId('wsbak') });
    await refuses(f, 'request-conflict');
  }, 120_000);

  it.each(['releaseTag', 'sourceCommit'] as const)(
    'WM 356, 379: a different installed %s refuses release-mismatch',
    async (field) => {
      const f = await fixture();
      writeFileSync(
        f.releaseIdentityPath,
        JSON.stringify({
          ...release,
          [field]: field === 'releaseTag' ? 'v0.1.0-rc.12' : '2'.repeat(40),
        })
      );
      await refuses(f, 'release-mismatch');
    },
    120_000
  );
});

// Same-Deployment Restore requires current authority and an authoritative open before serving.
// Use the bound manager and the original native reply; unchanged Policy may elide close/activate.
describe('Recovery readmission joins bound native Policy publication', () => {
  it.each(['current-owner', 'revoked-credential', 'released-freeze'] as const)(
    'keeps serving excluded until publication and fresh ownership: %s',
    async (fault) => {
      const f = await readmissionFixture();
      const core = f.owner.core;
      const token = createOpenKitAccessTokenRecord(core, {
        ownerUserId: f.ownerId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const actor = {
        kind: 'token' as const,
        userId: token.record.ownerUserId,
        tokenId: token.tokenId,
        tokenScope: token.record.scope,
        tokenWorkspaceIds: token.record.workspaceIds,
      };
      let replyReleased = false;
      let authorityCheckedAfterReply = false;
      const currentAuthority = () => {
        requireAdministratorOperation(core, actor, 'api.call');
        if (replyReleased) authorityCheckedAfterReply = true;
      };
      const owner = { ...f.owner, actor, currentAuthority };
      currentAuthority();
      const report = await admitWorkspaceBackupAtCore(owner, f.input);
      expect(report).toMatchObject({ disposition: 'restored', workspaceId });
      const finished = readRecoveryAdmission(core, f.requestId);
      expect(finished?.state).toBe('finished');
      const failures = scopeAdmissionFailures(f.dataRoot);
      const sibling = f.store.getWorkspace(f.sibling.id);
      const previous = f.runtimeConfigManager.current();
      await f.runtimeConfigManager.bindNativePolicyPublication(core);
      const client = getControlStoreWorkerClient(f.gate);
      const publish = client.runtimePolicyPublication.bind(client);
      expect((await publish(core, { kind: 'inspect' })).state).toBe('active');
      let releaseInspect!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseInspect = resolve;
      });
      let inspectArrived!: () => void;
      const inspected = new Promise<void>((resolve) => {
        inspectArrived = resolve;
      });
      let held = false;
      const publication = vi
        .spyOn(client, 'runtimePolicyPublication')
        .mockImplementation(async (db, input) => {
          // Always await the real native owner. Only its original reply is delayed.
          const result = await publish(db, input);
          if (db === core && input.kind === 'inspect' && !held) {
            held = true;
            inspectArrived();
            await release;
          }
          return result;
        });
      let settled = false;
      let completion: Promise<unknown> | undefined;
      try {
        const pending = Promise.resolve(
          activateWorkspaceRecoveryAtCore(owner, { ...f.activation, currentAuthority })
        );
        const outcome = pending.then(
          (value) => {
            settled = true;
            return { status: 'fulfilled' as const, value };
          },
          (error: unknown) => {
            settled = true;
            return { status: 'rejected' as const, error };
          }
        );
        completion = outcome;
        expect(
          await Promise.race([
            inspected.then(() => 'native-reply-held'),
            outcome.then(() => 'recovery-settled'),
          ])
        ).toBe('native-reply-held');
        expect(held).toBe(true);
        expect(settled).toBe(false);
        expect(f.gate.ownsFreeze(workspaceId, f.freeze)).toBe(true);
        expect(f.gate.enter(workspaceId)).toBeNull();
        expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
        expect(() => f.store.getWorkspace(workspaceId)).toThrow();
        expect(f.runtimeConfigManager.current()).toBe(previous);
        expect(readRecoveryAdmission(core, f.requestId)).toEqual(finished);
        expect(scopeAdmissionFailures(f.dataRoot)).toEqual(failures);
        expect(f.store.getWorkspace(f.sibling.id)).toEqual(sibling);

        if (fault === 'revoked-credential') revokeOpenKitAccessTokenRecord(core, token.tokenId);
        if (fault === 'released-freeze') f.freeze.release();
        replyReleased = true;
        releaseInspect();
        const result = await outcome;
        expect(settled).toBe(true);
        expect(readRecoveryAdmission(core, f.requestId)).toEqual(finished);
        expect(f.store.getWorkspace(f.sibling.id)).toEqual(sibling);
        if (fault === 'current-owner') {
          expect(result.status).toBe('fulfilled');
          if (result.status !== 'fulfilled') throw new Error('Recovery did not complete.');
          expect(result.value).toEqual(report);
          expect(authorityCheckedAfterReply).toBe(true);
          expect(f.runtimeConfigManager.current()).not.toBe(previous);
          expect(
            f.runtimeConfigManager
              .current()
              .workspaceConfigs.find((entry) => entry.workspaceId === workspaceId)?.config.workspace
              .name
          ).toBe('Current recovered configuration');
          expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(true);
          expect(f.store.getWorkspace(workspaceId).id).toBe(workspaceId);
          expect(() => f.store.getThread(workspaceId, f.staleThread.id)).toThrow();
          expect(scopeAdmissionFailures(f.dataRoot)).toEqual(
            failures.filter(
              (failure) =>
                failure.scope !== 'workspace' ||
                failure.id !== workspaceId ||
                failure.check !== 'recovery'
            )
          );
          f.freeze.release();
          const admission = f.gate.enter(workspaceId);
          expect(admission).toBeTypeOf('function');
          admission!();
        } else {
          // This direct module API propagates owner refusal; it does not map every
          // rejection to the public source-capture operation's recovery-required code.
          expect(result.status).toBe('rejected');
          if (result.status !== 'rejected') throw new Error('Recovery unexpectedly completed.');
          expect(result.error).toBeInstanceOf(Error);
          expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
          expect(f.gate.enter(workspaceId)).toBeNull();
          expect(() => f.store.getWorkspace(workspaceId)).toThrow();
          expect(scopeAdmissionFailures(f.dataRoot)).toEqual(failures);
          expect(f.gate.ownsFreeze(workspaceId, f.freeze)).toBe(fault !== 'released-freeze');
          if (fault === 'released-freeze') {
            expect(f.runtimeConfigManager.current()).toBe(previous);
          }
        }
      } finally {
        releaseInspect();
        await completion;
        publication.mockRestore();
      }
    }
  );
});
