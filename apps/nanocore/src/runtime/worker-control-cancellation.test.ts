import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { workspaceIdForOwner } from '@openkit/protocol';
import type { WorkerCanonicalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import type { AuthVariables } from '../auth/middleware.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { NanoHostWorkerRecoveryState } from '../storage/nanohost-recovery-native.js';
import { transitionAdmittedNanoHostRuntimeTarget } from '../storage/nanohost-transport-owner.js';
import { resolveAdmittedNanoHostFinalBinding } from '../storage/nanohost-worker-binding.js';
import { loadWorkspaceFileRecords } from '../storage/workspace-file-records.js';
import {
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { submitTestNanoHostWorkerLease } from '../test-support/nanohost-worker-lease.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createTestQueueEntry } from '../test-support/scheduler-admissions.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from './nanohost-attempt-recovery.js';
import { runSchedulerRestartRecovery } from './scheduler-restart-recovery.js';
import {
  getWorkerBackendSession,
  transitionWorkerBackendSessionState,
} from './worker-backend-session-records.js';
import { hashWorkerRouteToken, type WorkerControlLineage } from './worker-control-gateway.js';
import {
  canonicalStopReasonForAcceptedWorkerFinalStatus,
  getWorkerControlAcceptedFinalStatus,
} from './worker-control-records.js';
import { registerWorkerControlRoutes } from './worker-control-routes.js';

const ATTEMPT_ID = testEntityId('attempt', 'attempt_cancellation');
const BINDING = 'lease-binding:cancellation';
const CONTROL_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const INFERENCE_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CAPABILITY_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** Builds the real Core admission, Native binding, package ledger, and default gateway. */
async function createFixture() {
  // Native storage keeps its real clock; give each fixture the same current wall-time origin.
  const now = new Date(vi.getRealSystemTime()).toISOString();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-control-cancellation-'));
  let coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  });
  applyMigrations(coreDb);
  const nativeStorage = await openAdmittedTestNanoHost(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Cancel one exact worker Turn',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    await resolveAgentEnvironmentPackage({
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup: createTestAgentSetup(),
      agentSessionId: testEntityId('as', 'as_cancellation'),
      backend: { kind: 'openshell' },
      createdAt: new Date(Date.parse(now) - 6_000).toISOString(),
      requestId: 'req_cancellation',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      turn,
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  await store.createAgentSession({
    id: environmentPackage.scope.agentSessionId,
    agentId: environmentPackage.agent.agentId,
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    status: 'busy',
    message: null,
    createdAt: now,
    updatedAt: now,
  });
  await store.updateTurn(turn.id, { agentSessionId: environmentPackage.scope.agentSessionId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceIdForOwner(turn.owner));
  applyScopedMigrations(workspaceDb);
  await recordAgentEnvironmentPackageSnapshot(workspaceDb, { createdAt: now, environmentPackage });
  workspaceDb.sqlite.close();
  const entry = await createTestQueueEntry(coreDb, {
    backendId: 'nanohost',
    now: () => now,
    profileRef: 'default',
    queueEntryId: 'queue_cancellation',
    requestId: environmentPackage.scope.requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: turn.threadId,
    triggerActor: environmentPackage.scope.triggerActor,
    turnId: turn.id,
    text: 'Cancel one exact worker Turn',
    workspaceId: workspaceIdForOwner(turn.owner),
  });
  submitTestNanoHostWorkerLease(
    coreDb,
    entry,
    BINDING,
    {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      workerCapabilityTokenHash: hashWorkerRouteToken(CAPABILITY_TOKEN),
      workerControlTokenHash: hashWorkerRouteToken(CONTROL_TOKEN),
      workerInferenceTokenHash: hashWorkerRouteToken(INFERENCE_TOKEN),
    },
    { attemptId: ATTEMPT_ID }
  );
  const { deploymentId } = readDataRootLayoutMarker(dataRoot);
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    sqlite.prepare('UPDATE nanohost_runtime_targets SET deployment_id = ?').run(deploymentId);
    sqlite
      .prepare('UPDATE worker_backend_sessions SET deployment_id = ? WHERE attempt_id = ?')
      .run(deploymentId, ATTEMPT_ID);
  });
  const lineage: WorkerControlLineage = {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId,
    threadId: turn.threadId,
    turnId: turn.id,
    workspaceId: workspaceIdForOwner(turn.owner),
  };
  let gateway = createDefaultWorkerControlGateway(coreDb, undefined, nativeStorage);
  return {
    get coreDb() {
      return coreDb;
    },
    get gateway() {
      return gateway;
    },
    now,
    environmentPackage,
    lineage,
    store,
    /** Reopens SQLite and rebuilds serving state through the production composition. */
    restart() {
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      gateway = createDefaultWorkerControlGateway(coreDb, undefined, nativeStorage);
    },
    /** Repeats index.ts startup order with both real recovery owners and the durable backend. */
    async restartThroughStartup(input: RunNanoHostAttemptRecoveryInput) {
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      const fenced = await transitionAdmittedNanoHostRuntimeTarget(nativeStorage.value, {
        kind: 'restart',
        observedAt: new Date().toISOString(),
      });
      if (fenced.state !== 'ready') throw new Error(`Fixture restart: ${fenced.reason}`);
      gateway = createDefaultWorkerControlGateway(coreDb, undefined, nativeStorage);
      await runSchedulerRestartRecovery(coreDb, input);
      await classifyNanoHostAttemptsAfterRestart(coreDb, input);
    },
    /** Transfers the exact attempt to cancellation without asserting cleanup. */
    close(cause = 'turn-cancelled') {
      return markSchedulerExecutionAttemptClosing(coreDb, { attemptId: ATTEMPT_ID, cause });
    },
    /** Reads all durable control and attempt state, including sequence fingerprints. */
    durableState() {
      return {
        attempts: coreDb.sqlite
          .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
          .all(),
        admissions: coreDb.sqlite
          .prepare('SELECT * FROM scheduler_admission_entries ORDER BY rowid')
          .all(),
        ...readAdmittedTestNanoHost(coreDb, (sqlite) => ({
          records: sqlite.prepare('SELECT * FROM worker_control_records ORDER BY rowid').all(),
          sequences: sqlite
            .prepare('SELECT * FROM worker_control_sequence_fingerprints ORDER BY rowid')
            .all(),
        })),
      };
    },
    /** Reads canonical files and cleanup records afresh rather than using cached projections. */
    productState() {
      const currentWorkspaceDb = openWorkspaceDb(dataRoot, workspaceIdForOwner(turn.owner));
      try {
        return {
          canonical: loadWorkspaceFileRecords(dataRoot),
          cleanupHandles: currentWorkspaceDb.sqlite
            .prepare('SELECT * FROM backend_workspace_handles ORDER BY rowid')
            .all(),
          backends: readAdmittedTestNanoHost(coreDb, (sqlite) =>
            sqlite.prepare('SELECT * FROM worker_backend_sessions ORDER BY rowid').all()
          ),
          attempt: requireSchedulerExecutionAttempt(coreDb, ATTEMPT_ID),
        };
      } finally {
        currentWorkspaceDb.sqlite.close();
      }
    },
    dispose() {
      coreDb.sqlite.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Reads the exact launched physical placement seeded with the submitted route lease. */
function launchedBackend(fixture: Fixture) {
  const backend = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
    getWorkerBackendSession({ sqlite }, ATTEMPT_ID)
  );
  if (!backend) throw new Error('Fixture backend session is absent.');
  return backend;
}

/** Supplies only effect ports; an unexpected callback cannot fabricate authority or cleanup success. */
function recoveryPorts() {
  const failEffect = async () => {
    throw new Error('Backend effect is unavailable in this in-process test.');
  };
  const cleanupBackendSession =
    vi.fn<RunNanoHostAttemptRecoveryInput['cleanupBackendSession']>(failEffect);
  const prepareBackendCleanup = vi.fn<RunNanoHostAttemptRecoveryInput['prepareBackendCleanup']>();
  const input = {
    executionBackend: {
      id: 'nanohost',
      submit: vi.fn(failEffect),
      inspect: vi.fn(failEffect),
      cancel: vi.fn(failEffect),
      release: vi.fn(failEffect),
    },
    cleanupBackendSession,
    reconcileExecutions: async () => {},
    prepareBackendCleanup,
    restoreBackendSession: vi.fn(failEffect),
    reconcileAcceptedFinalStatus: vi.fn(failEffect),
    projectRecoveredTurn: vi.fn(failEffect),
    now: () => new Date().toISOString(),
  } satisfies RunNanoHostAttemptRecoveryInput;
  return { input, cleanupBackendSession, prepareBackendCleanup };
}

/** Composes the real HTTP parsers and bearer selection with the current durable gateway. */
function workerControlHttp(fixture: Fixture) {
  const app = new Hono<{ Variables: AuthVariables }>();
  registerWorkerControlRoutes({
    app,
    coreDb: fixture.coreDb,
    workerControlGateway: fixture.gateway,
  });
  return app;
}

/** Observes every pre-existing bound without introducing a cancellation grace deadline. */
function nativeDeadlines(fixture: Fixture) {
  const attempt = requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID);
  const proof = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
    NanoHostWorkerRecoveryState.parse(
      JSON.parse(
        sqlite
          .prepare('SELECT worker_recovery_json FROM worker_backend_sessions WHERE attempt_id = ?')
          .pluck()
          .get(ATTEMPT_ID) as string
      )
    )
  );
  return {
    deadline: attempt.deadline,
    startupDeadline: proof.startupDeadline,
    heartbeatDeadline: proof.heartbeatDeadline,
    recoveryDeadline: proof.recoveryDeadline,
  };
}

