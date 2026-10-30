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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  ModuleKind,
  type Node,
  ScriptTarget,
  transpileModule,
} from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBetterAuth } from '../auth/better-auth.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { isScopeAdmitted, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
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
import { OperationError, projectOperationError } from '../operation-error.js';
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
  type SchedulerAttemptMaintenanceInput,
  startSchedulerAttemptMaintenanceService,
} from '../runtime/scheduler-attempt-maintenance-service.js';
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
import { workspaceMembershipDecisionFixture } from '../test-support/resource-policy.js';
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
  type ControlTerminalTransition,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import * as databaseOwner from './db.js';
import { bindWorkspaceSqlite, openCoreDb, openWorkspaceDb, openWorkspaceReadDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import * as migrationOwner from './migrate.js';
import {
  createWorkspaceBackup,
  readBlockers,
  readWorkspaceRecoveryBlockers,
  runWorkspaceSnapshotMaintenance,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import {
  type VerifiedWorkspaceBackupBundle,
  withVerifiedWorkspaceBackupBundle,
  withVerifiedWorkspaceSnapshotSource,
} from './workspace-backup-bundle.js';
import { abandonCapture, inspectCapture, protectCapture } from './workspace-capture-protection.js';
import {
  ensureCanonicalDirectory,
  nativeProductScope,
  readNativeProductEntries,
  readNativeTurnHistory,
} from './workspace-file-records.js';
import { endRecoveryAdmission, readRecoveryAdmission } from './workspace-recovery-admissions.js';

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

const captureWorkerProbe = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  script: undefined as string | undefined,
  observe: undefined as
    | undefined
    | ((message: { kind: string; workspaceId?: string; captureId?: string }) => void),
  payloadHex: undefined as string | undefined,
  payloadName: 'cut-only-observation.bin',
  events: [] as { kind: 'hash' | 'sync'; phase: string; threadId: number }[],
  workers: [] as import('node:worker_threads').Worker[],
  onNativeMessage: undefined as
    | undefined
    | ((worker: import('node:worker_threads').Worker, message: unknown) => boolean),
  onPhase: undefined as
    | undefined
    | ((worker: import('node:worker_threads').Worker, message: { phase: string }) => boolean),
}));

