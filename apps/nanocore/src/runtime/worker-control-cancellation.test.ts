import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import type { WorkerCanonicalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { loadWorkspaceFileRecords } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
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
  bindNanoHostAttemptRouteTokenHashes,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from './nanohost-attempt-recovery.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  fenceNanoHostRuntimeTargetAfterRestart,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import { runSchedulerRestartRecovery } from './scheduler-restart-recovery.js';
import {
  getWorkerBackendSession,
  markWorkerBackendSessionLaunching,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  workerBackendLineageFromRuntimeImage,
} from './worker-backend-sessions.js';
import { hashWorkerRouteToken, type WorkerControlLineage } from './worker-control-gateway.js';
import {
  canonicalStopReasonForAcceptedWorkerFinalStatus,
  getWorkerControlAcceptedFinalStatus,
  resolveWorkerControlFinalStatusTokenBinding,
} from './worker-control-records.js';
import { registerWorkerControlRoutes } from './worker-control-routes.js';

const NOW = '2026-07-13T00:00:06.000Z';
const ATTEMPT_ID = 'attempt_cancellation';
const BINDING = 'lease-binding:cancellation';
const CONTROL_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const INFERENCE_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CAPABILITY_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** Builds the real Core admission, Native binding, package ledger, and default gateway. */
function createFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-control-cancellation-'));
  let coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  const turn = store.createTurn('ws_demo', 'th_demo', 'Cancel one exact worker Turn', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_cancellation',
      backend: { kind: 'openshell' },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_cancellation',
      triggerActor: { kind: 'user', id: 'user_local' },
      turn,
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  store.createAgentSession({
    id: environmentPackage.scope.agentSessionId,
    agentId: environmentPackage.agent.agentId,
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    status: 'busy',
    message: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.updateTurn(turn.id, { agentSessionId: environmentPackage.scope.agentSessionId });
  const workspaceDb = openWorkspaceDb(dataRoot, turn.workspaceId);
  applyScopedMigrations(workspaceDb);
  recordAgentEnvironmentPackageSnapshot(workspaceDb, { createdAt: NOW, environmentPackage });
  workspaceDb.sqlite.close();
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    now: () => NOW,
    profileRef: 'default',
    queueEntryId: 'queue_cancellation',
    requestId: environmentPackage.scope.requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: turn.threadId,
    triggerActor: environmentPackage.scope.triggerActor,
    turnId: turn.id,
    turnInput: 'Cancel one exact worker Turn',
    workspaceId: turn.workspaceId,
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: ATTEMPT_ID,
    agentSessionId: environmentPackage.scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: BINDING,
    sessionCompatibilityKey: 'sha256:cancellation',
    operationId: 'submit_cancellation',
    now: () => NOW,
  });
  bindNanoHostAttemptRouteTokenHashes(coreDb, {
    attemptId: ATTEMPT_ID,
    now: () => NOW,
    sandboxBindingRef: BINDING,
    workerCapabilityTokenHash: hashWorkerRouteToken(CAPABILITY_TOKEN),
    workerControlTokenHash: hashWorkerRouteToken(CONTROL_TOKEN),
    workerInferenceTokenHash: hashWorkerRouteToken(INFERENCE_TOKEN),
  });
  const lineage: WorkerControlLineage = {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId,
    threadId: turn.threadId,
    turnId: turn.id,
    workspaceId: turn.workspaceId,
  };
  let gateway = createDefaultWorkerControlGateway(coreDb);
  return {
    get coreDb() {
      return coreDb;
    },
    get gateway() {
      return gateway;
    },
    environmentPackage,
    lineage,
    store,
    /** Reopens SQLite and rebuilds serving state through the production composition. */
    restart() {
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      gateway = createDefaultWorkerControlGateway(coreDb);
    },
    /** Repeats index.ts startup order with both real recovery owners and the durable backend. */
    async restartThroughStartup(input: RunNanoHostAttemptRecoveryInput) {
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      fenceNanoHostRuntimeTargetAfterRestart(coreDb, new Date().toISOString());
      gateway = createDefaultWorkerControlGateway(coreDb);
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
        records: coreDb.sqlite.prepare('SELECT * FROM worker_control_records ORDER BY rowid').all(),
        sequences: coreDb.sqlite
          .prepare('SELECT * FROM worker_control_sequence_fingerprints ORDER BY rowid')
          .all(),
      };
    },
    /** Reads canonical files and cleanup records afresh rather than using cached projections. */
    productState() {
      const currentWorkspaceDb = openWorkspaceDb(dataRoot, turn.workspaceId);
      try {
        return {
          canonical: loadWorkspaceFileRecords(dataRoot),
          cleanupHandles: currentWorkspaceDb.sqlite
            .prepare('SELECT * FROM backend_workspace_handles ORDER BY rowid')
            .all(),
          backends: coreDb.sqlite
            .prepare('SELECT * FROM worker_backend_sessions ORDER BY rowid')
            .all(),
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

type Fixture = ReturnType<typeof createFixture>;

/** Establishes exact admitted physical lineage through the existing backend record producers. */
function recordLaunchedBackend(fixture: Fixture) {
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(fixture.coreDb, {
    deploymentId: 'deployment-cancellation',
    identityId: 'identity-cancellation',
    observedAt: NOW,
    targetId: 'runtime-target-cancellation',
  });
  upsertNanoHostRuntimeTarget(fixture.coreDb, {
    ...target,
    freshEmpty: true,
    observedAt: NOW,
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
  recordWorkerBackendSessionMaterializing(fixture.coreDb, {
    backendLineage: workerBackendLineageFromRuntimeImage(fixture.environmentPackage.runtime.image),
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: fixture.lineage.agentSessionId,
      backendKind: fixture.environmentPackage.backend.preferred,
      backendSessionId: 'nh-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb',
      deploymentId: target.deploymentId,
      packageSnapshotId: fixture.lineage.packageSnapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${fixture.lineage.packageSnapshotId}`,
      transientProviderInstanceId: null,
    },
    lineage: fixture.lineage,
    now: () => NOW,
    sandboxBindingRef: BINDING,
  });
  transitionWorkerBackendSessionState(fixture.coreDb, {
    attemptId: ATTEMPT_ID,
    fromState: 'materializing',
    toState: 'materialized',
    now: () => NOW,
  });
  markWorkerBackendWorkspaceHandoffComplete(fixture.coreDb, {
    attemptId: ATTEMPT_ID,
    now: () => NOW,
  });
  return markWorkerBackendSessionLaunching(fixture.coreDb, {
    attemptId: ATTEMPT_ID,
    now: () => NOW,
  });
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
  const attempt = requireNanoHostExecutionAttempt(fixture.coreDb, ATTEMPT_ID);
  return {
    deadline: attempt.deadline,
    startupDeadline: attempt.startupDeadline,
    heartbeatDeadline: attempt.heartbeatDeadline,
    recoveryDeadline: attempt.recoveryDeadline,
  };
}

/** Constructs a candidate ordinary output that the closing lineage must refuse. */
function ordinaryEvent(lineage: WorkerControlLineage, sequence = 7): WorkerCanonicalEventRecord {
  return {
    schemaVersion: 1,
    kind: 'event',
    lineage,
    sequence,
    event: { type: 'item.delta', data: { itemId: 'candidate_cancel', delta: 'late output' } },
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
  const rows = fixture.coreDb.sqlite
    .prepare("SELECT * FROM worker_control_records WHERE operation = 'final_status'")
    .all();
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
    acceptedAt: NOW,
    ...(diagnostics ? { diagnostics } : {}),
    evidenceManifestDigests: finalInput(fixture, status).evidenceManifestDigests,
    sequence: 8,
    status,
    stopReason: 'aborted',
  });
  const accepted = getWorkerControlAcceptedFinalStatus(fixture.coreDb, fixture.lineage);
  expect(accepted).toMatchObject({ status, stopReason: 'aborted', acceptedAt: NOW });
  expect(canonicalStopReasonForAcceptedWorkerFinalStatus(accepted!)).toBe('aborted');
  const events = fixture.coreDb.sqlite
    .prepare("SELECT record_json FROM worker_control_records WHERE operation = 'event_append'")
    .all() as Array<{ record_json: string }>;
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.record_json)).toMatchObject({
    lineage: fixture.lineage,
    sequence: 8,
    event: { type: 'turn.failed', data: { status, stopReason: 'aborted' } },
  });
}

describe('Core cancellation-only final admission', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    'cancelled',
    'interrupted',
  ] as const)('preserves the %s first final after refused ordinary output and seals all route families', (status) => {
    const fixture = createFixture();
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
        resolveWorkerControlFinalStatusTokenBinding(fixture.coreDb, {
          lineage: fixture.lineage,
          sandboxBindingRef: BINDING,
          token: CONTROL_TOKEN,
          tokenFamily: 'worker-control',
        })
      ).toMatchObject({ status: 'accepted' });
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture, status))).toMatchObject({
        accepted: true,
        nextExpectedSequence: 9,
      });
      expectOneFinal(fixture, status);
      expect(fixture.productState()).toEqual(product);
      const accepted = fixture.durableState();
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture, status))).toMatchObject({
        accepted: true,
        nextExpectedSequence: 9,
      });
      expect(fixture.durableState()).toEqual(accepted);
      expectOrdinaryEffectsRefused(fixture);
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture, status), sequence: 9 })
      );
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({
          ...finalInput(fixture, status),
          diagnostics: { reason: 'changed terminal payload' },
        })
      );
    } finally {
      fixture.dispose();
    }
  });

  it('refuses reconnect on closing authority without consuming its exact first final', () => {
    const fixture = createFixture();
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
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'turn-cancelled',
    'raw-output-exhausted',
    'raw-output-unavailable',
  ])('rebuilds a %s first-final opportunity after restart without changing its deadline', (cause) => {
    const fixture = createFixture();
    try {
      fixture.close(cause);
      expectOrdinaryEffectsRefused(fixture);
      const before = fixture.durableState();
      fixture.restart();
      expect(fixture.durableState()).toEqual(before);
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
      expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).deadline).toBe(
        (before.attempts[0] as { deadline: string }).deadline
      );
    } finally {
      fixture.dispose();
    }
  });

  it('replays the exact accepted final after restart on both closing and closed lineage', () => {
    const fixture = createFixture();
    try {
      fixture.close();
      fixture.gateway.recordFinalStatus(finalInput(fixture));
      const accepted = fixture.durableState();
      fixture.restart();
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expect(fixture.durableState()).toEqual(accepted);
      expectRefusal(fixture, () =>
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
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expect(fixture.durableState()).toEqual(closed);
      expectOneFinal(fixture, 'cancelled');
      expectOrdinaryEffectsRefused(fixture);
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), stopReason: 'error' })
      );
      expectRefusal(fixture, () =>
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
  ] as const)('refuses closing first final %s/%s without consuming the valid cancellation final', (status, stopReason) => {
    const fixture = createFixture();
    try {
      fixture.close();
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), status, stopReason })
      );
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
    } finally {
      fixture.dispose();
    }
  });

  it('refuses invalid final schema without consuming the valid cancellation final', () => {
    const fixture = createFixture();
    try {
      fixture.close();
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), stopReason: '' })
      );
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), sequence: -1 })
      );
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'worker-final-status',
    'restart-native-recovery',
    'authority-revoked',
  ])('refuses the first final when closing belongs to %s', (cause) => {
    const fixture = createFixture();
    try {
      fixture.close(cause);
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
    } finally {
      fixture.dispose();
    }
  });

  it('rejects each changed lineage field and each wrong token without consuming the first final', () => {
    const fixture = createFixture();
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
        expectRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus({
            ...finalInput(fixture),
            lineage: { ...fixture.lineage, [field]: 'wrong-lineage' },
          })
        );
      }
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({
          ...finalInput(fixture),
          lineage: { ...fixture.lineage, requestId: null },
        })
      );
      for (const token of ['stale-control-token', INFERENCE_TOKEN, CAPABILITY_TOKEN, BINDING]) {
        expectRefusal(fixture, () =>
          fixture.gateway.recordFinalStatus({
            ...finalInput(fixture),
            authorization: `Bearer ${token}`,
          })
        );
      }
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
    } finally {
      fixture.dispose();
    }
  });

  it('rejects a process binding that differs from the exact durable attempt', () => {
    const fixture = createFixture();
    try {
      fixture.close();
      fixture.gateway.registerSession(fixture.environmentPackage, {
        sandboxBindingRef: 'lease-binding:wrong-attempt',
        workerControlToken: CONTROL_TOKEN,
        workerInferenceToken: INFERENCE_TOKEN,
        workerCapabilityToken: CAPABILITY_TOKEN,
      });
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
    } finally {
      fixture.dispose();
    }
  });

  it('refuses an explicitly revoked gateway binding', () => {
    const fixture = createFixture();
    try {
      fixture.close();
      expect(fixture.gateway.unregisterSession(fixture.lineage.packageSnapshotId)).toBe(true);
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
    } finally {
      fixture.dispose();
    }
  });

  it('refuses a cancellation first final after the attempt has an accepted fence', () => {
    const fixture = createFixture();
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
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
    } finally {
      fixture.dispose();
    }
  });

  it.each([false, true])('refuses expired cancellation authority after restart=%s', (restart) => {
    const fixture = createFixture();
    try {
      fixture.close();
      const attempt = requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID);
      vi.setSystemTime(new Date(attempt.deadline!));
      if (restart) fixture.restart();
      expectOrdinaryEffectsRefused(fixture);
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'startup',
    'heartbeat',
  ] as const)('refuses a first cancellation final at the expired Native %s deadline', (kind) => {
    const fixture = createFixture();
    try {
      if (kind === 'heartbeat') {
        fixture.gateway.recordHeartbeat({
          authorization: `Bearer ${CONTROL_TOKEN}`,
          lineage: fixture.lineage,
          operation: 'heartbeat',
          schemaVersion: 2,
          sequence: 1,
          body: { status: 'running' },
        });
      }
      fixture.close();
      const attempt = requireNanoHostExecutionAttempt(fixture.coreDb, ATTEMPT_ID);
      vi.setSystemTime(
        new Date(kind === 'startup' ? attempt.startupDeadline : attempt.heartbeatDeadline)
      );
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
    } finally {
      fixture.dispose();
    }
  });

  it('refuses contradictory cancellation and recovery evidence without resetting deadlines', () => {
    const fixture = createFixture();
    try {
      fixture.close();
      // Inject the adapter's existing stale classification; no recovery owner is replaced.
      fixture.coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET recovery_state = 'needs-evidence' WHERE attempt_id = ?"
        )
        .run(ATTEMPT_ID);
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
    } finally {
      fixture.dispose();
    }
  });

  it('refuses a final sequence below the accepted event high-watermark without consuming the valid final', () => {
    const fixture = createFixture();
    try {
      fixture.gateway.appendEvent({
        authorization: `Bearer ${CONTROL_TOKEN}`,
        lineage: fixture.lineage,
        record: ordinaryEvent(fixture.lineage, 7),
      });
      fixture.close();
      expectRefusal(fixture, () =>
        fixture.gateway.recordFinalStatus({ ...finalInput(fixture), sequence: 6 })
      );
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expect(
        fixture.coreDb.sqlite
          .prepare("SELECT * FROM worker_control_records WHERE operation = 'final_status'")
          .all()
      ).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('preserves the real-backend first final through startup classification and maintenance=%s', async (maintenance) => {
    const fixture = createFixture();
    const ports = recoveryPorts();
    try {
      const backend = recordLaunchedBackend(fixture);
      expect(backend).toMatchObject({
        state: 'launching',
        workspaceHandoffState: 'complete',
        physicalCleanedAt: null,
      });
      fixture.gateway.recordHeartbeat({
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
      expect(fixture.gateway.recordFinalStatus(finalInput(fixture))).toMatchObject({
        accepted: true,
      });
      expectOneFinal(fixture, 'cancelled');
      expect(fixture.productState().canonical).toEqual(canonical);
      expect(getWorkerBackendSession(fixture.coreDb, ATTEMPT_ID)).toEqual(backend);
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
  });

  it.each([
    'startup',
    'heartbeat',
    'absolute',
  ] as const)('refuses the real-backend first final and retains cleanup at the original %s deadline', async (kind) => {
    const fixture = createFixture();
    const ports = recoveryPorts();
    try {
      const backend = recordLaunchedBackend(fixture);
      if (kind === 'heartbeat')
        fixture.gateway.recordHeartbeat({
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
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
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
      expect(getWorkerBackendSession(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
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
  });

  it.each([
    'cleanup-pending',
    'handoff-pending',
    'needs-evidence',
    'fenced',
    'non-cancellation',
  ] as const)('does not wait for a real-backend first final with existing %s evidence', async (contradiction) => {
    const fixture = createFixture();
    const ports = recoveryPorts();
    try {
      recordLaunchedBackend(fixture);
      fixture.close(contradiction === 'non-cancellation' ? 'execution-failed' : 'turn-cancelled');
      if (contradiction === 'cleanup-pending')
        transitionWorkerBackendSessionState(fixture.coreDb, {
          attemptId: ATTEMPT_ID,
          fromState: 'launching',
          toState: 'cleanup-pending',
          now: () => NOW,
        });
      if (contradiction === 'handoff-pending')
        fixture.coreDb.sqlite
          .prepare(
            "UPDATE worker_backend_sessions SET workspace_handoff_state = 'pending' WHERE attempt_id = ?"
          )
          .run(ATTEMPT_ID);
      if (contradiction === 'needs-evidence')
        fixture.coreDb.sqlite
          .prepare(
            "UPDATE scheduler_execution_attempts SET recovery_state = 'needs-evidence' WHERE attempt_id = ?"
          )
          .run(ATTEMPT_ID);
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
      expectRefusal(fixture, () => fixture.gateway.recordFinalStatus(finalInput(fixture)));
      await expect(
        runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, ports.input)
      ).rejects.toThrow('Native attempt recovery failed');
      expect(ports.cleanupBackendSession).toHaveBeenCalledTimes(1);
      expect(getWorkerBackendSession(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
        state: 'cleanup-failed',
        workspaceHandoffState: contradiction === 'handoff-pending' ? 'pending' : 'complete',
        physicalCleanedAt: null,
      });
      expect(nativeDeadlines(fixture)).toEqual(deadlines);
      expect(fixture.productState().canonical).toEqual(canonical);
    } finally {
      fixture.dispose();
    }
  });

  it('accepts the P03 cancellation envelope after HTTP append refusal and preserves incomplete evidence through exact replay', async () => {
    const fixture = createFixture();
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
      expect(getWorkerControlAcceptedFinalStatus(fixture.coreDb, lineage)).toMatchObject({
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
