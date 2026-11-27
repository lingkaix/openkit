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
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { createOperationInvocation } from './operation-composition.js';
import { OperationError } from './operation-error.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { localCoreJournalIntent } from './runtime/core-journal-records.js';
import {
  CORE_SANDBOX_RELEASE_REFUSAL_DEFINITION,
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
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import {
  getWorkerBackendSession,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import { createWorkerStorageBinding as createLegacyWorkerStorageBinding } from './runtime/worker-storage-binding-records.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from './scheduler-records.js';
import { commandInputHash } from './storage/control-store-input.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { verifyAndMigrateExistingScopedDatabases } from './storage/workspace-storage-migration.js';
import { createApp } from './test-support/app.js';
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

// The reader stays synchronous. This test-only prelude gates the real native owner,
// then signals only after its actual SQLite COMMIT returns.
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
              if (value.operation === 'backend-session' && value.input.kind === 'transition' &&
                  Atomics.compareExchange(gate, 0, 1, 0) === 1) {
                crossing = true;
                Atomics.store(gate, 1, 1);
                Atomics.notify(gate, 1);
                if (Atomics.wait(gate, 2, 0, 10000) === 'timed-out') {
                  throw new Error('Snapshot owner transition was not released.');
                }
              }
            });
            Database.prototype.exec = function(sql) {
              const result = originalExec.call(this, sql);
              if (crossing && /^COMMIT$/i.test(sql)) {
                crossing = false;
                Atomics.store(gate, 4, this.pragma('synchronous', {simple: true}));
                Atomics.store(gate, 3, 1);
                Atomics.notify(gate, 3);
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
  const dependencies = {
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
  return { ...dependencies, token, actor, invoke, native, json, app };
}

/** Creates the deletion owner's durable request without advancing deletion. */
function deletion(f: ReturnType<typeof fixture>, requestId = REQUEST) {
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

/** Creates a native Sandbox identity to exercise complete UTF-8 response bounds without invalid Core IDs. */
async function sandbox(coreDb: CoreDb, id: string): Promise<void> {
  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: testEntityId('dep', 'deployment_cleanup'),
    identityId: 'identity_cleanup',
    targetId: 'target_cleanup',
    observedAt: CREATED,
  });
  await upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: CREATED,
  });
  await createNanoHostHarnessRuntime(coreDb, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: `harness_${id}`,
    harnessBindingRef: `harness_binding_${id}`,
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: 'a'.repeat(64),
    sandboxBindingRef: `sandbox_binding_${id}`,
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: `integration_${id}`,
    sandboxRuntimeId: id,
    runtimeTargetId: 'target_cleanup',
    timestamp: CREATED,
  });
}