/** Constructs a candidate ordinary output that the closing lineage must refuse. */
function ordinaryEvent(lineage: WorkerControlLineage, sequence = 7): WorkerCanonicalEventRecord {
  return {
    schemaVersion: 1,
    kind: 'event',
    lineage,
    sequence,
    event: {
      type: 'item.delta',
      data: { itemId: testEntityId('it', 'candidate_cancel'), delta: 'late output' },
    },
  };
}

/** Sends the reliability owner's exact cancellation wire pair at the public gateway seam. */
function finalInput(fixture: Fixture, status: 'cancelled' | 'interrupted' = 'cancelled') {
  return {
    authorization: `Bearer ${CONTROL_TOKEN}`,
    lineage: fixture.lineage,
    sequence: 8,
    status,
    stopReason: 'aborted',
    evidenceManifestDigests: {
      transcript: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
}

/** Requires refusal with no mutation in either durable control state or serving state. */
function expectRefusal(fixture: Fixture, operation: () => unknown) {
  const before = fixture.durableState();
  const product = fixture.productState();
  const snapshot = fixture.gateway.getSessionSnapshot(fixture.lineage.packageSnapshotId);
  expect(operation).toThrow();
  expect(fixture.durableState()).toEqual(before);
  expect(fixture.productState()).toEqual(product);
  expect(fixture.gateway.getSessionSnapshot(fixture.lineage.packageSnapshotId)).toEqual(snapshot);
}

/** Requires an asynchronous refusal with no mutation in either durable or serving state. */
async function expectAsyncRefusal(fixture: Fixture, operation: () => Promise<unknown>) {
  const before = fixture.durableState();
  const product = fixture.productState();
  const snapshot = fixture.gateway.getSessionSnapshot(fixture.lineage.packageSnapshotId);
  await expect(operation()).rejects.toThrow();
  expect(fixture.durableState()).toEqual(before);
  expect(fixture.productState()).toEqual(product);
  expect(fixture.gateway.getSessionSnapshot(fixture.lineage.packageSnapshotId)).toEqual(snapshot);
}

/** Checks that each credential family has lost ordinary effect authority. */
function expectOrdinaryEffectsRefused(fixture: Fixture) {
  for (const [tokenFamily, token] of [
    ['worker-control', CONTROL_TOKEN],
    ['inference', INFERENCE_TOKEN],
    ['capability', CAPABILITY_TOKEN],
  ] as const) {
    expectRefusal(fixture, () =>
      fixture.gateway.authenticatePackageToken(`Bearer ${token}`, { tokenFamily })
    );
  }
  expectRefusal(fixture, () =>
    fixture.gateway.appendEvent({
      authorization: `Bearer ${CONTROL_TOKEN}`,
      lineage: fixture.lineage,
      record: ordinaryEvent(fixture.lineage),
    })
  );
}

/** Verifies one immutable final row and the matching canonical terminal event. */
function expectOneFinal(
  fixture: Fixture,
  status: 'cancelled' | 'interrupted',
  diagnostics?: Readonly<Record<string, string>>
) {
  const rows = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
    sqlite.prepare("SELECT * FROM worker_control_records WHERE operation = 'final_status'").all()
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    workspace_id: fixture.lineage.workspaceId,
    thread_id: fixture.lineage.threadId,
    turn_id: fixture.lineage.turnId,
    agent_session_id: fixture.lineage.agentSessionId,
    package_snapshot_id: fixture.lineage.packageSnapshotId,
    request_id: fixture.lineage.requestId,
    record_key: '8',
    sequence: 8,
  });
  expect(JSON.parse((rows[0] as { record_json: string }).record_json)).toEqual({
    acceptedAt: fixture.now,
    ...(diagnostics ? { diagnostics } : {}),
    evidenceManifestDigests: finalInput(fixture, status).evidenceManifestDigests,
    sequence: 8,
    status,
    stopReason: 'aborted',
  });
  const accepted = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
    getWorkerControlAcceptedFinalStatus({ sqlite }, fixture.lineage)
  );
  expect(accepted).toMatchObject({ status, stopReason: 'aborted', acceptedAt: fixture.now });
  expect(canonicalStopReasonForAcceptedWorkerFinalStatus(accepted!)).toBe('aborted');
  const events = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
    sqlite
      .prepare("SELECT record_json FROM worker_control_records WHERE operation = 'event_append'")
      .all()
  ) as Array<{ record_json: string }>;
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.record_json)).toMatchObject({
    lineage: fixture.lineage,
    sequence: 8,
    event: { type: 'turn.failed', data: { status, stopReason: 'aborted' } },
  });
}

