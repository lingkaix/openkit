import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs, {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  type AdministratorCleanupReadResponse,
  AdministratorCleanupReadResponseSchema,
} from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { createApp } from './app.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { listNanoHostTransportTokenRecords } from './auth/nanohost-transport-token-store.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { createOperationInvocation } from './operation-composition.js';
import { OperationError } from './operation-error.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { localCoreJournalIntent } from './runtime/core-journal-records.js';
import { requireSchedulerExecutionAttempt } from './runtime/execution-attempt-records.js';
import {
  CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION,
  commitSchedulerAttemptLifecycleStepInDb,
  readExecutionJournalInvocation,
  readExecutionJournalRoot,
  writeExecutionJournalIntent,
} from './runtime/execution-journal.js';
import type { ExecutionInvocation, ExecutionJournalRef } from './runtime/execution-step-journal.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
  removeNanoHostSandboxRuntimeByBinding,
} from './runtime/nanohost-harness.js';
import { getWorkerBackendSession } from './runtime/worker-backend-session-records.js';
import { createWorkerStorageBinding } from './runtime/worker-storage-binding-records.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from './scheduler-records.js';
import { commandInputHash } from './storage/control-store-input.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, serverStoragePath } from './storage/db.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import {
  inspectNanoHostRuntimeTargetTransition,
  prepareNanoHostRuntimeTargetTransition,
  readNanoHostEpochInvalidation,
  readPendingNanoHostEpochRetirement,
} from './storage/nanohost-epoch-invalidation-native.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './storage/nanohost-transport-owner.js';
import type { ControlRuntimeTargetInput } from './storage/runtime-target-codecs.js';
import { verifyAndMigrateExistingScopedDatabases } from './storage/workspace-storage-migration.js';
import {
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
} from './test-support/admitted-nanohost.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { schedulerFixtureInput } from './test-support/scheduler-admissions.js';
import {
  createWorkspaceDeletionRequest,
  readWorkspaceDeletionRequest,
  writeWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { beginWorkspaceDeletion } from './workspace-sharing.js';

// The reader stays synchronous. This hook wakes it only after the Native SQLite COMMIT returns.
const snapshotNativeInterception = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (snapshotNativeInterception.gate === undefined) {
          super(filename, options);
        } else {
          const require = createRequire(import.meta.url);
          const prelude = `
            const {workerData, parentPort} = require('node:worker_threads');
            const Database = require(workerData.databaseModule);
            const originalExec = Database.prototype.exec;
            const gate = workerData.snapshotGate;
            let crossing = false;
            parentPort.on('message', value => {
              const mutation = value.mutation;
              if (value.operation === 'nanohost-owner' && mutation.kind === 'backend-session' &&
                  mutation.input.kind === 'transition') crossing = true;
            });
            Database.prototype.exec = function(sql) {
              const result = originalExec.call(this, sql);
              if (crossing && /^COMMIT$/i.test(sql)) {
                crossing = false;
                Atomics.store(gate, 1, this.pragma('synchronous', {simple: true}));
                Atomics.store(gate, 0, 1);
                Atomics.notify(gate, 0);
              }
              return result;
            };
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              databaseModule: require.resolve('better-sqlite3'),
              snapshotGate: new Int32Array(snapshotNativeInterception.gate),
            },
          });
        }
      }
    },
  };
});

const OPERATION = 'administration.cleanup-read';
const CREATED = '2026-10-16T00:00:00.000Z';
const CHANGED = '2026-10-16T00:00:01.000Z';
const TARGET = 'target_cleanup';
const EPOCH = 'a'.repeat(64);
const PRIVATE = 'private-cleanup-operation-canary';
const REQUEST = '00000000-0000-4000-8000-000000000226';
const SOURCES = [
  'workspace-deletion',
  'workspace-registry',
  'execution-attempt',
  'backend-session',
  'agent-session-binding',
  'sandbox-runtime',
  'worker-storage',
];
const fixtures: Array<{ coreDb: CoreDb; dataRoot: string }> = [];

/** Composes public invocation with real identity and canonical source owners. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'cleanup-operation-'));
  const coreDb = openCoreDb(dataRoot);
  fixtures.push({ coreDb, dataRoot });
  applyMigrations(coreDb);
  coreDb.sqlite.pragma('journal_mode = WAL');
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: 'usr_00000000-0000-7000-8000-000000000001',
    tokenScope: 'server-admin',
    tokenId: token.tokenId,
  };
  const nanoHostStorage = await openAdmittedTestNanoHost(coreDb);
  const nanoHostCleanupOwner = { state: 'ready', value: nanoHostStorage.value.owner } as const;
  const nativeReader = nanoHostCleanupOwner.value.read((sqlite) => sqlite);
  if (nativeReader.state !== 'ready') throw new Error(`NanoHost reader: ${nativeReader.reason}`);
  const dependencies = {
    nanoHostCleanupOwner,
    coreDb,
    dataRoot,
    store,
    inflightCommands: new WeakMap(),
  };
  const invoke = createOperationInvocation(dependencies);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', actor);
    await next();
  });
  registerOperationJsonRoutes({ ...dependencies, app, requestStore: () => store });
  const native = (input: unknown = {}, currentActor = actor) =>
    invoke(OPERATION, input as never, { kind: 'public', actor: currentActor });
  const json = (input: unknown = {}) =>
    app.request(`/api/app/operations/${OPERATION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  return {
    ...dependencies,
    nanoHostStorage,
    nativeSqlite: nativeReader.value,
    token,
    actor,
    invoke,
    native,
    json,
    app,
  };
}

/** Creates the deletion owner's durable request without advancing deletion. */
function deletion(f: Fixture, requestId = REQUEST) {
  return createWorkspaceDeletionRequest(f.dataRoot, {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    requestId,
    originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
    confirmation: 'permanently-delete-workspace:ws_00000000-0000-7000-8000-000000000001:1',
    expectedRegistryRevision: 1,
    createdAt: CREATED,
  });
}

/** Creates a real prepared Scheduler attempt with no execution or Host contact. */
function attempt(coreDb: CoreDb, label = 'attempt_cleanup_operation') {
  const id = testEntityId('attempt', label);
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${id}`,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: testEntityId('th', `thread_${id}`),
    turnId: testEntityId('tu', `turn_${id}`),
    inputRef: schedulerFixtureInput(
      'ws_00000000-0000-7000-8000-000000000001',
      testEntityId('tu', `turn_${id}`),
      PRIVATE
    ),
    requestedAgentId: 'agent_cleanup',
    now: () => CREATED,
  });
  return recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: id,
    agentSessionId: testEntityId('as', `session_${id}`),
    inputRef: `package_${id}`,
    bindingRef: `binding_${id}`,
    sessionCompatibilityKey: 'b'.repeat(64),
    now: () => CREATED,
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Commits a RuntimeTarget transition through the admitted owner. */
async function transitionTarget(f: Fixture, input: ControlRuntimeTargetInput) {
  const result = await transitionAdmittedNanoHostRuntimeTarget(f.nanoHostStorage.value, input);
  if (result.state !== 'ready') throw new Error(`RuntimeTarget held: ${result.reason}`);
  return result.value;
}

/** Installs a ready target once before seeding its physical observations. */
async function readyTarget(f: Fixture) {
  const target = {
    deploymentId: readDataRootLayoutMarker(f.dataRoot).deploymentId,
    identityId: 'identity_cleanup',
    targetId: TARGET,
    observedAt: CREATED,
  };
  const allocated = await transitionTarget(f, { kind: 'allocate', ...target });
  if (!allocated) throw new Error('Expected a RuntimeTarget allocation.');
  const ready = await transitionTarget(f, {
    kind: 'ready',
    ...target,
    connectionGeneration: allocated.connectionGeneration,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: EPOCH,
  });
  if (!ready?.ready) throw new Error('Expected an admitted RuntimeTarget.');
  return target;
}

/** Seeds retained physical facts that do not have a standalone serving writer on this candidate. */
function seedNanoHost<Value>(f: Fixture, write: (sqlite: Database.Database) => Value): Value {
  const sqlite = new Database(serverStoragePath(f.dataRoot, 'nanohost'), { fileMustExist: true });
  try {
    sqlite.pragma('foreign_keys = ON');
    return sqlite.transaction(() => write(sqlite)).immediate();
  } finally {
    sqlite.close();
  }
}

/** Binds the admitted worker for the owner-local transition and reopening tests. */
async function bindNanoHostWriter(f: Fixture) {
  const result = await getControlStoreWorkerClient().bindNanoHostOwner(
    f.dataRoot,
    {
      getWorkerBackendSession,
      inspectNanoHostRuntimeTargetTransition,
      listNanoHostTransportTokenRecords,
      prepareNanoHostRuntimeTargetTransition,
      readNanoHostEpochInvalidation,
      readPendingNanoHostEpochRetirement,
    },
    { enabled: () => true }
  );
  if (result.state !== 'ready') throw new Error(`NanoHost writer: ${result.reason}`);
  return result.value;
}

/** Creates a native Sandbox identity to exercise complete UTF-8 response bounds. */
async function sandbox(f: Fixture, id: string): Promise<void> {
  await createNanoHostHarnessRuntime(f.nanoHostStorage.value.owner, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: `harness_${id}`,
    harnessBindingRef: `harness_binding_${id}`,
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: EPOCH,
    sandboxBindingRef: `sandbox_binding_${id}`,
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: `integration_${id}`,
    sandboxRuntimeId: id,
    runtimeTargetId: TARGET,
    timestamp: CREATED,
  });
}

/** Populates all seven source families through their retained record producers and real scope admission. */
async function populate(f: Fixture) {
  const request = deletion(f);
  const quarantinedId = (await f.store.createWorkspace('Quarantined cleanup metadata')).id;
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: quarantinedId,
    ownerUserId: f.actor.userId,
  });
  writeFileSync(
    join(f.dataRoot, 'workspaces', quarantinedId, 'db', 'workspace.sqlite'),
    'Unreadable cleanup fixture authority'
  );
  await verifyAndMigrateExistingScopedDatabases(f.dataRoot);
  const execution = attempt(f.coreDb);
  const storage = await populateRuntime(f, execution);
  return { request, execution, storage, quarantinedId };
}

/** Populates the four Native sources with the exact Core attempt lineage. */
async function populateRuntime(f: Fixture, execution: ReturnType<typeof attempt>) {
  const { deploymentId, targetId } = await readyTarget(f);
  await createNanoHostHarnessRuntime(f.nanoHostStorage.value.owner, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: 'harness_cleanup',
    harnessBindingRef: 'harness_binding_cleanup',
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: EPOCH,
    sandboxBindingRef: 'sandbox_binding_cleanup',
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: 'integration_cleanup',
    sandboxRuntimeId: 'sandbox_cleanup',
    runtimeTargetId: TARGET,
    timestamp: CREATED,
  });
  await openNanoHostAgentSessionBinding(f.nanoHostStorage.value.owner, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: execution.agentSessionId!,
    agentSessionRuntimeBindingId: 'binding_cleanup',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'harness_cleanup',
    threadId: execution.threadId,
    workspaceId: execution.workspaceId,
    timestamp: CREATED,
  });
  return seedNanoHost(f, (sqlite) => {
    sqlite
      .prepare(`INSERT INTO worker_backend_sessions (
        attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
        backend_kind, deployment_id, backend_session_id, runtime_target_id, origin_physical_epoch,
        backend_lineage_json, sandbox_binding_ref, staging_directory_ref, workspace_handoff_state,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'openshell', ?, ?, ?, ?, ?, ?, ?, 'pending', 'materializing', ?, ?)`)
      .run(
        execution.attemptId,
        execution.workspaceId,
        execution.threadId,
        execution.turnId,
        execution.agentSessionId,
        execution.inputRef,
        deploymentId,
        PRIVATE,
        targetId,
        EPOCH,
        JSON.stringify({ imageRef: `registry.example/${PRIVATE}` }),
        execution.bindingRef,
        `server/runtime/${PRIVATE}`,
        CREATED,
        CREATED
      );
    // This idle binding has no contributors or live writer.
    return createWorkerStorageBinding(
      { sqlite },
      {
        deploymentId,
        layout: {
          family: 'worker',
          version: '1',
          uid: 1000,
          gid: 1000,
          workingDirectory: '/workspace',
          platform: { architecture: 'amd64', os: 'linux' },
          targets: [{ target: '/workspace' }],
        },
        now: CREATED,
        runtimeTargetId: targetId,
        workspaceId: execution.workspaceId,
      }
    );
  });
}

/** Captures every table in one owner to detect writes during observation. */
function rows(sqlite: Database.Database) {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return tables.map(({ name }) => ({
    name,
    rows: sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
  }));
}

/** Captures file bytes and names, excluding SQLite's own read bookkeeping. */
function files(root: string, directory = root): Array<[string, string]> {
  return readdirSync(directory)
    .sort()
    .flatMap((name): Array<[string, string]> => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return files(root, path);
      if (/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(name)) return [];
      return [
        [relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex')],
      ];
    });
}

/** Validates the complete known-field response and independently measures the fixed wire ceiling. */
function bounded(value: unknown): AdministratorCleanupReadResponse {
  const response = AdministratorCleanupReadResponseSchema.parse(value);
  expect(response).toEqual(value);
  expect(response.sources.map((source) => source.source)).toEqual(SOURCES);
  expect(response.items.length).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(262144);
  return response;
}

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  snapshotNativeInterception.gate = undefined;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const f of fixtures.splice(0)) {
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

/** Models an admitted administrator decision with the existing journal writer. */
function recordSandboxRepair(
  coreDb: CoreDb,
  hold: ExecutionJournalRef,
  overrides: {
    attemptId?: string;
    bindingRef?: string;
    systemActor?: boolean;
    inputRefs?: string[];
    target?: Partial<NonNullable<ExecutionInvocation['control']['target']>>;
    physicalFenceRefs?: string[];
  } = {}
) {
  const root = readExecutionJournalRoot(coreDb, hold);
  const { control } = readExecutionJournalInvocation(coreDb, { execution: hold, stepId: 'fence' });
  const intent = localCoreJournalIntent({
    definitionVersion: CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION,
    executionId: hold.executionId,
    stepId: 'repair',
    workId: root.workId,
    fingerprint: commandInputHash([hold.executionId, root.revision, REQUEST]),
    kind: 'fence',
    actorId: 'administrator',
    inputRefs: overrides.inputRefs ?? [hold.executionId],
    authorityRefs: [],
    carriage: {
      operation: 'sandbox.release-repair',
      requestId: REQUEST,
      sequence: null,
      bindingRef: overrides.bindingRef ?? root.workId,
    },
    timestamp: CHANGED,
    root,
  });
  coreDb.sqlite.transaction(() =>
    writeExecutionJournalIntent(coreDb, {
      ...intent,
      control: {
        ...intent.control,
        actor: overrides.systemActor
          ? intent.control.actor
          : { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        attemptId: overrides.attemptId ?? control.attemptId,
        target: control.target && { ...control.target, ...overrides.target },
        physicalFenceRefs: overrides.physicalFenceRefs ?? control.physicalFenceRefs,
      },
    })
  )();
}

/** Models the existing Core receipt after exact release and requeue. */
function recordSandboxHandoff(coreDb: CoreDb, attemptId: string, orderId: string) {
  coreDb.sqlite.transaction(() => {
    const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
    const admission = requireSchedulerAdmissionEntry(coreDb, attempt.queueEntryId);
    coreDb.sqlite
      .prepare(`UPDATE scheduler_execution_attempts
        SET phase='closed', terminal_cause='sandbox-release-refusal' WHERE attempt_id=?`)
      .run(attemptId);
    commitSchedulerAttemptLifecycleStepInDb(coreDb, {
      attemptId,
      actor: admission.triggerActor,
      turnId: attempt.turnId,
      admissionHash: admission.inputHash,
      operationId: attempt.operationId,
      timestamp: CHANGED,
      kind: 'release',
      outputRefs: [`fence:${orderId}`],
      closed: true,
    });
    coreDb.sqlite
      .prepare("UPDATE scheduler_admission_entries SET status='queued' WHERE queue_entry_id=?")
      .run(attempt.queueEntryId);
  })();
}

/** Changes only the completed release output while preserving the attempt phase and claim. */
function setSandboxHandoffFence(coreDb: CoreDb, attemptId: string, fenceRef: string | null) {
  coreDb.sqlite.transaction(() => {
    // Model corrupted retained output. Restore the settle-once constraint before observation.
    const trigger = 'control_execution_steps_settle_once';
    const { sql } = coreDb.sqlite
      .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
      .get(trigger) as { sql: string };
    coreDb.sqlite.exec(`DROP TRIGGER ${trigger}`);
    const { changes } = coreDb.sqlite
      .prepare(`UPDATE control_execution_steps
        SET control_json=json_set(control_json, '$.outputRefs', json(?))
        WHERE execution_id=? AND state='completed' AND json_extract(control_json, '$.kind')='release'`)
      .run(
        JSON.stringify(fenceRef === null ? [] : [`fence:${fenceRef}`]),
        `scheduler-lifecycle:${attemptId}`
      );
    expect(changes).toBe(1);
    coreDb.sqlite.exec(sql);
  })();
}

/** Seeds the Core fences and retained scheduler succession for the public read. */
function recordSandboxHold(
  coreDb: CoreDb,
  sandboxRuntimeId: string,
  bindingRef: string,
  epoch: string,
  options: {
    omitOriginalReference?: boolean;
    conflictOriginalOrder?: boolean;
    intervening?: readonly ('automatic' | 'repaired')[];
    useInterveningOrder?: boolean;
    originalReference?: string;
    ownFenceSequence?: number;
    competingAttempt?: boolean;
  } = {}
) {
  const definitionVersion = CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION;
  const targetId = 'target_cleanup';
  const record = (
    binding: string,
    attemptId: string,
    operation: 'sandbox.release-refusal' | 'sandbox.release-refusal-hold',
    inputRefs: readonly string[],
    sequence: number | null = null,
    originEpoch = epoch
  ) => {
    const fingerprint = commandInputHash([definitionVersion, targetId, originEpoch, binding]);
    const executionId = `sandbox-release-refusal:${fingerprint}`;
    const intent = localCoreJournalIntent({
      definitionVersion,
      executionId,
      stepId: 'fence',
      workId: binding,
      fingerprint,
      kind: 'fence',
      actorId: 'nanohost-release-refusal',
      inputRefs,
      authorityRefs: [sandboxRuntimeId],
      carriage: { operation, requestId: fingerprint, sequence, bindingRef: binding },
      timestamp: CREATED,
    });
    writeExecutionJournalIntent(coreDb, {
      ...intent,
      control: {
        ...intent.control,
        attemptId,
        target: { backendKind: 'openshell', targetId, allocationRef: binding },
        physicalFenceRefs: [originEpoch],
      },
    });
    return intent.execution.ref;
  };
  return coreDb.sqlite.transaction(() => {
    const predecessor = attempt(coreDb, `predecessor-${bindingRef}`);
    const next = (binding: string) =>
      recordTestExecutionAttempt(coreDb, {
        entry: requireSchedulerAdmissionEntry(coreDb, predecessor.queueEntryId),
        attemptId: testEntityId('attempt', `successor-${binding}`),
        agentSessionId: predecessor.agentSessionId!,
        inputRef: `successor-package-${binding}`,
        bindingRef: binding,
        sessionCompatibilityKey: 'b'.repeat(64),
        now: () => CHANGED,
      });
    const original = record(
      predecessor.bindingRef!,
      predecessor.attemptId,
      'sandbox.release-refusal',
      [],
      options.conflictOriginalOrder ? 1 : null,
      '1'.repeat(64)
    );
    recordSandboxHandoff(coreDb, predecessor.attemptId, original.executionId);
    const intermediate = (options.intervening ?? []).map((kind, index) => {
      const binding = `intervening-${index}-${bindingRef}`;
      const attempt = next(binding);
      const order = record(
        binding,
        attempt.attemptId,
        kind === 'automatic' ? 'sandbox.release-refusal' : 'sandbox.release-refusal-hold',
        kind === 'automatic' ? [] : [original.executionId],
        null,
        '2'.repeat(64)
      );
      if (kind === 'repaired') recordSandboxRepair(coreDb, order);
      recordSandboxHandoff(coreDb, attempt.attemptId, order.executionId);
      return { attempt, order };
    });
    const successor = next(bindingRef);
    coreDb.sqlite
      .prepare(`UPDATE scheduler_execution_attempts
      SET phase='closing', terminal_cause='sandbox-release-refusal' WHERE attempt_id=?`)
      .run(successor.attemptId);
    const hold = record(
      bindingRef,
      successor.attemptId,
      'sandbox.release-refusal-hold',
      options.omitOriginalReference
        ? []
        : [
            options.originalReference ??
              (options.useInterveningOrder
                ? intermediate[0]!.order.executionId
                : original.executionId),
          ],
      options.ownFenceSequence ?? null
    );
    if (options.competingAttempt) {
      // Model another attempt after the held one while retaining its original closing state.
      recordSandboxHandoff(coreDb, successor.attemptId, hold.executionId);
      const competing = next(`competing-${bindingRef}`);
      coreDb.sqlite
        .prepare("UPDATE scheduler_execution_attempts SET phase='closed' WHERE attempt_id=?")
        .run(competing.attemptId);
      coreDb.sqlite
        .prepare("UPDATE scheduler_execution_attempts SET phase='closing' WHERE attempt_id=?")
        .run(successor.attemptId);
      setSandboxHandoffFence(coreDb, successor.attemptId, null);
    }
    return { original, hold, predecessor, successor, intermediate };
  })();
}

it('returns an empty final Sandbox hold page on fresh K8', async () => {
  const f = await fixture();
  await expect(
    f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor })
  ).resolves.toEqual({ holds: [], incomplete: false, nextCursor: null });
});

it('discovers the exact Sandbox hold from Core after the Native resident is gone', async () => {
  const f = await fixture();
  const id = 'administration.sandbox-hold-read';
  const sandboxRuntimeId = 'sandbox-held';
  const oldBinding = `sandbox_binding_${sandboxRuntimeId}`;
  const target = await readyTarget(f);
  await sandbox(f, sandboxRuntimeId);
  const nativeRuntimes = (coreDb: CoreDb) =>
    readAdmittedTestNanoHost(coreDb, (sqlite) =>
      sqlite
        .prepare(`SELECT sandbox_runtime_id AS runtimeId, sandbox_binding_ref AS bindingRef,
        origin_physical_epoch AS epoch FROM sandbox_runtime_records`)
        .all()
    );
  expect(nativeRuntimes(f.coreDb)).toEqual([
    { runtimeId: sandboxRuntimeId, bindingRef: oldBinding, epoch: EPOCH },
  ]);
  const { hold } = recordSandboxHold(f.coreDb, sandboxRuntimeId, oldBinding, EPOCH, {
    intervening: ['repaired'],
  });
  const expected = {
    holds: [projectedSandboxHold(f.coreDb, hold, 'eligible')],
    incomplete: false,
    nextCursor: null,
  };
  const snapshot = (coreDb: CoreDb) => ({
    core: rows(coreDb.sqlite),
    native: readAdmittedTestNanoHost(coreDb, rows),
    files: files(f.dataRoot),
  });
  const before = snapshot(f.coreDb);
  await expect(f.invoke(id, {}, { kind: 'public', actor: f.actor })).resolves.toEqual(expected);
  expect(snapshot(f.coreDb)).toEqual(before);
  const response = await f.app.request(`/api/app/operations/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  expect(payload).toEqual(expected);
  expect(snapshot(f.coreDb)).toEqual(before);

  await removeNanoHostSandboxRuntimeByBinding(f.nanoHostStorage.value.owner, oldBinding);
  await shutdownControlStoreWorkerClient();
  f.coreDb.sqlite.close();
  const cold = openCoreDb(f.dataRoot);
  fixtures.push({ coreDb: cold, dataRoot: f.dataRoot });
  const nanoHostStorage = await openAdmittedTestNanoHost(cold);
  expect(nativeRuntimes(cold)).toEqual([]);
  const invoke = createOperationInvocation({
    ...f,
    coreDb: cold,
    nanoHostCleanupOwner: { state: 'ready', value: nanoHostStorage.value.owner },
  });
  const absent = snapshot(cold);
  await expect(invoke(id, {}, { kind: 'public', actor: f.actor })).resolves.toEqual(expected);
  expect(snapshot(cold)).toEqual(absent);

  // A later resident can reuse the runtime ID. Its binding and epoch cannot retarget the hold.
  const reopened = { ...f, coreDb: cold, nanoHostStorage };
  const nextTarget = { ...target, observedAt: CHANGED };
  const allocated = await transitionTarget(reopened, { kind: 'allocate', ...nextTarget });
  if (!allocated) throw new Error('Expected a replacement RuntimeTarget allocation.');
  expect(allocated.connectionGeneration).toBe(2);
  const newEpoch = 'c'.repeat(64);
  const ready = await transitionTarget(reopened, {
    kind: 'ready',
    ...nextTarget,
    connectionGeneration: allocated.connectionGeneration,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: newEpoch,
  });
  expect(ready).toMatchObject({ ready: true, freshEmpty: true, physicalEpoch: newEpoch });
  const newBinding = 'replacement-sandbox-binding';
  await createNanoHostHarnessRuntime(nanoHostStorage.value.owner, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: 'replacement-harness',
    harnessBindingRef: 'replacement-harness-binding',
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: newEpoch,
    sandboxBindingRef: newBinding,
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: 'replacement-integration',
    sandboxRuntimeId,
    runtimeTargetId: target.targetId,
    timestamp: CHANGED,
  });
  expect(nativeRuntimes(cold)).toEqual([
    { runtimeId: sandboxRuntimeId, bindingRef: newBinding, epoch: newEpoch },
  ]);
  const reused = snapshot(cold);
  await expect(invoke(id, {}, { kind: 'public', actor: f.actor })).resolves.toEqual(expected);
  expect(snapshot(cold)).toEqual(reused);
  await expect(
    invoke(id, {}, { kind: 'public', actor: { kind: 'session', userId: f.actor.userId } })
  ).rejects.toMatchObject({ status: 403 });
});