/** Populates all seven source families through their retained record producers and real scope admission. */
async function populate(f: ReturnType<typeof fixture>) {
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
  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(f.coreDb, {
    deploymentId: testEntityId('dep', 'deployment_cleanup'),
    identityId: 'identity_cleanup',
    targetId: 'target_cleanup',
    observedAt: CREATED,
  });
  await upsertNanoHostRuntimeTarget(f.coreDb, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: CREATED,
  });
  await recordWorkerBackendSessionMaterializing(f.coreDb, {
    identity: {
      agentSessionId: execution.agentSessionId!,
      backendKind: 'openshell',
      backendSessionId: PRIVATE,
      deploymentId: testEntityId('dep', 'deployment_cleanup'),
      packageSnapshotId: execution.inputRef!,
      runtimeTargetId: 'target_cleanup',
      stagingDirectoryRef: `server/runtime/${PRIVATE}`,
      transientProviderInstanceId: null,
    },
    backendVersion: null,
    lineage: {
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
    },
    backendLineage: { kind: 'reference', imageRef: `registry.example/${PRIVATE}` },
    sandboxBindingRef: execution.bindingRef!,
    now: () => CREATED,
  });
  await createNanoHostHarnessRuntime(f.coreDb, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: 'harness_cleanup',
    harnessBindingRef: 'harness_binding_cleanup',
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: 'a'.repeat(64),
    sandboxBindingRef: 'sandbox_binding_cleanup',
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: 'integration_cleanup',
    sandboxRuntimeId: 'sandbox_cleanup',
    runtimeTargetId: 'target_cleanup',
    timestamp: CREATED,
  });
  await openNanoHostAgentSessionBinding(f.coreDb, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: execution.agentSessionId!,
    agentSessionRuntimeBindingId: 'binding_cleanup',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'harness_cleanup',
    threadId: execution.threadId,
    workspaceId: execution.workspaceId,
    timestamp: CREATED,
  });
  await shutdownControlStoreWorkerClient();
  // Retained pre-admission idle records have no contributors; this isolated fixture has no live writer.
  const storage = createLegacyWorkerStorageBinding(f.coreDb, {
    deploymentId: testEntityId('dep', 'deployment_cleanup'),
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
    runtimeTargetId: 'target_cleanup',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  return { request, execution, storage, quarantinedId };
}

/** Captures every Core table so a read cannot silently mutate a different lifecycle owner. */
function rows(coreDb: CoreDb) {
  const tables = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return tables.map(({ name }) => ({
    name,
    rows: coreDb.sqlite
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
      .all(),
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
  coreDb.sqlite
    .prepare(`UPDATE scheduler_execution_attempts
      SET phase='closed', terminal_cause='sandbox-release-refusal', fence_ref=?
      WHERE attempt_id=?`)
    .run(orderId, attemptId);
  coreDb.sqlite
    .prepare(`UPDATE scheduler_admission_entries SET status='queued'
      WHERE queue_entry_id=(SELECT queue_entry_id FROM scheduler_execution_attempts WHERE attempt_id=?)`)
    .run(attemptId);
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
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase='closing', fence_ref=NULL WHERE attempt_id=?"
        )
        .run(successor.attemptId);
    }
    return { original, hold, predecessor, successor, intermediate };
  })();
}