describe('Core cancellation-only final admission', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['cancelled', 'interrupted'] as const)(
    'preserves the %s first final after refused ordinary output and seals all route families',
    async (status) => {
      const fixture = await createFixture();
      try {
        fixture.close();
        const product = fixture.productState();
        expect(product.attempt).toMatchObject({
          phase: 'closing',
          terminalCause: 'turn-cancelled',
          fenceRef: null,
          outcomeRef: null,
        });
        expectOrdinaryEffectsRefused(fixture);
        expect(
          readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
            resolveAdmittedNanoHostFinalBinding(fixture.coreDb, sqlite, {
              lineage: fixture.lineage,
              sandboxBindingRef: BINDING,
              token: CONTROL_TOKEN,
              tokenFamily: 'worker-control',
            })
          )
        ).toMatchObject({ status: 'accepted' });
        expect(await fixture.gateway.recordFinalStatus(finalInput(fixture, status))).toMatchObject({
          accepted: true,
          nextExpectedSequence: 9,
        });
        expectOneFinal(fixture, status);
        expect(fixture.productState()).toEqual(product);
        const accepted = fixture.durableState();
        expect(await fixture.gateway.recordFinalStatus(finalInput(fixture, status))).toMatchObject({
          accepted: true,
          nextExpectedSequence: 9,
        });
        expect(fixture.durableState()).toEqual(accepted);
        expectOrdinaryEffectsRefused(fixture);
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus({ ...finalInput(fixture, status), sequence: 9 })
        );
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus({
            ...finalInput(fixture, status),
            diagnostics: { reason: 'changed terminal payload' },
          })
        );
      } finally {
        fixture.dispose();
      }
    }
  );

  it('refuses reconnect on closing authority without consuming its exact first final', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      expectRefusal(fixture, () =>
        fixture.gateway.recordHeartbeat({
          authorization: `Bearer ${CONTROL_TOKEN}`,
          lineage: fixture.lineage,
          operation: 'heartbeat',
          schemaVersion: 2,
          sequence: 1,
          reconnectKey: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
          body: { status: 'running' },
        })
      );
      expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
    } finally {
      fixture.dispose();
    }
  });

  it.each(['turn-cancelled', 'raw-output-exhausted', 'raw-output-unavailable'])(
    'rebuilds a %s first-final opportunity after restart without changing its deadline',
    async (cause) => {
      const fixture = await createFixture();
      try {
        fixture.close(cause);
        expectOrdinaryEffectsRefused(fixture);
        const before = fixture.durableState();
        fixture.restart();
        expect(fixture.durableState()).toEqual(before);
        expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
          accepted: true,
        });
        expectOneFinal(fixture, 'cancelled');
        expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).deadline).toBe(
          (before.attempts[0] as { deadline: string }).deadline
        );
      } finally {
        fixture.dispose();
      }
    }
  );

  it('replays the exact accepted final after restart on both closing and closed lineage', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      await fixture.gateway.recordFinalStatus(finalInput(fixture));
      const accepted = fixture.durableState();
      fixture.restart();
      expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expect(fixture.durableState()).toEqual(accepted);
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), sequence: 9 })
      );
      // Only this simulated external release proof closes the attempt. The final did not do so.
      closeSchedulerExecutionAttemptWithFence(fixture.coreDb, {
        correlation: schedulerExecutionCorrelation(
          requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)
        ),
        fenceRef: 'fence:cancellation-release',
        proof: {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        },
      });
      const closed = fixture.durableState();
      fixture.restart();
      expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expect(fixture.durableState()).toEqual(closed);
      expectOneFinal(fixture, 'cancelled');
      expectOrdinaryEffectsRefused(fixture);
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), stopReason: 'error' })
      );
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), sequence: 9 })
      );
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    ['completed', 'completed'],
    ['failed', 'error'],
    ['lost', 'error'],
    ['blocked', 'length'],
    ['cancelled', 'completed'],
    ['interrupted', 'error'],
  ] as const)(
    'refuses closing first final %s/%s without consuming the valid cancellation final',
    async (status, stopReason) => {
      const fixture = await createFixture();
      try {
        fixture.close();
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus({ ...finalInput(fixture), status, stopReason })
        );
        expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
          accepted: true,
        });
        expectOneFinal(fixture, 'cancelled');
      } finally {
        fixture.dispose();
      }
    }
  );

  it('refuses invalid final schema without consuming the valid cancellation final', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), stopReason: '' })
      );
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), sequence: -1 })
      );
      expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
    } finally {
      fixture.dispose();
    }
  });

  it.each(['worker-final-status', 'restart-native-recovery', 'authority-revoked'])(
    'refuses the first final when closing belongs to %s',
    async (cause) => {
      const fixture = await createFixture();
      try {
        fixture.close(cause);
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus(finalInput(fixture))
        );
      } finally {
        fixture.dispose();
      }
    }
  );

  it('rejects each changed lineage field and each wrong token without consuming the first final', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      for (const field of [
        'workspaceId',
        'threadId',
        'turnId',
        'agentSessionId',
        'packageSnapshotId',
        'requestId',
      ] as const) {
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus({
            ...finalInput(fixture),
            lineage: { ...fixture.lineage, [field]: 'wrong-lineage' },
          })
        );
      }
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({
          ...finalInput(fixture),
          lineage: { ...fixture.lineage, requestId: null },
        })
      );
      for (const token of ['stale-control-token', INFERENCE_TOKEN, CAPABILITY_TOKEN, BINDING]) {
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus({
            ...finalInput(fixture),
            authorization: `Bearer ${token}`,
          })
        );
      }
      expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
    } finally {
      fixture.dispose();
    }
  });

  it('rejects a process binding that differs from the exact durable attempt', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      fixture.gateway.registerSession(fixture.environmentPackage, {
        sandboxBindingRef: 'lease-binding:wrong-attempt',
        workerControlToken: CONTROL_TOKEN,
        workerInferenceToken: INFERENCE_TOKEN,
        workerCapabilityToken: CAPABILITY_TOKEN,
      });
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus(finalInput(fixture))
      );
    } finally {
      fixture.dispose();
    }
  });

  it('refuses an explicitly revoked gateway binding', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      expect(fixture.gateway.unregisterSession(fixture.lineage.packageSnapshotId)).toBe(true);
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus(finalInput(fixture))
      );
    } finally {
      fixture.dispose();
    }
  });

  it('refuses a cancellation first final after the attempt has an accepted fence', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      const correlation = schedulerExecutionCorrelation(
        requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)
      );
      expect(
        acceptSchedulerExecutionObservation(fixture.coreDb, {
          ...correlation,
          disposition: 'accepted',
          execution: 'terminal',
          fenceRef: 'fence:cancellation-before-final',
          outcomeRef: null,
        })
      ).not.toBeNull();
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus(finalInput(fixture))
      );
    } finally {
      fixture.dispose();
    }
  });

  it.each([false, true])(
    'refuses expired cancellation authority after restart=%s',
    async (restart) => {
      const fixture = await createFixture();
      try {
        fixture.close();
        const attempt = requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID);
        vi.setSystemTime(new Date(attempt.deadline!));
        if (restart) fixture.restart();
        expectOrdinaryEffectsRefused(fixture);
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus(finalInput(fixture))
        );
      } finally {
        fixture.dispose();
      }
    }
  );

  it.each(['startup', 'heartbeat'] as const)(
    'refuses a first cancellation final at the expired Native %s deadline',
    async (kind) => {
      const fixture = await createFixture();
      try {
        if (kind === 'heartbeat') {
          await fixture.gateway.recordHeartbeat({
            authorization: `Bearer ${CONTROL_TOKEN}`,
            lineage: fixture.lineage,
            operation: 'heartbeat',
            schemaVersion: 2,
            sequence: 1,
            body: { status: 'running' },
          });
        }
        fixture.close();
        const attempt = nativeDeadlines(fixture);
        vi.setSystemTime(
          new Date(kind === 'startup' ? attempt.startupDeadline : attempt.heartbeatDeadline)
        );
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus(finalInput(fixture))
        );
      } finally {
        fixture.dispose();
      }
    }
  );

  it('refuses contradictory cancellation and recovery evidence without resetting deadlines', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      // Inject the adapter's existing stale classification; no recovery owner is replaced.
      mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
        sqlite
          .prepare(
            "UPDATE worker_backend_sessions SET worker_recovery_json = json_set(worker_recovery_json, '$.recoveryState', 'needs-evidence') WHERE attempt_id = ?"
          )
          .run(ATTEMPT_ID)
      );
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus(finalInput(fixture))
      );
    } finally {
      fixture.dispose();
    }
  });

  it('refuses a final sequence below the accepted event high-watermark without consuming the valid final', async () => {
    const fixture = await createFixture();
    try {
      await fixture.gateway.appendEvent({
        authorization: `Bearer ${CONTROL_TOKEN}`,
        lineage: fixture.lineage,
        record: ordinaryEvent(fixture.lineage, 7),
      });
      fixture.close();
      await expectAsyncRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), sequence: 6 })
      );
      expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expect(
        readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
          sqlite
            .prepare("SELECT * FROM worker_control_records WHERE operation = 'final_status'")
            .all()
        )
      ).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it.each([false, true])(
    'preserves the real-backend first final through startup classification and maintenance=%s',
    async (maintenance) => {
      const fixture = await createFixture();
      const ports = recoveryPorts();
      try {
        const backend = launchedBackend(fixture);
        expect(backend).toMatchObject({
          state: 'launching',
          workspaceHandoffState: 'complete',
          physicalCleanedAt: null,
        });
        await fixture.gateway.recordHeartbeat({
          authorization: `Bearer ${CONTROL_TOKEN}`,
          lineage: fixture.lineage,
          operation: 'heartbeat',
          schemaVersion: 2,
          sequence: 1,
          body: { status: 'running' },
        });
        fixture.close();
        const deadlines = nativeDeadlines(fixture);
        const canonical = fixture.productState().canonical;
        await fixture.restartThroughStartup(ports.input);
        if (maintenance) await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, ports.input);
        expect(nativeDeadlines(fixture)).toEqual(deadlines);
        expectOrdinaryEffectsRefused(fixture);
        expect(await fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
          accepted: true,
        });
        expectOneFinal(fixture, 'cancelled');
        expect(fixture.productState().canonical).toEqual(canonical);
        expect(
          readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
            getWorkerBackendSession({ sqlite }, ATTEMPT_ID)
          )
        ).toEqual(backend);
        expect(ports.cleanupBackendSession).not.toHaveBeenCalled();
        expect(ports.input.executionBackend.submit).not.toHaveBeenCalled();
        expect(ports.input.executionBackend.cancel).not.toHaveBeenCalled();
        expect(ports.input.executionBackend.release).not.toHaveBeenCalled();
        expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
          phase: 'closing',
          terminalCause: 'turn-cancelled',
          fenceRef: null,
        });
      } finally {
        fixture.dispose();
      }
    }
  );

  it.each(['startup', 'heartbeat', 'absolute'] as const)(
    'refuses the real-backend first final and retains cleanup at the original %s deadline',
    async (kind) => {
      const fixture = await createFixture();
      const ports = recoveryPorts();
      try {
        const backend = launchedBackend(fixture);
        if (kind === 'heartbeat')
          await fixture.gateway.recordHeartbeat({
            authorization: `Bearer ${CONTROL_TOKEN}`,
            lineage: fixture.lineage,
            operation: 'heartbeat',
            schemaVersion: 2,
            sequence: 1,
            body: { status: 'running' },
          });
        fixture.close();
        const deadlines = nativeDeadlines(fixture);
        const canonical = fixture.productState().canonical;
        vi.setSystemTime(
          new Date(
            kind === 'startup'
              ? deadlines.startupDeadline
              : kind === 'heartbeat'
                ? deadlines.heartbeatDeadline
                : deadlines.deadline!
          )
        );
        await fixture.restartThroughStartup(ports.input);
        expectOrdinaryEffectsRefused(fixture);
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus(finalInput(fixture))
        );
        await expect(
          runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, ports.input)
        ).rejects.toThrow('Native attempt recovery failed');
        expect(ports.cleanupBackendSession).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            agentSessionId: backend.agentSessionId,
            backendSessionId: backend.backendSessionId,
            packageSnapshotId: backend.packageSnapshotId,
            runtimeTargetId: backend.runtimeTargetId,
            deploymentId: backend.deploymentId,
          })
        );
        expect(nativeDeadlines(fixture)).toEqual(deadlines);
        expect(
          readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
            getWorkerBackendSession({ sqlite }, ATTEMPT_ID)
          )
        ).toMatchObject({
          state: 'cleanup-failed',
          workspaceHandoffState: 'complete',
          physicalCleanedAt: null,
        });
        expect(fixture.productState().canonical).toEqual(canonical);
        expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
          phase: 'closing',
          terminalCause: 'turn-cancelled',
          fenceRef: null,
        });
      } finally {
        fixture.dispose();
      }
    }
  );

  it.each([
    'cleanup-pending',
    'handoff-pending',
    'needs-evidence',
    'fenced',
    'non-cancellation',
  ] as const)(
    'does not wait for a real-backend first final with existing %s evidence',
    async (contradiction) => {
      const fixture = await createFixture();
      const ports = recoveryPorts();
      try {
        launchedBackend(fixture);
        fixture.close(contradiction === 'non-cancellation' ? 'execution-failed' : 'turn-cancelled');
        if (contradiction === 'cleanup-pending')
          mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
            transitionWorkerBackendSessionState(
              { sqlite },
              {
                attemptId: ATTEMPT_ID,
                fromState: 'launching',
                toState: 'cleanup-pending',
                now: () => fixture.now,
              }
            )
          );
        if (contradiction === 'handoff-pending')
          mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
            sqlite
              .prepare(
                "UPDATE worker_backend_sessions SET workspace_handoff_state = 'pending' WHERE attempt_id = ?"
              )
              .run(ATTEMPT_ID)
          );
        if (contradiction === 'needs-evidence')
          mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
            sqlite
              .prepare(
                "UPDATE worker_backend_sessions SET worker_recovery_json = json_set(worker_recovery_json, '$.recoveryState', 'needs-evidence') WHERE attempt_id = ?"
              )
              .run(ATTEMPT_ID)
          );
        if (contradiction === 'fenced')
          acceptSchedulerExecutionObservation(fixture.coreDb, {
            ...schedulerExecutionCorrelation(
              requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)
            ),
            disposition: 'accepted',
            execution: 'terminal',
            outcomeRef: null,
            fenceRef: 'fence:existing-cancellation-cleanup',
          });
        const deadlines = nativeDeadlines(fixture);
        const canonical = fixture.productState().canonical;
        await fixture.restartThroughStartup(ports.input);
        expectOrdinaryEffectsRefused(fixture);
        await expectAsyncRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus(finalInput(fixture))
        );
        await expect(
          runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, ports.input)
        ).rejects.toThrow('Native attempt recovery failed');
        expect(ports.cleanupBackendSession).toHaveBeenCalledTimes(1);
        expect(
          readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
            getWorkerBackendSession({ sqlite }, ATTEMPT_ID)
          )
        ).toMatchObject({
          state: 'cleanup-failed',
          workspaceHandoffState: contradiction === 'handoff-pending' ? 'pending' : 'complete',
          physicalCleanedAt: null,
        });
        expect(nativeDeadlines(fixture)).toEqual(deadlines);
        expect(fixture.productState().canonical).toEqual(canonical);
      } finally {
        fixture.dispose();
      }
    }
  );

  it('accepts the P03 cancellation envelope after HTTP append refusal and preserves incomplete evidence through exact replay', async () => {
    const fixture = await createFixture();
    try {
      fixture.close();
      let app = workerControlHttp(fixture);
      const diagnostics = { transcript: 'incomplete', runtimeCapture: 'incomplete' };
      const { authorization, lineage, sequence, status, stopReason, evidenceManifestDigests } =
        finalInput(fixture, 'interrupted');
      // P03 keeps this existing operation and wire body when a refused capture suffix is retained locally.
      const envelope = {
        schemaVersion: 2,
        operation: 'final_status',
        lineage,
        sequence,
        body: { status, stopReason, evidenceManifestDigests, diagnostics },
      };
      const post = (path: string, payload: unknown) =>
        app.request(`/api/worker-control/${path}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      const product = fixture.productState();
      const before = fixture.durableState();
      const refused = await post('events/append', { lineage, record: ordinaryEvent(lineage, 7) });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'worker_control_lease_not_live' });
      expect(fixture.durableState()).toEqual(before);
      expect(fixture.productState()).toEqual(product);
      const response = await post('final-status', envelope);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        accepted: true,
        diagnostics: [],
        nextExpectedSequence: 9,
        schemaVersion: 2,
      });
      expectOneFinal(fixture, 'interrupted', diagnostics);
      expect(
        readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
          getWorkerControlAcceptedFinalStatus({ sqlite }, lineage)
        )
      ).toMatchObject({
        diagnostics,
      });
      expect(fixture.productState()).toEqual(product);
      const accepted = fixture.durableState();
      fixture.restart();
      app = workerControlHttp(fixture);
      expect((await post('final-status', envelope)).status).toBe(200);
      expect(fixture.durableState()).toEqual(accepted);
      const changed = await post('final-status', {
        ...envelope,
        body: {
          ...envelope.body,
          diagnostics: { transcript: 'complete', runtimeCapture: 'incomplete' },
        },
      });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ code: 'worker_control_sequence_conflict' });
      expect(fixture.durableState()).toEqual(accepted);
      expect(fixture.productState()).toEqual(product);
      expect((await post('final-status', envelope)).status).toBe(200);
      expect(fixture.durableState()).toEqual(accepted);
      // The external release proof is supplied separately; HTTP final acceptance did not close the attempt.
      closeSchedulerExecutionAttemptWithFence(fixture.coreDb, {
        correlation: schedulerExecutionCorrelation(
          requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)
        ),
        fenceRef: 'fence:http-cancellation-release',
        proof: {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        },
      });
      fixture.restart();
      app = workerControlHttp(fixture);
      const closed = fixture.durableState();
      const closedProduct = fixture.productState();
      expect((await post('final-status', envelope)).status).toBe(200);
      expect(fixture.durableState()).toEqual(closed);
      expectOneFinal(fixture, 'interrupted', diagnostics);
      const sealedAppend = await post('events/append', {
        lineage,
        record: ordinaryEvent(lineage, 9),
      });
      expect(sealedAppend.status).toBe(403);
      expect(fixture.durableState()).toEqual(closed);
      expect(fixture.productState()).toEqual(closedProduct);
    } finally {
      fixture.dispose();
    }
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
