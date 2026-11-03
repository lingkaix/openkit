import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  type MaterializedWorkspaceRoot,
} from '@openkit/config-schema';
import { canonicalJsonText } from '@openkit/protocol';
import {
  type WorkerCanonicalEventRecord,
  WorkerObservationDataSchema,
  workerObservationSourceRelativePath,
} from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { WorkerControlClient } from '../../../packages/worker-shim/src/control-client.js';
import { WorkerTranscriptWriter } from '../../../packages/worker-shim/src/transcript.js';
import { createDefaultWorkerControlGateway } from './app.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import type { FsStore } from './lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import * as attemptActionOwners from './runtime/execution-attempt-records.js';
import {
  acceptNanoHostAttemptHeartbeat,
  acceptNanoHostAttemptHeartbeatByBinding,
  bindNanoHostAttemptRouteTokenHashes,
  requireNanoHostExecutionAttempt,
  resolveNanoHostAttemptTokenBinding,
} from './runtime/nanohost-attempt-records.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  runNanoHostAttemptRecoveryMaintenance,
} from './runtime/nanohost-attempt-recovery.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import { projectWorkerBackendCleanup } from './runtime/worker-backend-cleanup-projection.js';
import {
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import {
  hashWorkerRouteToken,
  WorkerControlGateway,
  type WorkerControlGatewayError,
  type WorkerControlLineage,
} from './runtime/worker-control-gateway.js';
import {
  createWorkerControlAcceptedRecordRecorder,
  listWorkerControlAcceptedEvents,
  recoverWorkerObservationSource,
  resolveWorkerControlFinalStatusTokenBinding,
} from './runtime/worker-control-records.js';
import { listWorkerControlRejectedEvidenceForWorkspace } from './runtime/worker-control-rejected-evidence.js';
import { createWorkerControlSequenceRecorder } from './runtime/worker-control-sequences.js';
import {
  beginWorkerTurnJournalStep,
  endWorkerTurnJournalRelease,
  endWorkerTurnJournalStep,
  endWorkerTurnMaterialization,
  prepareWorkerTurnJournalIntents,
} from './runtime/worker-governance-turn-executor.js';
import { importWorkerTranscript } from './runtime/worker-transcript.js';
import { workerTurnTerminalPublication } from './runtime/worker-turn-failure.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './runtime/workspace-materializer.js';
import { listWorkspaceReconciliationRecords } from './runtime/workspace-reconciliation-records.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
} from './runtime/workspace-sync-records.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from './scheduler-records.js';
import { closeWorkspaceProductReadHandles } from './storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import {
  CONTROL_WORKER_VERSION,
  isControlWorkerRequest,
} from './storage/control-store-worker-protocol.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { coreDbPath } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { nativeProductScope } from './storage/workspace-file-records.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

// The real client retry owner uses timers/promises; route tests control only its clock.
vi.mock('node:timers/promises', async (original) => {
  const actual = await original<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: <T>(ms: number, value: T, options?: { signal?: AbortSignal }) => {
      if (!vi.isFakeTimers()) return actual.setTimeout(ms, value, options);
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(options?.signal?.reason);
        };
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', abort);
          resolve(value);
        }, ms);
        options?.signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
});

const heartbeatNativeInterception = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  corePath: '',
  postedHeartbeats: 0,
}));