it('discovers the exact Sandbox hold from Core after the Native resident is gone', async () => {
  const f = await fixture();
  const id = 'administration.sandbox-hold-read';
  const sandboxRuntimeId = 'sandbox-held';
  const targetId = 'target_cleanup';
  const oldEpoch = 'a'.repeat(64);
  const oldBinding = `sandbox_binding_${sandboxRuntimeId}`;
  await sandbox(f.coreDb, sandboxRuntimeId);
  const { hold } = recordSandboxHold(f.coreDb, sandboxRuntimeId, oldBinding, oldEpoch, {
    intervening: ['repaired'],
  });
  const expected = {
    sandboxRuntimeId,
    holdRef: hold.executionId,
    revision: readExecutionJournalRoot(f.coreDb, hold).revision,
    reason: 'worker_release_incompatible',
    repairable: true,
    repairBlockedReason: null,
    correctiveAction: 'activate-compatible-worker-image-and-repair',
  };
  await expect(f.invoke(id, {}, { kind: 'public', actor: f.actor })).resolves.toEqual({
    holds: [expected],
    incomplete: false,
    nextCursor: null,
  });
  const response = await f.app.request(`/api/app/operations/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  expect(payload).toEqual({ holds: [expected], incomplete: false, nextCursor: null });

  // Model the acknowledged fresh-empty epoch after the old resident has been removed.
  await removeNanoHostSandboxRuntimeByBinding(f.coreDb, oldBinding);
  const generation = await allocateNanoHostRuntimeTargetConnectionGeneration(f.coreDb, {
    deploymentId: testEntityId('dep', 'deployment_cleanup'),
    identityId: 'identity_cleanup',
    targetId,
    observedAt: CHANGED,
  });
  await upsertNanoHostRuntimeTarget(f.coreDb, {
    ...generation,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: 'c'.repeat(64),
    observedAt: CHANGED,
  });
  await shutdownControlStoreWorkerClient();
  f.coreDb.sqlite.close();
  const cold = openCoreDb(f.dataRoot);
  fixtures.push({ coreDb: cold, dataRoot: f.dataRoot });
  expect(
    cold.sqlite.prepare('SELECT sandbox_runtime_id FROM sandbox_runtime_records').all()
  ).toEqual([]);
  const invoke = createOperationInvocation({ ...f, coreDb: cold });
  const before = rows(cold);
  const beforeFiles = files(f.dataRoot);
  await expect(invoke(id, {}, { kind: 'public', actor: f.actor })).resolves.toEqual({
    holds: [expected],
    incomplete: false,
    nextCursor: null,
  });
  expect(rows(cold)).toEqual(before);
  expect(files(f.dataRoot)).toEqual(beforeFiles);

  // A later resident can reuse the runtime ID. Its binding and epoch cannot retarget the hold.
  await createNanoHostHarnessRuntime(cold, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: 'replacement-harness',
    harnessBindingRef: 'replacement-harness-binding',
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: 'c'.repeat(64),
    sandboxBindingRef: 'replacement-sandbox-binding',
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: 'replacement-integration',
    sandboxRuntimeId,
    runtimeTargetId: targetId,
    timestamp: CHANGED,
  });
  const reused = rows(cold);
  const reusedFiles = files(f.dataRoot);
  await expect(invoke(id, {}, { kind: 'public', actor: f.actor })).resolves.toEqual({
    holds: [expected],
    incomplete: false,
    nextCursor: null,
  });
  expect(rows(cold)).toEqual(reused);
  expect(files(f.dataRoot)).toEqual(reusedFiles);
  await expect(
    invoke(
      id,
      {},
      {
        kind: 'public',
        actor: { kind: 'session', userId: f.actor.userId },
      }
    )
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

it('keeps the pending exact Sandbox repair visible until its Core handoff', async () => {
  const f = await fixture();
  const { hold, successor } = recordSandboxHold(
    f.coreDb,
    'sandbox-held',
    'binding',
    'a'.repeat(64)
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
  await expect(read()).resolves.toEqual({ holds: [], incomplete: false, nextCursor: null });
});

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
      f.coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET fence_ref=? WHERE attempt_id=?')
        .run(
          scenario === 'repair intent without release' ? null : original.executionId,
          predecessor!.attempt.attemptId
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
});

it.each(['own fence', 'own repair attempt', 'own repair binding', 'unavailable snapshot'] as const)(
  'refuses an unavailable Sandbox hold observation: %s',
  async (scenario) => {
    const f = await fixture();
    const { hold, predecessor } = recordSandboxHold(
      f.coreDb,
      'sandbox-held',
      'binding',
      'a'.repeat(64),
      {
        ...(scenario === 'own fence' ? { ownFenceSequence: 1 } : {}),
      }
    );
    switch (scenario) {
      case 'own repair attempt':
        recordSandboxRepair(f.coreDb, hold, { attemptId: predecessor.attemptId });
        break;
      case 'own repair binding':
        recordSandboxRepair(f.coreDb, hold, { bindingRef: 'foreign' });
        break;
      case 'unavailable snapshot': {
        const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
        vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql) => {
          if (sql.includes('SELECT root.id AS holdRef'))
            throw new Database.SqliteError('Core hold snapshot unavailable.', 'SQLITE_IOERR');
          return prepare(sql);
        });
        break;
      }
    }
    await expect(
      f.invoke('administration.sandbox-hold-read', {}, { kind: 'public', actor: f.actor })
    ).rejects.toMatchObject({ status: 503, code: 'administrator_cleanup_unavailable' });
  }
);

it('pages past the 100th Sandbox hold without clearing any hold', async () => {
  const f = await fixture();
  const expected = Array.from({ length: 101 }, (_, i) => {
    const sandboxRuntimeId = `held-${i}`;
    const { hold } = recordSandboxHold(f.coreDb, sandboxRuntimeId, `binding-${i}`, 'a'.repeat(64));
    return { ...projectedSandboxHold(f.coreDb, hold, 'eligible'), sandboxRuntimeId };
  }).sort((a, b) => (a.holdRef < b.holdRef ? -1 : 1));
  const read = (input: { cursor?: string }) =>
    f.invoke('administration.sandbox-hold-read', input, { kind: 'public', actor: f.actor });
  const before = rows(f.coreDb);
  const first = await read({});
  expect(first).toEqual({
    holds: expected.slice(0, 100),
    incomplete: true,
    nextCursor: expected[99]!.holdRef,
  });

  const second = await read({ cursor: first.nextCursor! });
  expect(second).toEqual({ holds: expected.slice(100), nextCursor: null, incomplete: false });
  expect(rows(f.coreDb)).toEqual(before);
});

describe('administrator cleanup public operation composition', () => {
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
    const read = vi.spyOn(f.coreDb.sqlite, 'prepare');
    await expect(f.native(input)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(read).not.toHaveBeenCalled();
    const http = await f.json(input);
    expect(http.status).toBe(400);
    expect(await http.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('refuses caller-supplied authority before source access', async () => {
    const f = await fixture();
    const read = vi.spyOn(f.coreDb.sqlite, 'prepare');
    await expect(
      f.native({ actor: 'usr_00000000-0000-7000-8000-000000000001' })
    ).rejects.toMatchObject({
      code: 'bound_input_conflict',
      status: 403,
    });
    expect(read).not.toHaveBeenCalled();
    expect((await f.json({ actor: 'usr_00000000-0000-7000-8000-000000000001' })).status).toBe(403);
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
      const fileRead = vi.spyOn(fs, 'readFileSync');
      syncBuiltinESMExports();
      const error = await f
        .invoke(OPERATION, {}, contexts[kind])
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(OperationError);
      // These trusted entry families have different existing refusal classes; all must refuse before reads.
      expect([400, 401, 403]).toContain(error instanceof OperationError ? error.status : null);
      expect(sqlRead).not.toHaveBeenCalled();
      expect(fileRead).not.toHaveBeenCalled();
    }
  );

  it('denies publication when the administrator is revoked during a real source read', async () => {
    const f = await fixture();
    await populate(f);
    const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
    let revoked = false;
    vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
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
    const beforeRows = rows(f.coreDb);
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
    expect(rows(f.coreDb)).toEqual(beforeRows);
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
        const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
        vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
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
    await populate(f);
    f.coreDb.sqlite
      .prepare('UPDATE worker_backend_sessions SET physical_cleaned_at = ?')
      .run(CREATED);
    let result = bounded(await f.native());
    expect(result.items.find((entry) => entry.source === 'backend-session')).toMatchObject({
      state: { state: 'materializing', physicalCleanedAt: CREATED },
      evidence: { kind: 'unknown', reason: 'contradictory' },
    });
    await recordNanoHostRuntimeTargetConnectionClose(f.coreDb, {
      targetId: 'target_cleanup',
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
    for (const id of ids) await sandbox(f.coreDb, id);

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
    for (const id of ids) await sandbox(f.coreDb, id);

    const result = bounded(await f.native());
    expect(result.items).toHaveLength(ids.length + 1);
    expect(result.items.slice(1).map((item) => item.target)).toEqual(
      ids.map((sandboxRuntimeId) => ({
        kind: 'sandbox-runtime',
        sandboxRuntimeId,
        runtimeTargetId: 'target_cleanup',
      }))
    );
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(262144);
    expect(result.sources.every((source) => source.reasons.length === 0)).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it('preserves coherent current owner facts during a concurrent source transition', async () => {
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5));
    snapshotNativeInterception.gate = gate.buffer as SharedArrayBuffer;
    const f = await fixture();
    const { execution } = await populate(f);
    const concurrent = openCoreDb(f.dataRoot);
    concurrent.sqlite.pragma('query_only = ON');
    f.coreDb.sqlite.pragma('query_only = ON');
    const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
    let changed = false;
    let committedBeforeReaderResumed = false;
    let transition: ReturnType<typeof transitionWorkerBackendSessionState> | undefined;
    try {
      Atomics.store(gate, 0, 1);
      transition = transitionWorkerBackendSessionState(concurrent, {
        attemptId: execution.attemptId,
        fromState: 'materializing',
        toState: 'cleanup-pending',
        now: () => CHANGED,
      });
      await vi.waitFor(() => expect(Atomics.load(gate, 1)).toBe(1), {
        timeout: 5000,
        interval: 5,
      });
      const fault = vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
        if (!changed && /\bFROM\s+scheduler_execution_attempts\b/i.test(sql)) {
          changed = true;
          // Release the actual writer at the original source-read seam and do not let
          // this synchronous snapshot continue until its FULL commit is observed.
          Atomics.store(gate, 2, 1);
          Atomics.notify(gate, 2);
          const wait = Atomics.wait(gate, 3, 0, 5000);
          const committed = getWorkerBackendSession(concurrent, execution.attemptId);
          committedBeforeReaderResumed =
            wait !== 'timed-out' &&
            Atomics.load(gate, 3) === 1 &&
            Atomics.load(gate, 4) === 2 &&
            f.coreDb.sqlite.inTransaction &&
            committed?.state === 'cleanup-pending' &&
            committed.updatedAt === CHANGED;
          if (!committedBeforeReaderResumed) {
            throw new Error('The owner did not commit before the snapshot reader resumed.');
          }
        }
        return prepare(sql);
      });
      const result = bounded(await f.native());
      expect(changed).toBe(true);
      expect(committedBeforeReaderResumed).toBe(true);
      const backend = result.items.find((item) => item.source === 'backend-session');
      expect(backend?.source).toBe('backend-session');
      if (backend?.source !== 'backend-session') throw new Error('Backend observation is absent.');
      expect([
        { state: 'materializing', sourceUpdatedAt: CREATED },
        { state: 'cleanup-pending', sourceUpdatedAt: CHANGED },
      ]).toContainEqual({ state: backend.state.state, sourceUpdatedAt: backend.sourceUpdatedAt });
      expect(backend.evidence.kind).toBe('unknown');
      fault.mockRestore();
      await transition;
      expect(
        bounded(await f.native()).items.find((item) => item.source === 'backend-session')
      ).toMatchObject({ sourceUpdatedAt: CHANGED, state: { state: 'cleanup-pending' } });
    } finally {
      Atomics.store(gate, 2, 1);
      Atomics.notify(gate, 2);
      try {
        await transition;
      } finally {
        concurrent.sqlite.close();
      }
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
    const beforeRows = rows(f.coreDb);
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
    expect(rows(f.coreDb)).toEqual(beforeRows);
    const afterFiles = files(f.dataRoot);
    expect(afterFiles.map(([name]) => name)).toEqual(beforeFiles.map(([name]) => name));
    expect(
      afterFiles
        .filter(([, digest], index) => digest !== beforeFiles[index]?.[1])
        .map(([name]) => name)
    ).toEqual([relative(f.dataRoot, path)]);
  });

  it('reads current deletion and runtime records after reopening Core storage', async () => {
    const f = await fixture();
    const { request, execution } = await populate(f);
    bounded(await f.native());
    f.coreDb.sqlite.close();
    f.coreDb = openCoreDb(f.dataRoot);
    fixtures[fixtures.length - 1]!.coreDb = f.coreDb;
    writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'blocked' });
    await transitionWorkerBackendSessionState(f.coreDb, {
      attemptId: execution.attemptId,
      fromState: 'materializing',
      toState: 'cleanup-pending',
      now: () => CHANGED,
    });
    const invoke = createOperationInvocation({ ...f, coreDb: f.coreDb });
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
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      mode: 'server',
    });
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      headers: { authorization: `Bearer ${f.token.secret}` },
      fetch: (input, init) => app.fetch(new Request(input, init)),
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