it.each([
  ['missing reference', 'original-refusal-missing'],
  ['missing order', 'original-refusal-missing'],
  ['missing fence step', 'original-refusal-missing'],
  ['conflicting order', 'original-refusal-conflicting'],
  ['conflicting lineage', 'original-refusal-conflicting'],
  ['conflicting predecessor binding', 'original-refusal-conflicting'],
  ['conflicting successor binding', 'original-refusal-conflicting'],
  ['skipped intervening refusal', 'original-refusal-conflicting'],
  ['valid order and lineage', null],
] as const)('Sandbox hold repairability matrix: %s', async (scenario, reason) => {
  const f = await fixture();
  const { original, hold, predecessor, successor } = recordSandboxHold(
    f.coreDb,
    'sandbox-held',
    'sandbox-binding',
    'a'.repeat(64),
    {
      omitOriginalReference: scenario === 'missing reference',
      conflictOriginalOrder: scenario === 'conflicting order',
      ...(scenario === 'missing order'
        ? { originalReference: `sandbox-release-refusal:sha256:${'0'.repeat(64)}` }
        : {}),
      ...(scenario === 'skipped intervening refusal' ? { intervening: ['automatic'] } : {}),
    }
  );
  switch (scenario) {
    case 'missing fence step':
      f.coreDb.sqlite
        .prepare("DELETE FROM control_execution_steps WHERE execution_id=? AND step_id='fence'")
        .run(original.executionId);
      break;
    case 'conflicting lineage':
      f.coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET agent_session_id=? WHERE attempt_id=?')
        .run(testEntityId('as', 'unrelated-predecessor'), predecessor.attemptId);
      break;
    case 'conflicting predecessor binding':
    case 'conflicting successor binding':
      f.coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET binding_ref=? WHERE attempt_id=?')
        .run(
          'unrelated-sandbox-binding',
          scenario === 'conflicting predecessor binding'
            ? predecessor.attemptId
            : successor.attemptId
        );
      break;
  }
  await expect(
    f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor })
  ).resolves.toEqual({
    holds: [
      {
        sandboxRuntimeId: 'sandbox-held',
        holdRef: hold.executionId,
        revision: readExecutionJournalRoot(f.coreDb, hold).revision,
        reason: 'worker_release_incompatible',
        repairable: reason === null,
        repairBlockedReason: reason,
        correctiveAction: reason
          ? 'inspect-original-refusal-order'
          : 'activate-compatible-worker-image-and-repair',
      },
    ],
    incomplete: false,
    nextCursor: null,
  });
});