// Wrap the actual private entry. Test observations never enter its production handoff parser.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const capture = String(filename).includes('workspace-backup-worker');
        if (capture && (captureWorkerProbe.payloadHex || captureWorkerProbe.script)) {
          const prelude = `
            const { parentPort, threadId, workerData } = require('node:worker_threads');
            const oracleGate = workerData?.__captureOracleGate ? new Int32Array(workerData.__captureOracleGate) : undefined;
            if (workerData) delete workerData.__captureOracleGate;
            const fs = require('node:fs');
            const crypto = require('node:crypto');
            const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});
            const selected = ${JSON.stringify(captureWorkerProbe.payloadHex)};
            const selectedName = ${JSON.stringify(captureWorkerProbe.payloadName)};
            const post = parentPort.postMessage.bind(parentPort);
            let phase = 'preflight';
            parentPort.postMessage = function(message, ...args) {
              if (message && typeof message.phase === 'string') phase = message.phase;
              return post(message, ...args);
            };
            function observe(kind, fields = {}) { post({ __captureOracle: true, kind, phase, threadId, ...fields }); }
            const prototype = Object.getPrototypeOf(crypto.createHash('sha256'));
            const update = prototype.update;
            prototype.update = function(data, ...args) {
              if ((typeof data === 'string' || Buffer.isBuffer(data)) && Buffer.from(data).toString('hex') === selected) observe('hash');
              return update.call(this, data, ...args);
            };
            function selectedFile(fd) {
              return fs.realpathSync('/proc/self/fd/' + fd).endsWith('/' + selectedName);
            }
            const sync = fs.fsyncSync;
            fs.fsyncSync = function(fd, ...args) { if (selectedFile(fd)) observe('sync'); return sync.call(this, fd, ...args); };
            const open = fs.promises.open;
            fs.promises.open = async function(...args) {
              const file = await open.apply(this, args);
              const sync = file.sync.bind(file);
              file.sync = async function() { if (selectedFile(file.fd)) observe('sync'); return sync(); };
              return file;
            };
            ${captureWorkerProbe.script ?? ''}
            require('node:module').syncBuiltinESMExports();
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: captureWorkerProbe.gate
              ? { ...options?.workerData, __captureOracleGate: captureWorkerProbe.gate }
              : options?.workerData,
          });
        } else super(filename, options);
        if (capture) captureWorkerProbe.workers.push(this);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (event === 'message' && captureWorkerProbe.onNativeMessage?.(this, message)) return true;
        if (event === 'message' && message !== null && typeof message === 'object') {
          if ('__captureOracle' in message) {
            if ('kind' in message && (message.kind === 'hash' || message.kind === 'sync'))
              captureWorkerProbe.events.push(
                message as { kind: 'hash' | 'sync'; phase: string; threadId: number }
              );
            captureWorkerProbe.observe?.(
              message as { kind: string; workspaceId?: string; captureId?: string }
            );
            return true;
          }
          if (
            'phase' in message &&
            typeof message.phase === 'string' &&
            captureWorkerProbe.onPhase?.(this, message as { phase: string })
          )
            return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

/** Holds the actual private worker at its acknowledged owner phase, then resumes the real operation. */
function holdCapturePhase(phase: string, boundary: () => Promise<void>) {
  let held: { worker: Worker; message: { phase: string } } | undefined;
  const resume = () => {
    if (!held) return;
    const current = held;
    held = undefined;
    captureWorkerProbe.onPhase = undefined;
    current.worker.emit('message', current.message);
  };
  captureWorkerProbe.onPhase = (worker, message) => {
    if (message.phase !== phase || held) return false;
    held = { worker, message };
    void boundary().then(resume);
    return true;
  };
  return {
    mockRestore: () => {
      resume();
      captureWorkerProbe.onPhase = undefined;
    },
  };
}

/** Injects only at the existing capture row owner's real statement and covering COMMIT boundaries. */
function captureRecordBoundary(
  captureId: string,
  decision: 'pin' | 'finish',
  fault: 'observe' | 'before-commit' | 'lost-ack',
  observed: (message: { kind: string; workspaceId?: string; captureId?: string }) => void
) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  captureWorkerProbe.gate = gate.buffer;
  captureWorkerProbe.observe = (message) => {
    try {
      observed(message);
    } finally {
      Atomics.add(gate, 0, 1);
      Atomics.notify(gate, 0);
    }
  };
  captureWorkerProbe.script = `
    function captureObserved(kind, fields) {
      const version = Atomics.load(oracleGate, 0);
      observe(kind, fields);
      Atomics.wait(oracleGate, 0, version);
    }
    const selectedCapture = ${JSON.stringify(captureId)};
    const decision = ${JSON.stringify(decision)};
    const fault = ${JSON.stringify(fault)};
    let pendingCapture;
    let pendingDatabase;
    let installedCommitProbe = false;
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function(sql, ...args) {
      const statement = prepare.call(this, sql, ...args);
      if (!installedCommitProbe) {
        installedCommitProbe = true;
        // better-sqlite3 prepares transaction-control statements through its native handle.
        // The public Statement.run boundary still observes their real committed decision.
        const prototype = Object.getPrototypeOf(statement);
        const execute = prototype.run;
        prototype.run = function(...values) {
          const result = execute.apply(this, values);
          if (/^COMMIT$/i.test(this.source.trim()) && this.database === pendingDatabase && pendingCapture) {
            const facts = pendingCapture;
            pendingCapture = undefined;
            pendingDatabase = undefined;
            captureObserved(decision, facts);
            if (fault === 'lost-ack') throw new Error('Injected lost acknowledgement after capture decision COMMIT.');
          }
          return result;
        };
      }
      const insertion = /INSERT INTO workspace_capture_records/i.test(sql);
      const completion = /UPDATE workspace_capture_records SET state/i.test(sql);
      if (!insertion && !completion) return statement;
      const run = statement.run.bind(statement);
      statement.run = function(...values) {
        const selected = insertion ? values[0] === selectedCapture : completion && values[0] === 'finished' && values[2] === selectedCapture;
        if (selected && ((decision === 'pin' && insertion) || (decision === 'finish' && completion))) {
          const facts = { captureId: selectedCapture, workspaceId: insertion ? values[1] : values[3] };
          if (fault === 'before-commit') { captureObserved(decision, facts); throw new Error('Injected capture decision before commit.'); }
          const result = run(...values);
          pendingCapture = facts;
          pendingDatabase = statement.database;
          return result;
        }
        return run(...values);
      };
      return statement;
    };
  `;
  return {
    mockRestore: () => {
      Atomics.add(gate, 0, 1);
      Atomics.notify(gate, 0);
      captureWorkerProbe.gate = undefined;
      captureWorkerProbe.script = undefined;
      captureWorkerProbe.observe = undefined;
    },
  };
}

const roots: string[] = [];
const databaseHandles: { readonly sqlite: Database.Database }[] = [];
const workspaceId = DEMO_WORKSPACE_ID;
const release = { version: '0.1.0-c-a-oracle', buildId: 'independent-snapshot-oracle' };
const formats = {
  'drizzle.workspace': 17,
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

/** Advances the real private producer's clock without constructing or rewriting a successful seal. */
function captureDay(day: number): Date {
  const iso = `2099-01-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  captureWorkerProbe.script = `
    const OriginalDate = Date;
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [${JSON.stringify(iso)}])); }
      static now() { return ${Date.parse(iso)}; }
    };
  `;
  return new Date(iso);
}

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
  captureWorkerProbe.gate = undefined;
  captureWorkerProbe.script = undefined;
  captureWorkerProbe.observe = undefined;
  captureWorkerProbe.payloadHex = undefined;
  captureWorkerProbe.onPhase = undefined;
  captureWorkerProbe.onNativeMessage = undefined;
  captureWorkerProbe.events.length = 0;
  captureWorkerProbe.workers.length = 0;
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

  it('keeps equal active blockers without decoding unrelated sealed Turn history', async () => {
    const f = await fixture();
    const dependency = await f.store.createTurn(
      workspaceId,
      DEMO_THREAD_ID,
      'Unresolved attempt dependency',
      {
        kind: 'user',
        id: f.ownerId,
      }
    );
    const entry = createSchedulerAdmissionEntry(f.coreDb, {
      queueEntryId: randomUUID(),
      backendId: 'nanohost',
      workspaceId,
      threadId: dependency.threadId,
      turnId: dependency.id,
      turnInput: 'Retained dependency',
      requestedAgentId: 'agent_fixture',
      triggerActor: { kind: 'user', id: f.ownerId },
    });
    await f.store.completeTurn(dependency.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const attempt = createSchedulerExecutionAttempt(f.coreDb, {
      entry,
      attemptId: allocateEntityId('attempt'),
      preparationInput: { admission: entry },
      now: () => new Date().toISOString(),
    });
    const activeThread = await f.store.createThread(workspaceId, 'Constant active history control');
    const active = await f.store.createTurn(workspaceId, activeThread.id, 'Constant active work', {
      kind: 'user',
      id: f.ownerId,
    });
    const before = readBlockers({ ...f, workspaceId });
    expect(before).toHaveLength(2);
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn',
          reference: { threadId: active.threadId, turnId: active.id },
        }),
        expect.objectContaining({
          kind: 'worker-attempt',
          reference: expect.objectContaining({ attemptId: attempt.attemptId }),
        }),
      ])
    );
    const unrelated = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      const turn = await f.store.createTurn(
        workspaceId,
        DEMO_THREAD_ID,
        `Sealed history ${index}`,
        {
          kind: 'user',
          id: f.ownerId,
        }
      );
      await f.store.completeTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      unrelated.add(turn.id);
    }
    // Each read offers a fresh command identity; blocker facts and all other action inputs stay equal.
    const stableBlockers = (value: ReturnType<typeof readBlockers>) =>
      JSON.stringify(value, (key, entry) => (key === 'requestId' ? '<fresh-command-id>' : entry));
    const decodedUnrelated: string[] = [];
    const parse = JSON.parse;
    const decoding = vi
      .spyOn(JSON, 'parse')
      .mockImplementation((...args: Parameters<typeof JSON.parse>) => {
        for (const id of unrelated) if (args[0].includes(id)) decodedUnrelated.push(id);
        return Reflect.apply(parse, JSON, args);
      });
    try {
      expect(stableBlockers(readBlockers({ ...f, workspaceId }))).toBe(stableBlockers(before));
      // R1 admits active/unresolved candidates and addressed dependencies, not every retained Turn body.
      expect(decodedUnrelated).toEqual([]);
    } finally {
      decoding.mockRestore();
    }
  });

  it.each([
    'turn',
    'agent-session',
    'capability-call',
    'recurring-occurrence',
    'recovery-admission',
  ] as const)('fails closed on an unsupported %s scalar state before accepting a capture pin', async (family) => {
    const f = await fixture();
    let source = f.source;
    const unsupported = 'unsupported-fixture-state';
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    databaseHandles.push(db);
    if (family === 'turn' || family === 'capability-call') {
      const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Retained header owner', {
        kind: 'user',
        id: f.ownerId,
      });
      if (family === 'capability-call') {
        const callId = allocateEntityId('cap');
        await startCapabilityCall({
          workspaceDb: db,
          workspaceId,
          threadId: turn.threadId,
          turnId: turn.id,
          callId,
          authorityActor: { kind: 'user', id: f.ownerId },
          family: 'llm',
          operation: 'responses.create',
          capabilityId: 'llm.responses',
          requestId: randomUUID(),
          redactionClass: 'metadata-only',
        });
        db.sqlite
          .prepare('UPDATE capability_calls SET status=? WHERE call_id=?')
          .run(unsupported, callId);
      }
      await f.store.completeTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      if (family === 'turn') {
        db.sqlite.pragma('ignore_check_constraints = ON');
        try {
          db.sqlite
            .prepare('UPDATE control_turns SET status=? WHERE id=?')
            .run(unsupported, turn.id);
        } finally {
          db.sqlite.pragma('ignore_check_constraints = OFF');
        }
      }
    } else if (family === 'agent-session') {
      const session = await f.store.createAgentSession({
        id: allocateEntityId('as'),
        workspaceId,
        threadId: DEMO_THREAD_ID,
        agentId: 'agent_codex_host',
        status: 'closed',
        message: 'Closed retained owner.',
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
      });
      db.sqlite.pragma('ignore_check_constraints = ON');
      try {
        db.sqlite
          .prepare('UPDATE control_agent_sessions SET status=? WHERE id=?')
          .run(unsupported, session.id);
      } finally {
        db.sqlite.pragma('ignore_check_constraints = OFF');
      }
    } else if (family === 'recurring-occurrence') {
      const now = '2026-10-27T01:00:00.000Z';
      const schedules = new AutomationStore(f.coreDb, f.mutationAdmission, () => now);
      const schedule = schedules.createAutomation(f.ownerId, {
        workspaceId,
        threadId: DEMO_THREAD_ID,
        name: 'Owned occurrence header',
        intervalSeconds: 60,
        prompt: 'Queued only.',
      });
      schedules.updateAutomation(f.ownerId, schedule.id, {
        expectedRevision: schedule.revision,
        status: 'active',
        scheduledAt: now,
      });
      const occurrences = schedules.collectScanCandidates(now);
      expect(occurrences).toHaveLength(1);
      f.coreDb.sqlite.pragma('ignore_check_constraints = ON');
      try {
        f.coreDb.sqlite
          .prepare('UPDATE recurring_occurrences SET state=? WHERE id=?')
          .run(unsupported, occurrences[0]!.id);
      } finally {
        f.coreDb.sqlite.pragma('ignore_check_constraints = OFF');
      }
    } else {
      await shutdownControlStoreWorkerClient();
      const move = await createWorkspaceBackup({
        ...f.input(),
        source: { kind: 'stopped-data-root', dataRoot: f.dataRoot },
        bundleRoot: join(f.root, 'stopped-move'),
        purpose: 'move',
      });
      expect(move.disposition).toBe('prepared');
      endRecoveryAdmission(f.coreDb, move.manifest.backupId, 'abandoned');
      abandonCapture(db, workspaceId, move.manifest.backupId);
      // A fresh Store reads the stopped capture's retained Core scalar authority.
      source = {
        ...f.source,
        store: new FsStore({ dataRoot: f.dataRoot }),
        mutationAdmission: new WorkspaceMutationAdmission(),
      };
      expect(readBlockers({ ...source, workspaceId })).toEqual([]);
      f.coreDb.sqlite.pragma('ignore_check_constraints = ON');
      try {
        f.coreDb.sqlite
          .prepare('UPDATE workspace_recovery_admissions SET state=? WHERE admission_id=?')
          .run(unsupported, move.manifest.backupId);
      } finally {
        f.coreDb.sqlite.pragma('ignore_check_constraints = OFF');
      }
    }
    expect(readBlockers({ ...source, workspaceId })).toEqual(expect.arrayContaining([unavailable]));
    await refusal(
      { ...f, store: source.store, mutationAdmission: source.mutationAdmission },
      { ...f.input(), source }
    );
  }, 120_000);

  it('rejects malformed closed Turn history during private-cut validation before sealing', async () => {
    const f = await fixture();
    const previous = await createWorkspaceBackup(f.input());
    const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Closed retained body', {
      kind: 'user',
      id: f.ownerId,
    });
    await f.store.completeTurn(turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    databaseHandles.push(db);
    db.sqlite.pragma('ignore_check_constraints = ON');
    try {
      db.sqlite
        .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
        .run('{invalid retained body', turn.id);
    } finally {
      db.sqlite.pragma('ignore_check_constraints = OFF');
    }
    // Terminal headers are inert for the fast census; complete private-cut validation still owns integrity.
    expect(readBlockers({ ...f, workspaceId })).toEqual([]);
    const input = f.input();
    await expect(createWorkspaceBackup(input)).rejects.toThrow();
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    await f.read(previous.manifest.backupId, async (bundle) =>
      expect(bundle.manifestDigest).toBe(previous.report.manifestDigest)
    );
  }, 120_000);

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
        authorization: workspaceMembershipDecisionFixture(f.coreDb, f.ownerId, workspaceId),
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
    const copy = holdCapturePhase('db-backup', async () => {
      enter();
      await barrier;
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
      const beforeSessionRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
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
      expect(databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root)).toEqual(
        beforeSessionRows
      );
      const afterSessionWrite = tree(f.workspaceRoot);
      // SQLite readers may update SHM lock metadata; canonical rows and every other byte stay exact.
      delete beforeSessionWrite['/db/workspace.sqlite-shm'];
      delete afterSessionWrite['/db/workspace.sqlite-shm'];
      expect(afterSessionWrite).toEqual(beforeSessionWrite);
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
    const database = `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`;
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
    // Step A keeps small bodies inline; this owner-authored body selects the immutable-file family.
    await f.store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'x'.repeat(65_537),
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
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
    let intercepted = false;
    const gate = new Int32Array(new SharedArrayBuffer(4));
    captureWorkerProbe.gate = gate.buffer;
    captureWorkerProbe.observe = (message) => {
      if (message.kind !== 'immutable-copy') return;
      intercepted = true;
      expect(readFileSync(sourcePath)).toEqual(original);
      enter();
    };
    captureWorkerProbe.script = `
      const copyOpen = fs.promises.open;
      let copiedOriginal = false;
      fs.promises.open = async function(...args) {
        const file = await copyOpen.apply(this, args);
        if (!copiedOriginal && fs.realpathSync('/proc/self/fd/' + file.fd) === ${JSON.stringify(sourcePath)}) {
          copiedOriginal = true;
          observe('immutable-copy');
          Atomics.wait(oracleGate, 0, 0);
        }
        return file;
      };
    `;
    void barrier.then(() => {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
    });
    const copy = {
      mockRestore: () => {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        captureWorkerProbe.gate = undefined;
        captureWorkerProbe.script = undefined;
        captureWorkerProbe.observe = undefined;
      },
    };
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
    const copy = holdCapturePhase('db-backup', async () => {
      enter();
      await barrier;
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

describe('C-b daily snapshot policy and retention', () => {
  it('activates idle capture through the actual entrypoint maintenance callback', async () => {
    const f = await fixture();
    mkdirSync(join(f.workspaceRoot, 'files'), { recursive: true });
    writeFileSync(join(f.workspaceRoot, 'files/activation-proof.txt'), 'real idle capture');
    const turn = await f.store.createTurn(workspaceId, DEMO_THREAD_ID, 'Still running', {
      kind: 'user',
      id: f.ownerId,
    });
    const source = createSourceFile(
      'index.ts',
      readFileSync(new URL('../index.ts', import.meta.url), 'utf8'),
      ScriptTarget.Latest,
      true
    );
    let argument: Node | undefined;
    const visit = (node: Node): void => {
      if (
        isCallExpression(node) &&
        node.expression.getText(source) === 'startSchedulerAttemptMaintenanceService'
      )
        argument = node.arguments[0];
      forEachChild(node, visit);
    };
    visit(source);
    if (!argument) throw new Error('Entrypoint attempt maintenance is missing.');
    const releaseIdentity = {
      releaseTag: release.version,
      sourceCommit: release.buildId as string | undefined,
    };
    // Evaluate the shipped composition without booting unrelated process and network owners.
    const bindings = {
      runRecoveryMaintenance: {
        scheduler: vi.fn(async () => undefined),
        native: vi.fn(async () => undefined),
        checkpoints: vi.fn(async () => undefined),
      },
      requireBootValue: <T>(value: T) => value,
      SCHEDULER_ATTEMPT_MAINTENANCE_INTERVAL_MS: 30_000,
      releaseIdentity,
      dataRoot: f.dataRoot,
      activeCoreDb: f.coreDb,
      store: f.store,
      workspaceMutationAdmission: f.mutationAdmission,
      fileAdmission: f.policy.admission,
      WORKSPACE_BACKUP_POLICY,
      join,
      ensureCanonicalDirectory,
      readDataRootLayoutMarker,
      runWorkspaceSnapshotMaintenance,
    };
    const javascript = transpileModule(`const input = ${argument.getText(source)};`, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText;
    const input = new Function(...Object.keys(bindings), `${javascript}\nreturn input;`)(
      ...Object.values(bindings)
    ) as SchedulerAttemptMaintenanceInput;
    let tick = () => {};
    const pool = join(f.dataRoot, 'server/backups/workspaces', workspaceId);
    const sealed = () =>
      existsSync(pool)
        ? readdirSync(pool).filter((name) => existsSync(join(pool, name, 'seal.json')))
        : [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(captureDay(1));
    const service = startSchedulerAttemptMaintenanceService({
      ...input,
      setInterval: (callback) => {
        tick = callback;
        return 'existing-maintenance-timer';
      },
      clearInterval: vi.fn(),
    });
    try {
      await service.runOnce();
      expect(sealed()).toEqual([]);
      expect(f.store.getTurnById(turn.id)).toEqual(turn);
      await f.store.completeTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      releaseIdentity.sourceCommit = undefined;
      tick();
      await service.runOnce();
      expect(sealed()).toEqual([]);
      releaseIdentity.sourceCommit = release.buildId;
      tick();
      await service.runOnce();
      // Online Snapshot Policy: the existing tick captures an eligible idle Workspace once per UTC day.
      expect(sealed()).toHaveLength(1);
      await f.read(sealed()[0]!, async (bundle) => {
        expect(bundle.manifest.capture.completedAt).toBe('2099-01-01T12:00:00.000Z');
        expect(await bytes(bundle, 'files/activation-proof.txt')).toEqual(
          Buffer.from('real idle capture')
        );
      });
      tick();
      await service.runOnce();
      expect(sealed()).toHaveLength(1);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  });

  it('selects one healthy Workspace per pass and uses sealed UTC success instead of filesystem time', async () => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Independent daily backup target');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    const policy = {
      ...f.policy,
      source: f.source,
      expectedSourceDeploymentId: f.input().expectedSourceDeploymentId,
    };
    const first = await runWorkspaceSnapshotMaintenance({ ...policy, now: captureDay(1) });
    expect(first?.disposition).toBe('sealed');
    if (!first) throw new Error('No initial daily snapshot was produced.');
    const sealed = () =>
      [workspaceId, sibling.id].flatMap((id) => {
        const pool = join(f.dataRoot, 'server/backups/workspaces', id);
        return existsSync(pool)
          ? readdirSync(pool).filter((name) => existsSync(join(pool, name, 'seal.json')))
          : [];
      });
    expect(sealed()).toHaveLength(1);
    const selected = first.manifest.workspaceId;
    const blocked = selected === workspaceId ? sibling.id : workspaceId;
    const releaseBlocked = f.mutationAdmission.enter(blocked);
    if (!releaseBlocked) throw new Error('The other Workspace was not initially admitted.');
    const blockedRoot = join(f.dataRoot, 'workspaces', blocked);
    const beforeBlocked = tree(blockedRoot);
    try {
      const db = openWorkspaceDb(f.dataRoot, selected);
      try {
        expect(inspectCapture(db, selected, first.manifest.backupId)).toMatchObject({
          origin: 'automatic',
          state: 'finished',
        });
      } finally {
        db.sqlite.close();
      }
      await withVerifiedWorkspaceSnapshotSource(
        {
          ...f.policy,
          dataRoot: f.dataRoot,
          source: {
            kind: 'local-snapshot',
            workspaceId: selected,
            backupId: first.manifest.backupId,
          },
        },
        async (bundle) =>
          expect(bundle.manifest.capture.completedAt).toBe('2099-01-01T12:00:00.000Z')
      );
      utimesSync(join(first.bundleRoot, 'seal.json'), new Date(0), new Date(0));
      expect(
        await runWorkspaceSnapshotMaintenance({ ...policy, now: new Date('2099-01-01T23:59:59Z') })
      ).toBeUndefined();
      expect(sealed()).toHaveLength(1);
      const next = await runWorkspaceSnapshotMaintenance({ ...policy, now: captureDay(2) });
      expect(next?.manifest.workspaceId).toBe(selected);
      expect(next?.manifest.capture.completedAt).toBe('2099-01-02T12:00:00.000Z');
      expect(sealed()).toHaveLength(2);
      expect(tree(blockedRoot)).toEqual(beforeBlocked);
    } finally {
      releaseBlocked();
    }
  });

  it('retains seven automatic daily generations plus manual bytes and collects only unreachable objects', async () => {
    const f = await fixture();
    const files = join(f.workspaceRoot, 'files');
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'retention-shared.bin'), 'shared original');
    writeFileSync(join(files, 'retention-changed.bin'), 'manual original');
    const manual = await createWorkspaceBackup(f.input());
    const generations: Awaited<ReturnType<typeof createWorkspaceBackup>>[] = [];
    for (let day = 1; day <= 7; day += 1) {
      captureDay(day);
      writeFileSync(join(files, 'retention-changed.bin'), `day ${day}`);
      generations.push(await createWorkspaceBackup({ ...f.input(), origin: 'automatic' }));
    }
    writeFileSync(join(files, 'retention-changed.bin'), 'day 8');
    const oldestId = generations[0]!.manifest.backupId;
    const oldObject = generations[0]!.manifest.inventory.find(
      (entry) => entry.path === 'files/retention-changed.bin'
    )!;
    const eighth = await runWorkspaceSnapshotMaintenance({
      ...f.policy,
      source: f.source,
      expectedSourceDeploymentId: f.input().expectedSourceDeploymentId,
      now: captureDay(8),
    });
    expect(eighth?.disposition).toBe('sealed');
    if (!eighth) throw new Error('The eighth daily snapshot was not produced.');
    expect(
      existsSync(
        join(
          f.dataRoot,
          'server/backups/workspaces',
          workspaceId,
          'objects',
          oldObject.sha256.slice(7)
        )
      )
    ).toBe(false);
    await expect(f.read(oldestId, async () => undefined)).rejects.toThrow();
    await shutdownControlStoreWorkerClient();
    rmSync(f.workspaceRoot, { recursive: true, force: true });
    const retained = [manual, ...generations.slice(1), eighth];
    expect(retained.slice(1)).toHaveLength(7);
    for (const [index, generation] of retained.entries()) {
      await f.read(generation.manifest.backupId, async (bundle) => {
        expect(await bytes(bundle, 'files/retention-shared.bin')).toEqual(
          Buffer.from('shared original')
        );
        expect(await bytes(bundle, 'files/retention-changed.bin')).toEqual(
          Buffer.from(index === 0 ? 'manual original' : `day ${index + 1}`)
        );
        for (const entry of bundle.manifest.inventory)
          expect(digest(await bytes(bundle, entry.path))).toBe(entry.sha256);
      });
    }
  });

  it('refuses corrupt sealed inventory before retiring exposure or collecting referenced objects', async () => {
    const f = await fixture();
    const generations: Awaited<ReturnType<typeof createWorkspaceBackup>>[] = [];
    for (let day = 1; day <= 8; day += 1) {
      captureDay(day);
      generations.push(await createWorkspaceBackup({ ...f.input(), origin: 'automatic' }));
    }
    const corrupted = generations.at(-1)!;
    const manifestPath = join(corrupted.bundleRoot, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.inventory[0].sha256 = `sha256:${'f'.repeat(64)}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const pool = join(f.dataRoot, 'server/backups/workspaces', workspaceId);
    const before = tree(pool);
    await expect(
      runWorkspaceSnapshotMaintenance({
        ...f.policy,
        source: f.source,
        expectedSourceDeploymentId: f.input().expectedSourceDeploymentId,
        now: captureDay(9),
      })
    ).rejects.toThrow();
    expect(tree(pool)).toEqual(before);
    for (const generation of generations.slice(0, -1))
      await f.read(generation.manifest.backupId, async (bundle) => {
        expect(bundle.manifestDigest).toBe(generation.report.manifestDigest);
        for (const entry of bundle.manifest.inventory)
          expect(digest(await bytes(bundle, entry.path))).toBe(entry.sha256);
      });
  });
});

describe('C-b original-byte acquisition protection', () => {
  it('excludes retention during acquisition and releases before independent verified consumption', async () => {
    const f = await fixture();
    const captured = await createWorkspaceBackup(f.input());
    const refusal = new OperationError('workspace_frozen', 'Workspace capture is frozen.', 409, {
      details: {
        workspaceId,
        operation: 'capture',
        retryable: true,
        blockers: [{ kind: 'snapshot', reason: 'frozen', actions: [] }],
      },
    });
    let duringAcquisition: string | undefined;
    const reserve = vi.fn((...args: Parameters<typeof f.policy.admission.reserve>) => {
      if (duringAcquisition === undefined) {
        const attempt = f.mutationAdmission.tryFreeze(workspaceId, () => []);
        duringAcquisition = attempt.status;
        if (attempt.status === 'frozen') attempt.release();
      }
      return f.policy.admission.reserve(...args);
    });
    const input = {
      ...f.policy,
      dataRoot: f.dataRoot,
      source: {
        kind: 'local-snapshot' as const,
        workspaceId,
        backupId: captured.manifest.backupId,
      },
      admission: { reserve },
      acquireSource: () => {
        const release = f.mutationAdmission.enter(workspaceId);
        if (!release) throw refusal;
        return release;
      },
    };
    await withVerifiedWorkspaceSnapshotSource(input, async (bundle) => {
      // Online Snapshot Policy makes an independent verified stream inert after acquisition.
      const attempt = f.mutationAdmission.tryFreeze(workspaceId, () => []);
      expect(attempt.status).toBe('frozen');
      if (attempt.status !== 'frozen') throw new Error('Acquisition admission was not released.');
      try {
        expect(bundle.manifestDigest).toBe(captured.report.manifestDigest);
        for (const entry of bundle.manifest.inventory)
          expect(digest(await bytes(bundle, entry.path))).toBe(entry.sha256);
      } finally {
        attempt.release();
      }
    });
    // The real gate must exclude retention while original bytes still require the local pool.
    expect(duringAcquisition).toBe('busy');

    const frozen = f.mutationAdmission.tryFreeze(workspaceId, () => []);
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('Control freeze was not admitted.');
    const sourceOpen = vi.spyOn(await import('node:fs/promises'), 'open');
    const consume = vi.fn(async () => undefined);
    const beforePool = tree(join(f.dataRoot, 'server/backups/workspaces', workspaceId));
    const beforeStaging = tree(f.policy.stagingParent);
    reserve.mockClear();
    try {
      await expect(withVerifiedWorkspaceSnapshotSource(input, consume)).rejects.toBe(refusal);
      expect(consume).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(sourceOpen).not.toHaveBeenCalled();
      expect(tree(join(f.dataRoot, 'server/backups/workspaces', workspaceId))).toEqual(beforePool);
      expect(tree(f.policy.stagingParent)).toEqual(beforeStaging);
      const staged = await stageWorkspaceBackup({
        ...f.input(captured.manifest.backupId),
        snapshotSource: input,
        candidateRoot: join(f.root, 'frozen-verification-candidate'),
        expectedWorkspaceId: workspaceId,
      }).catch((error: unknown) => error);
      expect.soft(staged).toBe(refusal);
      const workersBeforeReplay = captureWorkerProbe.workers.length;
      const replay = await createWorkspaceBackup(f.input(captured.manifest.backupId)).catch(
        (error: unknown) => error
      );
      expect.soft(projectOperationError(replay)).toMatchObject({ code: 'workspace_frozen' });
      expect.soft(captureWorkerProbe.workers).toHaveLength(workersBeforeReplay);
    } finally {
      sourceOpen.mockRestore();
      frozen.release();
    }

    duringAcquisition = undefined;
    const replay = await createWorkspaceBackup({
      ...f.input(captured.manifest.backupId),
      admission: { reserve },
    });
    expect(replay.report.manifestDigest).toBe(captured.report.manifestDigest);
    expect.soft(duringAcquisition).toBe('busy');

    // A valid owner-created generation is damaged only to prove failure releases admission.
    writeFileSync(join(captured.bundleRoot, 'manifest.json'), '{');
    await expect(withVerifiedWorkspaceSnapshotSource(input, consume)).rejects.toThrow();
    const afterFailure = f.mutationAdmission.tryFreeze(workspaceId, () => []);
    expect(afterFailure.status).toBe('frozen');
    if (afterFailure.status === 'frozen') afterFailure.release();
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
    let calls = 0;
    const pin = captureRecordBoundary(input.backupId, 'pin', 'lost-ack', (message) => {
      expect(message.captureId).toBe(input.backupId);
      expect(message.workspaceId).toBe(workspaceId);
      calls += 1;
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      const db = openWorkspaceDb(f.dataRoot, workspaceId);
      try {
        expect(inspectCapture(db, workspaceId, input.backupId)?.state).toBe('active');
      } finally {
        db.sqlite.close();
      }
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
    const db = openWorkspaceReadDb(f.dataRoot, workspaceId);
    databaseHandles.push(db);
    expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({
      captureId: input.backupId,
      workspaceId,
      state: 'active',
      endedAt: null,
    });
    // Ordinary reads preserve quarantine; only the exact selected census omits its own pin.
    expect(readBlockers({ ...f, workspaceId })).toEqual([unavailable]);
    expect(
      readWorkspaceRecoveryBlockers({ ...f, workspaceId }, { captureId: input.backupId })
    ).toEqual([]);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
  });

  it('drains a real inline terminal ACK into the target cut while refusing new target publication and preserving sibling ACKs', async () => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Inline composition sibling');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    await f.store.createThread(sibling.id, 'Initialize sibling native writer');
    const turn = await f.store.createTurn(
      workspaceId,
      DEMO_THREAD_ID,
      'Retain exact inline bytes.',
      {
        kind: 'user',
        id: f.ownerId,
      }
    );
    const item: Parameters<FsStore['createItem']>[0] = {
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Exact inline bytes: café, 雪.\nSecond line.\n',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const client = getControlStoreWorkerClient();
    const targetDatabase = `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`;
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    let terminal: ControlTerminalTransition | undefined;
    let forwardAck: (() => void) | undefined;
    let forwarded = false;
    let arrived!: () => void;
    const ackArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    captureWorkerProbe.onNativeMessage = (worker, value) => {
      if (!value || typeof value !== 'object' || !('id' in value)) return false;
      const request = post.mock.calls.find(
        ([message]) =>
          message &&
          message.operation === 'terminal' &&
          message.database === targetDatabase &&
          message.input.turn.record.id === turn.id
      )?.[0];
      if (!request || value.id !== request.id || forwardAck) return false;
      terminal = request.input;
      forwardAck = () => {
        if (forwarded) return;
        forwarded = true;
        captureWorkerProbe.onNativeMessage = undefined;
        worker.emit('message', value);
      };
      arrived();
      return true;
    };
    let acknowledged = false;
    const publication = f.store
      .completeTurn(
        turn.id,
        { status: 'completed', completedAt: item.completedAt },
        { items: [item] }
      )
      .then((completed) => {
        acknowledged = true;
        return completed;
      });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const cutEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cutReached = false;
    const cut = holdCapturePhase('db-backup', async () => {
      expect(acknowledged).toBe(true);
      cutReached = true;
      entered();
      await barrier;
    });
    const phase = captureWorkerProbe.onPhase!;
    let draining!: () => void;
    const drainEntered = new Promise<void>((resolve) => {
      draining = resolve;
    });
    captureWorkerProbe.onPhase = (worker, message) => {
      if (message.phase === 'drain') draining();
      return phase(worker, message);
    };
    let capturing: ReturnType<typeof createWorkspaceBackup> | undefined;
    try {
      await Promise.race([
        ackArrived,
        publication.then(() => {
          throw new Error('Terminal publication did not expose its real native ACK.');
        }),
      ]);
      expect(acknowledged).toBe(false);
      expect(readBlockers({ ...f, workspaceId })).toEqual([]);
      expect(terminal!.entries.map((entry) => entry.kind)).toEqual(['item', 'event']);
      const expectedBodies = terminal!.entries.map((entry) => {
        expect(entry.content.reference.representation).toBe('inline');
        if (entry.content.reference.representation !== 'inline')
          throw new Error('The real terminal producer did not select inline retention.');
        const body = Buffer.from(entry.content.reference.body, 'utf8');
        expect(body.length).toBeLessThanOrEqual(65_536);
        expect(body.length).toBe(entry.content.byteLength);
        expect(digest(body)).toBe(entry.content.reference.contentDigest);
        return Buffer.from(body);
      });
      expect(JSON.parse(expectedBodies[0]!.toString())).toMatchObject({
        id: item.id,
        turnId: turn.id,
        threadId: turn.threadId,
        text: item.text,
      });
      const input = f.input();
      capturing = createWorkspaceBackup(input);
      await Promise.race([
        drainEntered,
        capturing.then(() => {
          throw new Error('Capture did not drain the already-posted terminal ACK.');
        }),
      ]);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      expect(acknowledged).toBe(false);
      expect(cutReached).toBe(false);
      expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
      await expect(client.terminal(targetDatabase, terminal!)).rejects.toMatchObject({
        code: 'workspace_frozen',
      });
      const siblingThread = await f.store.createThread(
        sibling.id,
        'Sibling ACK during inline drain'
      );
      expect(f.store.getThread(sibling.id, siblingThread.id).name).toBe(
        'Sibling ACK during inline drain'
      );
      expect(acknowledged).toBe(false);
      expect(cutReached).toBe(false);
      forwardAck!();
      const completed = await publication;
      await Promise.race([
        cutEntered,
        capturing.then(() => {
          throw new Error('Capture did not reach its target cut after the real terminal ACK.');
        }),
      ]);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      const terminalPosts = () =>
        post.mock.calls.filter(
          ([message]) => message?.operation === 'terminal' && message.database === targetDatabase
        );
      expect(terminalPosts()).toHaveLength(1);
      resume();
      const captured = await capturing;
      expect(captured.disposition).toBe('sealed');
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
      await f.store.createThread(workspaceId, 'Only in the later live source');
      expect(terminalPosts()).toHaveLength(1);
      await shutdownControlStoreWorkerClient();
      f.coreDb.sqlite.close();
      rmSync(f.workspaceRoot, { recursive: true });
      await f.read(captured.manifest.backupId, async (bundle) => {
        const scope = nativeProductScope(join(f.root, 'verified-inline-replay'), turn.owner);
        mkdirSync(dirname(scope.path), { recursive: true });
        writeFileSync(scope.path, await bytes(bundle, 'db/workspace.sqlite'));
        expect(readNativeTurnHistory(scope, turn.id)?.turn).toEqual(completed);
        const reader = openControlStoreProductReadHandle(scope.path, turn.owner);
        try {
          for (const [index, entry] of terminal!.entries.entries()) {
            const retained = reader
              .entries(turn.id, entry.kind)
              .find((row) => row.sequence === entry.sequence);
            expect(retained).toBeDefined();
            expect(retained!.content).toEqual(entry.content);
            const reference = retained!.content.reference;
            expect(reference.representation).toBe('inline');
            if (reference.representation !== 'inline') throw new Error('Lost inline retention.');
            const actual = Buffer.from(reference.body, 'utf8');
            expect(actual).toEqual(expectedBodies[index]);
            expect(actual.length).toBe(retained!.content.byteLength);
            expect(digest(actual)).toBe(reference.contentDigest);
          }
        } finally {
          reader.close();
        }
      });
    } finally {
      forwardAck?.();
      resume();
      cut.mockRestore();
      captureWorkerProbe.onNativeMessage = undefined;
      await Promise.allSettled([publication, ...(capturing ? [capturing] : [])]);
      post.mockRestore();
    }
  }, 120_000);

  it.each([
    'capture-worker-loss',
    'native-drain-rejection',
  ] as const)('retains capture ownership through %s while a real posted target ACK still drains', async (failure) => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Drain-loss sibling');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    await f.store.createThread(sibling.id, 'Initialize real sibling native ACK');
    const client = getControlStoreWorkerClient();
    const targetDatabase = `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`;
    const siblingDatabase = `workspace:${workspaceDbPath(f.dataRoot, sibling.id)}`;
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    let forwardAck: (() => void) | undefined;
    let ackForwarded = false;
    let nativeFailed = false;
    let nativeWorker: Worker | undefined;
    let arrived!: () => void;
    const ackArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    captureWorkerProbe.onNativeMessage = (worker, value) => {
      if (!value || typeof value !== 'object' || !('id' in value)) return false;
      const request = post.mock.calls.find(
        ([message]) =>
          message && message.operation === 'checkpoint' && message.database === targetDatabase
      )?.[0];
      if (!request || value.id !== request.id || forwardAck) return false;
      nativeWorker = worker;
      forwardAck = () => {
        if (ackForwarded) return;
        ackForwarded = true;
        captureWorkerProbe.onNativeMessage = undefined;
        worker.emit('message', value);
      };
      arrived();
      return true;
    };
    const pendingAck = client.checkpoint(targetDatabase).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    await ackArrived;
    const releaseOrder: string[] = [];
    const tryPause = client.tryPauseForWorkspaceCapture.bind(client);
    const hold = vi.spyOn(client, 'tryPauseForWorkspaceCapture').mockImplementation((...args) => {
      const acquired = tryPause(...args);
      return (
        acquired?.then((release) => () => {
          expect(ackForwarded || nativeFailed).toBe(true);
          releaseOrder.push('hold');
          release();
        }) ?? null
      );
    });
    const tryFreeze = f.mutationAdmission.tryFreeze.bind(f.mutationAdmission);
    const gate = vi.spyOn(f.mutationAdmission, 'tryFreeze').mockImplementation((...args) => {
      const result = tryFreeze(...args);
      if (result.status !== 'frozen') return result;
      return {
        ...result,
        release: () => {
          expect(ackForwarded || nativeFailed).toBe(true);
          releaseOrder.push('gate');
          result.release();
        },
      };
    });
    let worker: Worker | undefined;
    let entered!: () => void;
    const draining = new Promise<void>((resolve) => {
      entered = resolve;
    });
    captureWorkerProbe.onPhase = (selected, message) => {
      if (message.phase === 'drain') {
        worker = selected;
        entered();
      }
      return false;
    };
    let settled = false;
    const input = f.input();
    const capturing = createWorkspaceBackup(input).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      }
    );
    try {
      await Promise.race([
        draining,
        capturing.then((outcome) => {
          if ('error' in outcome) throw outcome.error;
          throw new Error('Capture did not reach real target ACK drain.');
        }),
      ]);
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
      if (failure === 'capture-worker-loss') {
        await worker!.terminate();
        await expect(client.checkpoint(siblingDatabase)).resolves.toBeDefined();
        expect(settled).toBe(false);
        expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
        expect(releaseOrder).toEqual([]);
        forwardAck!();
        expect(await pendingAck).toHaveProperty('result');
      } else {
        nativeWorker!.prependOnceListener('exit', () => {
          nativeFailed = true;
        });
        await nativeWorker!.terminate();
        captureWorkerProbe.onNativeMessage = undefined;
        expect(await pendingAck).toMatchObject({ error: expect.any(Error) });
        await expect(client.checkpoint(siblingDatabase)).resolves.toBeDefined();
      }
      expect(await capturing).toMatchObject({ error: expect.any(Error) });
      if (failure === 'capture-worker-loss') expect(releaseOrder).toEqual(['hold', 'gate']);
      else {
        expect(releaseOrder.at(-1)).toBe('gate');
        expect(releaseOrder.filter((value) => value === 'gate')).toHaveLength(1);
        expect(releaseOrder.filter((value) => value === 'hold').length).toBeLessThanOrEqual(1);
      }
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
      expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    } finally {
      captureWorkerProbe.onPhase = undefined;
      if (!nativeFailed) forwardAck?.();
      captureWorkerProbe.onNativeMessage = undefined;
      await pendingAck;
      await capturing;
      hold.mockRestore();
      gate.mockRestore();
      post.mockRestore();
    }
    const reacquired = client.tryPauseForWorkspaceCapture(targetDatabase);
    expect(reacquired).not.toBeNull();
    if (failure === 'capture-worker-loss') {
      await expect(reacquired).resolves.toBeTypeOf('function');
      (await reacquired!)();
      await expect(client.checkpoint(targetDatabase)).resolves.toBeDefined();
    } else {
      // The original native owner refuses a failed host before installing a new hold.
      await expect(reacquired).rejects.toMatchObject({
        code: 'unavailable',
        commit: 'not-committed',
      });
    }
    const siblingInput = f.input();
    const afterLoss = createWorkspaceBackup({
      ...siblingInput,
      workspaceId: sibling.id,
      bundleRoot: join(
        f.dataRoot,
        'server',
        'backups',
        'workspaces',
        sibling.id,
        siblingInput.backupId
      ),
    });
    await expect(
      afterLoss,
      'A healthy sibling capture must acquire the released request slot.'
    ).resolves.toMatchObject({ disposition: 'sealed' });
  }, 120_000);

  it.each([
    'cut',
    'pool',
    'finish',
    'cleanup',
  ] as const)('keeps worker loss at %s truthful without losing source, predecessor or admission ownership', async (phase) => {
    const f = await fixture();
    const previousInput = f.input();
    const previous = await createWorkspaceBackup(previousInput);
    const previousBytes = tree(previousInput.bundleRoot);
    const sibling = await f.store.createWorkspace('Capture slot sibling');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: sibling.id,
      ownerUserId: f.ownerId,
    });
    await f.store.createThread(sibling.id, 'Real native sibling admission');
    const input = f.input();
    const beforeSource = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    let retrySibling: Parameters<typeof createWorkspaceBackup>[0] | undefined;
    let capturedWorker: Worker | undefined;
    const late = phase === 'finish' || phase === 'cleanup';
    let publishedGeneration: ReturnType<typeof tree> | undefined;
    let publishedDigest: string | undefined;
    let publishedDecision: ReturnType<typeof inspectCapture> | undefined;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    captureWorkerProbe.onPhase = (worker, message) => {
      if (message.phase !== phase) return false;
      capturedWorker = worker;
      enter();
      return true;
    };
    const capturing = createWorkspaceBackup(input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      await Promise.race([
        entered,
        capturing.then(() => {
          throw new Error('Capture did not reach the selected real worker boundary.');
        }),
      ]);
      expect(capturedWorker).toBeDefined();
      expect(f.mutationAdmission.isClosed(workspaceId)).toBe(phase === 'cut');
      if (phase === 'cut') {
        const siblingInput = f.input();
        retrySibling = {
          ...siblingInput,
          workspaceId: sibling.id,
          bundleRoot: join(
            f.dataRoot,
            'server',
            'backups',
            'workspaces',
            sibling.id,
            siblingInput.backupId
          ),
        };
        const siblingCapture = createWorkspaceBackup(retrySibling).then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        );
        const ack = getControlStoreWorkerClient().checkpoint(
          `workspace:${workspaceDbPath(f.dataRoot, sibling.id)}`
        );
        expect(
          await Promise.race([
            siblingCapture,
            ack.then(() => ({ waitingForOccupiedCapture: true })),
          ])
        ).toMatchObject({ error: { code: 'capacity-exceeded' } });
        await expect(ack).resolves.toBeDefined();
        expect(f.mutationAdmission.isClosed(sibling.id)).toBe(false);
        expect(f.mutationAdmission.isClosed(workspaceId)).toBe(true);
        const siblingDb = openWorkspaceDb(f.dataRoot, sibling.id);
        try {
          expect(inspectCapture(siblingDb, sibling.id, siblingInput.backupId)).toBeNull();
        } finally {
          siblingDb.sqlite.close();
        }
        expect(
          existsSync(
            join(
              f.dataRoot,
              'server',
              'backups',
              'workspaces',
              sibling.id,
              siblingInput.backupId,
              'seal.json'
            )
          )
        ).toBe(false);
      }
      if (late) {
        const seal = JSON.parse(readFileSync(join(input.bundleRoot, 'seal.json'), 'utf8')) as {
          backupId: string;
          manifestDigest: string;
        };
        expect(seal.backupId).toBe(input.backupId);
        publishedDigest = seal.manifestDigest;
        expect(publishedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        publishedGeneration = tree(input.bundleRoot);
        const db = openWorkspaceDb(f.dataRoot, workspaceId);
        try {
          publishedDecision = inspectCapture(db, workspaceId, input.backupId);
          expect(publishedDecision).toMatchObject({
            state: phase === 'cleanup' ? 'finished' : 'active',
          });
        } finally {
          db.sqlite.close();
        }
        await expect(
          getControlStoreWorkerClient().checkpoint(
            `workspace:${workspaceDbPath(f.dataRoot, sibling.id)}`
          )
        ).resolves.toBeDefined();
        expect(f.mutationAdmission.isClosed(sibling.id)).toBe(false);
      }
      await capturedWorker!.terminate();
      expect(await capturing).toMatchObject({ error: expect.any(Error) });
    } finally {
      captureWorkerProbe.onPhase = undefined;
      if (capturedWorker && capturedWorker.threadId !== -1) await capturedWorker.terminate();
      await capturing;
    }
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(late);
    if (late) {
      expect(tree(input.bundleRoot)).toEqual(publishedGeneration);
      await f.read(input.backupId, async (bundle) =>
        expect(bundle.manifestDigest).toBe(publishedDigest)
      );
    }
    expect(tree(previousInput.bundleRoot)).toEqual(previousBytes);
    const afterSource = tree(f.workspaceRoot);
    for (const path of [
      '/db/workspace.sqlite',
      '/db/workspace.sqlite-wal',
      '/db/workspace.sqlite-shm',
    ]) {
      delete beforeSource[path];
      delete afterSource[path];
    }
    expect(afterSource).toEqual(beforeSource);
    const afterRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    afterRows.workspace_capture_records = afterRows.workspace_capture_records!.filter((row) => {
      const capture = row as { capture_id: string; workspace_id: string };
      return capture.capture_id !== input.backupId || capture.workspace_id !== workspaceId;
    });
    expect(afterRows).toEqual(beforeRows);
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      const retained = inspectCapture(db, workspaceId, input.backupId);
      expect(retained).toMatchObject({
        state: phase === 'cleanup' ? 'finished' : 'active',
      });
      if (late) expect(retained).toEqual(publishedDecision);
    } finally {
      db.sqlite.close();
    }
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const hold = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
      `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`
    );
    expect(hold).not.toBeNull();
    (await hold!)();
    await f.read(previous.manifest.backupId, async (bundle) =>
      expect(bundle.manifestDigest).toBe(previous.report.manifestDigest)
    );
    if (late) {
      const siblingInput = f.input();
      retrySibling = {
        ...siblingInput,
        workspaceId: sibling.id,
        bundleRoot: join(
          f.dataRoot,
          'server',
          'backups',
          'workspaces',
          sibling.id,
          siblingInput.backupId
        ),
      };
    }
    // Worker death releases the single slot; only this explicit later call retries the refused request.
    if (retrySibling)
      expect((await createWorkspaceBackup(retrySibling)).disposition).toBe('sealed');
  }, 120_000);

  it('takes an independent mutable cut before payload hashing and synchronization leave the freeze', async () => {
    const f = await fixture();
    const original = Buffer.from(
      'The exact authored cut payload must remain independent after release.'
    );
    const authored = join(f.workspaceRoot, 'files', captureWorkerProbe.payloadName);
    mkdirSync(dirname(authored), { recursive: true });
    writeFileSync(authored, original, { mode: 0o640 });
    captureWorkerProbe.payloadHex = original.toString('hex');
    let frozenHashes = 0;
    let frozenSyncs = 0;
    let released = false;
    const update = Object.getPrototypeOf(createHash('sha256')).update;
    const hashing = vi
      .spyOn(Object.getPrototypeOf(createHash('sha256')), 'update')
      .mockImplementation(function (this: unknown, data: unknown, ...args: unknown[]) {
        if (
          (typeof data === 'string' || Buffer.isBuffer(data)) &&
          Buffer.from(data).equals(original) &&
          f.mutationAdmission.isClosed(workspaceId)
        )
          frozenHashes += 1;
        return Reflect.apply(update, this, [data, ...args]);
      });
    namespaceSyncFault.beforeSync = (fd) => {
      if (
        f.mutationAdmission.isClosed(workspaceId) &&
        fstatSync(fd).isFile() &&
        realpathSync(`/proc/self/fd/${fd}`).endsWith(`/${captureWorkerProbe.payloadName}`)
      )
        frozenSyncs += 1;
    };
    const tryFreeze = f.mutationAdmission.tryFreeze.bind(f.mutationAdmission);
    const freeze = vi.spyOn(f.mutationAdmission, 'tryFreeze').mockImplementation((...args) => {
      const result = tryFreeze(...args);
      if (result.status !== 'frozen') return result;
      return {
        ...result,
        release: () => {
          result.release();
          released = true;
          writeFileSync(authored, 'A live source change after the cut.');
        },
      };
    });
    let captured: Awaited<ReturnType<typeof createWorkspaceBackup>>;
    try {
      captured = await createWorkspaceBackup(f.input());
    } finally {
      hashing.mockRestore();
      freeze.mockRestore();
      namespaceSyncFault.beforeSync = undefined;
    }
    expect(released).toBe(true);
    expect(frozenHashes).toBe(0);
    expect(frozenSyncs).toBe(0);
    expect(captureWorkerProbe.workers).toHaveLength(1);
    const workerHashes = captureWorkerProbe.events.filter(({ kind }) => kind === 'hash');
    expect(workerHashes.length).toBeGreaterThan(0);
    expect(workerHashes.every(({ threadId }) => threadId > 0)).toBe(true);
    const frozenPhases = new Set([
      'preflight',
      'freeze',
      'census',
      'drain',
      'core-pin',
      'enumeration',
      'mutable-copy',
      'db-backup',
      'cut',
    ]);
    expect(captureWorkerProbe.events.filter(({ phase }) => frozenPhases.has(phase))).toEqual([]);
    expect(captured.disposition).toBe('sealed');
    await f.read(captured.manifest.backupId, async (bundle) => {
      expect(await bytes(bundle, `files/${captureWorkerProbe.payloadName}`)).toEqual(original);
      expect(
        bundle.manifest.inventory.find(
          ({ path }) => path === `files/${captureWorkerProbe.payloadName}`
        )?.mode
      ).toBe(0o640);
    });
    expect(readFileSync(authored, 'utf8')).toBe('A live source change after the cut.');
  });

  it('preserves exact mutable and Light App cuts, reuses immutable objects and survives source deletion', async () => {
    const f = await fixture();
    const sourceDeploymentId = readDataRootLayoutMarker(f.dataRoot).deploymentId;
    const memberEmail = 'capture-member@example.invalid';
    const auth = createBetterAuth(f.coreDb, { env: {} });
    const { user: member } = await auth.api.signUpEmail({
      body: { email: memberEmail, name: 'Captured member', password: randomUUID() },
    });
    const { user: unrelated } = await auth.api.signUpEmail({
      body: {
        email: 'capture-unrelated@example.invalid',
        name: 'Unrelated account',
        password: randomUUID(),
      },
    });
    const invitation = f.coreDb.sqlite.transaction(() =>
      createWorkspaceInvitation({
        authorization: workspaceMembershipDecisionFixture(f.coreDb, f.ownerId, workspaceId),
        coreDb: f.coreDb,
        workspaceId,
        inviterUserId: f.ownerId,
        inviteeEmail: memberEmail,
      })
    )();
    expect(invitation.kind).toBe('created');
    if (invitation.kind !== 'created') throw new Error('Owner invitation was not created.');
    const admitted = f.coreDb.sqlite.transaction(() =>
      acceptWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId,
        invitationId: invitation.invitation.invitationId,
        inviteeUserId: member.id,
        expectedRevision: invitation.invitation.revision,
      })
    )();
    expect(admitted.kind).toBe('accepted');
    const expectedAccounts = {
      ownerId: f.ownerId,
      memberIds: [f.ownerId, member.id].sort(),
      privateAudienceRefs: [member.id],
    };
    const nativeThread = await f.store.createThread(
      workspaceId,
      'Private captured file bodies',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: member.id,
      }
    );
    const nativeTurn = await f.store.createTurn(
      workspaceId,
      nativeThread.id,
      'Keep native file bodies.',
      { kind: 'user', id: member.id }
    );
    const nativeItem = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: nativeTurn.owner,
      threadId: nativeTurn.threadId,
      turnId: nativeTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Exact multibyte native é😀\n"\\'.repeat(5_000),
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    const nativeEvent = await f.store.persistTurnEvent(nativeTurn.id, {
      event: 'item.completed',
      workspaceId,
      threadId: nativeTurn.threadId,
      turnId: nativeTurn.id,
      requestId: null,
      data: { type: 'item-completed', itemId: nativeItem.id, item: nativeItem },
    });
    const completedNative = await f.store.completeTurn(nativeTurn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const sourceScope = nativeProductScope(f.dataRoot, nativeTurn.owner);
    const sourceReader = openControlStoreProductReadHandle(sourceScope.path, nativeTurn.owner);
    let expectedNative: {
      kind: 'item' | 'event';
      value: typeof nativeItem | typeof nativeEvent;
      row: ReturnType<typeof sourceReader.entries>[number];
      body: Buffer;
      sha256: string;
    }[];
    try {
      expectedNative = [
        { kind: 'item' as const, value: nativeItem },
        { kind: 'event' as const, value: nativeEvent },
      ].map(({ kind, value }) => {
        const row = sourceReader
          .entries(nativeTurn.id, kind)
          .find((row) =>
            kind === 'item' ? row.id === nativeItem.id : row.sequence === nativeEvent.sequence
          )!;
        const body = Buffer.from(JSON.stringify(writeRetainedV1(value)));
        expect(row).toBeDefined();
        expect(body.length).toBeGreaterThan(65_536);
        const reference = row.content.reference;
        expect('representation' in reference ? reference.representation : 'file').toBe('file');
        if (!('locator' in reference)) throw new Error('Expected file-backed native body.');
        expect(readFileSync(join(sourceScope.contentMount.root, reference.locator.path))).toEqual(
          body
        );
        return { kind, value, row, body, sha256: digest(body) };
      });
    } finally {
      sourceReader.close();
    }
    const expectedKnowledgeIds = [
      readDefaultKnowledgeBaseId({
        dataRoot: f.dataRoot,
        scope: { kind: 'workspace', workspaceId },
      }),
    ];
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
    const firstWorkspaceReader = openControlStoreProductReadHandle(
      sourceScope.path,
      nativeTurn.owner
    );
    let firstWorkspaceRevision: NonNullable<
      ReturnType<typeof firstWorkspaceReader.get>
    >['revision'];
    try {
      firstWorkspaceRevision = firstWorkspaceReader.get('workspace', workspaceId)!.revision;
    } finally {
      firstWorkspaceReader.close();
    }
    const first = await createWorkspaceBackup(f.input());
    expect(first.disposition).toBe('sealed');
    expect(first.manifest.sourceDeploymentId).toBe(sourceDeploymentId);
    expect(first.report.sourceDeploymentId).toBe(sourceDeploymentId);
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
    const secondWorkspaceReader = openControlStoreProductReadHandle(
      sourceScope.path,
      nativeTurn.owner
    );
    let secondWorkspaceRevision: NonNullable<
      ReturnType<typeof secondWorkspaceReader.get>
    >['revision'];
    try {
      secondWorkspaceRevision = secondWorkspaceReader.get('workspace', workspaceId)!.revision;
    } finally {
      secondWorkspaceReader.close();
    }
    const second = await createWorkspaceBackup(f.input());
    expect(second.manifest.sourceDeploymentId).toBe(sourceDeploymentId);
    expect(second.report.sourceDeploymentId).toBe(sourceDeploymentId);
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
        expect(bundle.manifest.sourceDeploymentId).toBe(sourceDeploymentId);
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
        expect(bundle.manifest.sourceDeploymentId).toBe(sourceDeploymentId);
        expect(bundle.manifest.accounts).toEqual(expectedAccounts);
        expect(bundle.manifest.accounts.memberIds).not.toContain(unrelated.id);
        expect(bundle.manifest.accounts.privateAudienceRefs).not.toContain(unrelated.id);
        expect(bundle.manifest.knowledgeBaseIds).toEqual(expectedKnowledgeIds);
        expect(bundle.manifest.capturedRevision).toBe(
          generation === first ? firstWorkspaceRevision : secondWorkspaceRevision
        );
        expect(generation.report.knowledgeBaseIds).toEqual(expectedKnowledgeIds);
        expect(generation.report.capturedRevision).toBe(bundle.manifest.capturedRevision);
        const replayRoot = join(f.root, `verified-file-replay-${generation.manifest.backupId}`);
        for (const entry of bundle.manifest.inventory) {
          const actual = await bytes(bundle, entry.path);
          expect(actual.length).toBe(entry.bytes);
          expect(digest(actual)).toBe(entry.sha256);
          const destination = join(replayRoot, 'workspaces', workspaceId, entry.path);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, actual, { mode: entry.mode });
        }
        const replayScope = nativeProductScope(replayRoot, nativeTurn.owner);
        expect(readNativeTurnHistory(replayScope, nativeTurn.id)?.turn).toEqual(completedNative);
        const replayReader = openControlStoreProductReadHandle(replayScope.path, nativeTurn.owner);
        try {
          for (const expected of expectedNative) {
            expect(
              readNativeProductEntries(replayScope, nativeTurn.id, expected.kind).find(
                (row) => row.sequence === expected.row.sequence
              )
            ).toEqual({
              sequence: expected.row.sequence,
              id: expected.row.id,
              revision: expected.row.revision,
              value: JSON.parse(expected.body.toString('utf8')),
            });
            const retained = replayReader
              .entries(nativeTurn.id, expected.kind)
              .find((row) => row.sequence === expected.row.sequence)!;
            expect(retained.content).toEqual(expected.row.content);
            const reference = retained.content.reference;
            expect('representation' in reference ? reference.representation : 'file').toBe('file');
            if (!('locator' in reference)) throw new Error('Lost captured native file reference.');
            const original = readFileSync(
              join(replayScope.contentMount.root, reference.locator.path)
            );
            expect(original).toEqual(expected.body);
            expect(original.length).toBe(retained.content.byteLength);
            expect(digest(original)).toBe(expected.sha256);
            expect(reference.contentDigest).toBe(expected.sha256);
          }
        } finally {
          replayReader.close();
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
    'substituted',
  ] as const)('refuses a %s local digest object before invoking its reader', async (fault) => {
    const f = await fixture();
    const authoredPath = join(f.workspaceRoot, 'files', 'substitution.bin');
    if (fault === 'substituted') {
      mkdirSync(dirname(authoredPath), { recursive: true });
      writeFileSync(authoredPath, Buffer.alloc(64, 0x41), { mode: 0o600 });
    }
    const captured = await createWorkspaceBackup(f.input());
    const entry =
      fault === 'substituted'
        ? captured.manifest.inventory.find((item) => item.path === 'files/substitution.bin')!
        : captured.manifest.inventory[0]!;
    const backupRoot = join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId);
    const object = Object.entries(tree(backupRoot)).find(([, hash]) => hash === entry.sha256)?.[0];
    expect(object).toBeDefined();
    const path = join(backupRoot, object!);
    if (fault === 'substituted') {
      writeFileSync(authoredPath, Buffer.alloc(64, 0x42));
      const donor = await createWorkspaceBackup(f.input());
      expect(donor.disposition).toBe('sealed');
      const other = donor.manifest.inventory.find((item) => item.path === entry.path)!;
      expect(other.bytes).toBe(entry.bytes);
      expect(other.sha256).not.toBe(entry.sha256);
      const replacement = Object.entries(tree(backupRoot)).find(
        ([, hash]) => hash === other.sha256
      )?.[0];
      expect(replacement).toBeDefined();
      const mode = lstatSync(path).mode & 0o777;
      chmodSync(path, 0o600);
      writeFileSync(path, readFileSync(join(backupRoot, replacement!)));
      chmodSync(path, mode);
    } else if (fault === 'corrupt') {
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
    const beforeSource = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const pool = dirname(input.bundleRoot);
    expect(existsSync(pool)).toBe(false);
    let committedPin: ReturnType<typeof protectCapture> | undefined;
    let failed = false;
    const pin = captureRecordBoundary(input.backupId, 'pin', 'observe', (message) => {
      if (message.kind === 'pin') {
        const db = openWorkspaceDb(f.dataRoot, workspaceId);
        try {
          committedPin = inspectCapture(db, workspaceId, input.backupId) ?? undefined;
        } finally {
          db.sqlite.close();
        }
      }
      if (message.kind === 'pool-sync') {
        failed = true;
        expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
      }
    });
    captureWorkerProbe.script += `
      let syncFailed = false;
      function poolSync(fd) {
        if (!syncFailed && fs.fstatSync(fd).isDirectory() && fs.realpathSync('/proc/self/fd/' + fd) === ${JSON.stringify(dirname(pool))} && fs.existsSync(${JSON.stringify(pool)})) {
          syncFailed = true;
          captureObserved('pool-sync');
          throw new Error('Injected synchronization failure for the new Workspace pool entry.');
        }
      }
      const originalSync = fs.fsyncSync;
      fs.fsyncSync = function(fd, ...args) { poolSync(fd); return originalSync.call(this, fd, ...args); };
      const originalOpen = fs.promises.open;
      fs.promises.open = async function(...args) {
        const file = await originalOpen.apply(this, args);
        const sync = file.sync.bind(file);
        file.sync = async function() { poolSync(file.fd); return sync(); };
        return file;
      };
    `;
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
    const afterSource = tree(f.workspaceRoot);
    for (const path of [
      '/db/workspace.sqlite',
      '/db/workspace.sqlite-wal',
      '/db/workspace.sqlite-shm',
    ]) {
      delete beforeSource[path];
      delete afterSource[path];
    }
    expect(afterSource).toEqual(beforeSource);
    const afterRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    afterRows.workspace_capture_records = afterRows.workspace_capture_records!.filter((row) => {
      const capture = row as { capture_id: string; workspace_id: string };
      return capture.capture_id !== input.backupId || capture.workspace_id !== workspaceId;
    });
    expect(afterRows).toEqual(beforeRows);
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
      `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`
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

  it.each([
    'authority',
    'capacity',
  ] as const)('refuses initial %s before freezing or accepting a capture', async (fault) => {
    const f = await fixture();
    const sibling = await f.store.createWorkspace('Preflight refusal sibling');
    const input = f.input();
    const before = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const freeze = vi.spyOn(f.mutationAdmission, 'tryFreeze');
    const pending = createWorkspaceBackup({
      ...input,
      ...(fault === 'capacity'
        ? {
            admission: new FileStorageAdmission(
              f.root,
              () => 0n,
              () => 0n
            ),
          }
        : {}),
      source: {
        ...input.source,
        ...(fault === 'authority'
          ? {
              currentAuthority: () => {
                throw new Error('Initial current authority denied.');
              },
            }
          : {}),
      },
    });
    if (fault === 'authority')
      await expect(pending).rejects.toThrow('Initial current authority denied.');
    else await expect(pending).rejects.toMatchObject({ code: 'capacity-exceeded' });
    expect(freeze).not.toHaveBeenCalled();
    expect(tree(f.workspaceRoot)).toEqual(before);
    expect(databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root)).toEqual(beforeRows);
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      expect(inspectCapture(db, workspaceId, input.backupId)).toBeNull();
    } finally {
      db.sqlite.close();
    }
    expect((await f.store.createThread(sibling.id, 'Sibling remains admitted')).owner).toEqual({
      kind: 'workspace',
      workspaceId: sibling.id,
    });
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
  });

  it('rechecks current authority after awaited database preparation before sealing', async () => {
    const f = await fixture();
    const input = f.input();
    let authorized = true;
    const check = vi.fn(() => {
      if (!authorized) throw new Error('Current authority was revoked.');
    });
    const intercept = holdCapturePhase('cut', async () => {
      authorized = false;
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

  it('does not seal after an incomplete mutable cut write fails', async () => {
    const f = await fixture();
    const sourcePath = join(f.workspaceRoot, 'files', 'positive-partial-cut.bin');
    mkdirSync(dirname(sourcePath), { recursive: true });
    const authored = Buffer.from('An exact mutable cut short-write specimen. '.repeat(100));
    writeFileSync(sourcePath, authored, { mode: 0o640 });
    const predecessor = await createWorkspaceBackup(f.input());
    const input = f.input();
    const before = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    const partials: { written: number; prefixHex: string }[] = [];
    captureWorkerProbe.observe = (message) => {
      if (message.kind === 'positive-partial-cut')
        partials.push(message as typeof message & { written: number; prefixHex: string });
    };
    captureWorkerProbe.script = `
      const openCut = fs.promises.open;
      let selectedCut = false;
      fs.promises.open = async function(...args) {
        const file = await openCut.apply(this, args);
        const path = fs.realpathSync('/proc/self/fd/' + file.fd);
        if (!selectedCut && path.endsWith('/files/positive-partial-cut.bin') && path !== ${JSON.stringify(sourcePath)}) {
          selectedCut = true;
          const write = file.write.bind(file);
          let writes = 0;
          let written = 0;
          file.write = async function(buffer, offset, length, ...rest) {
            if (writes++ === 0) {
              const result = await write(buffer, offset, Math.min(length, 7), ...rest);
              written = result.bytesWritten;
              return result;
            }
            observe('positive-partial-cut', { written, prefixHex: fs.readFileSync(path).toString('hex') });
            throw new Error('Injected mutable cut failure after a positive short write.');
          };
        }
        return file;
      };
    `;
    const available = 1_000_000_000n;
    const admission = new FileStorageAdmission(
      f.root,
      () => 0n,
      () => available
    );
    try {
      await expect(createWorkspaceBackup({ ...input, admission })).rejects.toThrow();
    } finally {
      captureWorkerProbe.script = undefined;
      captureWorkerProbe.observe = undefined;
    }
    expect(partials).toHaveLength(1);
    expect(partials[0]!.written).toBeGreaterThan(0);
    expect(partials[0]!.written).toBeLessThan(authored.length);
    expect(Buffer.from(partials[0]!.prefixHex, 'hex')).toEqual(
      authored.subarray(0, partials[0]!.written)
    );
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    expect(readFileSync(sourcePath)).toEqual(authored);
    expect(lstatSync(sourcePath).mode & 0o777).toBe(0o640);
    const after = tree(f.workspaceRoot);
    for (const path of [
      '/db/workspace.sqlite',
      '/db/workspace.sqlite-wal',
      '/db/workspace.sqlite-shm',
    ]) {
      delete before[path];
      delete after[path];
    }
    expect(after).toEqual(before);
    const afterRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    afterRows.workspace_capture_records = afterRows.workspace_capture_records!.filter((row) => {
      const capture = row as { capture_id: string; workspace_id: string };
      return capture.capture_id !== input.backupId || capture.workspace_id !== workspaceId;
    });
    expect(afterRows).toEqual(beforeRows);
    const db = openWorkspaceDb(f.dataRoot, workspaceId);
    try {
      expect(inspectCapture(db, workspaceId, input.backupId)).toMatchObject({
        captureId: input.backupId,
        state: 'active',
      });
    } finally {
      db.sqlite.close();
    }
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const hold = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
      `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`
    );
    expect(hold).not.toBeNull();
    (await hold!)();
    const readmitted = admission.reserve({
      stagingBytes: available,
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
    readmitted.release();
    await f.read(predecessor.manifest.backupId, async (bundle) => {
      expect(bundle.manifestDigest).toBe(predecessor.report.manifestDigest);
      for (const entry of bundle.manifest.inventory)
        expect(digest(await bytes(bundle, entry.path))).toBe(entry.sha256);
    });
  });

  it('keeps manual unfinished capture inspectable after native-copy failure and cold reopen', async () => {
    const f = await fixture();
    const previous = await createWorkspaceBackup(f.input());
    const input = f.input();
    const beforeSource = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    captureWorkerProbe.script = `
      Database.prototype.backup = async function() { throw new Error('Injected native SQLite backup failure.'); };
    `;
    const intercept = {
      mockRestore: () => {
        captureWorkerProbe.script = undefined;
      },
    };
    try {
      await expect(createWorkspaceBackup(input)).rejects.toThrow();
    } finally {
      intercept.mockRestore();
    }
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    const afterSource = tree(f.workspaceRoot);
    for (const path of [
      '/db/workspace.sqlite',
      '/db/workspace.sqlite-wal',
      '/db/workspace.sqlite-shm',
    ]) {
      delete beforeSource[path];
      delete afterSource[path];
    }
    expect(afterSource).toEqual(beforeSource);
    const afterRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    afterRows.workspace_capture_records = afterRows.workspace_capture_records!.filter((row) => {
      const capture = row as { capture_id: string; workspace_id: string };
      return capture.capture_id !== input.backupId || capture.workspace_id !== workspaceId;
    });
    expect(afterRows).toEqual(beforeRows);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const nextHold = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
      `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`
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
    const beforeSource = tree(f.workspaceRoot);
    const beforeRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    let calls = 0;
    let publishedDigest: string | undefined;
    const completion = captureRecordBoundary(input.backupId, 'finish', cut, (message) => {
      calls += 1;
      expect(message.workspaceId).toBe(workspaceId);
      expect(message.captureId).toBe(input.backupId);
      const seal = JSON.parse(readFileSync(join(input.bundleRoot, 'seal.json'), 'utf8')) as {
        backupId: string;
        manifestDigest: string;
      };
      expect(seal.backupId).toBe(input.backupId);
      publishedDigest = seal.manifestDigest;
      if (cut === 'lost-ack') {
        const db = openWorkspaceDb(f.dataRoot, workspaceId);
        try {
          expect(inspectCapture(db, workspaceId, input.backupId)?.state).toBe('finished');
        } finally {
          db.sqlite.close();
        }
      }
    });
    try {
      await expect(createWorkspaceBackup(input)).rejects.toThrow();
    } finally {
      completion.mockRestore();
    }
    expect(calls).toBe(1);
    expect(publishedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const afterSource = tree(f.workspaceRoot);
    for (const path of [
      '/db/workspace.sqlite',
      '/db/workspace.sqlite-wal',
      '/db/workspace.sqlite-shm',
    ]) {
      delete beforeSource[path];
      delete afterSource[path];
    }
    expect(afterSource).toEqual(beforeSource);
    const afterRows = databaseRows(workspaceDbPath(f.dataRoot, workspaceId), f.root);
    afterRows.workspace_capture_records = afterRows.workspace_capture_records!.filter((row) => {
      const capture = row as { capture_id: string; workspace_id: string };
      return capture.capture_id !== input.backupId || capture.workspace_id !== workspaceId;
    });
    expect(afterRows).toEqual(beforeRows);
    expect(f.mutationAdmission.isClosed(workspaceId)).toBe(false);
    const held = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
      `workspace:${workspaceDbPath(f.dataRoot, workspaceId)}`
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
    const copy = holdCapturePhase('db-backup', async () => {
      enter();
      await barrier;
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

// Online Snapshot Policy and Bootstrap recovery preserve origin and publication uncertainty.
describe('C-b automatic capture origin after restart', () => {
  it('abandons only the real automatic unsealed capture and does not retry it', async () => {
    const f = await fixture();
    const input = { ...f.input(), origin: 'automatic' as const };
    captureWorkerProbe.script = `
      Database.prototype.backup = async function() { throw new Error('Injected native SQLite backup failure.'); };
    `;
    try {
      await expect(createWorkspaceBackup(input)).rejects.toThrow();
    } finally {
      captureWorkerProbe.script = undefined;
    }
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
    const inspectDb = bindWorkspaceSqlite(
      new Database(workspaceDbPath(f.dataRoot, workspaceId), {
        readonly: true,
        fileMustExist: true,
      }),
      f.dataRoot,
      workspaceId
    );
    databaseHandles.push(inspectDb);
    expect(inspectCapture(inspectDb, workspaceId, input.backupId)).toMatchObject({
      state: 'active',
      origin: 'automatic',
    });
    // Live capture has no Core recovery-admission authority to synthesize or end.
    expect(readRecoveryAdmission(f.coreDb, input.backupId)).toBeUndefined();
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    const coreDb = openCoreDb(f.dataRoot);
    databaseHandles.push(coreDb);
    const gate = new WorkspaceMutationAdmission();
    const generations = tree(join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId));
    restoreWorkspaceRecoveryAdmission(coreDb, gate);
    const abandoned = inspectCapture(inspectDb, workspaceId, input.backupId);
    expect(abandoned).toMatchObject({ state: 'abandoned', origin: 'automatic' });
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(true);
    expect(gate.isClosed(workspaceId)).toBe(false);
    const release = gate.enter(workspaceId);
    expect(release).not.toBeNull();
    release!();
    restoreWorkspaceRecoveryAdmission(coreDb, gate);
    expect(inspectCapture(inspectDb, workspaceId, input.backupId)).toEqual(abandoned);
    expect(readRecoveryAdmission(coreDb, input.backupId)).toBeUndefined();
    expect(tree(join(f.dataRoot, 'server', 'backups', 'workspaces', workspaceId))).toEqual(
      generations
    );
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
  });

  it('preserves an automatic durable seal when its capture finish did not commit', async () => {
    const f = await fixture();
    const input = { ...f.input(), origin: 'automatic' as const };
    let worker: Worker | undefined;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    captureWorkerProbe.onPhase = (selected, message) => {
      if (message.phase !== 'finish') return false;
      worker = selected;
      enter();
      return true;
    };
    const capturing = createWorkspaceBackup(input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      await Promise.race([
        entered,
        capturing.then((outcome) => {
          if ('error' in outcome) throw outcome.error;
          throw new Error('Capture did not reach the real worker finish boundary.');
        }),
      ]);
      expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(true);
      await worker!.terminate();
      expect(await capturing).toMatchObject({ error: expect.any(Error) });
    } finally {
      captureWorkerProbe.onPhase = undefined;
      if (worker && worker.threadId !== -1) await worker.terminate();
      await capturing;
    }
    const generation = tree(input.bundleRoot);
    const inspectDb = bindWorkspaceSqlite(
      new Database(workspaceDbPath(f.dataRoot, workspaceId), {
        readonly: true,
        fileMustExist: true,
      }),
      f.dataRoot,
      workspaceId
    );
    databaseHandles.push(inspectDb);
    const capture = inspectCapture(inspectDb, workspaceId, input.backupId);
    expect(capture).toMatchObject({ state: 'active', origin: 'automatic' });
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    const coreDb = openCoreDb(f.dataRoot);
    databaseHandles.push(coreDb);
    const gate = new WorkspaceMutationAdmission();
    restoreWorkspaceRecoveryAdmission(coreDb, gate);
    expect(inspectCapture(inspectDb, workspaceId, input.backupId)).toEqual(capture);
    expect(tree(input.bundleRoot)).toEqual(generation);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
    expect(gate.isClosed(workspaceId)).toBe(true);
    await f.read(input.backupId, async (bundle) => {
      expect(bundle.seal?.backupId).toBe(input.backupId);
      for (const entry of bundle.manifest.inventory)
        expect(digest(await bytes(bundle, entry.path))).toBe(entry.sha256);
    });
  });

  it('retains an independent database refusal when automatic capture recovery runs', async () => {
    const f = await fixture();
    const input = { ...f.input(), origin: 'automatic' as const };
    captureWorkerProbe.script = `
      Database.prototype.backup = async function() { throw new Error('Injected native SQLite backup failure.'); };
    `;
    try {
      await expect(createWorkspaceBackup(input)).rejects.toThrow();
    } finally {
      captureWorkerProbe.script = undefined;
    }
    const inspectDb = bindWorkspaceSqlite(
      new Database(workspaceDbPath(f.dataRoot, workspaceId), {
        readonly: true,
        fileMustExist: true,
      }),
      f.dataRoot,
      workspaceId
    );
    databaseHandles.push(inspectDb);
    expect(inspectCapture(inspectDb, workspaceId, input.backupId)).toMatchObject({
      state: 'active',
      origin: 'automatic',
    });
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    const coreDb = openCoreDb(f.dataRoot);
    databaseHandles.push(coreDb);
    const { refuseScope } = await import('../bootstrap/readiness.js');
    const databaseFailure = {
      scope: 'workspace' as const,
      id: workspaceId,
      check: 'database' as const,
    };
    refuseScope(f.dataRoot, databaseFailure);
    const capture = inspectCapture(inspectDb, workspaceId, input.backupId);
    const before = tree(input.bundleRoot);
    const gate = new WorkspaceMutationAdmission();
    restoreWorkspaceRecoveryAdmission(coreDb, gate);
    expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual(databaseFailure);
    expect(inspectCapture(inspectDb, workspaceId, input.backupId)).toEqual(capture);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
    expect(gate.isClosed(workspaceId)).toBe(true);
    expect(gate.enter(workspaceId)).toBeNull();
    expect(tree(input.bundleRoot)).toEqual(before);
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(false);
  });
});