// Use the real worker entry and SQLite COMMIT, as in control-store-worker-client.test.ts.
// Only the selected private Core journal is held or faulted; no SQL service is replaced.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (heartbeatNativeInterception.gate === undefined) {
          super(filename, options);
          return;
        }
        const prelude = `
          const { workerData } = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const original = Database.prototype.exec;
          Database.prototype.exec = function(sql) {
            if (this.name === workerData.corePath && /^COMMIT$/i.test(sql)) {
              const mode = Atomics.exchange(workerData.gate, 0, 0);
              if (mode !== 0) Atomics.add(workerData.gate, 1, 1);
              if (mode === 1) throw new Error('injected heartbeat native COMMIT failure');
              if (mode === 2) Atomics.wait(workerData.gate, 2, 0);
            }
            return original.call(this, sql);
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
            databaseModule: require.resolve('better-sqlite3'),
            gate: new Int32Array(heartbeatNativeInterception.gate),
            corePath: heartbeatNativeInterception.corePath,
          },
        });
      }

      postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        const [message] = args;
        super.postMessage(...args);
        if (message?.operation === 'worker-control-heartbeat')
          heartbeatNativeInterception.postedHeartbeats += 1;
      }
    },
  };
});

/** Arms one actual Core COMMIT; setup and all other journals remain outside the fault. */
function armHeartbeatNativeCommit(gate: Int32Array, mode: 1 | 2): void {
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 0);
  Atomics.store(gate, 0, mode);
}

/** Releases a held COMMIT on every success, refusal and test-cleanup path. */
function releaseHeartbeatNativeCommit(gate: Int32Array): void {
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
}

/** Keeps Main responsive while the existing test timeout bounds native crossing observation. */
async function waitForHeartbeatNativeObservation(observed: () => boolean): Promise<void> {
  while (!observed()) await nextTurn();
}

/** Private Core handles explicitly opened by the control-envelope cases; drained before disposal. */
const workerControlCoreFixtures: CoreDb[] = [];

/**
 * Creates an app with one registered worker control session.
 *
 * @param workspaceRoots Workspace inputs declared by the package fixture.
 * @param coreDb Existing migrated Core owner for an explicitly native product fixture.
 * @param captureOn Enables capture before admitting the Turn for restricted-content cases.
 * @returns App, gateway, token, package, and lineage fixtures.
 */
async function createWorkerControlRouteFixture(
  workspaceRoots: MaterializedWorkspaceRoot[],
  coreDb: CoreDb,
  captureOn = false
): Promise<{
  app: ReturnType<typeof createApp>;
  environmentPackage: AgentEnvironmentPackage;
  gateway: WorkerControlGateway;
  lineage: WorkerControlLineage;
  store: FsStore;
  token: string;
  workspaceMutationAdmission: WorkspaceMutationAdmission;
}> {
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  if (captureOn) store.setLiveCaptureCoverage({ scope: 'server', value: 'on' });
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Control worker over HTTP',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    await resolveAgentEnvironmentPackage({
      coreDb,
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup: createTestAgentSetup(),
      agentSessionId: testEntityId('as', 'as_control_route_1'),
      triggerActor: { kind: 'user', id: LOCAL_USER_ID },
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_control_route_1',
      turn,
      workspaceCwd: '/workspace/repo',
      workspaceRoots,
      workspaceSourceRefs: Object.fromEntries(workspaceRoots.map((root) => [root.id, root.id])),
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        requiredFeatures: [],
        extensions: {},
        sources: workspaceRoots.map((root) => ({
          id: root.id,
          displayName: root.id,
          kind: 'git' as const,
          locator: { commit: root.sourceCommit!, url: 'https://example.invalid/control.git' },
          access: root.access,
          allowedSlotKinds: ['worktree' as const],
          sensitivity: 'internal' as const,
          status: 'active' as const,
          syncHints: {},
          requiredFeatures: [],
          extensions: {},
        })),
      },
    })
  );
  const gateway = new WorkerControlGateway({
    createToken: () => 'token_control_route_1',
    now: () => '2026-06-16T00:00:02.000Z',
  });
  const registration = gateway.registerSession(environmentPackage);

  return {
    app: createApp({
      mode: 'server',
      store,
      workerControlGateway: gateway,
      workspaceMutationAdmission,
      turnExecutor: new SimulatedTurnExecutor({ coreDb }),
    }),
    environmentPackage,
    workspaceMutationAdmission,
    gateway,
    lineage: {
      agentSessionId: testEntityId('as', 'as_control_route_1'),
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: 'req_control_route_1',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: turn.id,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    },
    store,
    token: registration.token,
  };
}

/**
 * Creates one live scheduler lease for a default database-backed worker-control gateway.
 *
 * @param coreDb Open Core database handle.
 * @param environmentPackage Durable package snapshot owned by the lease.
 * @param lineage Worker lineage owned by the lease.
 * @param suffix Stable test id suffix.
 * @returns Sandbox binding ref registered on the lease.
 */
async function createDurableWorkerControlLease(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackage,
  lineage: WorkerControlLineage,
  suffix: string
): Promise<string> {
  const binding = `lease-binding:lease_${suffix}`;

  createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: LOCAL_USER_ID },
    profileRef: environmentPackage.agent.profileId,
    queueEntryId: `queue_${suffix}`,
    requestId: lineage.requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: lineage.threadId,
    turnId: lineage.turnId,
    turnInput: 'Run durable worker-control test',
    workspaceId: lineage.workspaceId,
  });
  const submittedAttempt = recordTestExecutionAttempt(coreDb, {
    entry: requireSchedulerAdmissionEntry(coreDb, `queue_${suffix}`),
    attemptId: testEntityId('attempt', `lease_${suffix}`),
    agentSessionId: lineage.agentSessionId,
    inputRef: lineage.packageSnapshotId,
    bindingRef: binding,
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => new Date().toISOString(),
    operationId: `fixture-submit:${String(testEntityId('attempt', `lease_${suffix}`))}`,
  });
  attemptActionOwners.acceptSchedulerExecutionObservation(coreDb, {
    ...attemptActionOwners.schedulerExecutionCorrelation(submittedAttempt),
    disposition: 'accepted',
    execution: 'running',
    fenceRef: null,
    outcomeRef: null,
  });
  bindNanoHostAttemptRouteTokenHashes(coreDb, {
    attemptId: testEntityId('attempt', `lease_${suffix}`),
    sandboxBindingRef: binding,
    workerCapabilityTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'capability')),
    workerControlTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'worker-control')),
    workerInferenceTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'inference')),
  });
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);

  try {
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
    await recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      createdAt: environmentPackage.createdAt,
      environmentPackage,
    });
  } finally {
    workspaceDb.sqlite.close();
  }

  return binding;
}

/** Derives one deterministic 32-byte raw route token for a durable fixture. */
function workerRouteToken(
  sandboxBindingRef: string,
  family: 'capability' | 'worker-control' | 'inference'
): string {
  return createHash('sha256').update(`${family}:${sandboxBindingRef}`).digest('base64url');
}

/** Registers the exact raw token pair whose hashes are owned by a durable fixture lease. */
function registerDurableWorkerControlSession(
  gateway: WorkerControlGateway,
  environmentPackage: AgentEnvironmentPackage,
  sandboxBindingRef: string
) {
  return gateway.registerSession(environmentPackage, {
    sandboxBindingRef,
    workerCapabilityToken: workerRouteToken(sandboxBindingRef, 'capability'),
    workerControlToken: workerRouteToken(sandboxBindingRef, 'worker-control'),
    workerInferenceToken: workerRouteToken(sandboxBindingRef, 'inference'),
  });
}

/** Records the exact durable backend identity owned by one worker-control lease fixture. */
async function recordWorkerControlBackendSession(
  coreDb: CoreDb,
  _environmentPackage: AgentEnvironmentPackage,
  lineage: WorkerControlLineage,
  sandboxBindingRef: string,
  backendSessionId: string
): Promise<string> {
  if (!getNanoHostRuntimeTarget(coreDb, 'runtime-target-test')) {
    const allocated = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-worker-control-test',
      identityId: 'identity-worker-control-test',
      observedAt: '2026-06-16T00:00:00.000Z',
      targetId: 'runtime-target-test',
    });
    await upsertNanoHostRuntimeTarget(coreDb, {
      ...allocated,
      freshEmpty: true,
      observedAt: '2026-06-16T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
  }
  return (
    await recordWorkerBackendSessionMaterializing(coreDb, {
      backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
      backendVersion: '0.0.80',
      identity: {
        agentSessionId: lineage.agentSessionId,
        backendKind: 'openshell',
        backendSessionId,
        deploymentId: 'deployment-worker-control-test',
        packageSnapshotId: lineage.packageSnapshotId,
        runtimeTargetId: 'runtime-target-test',
        stagingDirectoryRef: `server/runtime/worker-backend-sessions/${lineage.packageSnapshotId}`,
        transientProviderInstanceId: null,
      },
      lineage: {
        threadId: lineage.threadId,
        turnId: lineage.turnId,
        workspaceId: lineage.workspaceId,
      },
      sandboxBindingRef,
    })
  ).attemptId;
}

/** Advances one test backend identity through successful physical and durable cleanup. */
async function markWorkerControlBackendSessionCleaned(
  coreDb: CoreDb,
  attemptId: string
): Promise<void> {
  const transitions = [
    ['materializing', 'cleanup-pending'],
    ['cleanup-pending', 'physical-cleaned'],
    ['physical-cleaned', 'cleaned'],
  ] as const;

  for (const [fromState, toState] of transitions) {
    await transitionWorkerBackendSessionState(coreDb, { fromState, attemptId, toState });
  }
}

/** Builds the only worker heartbeat request shape accepted by the HTTP route. */
function heartbeatEnvelope(
  lineage: WorkerControlLineage,
  sequence: number,
  status: 'starting' | 'running' | 'stopping',
  message: string | null = null,
  processKeyHash?: string
) {
  return {
    body: { message, ...(processKeyHash ? { processKeyHash } : {}), status },
    lineage,
    operation: 'heartbeat' as const,
    schemaVersion: 2 as const,
    sequence,
  };
}

/** Reads exact Core attempt ownership without interpreting backend-private progress. */
function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const present = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return present
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Observes the immutable Core deadline separately from adapter liveness and sequence updates. */
function absoluteAttemptDeadline(coreDb: CoreDb, turnId: string): string {
  const row = observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === turnId);
  expect(
    row,
    'Activity must retain a real attempt with a durable absolute deadline.'
  ).toBeDefined();
  const deadline = String(row!.deadline);
  expect(Number.isFinite(Date.parse(deadline))).toBe(true);
  return deadline;
}

describe('worker control routes', () => {
  it.each([
    ['final-status', 'final_status'],
    ['supply-refresh-ack', 'supply_refresh_ack'],
    ['capability-summary', 'capability_summary'],
  ])('observes early %s refusals without echoing attempted values', async (path, operation) => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, lineage, token } = await createWorkerControlRouteFixture([], coreDb);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const attemptedOperation of ['heartbeat', operation]) {
        log.mockClear();
        const response = await app.request(`/api/worker-control/${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: 2,
            lineage,
            operation: attemptedOperation,
            sequence: 4,
            body: { privateValue: 'PRIVATE_BODY_SENTINEL' },
          }),
        });
        expect(response.status).toBe(400);
        expect(log).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
          event: 'worker.control.request',
          operation,
          sequence: 4,
          code: 'invalid_request',
          outcome: 'refused',
          status: 400,
          attemptId: null,
          attemptPhase: null,
          turnId: null,
          agentSessionId: null,
        });
        expect(log.mock.calls.join(' ')).not.toContain('PRIVATE_BODY_SENTINEL');
        expect(log.mock.calls.join(' ')).not.toContain(token);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('localizes withheld heartbeat acknowledgements and blocked carriage without renewing stale authority', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-heartbeat-gap-')));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const fixture = await createWorkerControlRouteFixture([], coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: LOCAL_USER_ID,
    });
    const binding = await createDurableWorkerControlLease(
      coreDb,
      fixture.environmentPackage,
      fixture.lineage,
      'diagnostic_gap'
    );
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = registerDurableWorkerControlSession(
      gateway,
      fixture.environmentPackage,
      binding
    );
    const app = createApp({
      workspaceMutationAdmission: fixture.workspaceMutationAdmission,
      coreDb,
      mode: 'server',
      store: fixture.store,
      workerControlGateway: gateway,
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const attempts: string[] = [];
    let releaseCarriage!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseCarriage = resolve;
    });
    let entered!: () => void;
    const firstAccepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let baseline: ReturnType<typeof requireNanoHostExecutionAttempt> | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const stop = new AbortController();
    const client = new WorkerControlClient({
      baseUrl: 'http://core/api/worker-control',
      token: registration.token,
      lineage: fixture.lineage,
      fetch: async (url, init) => {
        attempts.push(init.body);
        if (attempts.length > 2) await blocked;
        const response = await app.request(url, init);
        if (attempts.length <= 2) {
          expect(response.status).toBe(200);
          const lease = requireNanoHostExecutionAttempt(
            coreDb,
            testEntityId('attempt', 'lease_diagnostic_gap')
          );
          if (!baseline) {
            baseline = lease;
            entered();
          } else expect(lease).toEqual(baseline); // Exact replay acknowledges; it never renews.
          return { ok: true, status: 200, text: () => new Promise<string>(() => {}) };
        }
        return response;
      },
    });
    client.enablePostLaunchRecovery();
    const heartbeat = client
      .recordHeartbeat({ status: 'starting', message: 'PRIVATE_STATUS_SENTINEL' }, stop.signal)
      .catch((error: unknown) => error);
    try {
      await firstAccepted;
      vi.setSystemTime(new Date(baseline!.lastAcceptedHeartbeatAt!));
      await vi.advanceTimersByTimeAsync(31_000);
      expect(attempts.length).toBeGreaterThanOrEqual(3);
      expect(new Set(attempts).size).toBe(1);
      expect(
        requireNanoHostExecutionAttempt(coreDb, testEntityId('attempt', 'lease_diagnostic_gap'))
          .heartbeatDeadline
      ).toBe(baseline!.heartbeatDeadline);
      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          sandboxBindingRef: binding,
          lineage: fixture.lineage,
          token: registration.token,
          tokenFamily: 'worker-control',
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
      expect(
        attemptActionOwners.requireSchedulerExecutionAttempt(
          coreDb,
          testEntityId('attempt', 'lease_diagnostic_gap')
        )
      ).toMatchObject({
        phase: 'open',
        disposition: 'accepted',
        operationId: `fixture-submit:${testEntityId('attempt', 'lease_diagnostic_gap')}`,
        fenceRef: null,
      });
      releaseCarriage();
      expect(await heartbeat).toMatchObject({ code: 'worker_control_lease_not_live', status: 403 });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_diagnostic_gap')
        )?.phase
      );
      expect(
        requireNanoHostExecutionAttempt(coreDb, testEntityId('attempt', 'lease_diagnostic_gap'))
      ).toMatchObject({
        lastWorkerSequence: 0,
        heartbeatDeadline: baseline!.heartbeatDeadline,
      });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT count(*) AS count FROM worker_control_records WHERE operation = 'final_status'"
          )
          .get()
      ).toEqual({ count: 0 });
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: 'worker.control.request',
          operation: 'heartbeat',
          sequence: 0,
          attemptId: testEntityId('attempt', 'lease_diagnostic_gap'),
          attemptPhase: 'open',
          outcome: 'accepted',
        })
      );
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: 'worker.control.request',
          sequence: 0,
          attemptId: testEntityId('attempt', 'lease_diagnostic_gap'),
          attemptPhase: 'open',
          outcome: 'refused',
          status: 403,
          deadlineDeltaMs: 1000,
        })
      );
      expect(log.mock.calls.join(' ')).not.toContain(registration.token);
      expect(log.mock.calls.join(' ')).not.toContain('PRIVATE_STATUS_SENTINEL');
      expect(log.mock.calls.join(' ')).not.toContain('processKey');
    } finally {
      stop.abort();
      releaseCarriage();
      await heartbeat;
      vi.useRealTimers();
      log.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('strips descriptive heartbeat, final-status and refresh additions before gateway admission', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, gateway, lineage, token, environmentPackage } =
      await createWorkerControlRouteFixture([], coreDb);
    const heartbeat = heartbeatEnvelope(lineage, 1, 'running', 'alive');
    const cases = [
      {
        path: 'heartbeat',
        body: { ...heartbeat, body: { ...heartbeat.body, futureNote: 'ignored' } },
      },
      {
        path: 'supply-refresh-ack',
        body: {
          schemaVersion: 2,
          lineage,
          sequence: 1,
          operation: 'supply_refresh_ack',
          body: { refreshId: 'refresh_1', status: 'applied', futureNote: 'ignored' },
        },
      },
      {
        path: 'final-status',
        body: {
          schemaVersion: 2,
          lineage,
          sequence: 3,
          operation: 'final_status',
          body: {
            status: 'completed',
            stopReason: 'completed',
            evidenceManifestDigests: {},
            futureNote: 'ignored',
          },
        },
      },
    ];
    for (const entry of cases) {
      const response = await app.request(`/api/worker-control/${entry.path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...entry.body, futureNote: 'ignored' }),
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain('futureNote');
    }
    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);
    expect(snapshot?.heartbeat).toMatchObject({ status: 'running', message: 'alive' });
    expect(snapshot?.supplyRefreshAcks).toEqual([
      expect.objectContaining({ refreshId: 'refresh_1', status: 'applied' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('futureNote');
  });

  it.each([
    [
      'heartbeat',
      { schemaVersion: 2, sequence: 1, operation: 'heartbeat', body: { status: 'invented' } },
    ],
    [
      'supply-refresh-ack',
      {
        schemaVersion: 2,
        sequence: 1,
        operation: 'supply_refresh_ack',
        body: { status: 'invented', refreshId: 'refresh_1' },
      },
    ],
    [
      'final-status',
      { schemaVersion: 2, sequence: 1, operation: 'final_status', body: { status: 'completed' } },
    ],
  ])('refuses invalid known core in %s before admission', async (path, body) => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, gateway, lineage, token, environmentPackage } =
      await createWorkerControlRouteFixture([], coreDb);
    const response = await app.request(`/api/worker-control/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, lineage, futureNote: 'ignored' }),
    });
    expect(response.status).toBe(400);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)).toMatchObject({
      heartbeat: null,
      events: [],
      supplyRefreshAcks: [],
    });
  });

  it('keeps worker route planes ahead of product API middleware', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-route-inventory-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = createTestStore({ dataRoot });
    const routes = createApp({ store })
      .routes.filter(({ path }) => path.startsWith('/api/worker-') || path === '/api/*')
      .map(({ method, path }) => `${method} ${path}`);

    expect(routes).toEqual([
      'ALL /api/worker-control/*',
      'POST /api/worker-control/heartbeat',
      'POST /api/worker-control/artifacts',
      'POST /api/worker-control/events/append',
      'POST /api/worker-control/final-status',
      'POST /api/worker-control/supply-refresh-ack',
      'POST /api/worker-control/capability-summary',
      'ALL /api/worker-inference/*',
      'POST /api/worker-inference/v1/chat/completions',
      'POST /api/worker-inference/v1/responses',
      'ALL /api/worker-capabilities/*',
      'POST /api/worker-capabilities/mcp/_list-servers',
      'POST /api/worker-capabilities/mcp/:serverId',
      'ALL /api/*',
      'ALL /api/*',
    ]);
  });

  it.each([
    [
      'original process key',
      createHash('sha256').update('route-process-key').digest('base64url'),
      true,
      false,
      false,
      null,
      null,
    ],
    [
      'different process key',
      createHash('sha256').update('wrong-route-process-key').digest('base64url'),
      false,
      false,
      false,
      null,
      null,
    ],
    [
      'original process key before RuntimeTarget readiness returns',
      createHash('sha256').update('route-process-key').digest('base64url'),
      false,
      true,
      false,
      503,
      'worker_control_reconnect_required',
    ],
    [
      'original process key after backend cleanup starts',
      createHash('sha256').update('route-process-key').digest('base64url'),
      false,
      false,
      true,
      403,
      'worker_control_lease_not_live',
    ],
  ] as const)('accepts restart heartbeat only for the %s', async (_case, reconnectKey, accepted, clearRuntimeTargetReadiness, beginBackendCleanup, expectedStatus, expectedErrorCode) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-reconnect-route-')));
    const originalKey = createHash('sha256').update('route-process-key').digest('base64url');
    const processKeyHash = createHash('sha256')
      .update(Buffer.from(originalKey, 'base64url'))
      .digest('base64url');

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const fixture = await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        fixture.environmentPackage,
        fixture.lineage,
        'process_key_reconnect'
      );
      const attemptId = await recordWorkerControlBackendSession(
        coreDb,
        fixture.environmentPackage,
        fixture.lineage,
        binding,
        'sandbox-process-key-reconnect'
      );
      await transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId,
        toState: 'materialized',
      });
      await transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materialized',
        attemptId,
        toState: 'launching',
      });
      await markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId });
      const absoluteDeadline = absoluteAttemptDeadline(coreDb, fixture.lineage.turnId);
      const firstGateway = createDefaultWorkerControlGateway(coreDb);
      registerDurableWorkerControlSession(firstGateway, fixture.environmentPackage, binding);
      const firstApp = createApp({
        workspaceMutationAdmission: fixture.workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store: fixture.store,
        workerControlGateway: firstGateway,
      });
      const firstHeartbeat = await firstApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(
          heartbeatEnvelope(fixture.lineage, 0, 'starting', null, processKeyHash)
        ),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      expect(firstHeartbeat.status).toBe(200);
      expect(absoluteAttemptDeadline(coreDb, fixture.lineage.turnId)).toBe(absoluteDeadline);
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts
           SET recovery_state = 'awaiting-reconnect',
               recovery_deadline = '2099-01-01T00:00:00.000Z'
           WHERE attempt_id = '${testEntityId('attempt', 'lease_process_key_reconnect')}'`
        )
        .run();
      if (clearRuntimeTargetReadiness) {
        await recordNanoHostRuntimeTargetConnectionClose(coreDb, {
          authoritativeGeneration: null,
          closedGeneration: 1,
          observedAt: '2026-07-05T00:00:01.000Z',
          targetId: 'runtime-target-test',
        });
      }
      if (beginBackendCleanup) {
        await transitionWorkerBackendSessionState(coreDb, {
          fromState: 'launching',
          attemptId,
          toState: 'cleanup-pending',
        });
      }

      const restartedGateway = createDefaultWorkerControlGateway(coreDb);
      registerDurableWorkerControlSession(restartedGateway, fixture.environmentPackage, binding);
      const restartedApp = createApp({
        workspaceMutationAdmission: fixture.workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store: fixture.store,
        workerControlGateway: restartedGateway,
      });
      const reconnect = await restartedApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify({
          ...heartbeatEnvelope(fixture.lineage, 1, 'running', 'Worker survived NanoCore restart.'),
          reconnectKey,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const lease = requireNanoHostExecutionAttempt(
        coreDb,
        testEntityId('attempt', 'lease_process_key_reconnect')
      );
      const durableWorkerControl = JSON.stringify(
        coreDb.sqlite
          .prepare(
            `SELECT record_json FROM worker_control_records
             UNION ALL
             SELECT fingerprint AS record_json FROM worker_control_sequence_fingerprints`
          )
          .all()
      );

      expect(reconnect.status === 200).toBe(accepted);
      expect(absoluteAttemptDeadline(coreDb, fixture.lineage.turnId)).toBe(absoluteDeadline);
      if (expectedErrorCode) {
        expect(reconnect.status).toBe(expectedStatus);
        expect(await reconnect.clone().json()).toMatchObject({ code: expectedErrorCode });
      }
      if (expectedErrorCode === 'worker_control_reconnect_required') {
        expect(
          listWorkerControlRejectedEvidenceForWorkspace(coreDb, fixture.lineage.workspaceId)
        ).toEqual([]);
      }
      expect(lease).toMatchObject(
        accepted
          ? { lastWorkerSequence: 1, recoveryDeadline: null, recoveryState: null }
          : {
              lastWorkerSequence: 0,
              recoveryDeadline: '2099-01-01T00:00:00.000Z',
              recoveryState: 'awaiting-reconnect',
            }
      );
      expect(await reconnect.text()).not.toContain(reconnectKey);
      expect(durableWorkerControl).not.toContain(reconnectKey);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps event append sequence conflicts durable across default gateway instances', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-sequence-')));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(coreDb.dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Durable sequence thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Control worker',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: testEntityId('as', 'session_durable_sequence'),
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_durable_sequence',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      ensureLocalUser(coreDb);
      await createDemoStore({ dataRoot: coreDb.dataRoot });
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });

      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'durable_sequence'
      );
      const firstGateway = createDefaultWorkerControlGateway(coreDb);
      const firstRegistration = registerDurableWorkerControlSession(
        firstGateway,
        environmentPackage,
        binding
      );
      const firstApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: firstGateway,
      });
      const first = await firstApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${firstRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      const secondGateway = createDefaultWorkerControlGateway(coreDb);
      const secondRegistration = registerDurableWorkerControlSession(
        secondGateway,
        environmentPackage,
        binding
      );
      const secondApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: secondGateway,
      });
      const conflict = await secondApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: {
              data: { delta: 'different', itemId: 'candidate_item_1' },
              type: 'item.delta',
            },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${secondRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await conflict.json()) as { code: string };

      expect(first.status).toBe(200);
      expect(conflict.status).toBe(409);
      expect(body.code).toBe('worker_control_sequence_conflict');
    } finally {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(coreDb.dataRoot);
      coreDb.sqlite.close();
    }
  });

  it('persists accepted worker-control records through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-records-')));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(coreDb.dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Durable control records thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Control worker',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: testEntityId('as', 'session_durable_records'),
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_durable_records',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      ensureLocalUser(coreDb);
      await createDemoStore({ dataRoot: coreDb.dataRoot });
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });

      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'durable_records'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
      const app = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const heartbeat = await app.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.')),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const event = await app.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const rows = coreDb.sqlite
        .prepare(
          `
          SELECT operation, record_key AS recordKey, sequence, record_json AS recordJson
          FROM worker_control_records
          ORDER BY operation
          `
        )
        .all() as Array<{
        operation: string;
        recordJson: string;
        recordKey: string;
        sequence: number;
      }>;

      expect(heartbeat.status).toBe(200);
      expect(event.status).toBe(200);
      // Durable Worker-Control State forbids a second retained heartbeat payload.
      expect(rows).toHaveLength(1);
      expect(rows.map((row) => [row.operation, row.recordKey, row.sequence])).toEqual([
        ['event_append', '3', 3],
      ]);
      expect(JSON.parse(rows[0].recordJson)).toMatchObject({
        event: { type: 'item.delta' },
        sequence: 3,
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(coreDb.dataRoot);
      coreDb.sqlite.close();
    }
  });

  it('keeps native chunk fingerprints and receipts content-free across replay and source recovery', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-chunk-receipt-'));
    let coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const fixture = await createWorkerControlRouteFixture([], coreDb, true);
    const { environmentPackage, lineage, store, workspaceMutationAdmission } = fixture;
    await store.createAgentSession({
      id: lineage.agentSessionId,
      agentId: environmentPackage.agent.agentId,
      workspaceId: lineage.workspaceId,
      threadId: lineage.threadId,
      status: 'busy',
      message: null,
      createdAt: environmentPackage.createdAt,
      updatedAt: environmentPackage.createdAt,
    });
    await store.updateTurn(lineage.turnId, { agentSessionId: lineage.agentSessionId });
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: lineage.workspaceId,
      ownerUserId: LOCAL_USER_ID,
    });
    const binding = await createDurableWorkerControlLease(
      coreDb,
      environmentPackage,
      lineage,
      'chunk_receipt'
    );
    let gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = registerDurableWorkerControlSession(gateway, environmentPackage, binding);
    let app = createApp({
      coreDb,
      mode: 'server',
      store,
      workerControlGateway: gateway,
      workspaceMutationAdmission,
    });
    const authorization = `Bearer ${registration.token}`;
    const send = (record: WorkerCanonicalEventRecord) =>
      app.request('/api/worker-control/events/append', {
        body: JSON.stringify({ lineage, record }),
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
    const delivered: WorkerCanonicalEventRecord[] = [];
    const acknowledgements: unknown[] = [];
    const sessionDir = join(dataRoot, 'capture');
    const writer = new WorkerTranscriptWriter({
      sessionDir,
      lineage,
      appendEvent: async (record) => {
        const response = await send(record);
        expect(response.status).toBe(200);
        delivered.push(record);
        acknowledgements.push(await response.json());
      },
    });
    const bytes = Buffer.from('restricted-native-control-chunk-content');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writer.writeObservation(
      WorkerObservationDataSchema.parse({
        observationId: 'safe-core-receipt',
        sourceRef: 'control-source',
        sourceSequence: 0,
        observedAt: environmentPackage.createdAt,
        fact: {
          kind: 'assistant',
          runtimeOriginRef: null,
          phase: 'updated',
          messageRef: 'control',
          representation: 'delta',
        },
        content: {
          state: 'expected',
          mediaType: 'text/plain',
          boundary: 'assistant.text',
          bytes: bytes.length,
          sha256: `sha256:${digest}`,
          chunkCount: 1,
        },
      }),
      bytes
    );
    expect(delivered).toHaveLength(2);
    // WCP Incremental Work Observations: only coordinates, byte count and digest enter Core.
    const safeReceipt = {
      schemaVersion: 1,
      kind: 'event',
      lineage,
      sequence: 1,
      event: {
        type: 'observation.content.chunk',
        data: {
          observationId: 'safe-core-receipt',
          chunkIndex: 0,
          byteOffset: 0,
          encoding: 'base64',
          bytes: bytes.length,
          sha256: digest,
        },
      },
    };
    const retained = () => ({
      fingerprints: coreDb.sqlite
        .prepare(
          "SELECT sequence, fingerprint FROM worker_control_sequence_fingerprints WHERE package_snapshot_id = ? AND operation = 'event_append' ORDER BY sequence"
        )
        .all(lineage.packageSnapshotId) as { sequence: number; fingerprint: string }[],
      receipts: coreDb.sqlite
        .prepare(
          "SELECT sequence, record_json AS recordJson FROM worker_control_records WHERE package_snapshot_id = ? AND operation = 'event_append' ORDER BY sequence"
        )
        .all(lineage.packageSnapshotId) as { sequence: number; recordJson: string }[],
    });
    const original = retained();
    expect(original.fingerprints).toHaveLength(2);
    expect(original.receipts).toHaveLength(2);
    expect(original.fingerprints[1]!.fingerprint).toBe(canonicalJsonText(safeReceipt));
    expect(JSON.parse(original.receipts[1]!.recordJson)).toEqual(safeReceipt);
    expect(JSON.stringify(original)).not.toContain(bytes.toString('utf8'));
    expect(JSON.stringify(original)).not.toContain(bytes.toString('base64'));

    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(dataRoot);
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    gateway = createDefaultWorkerControlGateway(coreDb);
    app = createApp({
      coreDb,
      mode: 'server',
      store,
      workerControlGateway: gateway,
      workspaceMutationAdmission,
    });
    const replay = await send(delivered[1]!);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(acknowledgements[1]);
    // The actual recovery reader must accept the same safe fingerprints against the producer's original source.
    await recoverWorkerObservationSource(coreDb, {
      environmentPackage,
      metadata: delivered[0]!,
      sourcePath: join(sessionDir, workerObservationSourceRelativePath(0)),
      assertPublicationAuthority: () => {
        gateway.authenticateRequest({ authorization, lineage });
      },
    });
    expect(retained()).toEqual(original);
  });

  it.each([
    ['artifact_notice', '/api/worker-control/artifacts', 'artifact', 'noticedAt'],
    [
      'supply_refresh_ack',
      '/api/worker-control/supply-refresh-ack',
      'supplyRefreshAck',
      'acknowledgedAt',
    ],
  ] as const)('replays the original native %s receipt with an inert retained annotation', async (operation, route, responseKey, timestampKey) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-descriptive-receipt-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const { environmentPackage, lineage, store, workspaceMutationAdmission } =
      await createWorkerControlRouteFixture([], coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: lineage.workspaceId,
      ownerUserId: LOCAL_USER_ID,
    });
    const binding = await createDurableWorkerControlLease(
      coreDb,
      environmentPackage,
      lineage,
      operation
    );
    let gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = registerDurableWorkerControlSession(gateway, environmentPackage, binding);
    let app = createApp({
      coreDb,
      mode: 'server',
      store,
      workerControlGateway: gateway,
      workspaceMutationAdmission,
    });
    const payload =
      operation === 'artifact_notice'
        ? {
            artifact: {
              path: 'reports/result.md',
              title: 'Original report',
              mediaType: 'text/markdown',
            },
            lineage,
            sequence: 1,
          }
        : {
            body: {
              refreshId: 'refresh_original',
              status: 'applied',
              message: 'Original acknowledgement',
            },
            lineage,
            sequence: 1,
            schemaVersion: 2,
            operation,
          };
    const send = () =>
      app.request(route, {
        body: JSON.stringify(payload),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
    const first = await send();
    expect(first.status).toBe(200);
    const original = (await first.json()) as Record<string, Record<string, unknown>>;
    const readReceipt = () =>
      coreDb.sqlite
        .prepare(
          'SELECT accepted_at AS acceptedAt, record_json AS recordJson FROM worker_control_records WHERE package_snapshot_id = ? AND operation = ? AND record_key = ?'
        )
        .get(lineage.packageSnapshotId, operation, '1') as {
        acceptedAt: string;
        recordJson: string;
      };
    const accepted = readReceipt();
    expect(JSON.parse(accepted.recordJson)).toEqual(original[responseKey]);
    expect(original[responseKey]![timestampKey]).toBe(accepted.acceptedAt);
    // Deliberate retained-boundary fault injection follows valid public publication; it changes no known core or request fingerprint.
    const annotated = JSON.stringify({
      ...JSON.parse(accepted.recordJson),
      futureNote: 'inert descriptive annotation',
    });
    coreDb.sqlite
      .prepare(
        'UPDATE worker_control_records SET record_json = ? WHERE package_snapshot_id = ? AND operation = ? AND record_key = ?'
      )
      .run(annotated, lineage.packageSnapshotId, operation, '1');
    const beforeReplay = readReceipt();
    const fingerprints = () =>
      coreDb.sqlite
        .prepare(
          'SELECT sequence, fingerprint FROM worker_control_sequence_fingerprints WHERE package_snapshot_id = ? AND operation = ? ORDER BY sequence'
        )
        .all(lineage.packageSnapshotId, operation);
    const originalFingerprints = fingerprints();
    // A fresh default gateway with the exact original credentials must obtain the original receipt from its durable reader.
    gateway = createDefaultWorkerControlGateway(coreDb);
    expect(registerDurableWorkerControlSession(gateway, environmentPackage, binding).token).toBe(
      registration.token
    );
    app = createApp({
      coreDb,
      mode: 'server',
      store,
      workerControlGateway: gateway,
      workspaceMutationAdmission,
    });
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(original);
    // Contract Evolution's descriptive reader ignores additions without rewriting retained bytes or timestamps.
    expect(readReceipt()).toEqual(beforeReplay);
    expect(beforeReplay).toEqual({ acceptedAt: accepted.acceptedAt, recordJson: annotated });
    expect(fingerprints()).toEqual(originalFingerprints);
  });

  it('replays an ordinary native event with retained descriptive additions without a second live event', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-event-descriptive-receipt-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const { environmentPackage, lineage, store, workspaceMutationAdmission } =
      await createWorkerControlRouteFixture([], coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: lineage.workspaceId,
      ownerUserId: LOCAL_USER_ID,
    });
    const binding = await createDurableWorkerControlLease(
      coreDb,
      environmentPackage,
      lineage,
      'ordinary_event_annotation'
    );
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = registerDurableWorkerControlSession(gateway, environmentPackage, binding);
    const app = createApp({
      coreDb,
      mode: 'server',
      store,
      workerControlGateway: gateway,
      workspaceMutationAdmission,
    });
    const record: WorkerCanonicalEventRecord = {
      schemaVersion: 1,
      kind: 'event',
      lineage,
      sequence: 1,
      event: {
        type: 'item.delta',
        data: { itemId: 'ordinary_annotation_item', delta: 'original content' },
      },
    };
    const send = (event: unknown = record) =>
      app.request('/api/worker-control/events/append', {
        method: 'POST',
        body: JSON.stringify({ lineage, record: event }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
      });
    const first = await send();
    expect(first.status).toBe(200);
    const original = await first.json();
    expect(original).toEqual({
      schemaVersion: 2,
      accepted: true,
      nextExpectedSequence: 2,
      diagnostics: [],
    });
    const readReceipt = () =>
      coreDb.sqlite
        .prepare(
          "SELECT accepted_at AS acceptedAt, record_json AS recordJson FROM worker_control_records WHERE package_snapshot_id = ? AND operation = 'event_append' AND record_key = '1'"
        )
        .get(lineage.packageSnapshotId) as { acceptedAt: string; recordJson: string };
    const fingerprints = () =>
      coreDb.sqlite
        .prepare(
          "SELECT sequence, fingerprint FROM worker_control_sequence_fingerprints WHERE package_snapshot_id = ? AND operation = 'event_append' ORDER BY sequence"
        )
        .all(lineage.packageSnapshotId);
    const accepted = readReceipt();
    expect(JSON.parse(accepted.recordJson)).toEqual(record);
    const originalFingerprints = fingerprints();
    expect(originalFingerprints).toEqual([{ sequence: 1, fingerprint: canonicalJsonText(record) }]);
    expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.events).toEqual([record]);
    const liveBefore = gateway.getSessionSnapshot(lineage.packageSnapshotId)?.events;
    const setReceipt = (value: unknown) =>
      coreDb.sqlite
        .prepare(
          "UPDATE worker_control_records SET record_json = ? WHERE package_snapshot_id = ? AND operation = 'event_append' AND record_key = '1'"
        )
        .run(JSON.stringify(value), lineage.packageSnapshotId);
    // Valid public publication precedes this retained-reader fault; known core, time and fingerprint stay original.
    const annotated = {
      ...JSON.parse(accepted.recordJson),
      futureNote: 'inert descriptive annotation',
    };
    setReceipt(annotated);
    const retainedBefore = readReceipt();
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(original);
    // Contract Evolution / Worker Control Descriptive Readers: no rewrite, new timestamp or live event on replay.
    expect(readReceipt()).toEqual(retainedBefore);
    expect(retainedBefore).toEqual({
      acceptedAt: accepted.acceptedAt,
      recordJson: JSON.stringify(annotated),
    });
    expect(fingerprints()).toEqual(originalFingerprints);
    expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.events).toEqual(liveBefore);
    const changed = await send({
      ...record,
      event: {
        type: 'item.delta',
        data: { itemId: 'ordinary_annotation_item', delta: 'changed content' },
      },
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'worker_control_sequence_conflict' });
    for (const invalid of [
      {
        ...annotated,
        event: {
          type: 'item.delta',
          data: { itemId: 'ordinary_annotation_item', delta: 'changed retained content' },
        },
      },
      { ...annotated, requiredFeatures: ['unsupported.required'] },
      { ...annotated, event: { type: 'future.authority', data: {} } },
    ]) {
      setReceipt(invalid);
      const invalidBefore = readReceipt();
      const refused = await send();
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(readReceipt()).toEqual(invalidBefore);
      expect(fingerprints()).toEqual(originalFingerprints);
      expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.events).toEqual(liveBefore);
    }
  });

  it('never persists worker bearer tokens in sequenced control state', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-token-redaction-'));
    const coreDb = openCoreDb(dataRoot);
    const token = 'okw_sequence_fingerprint_secret';

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage, store, workspaceMutationAdmission } =
        await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const gateway = new WorkerControlGateway({
        acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
        createToken: () => token,
        now: () => '2026-07-15T00:00:00.000Z',
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      });
      gateway.registerSession(environmentPackage);
      const app = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const requests = [
        {
          accepted: heartbeatEnvelope(lineage, 1, 'running', 'alive'),
          conflict: heartbeatEnvelope(lineage, 1, 'running', 'changed'),
          operation: 'heartbeat',
          route: '/api/worker-control/heartbeat',
        },
        {
          accepted: {
            artifact: { path: 'reports/result.md', title: 'Result' },
            lineage,
            sequence: 2,
          },
          conflict: {
            artifact: { path: 'reports/result.md', title: 'Changed result' },
            lineage,
            sequence: 2,
          },
          operation: 'artifact_notice',
          route: '/api/worker-control/artifacts',
        },
        {
          accepted: {
            body: { message: 'refreshed', refreshId: 'refresh_token_redaction', status: 'applied' },
            lineage,
            operation: 'supply_refresh_ack',
            schemaVersion: 2,
            sequence: 3,
          },
          conflict: {
            body: { message: 'changed', refreshId: 'refresh_token_redaction', status: 'applied' },
            lineage,
            operation: 'supply_refresh_ack',
            schemaVersion: 2,
            sequence: 3,
          },
          operation: 'supply_refresh_ack',
          route: '/api/worker-control/supply-refresh-ack',
        },
      ] as const;

      for (const request of requests) {
        const send = (body: unknown) =>
          app.request(request.route, {
            body: JSON.stringify(body),
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            method: 'POST',
          });
        const accepted = await send(request.accepted);
        const replay = await send(request.accepted);
        const conflict = await send(request.conflict);

        expect.soft(accepted.status, request.operation).toBe(200);
        expect.soft(replay.status, request.operation).toBe(200);
        expect.soft(conflict.status, request.operation).toBe(409);
        expect.soft(await conflict.json(), request.operation).toMatchObject({
          code: 'worker_control_sequence_conflict',
        });
      }

      const fingerprints = coreDb.sqlite
        .prepare(
          `SELECT operation, fingerprint
             FROM worker_control_sequence_fingerprints
            ORDER BY operation`
        )
        .all() as Array<{ fingerprint: string; operation: string }>;
      const records = coreDb.sqlite
        .prepare(
          `SELECT operation, record_json AS recordJson
             FROM worker_control_records
            ORDER BY operation`
        )
        .all() as Array<{ operation: string; recordJson: string }>;

      expect(fingerprints.map(({ operation }) => operation)).toEqual(
        requests.map(({ operation }) => operation).sort()
      );
      // Heartbeat replay evidence remains durable; its liveness payload has no second owner.
      expect(records.map(({ operation }) => operation)).toEqual([
        'artifact_notice',
        'supply_refresh_ack',
      ]);
      expect(JSON.stringify(fingerprints)).not.toContain(token);
      expect(JSON.stringify(records)).not.toContain(token);
      coreDb.sqlite.close();
      expect(readFileSync(coreDbPath(dataRoot)).includes(token)).toBe(false);
    } finally {
      if (coreDb.sqlite.open) {
        coreDb.sqlite.close();
      }
    }
  });

  it('records rejected worker-control evidence through the default gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-rejected-')));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(coreDb.dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Rejected control records thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Control worker',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: testEntityId('as', 'session_rejected_records'),
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_rejected_records',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      ensureLocalUser(coreDb);
      await createDemoStore({ dataRoot: coreDb.dataRoot });
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });

      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'rejected_records'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
      const app = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const resumeNativeWrites = await getControlStoreWorkerClient().pauseForDataRootBackup(
        `core:${coreDbPath(coreDb.dataRoot)}`
      );
      let responseSettled = false;
      const responsePromise = app
        .request('/api/worker-control/events/append', {
          body: JSON.stringify({
            lineage,
            record: {
              event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
              kind: 'event',
              lineage: { ...lineage, threadId: testEntityId('th', 'th_other') },
              schemaVersion: 1,
              sequence: 1,
            },
          }),
          headers: {
            authorization: `Bearer ${registration.token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        })
        .then((response) => {
          responseSettled = true;
          return response;
        });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(responseSettled).toBe(false);
        expect(listWorkerControlRejectedEvidenceForWorkspace(coreDb, lineage.workspaceId)).toEqual(
          []
        );
      } finally {
        resumeNativeWrites();
      }
      const response = await responsePromise;
      const body = (await response.json()) as { code: string; message: string };
      const rejectedEvidence = listWorkerControlRejectedEvidenceForWorkspace(
        coreDb,
        lineage.workspaceId
      );
      const rejectedRow = coreDb.sqlite
        .prepare(
          `
          SELECT route, operation, error_code AS errorCode, http_status AS httpStatus, thread_id AS threadId
          FROM worker_control_rejected_evidence
          WHERE agent_session_id = ?
          `
        )
        .get(lineage.agentSessionId) as
        | {
            errorCode: string;
            httpStatus: number;
            operation: string;
            route: string;
            threadId: string;
          }
        | undefined;
      const acceptedCount = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM worker_control_records')
        .get() as { count: number };

      expect(response.status).toBe(403);
      expect(body.code).toBe('worker_control_lineage_mismatch');
      expect(rejectedEvidence).toEqual([
        {
          agentSessionId: lineage.agentSessionId,
          errorCode: 'worker_control_lineage_mismatch',
          httpStatus: 403,
          message: body.message,
          operation: 'event_append',
          packageSnapshotId: lineage.packageSnapshotId,
          rejectedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
          rejectionId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
          requestId: lineage.requestId,
          route: '/api/worker-control/events/append',
          threadId: lineage.threadId,
          turnId: lineage.turnId,
          workspaceId: lineage.workspaceId,
        },
      ]);
      const nativeRequest = {
        version: CONTROL_WORKER_VERSION,
        id: 0,
        database: `core:${coreDbPath(coreDb.dataRoot)}`,
        operation: 'worker-control-evidence' as const,
        input: rejectedEvidence[0]!,
      };
      expect(isControlWorkerRequest(nativeRequest)).toBe(true);
      expect(
        isControlWorkerRequest({
          ...nativeRequest,
          input: { ...nativeRequest.input, futureRequiredSemantics: true },
        })
      ).toBe(false);
      expect(
        isControlWorkerRequest({
          ...nativeRequest,
          input: { ...nativeRequest.input, workspaceId: 'not-a-canonical-workspace-id' },
        })
      ).toBe(false);
      expect(rejectedRow).toEqual({
        errorCode: 'worker_control_lineage_mismatch',
        httpStatus: 403,
        operation: 'event_append',
        route: '/api/worker-control/events/append',
        threadId: lineage.threadId,
      });
      expect(acceptedCount.count).toBe(0);

      const eventBody = (requestLineage = lineage) => ({
        lineage: requestLineage,
        record: {
          event: { data: { delta: 'unadmitted', itemId: 'unadmitted_item' }, type: 'item.delta' },
          kind: 'event',
          lineage: requestLineage,
          schemaVersion: 1,
          sequence: 1,
        },
      });
      const authorization = `Bearer ${registration.token}`;
      const requests = [
        { name: 'missing Token', authorization: null, body: eventBody(), status: 401 },
        {
          name: 'invalid Token',
          authorization: `Bearer ${globalThis.crypto.randomUUID()}`,
          body: eventBody(),
          status: 401,
        },
        {
          name: 'wrong authenticated outer lineage',
          authorization,
          body: eventBody({ ...lineage, threadId: testEntityId('th', 'th_wrong_outer') }),
          status: 403,
        },
        {
          name: 'schema refusal',
          authorization,
          body: { ...eventBody(), record: null },
          status: 400,
        },
        {
          name: 'size refusal',
          authorization,
          body: {
            ...eventBody(),
            record: {
              ...eventBody().record,
              event: {
                data: { delta: 'x'.repeat(260 * 1024), itemId: 'unadmitted_item' },
                type: 'item.delta',
              },
            },
          },
          status: 413,
        },
      ];
      const quarantineCount = () =>
        (
          coreDb.sqlite
            .prepare('SELECT COUNT(*) AS count FROM worker_control_rejected_evidence')
            .get() as { count: number }
        ).count;
      for (const request of requests) {
        const before = quarantineCount();
        const refused = await app.request('/api/worker-control/events/append', {
          body: JSON.stringify(request.body),
          headers: {
            'content-type': 'application/json',
            ...(request.authorization ? { authorization: request.authorization } : {}),
          },
          method: 'POST',
        });
        expect.soft(refused.status, request.name).toBe(request.status);
        // Worker Control Verification: parsed bytes cannot supply authenticated
        // lineage. The earlier admitted inner-lineage rejection remains retained.
        expect.soft(quarantineCount(), request.name).toBe(before);
      }
      const evidence = coreDb.sqlite
        .prepare('SELECT * FROM worker_control_rejected_evidence')
        .all();
      expect(JSON.stringify(evidence).includes(registration.token)).toBe(false);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_control_records').get()
      ).toEqual({ count: 0 });
    } finally {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(coreDb.dataRoot);
      coreDb.sqlite.close();
    }
  });

  it('enforces durable scheduler binding refs through the default gateway factory', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-default-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Default binding thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Control worker',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: testEntityId('as', 'session_default_binding'),
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_default_binding',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: LOCAL_USER_ID,
    });
    const gateway = createDefaultWorkerControlGateway(coreDb);
    createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      profileRef: environmentPackage.agent.profileId,
      queueEntryId: 'queue_default_binding',
      requestedAgentId: environmentPackage.agent.agentId,
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      turnInput: 'Run worker control route test',
      workspaceId: lineage.workspaceId,
    });
    const submittedAttempt = recordTestExecutionAttempt(coreDb, {
      entry: requireSchedulerAdmissionEntry(coreDb, 'queue_default_binding'),
      attemptId: testEntityId('attempt', 'lease_default_binding'),
      agentSessionId: lineage.agentSessionId,
      inputRef: lineage.packageSnapshotId,
      bindingRef: 'lease-binding:lease_default_binding',
      sessionCompatibilityKey: 'fixture-compatibility',
      now: () => new Date().toISOString(),
      operationId: `fixture-submit:${String(testEntityId('attempt', 'lease_default_binding'))}`,
    });
    attemptActionOwners.acceptSchedulerExecutionObservation(coreDb, {
      ...attemptActionOwners.schedulerExecutionCorrelation(submittedAttempt),
      disposition: 'accepted',
      execution: 'running',
      fenceRef: null,
      outcomeRef: null,
    });
    bindNanoHostAttemptRouteTokenHashes(coreDb, {
      attemptId: testEntityId('attempt', 'lease_default_binding'),
      sandboxBindingRef: 'lease-binding:lease_default_binding',
      workerCapabilityTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_default_binding', 'capability')
      ),
      workerControlTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_default_binding', 'worker-control')
      ),
      workerInferenceTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_default_binding', 'inference')
      ),
    });
    const backendLeaseId = await recordWorkerControlBackendSession(
      coreDb,
      environmentPackage,
      lineage,
      'lease-binding:lease_default_binding',
      'sandbox_default_binding'
    );
    const registration = registerDurableWorkerControlSession(
      gateway,
      environmentPackage,
      'lease-binding:lease_default_binding'
    );
    const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

    await gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      ...heartbeatEnvelope(lineage, 1, 'running'),
    });
    expect(['open', 'closing']).toContain(
      observeExecutionAttempts(coreDb).find(
        (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_default_binding')
      )?.phase
    );
    expect(
      requireNanoHostExecutionAttempt(coreDb, testEntityId('attempt', 'lease_default_binding'))
    ).toMatchObject({
      lastAcceptedHeartbeatAt: expect.any(String),
      lastWorkerSequence: 1,
    });
    const heartbeatBaseline = requireNanoHostExecutionAttempt(
      coreDb,
      testEntityId('attempt', 'lease_default_binding')
    );

    coreDb.sqlite
      .prepare(
        'UPDATE scheduler_execution_attempts SET last_worker_sequence = ? WHERE attempt_id = ?'
      )
      .run(3, testEntityId('attempt', 'lease_default_binding'));
    const staleSequenceResponse = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify(heartbeatEnvelope(lineage, 2, 'running')),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const staleSequenceBody = (await staleSequenceResponse.json()) as { code: string };

    expect.soft(staleSequenceResponse.status).toBe(409);
    expect.soft(staleSequenceBody.code).toBe('worker_control_sequence_stale');
    coreDb.sqlite
      .prepare(
        "DELETE FROM worker_control_sequence_fingerprints WHERE operation = 'heartbeat' AND sequence = ?"
      )
      .run(2);
    coreDb.sqlite
      .prepare(
        'UPDATE scheduler_execution_attempts SET last_worker_sequence = ? WHERE attempt_id = ?'
      )
      .run(heartbeatBaseline.lastWorkerSequence, testEntityId('attempt', 'lease_default_binding'));

    coreDb.sqlite.exec(`
      CREATE TRIGGER reject_second_heartbeat_acceptance
      BEFORE UPDATE ON scheduler_execution_attempts
      WHEN NEW.attempt_id = '${testEntityId('attempt', 'lease_default_binding')}'
        AND NEW.last_worker_sequence = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected attempt heartbeat acceptance failure');
      END
    `);
    const failedHeartbeatResponse = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify(heartbeatEnvelope(lineage, 2, 'running')),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    coreDb.sqlite.exec('DROP TRIGGER reject_second_heartbeat_acceptance');
    const failedSequence = coreDb.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM worker_control_sequence_fingerprints WHERE operation = 'heartbeat' AND sequence = ?"
      )
      .get(2) as { count: number };
    const failedRecord = coreDb.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM worker_control_records WHERE operation = 'heartbeat' AND record_key = ?"
      )
      .get('2') as { count: number };
    const leaseAfterFailure = requireNanoHostExecutionAttempt(
      coreDb,
      testEntityId('attempt', 'lease_default_binding')
    );

    expect(failedHeartbeatResponse.status).toBe(500);
    expect.soft(failedSequence.count).toBe(0);
    expect.soft(failedRecord.count).toBe(0);
    expect.soft(leaseAfterFailure).toMatchObject({
      heartbeatDeadline: heartbeatBaseline.heartbeatDeadline,
      lastAcceptedHeartbeatAt: heartbeatBaseline.lastAcceptedHeartbeatAt,
      lastWorkerSequence: heartbeatBaseline.lastWorkerSequence,
      phase: heartbeatBaseline.phase,
    });
    coreDb.sqlite
      .prepare(
        "DELETE FROM worker_control_sequence_fingerprints WHERE operation = 'heartbeat' AND sequence = ?"
      )
      .run(2);
    coreDb.sqlite
      .prepare(
        `UPDATE scheduler_execution_attempts
         SET phase = ?, heartbeat_deadline = ?, last_accepted_heartbeat_at = ?, last_worker_sequence = ?
         WHERE attempt_id = ?`
      )
      .run(
        heartbeatBaseline.phase,
        heartbeatBaseline.heartbeatDeadline,
        heartbeatBaseline.lastAcceptedHeartbeatAt,
        heartbeatBaseline.lastWorkerSequence,
        testEntityId('attempt', 'lease_default_binding')
      );
    coreDb.sqlite
      .prepare(
        "UPDATE scheduler_execution_attempts SET heartbeat_deadline = '2000-01-01T00:00:00.000Z' WHERE attempt_id = ?"
      )
      .run(testEntityId('attempt', 'lease_default_binding'));
    const staleResponse = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify(heartbeatEnvelope(lineage, 2, 'running')),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const staleBody = (await staleResponse.json()) as { code: string };

    expect(staleResponse.status).toBe(403);
    expect(staleBody.code).toBe('worker_control_lease_not_live');
    await markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
    await closeOwnedExecutionAttempt(coreDb, {
      attemptId: testEntityId('attempt', 'lease_default_binding'),
      firstTerminalCause: 'completed',
      outcome: 'completed',
    });

    expect(() =>
      gateway.recordHeartbeat({
        authorization: `Bearer ${registration.token}`,
        ...heartbeatEnvelope(lineage, 3, 'running'),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lease_not_live',
        status: 403,
      }) as WorkerControlGatewayError
    );

    coreDb.sqlite.close();
  });

  it('rejects non-lease tokens on the default database gateway', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-non-lease-')));

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage, store, workspaceMutationAdmission } =
        await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        'lease-binding:missing_lease'
      );
      const app = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const response = await app.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running')),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await response.json()) as { code: string };

      expect(response.status).toBe(401);
      expect(body.code).toBe('worker_control_unauthorized');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps worker-control database failures as internal server errors', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-db-error-')));

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const { environmentPackage, lineage, store, workspaceMutationAdmission } =
      await createWorkerControlRouteFixture([], coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: LOCAL_USER_ID,
    });
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const registration = gateway.registerSession(environmentPackage, {
      sandboxBindingRef: 'lease-binding:database_failure',
    });
    const app = createApp({
      workspaceMutationAdmission,
      mode: 'server',
      store,
      workerControlGateway: gateway,
    });

    coreDb.sqlite.close();
    const response = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running')),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(500);
  });

  it.each([
    ['missing', {}],
    ['null', { stopReason: null }],
    ['empty', { stopReason: '' }],
    ['whitespace', { stopReason: '   ' }],
  ])('rejects %s final-status stopReason', async (_label, bodyOverride) => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, environmentPackage, gateway, lineage, token } =
      await createWorkerControlRouteFixture([], coreDb);
    const response = await app.request('/api/worker-control/final-status', {
      body: JSON.stringify({
        body: { status: 'completed', ...bodyOverride },
        lineage,
        operation: 'final_status',
        schemaVersion: 2,
        sequence: 7,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const responseBody = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(responseBody.code).toBe('invalid_request');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([]);
  });

  it('records final status as the exact canonical terminal event', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, environmentPackage, gateway, lineage, token } =
      await createWorkerControlRouteFixture([], coreDb);
    const response = await app.request('/api/worker-control/final-status', {
      body: JSON.stringify({
        body: {
          diagnostics: { stderr: 'Product-safe failure summary.' },
          evidenceManifestDigests: { runtime: 'sha256:runtime' },
          status: 'failed',
          stopReason: 'worker-runtime-failed',
        },
        lineage,
        operation: 'final_status',
        schemaVersion: 2,
        sequence: 7,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([
      {
        event: {
          data: {
            diagnostics: { stderr: 'Product-safe failure summary.' },
            evidenceManifestDigests: { runtime: 'sha256:runtime' },
            status: 'failed',
            stopReason: 'worker-runtime-failed',
          },
          type: 'turn.failed',
        },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 7,
      },
    ]);
  });

  it.each([
    'turn.completed',
    'turn.failed',
  ] as const)('rejects direct %s event append outside final status', async (eventType) => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, environmentPackage, gateway, lineage, token } =
      await createWorkerControlRouteFixture([], coreDb);
    const response = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          event: {
            data: {
              evidenceManifestDigests: {},
              status: eventType === 'turn.completed' ? 'completed' : 'failed',
              stopReason: eventType === 'turn.completed' ? 'completed' : 'failed',
            },
            type: eventType,
          },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 7,
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const responseBody = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(responseBody.code).toBe('worker_control_terminal_event_requires_final_status');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([]);
  });

  it('rolls back final status atomically before a successful restart retry', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-final-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Final status thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Complete worker',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: testEntityId('as', 'session_final_status'),
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_final_status',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: LOCAL_USER_ID,
    });
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
    await recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      createdAt: environmentPackage.createdAt,
      environmentPackage,
    });
    recordWorkspaceMaterializationRecords(workspaceDb, [
      {
        backendKind: 'openshell',
        base: { commit: 'abc123', contentDigest: null },
        createdAt: '2026-06-16T00:00:01.000Z',
        id: 'wmr_final_status',
        inputSnapshotId: 'wis_final_status',
        materializedRootRef: 'workspace://ws_00000000-0000-7000-8000-000000000001/repo_default',
        packageSnapshotId: lineage.packageSnapshotId,
        policyDigest: 'sha256:policy',
        readinessEvidence: [{ kind: 'backend.ready', ref: 'version:0.0.63' }],
        sourceId: 'repo_default',
        strategy: 'git',
        workerSessionId: 'sandbox_final_status',
        workspaceId: lineage.workspaceId,
      },
    ]);
    createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      profileRef: environmentPackage.agent.profileId,
      queueEntryId: 'queue_final_status',
      requestId: lineage.requestId,
      requestedAgentId: environmentPackage.agent.agentId,
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      turnInput: 'Run final status route test',
      workspaceId: lineage.workspaceId,
    });
    const submittedAttempt = recordTestExecutionAttempt(coreDb, {
      entry: requireSchedulerAdmissionEntry(coreDb, 'queue_final_status'),
      attemptId: testEntityId('attempt', 'lease_final_status'),
      agentSessionId: lineage.agentSessionId,
      inputRef: lineage.packageSnapshotId,
      bindingRef: 'lease-binding:lease_final_status',
      sessionCompatibilityKey: 'fixture-compatibility',
      now: () => '2099-07-05T00:00:02.000Z',
      operationId: `fixture-submit:${String(testEntityId('attempt', 'lease_final_status'))}`,
    });
    attemptActionOwners.acceptSchedulerExecutionObservation(coreDb, {
      ...attemptActionOwners.schedulerExecutionCorrelation(submittedAttempt),
      disposition: 'accepted',
      execution: 'running',
      fenceRef: null,
      outcomeRef: null,
    });
    bindNanoHostAttemptRouteTokenHashes(coreDb, {
      attemptId: testEntityId('attempt', 'lease_final_status'),
      now: () => '2099-07-05T00:00:03.000Z',
      sandboxBindingRef: 'lease-binding:lease_final_status',
      workerCapabilityTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_final_status', 'capability')
      ),
      workerControlTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_final_status', 'worker-control')
      ),
      workerInferenceTokenHash: hashWorkerRouteToken(
        workerRouteToken('lease-binding:lease_final_status', 'inference')
      ),
    });
    const backendLeaseId = await recordWorkerControlBackendSession(
      coreDb,
      environmentPackage,
      lineage,
      'lease-binding:lease_final_status',
      'sandbox_final_status'
    );
    acceptNanoHostAttemptHeartbeat(coreDb, {
      heartbeatTimeoutMs: 30_000,
      attemptId: testEntityId('attempt', 'lease_final_status'),
      now: () => '2099-07-05T00:00:10.000Z',
      workerSequence: 1,
    });
    const registration = registerDurableWorkerControlSession(
      gateway,
      environmentPackage,
      'lease-binding:lease_final_status'
    );
    const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });
    const finalStatusBody = JSON.stringify({
      schemaVersion: 2,
      lineage,
      operation: 'final_status',
      sequence: 7,
      body: {
        status: 'completed',
        stopReason: 'completed',
      },
    });

    const pendingHandles = listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId);
    expect(pendingHandles).toEqual([
      expect.objectContaining({
        cleanupStatus: 'pending',
        id: 'bwh_wmr_final_status',
        packageSnapshotId: lineage.packageSnapshotId,
        workerSessionId: 'sandbox_final_status',
      }),
    ]);
    coreDb.sqlite.exec(`
      CREATE TRIGGER reject_final_status_release
      BEFORE UPDATE OF phase ON scheduler_execution_attempts
      WHEN OLD.attempt_id = '${testEntityId('attempt', 'lease_final_status')}' AND NEW.phase = 'closing'
      BEGIN
        SELECT RAISE(ABORT, 'injected final status release failure');
      END
    `);
    const failed = await app.request('/api/worker-control/final-status', {
      body: finalStatusBody,
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const recordsAfterFailure = coreDb.sqlite
      .prepare(
        `SELECT operation
           FROM worker_control_records
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          ORDER BY operation`
      )
      .all(lineage.turnId);
    const fingerprintsAfterFailure = coreDb.sqlite
      .prepare(
        `SELECT operation
           FROM worker_control_sequence_fingerprints
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          ORDER BY operation`
      )
      .all(lineage.turnId);

    expect(failed.status).toBe(500);
    expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual(pendingHandles);
    expect.soft(recordsAfterFailure).toEqual([]);
    expect.soft(fingerprintsAfterFailure).toEqual([]);
    expect(['open', 'closing']).toContain(
      observeExecutionAttempts(coreDb).find(
        (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_final_status')
      )?.phase
    );

    coreDb.sqlite.exec('DROP TRIGGER reject_final_status_release');
    const rebuiltGateway = createDefaultWorkerControlGateway(coreDb);
    const rebuiltApp = createApp({
      coreDb,
      mode: 'server',
      store,
      workerControlGateway: rebuiltGateway,
    });
    const accepted = await rebuiltApp.request('/api/worker-control/final-status', {
      body: finalStatusBody,
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    const acceptedRecords = coreDb.sqlite
      .prepare(
        `SELECT operation, COUNT(*) AS count
           FROM worker_control_records
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          GROUP BY operation
          ORDER BY operation`
      )
      .all(lineage.turnId);
    const acceptedFingerprints = coreDb.sqlite
      .prepare(
        `SELECT operation, COUNT(*) AS count
           FROM worker_control_sequence_fingerprints
          WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
          GROUP BY operation
          ORDER BY operation`
      )
      .all(lineage.turnId);
    const acceptedEvents = listWorkerControlAcceptedEvents(coreDb, lineage);
    const transcriptImport = await importWorkerTranscript(
      store,
      environmentPackage,
      { eventsJsonl: `${JSON.stringify(acceptedEvents[0])}\n` },
      { acceptedLiveEvents: acceptedEvents }
    );

    expect(accepted.status).toBe(200);
    expect.soft(acceptedEvents).toEqual([
      {
        event: {
          data: {
            evidenceManifestDigests: {},
            status: 'completed',
            stopReason: 'completed',
          },
          type: 'turn.completed',
        },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 7,
      },
    ]);
    expect.soft(transcriptImport).toMatchObject({
      dedupedEventSequences: [7],
      diagnostics: [],
      rejectedEventSequences: [],
    });
    expect.soft(acceptedRecords).toEqual([
      { count: 1, operation: 'event_append' },
      { count: 1, operation: 'final_status' },
    ]);
    expect.soft(acceptedFingerprints).toEqual([
      { count: 1, operation: 'event_append' },
      { count: 1, operation: 'final_status' },
    ]);
    expect(
      observeExecutionAttempts(coreDb).find(
        (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_final_status')
      )?.phase
    ).toBe('closing');

    // Core final-status acceptance does not acknowledge Workspace collection or cleanup.
    expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual(pendingHandles);
    expect(
      resolveNanoHostAttemptTokenBinding(coreDb, {
        sandboxBindingRef: 'lease-binding:lease_final_status',
        lineage,
      })
    ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });

    const reconcileAcceptedFinalStatus = vi.fn(async () => undefined);
    await runNanoHostAttemptRecoveryMaintenance(coreDb, {
      executionBackend: {
        id: 'nanohost',
        submit: vi.fn(),
        inspect: vi.fn(),
        cancel: vi.fn(),
        release: vi.fn(),
      },
      cleanupBackendSession: vi.fn(),
      reconcileExecutions: async () => {},
      prepareBackendCleanup: vi.fn(() => false),
      restoreBackendSession: vi.fn(),
      projectRecoveredTurn: vi.fn(),
      reconcileAcceptedFinalStatus,
      now: () => new Date(Date.now() + 60_000).toISOString(),
    });
    expect(reconcileAcceptedFinalStatus).toHaveBeenCalledOnce();
    expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual(pendingHandles);
    expect(listWorkspaceReconciliationRecords(workspaceDb, lineage.workspaceId)).toEqual([]);
    expect(
      observeExecutionAttempts(coreDb).find(
        (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_final_status')
      )?.phase
    ).toBe('closing');
    expect(
      requireNanoHostExecutionAttempt(coreDb, testEntityId('attempt', 'lease_final_status'))
    ).toMatchObject({
      heartbeatDeadline: '2099-07-05T00:00:40.000Z',
    });

    const completedTurn = {
      id: lineage.turnId,
      status: 'completed' as const,
      threadId: lineage.threadId,
      workspaceId: lineage.workspaceId,
    };
    await markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
    // This route-level fixture supplies settled handoff barriers after checking the accepted
    // transcript and unchanged Workspace handle; executor integration tests prove their producers.
    attemptActionOwners.markSchedulerAttemptForTerminalTurn(coreDb, completedTurn);
    const closing = attemptActionOwners.requireSchedulerExecutionAttempt(
      coreDb,
      testEntityId('attempt', 'lease_final_status')
    );
    const release = {
      correlation: attemptActionOwners.schedulerExecutionCorrelation(closing),
      proof: {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      },
      fenceRef: 'fixture-cleaned:lease_final_status',
    };
    attemptActionOwners.closeSchedulerExecutionAttemptWithFence(coreDb, release);
    attemptActionOwners.closeSchedulerExecutionAttemptWithFence(coreDb, release);

    expect(
      observeExecutionAttempts(coreDb).find(
        (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_final_status')
      )?.phase
    ).toBe('closed');

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('resolves a live final-status binding inside its Core transaction', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-live-race-')));

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage, store, workspaceMutationAdmission } =
        await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'final_status_live_race'
      );
      const gateway = new WorkerControlGateway({
        acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
        resolveFinalStatusTokenBinding: (input) =>
          resolveWorkerControlFinalStatusTokenBinding(coreDb, input),
        runFinalStatusTransaction: (operation) => {
          coreDb.sqlite
            .prepare('UPDATE scheduler_execution_attempts SET binding_ref = ? WHERE attempt_id = ?')
            .run('revoked-binding', testEntityId('attempt', 'lease_final_status_live_race'));
          return coreDb.sqlite.transaction(operation)();
        },
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      });
      registerDurableWorkerControlSession(gateway, environmentPackage, binding);
      const app = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const response = await app.request('/api/worker-control/final-status', {
        body: JSON.stringify({
          body: { status: 'completed', stopReason: 'completed' },
          lineage,
          operation: 'final_status',
          schemaVersion: 2,
          sequence: 7,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const acceptedRecordCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_records
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };
      const fingerprintCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_sequence_fingerprints
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };

      expect(response.status).toBe(401);
      expect.soft(acceptedRecordCount.count).toBe(0);
      expect.soft(fingerprintCount.count).toBe(0);
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) =>
            attempt.attempt_id === testEntityId('attempt', 'lease_final_status_live_race')
        )?.phase
      );
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) =>
            attempt.attempt_id === testEntityId('attempt', 'lease_final_status_live_race')
        )
      ).toMatchObject({ binding_ref: 'revoked-binding' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects exact final-status replay when the authority deadline expires at transaction entry', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-replay-race-')));
    let transactionCount = 0;
    let deadlineExpiredAtTransactionEntry = false;

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage, store, workspaceMutationAdmission } =
        await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'final_status_replay_race'
      );
      const backendLeaseId = await recordWorkerControlBackendSession(
        coreDb,
        environmentPackage,
        lineage,
        binding,
        'sandbox_final_status_replay_race'
      );
      const gateway = new WorkerControlGateway({
        acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
        onFinalStatusAccepted: (input) => {
          const resolution = resolveNanoHostAttemptTokenBinding(coreDb, input);

          if (resolution.status !== 'accepted') {
            throw new Error('Expected a live lease during initial final-status acceptance.');
          }

          beginOwnedAttemptCloseout(coreDb, {
            attemptId: resolution.attempt.attemptId,
            firstTerminalCause: 'worker-final-status',
          });
        },
        resolveFinalStatusTokenBinding: (input) =>
          resolveWorkerControlFinalStatusTokenBinding(coreDb, input),
        runFinalStatusTransaction: (operation) => {
          transactionCount += 1;
          if (transactionCount === 2) {
            coreDb.sqlite
              .prepare('UPDATE scheduler_execution_attempts SET deadline = ? WHERE attempt_id = ?')
              .run(
                '2000-01-01T00:00:00.000Z',
                testEntityId('attempt', 'lease_final_status_replay_race')
              );
            deadlineExpiredAtTransactionEntry = true;
            beginOwnedAttemptCloseout(coreDb, {
              attemptId: testEntityId('attempt', 'lease_final_status_replay_race'),

              firstTerminalCause: 'worker-final-status',
            });
          }
          return coreDb.sqlite.transaction(operation)();
        },
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      });
      registerDurableWorkerControlSession(gateway, environmentPackage, binding);
      const app = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const request = {
        body: JSON.stringify({
          body: { status: 'completed', stopReason: 'completed' },
          lineage,
          operation: 'final_status',
          schemaVersion: 2,
          sequence: 7,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST' as const,
      };
      const accepted = await app.request('/api/worker-control/final-status', request);
      // Cleanup is a settled replay precondition; deadline expiry remains the synchronous transaction-entry fault.
      await markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
      const replay = await app.request('/api/worker-control/final-status', request);
      const acceptedRecordCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_records
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };
      const fingerprintCount = coreDb.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_control_sequence_fingerprints
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')`
        )
        .get(lineage.turnId) as { count: number };

      expect(accepted.status).toBe(200);
      expect(replay.status).toBe(403);
      expect(deadlineExpiredAtTransactionEntry).toBe(true);
      expect.soft(acceptedRecordCount.count).toBe(2);
      expect.soft(fingerprintCount.count).toBe(2);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) =>
            attempt.attempt_id === testEntityId('attempt', 'lease_final_status_replay_race')
        )?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains the backend handle in the canonical Workspace across final-status replay', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-workspace-')));
    const sourceCommit = 'a'.repeat(40);
    let preparedWorkspaceDb: ReturnType<typeof openWorkspaceDb> | undefined;

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage, store, workspaceMutationAdmission } =
        await createWorkerControlRouteFixture(
          [
            {
              access: 'read-write',
              id: 'repo_default',
              sourceCommit,
              sourceKind: 'remote-git',
              workerPath: '/workspace/repo',
            },
          ],
          coreDb
        );
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);
      preparedWorkspaceDb = workspaceDb;
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const fixtureSuffix = 'final_status_workspace';
      const binding = `lease-binding:lease_${fixtureSuffix}`;
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: LOCAL_USER_ID },
        profileRef: environmentPackage.agent.profileId,
        queueEntryId: `queue_${fixtureSuffix}`,
        requestId: lineage.requestId,
        requestedAgentId: environmentPackage.agent.agentId,
        threadId: lineage.threadId,
        turnId: lineage.turnId,
        turnInput: 'Run durable worker-control test',
        workspaceId: lineage.workspaceId,
      });
      const submittedAttempt = recordTestExecutionAttempt(coreDb, {
        entry: requireSchedulerAdmissionEntry(coreDb, `queue_${fixtureSuffix}`),
        attemptId: testEntityId('attempt', `lease_${fixtureSuffix}`),
        agentSessionId: lineage.agentSessionId,
        inputRef: lineage.packageSnapshotId,
        bindingRef: binding,
        sessionCompatibilityKey: 'fixture-compatibility',
        now: () => new Date().toISOString(),
        operationId: `fixture-submit:${String(testEntityId('attempt', `lease_${fixtureSuffix}`))}`,
      });
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: environmentPackage.createdAt,
        environmentPackage,
      });
      const backendLeaseId = await recordWorkerControlBackendSession(
        coreDb,
        environmentPackage,
        lineage,
        binding,
        'sandbox_final_status_workspace'
      );
      const backendSession = getWorkerBackendSession(coreDb, backendLeaseId)!;
      const sessionCreatedAt = new Date().toISOString();
      await store.createAgentSession({
        id: lineage.agentSessionId,
        agentId: environmentPackage.agent.agentId,
        workspaceId: lineage.workspaceId,
        threadId: lineage.threadId,
        status: 'busy',
        message: null,
        environmentPackageSnapshotId: lineage.packageSnapshotId,
        sessionCompatibilityKey: requireNanoHostExecutionAttempt(coreDb, submittedAttempt.attemptId)
          .sessionCompatibilityKey,
        createdAt: sessionCreatedAt,
        updatedAt: sessionCreatedAt,
      });
      await store.updateTurn(
        lineage.turnId,
        {
          agentId: environmentPackage.agent.agentId,
          agentSessionId: lineage.agentSessionId,
        },
        {
          journalIntents: prepareWorkerTurnJournalIntents(
            workspaceDb,
            environmentPackage,
            submittedAttempt,
            {
              backendKind: 'nanohost',
              targetId: backendSession.runtimeTargetId,
              allocationRef: submittedAttempt.bindingRef,
            }
          ),
        }
      );
      const inputSnapshots = buildWorkspaceInputSnapshots({
        backendCapabilities: environmentPackage.backend.requiredCapabilities,
        backendKind: 'openshell',
        createdAt: '2026-06-16T00:00:01.000Z',
        environmentPackage,
      });
      const materializations = buildWorkspaceMaterializationRecords({
        createdAt: '2026-06-16T00:00:01.000Z',
        inputSnapshots,
        materialization: {
          backendKind: 'openshell',
          backendStatus: { health: 'ready', version: '0.0.80' },
          packageSnapshotId: environmentPackage.snapshotId,
          requiredCapabilities: environmentPackage.backend.requiredCapabilities,
          sandbox: { name: 'sandbox_final_status_workspace', state: 'created' },
          workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
            id: input.id,
            target: input.target,
          })),
        },
      });
      recordWorkspaceInputSnapshots(workspaceDb, inputSnapshots);
      recordWorkspaceMaterializationRecords(workspaceDb, materializations);
      await markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId: backendLeaseId });
      await endWorkerTurnMaterialization(store, workspaceDb, lineage.turnId, 'completed', [
        backendSession.backendSessionId,
      ]);
      const delivery = await beginWorkerTurnJournalStep(
        store,
        workspaceDb,
        lineage.turnId,
        'deliver-start',
        undefined,
        submittedAttempt
      );
      attemptActionOwners.acceptSchedulerExecutionObservation(coreDb, {
        ...attemptActionOwners.schedulerExecutionCorrelation(submittedAttempt),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      });
      await endWorkerTurnJournalStep(store, workspaceDb, delivery, 'completed', [
        submittedAttempt.operationId!,
      ]);
      bindNanoHostAttemptRouteTokenHashes(coreDb, {
        attemptId: testEntityId('attempt', `lease_${fixtureSuffix}`),
        sandboxBindingRef: binding,
        workerCapabilityTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'capability')),
        workerControlTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'worker-control')),
        workerInferenceTokenHash: hashWorkerRouteToken(workerRouteToken(binding, 'inference')),
      });
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const app = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const request = {
        body: JSON.stringify({
          body: { status: 'completed', stopReason: 'completed' },
          lineage,
          operation: 'final_status',
          schemaVersion: 2,
          sequence: 7,
        }),
        headers: {
          authorization: `Bearer ${workerRouteToken(binding, 'worker-control')}`,
          'content-type': 'application/json',
        },
        method: 'POST' as const,
      };
      const absoluteDeadline = absoluteAttemptDeadline(coreDb, lineage.turnId);
      const pendingHandles = listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId);
      expect(pendingHandles).toEqual([expect.objectContaining({ cleanupStatus: 'pending' })]);
      const response = await app.request('/api/worker-control/final-status', request);

      expect(response.status).toBe(200);
      expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual(pendingHandles);

      const restartedGateway = createDefaultWorkerControlGateway(coreDb);
      const restartedApp = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: restartedGateway,
      });
      expect(absoluteAttemptDeadline(coreDb, lineage.turnId)).toBe(absoluteDeadline);
      const replay = await restartedApp.request('/api/worker-control/final-status', request);

      expect(absoluteAttemptDeadline(coreDb, lineage.turnId)).toBe(absoluteDeadline);
      expect(replay.status).toBe(200);
      expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual(pendingHandles);

      await markWorkerControlBackendSessionCleaned(coreDb, backendLeaseId);
      const releasingLease = requireNanoHostExecutionAttempt(
        coreDb,
        testEntityId('attempt', 'lease_final_status_workspace')
      );
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: releasingLease.attemptId,

        firstTerminalCause: 'worker-final-status',
      });
      const reconcileAcceptedFinalStatus = vi.fn(
        async (session: NonNullable<ReturnType<typeof getWorkerBackendSession>>) => {
          expect(session.attemptId).toBe(backendLeaseId);
          expect(session.state).toBe('cleaned');
          // This transport fixture has no physical worker; the normal terminal callback settles its actual Workspace projection before modeled release.
          const completedAt = session.physicalCleanedAt!;
          const collection = await beginWorkerTurnJournalStep(
            store,
            workspaceDb,
            lineage.turnId,
            'collect'
          );
          const projection = await projectWorkerBackendCleanup(workspaceDb, {
            agentSessionId: lineage.agentSessionId,
            backendType: session.backendKind,
            backendVersion: session.backendVersion,
            completedAt,
            outcome: 'succeeded',
            backendSessionId: 'sandbox_final_status_workspace',
            environmentPackage,
            packageSnapshotId: lineage.packageSnapshotId,
            placement: 'local',
            threadId: lineage.threadId,
            turnId: lineage.turnId,
            workerImage: environmentPackage.runtime.image.ref,
            workspaceHandoffState: 'complete',
            workspaceId: lineage.workspaceId,
          });
          expect(projection.workspaceHandoffComplete).toBe(true);
          await endWorkerTurnJournalStep(store, workspaceDb, collection, 'completed', [
            projection.evidence.id,
          ]);
          await store.updateAgentSession(lineage.agentSessionId, {
            status: 'idle',
            message: null,
            updatedAt: completedAt,
          });
          const terminal = await store.completeTurn(
            lineage.turnId,
            {
              agentId: environmentPackage.agent.agentId,
              agentSessionId: lineage.agentSessionId,
              status: 'completed',
              completedAt,
            },
            {
              requestId: lineage.requestId,
              stopReason: 'completed',
              ...(await workerTurnTerminalPublication(workspaceDb, lineage.turnId)),
            }
          );
          // Reuse the exact completion event already committed by the terminal owner.
          const terminalEvent = await store.persistTurnEvent(lineage.turnId, {
            event: 'turn.completed',
            requestId: lineage.requestId,
            workspaceId: lineage.workspaceId,
            threadId: lineage.threadId,
            turnId: lineage.turnId,
            data: { type: 'turn-completed', stopReason: 'completed', turn: terminal },
          });
          store.emitTurnEvent(lineage.turnId, terminalEvent);
          const closedAttempt = await closeOwnedExecutionAttempt(coreDb, {
            attemptId: session.attemptId,
            firstTerminalCause: 'turn-completed',
            outcome: `turn:${lineage.turnId}:completed`,
          });
          await endWorkerTurnJournalRelease(
            store,
            workspaceDb,
            lineage.turnId,
            closedAttempt.fenceRef!
          );
        }
      );
      await runNanoHostAttemptRecoveryMaintenance(coreDb, {
        executionBackend: new SimulatedTurnExecutor({ coreDb }),
        now: () => new Date(Date.parse(releasingLease.deadline!) + 1).toISOString(),
        cleanupBackendSession: vi.fn(async () => {}),
        reconcileExecutions: async () => {},
        prepareBackendCleanup: vi.fn(() => false),
        restoreBackendSession: vi.fn(async () => {}),
        projectRecoveredTurn: vi.fn(async () => ({ status: 'interrupted' as const })),
        reconcileAcceptedFinalStatus,
      });
      expect(reconcileAcceptedFinalStatus).toHaveBeenCalledTimes(1);
      expect(listBackendWorkspaceHandles(workspaceDb, lineage.workspaceId)).toEqual([
        expect.objectContaining({ cleanupStatus: 'cleaned' }),
      ]);
      expect(listWorkspaceReconciliationRecords(workspaceDb, lineage.workspaceId)).toEqual([]);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) =>
            attempt.attempt_id === testEntityId('attempt', 'lease_final_status_workspace')
        )?.phase
      ).toBe('closed');
    } finally {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(coreDb.dataRoot);
      preparedWorkspaceDb?.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });

  it('replays only exact final status while its lease is releasing', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-replay-')));

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage, store, workspaceMutationAdmission } =
        await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'final_status_replay'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const app = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: gateway,
      });
      const authorization = `Bearer ${workerRouteToken(binding, 'worker-control')}`;
      const finalStatusBody = JSON.stringify({
        body: { status: 'completed', stopReason: 'completed' },
        lineage,
        operation: 'final_status',
        schemaVersion: 2,
        sequence: 7,
      });
      const accepted = await app.request('/api/worker-control/final-status', {
        body: finalStatusBody,
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(accepted.status).toBe(200);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === testEntityId('attempt', 'lease_final_status_replay')
        )?.phase
      ).toBe('closing');

      const sameProcessReplay = await app.request('/api/worker-control/final-status', {
        body: finalStatusBody,
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const restartedGateway = createDefaultWorkerControlGateway(coreDb);
      const restartedApp = createApp({
        workspaceMutationAdmission,
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: restartedGateway,
      });
      const restartedReplay = await restartedApp.request('/api/worker-control/final-status', {
        body: finalStatusBody,
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const rejectedEventAppend = await restartedApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: {
              data: {
                evidenceManifestDigests: {},
                status: 'completed',
                stopReason: 'completed',
              },
              type: 'turn.completed',
            },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 7,
          },
        }),
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const acceptedRecords = coreDb.sqlite
        .prepare(
          `SELECT operation, COUNT(*) AS count
             FROM worker_control_records
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
            GROUP BY operation
            ORDER BY operation`
        )
        .all(lineage.turnId);
      const acceptedFingerprints = coreDb.sqlite
        .prepare(
          `SELECT operation, COUNT(*) AS count
             FROM worker_control_sequence_fingerprints
            WHERE turn_id = ? AND operation IN ('event_append', 'final_status')
            GROUP BY operation
            ORDER BY operation`
        )
        .all(lineage.turnId);

      expect.soft(sameProcessReplay.status).toBe(200);
      expect.soft(restartedReplay.status).toBe(200);
      expect(rejectedEventAppend.status).not.toBe(200);
      expect.soft(acceptedRecords).toEqual([
        { count: 1, operation: 'event_append' },
        { count: 1, operation: 'final_status' },
      ]);
      expect.soft(acceptedFingerprints).toEqual([
        { count: 1, operation: 'event_append' },
        { count: 1, operation: 'final_status' },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts supply refresh acknowledgements through the control envelope', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, environmentPackage, gateway, lineage, token } =
      await createWorkerControlRouteFixture([], coreDb);

    const res = await app.request('/api/worker-control/supply-refresh-ack', {
      body: JSON.stringify({
        body: {
          refreshId: 'refresh_1',
          status: 'applied',
        },
        lineage,
        operation: 'supply_refresh_ack',
        schemaVersion: 2,
        sequence: 8,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { supplyRefreshAck: { refreshId: string; status: string } };

    expect(res.status).toBe(200);
    expect(body.supplyRefreshAck).toMatchObject({
      refreshId: 'refresh_1',
      status: 'applied',
    });
    const invalidOperation = await app.request('/api/worker-control/supply-refresh-ack', {
      body: JSON.stringify({
        body: { refreshId: 'refresh_2', status: 'applied' },
        lineage,
        operation: 'final_status',
        schemaVersion: 2,
        sequence: 9,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(invalidOperation.status).toBe(400);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.supplyRefreshAcks).toEqual([
      expect.objectContaining({ refreshId: 'refresh_1', status: 'applied' }),
    ]);
  });

  it('retains accepted supply refresh acknowledgement evidence in Core', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-supply-refresh-ack-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Supply refresh thread'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Control worker',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: testEntityId('as', 'session_supply_refresh'),
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_supply_refresh',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const gateway = createDefaultWorkerControlGateway(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        profileRef: environmentPackage.agent.profileId,
        queueEntryId: 'queue_supply_refresh',
        requestedAgentId: environmentPackage.agent.agentId,
        threadId: lineage.threadId,
        turnId: lineage.turnId,
        turnInput: 'Run supply refresh worker',
        workspaceId: lineage.workspaceId,
      });
      const submittedAttempt = recordTestExecutionAttempt(coreDb, {
        entry: requireSchedulerAdmissionEntry(coreDb, 'queue_supply_refresh'),
        attemptId: testEntityId('attempt', 'lease_supply_refresh'),
        agentSessionId: lineage.agentSessionId,
        inputRef: lineage.packageSnapshotId,
        bindingRef: 'lease-binding:lease_supply_refresh',
        sessionCompatibilityKey: 'fixture-compatibility',
        now: () => new Date().toISOString(),
        operationId: `fixture-submit:${String(testEntityId('attempt', 'lease_supply_refresh'))}`,
      });
      attemptActionOwners.acceptSchedulerExecutionObservation(coreDb, {
        ...attemptActionOwners.schedulerExecutionCorrelation(submittedAttempt),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      });
      bindNanoHostAttemptRouteTokenHashes(coreDb, {
        attemptId: testEntityId('attempt', 'lease_supply_refresh'),
        sandboxBindingRef: 'lease-binding:lease_supply_refresh',
        workerCapabilityTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_supply_refresh', 'capability')
        ),
        workerControlTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_supply_refresh', 'worker-control')
        ),
        workerInferenceTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_supply_refresh', 'inference')
        ),
      });
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        'lease-binding:lease_supply_refresh'
      );
      const app = createApp({ coreDb, mode: 'server', store, workerControlGateway: gateway });

      const res = await app.request('/api/worker-control/supply-refresh-ack', {
        body: JSON.stringify({
          body: {
            refreshId: 'refresh_safe_1',
            status: 'applied',
          },
          lineage,
          operation: 'supply_refresh_ack',
          schemaVersion: 2,
          sequence: 4,
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const durableAck = coreDb.sqlite
        .prepare(
          "SELECT record_json AS recordJson FROM worker_control_records WHERE turn_id = ? AND operation = 'supply_refresh_ack'"
        )
        .get(lineage.turnId) as { recordJson: string };
      expect(JSON.parse(durableAck.recordJson)).toMatchObject({
        refreshId: 'refresh_safe_1',
        status: 'applied',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts capability summaries through the control envelope', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, environmentPackage, gateway, lineage, token } =
      await createWorkerControlRouteFixture([], coreDb);

    const res = await app.request('/api/worker-control/capability-summary', {
      body: JSON.stringify({
        body: {
          capabilityCallId: testEntityId('cap', 'capability_1'),
          diagnostics: [],
          family: 'knowledge.search',
          inputSummary: 'Search project knowledge.',
          lineage,
          outputSummary: 'Returned one entry.',
          schemaVersion: 1,
          sequence: 10,
          status: 'succeeded',
        },
        lineage,
        operation: 'capability_summary',
        schemaVersion: 2,
        sequence: 10,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      response: { accepted: boolean; nextExpectedSequence: number };
    };

    expect(res.status).toBe(200);
    expect(body.response).toMatchObject({
      accepted: true,
      nextExpectedSequence: 11,
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.capabilitySummaries).toEqual([
      expect.objectContaining({
        capabilityCallId: testEntityId('cap', 'capability_1'),
        status: 'succeeded',
      }),
    ]);
  });

  it('rejects oversized simple control requests before sandbox authentication', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, lineage } = await createWorkerControlRouteFixture([], coreDb);
    const padding = 'x'.repeat(70 * 1024);
    const requests = [
      {
        body: {
          schemaVersion: 2,
          lineage,
          sequence: 1,
          operation: 'supply_refresh_ack',
          body: { refreshId: 'refresh_oversized', status: 'applied' },
          futureNote: padding,
        },
        path: '/api/worker-control/supply-refresh-ack',
      },
      {
        body: heartbeatEnvelope(lineage, 1, 'running', padding),
        path: '/api/worker-control/heartbeat',
      },
      {
        body: {
          artifact: { path: padding, title: 'Oversized artifact' },
          lineage,
          sequence: 1,
        },
        path: '/api/worker-control/artifacts',
      },
    ];
    const results = await Promise.all(
      requests.map(async ({ body, path }) => {
        const response = await app.request(path, {
          body: JSON.stringify(body),
          headers: {
            authorization: 'Bearer invalid',
            'content-type': 'application/json',
          },
          method: 'POST',
        });

        return {
          body: (await response.json()) as { code: string },
          status: response.status,
        };
      })
    );

    expect(results).toEqual(
      requests.map(() => ({
        body: expect.objectContaining({ code: 'worker_control_payload_too_large' }),
        status: 413,
      }))
    );
  });

  it('accepts sandbox bearer heartbeats without a browser session cookie', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, gateway, lineage, token } = await createWorkerControlRouteFixture([], coreDb);

    const res = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.')),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    // Worker Control Protocol: the ACK is descriptive; only the attempt owns liveness.
    expect(body).toEqual({
      schemaVersion: 2,
      accepted: true,
      nextExpectedSequence: 2,
      diagnostics: [],
    });
    expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toMatchObject({
      lastHeartbeatAt: '2026-06-16T00:00:02.000Z',
      status: 'running',
    });
  });

  it('accepts worker artifact notices over HTTP', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, lineage, token } = await createWorkerControlRouteFixture([], coreDb);

    const res = await app.request('/api/worker-control/artifacts', {
      body: JSON.stringify({
        artifact: {
          mediaType: 'text/markdown',
          path: '/openkit/artifacts/report.md',
          title: 'Worker report',
        },
        lineage,
        sequence: 2,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      artifact: { path: string; title: string };
    };

    expect(res.status).toBe(200);
    expect(body.artifact).toMatchObject({
      path: '/openkit/artifacts/report.md',
      title: 'Worker report',
    });
  });

  it('retains Artifact notice digest and collection hint across the real client route and durable restart replay', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-notice-carriage-'));
    let coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const fixture = await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: fixture.lineage.workspaceId,
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        fixture.environmentPackage,
        fixture.lineage,
        'artifact_notice_carriage'
      );
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = registerDurableWorkerControlSession(
        gateway,
        fixture.environmentPackage,
        binding
      );
      let app = createApp({
        coreDb,
        mode: 'server',
        store: fixture.store,
        workerControlGateway: gateway,
        workspaceMutationAdmission: fixture.workspaceMutationAdmission,
      });
      const client = new WorkerControlClient({
        baseUrl: 'http://core/api/worker-control',
        token: registration.token,
        lineage: fixture.lineage,
        fetch: (url, init) => app.request(url, init),
      });
      const artifact = {
        path: 'reports/result.md',
        title: 'Worker report',
        mediaType: 'text/markdown',
        digest: `sha256:${'ab'.repeat(32)}`,
        collectionHint: 'Collect reports/re\u0301sume\u0301.md; preserve  two spaces.\n',
      };
      const notice = { sequence: 2, artifact };
      const canonicalArtifacts = fixture.store.listArtifacts(fixture.lineage.workspaceId);
      const first = await client.recordArtifactNotice(notice);
      // S03 artifact_notice metadata is descriptive carriage, not canonical Artifact admission.
      expect.soft(first).toMatchObject({ artifact });
      expect
        .soft(gateway.getSessionSnapshot(fixture.lineage.packageSnapshotId)?.artifacts)
        .toEqual([expect.objectContaining(artifact)]);
      const records = () =>
        coreDb.sqlite
          .prepare(
            "SELECT record_json AS recordJson FROM worker_control_records WHERE operation='artifact_notice' AND package_snapshot_id=?"
          )
          .all(fixture.lineage.packageSnapshotId) as { recordJson: string }[];
      const acceptedRows = records();
      expect(acceptedRows).toHaveLength(1);
      expect.soft(JSON.parse(acceptedRows[0]!.recordJson)).toMatchObject(artifact);

      closeWorkspaceProductReadHandles(dataRoot);
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      const restartedGateway = createDefaultWorkerControlGateway(coreDb);
      app = createApp({
        coreDb,
        mode: 'server',
        store: fixture.store,
        workerControlGateway: restartedGateway,
        workspaceMutationAdmission: fixture.workspaceMutationAdmission,
      });
      expect
        .soft(restartedGateway.getSessionSnapshot(fixture.lineage.packageSnapshotId)?.artifacts)
        .toEqual([expect.objectContaining(artifact)]);
      expect(await client.recordArtifactNotice(notice)).toEqual(first);
      // Both descriptive values remain part of the original same-sequence request fingerprint.
      for (const changed of [
        { digest: `sha256:${'cd'.repeat(32)}` },
        { collectionHint: `${artifact.collectionHint}changed` },
      ]) {
        const result = await client
          .recordArtifactNotice({ ...notice, artifact: { ...artifact, ...changed } })
          .then(
            () => null,
            (error: unknown) => error
          );
        expect
          .soft(result)
          .toMatchObject({ status: 409, code: 'worker_control_sequence_conflict' });
      }
      expect(records()).toEqual(acceptedRows);
      expect(
        restartedGateway.getSessionSnapshot(fixture.lineage.packageSnapshotId)?.artifacts
      ).toHaveLength(1);
      expect(fixture.store.listArtifacts(fixture.lineage.workspaceId)).toEqual(canonicalArtifacts);
    } finally {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('retries durable heartbeat acceptance after the transaction fails beyond its callback', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-heartbeat-transaction-tail-'));
    const coreDb = openCoreDb(dataRoot);
    const injectedFailure = new Error('injected heartbeat transaction tail failure');
    let failAfterCallback = true;

    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage } = await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: lineage.workspaceId,
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'heartbeat_transaction_tail'
      );
      const gateway = new WorkerControlGateway({
        resolveTokenBinding: (input) => resolveNanoHostAttemptTokenBinding(coreDb, input),
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
        onHeartbeatAccepted: (input) => {
          acceptNanoHostAttemptHeartbeatByBinding(coreDb, {
            acceptedAt: input.heartbeat.lastHeartbeatAt,
            lineage: input.lineage,
            sandboxBindingRef: input.sandboxBindingRef,
            workerSequence: input.heartbeat.sequence,
          });
        },
        runHeartbeatTransaction: (operation) =>
          coreDb.sqlite.transaction(() => {
            const acknowledgement = operation();
            // The callback succeeded, but this transaction must still roll back before COMMIT.
            if (failAfterCallback) {
              failAfterCallback = false;
              throw injectedFailure;
            }
            return acknowledgement;
          })(),
      });
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
      const request = {
        authorization: `Bearer ${registration.token}`,
        ...heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.'),
      };
      const attemptId = testEntityId('attempt', 'lease_heartbeat_transaction_tail');
      const before = requireNanoHostExecutionAttempt(coreDb, attemptId);
      const fingerprints = () =>
        coreDb.sqlite
          .prepare(`SELECT fingerprint FROM worker_control_sequence_fingerprints
            WHERE agent_session_id = ? AND package_snapshot_id = ? AND operation = 'heartbeat'`)
          .all(lineage.agentSessionId, lineage.packageSnapshotId);

      const firstResult = (() => {
        try {
          return gateway.recordHeartbeat(request);
        } catch (error) {
          return error;
        }
      })();
      expect(firstResult).toBe(injectedFailure);
      expect(fingerprints()).toEqual([]);
      expect(requireNanoHostExecutionAttempt(coreDb, attemptId)).toEqual(before);

      expect(gateway.recordHeartbeat(request)).toEqual({
        schemaVersion: 2,
        accepted: true,
        nextExpectedSequence: 2,
        diagnostics: [],
      });
      // Exact-request acceptance must be durable; a process-local retry cache grants no success.
      expect.soft(fingerprints()).toHaveLength(1);
      const afterRetry = requireNanoHostExecutionAttempt(coreDb, attemptId);
      expect.soft(afterRetry).toMatchObject({
        lastWorkerSequence: 1,
        lastAcceptedHeartbeatAt: expect.any(String),
      });
      expect.soft(afterRetry.heartbeatDeadline).not.toBe(before.heartbeatDeadline);
    } finally {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'ordinary',
    'reconnect',
  ] as const)('keeps the native %s heartbeat tuple and memory unchanged on UPDATE and outer COMMIT failure', async (kind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-heartbeat-native-rollback-'));
    const coreDb = openCoreDb(dataRoot);
    const gate = new Int32Array(new SharedArrayBuffer(12));
    await shutdownControlStoreWorkerClient();
    heartbeatNativeInterception.gate = gate.buffer as SharedArrayBuffer;
    heartbeatNativeInterception.corePath = coreDbPath(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const fixture = await createWorkerControlRouteFixture([], coreDb);
      const { environmentPackage, lineage } = fixture;
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: lineage.workspaceId,
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        `heartbeat_native_${kind}`
      );
      const attemptId = testEntityId('attempt', `lease_heartbeat_native_${kind}`);
      const backendAttemptId = await recordWorkerControlBackendSession(
        coreDb,
        environmentPackage,
        lineage,
        binding,
        `sandbox-heartbeat-native-${kind}`
      );
      await transitionWorkerBackendSessionState(coreDb, {
        attemptId: backendAttemptId,
        fromState: 'materializing',
        toState: 'materialized',
      });
      await transitionWorkerBackendSessionState(coreDb, {
        attemptId: backendAttemptId,
        fromState: 'materialized',
        toState: 'launching',
      });
      await markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId: backendAttemptId });
      let gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
      const authorization = `Bearer ${registration.token}`;
      const reconnectKey = createHash('sha256')
        .update(`native-process-${kind}`)
        .digest('base64url');
      const processKeyHash = createHash('sha256')
        .update(Buffer.from(reconnectKey, 'base64url'))
        .digest('base64url');
      await gateway.recordHeartbeat({
        authorization,
        ...heartbeatEnvelope(lineage, 0, 'starting', null, processKeyHash),
      });
      await gateway.recordHeartbeat({
        authorization,
        ...heartbeatEnvelope(lineage, 1, 'running', 'Before the fault.'),
      });
      if (kind === 'reconnect') {
        // Worker Control restart adoption requires accepted sequence one before recovery can arm.
        const restoreBackendSession = vi.fn(async () => {});
        await classifyNanoHostAttemptsAfterRestart(coreDb, {
          store: fixture.store,
          executionBackend: new SimulatedTurnExecutor({ coreDb }),
          reconcileExecutions: async () => {},
          cleanupBackendSession: vi.fn(),
          prepareBackendCleanup: vi.fn(() => false),
          restoreBackendSession,
          reconcileAcceptedFinalStatus: vi.fn(),
          projectRecoveredTurn: vi.fn(),
        });
        expect(restoreBackendSession).toHaveBeenCalledOnce();
        expect(requireNanoHostExecutionAttempt(coreDb, attemptId)).toMatchObject({
          phase: 'open',
          recoveryState: 'awaiting-reconnect',
          recoveryDeadline: expect.any(String),
        });
        gateway = createDefaultWorkerControlGateway(coreDb);
        registerDurableWorkerControlSession(gateway, environmentPackage, binding);
      }
      const before = requireNanoHostExecutionAttempt(coreDb, attemptId);
      // Both proofs hash their decoded bytes; the route digest is hex and the process digest is base64url.
      expect(before.workerControlTokenHash).toBe(
        createHash('sha256').update(Buffer.from(registration.token, 'base64url')).digest('hex')
      );
      expect(before.workerProcessKeyHash).toBe(processKeyHash);
      const memoryBefore = gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat;
      const fingerprints = () =>
        coreDb.sqlite
          .prepare(
            `SELECT sequence, fingerprint FROM worker_control_sequence_fingerprints
           WHERE package_snapshot_id = ? AND operation = 'heartbeat' ORDER BY sequence`
          )
          .all(lineage.packageSnapshotId);
      const fingerprintsBefore = fingerprints();
      const heartbeatRows = () =>
        coreDb.sqlite
          .prepare("SELECT record_json FROM worker_control_records WHERE operation = 'heartbeat'")
          .all();
      const request = {
        authorization,
        ...heartbeatEnvelope(lineage, 2, 'running', 'After the fault.'),
        ...(kind === 'reconnect' ? { reconnectKey } : {}),
      };
      coreDb.sqlite.exec(`
          CREATE TRIGGER reject_native_heartbeat_acceptance
          BEFORE UPDATE ON scheduler_execution_attempts
          WHEN NEW.attempt_id = '${attemptId}' AND NEW.last_worker_sequence = 2
          BEGIN SELECT RAISE(ABORT, 'injected native heartbeat UPDATE failure'); END
        `);
      coreDb.sqlite.pragma('query_only = ON');
      expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
      await expect(gateway.recordHeartbeat(request)).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      // Storage complete-tuple rule also rolls back adoption when later liveness fails.
      expect(requireNanoHostExecutionAttempt(coreDb, attemptId)).toEqual(before);
      expect(fingerprints()).toEqual(fingerprintsBefore);
      expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toEqual(
        memoryBefore
      );
      expect(heartbeatRows()).toEqual([]);
      coreDb.sqlite.pragma('query_only = OFF');
      coreDb.sqlite.exec('DROP TRIGGER reject_native_heartbeat_acceptance');
      coreDb.sqlite.pragma('query_only = ON');

      armHeartbeatNativeCommit(gate, 1);
      await expect(gateway.recordHeartbeat(request)).rejects.toMatchObject({
        code: 'commit-unknown',
        commit: 'unknown',
      });
      expect(Atomics.load(gate, 1)).toBe(1);
      expect(requireNanoHostExecutionAttempt(coreDb, attemptId)).toEqual(before);
      expect(fingerprints()).toEqual(fingerprintsBefore);
      expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toEqual(
        memoryBefore
      );
      expect(heartbeatRows()).toEqual([]);

      // Native COMMIT failure poisons the owner. Inspect absence before explicit reopen and retry.
      await shutdownControlStoreWorkerClient();
      const scope = nativeProductScope(dataRoot, { kind: 'server' });
      // Finish any opening/migration transaction before holding the heartbeat's own COMMIT.
      await getControlStoreWorkerClient().open({
        database: `core:${scope.path}`,
        path: scope.path,
        dataRoot,
        create: false,
        initialize: 'core',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      armHeartbeatNativeCommit(gate, 2);
      let settled = false;
      const retry = Promise.resolve()
        .then(() => gateway.recordHeartbeat(request))
        .then(
          (ack) => {
            settled = true;
            return { ack };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          }
        );
      await waitForHeartbeatNativeObservation(() => Atomics.load(gate, 1) === 1 || settled);
      expect(Atomics.load(gate, 1)).toBe(1);
      expect(settled).toBe(false);
      expect(requireNanoHostExecutionAttempt(coreDb, attemptId)).toEqual(before);
      expect(fingerprints()).toEqual(fingerprintsBefore);
      expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toEqual(
        memoryBefore
      );
      releaseHeartbeatNativeCommit(gate);
      expect(await retry).toEqual({
        ack: { schemaVersion: 2, accepted: true, nextExpectedSequence: 3, diagnostics: [] },
      });
      expect(fingerprints()).toHaveLength(fingerprintsBefore.length + 1);
      const accepted = requireNanoHostExecutionAttempt(coreDb, attemptId);
      expect(accepted).toMatchObject({
        phase: 'open',
        lastWorkerSequence: 2,
        lastAcceptedHeartbeatAt: expect.any(String),
        recoveryState: null,
        recoveryDeadline: null,
        workerProcessKeyHash: processKeyHash,
      });
      expect(accepted.heartbeatDeadline).not.toBe(before.heartbeatDeadline);
      expect(accepted.deadline).toBe(before.deadline);
      expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toMatchObject({
        sequence: 2,
        message: 'After the fault.',
      });
      expect(heartbeatRows()).toEqual([]);
      // Raw process keys and route tokens never enter retained heartbeat evidence.
      expect(JSON.stringify(fingerprints())).not.toContain(reconnectKey);
      expect(JSON.stringify(fingerprints())).not.toContain(registration.token);
    } finally {
      releaseHeartbeatNativeCommit(gate);
      await shutdownControlStoreWorkerClient();
      heartbeatNativeInterception.gate = undefined;
      vi.useRealTimers();
      closeWorkspaceProductReadHandles(dataRoot);
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses a heartbeat queued behind native attempt revocation using current Core authority', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-heartbeat-native-authority-'));
    const coreDb = openCoreDb(dataRoot);
    const gate = new Int32Array(new SharedArrayBuffer(12));
    await shutdownControlStoreWorkerClient();
    heartbeatNativeInterception.gate = gate.buffer as SharedArrayBuffer;
    heartbeatNativeInterception.corePath = coreDbPath(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const { environmentPackage, lineage } = await createWorkerControlRouteFixture([], coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: lineage.workspaceId,
        ownerUserId: LOCAL_USER_ID,
      });
      const binding = await createDurableWorkerControlLease(
        coreDb,
        environmentPackage,
        lineage,
        'heartbeat_native_authority'
      );
      const attemptId = testEntityId('attempt', 'lease_heartbeat_native_authority');
      const gateway = createDefaultWorkerControlGateway(coreDb);
      const registration = registerDurableWorkerControlSession(
        gateway,
        environmentPackage,
        binding
      );
      const authorization = `Bearer ${registration.token}`;
      await gateway.recordHeartbeat({ authorization, ...heartbeatEnvelope(lineage, 1, 'running') });
      const before = requireNanoHostExecutionAttempt(coreDb, attemptId);
      const memoryBefore = gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat;
      const fingerprints = () =>
        coreDb.sqlite
          .prepare(
            `SELECT sequence, fingerprint FROM worker_control_sequence_fingerprints
         WHERE package_snapshot_id = ? AND operation = 'heartbeat' ORDER BY sequence`
          )
          .all(lineage.packageSnapshotId);
      const fingerprintsBefore = fingerprints();
      coreDb.sqlite.pragma('query_only = ON');
      expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
      armHeartbeatNativeCommit(gate, 2);
      const closing = getControlStoreWorkerClient().executionAttempt(
        `core:${coreDbPath(dataRoot)}`,
        { kind: 'closing', attemptId, cause: 'native-heartbeat-authority-race' }
      );
      await waitForHeartbeatNativeObservation(() => Atomics.load(gate, 1) === 1);
      // Main still sees open authority while the earlier native revocation waits before COMMIT.
      expect(requireNanoHostExecutionAttempt(coreDb, attemptId)).toEqual(before);
      const postedBefore = heartbeatNativeInterception.postedHeartbeats;
      let settled = false;
      const heartbeat = Promise.resolve()
        .then(() =>
          gateway.recordHeartbeat({
            authorization,
            ...heartbeatEnvelope(lineage, 2, 'running', 'Queued before revocation ACK.'),
          })
        )
        .then(
          (ack) => {
            settled = true;
            return { ack };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          }
        );
      await waitForHeartbeatNativeObservation(
        () => heartbeatNativeInterception.postedHeartbeats === postedBefore + 1 || settled
      );
      expect(heartbeatNativeInterception.postedHeartbeats).toBe(postedBefore + 1);
      expect(settled).toBe(false);
      expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toEqual(
        memoryBefore
      );
      releaseHeartbeatNativeCommit(gate);
      expect(await closing).toMatchObject({
        phase: 'closing',
        terminalCause: 'native-heartbeat-authority-race',
      });
      expect(await heartbeat).toMatchObject({
        error: { code: 'worker_control_lease_not_live', status: 403 },
      });
      const revoked = requireNanoHostExecutionAttempt(coreDb, attemptId);
      expect(revoked).toMatchObject({
        phase: 'closing',
        lastWorkerSequence: before.lastWorkerSequence,
        lastAcceptedHeartbeatAt: before.lastAcceptedHeartbeatAt,
        heartbeatDeadline: before.heartbeatDeadline,
      });
      expect(fingerprints()).toEqual(fingerprintsBefore);
      expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toEqual(
        memoryBefore
      );
      expect(
        coreDb.sqlite
          .prepare("SELECT record_json FROM worker_control_records WHERE operation = 'heartbeat'")
          .all()
      ).toEqual([]);
    } finally {
      releaseHeartbeatNativeCommit(gate);
      await shutdownControlStoreWorkerClient();
      heartbeatNativeInterception.gate = undefined;
      closeWorkspaceProductReadHandles(dataRoot);
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('replays the heartbeat ACK after database reopen without a retained heartbeat or liveness renewal', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-rebuild-'));
    let coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceMutationAdmission = new WorkspaceMutationAdmission();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Rebuild worker session'
    );
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Control worker',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: testEntityId('as', 'session_rebuild'),
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_rebuild',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    try {
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        ownerUserId: LOCAL_USER_ID,
      });
      const firstGateway = createDefaultWorkerControlGateway(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        profileRef: environmentPackage.agent.profileId,
        queueEntryId: 'queue_rebuild',
        requestId: lineage.requestId,
        requestedAgentId: environmentPackage.agent.agentId,
        threadId: lineage.threadId,
        turnId: lineage.turnId,
        turnInput: 'Run worker control rebuild test',
        workspaceId: lineage.workspaceId,
      });
      const submittedAttempt = recordTestExecutionAttempt(coreDb, {
        entry: requireSchedulerAdmissionEntry(coreDb, 'queue_rebuild'),
        attemptId: testEntityId('attempt', 'lease_rebuild'),
        agentSessionId: lineage.agentSessionId,
        inputRef: lineage.packageSnapshotId,
        bindingRef: 'lease-binding:lease_rebuild',
        sessionCompatibilityKey: 'fixture-compatibility',
        now: () => new Date().toISOString(),
        operationId: `fixture-submit:${String(testEntityId('attempt', 'lease_rebuild'))}`,
      });
      attemptActionOwners.acceptSchedulerExecutionObservation(coreDb, {
        ...attemptActionOwners.schedulerExecutionCorrelation(submittedAttempt),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      });
      bindNanoHostAttemptRouteTokenHashes(coreDb, {
        attemptId: testEntityId('attempt', 'lease_rebuild'),
        sandboxBindingRef: 'lease-binding:lease_rebuild',
        workerCapabilityTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_rebuild', 'capability')
        ),
        workerControlTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_rebuild', 'worker-control')
        ),
        workerInferenceTokenHash: hashWorkerRouteToken(
          workerRouteToken('lease-binding:lease_rebuild', 'inference')
        ),
      });

      const firstRegistration = registerDurableWorkerControlSession(
        firstGateway,
        environmentPackage,
        'lease-binding:lease_rebuild'
      );
      const firstApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: firstGateway,
        workspaceMutationAdmission,
      });

      const absoluteDeadline = absoluteAttemptDeadline(coreDb, lineage.turnId);
      const attemptId = testEntityId('attempt', 'lease_rebuild');
      const beforeHeartbeat = requireNanoHostExecutionAttempt(coreDb, attemptId);
      coreDb.sqlite.pragma('query_only = ON');
      expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
      const firstHeartbeatResponse = await firstApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.')),
        headers: {
          authorization: `Bearer ${firstRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const firstHeartbeatBody = await firstHeartbeatResponse.json();
      const acceptedAttempt = requireNanoHostExecutionAttempt(coreDb, attemptId);
      expect(firstHeartbeatResponse.status).toBe(200);
      expect.soft(firstHeartbeatBody).toEqual({
        schemaVersion: 2,
        accepted: true,
        nextExpectedSequence: 2,
        diagnostics: [],
      });
      expect(acceptedAttempt.lastWorkerSequence).toBe(1);
      expect(acceptedAttempt.lastAcceptedHeartbeatAt).not.toBeNull();
      expect(acceptedAttempt.lastAcceptedHeartbeatAt).not.toBe(
        beforeHeartbeat.lastAcceptedHeartbeatAt
      );
      expect(acceptedAttempt.heartbeatDeadline).not.toBe(beforeHeartbeat.heartbeatDeadline);
      const heartbeatRows = () =>
        coreDb.sqlite
          .prepare("SELECT record_json FROM worker_control_records WHERE operation = 'heartbeat'")
          .all();
      expect.soft(heartbeatRows()).toEqual([]);
      coreDb.sqlite.pragma('query_only = OFF');
      await firstApp.request('/api/worker-control/events/append', {
        body: JSON.stringify({
          lineage,
          record: {
            event: { data: { delta: 'hello', itemId: 'candidate_item_1' }, type: 'item.delta' },
            kind: 'event',
            lineage,
            schemaVersion: 1,
            sequence: 3,
          },
        }),
        headers: {
          authorization: `Bearer ${firstRegistration.token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);
      try {
        applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
        await recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: '2026-06-16T00:00:01.000Z',
          environmentPackage,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.parse(acceptedAttempt.lastAcceptedHeartbeatAt!) + 1_000));
      const rebuiltGateway = createDefaultWorkerControlGateway(coreDb);
      expect
        .soft(rebuiltGateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat)
        .toBeNull();
      const restartedApp = createApp({
        coreDb,
        mode: 'server',
        store,
        workerControlGateway: rebuiltGateway,
        workspaceMutationAdmission,
      });
      coreDb.sqlite.pragma('query_only = ON');
      expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
      const authorization = `Bearer ${workerRouteToken(
        'lease-binding:lease_rebuild',
        'worker-control'
      )}`;
      const retryHeartbeat = await restartedApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Worker is alive.')),
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const snapshot = rebuiltGateway.getSessionSnapshot(lineage.packageSnapshotId);
      const leaseAfterRetry = requireNanoHostExecutionAttempt(
        coreDb,
        testEntityId('attempt', 'lease_rebuild')
      );
      expect(absoluteAttemptDeadline(coreDb, lineage.turnId)).toBe(absoluteDeadline);
      expect(retryHeartbeat.status).toBe(200);
      expect.soft(await retryHeartbeat.json()).toEqual(firstHeartbeatBody);
      expect.soft(snapshot?.heartbeat).toBeNull();
      expect(leaseAfterRetry).toMatchObject({
        lastAcceptedHeartbeatAt: acceptedAttempt.lastAcceptedHeartbeatAt,
        heartbeatDeadline: acceptedAttempt.heartbeatDeadline,
        lastWorkerSequence: acceptedAttempt.lastWorkerSequence,
      });
      expect.soft(heartbeatRows()).toEqual([]);
      const conflict = await restartedApp.request('/api/worker-control/heartbeat', {
        body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running', 'Changed heartbeat.')),
        headers: { authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'worker_control_sequence_conflict' });
      expect(snapshot).toMatchObject({
        agentSessionId: testEntityId('as', 'session_rebuild'),
        events: [expect.objectContaining({ sequence: 3 })],
        heartbeat: null,
        packageSnapshotId: lineage.packageSnapshotId,
      });
    } finally {
      vi.useRealTimers();
      closeWorkspaceProductReadHandles(dataRoot);
      coreDb.sqlite.close();
    }
  });

  it('accepts canonical event append requests without a browser session cookie', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, environmentPackage, gateway, lineage, token } =
      await createWorkerControlRouteFixture([], coreDb);

    const res = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          event: {
            data: {
              delta: 'hello',
              itemId: 'candidate_item_1',
            },
            type: 'item.delta',
          },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 3,
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { accepted: boolean; nextExpectedSequence: number };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      nextExpectedSequence: 4,
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'item.delta' }),
        sequence: 3,
      }),
    ]);
  });

  it('rejects oversized event append requests before schema handling', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, lineage, token } = await createWorkerControlRouteFixture([], coreDb);

    const res = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          event: {
            data: {
              delta: 'x'.repeat(260 * 1024),
              itemId: 'candidate_item_oversized',
            },
            type: 'item.delta',
          },
          kind: 'event',
          lineage,
          schemaVersion: 1,
          sequence: 13,
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(413);
    expect(body.code).toBe('worker_control_payload_too_large');
  });

  it('projects event append sequence conflicts as worker-control API errors', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, lineage, token } = await createWorkerControlRouteFixture([], coreDb);
    const record = {
      event: {
        data: {
          delta: 'hello',
          itemId: 'candidate_item_1',
        },
        type: 'item.delta',
      },
      kind: 'event',
      lineage,
      schemaVersion: 1,
      sequence: 3,
    };

    await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({ lineage, record }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const res = await app.request('/api/worker-control/events/append', {
      body: JSON.stringify({
        lineage,
        record: {
          ...record,
          event: {
            data: {
              delta: 'different',
              itemId: 'candidate_item_1',
            },
            type: 'item.delta',
          },
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('worker_control_sequence_conflict');
  });

  it('rejects worker requests with invalid sandbox bearer tokens', async () => {
    const coreDb = createTestCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-route-')));
    workerControlCoreFixtures.push(coreDb);
    ensureLocalUser(coreDb);
    const { app, lineage } = await createWorkerControlRouteFixture([], coreDb);

    const res = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify(heartbeatEnvelope(lineage, 1, 'running')),
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe('worker_control_unauthorized');
  });

  it('authenticates only the worker-control token family', () => {
    const source = readFileSync(
      new URL('./runtime/worker-control-routes.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain('workerControlTokenHash');
    expect(source).toContain("tokenFamily: 'worker-control'");
    expect(source).not.toContain("tokenFamily: 'inference'");
  });
});

/** Closes this explicit no-process control fixture only after its six modeled barriers and exact simulator fence settle. */
async function closeOwnedExecutionAttempt(
  db: CoreDb,
  input: {
    readonly attemptId: string;
    readonly firstTerminalCause: string;
    readonly outcome?: string;
    readonly now?: () => string;
  }
) {
  const attempt = attemptActionOwners.markSchedulerExecutionAttemptClosing(db, {
    attemptId: input.attemptId,
    cause: input.firstTerminalCause,
    ...(input.outcome ? { outcomeRef: input.outcome } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const proof = {
    terminalHandoff: true,
    output: true,
    evidence: true,
    outsideWorkspaceCollection: true,
    integrationDrain: true,
    routesRevoked: true,
  } as const;
  const correlation = attemptActionOwners.schedulerExecutionCorrelation(attempt);
  const result = await new SimulatedTurnExecutor({ coreDb: db }).release({ ...correlation, proof });
  return attemptActionOwners.closeSchedulerExecutionAttemptWithFence(db, {
    correlation,
    proof,
    fenceRef: result.fenceRef!,
    ...(input.now ? { now: input.now } : {}),
  });
}

/** Calls the current attempt owner at the deciding action; the private API spelling is an adaptable test seam. */
function beginOwnedAttemptCloseout(
  db: ReturnType<typeof openCoreDb>,
  input: {
    readonly attemptId: string;
    readonly firstTerminalCause: string;
    readonly outcome?: string;
    readonly now?: () => string;
  }
) {
  const action = attemptActionOwners.markSchedulerExecutionAttemptClosing;
  expect(
    action,
    'The deciding action needs the current attempt owner, without a SessionLease compatibility action.'
  ).toBeTypeOf('function');
  return action(db, {
    attemptId: input.attemptId,
    cause: input.firstTerminalCause,
    ...(input.outcome ? { outcomeRef: input.outcome } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const coreDb of workerControlCoreFixtures.splice(0)) {
    closeWorkspaceProductReadHandles(coreDb.dataRoot);
    closeTestCoreDb(coreDb);
    rmSync(coreDb.dataRoot, { recursive: true, force: true });
  }
});