/** Compares the full public projection of the exact hold under test. */
function projectedSandboxHold(
  coreDb: CoreDb,
  hold: ExecutionJournalRef,
  status: 'eligible' | 'repairing' | 'conflicting'
) {
  return {
    sandboxRuntimeId: 'sandbox-held',
    holdRef: hold.executionId,
    revision: readExecutionJournalRoot(coreDb, hold).revision,
    reason: 'worker_release_incompatible',
    repairable: status === 'eligible',
    repairBlockedReason: status === 'conflicting' ? 'original-refusal-conflicting' : null,
    correctiveAction: {
      eligible: 'activate-compatible-worker-image-and-repair',
      repairing: 'await-exact-release',
      conflicting: 'inspect-original-refusal-order',
    }[status],
  };
}

it.each(['missing', 'foreign'] as const)(
  'keeps the pending exact Sandbox repair visible until its Core handoff with %s release output',
  async (evidence) => {
    const f = await fixture();
    const { hold, original, successor } = recordSandboxHold(
      f.coreDb,
      'sandbox-held',
      'binding',
      EPOCH
    );
    recordSandboxRepair(f.coreDb, hold);
    const read = () =>
      f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor });
    await expect(read()).resolves.toEqual({
      holds: [projectedSandboxHold(f.coreDb, hold, 'repairing')],
      incomplete: false,
      nextCursor: null,
    });
    recordSandboxHandoff(f.coreDb, successor.attemptId, hold.executionId);
    setSandboxHandoffFence(
      f.coreDb,
      successor.attemptId,
      evidence === 'missing' ? null : original.executionId
    );
    await expect(read()).resolves.toEqual({
      holds: [projectedSandboxHold(f.coreDb, hold, 'conflicting')],
      incomplete: false,
      nextCursor: null,
    });
    setSandboxHandoffFence(f.coreDb, successor.attemptId, hold.executionId);
    await expect(read()).resolves.toEqual({ holds: [], incomplete: false, nextCursor: null });
  }
);

it.each([1, 2])('recommends repair after %i exact deliberate handoffs', async (count) => {
  const f = await fixture();
  const { hold } = recordSandboxHold(f.coreDb, 'sandbox-held', 'binding', 'a'.repeat(64), {
    intervening: Array.from({ length: count }, () => 'repaired' as const),
  });
  await expect(
    f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor })
  ).resolves.toEqual({
    holds: [projectedSandboxHold(f.coreDb, hold, 'eligible')],
    incomplete: false,
    nextCursor: null,
  });
});

describe.each(['intermediate', 'visible'] as const)('%s Sandbox repair identity', (position) => {
  it.each([
    'hold reference',
    'extra hold reference',
    'RuntimeTarget ID',
    'RuntimeTarget backend',
    'RuntimeTarget allocation',
    'origin Epoch',
    'extra origin Epoch',
  ] as const)('rejects a contradictory %s', async (field) => {
    const f = await fixture();
    const { original, intermediate, hold } = recordSandboxHold(
      f.coreDb,
      'sandbox-held',
      'binding',
      'a'.repeat(64),
      { intervening: position === 'intermediate' ? ['repaired'] : [] }
    );
    const repairedHold = position === 'intermediate' ? intermediate[0]!.order : hold;
    const { control } = readExecutionJournalInvocation(f.coreDb, {
      execution: repairedHold,
      stepId: 'fence',
    });
    f.coreDb.sqlite
      .prepare("DELETE FROM control_execution_steps WHERE execution_id=? AND step_id='repair'")
      .run(repairedHold.executionId);
    const overrides = {
      'hold reference': { inputRefs: [original.executionId] },
      'extra hold reference': { inputRefs: [repairedHold.executionId, original.executionId] },
      'RuntimeTarget ID': { target: { targetId: 'foreign-target' } },
      'RuntimeTarget backend': { target: { backendKind: 'foreign-backend' } },
      'RuntimeTarget allocation': { target: { allocationRef: 'foreign-allocation' } },
      'origin Epoch': { physicalFenceRefs: ['f'.repeat(64)] },
      'extra origin Epoch': { physicalFenceRefs: [...control.physicalFenceRefs, 'f'.repeat(64)] },
    }[field];
    recordSandboxRepair(f.coreDb, repairedHold, overrides);

    const result = f.invoke(
      'administration.sandbox-hold-read',
      {},
      { kind: 'public', actor: f.actor }
    );
    if (position === 'intermediate') {
      await expect(result).resolves.toEqual({
        holds: [projectedSandboxHold(f.coreDb, hold, 'conflicting')],
        incomplete: false,
        nextCursor: null,
      });
    } else {
      await expect(result).rejects.toMatchObject({
        status: 503,
        code: 'administrator_cleanup_unavailable',
      });
    }
  });
});

it.each([
  'released without repair',
  'released with repair under another root',
  'released with repair for another attempt',
  'released with repair for another binding',
  'released with a non-administrator repair actor',
  'repair intent without release',
  'release names another fence',
  'earlier repair unproved',
  'second automatic order claimed as original',
  'malformed original after repair',
  'foreign original after repair',
  'different admission after repair',
  'contradictory original reference',
  'competing attempt after hold',
] as const)('refuses a contradictory Sandbox repair lineage: %s', async (scenario) => {
  const f = await fixture();
  const originalReference =
    scenario === 'foreign original after repair'
      ? recordSandboxHold(f.coreDb, 'sandbox-foreign', 'foreign', 'b'.repeat(64)).original
          .executionId
      : scenario === 'contradictory original reference'
        ? `sandbox-release-refusal:${commandInputHash([
            CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION,
            'target_cleanup',
            'a'.repeat(64),
            'binding',
          ])}`
        : undefined;
  const { original, hold, intermediate, successor } = recordSandboxHold(
    f.coreDb,
    'sandbox-held',
    'binding',
    'a'.repeat(64),
    {
      intervening:
        scenario === 'second automatic order claimed as original'
          ? ['automatic']
          : scenario === 'earlier repair unproved'
            ? ['repaired', 'repaired']
            : ['repaired'],
      useInterveningOrder: scenario === 'second automatic order claimed as original',
      conflictOriginalOrder: scenario === 'malformed original after repair',
      competingAttempt: scenario === 'competing attempt after hold',
      ...(originalReference ? { originalReference } : {}),
    }
  );
  const [predecessor] = intermediate;
  const predecessorId = predecessor!.order.executionId;
  const deleteRepair = () =>
    f.coreDb.sqlite
      .prepare("DELETE FROM control_execution_steps WHERE execution_id=? AND step_id='repair'")
      .run(predecessorId);
  switch (scenario) {
    case 'released with repair under another root':
      recordSandboxRepair(f.coreDb, original, {
        attemptId: predecessor!.attempt.attemptId,
        bindingRef: predecessor!.attempt.bindingRef!,
      });
      deleteRepair();
      break;
    case 'released without repair':
    case 'earlier repair unproved':
      deleteRepair();
      break;
    case 'released with repair for another attempt':
      deleteRepair();
      recordSandboxRepair(f.coreDb, predecessor!.order, { attemptId: successor.attemptId });
      break;
    case 'released with repair for another binding':
      deleteRepair();
      recordSandboxRepair(f.coreDb, predecessor!.order, { bindingRef: 'foreign' });
      break;
    case 'released with a non-administrator repair actor':
      deleteRepair();
      recordSandboxRepair(f.coreDb, predecessor!.order, { systemActor: true });
      break;
    case 'repair intent without release':
    case 'release names another fence':
      setSandboxHandoffFence(
        f.coreDb,
        predecessor!.attempt.attemptId,
        scenario === 'repair intent without release' ? null : original.executionId
      );
      break;
    case 'different admission after repair': {
      // Model a contradictory retained admission reference. Restore normal checks before reading.
      const alternate = attempt(f.coreDb, 'alternate-admission');
      f.coreDb.sqlite.pragma('foreign_keys = OFF');
      try {
        f.coreDb.sqlite
          .prepare('UPDATE scheduler_execution_attempts SET queue_entry_id=? WHERE attempt_id=?')
          .run(alternate.queueEntryId, successor.attemptId);
      } finally {
        f.coreDb.sqlite.pragma('foreign_keys = ON');
      }
      break;
    }
  }
  const result = await f.invoke(
    'administration.sandbox-hold-read',
    {},
    { kind: 'public', actor: f.actor }
  );
  expect(result.holds.find(({ holdRef }) => holdRef === hold.executionId)).toEqual(
    projectedSandboxHold(f.coreDb, hold, 'conflicting')
  );
  if (scenario === 'repair intent without release' || scenario === 'release names another fence') {
    setSandboxHandoffFence(f.coreDb, predecessor!.attempt.attemptId, predecessorId);
    await expect(
      f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor })
    ).resolves.toEqual({
      holds: [projectedSandboxHold(f.coreDb, hold, 'eligible')],
      incomplete: false,
      nextCursor: null,
    });
  }
});

it.each(['contradictory admission', 'missing lifecycle steps'] as const)(
  'keeps the successor visible after a closed intermediate handoff with %s',
  async (evidence) => {
    const f = await fixture();
    const { hold, intermediate } = recordSandboxHold(f.coreDb, 'sandbox-held', 'binding', EPOCH, {
      intervening: ['repaired'],
    });
    const prior = intermediate[0]!;
    const read = () =>
      f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor });
    await expect(read()).resolves.toEqual({
      holds: [projectedSandboxHold(f.coreDb, hold, 'eligible')],
      incomplete: false,
      nextCursor: null,
    });

    if (evidence === 'contradictory admission') {
      const alternate = attempt(f.coreDb, 'alternate-admission');
      // Inject the same contradictory admission reference as the visible-attempt fixture.
      f.coreDb.sqlite.pragma('foreign_keys = OFF');
      try {
        f.coreDb.sqlite
          .prepare('UPDATE scheduler_execution_attempts SET queue_entry_id=? WHERE attempt_id=?')
          .run(alternate.queueEntryId, prior.attempt.attemptId);
      } finally {
        f.coreDb.sqlite.pragma('foreign_keys = ON');
      }
    } else {
      f.coreDb.sqlite
        .prepare('DELETE FROM control_execution_steps WHERE execution_id=?')
        .run(`scheduler-lifecycle:${prior.attempt.attemptId}`);
      expect(f.coreDb.sqlite.pragma('foreign_key_check')).toEqual([]);
    }
    expect(f.coreDb.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    await expect(read()).resolves.toEqual({
      holds: [prior.order, hold]
        .sort((a, b) => a.executionId.localeCompare(b.executionId))
        .map((reference) => projectedSandboxHold(f.coreDb, reference, 'conflicting')),
      incomplete: false,
      nextCursor: null,
    });
  }
);

it.each([
  'own fence',
  'own repair attempt',
  'own repair binding',
  'unavailable snapshot',
  'unavailable closed-handoff projection',
] as const)('refuses an unavailable Sandbox hold observation: %s', async (scenario) => {
  const f = await fixture();
  const { hold, predecessor } = recordSandboxHold(
    f.coreDb,
    'sandbox-held',
    'binding',
    'a'.repeat(64),
    {
      ...(scenario === 'own fence' ? { ownFenceSequence: 1 } : {}),
      ...(scenario === 'unavailable closed-handoff projection'
        ? { intervening: ['repaired'] }
        : {}),
    }
  );
  switch (scenario) {
    case 'own repair attempt':
      recordSandboxRepair(f.coreDb, hold, { attemptId: predecessor.attemptId });
      break;
    case 'own repair binding':
      recordSandboxRepair(f.coreDb, hold, { bindingRef: 'foreign' });
      break;
    case 'unavailable snapshot':
    case 'unavailable closed-handoff projection': {
      const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
      const selector =
        scenario === 'unavailable snapshot'
          ? 'SELECT root.id AS holdRef'
          : 'WHERE attempt.attempt_id = ?';
      vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql) => {
        if (sql.includes(selector))
          throw new Database.SqliteError('Core hold snapshot unavailable.', 'SQLITE_IOERR');
        return prepare(sql);
      });
      break;
    }
  }
  await expect(
    f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor })
  ).rejects.toMatchObject({ status: 503, code: 'administrator_cleanup_unavailable' });
});

it('pages past the 100th Sandbox hold without clearing any hold', async () => {
  const f = await fixture();
  const candidates = Array.from({ length: 111 }, (_, i) => {
    const sandboxRuntimeId = `held-${i}`;
    return {
      sandboxRuntimeId,
      ...recordSandboxHold(f.coreDb, sandboxRuntimeId, `binding-${i}`, EPOCH),
    };
  }).sort((a, b) => a.hold.executionId.localeCompare(b.hold.executionId));
  const expected = candidates.flatMap(({ hold, successor, sandboxRuntimeId }, index) => {
    if (index % 11 === 1) {
      recordSandboxRepair(f.coreDb, hold);
      recordSandboxHandoff(f.coreDb, successor.attemptId, hold.executionId);
      return [];
    }
    return [{ ...projectedSandboxHold(f.coreDb, hold, 'eligible'), sandboxRuntimeId }];
  });
  expect(expected).toHaveLength(101);
  const read = (input: { cursor?: string }) =>
    f.invoke('administration.sandbox-hold-read', input, { kind: 'public', actor: f.actor });
  const before = rows(f.coreDb.sqlite);
  const first = await read({});
  expect(first).toEqual({
    holds: expected.slice(0, 100),
    incomplete: true,
    nextCursor: expected[99]!.holdRef,
  });
  expect(rows(f.coreDb.sqlite)).toEqual(before);

  const second = await read({ cursor: first.nextCursor! });
  expect(second).toEqual({ holds: expected.slice(100), nextCursor: null, incomplete: false });
  expect(rows(f.coreDb.sqlite)).toEqual(before);
});

describe('administrator cleanup public operation composition', () => {
  it('reads all four admitted NanoHost sources and withholds them when that owner is unavailable', async () => {
    const f = await fixture();
    await populateRuntime(f, attempt(f.coreDb));
    const read = vi.spyOn(f.nanoHostCleanupOwner.value, 'read');
    const response = await f.json();
    expect(response.status).toBe(200);
    const ready = bounded(await response.json());
    const nativeSources = [
      'backend-session',
      'agent-session-binding',
      'sandbox-runtime',
      'worker-storage',
    ];
    expect(ready.items.map((item) => item.source)).toEqual(['execution-attempt', ...nativeSources]);
    expect(ready.items[1]).toMatchObject({ state: { physicalEpochRelation: 'same' } });
    expect(ready.items[3]).toMatchObject({ state: { physicalEpochRelation: 'same' } });
    expect(JSON.stringify(ready)).not.toContain(PRIVATE);
    expect(read).toHaveBeenCalledTimes(1);

    read.mockReturnValue({ state: 'unavailable', owner: 'nanohost', reason: 'missing' });
    const rejected = await f.json();
    expect(rejected.status).toBe(200);
    const held = bounded(await rejected.json());
    expect(held.incomplete).toBe(true);
    expect(held.items.map((item) => item.source)).toEqual(['execution-attempt']);
    for (const source of nativeSources) {
      expect(held.sources.find((entry) => entry.source === source)).toEqual({
        source,
        availability: 'unavailable',
        incomplete: true,
        reasons: ['source_unavailable'],
      });
    }
    expect(JSON.stringify(held)).not.toContain(TARGET);
  });

  it('returns complete empty seven-source coverage through native and JSON invocation', async () => {
    const f = await fixture();
    const native = bounded(await f.native());
    expect(native.items).toEqual([]);
    expect(native.sources).toEqual(
      SOURCES.map((source) => ({
        source,
        availability: 'available',
        incomplete: false,
        reasons: [],
      }))
    );
    expect(native.incomplete).toBe(false);
    const http = await f.json();
    expect(http.status).toBe(200);
    expect(http.headers.get('cache-control')).toBe('no-store');
    expect(bounded(await http.json())).toMatchObject({
      items: [],
      sources: native.sources,
      incomplete: false,
    });
  });

  it.each([
    null,
    [],
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    { maxEntries: 1 },
    { maxBytes: 1 },
    { now: CREATED },
  ])('refuses nonempty or nonobject input %j before source access', async (input) => {
    const f = await fixture();
    const coreRead = vi.spyOn(f.coreDb.sqlite, 'prepare');
    const nativeRead = vi.spyOn(f.nanoHostCleanupOwner.value, 'read');
    await expect(f.native(input)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(coreRead).not.toHaveBeenCalled();
    const http = await f.json(input);
    expect(http.status).toBe(400);
    expect(await http.json()).toMatchObject({ code: 'invalid_request' });
    expect(nativeRead).not.toHaveBeenCalled();
  });

  it('refuses caller-supplied authority before source access', async () => {
    const f = await fixture();
    const coreRead = vi.spyOn(f.coreDb.sqlite, 'prepare');
    const nativeRead = vi.spyOn(f.nanoHostCleanupOwner.value, 'read');
    await expect(
      f.native({ actor: 'usr_00000000-0000-7000-8000-000000000001' })
    ).rejects.toMatchObject({
      code: 'bound_input_conflict',
      status: 403,
    });
    expect(coreRead).not.toHaveBeenCalled();
    expect((await f.json({ actor: 'usr_00000000-0000-7000-8000-000000000001' })).status).toBe(403);
    expect(nativeRead).not.toHaveBeenCalled();
  });

  it('joins every real source, preserves waiting and unknown facts, and exposes no private payload', async () => {
    const f = await fixture();
    const { execution, storage, quarantinedId } = await populate(f);
    const result = bounded(await f.native());
    expect(result.items.map((item) => item.source)).toEqual(SOURCES);
    expect(result.incomplete).toBe(false);
    expect(result.items[0]).toMatchObject({
      source: 'workspace-deletion',
      target: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', requestId: REQUEST },
      state: { phase: 'requested', retainedStaging: false, cleanedAt: null },
      sourceUpdatedAt: null,
      evidence: { kind: 'unknown' },
    });
    expect(result.items[1]).toMatchObject({
      source: 'workspace-registry',
      target: { kind: 'workspace-registry', workspaceId: quarantinedId },
      state: {
        registryStatus: 'active',
        registryRevision: 1,
        quarantineCheck: 'database',
        retirement: null,
      },
    });
    expect(result.items[2]).toMatchObject({
      target: { attemptId: execution.attemptId },
      state: { phase: 'open', disposition: 'not_accepted' },
      evidence: { kind: 'unknown' },
    });
    expect(result.items[3]).toMatchObject({
      target: { attemptId: execution.attemptId },
      state: { state: 'materializing', workspaceHandoffState: 'pending', physicalCleanedAt: null },
      evidence: { kind: 'unknown' },
    });
    expect(result.items[6]).toMatchObject({
      target: { storageRef: storage.storageRef },
      state: { state: 'idle', revision: 1, purgedAt: null },
      evidence: { kind: 'unknown' },
    });
    for (const item of result.items) {
      expect(item.observedAt).toBe(result.observedAt);
      expect(item.nextInspection).toEqual({
        kind: 'source-record',
        sourceOwner: item.sourceOwner,
        target: item.target,
      });
    }
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toMatch(
      /stagingRelativePath|confirmation|preparationInput|backendSessionId|imageDigest|terminalCause|compatibilityKey/
    );
  });

  it.each(['workspace', 'workspace-readonly'] as const)(
    'denies the %s credential despite current Workspace ownership',
    async (scope) => {
      const f = await fixture();
      await populate(f);
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope,
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await expect(
        f.native(
          {},
          {
            kind: 'token',
            userId: 'usr_00000000-0000-7000-8000-000000000001',
            tokenId: token.tokenId,
            tokenScope: scope,
          }
        )
      ).rejects.toMatchObject({ status: 403 });
    }
  );

  it('rechecks the original credential on every invocation after revocation', async () => {
    const f = await fixture();
    await populate(f);
    bounded(await f.native());
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    await expect(f.native()).rejects.toMatchObject({ status: 403 });
    const http = await f.json();
    expect(http.status).toBe(403);
    expect(JSON.stringify(await http.json())).not.toContain('attempt_cleanup_operation');
  });

  it('denies the next read after the current administrator is disabled', async () => {
    const f = await fixture();
    await populate(f);
    bounded(await f.native());
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.actor.userId))();
    await expect(f.native()).rejects.toMatchObject({ status: 403 });
    const http = await f.json();
    expect(http.status).toBe(403);
    expect(JSON.stringify(await http.json())).not.toMatch(
      /ws_00000000-0000-7000-8000-000000000001|attempt_cleanup_operation/
    );
  });

  it.each(['worker', 'coordinator', 'bootstrap'] as const)(
    'refuses %s invocation before any source access',
    async (kind) => {
      const f = await fixture();
      const { execution } = await populate(f);
      const contexts = {
        worker: {
          kind: 'worker' as const,
          actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
          lineage: {
            workspaceId: execution.workspaceId,
            threadId: execution.threadId,
            turnId: execution.turnId,
            agentSessionId: execution.agentSessionId!,
            packageSnapshotId: execution.inputRef!,
          },
          requestId: REQUEST,
          bindings: {},
        },
        coordinator: {
          kind: 'coordinator' as const,
          actor: f.actor,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: execution.threadId,
          turnId: execution.turnId,
          goalId: 'goal_cleanup',
          requestId: REQUEST,
        },
        bootstrap: { kind: 'bootstrap' as const },
      };
      const sqlRead = vi.spyOn(f.coreDb.sqlite, 'prepare');
      const nativeRead = vi.spyOn(f.nanoHostCleanupOwner.value, 'read');
      const fileRead = vi.spyOn(fs, 'readFileSync');
      syncBuiltinESMExports();
      const error = await f
        .invoke(OPERATION, {}, contexts[kind])
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(OperationError);
      // These trusted entry families have different existing refusal classes; all must refuse before reads.
      expect([400, 401, 403]).toContain(error instanceof OperationError ? error.status : null);
      expect(sqlRead).not.toHaveBeenCalled();
      expect(nativeRead).not.toHaveBeenCalled();
      expect(fileRead).not.toHaveBeenCalled();
    }
  );

  it('denies publication when the administrator is revoked during a real source read', async () => {
    const f = await fixture();
    await populate(f);
    const prepare = f.nativeSqlite.prepare.bind(f.nativeSqlite);
    let revoked = false;
    vi.spyOn(f.nativeSqlite, 'prepare').mockImplementation((sql: string) => {
      if (!revoked && /\bFROM\s+worker_storage_bindings\b/i.test(sql)) {
        revoked = true;
        revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
      }
      return prepare(sql);
    });
    await expect(f.native()).rejects.toMatchObject({ status: 403 });
    expect(revoked).toBe(true);
  });

  it('returns a safe unavailable operation error when current authority storage is lost', async () => {
    const f = await fixture();
    await populate(f);
    const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
    vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('openkit_access_tokens')) {
        throw new Database.SqliteError('injected authority storage failure', 'SQLITE_ERROR');
      }
      return prepare(sql);
    });
    const http = await f.json();
    expect(http.status).toBe(503);
    const error = await http.json();
    expect(error).toMatchObject({ code: 'operation_storage_unavailable' });
    expect(JSON.stringify(error)).not.toMatch(
      /openkit_access_tokens|attempt_cleanup_operation|ws_00000000-0000-7000-8000-000000000001|SQLITE|injected authority storage failure/
    );
  });

  it('propagates an unclassified administrator-admission error to the existing HTTP error handler', async () => {
    const f = await fixture();
    const sentinel = new Error('unclassified-admission-canary');
    const observed = vi.fn();
    f.app.onError((error, context) => {
      observed(error);
      return context.text('Internal Server Error', 500);
    });
    vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation(() => {
      throw sentinel;
    });
    await expect(f.native()).rejects.toBe(sentinel);
    const http = await f.json();
    expect(http.status).toBe(500);
    expect(await http.text()).toBe('Internal Server Error');
    expect(observed).toHaveBeenCalledExactlyOnceWith(sentinel);
  });

  it('observes a deleting Workspace without opening its content gate or changing any source', async () => {
    const f = await fixture();
    const { request } = await populate(f);
    f.coreDb.sqlite.transaction(() =>
      beginWorkspaceDeletion({
        coreDb: f.coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        expectedRegistryRevision: 1,
      })
    )();
    // Deliberate partial owner facts exercise read-only unknown evidence; no producer emits this pair.
    writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'fenced' });
    writeFileSync(join(f.dataRoot, 'orphan-cleanup-canary'), PRIVATE);
    const beforeCoreRows = rows(f.coreDb.sqlite);
    const beforeNativeRows = rows(f.nativeSqlite);
    const beforeFiles = files(f.dataRoot);
    f.coreDb.sqlite.pragma('query_only = ON');
    const result = bounded(await f.native());
    expect(result.items).toHaveLength(7);
    expect(result.items[0]).toMatchObject({
      state: { phase: 'fenced' },
      evidence: { kind: 'unknown' },
    });
    await expect(
      f.invoke(
        'workspace.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          kind: 'public',
          actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        }
      )
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    expect(rows(f.coreDb.sqlite)).toEqual(beforeCoreRows);
    expect(rows(f.nativeSqlite)).toEqual(beforeNativeRows);
    expect(files(f.dataRoot)).toEqual(beforeFiles);
  });

  it.each(['workspace-deletion', 'backend-session'])(
    'preserves other sources when %s becomes unavailable',
    async (source) => {
      const f = await fixture();
      await populate(f);
      if (source === 'workspace-deletion') {
        const path = join(
          f.dataRoot,
          'server',
          'exports',
          'workspace-deletions',
          'ws_00000000-0000-7000-8000-000000000001',
          REQUEST,
          'request.json'
        );
        writeFileSync(path, PRIVATE);
      } else {
        const prepare = f.nativeSqlite.prepare.bind(f.nativeSqlite);
        vi.spyOn(f.nativeSqlite, 'prepare').mockImplementation((sql: string) => {
          if (sql.includes('worker_backend_sessions')) {
            throw new Database.SqliteError('unavailable_backend_sessions', 'SQLITE_ERROR');
          }
          return prepare(sql);
        });
      }
      const result = bounded(await f.native());
      expect(result.sources.find((entry) => entry.source === source)).toMatchObject({
        availability: 'unavailable',
        incomplete: true,
        reasons: ['source_unavailable'],
      });
      expect(result.items.some((entry) => entry.source === source)).toBe(false);
      expect(result.items.filter((entry) => entry.source !== source)).toHaveLength(6);
      expect(result.incomplete).toBe(true);
      expect(JSON.stringify(result)).not.toContain(PRIVATE);
      expect(JSON.stringify(result)).not.toContain('unavailable_backend_sessions');
    }
  );

  it('preserves contradictory and stale proof as unknown across the public boundary', async () => {
    const f = await fixture();
    const { execution } = await populate(f);
    seedNanoHost(f, (sqlite) =>
      sqlite
        .prepare('UPDATE worker_backend_sessions SET physical_cleaned_at = ? WHERE attempt_id = ?')
        .run(CREATED, execution.attemptId)
    );
    let result = bounded(await f.native());
    expect(result.items.find((entry) => entry.source === 'backend-session')).toMatchObject({
      state: { state: 'materializing', physicalCleanedAt: CREATED },
      evidence: { kind: 'unknown', reason: 'contradictory' },
    });
    await transitionTarget(f, {
      kind: 'close',
      targetId: TARGET,
      closedGeneration: 1,
      authoritativeGeneration: null,
      observedAt: CHANGED,
    });
    result = bounded(await f.native());
    expect(result.items.find((entry) => entry.source === 'sandbox-runtime')).toMatchObject({
      state: { physicalEpochRelation: 'unknown' },
      evidence: { kind: 'unknown', reason: 'stale' },
    });
    expect(result.incomplete).toBe(false);
  });

  it('applies one stable 100-item count bound across deletion and runtime sources', async () => {
    const f = await fixture();
    deletion(f);
    for (let index = 0; index < 102; index++)
      attempt(f.coreDb, `attempt_${String(index).padStart(3, '0')}`);
    const first = bounded(await f.native());
    const second = bounded(await f.native());
    expect(first.items).toHaveLength(100);
    expect(first.items[0]).toMatchObject({ source: 'workspace-deletion' });
    expect(first.items.slice(1).map((item) => item.target)).toEqual(
      second.items.slice(1).map((item) => item.target)
    );
    expect(first.items.slice(1).map((item) => item.target)).toEqual(
      Array.from({ length: 102 }, (_, index) =>
        testEntityId('attempt', `attempt_${String(index).padStart(3, '0')}`)
      )
        .sort()
        .slice(0, 99)
        .map((attemptId) => expect.objectContaining({ attemptId }))
    );
    expect(first.sources[2]).toMatchObject({
      incomplete: true,
      reasons: expect.arrayContaining(['count_limit']),
    });
    expect(first.incomplete).toBe(true);
  });

  it('bounds canonical deletion request reads and preserves a stable 100-item prefix', async () => {
    const f = await fixture();
    const requests = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    );
    for (const requestId of requests) {
      const request = deletion(f, requestId);
      writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'blocked' });
    }
    attempt(f.coreDb);
    const fileRead = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    const canonicalRoot = join(
      f.dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      'ws_00000000-0000-7000-8000-000000000001'
    );
    const canonicalReadPaths = () =>
      fileRead.mock.calls
        .map(([path]) => String(path))
        .filter((path) => path.startsWith(`${canonicalRoot}/`) && path.endsWith('/request.json'));
    const first = bounded(await f.native());
    expect(first.items).toHaveLength(100);
    expect(first.items.every((item) => item.source === 'workspace-deletion')).toBe(true);
    expect(
      first.items.map((item) =>
        item.source === 'workspace-deletion' ? item.target.requestId : null
      )
    ).toEqual(requests.slice(0, 100));
    const firstPaths = canonicalReadPaths();
    expect(firstPaths.length).toBeGreaterThanOrEqual(100);
    expect(firstPaths.length).toBeLessThanOrEqual(101);
    expect(first.sources[0]).toMatchObject({
      availability: 'available',
      incomplete: true,
      reasons: expect.arrayContaining(['count_limit']),
    });
    for (const source of first.sources.slice(1)) {
      expect(source).toMatchObject({
        availability: 'unavailable',
        incomplete: true,
        reasons: expect.arrayContaining(['count_limit', 'source_unavailable']),
      });
    }
    fileRead.mockClear();
    const second = bounded(await f.native());
    expect(second.items.map((item) => item.target)).toEqual(first.items.map((item) => item.target));
    expect(canonicalReadPaths()).toEqual(firstPaths);
    expect(first.incomplete).toBe(true);
  });

  it.each(['missing', 'invalid'] as const)(
    'withholds deletion identifiers when the current Workspace registry is %s',
    async (state) => {
      const f = await fixture();
      deletion(f);
      if (state === 'missing')
        f.coreDb.sqlite
          .prepare(
            "DELETE FROM workspace_registry WHERE workspace_id = 'ws_00000000-0000-7000-8000-000000000001'"
          )
          .run();
      else {
        // Model a corrupted retained registry row; restore constraint enforcement before the public read.
        f.coreDb.sqlite.pragma('ignore_check_constraints = ON');
        f.coreDb.sqlite
          .prepare(
            "UPDATE workspace_registry SET status = ? WHERE workspace_id = 'ws_00000000-0000-7000-8000-000000000001'"
          )
          .run(PRIVATE);
        f.coreDb.sqlite.pragma('ignore_check_constraints = OFF');
      }
      const result = bounded(await f.native());
      expect(result.items).toEqual([]);
      expect(result.sources[0]).toMatchObject({
        availability: 'unavailable',
        incomplete: true,
        reasons: expect.arrayContaining(['source_unavailable']),
      });
      expect(result.incomplete).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(
        /ws_00000000-0000-7000-8000-000000000001|00000000-0000-4000-8000-000000000226|private-cleanup-operation-canary/
      );
    }
  );

  it('counts UTF-8 bytes on the complete seven-source response and preserves bounded native identities intact', async () => {
    const f = await fixture();
    deletion(f);
    const ids = Array.from(
      { length: 96 },
      (_, index) => `sandbox_${String(index).padStart(3, '0')}_${'界'.repeat(470)}`
    );
    await readyTarget(f);
    for (const id of ids) await sandbox(f, id);

    const result = bounded(await f.native());
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(262144);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(serialized.length);
    expect(result.items[0]?.source).toBe('workspace-deletion');
    const runtimes = result.items.filter((item) => item.source === 'sandbox-runtime');
    expect(runtimes.length).toBeGreaterThan(0);
    expect(runtimes.length).toBeLessThan(ids.length);
    for (const item of runtimes) {
      expect(item.target.kind).toBe('sandbox-runtime');
      if (item.target.kind === 'sandbox-runtime') {
        expect(ids).toContain(item.target.sandboxRuntimeId);
      }
    }
    expect(result.sources[5]).toMatchObject({
      incomplete: true,
      reasons: expect.arrayContaining(['byte_limit']),
    });
    expect(result.sources.flatMap((source) => source.reasons)).not.toContain('count_limit');
    expect(result.incomplete).toBe(true);
  });

  it('retains complete native runtime items when the complete response fits its byte ceiling', async () => {
    const f = await fixture();
    deletion(f);
    const ids = Array.from(
      { length: 4 },
      (_, index) => `sandbox_${String(index).padStart(3, '0')}_${'界'.repeat(470)}`
    );
    await readyTarget(f);
    for (const id of ids) await sandbox(f, id);

    const result = bounded(await f.native());
    expect(result.items).toHaveLength(ids.length + 1);
    expect(result.items.slice(1).map((item) => item.target)).toEqual(
      ids.map((sandboxRuntimeId) => ({
        kind: 'sandbox-runtime',
        sandboxRuntimeId,
        runtimeTargetId: TARGET,
      }))
    );
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(262144);
    expect(result.sources.every((source) => source.reasons.length === 0)).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it('preserves coherent current owner facts during a concurrent source transition', async () => {
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    snapshotNativeInterception.gate = gate.buffer as SharedArrayBuffer;
    const f = await fixture();
    const { execution } = await populate(f);
    const writer = await bindNanoHostWriter(f);
    const concurrent = new Database(f.nativeSqlite.name, { fileMustExist: true, readonly: true });
    f.coreDb.sqlite.pragma('query_only = ON');
    const prepare = f.nativeSqlite.prepare.bind(f.nativeSqlite);
    let committedBeforeReaderResumed = false;
    let transition: ReturnType<typeof writer.backendSession> | undefined;
    try {
      const fault = vi.spyOn(f.nativeSqlite, 'prepare').mockImplementation((sql: string) => {
        if (!transition && /\bFROM\s+agent_session_runtime_bindings\b/i.test(sql)) {
          // The reader has already observed the original backend row in its Native snapshot.
          transition = writer.backendSession({
            kind: 'transition',
            attemptId: execution.attemptId,
            fromState: 'materializing',
            toState: 'cleanup-pending',
            observedAt: CHANGED,
          });
          const wait = Atomics.wait(gate, 0, 0, 5000);
          const committed = getWorkerBackendSession({ sqlite: concurrent }, execution.attemptId);
          committedBeforeReaderResumed =
            wait !== 'timed-out' &&
            Atomics.load(gate, 0) === 1 &&
            Atomics.load(gate, 1) === 2 &&
            f.coreDb.sqlite.inTransaction &&
            f.nativeSqlite.inTransaction &&
            committed?.state === 'cleanup-pending' &&
            committed.updatedAt === CHANGED;
        }
        return prepare(sql);
      });
      const result = bounded(await f.native());
      expect(committedBeforeReaderResumed).toBe(true);
      expect(result.items.find((item) => item.source === 'backend-session')).toMatchObject({
        sourceUpdatedAt: CREATED,
        state: { state: 'materializing' },
        evidence: { kind: 'unknown' },
      });
      fault.mockRestore();
      await transition;
      expect(
        bounded(await f.native()).items.find((item) => item.source === 'backend-session')
      ).toMatchObject({ sourceUpdatedAt: CHANGED, state: { state: 'cleanup-pending' } });
    } finally {
      concurrent.close();
      await transition;
    }
  });

  it('keeps truthful uncertainty when a canonical deletion request is replaced during its read', async () => {
    const f = await fixture();
    const request = deletion(f);
    const path = join(
      f.dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      'ws_00000000-0000-7000-8000-000000000001',
      REQUEST,
      'request.json'
    );
    const beforeRows = rows(f.coreDb.sqlite);
    const beforeFiles = files(f.dataRoot);
    const read = fs.readFileSync;
    let replaced = false;
    const fault = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((...args: Parameters<typeof read>) => {
        const value = read(...args);
        if (!replaced && String(args[0]) === path) {
          replaced = true;
          writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'blocked' });
        }
        return value;
      });
    syncBuiltinESMExports();
    const result = bounded(await f.native());
    expect(replaced).toBe(true);
    fault.mockRestore();
    syncBuiltinESMExports();
    const item = result.items.find((entry) => entry.source === 'workspace-deletion');
    if (item?.source === 'workspace-deletion') {
      expect(['requested', 'blocked']).toContain(item.state.phase);
      expect(item.state).toMatchObject({ retainedStaging: false, cleanedAt: null });
      expect(item.evidence.kind).toBe('unknown');
    } else
      expect(result.sources[0]).toMatchObject({
        incomplete: true,
        reasons: expect.arrayContaining(['source_changed']),
      });
    expect(
      readWorkspaceDeletionRequest(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001', REQUEST)
        .phase
    ).toBe('blocked');
    expect(rows(f.coreDb.sqlite)).toEqual(beforeRows);
    const afterFiles = files(f.dataRoot);
    expect(afterFiles.map(([name]) => name)).toEqual(beforeFiles.map(([name]) => name));
    expect(
      afterFiles
        .filter(([, digest], index) => digest !== beforeFiles[index]?.[1])
        .map(([name]) => name)
    ).toEqual([relative(f.dataRoot, path)]);
  });

  it('reads current deletion and runtime records after reopening Core and NanoHost storage', async () => {
    const f = await fixture();
    const { request, execution } = await populate(f);
    bounded(await f.native());
    await shutdownControlStoreWorkerClient();
    expect(f.nativeSqlite.open).toBe(false);
    f.coreDb.sqlite.close();
    f.coreDb = openCoreDb(f.dataRoot);
    fixtures[fixtures.length - 1]!.coreDb = f.coreDb;
    const reopened = await bindNanoHostWriter(f);
    writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'blocked' });
    await reopened.backendSession({
      kind: 'transition',
      attemptId: execution.attemptId,
      fromState: 'materializing',
      toState: 'cleanup-pending',
      observedAt: CHANGED,
    });
    const invoke = createOperationInvocation({
      ...f,
      nanoHostCleanupOwner: { state: 'ready', value: reopened },
    });
    const result = bounded(await invoke(OPERATION, {}, { kind: 'public', actor: f.actor }));
    expect(result.items[0]).toMatchObject({ state: { phase: 'blocked' } });
    expect(result.items.find((item) => item.source === 'backend-session')).toMatchObject({
      sourceUpdatedAt: CHANGED,
      state: { state: 'cleanup-pending' },
    });
    expect(
      readWorkspaceDeletionRequest(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001', REQUEST)
        .phase
    ).toBe('blocked');
  });

  it('uses the same real JSON operation through generated CLI and eligible remote MCP', async () => {
    const f = await fixture();
    await populate(f);
    // The read-only round trip needs no simulated Worker image or model setup.
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      nanoHostStorage: f.nanoHostStorage,
      mode: 'server',
    });
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      headers: { authorization: `Bearer ${f.token.secret}` },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const { operationCatalog } = await import(
      new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
    );
    const operation = operationCatalog.find((entry: { id: string }) => entry.id === OPERATION);
    expect(operation).toBeDefined();
    expect(
      bounded(await operation.handler({ client }, operation.inputSchema.parse({}))).items.map(
        (item) => item.source
      )
    ).toEqual(SOURCES);
    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${f.token.secret}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'openkit_read', arguments: { operation: OPERATION, input: {} } },
      }),
    });
    expect(response.status).toBe(200);
    const message = await response.json();
    expect(message.error).toBeUndefined();
    expect(message.result.isError).not.toBe(true);
    expect(
      bounded(JSON.parse(message.result.content[0].text)).items.map((item) => item.source)
    ).toEqual(SOURCES);
  });
});
