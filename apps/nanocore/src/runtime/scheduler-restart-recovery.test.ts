import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { workerSessionInputPaths } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  DISPLAY_PROJECTION_REFRESH_ADMISSION,
  FsStore,
} from '../lib/store.js';
import type { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerExecutionAttemptAdmissionContext,
} from '../scheduler-records.js';
import {
  openCoreDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
  recordTestAgentEnvironmentPackage as recordBaseTestAgentEnvironmentPackage,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { reconcileWorkerMcpItems } from '../worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  listExportableAgentEnvironmentPackageSnapshots,
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import * as attempts from './execution-attempt-records.js';
import {
  acceptNanoHostAttemptHeartbeat,
  acceptNanoHostAttemptHeartbeatByBinding,
  adoptNanoHostAttemptReconnect,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from './nanohost-attempt-recovery.js';
import { createNanoHostEffectRequest } from './nanohost-effect-identity.js';
import {
  deriveNanoHostAgentSessionCompatibilityKey,
  openNanoHostAgentSessionBinding,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import {
  installPendingRequestAdmission,
  raiseRecordedPendingRequest,
  recoverPendingRequestsAtBoot,
} from './pending-request-flow.js';
import {
  answerPendingRequest,
  freezeReadyOutcomes,
  readPendingRequest,
} from './pending-requests.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import {
  runSchedulerRecoveryMaintenance,
  runSchedulerRestartRecovery,
} from './scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import type { TurnExecutor } from './types.js';
import { projectWorkerBackendCleanup } from './worker-backend-cleanup-projection.js';
import {
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionState,
  workerBackendImageIdentity,
} from './worker-backend-sessions.js';
import { WorkerControlGateway, type WorkerControlLineage } from './worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';
import {
  agentSessionCompatibilityKeyFromPackage,
  WorkerGovernanceTurnExecutor,
} from './worker-governance-turn-executor.js';
import * as workerTurnFailure from './worker-turn-failure.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  listWorkspaceReconciliationRecords,
  resolveWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceMaterializationRecords,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
} from './workspace-sync-records.js';

/** Creates an isolated migrated Core database for restart recovery tests. */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-restart-')));
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId: 'ws_demo' });
  return coreDb;
}

/** Persists the failed-start crash boundary, optionally with an outcome awaiting delivery. */
async function createFailedStartFixture(
  suffix: string,
  outcome = false,
  anchored = true,
  finalized = true,
  workspaceInputIds: readonly string[] = []
) {
  const coreDb = createMigratedCoreDb();
  const dataRoot = coreDb.dataRoot;
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId: 'ws_demo' });
  const threadId = `thread_${suffix}`;
  const turnId = `turn_${suffix}`;
  const agentSessionId = `as_${suffix}`;
  const packageSnapshotId = `aepsnap_turn_${suffix}_as_${suffix}`;
  store.createThread('ws_demo', 'Recover failed start', threadId);
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  if (outcome) {
    const raising = store.createTurn(
      'ws_demo',
      threadId,
      'Ask for input',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { agentId: 'agent_codex_host', executorKind: 'worker', startedAt: '2026-07-05T00:00:00.000Z' }
    );
    const questions = [
      {
        id: 'path',
        header: 'Path',
        question: 'Which path?',
        options: null,
        isOther: true,
        isSecret: false,
      },
    ];
    store.createItem({
      id: `it_request_${suffix}`,
      workspaceId: 'ws_demo',
      threadId,
      turnId: raising.id,
      type: 'user-input-request',
      responsibleUserId: LOCAL_USER_ID,
      status: 'completed',
      userInputRequestId: `input_${suffix}`,
      prompt: 'Which path?',
      questions,
      createdAt: raising.startedAt!,
      completedAt: raising.startedAt!,
    });
    raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
      requestId: `input_${suffix}`,
      requestItemId: `it_request_${suffix}`,
      workspaceId: 'ws_demo',
      threadId,
      raisingTurnId: raising.id,
      kind: 'user-input',
      requesterKind: 'worker',
      agentId: 'agent_codex_host',
      responsibleUserId: LOCAL_USER_ID,
      questions,
      questionDigest: `digest_${suffix}`,
      now: '2026-07-05T00:00:00.000Z',
    });
    store.updateTurn(raising.id, { status: 'completed', completedAt: '2026-07-05T00:00:00.000Z' });
    answerPendingRequest(
      workspaceDb.sqlite,
      `input_${suffix}`,
      { kind: 'user', id: LOCAL_USER_ID },
      { path: ['src'] },
      '2026-07-05T00:00:00.000Z'
    );
  }
  store.createAgentSession({
    id: agentSessionId,
    agentId: 'agent_codex_host',
    workspaceId: 'ws_demo',
    threadId,
    status: 'busy',
    message: null,
    ...(finalized || anchored ? { environmentPackageSnapshotId: packageSnapshotId } : {}),
    createdAt: '2026-07-05T00:00:01.000Z',
    updatedAt: '2026-07-05T00:00:01.000Z',
  });
  const turn = store.createTurn(
    'ws_demo',
    threadId,
    `Run ${suffix}`,
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      turnId,
      startedAt: '2026-07-05T00:00:01.000Z',
      agentId: 'agent_codex_host',
      agentSessionId,
      status: 'pending',
      executorKind: 'worker',
    }
  );
  if (outcome)
    freezeReadyOutcomes(workspaceDb.sqlite, {
      workspaceId: 'ws_demo',
      threadId,
      turnId,
      executor: 'worker',
      agentId: 'agent_codex_host',
      cause: 'outcome',
      now: '2026-07-05T00:00:01.000Z',
    });
  store.updateTurn(turnId, { status: 'running' });
  dispatchLease(
    coreDb,
    suffix,
    { kind: 'user', id: LOCAL_USER_ID },
    anchored,
    finalized || anchored
  );
  store.recordCommandRequest({
    command: 'turn.start',
    requestId: `request_${suffix}`,
    inputHash: `fixture:queue_${suffix}`,
    scope: { actorId: LOCAL_USER_ID, workspaceId: 'ws_demo', threadId },
    response: { kind: 'turn', id: turnId },
    createdAt: new Date().toISOString(),
  });
  if (anchored) {
    recordBackendSession(coreDb, suffix, 'cleaned');
    const anchor = getWorkerBackendSession(coreDb, `lease_${suffix}`)!;
    const environmentPackage = requireAgentEnvironmentPackageSnapshot(
      workspaceDb,
      'ws_demo',
      packageSnapshotId
    ).snapshot;
    const projection = projectWorkerBackendCleanup(workspaceDb, {
      agentSessionId,
      backendType: 'openshell',
      backendVersion: anchor.backendVersion,
      backendSessionId: anchor.backendSessionId,
      completedAt: anchor.physicalCleanedAt!,
      environmentPackage,
      outcome: 'succeeded',
      packageSnapshotId,
      placement: 'local',
      threadId,
      turnId,
      workerImage: workerBackendImageIdentity(anchor.backendLineage),
      workspaceHandoffState: anchor.workspaceHandoffState,
      workspaceId: 'ws_demo',
    });
    expect(projection.workspaceHandoffComplete).toBe(true);
    markWorkerBackendWorkspaceHandoffComplete(coreDb, {
      attemptId: anchor.attemptId,
      now: () => anchor.physicalCleanedAt!,
    });
  } else if (finalized)
    recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds });
  if (anchored) {
    const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
      attemptId: `lease_${suffix}`,
      cause: 'turn-start-failed',
      now: () => '2026-07-05T00:00:08.000Z',
    });
    // The controlled cleanup leaves no surviving worker, output, collection or integration stream. The exact original operation remains unknown: this fence proves release, not absence of prior effects. Startup failure handoff is decided; its product publication may remain partial.
    const proof = {
      terminalHandoff: true,
      output: true,
      evidence: true,
      outsideWorkspaceCollection: true,
      integrationDrain: true,
      routesRevoked: true,
    } as const;
    const correlation = attempts.schedulerExecutionCorrelation(closing);
    const release = await new SimulatedTurnExecutor({ coreDb }).release({ ...correlation, proof });
    attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
      correlation,
      proof,
      fenceRef: release.fenceRef!,
      now: () => '2026-07-05T00:00:08.000Z',
    });
  } else
    attempts.closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
      attemptId: `lease_${suffix}`,
      noOutstandingEffects: true,
      cause: 'turn-start-failed',
      now: () => '2026-07-05T00:00:08.000Z',
    });
  workspaceDb.sqlite.close();
  coreDb.sqlite.close();
  const restartedCore = openCoreDb(dataRoot);
  const restartedStore = new FsStore({ dataRoot });
  const workerDelivery = { startTurn: vi.fn(async () => {}) };
  const pending = {
    coreDb: restartedCore,
    agentAuthority: () => true,
    workerDelivery,
    openWorkspace: (workspaceId: string) => {
      const db = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(db);
      return db;
    },
  };
  installPendingRequestAdmission(restartedStore, pending);
  if (finalized) recoverPendingRequestsAtBoot(restartedStore, pending);
  const input = {
    store: restartedStore,
    now: () => '2026-10-03T00:00:00.000Z',
    executionBackend: new SimulatedTurnExecutor({ coreDb: restartedCore }),
    // Admitted product-boundary double for recovery selection/publication, not index.ts composition.
    // The scenario supplies a failed-start outcome independent of anchor shape; the real Turn
    // lifecycle owner performs all product writes and pending-request hooks. This double neither
    // selects eligible attempts nor proves bootstrap's diagnostic mapping or physical fencing.
    projectRecoveredTurn: vi.fn(async function (
      this: import('./scheduler-restart-recovery.js').RunSchedulerRestartRecoveryInput,
      subject: import('./scheduler-restart-recovery.js').PreAnchorRecoveryContext
    ) {
      const admission = requireSchedulerExecutionAttemptAdmissionContext(
        restartedCore,
        subject.attemptId
      );
      const currentTurn = this.store!.getTurnById(subject.turnId);
      const db = openWorkspaceDb(dataRoot, subject.workspaceId);
      let deliveryUnknown: boolean;
      try {
        const deliveries = db.sqlite
          .prepare('SELECT delivery FROM pending_requests WHERE delivery_turn_id = ?')
          .all(subject.turnId) as Array<{ delivery: string }>;
        deliveryUnknown = deliveries.some((record) => record.delivery === 'delivery-unknown');
      } finally {
        db.sqlite.close();
      }
      const diagnostic =
        currentTurn.error ??
        (deliveryUnknown
          ? { code: 'delivery_unknown', message: 'Outcome delivery could not be proved.' }
          : {
              code: 'worker_governance_turn_failed',
              message: 'The worker attempt failed to start.',
            });
      const result = terminalizeGovernedWorkerTurn({
        agentSessionId: subject.agentSessionId,
        completedAt: this.now?.() ?? new Date().toISOString(),
        errorCode: diagnostic.code,
        message: diagnostic.message,
        outcome: 'failed',
        requestId: admission.requestId,
        store: this.store!,
        turnId: subject.turnId,
      });
      if (
        result.status !== 'completed' &&
        result.status !== 'failed' &&
        result.status !== 'interrupted' &&
        result.status !== 'cancelled' &&
        result.status !== 'missing'
      )
        throw new Error(`Recovery did not terminalize Turn: ${result.status}`);
      return { status: result.status };
    }),
  };
  return {
    coreDb: restartedCore,
    store: restartedStore,
    dataRoot,
    threadId,
    turnId,
    agentSessionId,
    input,
    pending,
    workerDelivery,
    turn,
  };
}

/** Observes the Core attempt phase without projecting the retired grant or physical accounting. */
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

describe('terminal failed-start product recovery', () => {
  it.each([
    'closed-busy',
    'open',
    'closing',
    'unknown-operation',
    'native-evidence',
    'cleanup-failed',
    'cleanup-unknown',
  ] as const)('checks repeated failed-start settlement with busy history: %s', async (proof) => {
    const suffix = `busy_history_${proof}`;
    const f = await createFailedStartFixture(suffix);
    const attemptId = `lease_${suffix}`;
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Match the terminal no-operation failure after capacity deferrals, with a cleaned anchor in the same physical Epoch; cleanup controls retain the original uncertain operation.
      if (proof !== 'cleanup-failed' && proof !== 'cleanup-unknown')
        f.coreDb.sqlite
          .prepare(
            "UPDATE scheduler_execution_attempts SET disposition = 'not_accepted', operation_id = NULL, deadline = NULL WHERE attempt_id = ?"
          )
          .run(attemptId);
      for (let index = 0; index < 3; index += 1) {
        f.coreDb.sqlite
          .prepare("UPDATE scheduler_admission_entries SET status = 'queued' WHERE turn_id = ?")
          .run(f.turnId);
        const entry = requireSchedulerExecutionAttemptAdmissionContext(f.coreDb, attemptId);
        const busy = attempts.createSchedulerExecutionAttempt(f.coreDb, {
          entry,
          attemptId: `busy_${suffix}_${index}`,
          preparationInput: { admission: entry },
          now: () => '2026-07-05T00:00:00.000Z',
        });
        attempts.bindSchedulerExecutionAttemptSession(f.coreDb, {
          attemptId: busy.attemptId,
          agentSessionId: `as_busy_${suffix}_${index}`,
        });
        attempts.closeSchedulerExecutionAttemptWithoutEffects(f.coreDb, {
          attemptId: busy.attemptId,
          noOutstandingEffects: true,
          cause: 'backend-busy',
        });
      }
      const competingId = `busy_${suffix}_0`;
      if (proof === 'open' || proof === 'closing')
        f.coreDb.sqlite
          .prepare('UPDATE scheduler_execution_attempts SET phase = ? WHERE attempt_id = ?')
          .run(proof, competingId);
      else if (proof === 'unknown-operation')
        f.coreDb.sqlite
          .prepare(
            "UPDATE scheduler_execution_attempts SET disposition = 'unknown', operation_id = 'unproved-operation' WHERE attempt_id = ?"
          )
          .run(competingId);
      else if (proof === 'native-evidence')
        f.coreDb.sqlite
          .prepare(
            'UPDATE scheduler_execution_attempts SET last_worker_sequence = 1 WHERE attempt_id = ?'
          )
          .run(competingId);
      else if (proof === 'cleanup-failed')
        f.coreDb.sqlite
          .prepare(
            "UPDATE worker_backend_sessions SET state = 'cleanup-failed', physical_cleaned_at = NULL WHERE attempt_id = ?"
          )
          .run(attemptId);
      else if (proof === 'cleanup-unknown')
        f.coreDb.sqlite
          .prepare(
            'UPDATE worker_backend_sessions SET physical_cleaned_at = NULL WHERE attempt_id = ?'
          )
          .run(attemptId);
      terminalizeGovernedWorkerTurn({
        store: f.store,
        turnId: f.turnId,
        agentSessionId: f.agentSessionId,
        requestId: `request_${suffix}`,
        completedAt: '2026-07-05T00:00:08.000Z',
        outcome: 'failed',
        errorCode: 'worker_governance_turn_failed',
        message: 'NanoHost one-Sandbox capacity is occupied or unproved.',
      });
      const terminal = f.store.getTurnById(f.turnId);
      const events = f.store.getTurnEvents(f.turnId);
      const session = f.store.getAgentSession(f.agentSessionId);
      const beforeAttempts = observeExecutionAttempts(f.coreDb);
      const cleanup = vi.fn(async () => {
        throw new Error('Backend cleanup is unproved.');
      });
      const recovery = testRecoveryInput(f.coreDb, { ...f.input, cleanupBackendSession: cleanup });
      const results: PromiseSettledResult<void>[] = [];
      for (let pass = 0; pass < 2; pass += 1)
        results.push(
          ...(await Promise.allSettled([runNanoHostAttemptRecoveryMaintenance(f.coreDb, recovery)]))
        );
      const warnings = log.mock.calls
        .map(([line]) => JSON.parse(line))
        .filter(
          (record) =>
            record.attributes['openkit.error.code'] ===
            'scheduler.native_failed_start_recovery_required'
        );
      expect(warnings).toHaveLength(proof === 'closed-busy' ? 0 : 2);
      expect(results.map((result) => result.status)).toEqual(
        proof === 'closed-busy' ? ['fulfilled', 'fulfilled'] : ['rejected', 'rejected']
      );
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason.errors).toContainEqual(
            expect.objectContaining({
              message:
                proof === 'cleanup-failed' || proof === 'cleanup-unknown'
                  ? 'recovery_required: Failed-start backend cleanup is not definite for this exact attempt.'
                  : 'recovery_required: Failed-start attempt has a competing execution owner.',
            })
          );
      if (proof === 'closed-busy') {
        expect(log).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
      }
      for (const warning of warnings)
        expect(warning.attributes['openkit.attempt.id']).toBe(attemptId);
      expect(f.store.getTurnById(f.turnId)).toEqual(terminal);
      expect(f.store.getTurnEvents(f.turnId)).toEqual(events);
      expect(events.filter((event) => event.event === 'turn.completed')).toHaveLength(1);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(observeExecutionAttempts(f.coreDb)).toEqual(beforeAttempts);
      expect(recovery.projectRecoveredTurn).not.toHaveBeenCalled();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('settles a proved pre-effect outcome preparation failure without a never-published snapshot or its own delivery retry (#108)', async () => {
    const f = await createFailedStartFixture('pre_snapshot_108', true, false, false);
    const cleanup = vi.fn(async () => {
      throw new Error('Nothing was submitted or reserved to clean.');
    });
    const beforeItems = f.store.listThreadItems('ws_demo', f.threadId);
    const input = { ...f.input, cleanupBackendSession: cleanup };
    try {
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        expect(listExportableAgentEnvironmentPackageSnapshots(db, 'ws_demo')).toEqual([]);
        expect(readPendingRequest(db.sqlite, 'input_pre_snapshot_108')).toMatchObject({
          delivery: 'frozen',
          deliveryTurnId: f.turnId,
        });
      } finally {
        db.sqlite.close();
      }
      expect(getWorkerBackendSession(f.coreDb, 'lease_pre_snapshot_108')).toBeNull();
      expect(
        f.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_control_records').get()
      ).toEqual({ count: 0 });
      await recoverTestStartup(f.coreDb, input);
      expect(cleanup).not.toHaveBeenCalled();
      await expect(drainTestRecovery(f.coreDb, input)).resolves.toBeUndefined();
      const terminal = f.store.getTurnById(f.turnId);
      expect(terminal.status).toBe('failed');
      expect(terminal.id).toBe(f.turnId);
      const settledDb = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        expect(readPendingRequest(settledDb.sqlite, 'input_pre_snapshot_108')).toMatchObject({
          delivery: 'undelivered',
        });
      } finally {
        settledDb.sqlite.close();
      }
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
      await expect(drainTestRecovery(f.coreDb, input)).resolves.toBeUndefined();
      const reopened = openCoreDb(f.dataRoot);
      try {
        const reloaded = new FsStore({ dataRoot: f.dataRoot });
        await expect(
          runRestartRecoveryThroughMaintenance(reopened, { ...input, store: reloaded })
        ).resolves.toBeDefined();
        expect(reloaded.getTurnById(f.turnId)).toEqual(terminal);
        expect(reloaded.listThreadItems('ws_demo', f.threadId)).toEqual(beforeItems);
        expect(
          reloaded.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
        ).toHaveLength(1);
      } finally {
        reopened.sqlite.close();
      }
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'decided',
    'missing-call',
    'wrong-session',
    'wrong-package',
    'wrong-agent',
    'post-terminal',
    'changed-call',
    'running-call',
    'unknown-status',
    'changed-extra-item',
    'changed-prior-item',
  ] as const)('checks %s publication after boot MCP backfill before failed-start settlement', async (proof) => {
    const suffix = `mcp_backfill_${proof}`;
    const f = await createFailedStartFixture(suffix);
    const completedAt = new Date(Date.parse(f.turn.startedAt!) + 1_000).toISOString();
    f.input.now = () => new Date(Date.parse(completedAt) + 60_000).toISOString();
    const callId = `cap_${suffix}`;
    const itemId = `it_${suffix}`;
    try {
      for (let index = 0; index < 4; index += 1) {
        f.store.createItem({
          id: `it_prior_${suffix}_${index}`,
          workspaceId: 'ws_demo',
          threadId: f.threadId,
          turnId: f.turnId,
          type: 'status',
          status: 'completed',
          level: 'warning',
          title: 'Worker accepted',
          summary: 'The worker attempt was admitted.',
          createdAt: f.turn.startedAt!,
          completedAt: f.turn.startedAt!,
        });
      }
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        const pkg = requireAgentEnvironmentPackageSnapshot(
          db,
          'ws_demo',
          `aepsnap_turn_${suffix}_as_${suffix}`
        ).snapshot;
        startCapabilityCall({
          workspaceDb: db,
          workspaceId: 'ws_demo',
          threadId: f.threadId,
          turnId: f.turnId,
          agentId: f.turn.agentId,
          agentSessionId: f.agentSessionId,
          packageSnapshotId: pkg.snapshotId,
          authorityActor: f.turn.triggerActor,
          callId,
          itemId,
          capabilityId: 'mcp.call_tool',
          family: 'mcp',
          operation: 'mcp.call_tool',
          providerRef: 'github',
          serviceRef: 'mcp-tool:create_branch',
          redactionClass: 'metadata-only',
          now: new Date(Date.parse(completedAt) - 200),
        });
        finishCapabilityCall({
          workspaceDb: db,
          callId,
          status: 'denied',
          errorCode: 'mcp-denied',
          now: new Date(Date.parse(completedAt) + (proof === 'post-terminal' ? 100 : -100)),
        });
      } finally {
        db.sqlite.close();
      }
      const decided = f.store.updateTurn(f.turnId, {
        status: 'failed',
        completedAt,
        error: { code: 'worker_governance_turn_failed', message: 'The worker failed.' },
      });
      f.store.emitTurnEvent(
        f.turnId,
        {
          workspaceId: 'ws_demo',
          threadId: f.threadId,
          turnId: f.turnId,
          requestId: `request_${suffix}`,
          event: 'turn.completed',
          data: { type: 'turn-completed', stopReason: 'error', turn: decided },
        },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      );
      const eventsPath = join(
        f.store.workspaceRootPath('ws_demo'),
        'threads',
        f.threadId,
        'turns',
        f.turnId,
        'runtime',
        'events.jsonl'
      );
      expect(f.store.getTurnById(f.turnId).status).toBe('failed');
      const eventsBefore = readFileSync(eventsPath, 'utf8');
      verifyAndMigrateExistingScopedDatabases(f.dataRoot);
      const store = new FsStore({ dataRoot: f.dataRoot });
      expect(reconcileWorkerMcpItems(f.dataRoot, store)).toBe(1);
      expect(reconcileWorkerMcpItems(f.dataRoot, store)).toBe(0);
      expect(store.getTurnById(f.turnId).items).toHaveLength(5);
      expect(store.getTurnById(f.turnId).items[4]).toMatchObject({
        id: itemId,
        causationId: callId,
        tool: 'create_branch',
        status: 'declined',
        arguments: null,
        result: null,
        error: 'mcp-denied',
      });
      const changed = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        if (proof === 'missing-call')
          changed.sqlite.prepare('DELETE FROM capability_calls WHERE call_id = ?').run(callId);
        if (proof === 'wrong-session')
          changed.sqlite
            .prepare('UPDATE capability_calls SET agent_session_id = ? WHERE call_id = ?')
            .run('as_foreign', callId);
        if (proof === 'wrong-package')
          changed.sqlite
            .prepare('UPDATE capability_calls SET package_snapshot_id = ? WHERE call_id = ?')
            .run('aepsnap_foreign', callId);
        if (proof === 'wrong-agent')
          changed.sqlite
            .prepare('UPDATE capability_calls SET agent_id = ? WHERE call_id = ?')
            .run('agent_foreign', callId);
        if (proof === 'changed-call')
          changed.sqlite
            .prepare('UPDATE capability_calls SET service_ref = ? WHERE call_id = ?')
            .run('mcp-tool:delete_branch', callId);
        if (proof === 'running-call' || proof === 'unknown-status')
          changed.sqlite
            .prepare('UPDATE capability_calls SET status = ? WHERE call_id = ?')
            .run(proof === 'running-call' ? 'running' : 'unrecognized', callId);
      } finally {
        changed.sqlite.close();
      }
      if (proof === 'changed-prior-item' || proof === 'changed-extra-item') {
        // Model contradictory retained bytes; live Store admission correctly forbids this rewrite.
        const itemsPath = join(
          f.store.workspaceRootPath('ws_demo'),
          'threads',
          f.threadId,
          'turns',
          f.turnId,
          'items.jsonl'
        );
        const item = store.getTurnById(f.turnId).items[proof === 'changed-prior-item' ? 0 : 4]!;
        appendFileSync(itemsPath, `${JSON.stringify({ ...item, status: 'failed' })}\n`);
      }
      const currentStore = new FsStore({ dataRoot: f.dataRoot });
      const before = currentStore.getTurnById(f.turnId);
      const input = { ...f.input, store: currentStore };
      if (proof === 'decided') {
        await drainTestRecovery(f.coreDb, input);
        const durable = new FsStore({ dataRoot: f.dataRoot });
        expect(durable.getTurnById(f.turnId)).toEqual(before);
        expect(durable.getAgentSession(f.agentSessionId)).toMatchObject({
          status: 'failed',
          message: decided.error!.message,
          updatedAt: completedAt,
        });
        expect(
          durable.getTurnEvents(f.turnId).filter((event) => event.event === 'agent.session.updated')
        ).toHaveLength(1);
        await drainTestRecovery(f.coreDb, input);
        expect(new FsStore({ dataRoot: f.dataRoot }).getAgentSession(f.agentSessionId)).toEqual(
          durable.getAgentSession(f.agentSessionId)
        );
      } else {
        await expect(drainTestRecovery(f.coreDb, input)).rejects.toSatisfy((error: unknown) =>
          hasRecoveryFailure(
            error,
            'recovery_required: Failed-start terminal publication contradicts its decided Turn.'
          )
        );
        expect(new FsStore({ dataRoot: f.dataRoot }).getAgentSession(f.agentSessionId).status).toBe(
          'busy'
        );
      }
      const terminalBefore = eventsBefore
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.event === 'turn.completed');
      expect(
        currentStore.getTurnEvents(f.turnId).find((event) => event.event === 'turn.completed')
      ).toEqual(terminalBefore);
      expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(f.turnId)).toEqual(before);
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'maintenance',
    'ordinary-owner',
  ] as const)('leaves complete %s publication unchanged across later passes and display refreshes', async (owner) => {
    const f = await createFailedStartFixture(`repeat_${owner}`, owner === 'maintenance');
    let timestamp = f.input.now();
    f.input.now = () => timestamp;
    try {
      const display = f.store.createItem({
        id: `it_display_${owner}`,
        workspaceId: 'ws_demo',
        threadId: f.threadId,
        turnId: f.turnId,
        type: 'status',
        status: 'completed',
        level: 'warning',
        title: 'Worker Turn accepted',
        summary: 'Conversation continued with agent_codex_host.',
        createdAt: f.input.now(),
        completedAt: f.input.now(),
      });
      await recoverTestStartup(f.coreDb, f.input);
      if (owner === 'maintenance') {
        await drainTestRecovery(f.coreDb, f.input);
      } else {
        terminalizeGovernedWorkerTurn({
          store: f.store,
          turnId: f.turnId,
          agentSessionId: f.agentSessionId,
          requestId: `request_repeat_${owner}`,
          completedAt: f.input.now(),
          errorCode: 'worker_governance_turn_failed',
          message: 'Worker turn ended without success.',
          outcome: 'failed',
        });
      }
      const eventsPath = join(
        f.store.workspaceRootPath('ws_demo'),
        'threads',
        f.threadId,
        'turns',
        f.turnId,
        'runtime',
        'events.jsonl'
      );
      expect(f.store.getTurnById(f.turnId).status).toBe('failed');
      const eventsBefore = readFileSync(eventsPath, 'utf8');
      const published = f.store
        .getTurnEvents(f.turnId)
        .find((event) => event.event === 'turn.completed');
      expect(published?.data).toMatchObject({
        type: 'turn-completed',
        stopReason: 'error',
        turn: { status: 'failed' },
      });
      const decided = f.store.getTurnById(f.turnId);
      const session = f.store.getAgentSession(f.agentSessionId);
      expect(session.status).toBe('failed');
      expect(
        f.store.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      timestamp = '2026-10-03T00:01:00.000Z';
      await drainTestRecovery(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId)).toEqual(decided);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(readFileSync(eventsPath, 'utf8')).toBe(eventsBefore);

      // Core Protocol admits only these named display fields after the terminal snapshot.
      f.store.updateItem(
        display.id,
        {
          title: 'Worker Turn failed',
          summary: 'Worker turn ended without success.',
        },
        DISPLAY_PROJECTION_REFRESH_ADMISSION
      );
      const restarted = new FsStore({ dataRoot: f.dataRoot });
      const current = restarted.getTurnById(f.turnId);
      expect(published?.data.type).toBe('turn-completed');
      if (published?.data.type !== 'turn-completed') throw new Error('Missing terminal snapshot.');
      expect(
        Object.keys(current).filter(
          (key) =>
            !isDeepStrictEqual(
              current[key as keyof typeof current],
              published.data.turn[key as keyof typeof current]
            )
        )
      ).toEqual(['items']);
      expect(current.items.find((item) => item.id === display.id)).toMatchObject({
        level: 'warning',
        title: 'Worker Turn failed',
        summary: 'Worker turn ended without success.',
      });
      expect(current.items).toEqual(
        published.data.turn.items.map((item) =>
          item.id === display.id
            ? {
                ...item,
                title: 'Worker Turn failed',
                summary: 'Worker turn ended without success.',
              }
            : item
        )
      );
      expect(published.data.turn.items.find((item) => item.id === display.id)).toMatchObject({
        level: 'warning',
        title: 'Worker Turn accepted',
        summary: 'Conversation continued with agent_codex_host.',
      });
      const lease = requireNanoHostExecutionAttempt(f.coreDb, `lease_repeat_${owner}`);
      const backend = getWorkerBackendSession(f.coreDb, lease.attemptId);
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      const pending = readPendingRequest(db.sqlite, `input_repeat_${owner}`);
      db.sqlite.close();
      for (let pass = 0; pass < 2; pass += 1) {
        timestamp = new Date(Date.parse(timestamp) + 60_000).toISOString();
        await drainTestRecovery(f.coreDb, {
          ...f.input,
          store: restarted,
        });
        const durable = new FsStore({ dataRoot: f.dataRoot });
        expect(durable.getTurnById(f.turnId)).toEqual(current);
        expect(durable.getAgentSession(f.agentSessionId)).toEqual(session);
        expect(readFileSync(eventsPath, 'utf8')).toBe(eventsBefore);
        expect(requireNanoHostExecutionAttempt(f.coreDb, lease.attemptId)).toEqual(lease);
        expect(getWorkerBackendSession(f.coreDb, lease.attemptId)).toEqual(backend);
        const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
        expect(readPendingRequest(after.sqlite, `input_repeat_${owner}`)).toEqual(pending);
        after.sqlite.close();
      }
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'status',
    'stop-reason',
    'agent',
    'session',
    'error-code',
    'error-message',
    'completion-time',
  ] as const)('preserves a contradictory terminal %s and still maintains an independent lease', async (contradiction) => {
    const suffix = `publication_${contradiction}`;
    const f = await createFailedStartFixture(suffix);
    let timestamp = f.input.now();
    f.input.now = () => timestamp;
    try {
      const running = f.store.getTurnById(f.turnId);
      const decided = {
        ...running,
        status: 'failed' as const,
        completedAt: f.input.now(),
        durationMs: running.startedAt
          ? Math.max(0, Date.parse(f.input.now()) - Date.parse(running.startedAt))
          : running.durationMs,
        error: { code: 'worker_governance_turn_failed', message: 'The worker failed.' },
      };
      // Publish before the terminal row so the real store can represent conflicting history.
      f.store.emitTurnEvent(f.turnId, {
        workspaceId: 'ws_demo',
        threadId: f.threadId,
        turnId: f.turnId,
        requestId: `request_${suffix}`,
        event: 'turn.completed',
        data: {
          type: 'turn-completed',
          stopReason: contradiction === 'stop-reason' ? 'aborted' : 'error',
          turn: {
            ...decided,
            ...(contradiction === 'status' ? { status: 'interrupted' as const } : {}),
            ...(contradiction === 'agent' ? { agentId: 'agent_foreign' } : {}),
            ...(contradiction === 'session' ? { agentSessionId: 'as_foreign' } : {}),
            ...(contradiction === 'error-code'
              ? { error: { ...decided.error, code: 'delivery_unknown' } }
              : {}),
            ...(contradiction === 'error-message'
              ? { error: { ...decided.error, message: 'A different failure.' } }
              : {}),
            ...(contradiction === 'completion-time'
              ? { completedAt: '2026-10-02T23:59:00.000Z' }
              : {}),
          },
        },
      });
      f.store.updateTurn(f.turnId, {
        status: decided.status,
        completedAt: decided.completedAt,
        error: decided.error,
      });
      const sibling = `z_after_publication_${contradiction}`;
      f.store.createThread('ws_demo', 'Independent worker', `thread_${sibling}`);
      f.store.createAgentSession({
        id: `as_${sibling}`,
        agentId: 'agent_codex_host',
        workspaceId: 'ws_demo',
        threadId: `thread_${sibling}`,
        status: 'busy',
        message: null,
        environmentPackageSnapshotId: `aepsnap_turn_${sibling}_as_${sibling}`,
        createdAt: f.input.now(),
        updatedAt: f.input.now(),
      });
      f.store.createTurn(
        'ws_demo',
        `thread_${sibling}`,
        'Independent work',
        { kind: 'user', id: LOCAL_USER_ID },
        null,
        {
          turnId: `turn_${sibling}`,
          agentId: 'agent_codex_host',
          agentSessionId: `as_${sibling}`,
          status: 'running',
          executorKind: 'worker',
        }
      );
      dispatchLease(f.coreDb, sibling);
      recordBackendSession(f.coreDb, sibling, 'cleaned');
      beginOwnedAttemptCloseout(f.coreDb, {
        attemptId: `lease_${sibling}`,
        firstTerminalCause: 'turn-start-failed',
        outcome: 'failed',
      });
      expect(
        observeExecutionAttempts(f.coreDb)
          .filter((attempt) => attempt.phase !== 'closed')
          .map((attempt) => attempt.turn_id)
          .sort()
      ).toEqual([`turn_${sibling}`]);
      expect(attempts.requireSchedulerExecutionAttempt(f.coreDb, `lease_${suffix}`)).toMatchObject({
        phase: 'closed',
        fenceRef: `self-check:lease_${suffix}`,
      });
      const store = new FsStore({ dataRoot: f.dataRoot });
      const before = store.getTurnById(f.turnId);
      const session = store.getAgentSession(f.agentSessionId);
      const events = store.getTurnEventsForExport(f.turnId);
      const publication = store
        .getTurnEvents(f.turnId)
        .find((event) => event.event === 'turn.completed');
      if (publication?.data.type !== 'turn-completed')
        throw new Error('Missing contradictory snapshot.');
      const differingFields = Object.keys(before).filter(
        (key) =>
          !isDeepStrictEqual(
            before[key as keyof typeof before],
            publication.data.turn[key as keyof typeof before]
          )
      );
      expect(differingFields).toEqual(
        contradiction === 'stop-reason'
          ? []
          : [
              contradiction === 'status'
                ? 'status'
                : contradiction === 'agent'
                  ? 'agentId'
                  : contradiction === 'session'
                    ? 'agentSessionId'
                    : contradiction === 'completion-time'
                      ? 'completedAt'
                      : 'error',
            ]
      );
      const input = { ...f.input, store, cleanupBackendSession: vi.fn(async () => {}) };
      const completedAt = '2026-10-03T00:01:00.000Z';
      for (let pass = 0; pass < 2; pass += 1) {
        timestamp = new Date(Date.parse(timestamp) + 60_000).toISOString();
        await expect(drainTestRecovery(f.coreDb, input)).rejects.toSatisfy((error: unknown) =>
          hasRecoveryFailure(
            error,
            'recovery_required: Failed-start terminal publication contradicts its decided Turn.'
          )
        );
        const durable = new FsStore({ dataRoot: f.dataRoot });
        expect(durable.getTurnById(f.turnId)).toEqual(before);
        expect(durable.getAgentSession(f.agentSessionId)).toEqual(session);
        expect(durable.getTurnEventsForExport(f.turnId)).toEqual(events);
        expect(
          observeExecutionAttempts(f.coreDb).find(
            (attempt) => attempt.attempt_id === `lease_${sibling}`
          )?.phase
        ).toBe('closed');
        expect(getWorkerBackendSession(f.coreDb, `lease_${sibling}`)?.state).toBe('cleaned');
        expect(durable.getTurnById(`turn_${sibling}`)).toMatchObject({
          status: 'failed',
          completedAt,
          error: { code: 'worker_governance_turn_failed' },
        });
        expect(durable.getAgentSession(`as_${sibling}`)).toMatchObject({
          status: 'failed',
          updatedAt: completedAt,
        });
        expect(
          durable
            .getTurnEvents(`turn_${sibling}`)
            .filter((event) => event.event === 'turn.completed')
        ).toHaveLength(1);
      }
      expect(input.cleanupBackendSession).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('settles unknown delivery and admits an Assistant conversation without claiming worker continuity', async () => {
    const f = await createFailedStartFixture('unknown_outcome', true);
    try {
      await recoverTestStartup(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId).status).toBe('running');
      await drainTestRecovery(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId)).toMatchObject({
        status: 'failed',
        completedAt: f.input.now(),
        error: { code: 'delivery_unknown' },
      });
      // Failed is the existing AgentSession owner's terminal, non-reusable closure.
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('failed');
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(db.sqlite, 'input_unknown_outcome')).toMatchObject({
        delivery: 'delivery-unknown',
        deliveryTurnId: f.turnId,
      });
      db.sqlite.close();
      expect(
        f.store
          .listThreadTurns('ws_demo', f.threadId)
          .every((turn) =>
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)
          )
      ).toBe(true);
      const executor = new SimulatedTurnExecutor();
      const app = createApp({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
        turnExecutor: executor,
        agentManifests: [createTestAgentSetup().manifest],
        gatewayConfig: createTestGatewayConfig(),
        llmPiAiClient: {
          createChatCompletion: vi.fn(async () => ({
            id: 'chatcmpl_recovered_thread',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-5.2',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Fresh conversation admitted.' },
                finish_reason: 'stop',
              },
            ],
          })),
        } as unknown as PiAiGatewayClient,
        providerRegistry: new ProviderRegistry([
          {
            displayName: 'Fixture',
            id: 'agent-openrouter',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
      });
      const response = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: f.threadId },
          {
            body: JSON.stringify({
              requestId: 'fresh_after_failed_delivery',
              targetRef: 'internal-role:assistant',
              input: 'Continue with a fresh task.',
            }),
          }
        )
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({
        receivingWorkspaceId: 'ws_demo',
        receivingThreadId: f.threadId,
        turn: {
          workspaceId: 'ws_demo',
          threadId: f.threadId,
          triggerActor: { kind: 'user', id: LOCAL_USER_ID },
        },
      });
      expect(body.turn.id).not.toBe(f.turnId);
      expect(body.turn.agentSessionId).not.toBe(f.agentSessionId);
      expect(f.store.getTurnById(body.turn.id).threadId).toBe(f.threadId);
      recoverPendingRequestsAtBoot(f.store, f.pending);
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
      const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(after.sqlite, 'input_unknown_outcome')?.delivery).toBe(
        'delivery-unknown'
      );
      after.sqlite.close();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects a queued originating admission before changing outcome delivery or product state', async () => {
    const f = await createFailedStartFixture('queued_admission', true, false);
    f.coreDb.sqlite
      .prepare("UPDATE scheduler_admission_entries SET status = 'queued' WHERE turn_id = ?")
      .run(f.turnId);
    const turn = f.store.getTurnById(f.turnId);
    const session = f.store.getAgentSession(f.agentSessionId);
    const events = f.store.getTurnEvents(f.turnId);
    const admission = f.coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries WHERE turn_id = ?')
      .get(f.turnId);
    const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
    const delivery = readPendingRequest(db.sqlite, 'input_queued_admission');
    db.sqlite.close();
    try {
      await expect(runRestartRecoveryThroughMaintenance(f.coreDb, f.input)).rejects.toSatisfy(
        (error: unknown) => hasRecoveryFailure(error, /recovery_required/)
      );
      expect(f.store.getTurnById(f.turnId)).toEqual(turn);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(f.store.getTurnEvents(f.turnId)).toEqual(events);
      expect(
        f.coreDb.sqlite
          .prepare('SELECT * FROM scheduler_admission_entries WHERE turn_id = ?')
          .get(f.turnId)
      ).toEqual(admission);
      const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(after.sqlite, 'input_queued_admission')).toEqual(delivery);
      after.sqlite.close();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('recovers real worker conversation admission and successor continuity on the same Thread', async () => {
    const f = await createFailedStartFixture('worker_conversation', true);
    const setup = createTestAgentSetup();
    admitTestNativeEnvironment(f.coreDb, setup.manifest);
    await prepareReconnectLease(f.coreDb, 'worker_conversation_sibling');
    const recoveryInput = {
      ...f.input,
      now: () => '2026-07-05T00:01:00.000Z',
      restoreBackendSession: async () => {},
    };
    await recoverTestStartup(f.coreDb, recoveryInput);
    const live = requireNanoHostExecutionAttempt(f.coreDb, 'lease_worker_conversation_sibling');
    const liveBackend = getWorkerBackendSession(f.coreDb, live.attemptId);
    expect(liveBackend).not.toBeNull();
    let finishSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      finishSubmit = resolve;
    });
    const executionBackend = new SimulatedTurnExecutor({ coreDb: f.coreDb });
    const backend: WorkerGovernanceBackend = {
      id: executionBackend.id,
      submit: vi.fn(async (input) => {
        const accepted = await executionBackend.submit(input);
        await submitGate;
        return accepted;
      }),
      inspect: vi.fn((input) => executionBackend.inspect(input)),
      cancel: vi.fn((input) => executionBackend.cancel(input)),
      release: vi.fn((input) => executionBackend.release(input)),
      prepareLaunch: vi.fn(async () => undefined),
      describeCapabilities: async () => ({
        capabilities: ['container', 'transcript-sink', 'worker-control'],
        dynamicCapabilities: [],
        kind: 'openshell',
        version: 'test',
      }),
      validatePackage: async () => [],
      planSession: (pkg) => ({
        agentSessionId: pkg.scope.agentSessionId,
        backendKind: 'openshell',
        backendSessionId: testNanoHostBackendSessionId(pkg.scope.turnId),
        deploymentId: 'deployment-test',
        packageSnapshotId: pkg.snapshotId,
        runtimeTargetId: 'runtime-target-test',
        stagingDirectoryRef: `server/runtime/worker-backend-sessions/${pkg.snapshotId}`,
        transientProviderInstanceId: null,
      }),
      prepareAgentSessionContinuity: vi.fn(async () => 'absent' as const),
      materialize: vi.fn(async (pkg, context) => {
        context?.beforeMaterialization?.();
        return {
          backendKind: 'openshell',
          backendStatus: {
            gatewayEndpoint: null,
            gatewayName: 'openshell',
            health: 'ready',
            version: 'test',
          },
          command: {
            argv: pkg.runtime.command.argv,
            workingDirectory: pkg.runtime.command.workingDirectory,
          },
          controlMode: pkg.control.mode,
          packageId: pkg.packageId,
          packageSnapshotId: pkg.snapshotId,
          requiredCapabilities: pkg.backend.requiredCapabilities,
          workspaceInputs: pkg.workspace.inputs.map((input) => {
            const sessionWorkspace = (
              pkg.extensions.openkit as {
                sessionWorkspace: {
                  layout: { slots: Array<{ id: string; path: string }> };
                  materialization: { inputs: Array<{ inputId: string; slotId: string }> };
                };
              }
            ).sessionWorkspace;
            const slotId = sessionWorkspace.materialization.inputs.find(
              (entry) => entry.inputId === input.id
            )?.slotId;
            const target = sessionWorkspace.layout.slots.find((slot) => slot.id === slotId)?.path;
            if (!target) throw new Error(`Fixture workspace target missing for ${input.id}.`);
            return { access: input.access, id: input.id, kind: input.kind, target };
          }),
          sandbox: {
            name: testNanoHostBackendSessionId(pkg.scope.turnId),
            source: 'openkit/worker-codex:dev',
            state: 'created',
          },
        };
      }),
      cleanupSession: vi.fn(async () => {}),
      update: async () => [],
      collectEvidence: async () => [],
      collectProviderRefreshStatuses: async () => [],
      collectTranscript: async () => ({ itemsJsonl: '' }),
      collectWorkspaceChanges: async () => [],
    };
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb: f.coreDb });
    const prepare = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const starts = vi.spyOn(executor, 'startTurn');
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      turnExecutor: executor,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot: f.dataRoot,
        initialSnapshot: createInMemoryRuntimeConfigSnapshot({
          dataRoot: f.dataRoot,
          agentManifests: [setup.manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              displayName: 'Fixture',
              id: 'agent-openrouter',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
          workspaceConfigs: [
            {
              workspaceId: 'ws_demo',
              path: join(f.dataRoot, 'workspaces/ws_demo/config/workspace.jsonc'),
              config: {
                schemaVersion: 1,
                workspace: { name: 'Demo Workspace', defaultAgentId: setup.manifest.id },
              },
            },
          ],
        }),
      }),
    });
    const submit = (requestId: string) =>
      app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: f.threadId },
          {
            body: JSON.stringify({
              requestId,
              targetRef: `warm-worker:${setup.manifest.id}:default`,
              input: 'Implement the bounded recovery follow-up.',
            }),
          }
        )
      );
    try {
      const refused = await submit('worker_before_settlement');
      expect(refused.status, await refused.clone().text()).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: 'thread_busy',
        message: 'Thread already has a nonterminal Turn.',
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(backend.prepareAgentSessionContinuity).not.toHaveBeenCalled();
      expect(starts).not.toHaveBeenCalled();
      await drainTestRecovery(f.coreDb, recoveryInput);
      expect(f.store.getTurnById(f.turnId)).toMatchObject({
        status: 'failed',
        error: { code: 'delivery_unknown' },
      });
      const admitted = await submit('worker_after_settlement');
      const body = await admitted.json();
      expect(admitted.status, JSON.stringify(body)).toBe(202);
      expect(body).toMatchObject({
        receivingWorkspaceId: 'ws_demo',
        receivingThreadId: f.threadId,
        turn: {
          workspaceId: 'ws_demo',
          threadId: f.threadId,
          agentId: setup.manifest.id,
          triggerActor: { kind: 'user', id: LOCAL_USER_ID },
        },
      });
      expect(body.turn.id).not.toBe(f.turnId);
      // Product responses omit private AgentSession lineage; read its durable Turn and lease owners.
      let successorAgentSessionId: string | null | undefined;
      await vi.waitFor(
        () => {
          successorAgentSessionId = f.store.getTurnById(body.turn.id).agentSessionId;
          expect(successorAgentSessionId).toBeTruthy();
          expect(
            f.store.getAgentSession(successorAgentSessionId!),
            JSON.stringify(f.store.getTurnById(body.turn.id).error)
          ).toMatchObject({
            id: successorAgentSessionId,
            status: 'busy',
            workspaceId: 'ws_demo',
            threadId: f.threadId,
            agentId: setup.manifest.id,
          });
        },
        { timeout: 10000 }
      );
      expect(successorAgentSessionId).not.toBe(f.agentSessionId);
      expect(backend.prepareAgentSessionContinuity).toHaveBeenCalled();
      expect(starts).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(1), { timeout: 10000 });
      expect(backend.materialize).toHaveBeenCalledTimes(1);
      const launchedPackage = vi.mocked(backend.materialize).mock.calls[0]![0];
      expect(launchedPackage.scope).toMatchObject({
        workspaceId: 'ws_demo',
        threadId: f.threadId,
        turnId: body.turn.id,
        agentSessionId: successorAgentSessionId,
        requestId: 'worker_after_settlement',
      });
      const attempt = observeExecutionAttempts(f.coreDb).find(
        (row) => row.turn_id === body.turn.id
      );
      expect(attempt).toMatchObject({
        agent_session_id: successorAgentSessionId,
        workspace_id: 'ws_demo',
        thread_id: f.threadId,
      });
      const submitted = vi.mocked(backend.submit).mock.calls[0]![0];
      const successor = attempts.requireSchedulerExecutionAttempt(f.coreDb, submitted.attemptId);
      expect(attempt!.attempt_id).toBe(successor.attemptId);
      expect(successor).toMatchObject({
        phase: 'open',
        disposition: 'unknown',
        inputRef: launchedPackage.snapshotId,
        fenceRef: null,
      });
      expect(submitted).toEqual({
        ...attempts.schedulerExecutionCorrelation(successor),
        deadline: successor.deadline,
      });
      expect(backend.cancel).not.toHaveBeenCalled();
      expect(backend.release).not.toHaveBeenCalled();
      expect(backend.prepareLaunch).toHaveBeenCalledTimes(1);
      expect(backend.prepareLaunch).toHaveBeenCalledWith(
        await vi.mocked(backend.materialize).mock.results[0]!.value
      );
      recoverPendingRequestsAtBoot(f.store, f.pending);
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(db.sqlite, 'input_worker_conversation')).toMatchObject({
        delivery: 'delivery-unknown',
        deliveryTurnId: f.turnId,
      });
      expect(
        db.sqlite
          .prepare('SELECT request_id FROM pending_requests WHERE delivery_turn_id = ?')
          .all(body.turn.id)
      ).toEqual([]);
      db.sqlite.close();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
      // Scheduler 68/103 binds exclusion, deadlines and exact reconnect facts; an inspection's
      // observation timestamp is not liveness authority. Scheduler 111 preserves unrelated residency.
      expect(requireNanoHostExecutionAttempt(f.coreDb, live.attemptId)).toEqual({
        ...live,
        updatedAt: expect.any(String),
      });
      expect(getWorkerBackendSession(f.coreDb, live.attemptId)).toEqual(liveBackend);
    } finally {
      finishSubmit();
      await Promise.allSettled(starts.mock.results.map((result) => result.value));
      await new Promise<void>((resolve) => setImmediate(resolve));
      prepare.mockRestore();
      starts.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('settles an ordinary failed-start worker with anchored cleanup %s', async (anchored) => {
    const f = await createFailedStartFixture(`ordinary_${anchored}`, false, anchored);
    const lifecycleOwner = vi.spyOn(workerTurnFailure, 'terminalizeGovernedWorkerTurn');
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId)).toMatchObject({
        status: 'failed',
        error: { code: 'worker_governance_turn_failed' },
      });
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('failed');
      // Either the admitted product-boundary callback or direct recovery composition may invoke
      // this existing lifecycle owner; invocation count and anchor shape do not decide closeout.
      expect(lifecycleOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          store: f.store,
          turnId: f.turnId,
          agentSessionId: f.agentSessionId,
          outcome: 'failed',
          errorCode: 'worker_governance_turn_failed',
        })
      );
      const terminal = f.store.getTurnById(f.turnId);
      expect(f.store.getTurnEvents(f.turnId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workspaceId: 'ws_demo',
            threadId: f.threadId,
            turnId: f.turnId,
            event: 'turn.completed',
            data: { type: 'turn-completed', stopReason: 'error', turn: terminal },
          }),
          expect.objectContaining({
            event: 'agent.session.updated',
            data: expect.objectContaining({
              type: 'agent-session-updated',
              agentSession: expect.objectContaining({ id: f.agentSessionId, status: 'failed' }),
            }),
          }),
        ])
      );
    } finally {
      lifecycleOwner.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('finishes a crash after the decided delivery failure without replacing its bytes or duplicating publications', async () => {
    const f = await createFailedStartFixture('partial_delivery', true);
    f.store.updateTurn(f.turnId, {
      status: 'failed',
      completedAt: '2026-10-02T23:59:00.000Z',
      error: { code: 'delivery_unknown', message: 'Outcome delivery could not be proved.' },
    });
    const decided = f.store.getTurnById(f.turnId);
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, f.input);
      await drainTestRecovery(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId)).toEqual(decided);
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('failed');
      const events = f.store.getTurnEvents(f.turnId);
      expect(events.filter((event) => event.event === 'turn.completed')).toHaveLength(1);
      expect(events.find((event) => event.event === 'turn.completed')?.data).toMatchObject({
        stopReason: 'error',
        turn: decided,
      });
      expect(events.filter((event) => event.event === 'agent.session.updated')).toHaveLength(1);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'package',
    'request',
    'route-token',
    'anchor',
    'runtime-binding',
    'stale-session',
  ] as const)('leaves contradictory %s lineage recovery-required without product writes', async (contradiction) => {
    const f = await createFailedStartFixture(
      `contradictory_${contradiction}`,
      false,
      ['package', 'request', 'runtime-binding'].includes(contradiction)
    );
    if (contradiction === 'package')
      f.store.updateAgentSession(f.agentSessionId, {
        environmentPackageSnapshotId: 'aepsnap_other',
      });
    if (contradiction === 'request')
      f.coreDb.sqlite
        .prepare('UPDATE scheduler_admission_entries SET request_id = ? WHERE turn_id = ?')
        .run('request_other', f.turnId);
    if (contradiction === 'route-token')
      f.coreDb.sqlite
        .prepare(
          'UPDATE scheduler_execution_attempts SET worker_control_token_hash = ? WHERE turn_id = ?'
        )
        .run('a'.repeat(64), f.turnId);
    if (contradiction === 'anchor')
      f.coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET operation_id = 'lost-submission' WHERE turn_id = ?"
        )
        .run(f.turnId);
    if (contradiction === 'stale-session')
      f.store.updateAgentSession(f.agentSessionId, { stale: true });
    if (contradiction === 'runtime-binding') {
      f.coreDb.sqlite
        .prepare(`INSERT INTO sandbox_runtime_records
        (sandbox_runtime_id, runtime_target_id, origin_physical_epoch, sandbox_binding_ref,
         sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest, environment_class,
         max_open_sessions, max_harnesses, max_active_turns, lifecycle_state, health_state, drain_state,
         cleanup_state, created_at, updated_at)
        VALUES ('sandbox_contradictory', 'runtime-target-test', ?, 'sandbox-binding-contradictory',
         'integration-binding-contradictory', ?, ?, 'test', 2, 2, 1, 'open', 'ready', 'accepting', 'unknown', ?, ?)`)
        .run('a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64), f.input.now(), f.input.now());
      f.coreDb.sqlite
        .prepare(`INSERT INTO harness_instance_records
        (harness_instance_id, sandbox_runtime_id, harness_binding_ref, harness_compatibility_key,
         runtime_family, adapter_id, adapter_version, protocol_version, capabilities_json, max_open_sessions,
         max_active_turns, open_session_count, active_turn_count, lifecycle_state, drain_state, next_sequence,
         operation_state, created_at, updated_at)
        VALUES ('harness_contradictory', 'sandbox_contradictory', 'harness-binding-contradictory', ?,
         'codex', 'codex', 'test', 1, '[]', 2, 1, 1, 1, 'open', 'accepting', 1, 'idle', ?, ?)`)
        .run('a'.repeat(64), f.input.now(), f.input.now());
      f.coreDb.sqlite
        .prepare(`INSERT INTO agent_session_runtime_bindings
      (agent_session_runtime_binding_id, harness_instance_id, agent_session_id, workspace_id, thread_id,
       agent_session_compatibility_key, effective_setup_generation, native_handle_state, lifecycle_state,
       current_turn_id, current_attempt_id, next_turn_sequence, cleanup_state, created_at, updated_at, image_digest)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'absent', 'active', ?, ?, 1, 'unknown', ?, ?, ?)`)
        .run(
          'binding_contradictory',
          'harness_contradictory',
          f.agentSessionId,
          'ws_demo',
          f.threadId,
          'a'.repeat(64),
          f.turnId,
          `lease_contradictory_${contradiction}`,
          f.input.now(),
          f.input.now(),
          'a'.repeat(64)
        );
    }
    const before = f.store.getTurnById(f.turnId);
    try {
      await expect(runRestartRecoveryThroughMaintenance(f.coreDb, f.input)).rejects.toSatisfy(
        (error: unknown) => hasRecoveryFailure(error, /recovery_required/)
      );
      expect(f.store.getTurnById(f.turnId)).toEqual(before);
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('busy');
      expect(f.store.getTurnEvents(f.turnId)).toEqual([]);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'session',
    'terminal-event',
  ] as const)('retries a real failed %s write after the Turn decision survives a product-store reload', async (missing) => {
    const f = await createFailedStartFixture(`write_failure_${missing}`, true);
    const emit = f.store.emitTurnEvent.bind(f.store);
    const fault =
      missing === 'session'
        ? vi.spyOn(f.store, 'updateAgentSession').mockImplementationOnce(() => {
            throw new Error('Injected session write failure.');
          })
        : vi.spyOn(f.store, 'emitTurnEvent').mockImplementation((...args) => {
            if (args[1].event === 'turn.completed')
              throw new Error('Injected terminal event failure.');
            return emit(...args);
          });
    try {
      await recoverTestStartup(f.coreDb, f.input);
      await expect(drainTestRecovery(f.coreDb, f.input)).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(
          error,
          /recovery_required: Governed worker turn terminalization encountered partial persistence errors/
        )
      );
      const decided = f.store.getTurnById(f.turnId);
      expect(decided).toMatchObject({ status: 'failed', error: { code: 'delivery_unknown' } });
      fault.mockRestore();
      const restarted = new FsStore({ dataRoot: f.dataRoot });
      const input = { ...f.input, store: restarted };
      await drainTestRecovery(f.coreDb, input);
      await drainTestRecovery(f.coreDb, input);
      expect(restarted.getTurnById(f.turnId)).toEqual(decided);
      expect(restarted.getAgentSession(f.agentSessionId).status).toBe('failed');
      expect(
        restarted.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      expect(
        restarted.getTurnEvents(f.turnId).filter((event) => event.event === 'agent.session.updated')
      ).toHaveLength(1);
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      fault.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('preserves an authoritative typed refusal and proved outcome delivery while repairing publication', async () => {
    const f = await createFailedStartFixture('typed_refusal', true);
    const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
    db.sqlite
      .prepare(
        "UPDATE pending_requests SET delivery = 'delivered', held_result_json = NULL WHERE delivery_turn_id = ?"
      )
      .run(f.turnId);
    const proved = readPendingRequest(db.sqlite, 'input_typed_refusal');
    db.sqlite.close();
    f.store.updateTurn(f.turnId, {
      status: 'failed',
      completedAt: '2026-10-02T23:59:00.000Z',
      error: { code: 'native_admission_refused', message: 'An authoritative native refusal.' },
    });
    const decided = f.store.getTurnById(f.turnId);
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, f.input);
      await drainTestRecovery(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId)).toEqual(decided);
      expect(f.store.getAgentSession(f.agentSessionId)).toMatchObject({
        status: 'failed',
        message: decided.error!.message,
      });
      expect(
        f.store.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(after.sqlite, 'input_typed_refusal')).toEqual(proved);
      after.sqlite.close();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('preserves a live sibling and its exact awaiting-reconnect attempt', async () => {
    const f = await createFailedStartFixture('beside_live');
    f.input.now = () => '2026-07-05T00:01:00.000Z';
    await prepareReconnectLease(f.coreDb, 'surviving_sibling');
    const live = requireNanoHostExecutionAttempt(f.coreDb, 'lease_surviving_sibling');
    try {
      const input = { ...f.input, restoreBackendSession: async () => {} };
      await recoverTestStartup(f.coreDb, input);
      const armed = requireNanoHostExecutionAttempt(f.coreDb, live.attemptId);
      expect(armed).toMatchObject({ phase: 'open', recoveryState: 'awaiting-reconnect' });
      await drainTestRecovery(f.coreDb, input);
      expect(requireNanoHostExecutionAttempt(f.coreDb, live.attemptId)).toEqual({
        ...armed,
        updatedAt: expect.any(String),
      });
      expect(f.store.getTurnById(f.turnId).status).toBe('failed');
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'checkpoint',
    'accepted-final',
    'live-owner',
  ] as const)('leaves an existing %s with its owner', async (owner) => {
    const suffix = `existing_${owner}`;
    const f = await createFailedStartFixture(suffix);
    if (owner === 'checkpoint') {
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      db.sqlite
        .prepare(`INSERT INTO worker_turn_checkpoints
        (checkpoint_id, workspace_id, thread_id, turn_id, request_id, request_input_hash, stage, iteration, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running_worker', 1, ?, ?)`)
        .run(
          `checkpoint_${suffix}`,
          'ws_demo',
          f.threadId,
          f.turnId,
          `request_${suffix}`,
          'a'.repeat(64),
          f.input.now(),
          f.input.now()
        );
      db.sqlite.close();
    }
    if (owner === 'accepted-final')
      recordWorkerControlAcceptedRecord(f.coreDb, {
        acceptedAt: f.input.now(),
        lineage: {
          agentSessionId: f.agentSessionId,
          packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
          requestId: `request_${suffix}`,
          threadId: f.threadId,
          turnId: f.turnId,
          workspaceId: 'ws_demo',
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });
    const before = f.store.getTurnById(f.turnId);
    const session = f.store.getAgentSession(f.agentSessionId);
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, {
        ...f.input,
        isTurnExecutionActive: () => owner === 'live-owner',
      });
      expect(f.store.getTurnById(f.turnId)).toEqual(before);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(f.store.getTurnEvents(f.turnId)).toEqual([]);
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

/** Current recovery dependencies supplied by each bounded record fixture. */
type RecoveryFixtureInput = Partial<RunNanoHostAttemptRecoveryInput> &
  Pick<RunNanoHostAttemptRecoveryInput, 'projectRecoveredTurn'>;

/** Supplies the explicit in-process effect owner for record-level restart fixtures. */
function testRecoveryInput(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  input: Partial<RunNanoHostAttemptRecoveryInput> &
    Pick<RunNanoHostAttemptRecoveryInput, 'projectRecoveredTurn'>
): RunNanoHostAttemptRecoveryInput {
  return {
    executionBackend: new SimulatedTurnExecutor({ coreDb }),
    cleanupBackendSession: async () => {},
    prepareBackendCleanup: () => {},
    restoreBackendSession: async () => {},
    reconcileAcceptedFinalStatus: async () => {},
    ...input,
  };
}

/** Exercises the two independent startup owners in the order used by index.ts. */
async function recoverTestStartup(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  input: Parameters<typeof testRecoveryInput>[1]
) {
  const current = testRecoveryInput(coreDb, input);
  const recovery = await runSchedulerRestartRecovery(coreDb, current);
  await classifyNanoHostAttemptsAfterRestart(coreDb, current);
  return recovery;
}

/** Exercises Generic inspection and then the separate Native post-listener drain. */
async function drainTestRecovery(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  input: Parameters<typeof testRecoveryInput>[1]
) {
  const current = testRecoveryInput(coreDb, input);
  await runSchedulerRecoveryMaintenance(coreDb, current);
  await runNanoHostAttemptRecoveryMaintenance(coreDb, current);
}

/** Runs startup classification followed by the existing post-listener recovery owners. */
async function runRestartRecoveryThroughMaintenance(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  input: Parameters<typeof testRecoveryInput>[1]
) {
  const recovery = await recoverTestStartup(coreDb, input);
  await drainTestRecovery(coreDb, input);
  return recovery;
}

/** Records one scheduler-recovery package with an explicit or default trigger actor. */
function recordTestAgentEnvironmentPackage(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  input: {
    readonly suffix: string;
    readonly triggerActor?: ActorRef;
    readonly workspaceInputIds: readonly string[];
  }
): AgentEnvironmentPackage {
  const coreDb = openCoreDb(workspaceDb.dataRoot);
  try {
    return recordBaseTestAgentEnvironmentPackage(workspaceDb, {
      coreDb,
      suffix: input.suffix,
      triggerActor: input.triggerActor ?? { kind: 'user', id: LOCAL_USER_ID },
      workspaceInputIds: input.workspaceInputIds,
    });
  } finally {
    coreDb.sqlite.close();
  }
}

/** Persists the exact Generic and Native preparation boundary before any acknowledgement. */
function dispatchLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  triggerActor: ActorRef = { kind: 'user', id: LOCAL_USER_ID },
  submitted = true,
  nativePrepared = true
): void {
  const responsible =
    triggerActor.kind === 'user' ? triggerActor.id : triggerActor.responsibleUserId;
  if (responsible !== LOCAL_USER_ID) {
    const at = Date.parse('2026-07-05T00:00:00.000Z');
    coreDb.sqlite
      .prepare(
        "INSERT OR IGNORE INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, ?, ?, 0, ?, ?, 'human', 'active')"
      )
      .run(responsible, responsible, `${responsible}@restart.invalid`, at, at);
    coreDb.sqlite
      .prepare(
        "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES ('ws_demo', ?, 'active', 'editor', NULL, ?, NULL, 1, ?, ?)"
      )
      .run(
        responsible,
        '2026-07-05T00:00:00.000Z',
        '2026-07-05T00:00:00.000Z',
        '2026-07-05T00:00:00.000Z'
      );
  }
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor,
    queueEntryId: `queue_${suffix}`,
    requestId: `request_${suffix}`,
    requestedAgentId: 'agent_codex_host',
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run ${suffix}`,
    workspaceId: 'ws_demo',
    now: () => '2026-07-05T00:00:01.000Z',
  });
  if (!nativePrepared) {
    const attempt = attempts.createSchedulerExecutionAttempt(coreDb, {
      entry,
      attemptId: `lease_${suffix}`,
      preparationInput: { admission: entry },
      now: () => '2026-07-05T00:00:02.000Z',
    });
    attempts.bindSchedulerExecutionAttemptSession(coreDb, {
      attemptId: attempt.attemptId,
      agentSessionId: `as_${suffix}`,
      now: () => '2026-07-05T00:00:02.000Z',
    });
  } else {
    recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId: `lease_${suffix}`,
      agentSessionId: `as_${suffix}`,
      inputRef: `aepsnap_turn_${suffix}_as_${suffix}`,
      bindingRef: `lease-binding:lease_${suffix}`,
      sessionCompatibilityKey: 'sha256:restart-fixture',
      now: () => '2026-07-05T00:00:02.000Z',
      ...(submitted ? { operationId: `operation_${suffix}` } : {}),
    });
  }
}

/** Returns the non-reversible lease binding for one memory-only reconnect key. */
function reconnectKeyHash(reconnectKey: string): string {
  return createHash('sha256').update(Buffer.from(reconnectKey, 'base64url')).digest('base64url');
}

/** Creates one deterministic canonical 256-bit process key for a test worker. */
function reconnectKeyFor(suffix: string): string {
  return createHash('sha256').update(`process-key-${suffix}`).digest('base64url');
}

/**
 * Seeds one anchored worker with optional durable proof that child execution started.
 *
 * @param coreDb Open Core database.
 * @param suffix Stable test identity suffix.
 * @param postLaunch Whether to record the first post-launch heartbeat.
 * @param reconnectKey Memory-only worker process key.
 * @returns Worker lineage and reconnect key.
 */
async function prepareReconnectLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  postLaunch = true,
  reconnectKey = reconnectKeyFor(suffix)
): Promise<{ readonly lineage: WorkerControlLineage; readonly reconnectKey: string }> {
  dispatchLease(coreDb, suffix);
  const submitted = attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`);
  attempts.acceptSchedulerExecutionObservation(
    coreDb,
    await new SimulatedTurnExecutor({ coreDb }).submit({
      ...attempts.schedulerExecutionCorrelation(submitted),
      deadline: submitted.deadline!,
    })
  );
  recordBackendSession(coreDb, suffix, 'launching');
  markWorkerBackendWorkspaceHandoffComplete(coreDb, {
    attemptId: `lease_${suffix}`,
    now: () => '2026-07-05T00:00:04.000Z',
  });
  acceptNanoHostAttemptHeartbeat(coreDb, {
    heartbeatTimeoutMs: 30_000,
    attemptId: `lease_${suffix}`,
    now: () => '2026-07-05T00:00:05.000Z',
    workerProcessKeyHash: reconnectKeyHash(reconnectKey),
    workerSequence: 0,
  });
  if (postLaunch) {
    acceptNanoHostAttemptHeartbeat(coreDb, {
      heartbeatTimeoutMs: 30_000,
      attemptId: `lease_${suffix}`,
      now: () => '2026-07-05T00:00:06.000Z',
      workerSequence: 1,
    });
  }

  return {
    lineage: {
      agentSessionId: `as_${suffix}`,
      packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      requestId: `request_${suffix}`,
      threadId: `thread_${suffix}`,
      turnId: `turn_${suffix}`,
      workspaceId: 'ws_demo',
    },
    reconnectKey,
  };
}

/** Returns one production-shaped NanoHost backend attempt identity for a fixture suffix. */
function testNanoHostBackendSessionId(suffix: string): string {
  const digest = createHash('sha256').update(suffix).digest('hex');
  return `nh-${digest.slice(0, 16)}-${digest.slice(16, 32)}`;
}

/** Records one durable backend anchor and advances it to the requested state. */
function recordBackendSession(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  state: WorkerBackendSessionState = 'materializing'
): void {
  const existingRuntimeTarget = coreDb.sqlite
    .prepare('SELECT target_id FROM nanohost_runtime_targets LIMIT 1')
    .get() as { readonly target_id: string } | undefined;
  if (!existingRuntimeTarget) {
    const allocated = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'identity-test',
      observedAt: '2026-07-05T00:00:00.000Z',
      targetId: 'runtime-target-test',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...allocated,
      freshEmpty: true,
      observedAt: '2026-07-05T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
  }
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  try {
    applyScopedMigrations(workspaceDb);
    if (
      !listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_demo').some(
        (record) => record.snapshotId === `aepsnap_turn_${suffix}_as_${suffix}`
      )
    ) {
      recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds: [] });
    }
  } finally {
    workspaceDb.sqlite.close();
  }
  recordWorkerBackendSessionMaterializing(coreDb, {
    backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: `as_${suffix}`,
      backendKind: 'openshell',
      backendSessionId: testNanoHostBackendSessionId(suffix),
      deploymentId: 'deployment-test',
      packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/aepsnap_turn_${suffix}_as_${suffix}`,
      transientProviderInstanceId: null,
    },
    lineage: {
      threadId: `thread_${suffix}`,
      turnId: `turn_${suffix}`,
      workspaceId: 'ws_demo',
    },
    now: () => '2026-07-05T00:00:03.000Z',
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
  });
  const path: WorkerBackendSessionState[] =
    state === 'materializing'
      ? []
      : state === 'materialized'
        ? ['materialized']
        : state === 'launching'
          ? ['materialized', 'launching']
          : state === 'cleanup-pending'
            ? ['cleanup-pending']
            : state === 'cleanup-failed'
              ? ['cleanup-pending', 'cleanup-failed']
              : state === 'physical-cleaned'
                ? ['cleanup-pending', 'physical-cleaned']
                : ['cleanup-pending', 'physical-cleaned', 'cleaned'];
  let fromState: WorkerBackendSessionState = 'materializing';
  for (const toState of path) {
    transitionWorkerBackendSessionState(coreDb, {
      fromState,
      attemptId: `lease_${suffix}`,
      toState,
      now: () => '2026-07-05T00:00:07.000Z',
    });
    fromState = toState;
  }
}

/** Records the production-shaped workspace handoff for one immutable package. */
function recordCanonicalWorkspaceHandoff(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  environmentPackage: AgentEnvironmentPackage,
  createdAt: string
): void {
  const inputSnapshots = recordWorkspaceInputSnapshots(
    workspaceDb,
    buildWorkspaceInputSnapshots({
      backendCapabilities: ['trusted-worker-inference-relay'],
      backendKind: 'openshell',
      createdAt,
      environmentPackage,
    })
  );
  recordWorkspaceMaterializationRecords(
    workspaceDb,
    buildWorkspaceMaterializationRecords({
      createdAt,
      inputSnapshots,
      materialization: {
        backendKind: 'openshell',
        backendStatus: { health: 'ready', version: '0.0.99' },
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: environmentPackage.backend.requiredCapabilities,
        sandbox: {
          name: testNanoHostBackendSessionId(
            environmentPackage.scope.agentSessionId.replace(/^as_/, '')
          ),
          state: 'created',
        },
        workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
          id: input.id,
          target: input.target,
        })),
      },
    })
  );
}

/** Resolves actual retained recovery records through the existing human decision owner. */
function abandonRetainedWorkspaceRecovery(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  decidedAt: string
): void {
  // Workspace Synchronization 582–592 requires exact evidence evaluation before teardown;
  // 608 permits a terminal human decision to authorize teardown of the retained backend.
  const handles = listBackendWorkspaceHandles(workspaceDb, 'ws_demo');
  expect(handles.length).toBeGreaterThan(0);
  const records = listWorkspaceReconciliationRecords(workspaceDb, 'ws_demo');
  for (const handle of handles) {
    expect(handle.cleanupStatus).toBe('pending');
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          affectedRecordIds: expect.arrayContaining([handle.id, handle.materializationRecordId]),
          stateAfter: 'requires-human',
          retentionDecision: 'retain-backend',
          finishedAt: null,
        }),
      ])
    );
  }
  for (const record of records.filter((candidate) =>
    handles.some((handle) => candidate.affectedRecordIds.includes(handle.id))
  )) {
    expect(record.requiredHumanDecision).toBeTruthy();
    expect(
      resolveWorkspaceReconciliationRecord({
        workspaceDb,
        workspaceId: 'ws_demo',
        reconciliationRecordId: record.id,
        decision: 'abandon',
        decidedAt,
      })
    ).toMatchObject({
      stateBefore: 'requires-human',
      stateAfter: 'unrecoverable',
      retentionDecision: 'teardown-backend',
      requiredHumanDecision: null,
      finishedAt: decidedAt,
    });
  }
}

/** Executor that fails if a recovered admission is dispatched again. */
class RejectRecoveredTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    artifacts: false,
    interrupts: false,
    questions: false,
    workspaceConfig: false,
    workspaceKnowledgeEditing: false,
  };
  public readonly eventFamilies = ['turn.started'] as const;
  public readonly itemTypes = ['status'] as const;
  public readonly calls: string[] = [];

  /** Records the forbidden redispatch before failing the test. */
  public async startTurn(_store: FsStore, turnId: string): Promise<void> {
    this.calls.push(turnId);
    throw new Error(`Recovered turn was dispatched again: ${turnId}`);
  }

  /** No-op because restart recovery never invokes commands. */
  public async interruptTurn(): Promise<void> {}
}

describe('scheduler restart recovery', () => {
  it('retains a poll-first unknown fence while re-deriving only exact read-only expectations until fresh-ready cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'result_only_unknown_fence';
    const leaseId = `lease_${suffix}`;
    const runtimeTargetId = `target_${suffix}`;
    const effects: NanoHostSessionEffectRequest[] = [];
    const resultOnlyRejectors: Array<(error: Error) => void> = [];
    let resultOnlyRegistrations = 0;
    const cleanupExpectations: unknown[] = [];
    let rejectedResultOnlyRegistrations = 0;
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
        return {};
      },
      expectResultOnly(expectations) {
        cleanupExpectations.push(structuredClone(expectations));
        resultOnlyRegistrations += 1;
        return new Promise<never>((_, reject) => resultOnlyRejectors.push(reject));
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    const createRuntime = () =>
      createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
    const recoveryInput = (
      runtime: ReturnType<typeof createConfiguredWorkerLifecycleRuntime>,
      now: () => string
    ): RecoveryFixtureInput => ({
      cleanupBackendSession: runtime.cleanupBackendSession,
      now,
      prepareBackendCleanup: runtime.prepareBackendCleanup,
      projectRecoveredTurn: async () => ({ status: 'failed' }),
    });
    const expectFencedAuthority = () => {
      const backendSession = getWorkerBackendSession(coreDb, leaseId);
      expect(['cleanup-pending', 'cleanup-failed']).toContain(backendSession?.state);
      expect(backendSession?.physicalCleanedAt).toBeNull();
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === leaseId)?.phase
      );

      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM sandbox_runtime_records) AS sandboxes,
               (SELECT COUNT(*) FROM harness_instance_records) AS harnesses,
               (SELECT COUNT(*) FROM agent_session_runtime_bindings) AS bindings`
          )
          .get()
      ).toEqual({ bindings: 0, harnesses: 0, sandboxes: 0 });
    };
    const rejectUnexpectedRegistrations = () => {
      while (rejectedResultOnlyRegistrations < resultOnlyRejectors.length) {
        resultOnlyRejectors[rejectedResultOnlyRegistrations]?.(
          new Error('Old result-only cleanup expectation must not be registered again.')
        );
        rejectedResultOnlyRegistrations += 1;
      }
    };
    const expectMaintenanceFenced = async (input: RecoveryFixtureInput, registrations = 1) => {
      const maintenance = drainTestRecovery(coreDb, input);
      rejectUnexpectedRegistrations();
      await expect(maintenance).rejects.toThrow();
      expect.soft(resultOnlyRegistrations).toBe(registrations);
      expectFencedAuthority();
    };

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'cleanup-pending');
      coreDb.sqlite
        .prepare(
          `UPDATE worker_backend_sessions
           SET runtime_target_id = ?
           WHERE attempt_id = ?`
        )
        .run(runtimeTargetId, leaseId);
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES (?, ?, 'deployment-test', 1, 1, 1, 1, ?, ?, 1)`
        )
        .run(runtimeTargetId, `identity_${suffix}`, 'a'.repeat(64), '2026-07-05T00:00:00.000Z');
      expectFencedAuthority();

      const initialRuntime = createRuntime();
      let recoveryTime = '2026-07-05T00:01:00.000Z';
      const initialInput = recoveryInput(initialRuntime, () => recoveryTime);
      await recoverTestStartup(coreDb, initialInput);
      expect(resultOnlyRegistrations).toBe(1);
      const initialMaintenance = drainTestRecovery(coreDb, initialInput);
      const sameCoordinatorReadyAt = '2026-07-05T00:01:01.000Z';
      upsertNanoHostRuntimeTarget(coreDb, {
        connectionGeneration: 1,
        deploymentId: 'deployment-test',
        freshEmpty: true,
        identityId: `identity_${suffix}`,
        observedAt: sameCoordinatorReadyAt,
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
        targetId: runtimeTargetId,
      });
      recoveryTime = '2026-07-05T00:01:02.000Z';
      resultOnlyRejectors[0]?.(
        new Error('NanoHost accepted effect outcome is unknown; successor connection fenced.')
      );
      rejectedResultOnlyRegistrations = 1;
      await expect(initialMaintenance).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, /unknown/i)
      );
      expectFencedAuthority();
      const fenceObservedAt = getWorkerBackendSession(coreDb, leaseId)?.updatedAt;
      if (!fenceObservedAt) {
        throw new Error('Poll-first unknown did not retain a durable backend fence time.');
      }
      expect(fenceObservedAt).toBe(recoveryTime);
      await expectMaintenanceFenced(initialInput);

      coreDb.sqlite
        .prepare(
          `UPDATE nanohost_runtime_targets
           SET predecessor_fenced = 1, ready = 1, fresh_empty = 1,
               physical_epoch = ?, observed_at = ?
           WHERE target_id = ?`
        )
        .run(
          'a'.repeat(64),
          new Date(Date.parse(fenceObservedAt) - 1).toISOString(),
          runtimeTargetId
        );
      await expectMaintenanceFenced(initialInput);

      const restartedRuntime = createRuntime();
      const restartedInput = recoveryInput(restartedRuntime, () => '2026-07-05T00:01:03.000Z');
      await recoverTestStartup(coreDb, restartedInput);
      expect.soft(resultOnlyRegistrations).toBe(2);
      expect(cleanupExpectations[1]).toEqual(cleanupExpectations[0]);
      expectFencedAuthority();

      for (const [observedOffsetMs, predecessorFenced, ready, freshEmpty] of [
        [-1, 1, 1, 1],
        [0, 1, 1, 1],
        [1, 0, 1, 1],
        [1, 1, 0, 1],
        [1, 1, 1, 0],
      ] as const) {
        coreDb.sqlite
          .prepare(
            `UPDATE nanohost_runtime_targets
             SET predecessor_fenced = ?, ready = ?, fresh_empty = ?,
                 physical_epoch = ?, observed_at = ?
             WHERE target_id = ?`
          )
          .run(
            predecessorFenced,
            ready,
            freshEmpty,
            ready === 1 ? 'a'.repeat(64) : null,
            new Date(Date.parse(fenceObservedAt) + observedOffsetMs).toISOString(),
            runtimeTargetId
          );
        await expectMaintenanceFenced(restartedInput, 2);
      }

      const successorObservedAt = new Date(Date.parse(fenceObservedAt) + 1).toISOString();
      const successor = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: `identity_${suffix}`,
        observedAt: successorObservedAt,
        targetId: runtimeTargetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        connectionGeneration: successor.connectionGeneration,
        deploymentId: 'deployment-test',
        freshEmpty: true,
        identityId: `identity_${suffix}`,
        observedAt: successorObservedAt,
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
        targetId: runtimeTargetId,
      });
      const finalMaintenance = drainTestRecovery(coreDb, restartedInput);
      rejectUnexpectedRegistrations();
      await expect(finalMaintenance).resolves.toBeUndefined();

      expect(resultOnlyRegistrations).toBe(2);
      expect(cleanupExpectations).toHaveLength(2);
      expect(cleanupExpectations[1]).toEqual(cleanupExpectations[0]);
      expect(effects).toEqual([]);
      expect(getWorkerBackendSession(coreDb, leaseId)).toMatchObject({
        state: 'cleaned',
      });
      expect(getWorkerBackendSession(coreDb, leaseId)?.physicalCleanedAt).not.toBeNull();
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === leaseId)?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires the exact attempt, backend/package, original process, and next sequence at adoption', async () => {
    for (const mismatch of [
      'none',
      'binding',
      'backend',
      'package',
      'process',
      'sequence',
      'epoch',
    ] as const) {
      const coreDb = createMigratedCoreDb();
      try {
        const suffix = `lineage_${mismatch}`;
        const fixture = await prepareReconnectLease(coreDb, suffix);
        await recoverTestStartup(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' }),
        });
        if (mismatch === 'backend')
          coreDb.sqlite
            .prepare('UPDATE worker_backend_sessions SET agent_session_id=? WHERE attempt_id=?')
            .run('as_other', `lease_${suffix}`);
        if (mismatch === 'package')
          coreDb.sqlite
            .prepare('UPDATE worker_backend_sessions SET package_snapshot_id=? WHERE attempt_id=?')
            .run('aepsnap_other', `lease_${suffix}`);
        if (mismatch === 'epoch')
          coreDb.sqlite
            .prepare('UPDATE nanohost_runtime_targets SET physical_epoch=?')
            .run('b'.repeat(64));
        const adopt = () =>
          adoptNanoHostAttemptReconnect(coreDb, {
            acceptedAt: '2026-07-05T00:01:01.000Z',
            lineage: fixture.lineage,
            reconnectKey: mismatch === 'process' ? reconnectKeyFor('other') : fixture.reconnectKey,
            sandboxBindingRef:
              mismatch === 'binding' ? 'wrong-binding' : `lease-binding:lease_${suffix}`,
            workerSequence: mismatch === 'sequence' ? 3 : 2,
          });
        if (mismatch === 'none')
          expect(adopt()).toMatchObject({
            phase: 'open',
            recoveryState: null,
            lastWorkerSequence: 1,
          });
        else {
          const before = requireNanoHostExecutionAttempt(coreDb, `lease_${suffix}`);
          expect(adopt).toThrow();
          expect(requireNanoHostExecutionAttempt(coreDb, `lease_${suffix}`)).toEqual(before);
        }
      } finally {
        coreDb.sqlite.close();
      }
    }
  });

  it('fails pre-anchor acquired leases and cancels their admission entries', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'prelaunch', { kind: 'user', id: LOCAL_USER_ID }, false);

      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === 'lease_prelaunch')
          ?.phase
      ).toBe('closed');
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { partial: false, workspaceInputIds: [] },
    { partial: true, workspaceInputIds: [] },
    { partial: false, workspaceInputIds: ['source'] },
    { partial: true, workspaceInputIds: ['source'] },
  ])('terminalizes a no-operation failed start despite unused-anchor cleanup failure ($partial, $workspaceInputIds)', async ({
    partial,
    workspaceInputIds,
  }) => {
    const suffix = `no_effect_cleanup_failure_${partial}_${workspaceInputIds.length}`;
    const f = await createFailedStartFixture(suffix, false, false, true, workspaceInputIds);
    try {
      f.coreDb.sqlite
        .prepare("UPDATE scheduler_execution_attempts SET phase = 'open' WHERE attempt_id = ?")
        .run(`lease_${suffix}`);
      recordBackendSession(f.coreDb, suffix, 'cleanup-failed');
      f.coreDb.sqlite
        .prepare("UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE attempt_id = ?")
        .run(`lease_${suffix}`);
      f.store.updateAgentSession(f.agentSessionId, { status: 'created' });
      expect(
        f.coreDb.sqlite
          .prepare(`SELECT
          (SELECT COUNT(*) FROM scheduler_execution_attempts) AS attempts,
          (SELECT COUNT(*) FROM agent_session_runtime_bindings) AS bindings,
          (SELECT COUNT(*) FROM harness_instance_records) AS harnesses,
          (SELECT COUNT(*) FROM sandbox_runtime_records) AS sandboxes`)
          .get()
      ).toEqual({ attempts: 1, bindings: 0, harnesses: 0, sandboxes: 0 });
      const anchor = getWorkerBackendSession(f.coreDb, `lease_${suffix}`)!;
      const originalAttempt = requireNanoHostExecutionAttempt(f.coreDb, `lease_${suffix}`);
      expect(anchor).toMatchObject({
        state: 'cleanup-failed',
        workspaceHandoffState: 'pending',
        physicalCleanedAt: null,
      });
      expect(originalAttempt).toMatchObject({
        phase: 'closed',
        disposition: 'not_accepted',
        operationId: null,
        deadline: null,
        lastAcceptedHeartbeatAt: null,
        lastWorkerSequence: null,
        workerProcessKeyHash: null,
        workerControlTokenHash: null,
        workerInferenceTokenHash: null,
        workerCapabilityTokenHash: null,
        terminalCause: 'turn-start-failed',
      });
      recordNanoHostRuntimeTargetConnectionClose(f.coreDb, {
        targetId: 'runtime-target-test',
        closedGeneration: 1,
        authoritativeGeneration: null,
        observedAt: '2026-10-08T04:30:00.000Z',
      });
      const allocated = allocateNanoHostRuntimeTargetConnectionGeneration(f.coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'identity-test',
        observedAt: '2026-10-08T04:30:01.000Z',
        targetId: 'runtime-target-test',
      });
      upsertNanoHostRuntimeTarget(f.coreDb, {
        ...allocated,
        freshEmpty: true,
        observedAt: '2026-10-08T04:30:02.000Z',
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      const queued = f.store.createTurn(
        'ws_demo',
        f.threadId,
        'Later queued work',
        { kind: 'user', id: LOCAL_USER_ID },
        null,
        {
          status: 'pending',
          agentId: 'agent_codex_host',
          executorKind: 'worker',
        }
      );
      const admission = createSchedulerAdmissionEntry(f.coreDb, {
        queueEntryId: `queued_${suffix}`,
        backendId: 'nanohost',
        workspaceId: queued.workspaceId,
        threadId: queued.threadId,
        turnId: queued.id,
        requestedAgentId: 'agent_codex_host',
        triggerActor: queued.triggerActor,
        turnInput: 'Later queued work',
      });
      if (partial)
        vi.spyOn(f.store, 'emitTurnEvent').mockImplementationOnce(() => {
          throw new Error('Injected partial terminal publication.');
        });
      const recovery = testRecoveryInput(f.coreDb, {
        ...f.input,
        cleanupBackendSession: async () => {
          throw new Error('Unused anchor cleanup unavailable.');
        },
      });
      await expect(runNanoHostAttemptRecoveryMaintenance(f.coreDb, recovery)).rejects.toThrow(
        'Native attempt recovery failed'
      );
      await expect(runNanoHostAttemptRecoveryMaintenance(f.coreDb, recovery)).rejects.toThrow(
        'Native attempt recovery failed'
      );
      expect(
        requireSchedulerExecutionAttemptAdmissionContext(f.coreDb, `lease_${suffix}`).status
      ).toBe('admitted');
      expect(listQueuedSchedulerAdmissionEntries(f.coreDb)).toContainEqual(admission);
      expect(f.store.getTurnById(f.turnId)).toMatchObject({
        status: 'failed',
        error: {
          code: 'worker_governance_turn_failed',
          message: 'The worker attempt failed to start.',
        },
      });
      expect(attempts.requireSchedulerExecutionAttempt(f.coreDb, `lease_${suffix}`)).toMatchObject({
        phase: 'closed',
        operationId: null,
        terminalCause: 'turn-start-failed',
      });
      expect(f.store.getTurnById(queued.id)).toEqual(queued);
      expect(
        f.store.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
      ).toMatchObject([{ data: { stopReason: 'error' } }]);
      expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(f.turnId)).toEqual(
        f.store.getTurnById(f.turnId)
      );
      const terminal = f.store.getTurnById(f.turnId);
      const session = f.store.getAgentSession(f.agentSessionId);
      const events = f.store.getTurnEvents(f.turnId);
      expect(session.status).toBe('failed');
      expect(getWorkerBackendSession(f.coreDb, `lease_${suffix}`)).toEqual(anchor);
      expect(requireNanoHostExecutionAttempt(f.coreDb, `lease_${suffix}`)).toEqual(originalAttempt);
      f.coreDb.sqlite.close();
      const restartedCore = openCoreDb(f.dataRoot);
      try {
        const restartedStore = new FsStore({ dataRoot: f.dataRoot });
        const restartedInput = testRecoveryInput(restartedCore, {
          ...recovery,
          store: restartedStore,
          executionBackend: new SimulatedTurnExecutor({ coreDb: restartedCore }),
        });
        await recoverTestStartup(restartedCore, restartedInput);
        for (let pass = 0; pass < 6; pass++)
          await expect(drainTestRecovery(restartedCore, restartedInput)).rejects.toThrow(
            'Native attempt recovery failed'
          );
        expect(restartedStore.getTurnById(f.turnId)).toEqual(terminal);
        expect(restartedStore.getAgentSession(f.agentSessionId)).toEqual(session);
        expect(restartedStore.getTurnEvents(f.turnId)).toEqual(events);
        expect(getWorkerBackendSession(restartedCore, `lease_${suffix}`)).toEqual(anchor);
        expect(requireNanoHostExecutionAttempt(restartedCore, `lease_${suffix}`)).toEqual(
          originalAttempt
        );
        expect(restartedStore.getTurnById(queued.id)).toEqual(queued);
        expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
      } finally {
        restartedCore.sqlite.close();
      }
    } finally {
      vi.restoreAllMocks();
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'materialization',
    'handle',
    'native-evidence',
  ] as const)('refuses unused-anchor failed-start settlement with unproved %s', async (proof) => {
    const suffix = `no_effect_unproved_${proof}`;
    const f = await createFailedStartFixture(suffix, false, false, true, ['source']);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      f.coreDb.sqlite
        .prepare("UPDATE scheduler_execution_attempts SET phase = 'open' WHERE attempt_id = ?")
        .run(`lease_${suffix}`);
      recordBackendSession(f.coreDb, suffix, 'cleanup-failed');
      f.coreDb.sqlite
        .prepare("UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE attempt_id = ?")
        .run(`lease_${suffix}`);
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      try {
        if (proof === 'native-evidence')
          f.coreDb.sqlite
            .prepare(
              'UPDATE scheduler_execution_attempts SET last_worker_sequence = 1 WHERE attempt_id = ?'
            )
            .run(`lease_${suffix}`);
        else {
          const pkg = requireAgentEnvironmentPackageSnapshot(
            db,
            'ws_demo',
            `aepsnap_turn_${suffix}_as_${suffix}`
          ).snapshot;
          recordCanonicalWorkspaceHandoff(db, pkg, '2026-07-05T00:00:04.000Z');
          if (proof === 'materialization')
            db.sqlite.prepare('DELETE FROM backend_workspace_handles').run();
          else {
            // The retained handle alone must not be mistaken for an unpublished handoff.
            db.sqlite.prepare('DELETE FROM workspace_materialization_records').run();
          }
        }
      } finally {
        db.sqlite.close();
      }
      const turn = f.store.getTurnById(f.turnId);
      const session = f.store.getAgentSession(f.agentSessionId);
      const anchor = getWorkerBackendSession(f.coreDb, `lease_${suffix}`);
      const recovery = testRecoveryInput(f.coreDb, {
        ...f.input,
        cleanupBackendSession: async () => {
          throw new Error('Unused anchor cleanup unavailable.');
        },
      });
      for (let pass = 0; pass < 2; pass++)
        await expect(runNanoHostAttemptRecoveryMaintenance(f.coreDb, recovery)).rejects.toThrow(
          'Native attempt recovery failed'
        );
      expect(
        log.mock.calls.map(([line]) => JSON.parse(line).attributes['openkit.error.code'])
      ).toContain('scheduler.native_failed_start_recovery_required');
      expect(f.store.getTurnById(f.turnId)).toEqual(turn);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(getWorkerBackendSession(f.coreDb, `lease_${suffix}`)).toEqual(anchor);
      expect(f.store.getTurnEvents(f.turnId)).toEqual([]);
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('preserves a backend-busy no-effect deferral as the same queued Turn', async () => {
    const suffix = 'no_effect_backend_busy';
    const f = await createFailedStartFixture(suffix, false, false, true);
    try {
      f.coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET terminal_cause = 'backend-busy' WHERE attempt_id = ?"
        )
        .run(`lease_${suffix}`);
      f.coreDb.sqlite
        .prepare("UPDATE scheduler_admission_entries SET status = 'queued' WHERE turn_id = ?")
        .run(f.turnId);
      const pending = f.store.updateTurn(f.turnId, { status: 'pending' });
      await runNanoHostAttemptRecoveryMaintenance(f.coreDb, testRecoveryInput(f.coreDb, f.input));
      expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(f.turnId)).toEqual(pending);
      expect(listQueuedSchedulerAdmissionEntries(f.coreDb).map((entry) => entry.turnId)).toContain(
        f.turnId
      );
      expect(f.store.getTurnEvents(f.turnId)).toEqual([]);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('retains a closed no-effect attempt and retries its failed product projection after listen', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'prelaunch_projection_retry';
    let projectionAttempts = 0;

    try {
      dispatchLease(coreDb, suffix, { kind: 'user', id: LOCAL_USER_ID }, false);

      await expect(
        recoverTestStartup(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            projectionAttempts += 1;
            throw new Error('pre-anchor product projection failed');
          },
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'pre-anchor product projection failed')
      );
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closed');

      await drainTestRecovery(coreDb, {
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionAttempts += 1;
          return { status: 'failed' as const };
        },
      });

      expect(projectionAttempts).toBe(2);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closed');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['restart_workspace', ['repo']],
    ['restart_zero_input', []],
  ] as const)('projects %s cleanup once after its recovery decision permits teardown', async (suffix, workspaceInputIds) => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds,
      });
      if (workspaceInputIds.length > 0) {
        recordCanonicalWorkspaceHandoff(
          workspaceDb,
          environmentPackage,
          '2026-07-05T00:00:10.000Z'
        );
      }
      recordBackendSession(coreDb, suffix, 'launching');

      const cleanup = vi.fn(async () => undefined);
      const project = vi.fn(async () => ({ status: 'failed' as const }));
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: cleanup,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: project,
      });
      if (workspaceInputIds.length > 0) {
        expect(cleanup).not.toHaveBeenCalled();
        expect(project).not.toHaveBeenCalled();
        expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
          physicalCleanedAt: null,
        });
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`)).toMatchObject({
          phase: 'closing',
          operationId: `operation_${suffix}`,
          disposition: 'unknown',
          fenceRef: null,
        });
        expect(
          listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
            (record) => record.phase === 'teardown'
          )
        ).toEqual([]);
        abandonRetainedWorkspaceRecovery(workspaceDb, '2026-07-05T00:01:01.000Z');
        await drainTestRecovery(coreDb, {
          cleanupBackendSession: cleanup,
          now: () => '2026-07-05T00:01:02.000Z',
          projectRecoveredTurn: project,
        });
      }
      expect(cleanup).toHaveBeenCalledTimes(1);
      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Terminal backend session must not be cleaned twice.');
        },
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual(
        workspaceInputIds.length > 0 ? [expect.objectContaining({ cleanupStatus: 'cleaned' })] : []
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([
        expect.objectContaining({
          agentSessionId: `as_${suffix}`,
          outcome: 'succeeded',
          stopReason: 'completed',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('repairs a pending exact handoff without changing physical cleanup evidence time', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_handoff_marker_repair';
    let timestamp = '2026-07-05T00:01:00.000Z';

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:00:10.000Z');
      recordBackendSession(coreDb, suffix, 'launching');

      const cleanup = vi.fn(async () => {
        timestamp = '2026-07-05T00:01:03.000Z';
      });
      const project = vi.fn(async () => {
        throw new Error('product projection crash after handoff repair');
      });
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: cleanup,
        now: () => timestamp,
        projectRecoveredTurn: project,
      });
      expect(cleanup).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        physicalCleanedAt: null,
        workspaceHandoffState: 'pending',
      });
      abandonRetainedWorkspaceRecovery(workspaceDb, '2026-07-05T00:01:01.000Z');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: cleanup,
          now: () => timestamp,
          projectRecoveredTurn: project,
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'product projection crash after handoff repair')
      );
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        physicalCleanedAt: '2026-07-05T00:01:03.000Z',
        state: 'physical-cleaned',
        updatedAt: '2026-07-05T00:01:03.000Z',
        workspaceHandoffState: 'complete',
      });
      expect(cleanup).toHaveBeenCalledTimes(1);

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Physical cleanup must not replay after marker repair.');
        },
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([
        expect.objectContaining({
          completedAt: '2026-07-05T00:01:03.000Z',
          outcome: 'succeeded',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('preserves exclusion when Core claims a handoff whose Workspace rows are missing', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_missing_workspace_handle';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordBackendSession(coreDb, suffix, 'launching');
      markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:11.000Z',
      });

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'backend handle handoff is incomplete')
      );
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        physicalCleanedAt: null,
      });
      expect(cleanupCalls).toBe(0);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`)).toMatchObject({
        phase: 'closing',
        operationId: `operation_${suffix}`,
        disposition: 'unknown',
        fenceRef: null,
      });

      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:01:01.000Z');
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:02.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(0);
      abandonRetainedWorkspaceRecovery(workspaceDb, '2026-07-05T00:01:03.000Z');
      await drainTestRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:04.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects a workspace handle owned by a different physical backend session', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_mismatched_workspace_handle';

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:00:10.000Z');
      const row = workspaceDb.sqlite
        .prepare(
          'SELECT backend_workspace_handle_id AS id, payload_json AS payloadJson FROM backend_workspace_handles LIMIT 1'
        )
        .get() as { id: string; payloadJson: string };
      workspaceDb.sqlite
        .prepare(
          'UPDATE backend_workspace_handles SET payload_json = ? WHERE backend_workspace_handle_id = ?'
        )
        .run(
          JSON.stringify({
            ...(JSON.parse(row.payloadJson) as Record<string, unknown>),
            workerSessionId: 'openkit-as_attacker',
          }),
          row.id
        );
      recordBackendSession(coreDb, suffix, 'physical-cleaned');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            throw new Error('Physical cleanup must not replay.');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'backend handle handoff is incomplete')
      );
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['before heartbeat', false, 'materializing'],
    ['after heartbeat', true, 'launching'],
  ] as const)('cleans and terminalizes an anchored lease %s before releasing capacity', async (_description, heartbeat, anchorState) => {
    const coreDb = createMigratedCoreDb();
    const suffix = heartbeat ? 'restart_anchor_live' : 'restart_anchor_acquired';
    const leaseId = `lease_${suffix}`;
    const cleanupObservations: unknown[] = [];

    try {
      dispatchLease(coreDb, suffix);
      if (heartbeat) {
        acceptNanoHostAttemptHeartbeat(coreDb, {
          heartbeatTimeoutMs: 900_000,
          attemptId: `lease_${suffix}`,
          now: () => '2026-07-05T00:00:10.000Z',
          workerSequence: 1,
        });
      }
      recordBackendSession(coreDb, suffix, anchorState);

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async (_session) => {
          cleanupObservations.push({
            anchor: getWorkerBackendSession(coreDb, leaseId),
            phase: observeExecutionAttempts(coreDb).find(
              (attempt) => attempt.attempt_id === leaseId
            )?.phase,
          });
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(cleanupObservations).toEqual([
        {
          anchor: expect.objectContaining({ state: 'cleanup-pending' }),
          phase: 'closing',
        },
      ]);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('prepares exact result-only cleanup lineage before post-listener maintenance', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_cleanup_retry';
    let cleanupAttempts = 0;
    let preparedIdentity:
      | Parameters<NonNullable<RecoveryFixtureInput['prepareBackendCleanup']>>[0]
      | null = null;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordBackendSession(coreDb, suffix, 'launching');

      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Phase 8 must not start a physical cleanup effect.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: (identity) => {
          expect(cleanupAttempts).toBe(0);
          expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
            state: 'cleanup-pending',
          });
          preparedIdentity = identity;
        },
        projectRecoveredTurn: async () => {
          throw new Error('Phase 8 must not project an anchored Turn before cleanup.');
        },
      });
      expect(cleanupAttempts).toBe(0);
      expect(preparedIdentity).toEqual({
        agentSessionId: `as_${suffix}`,
        backendKind: 'openshell',
        backendSessionId: testNanoHostBackendSessionId(suffix),
        deploymentId: 'deployment-test',
        packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
        runtimeTargetId: 'runtime-target-test',
        stagingDirectoryRef: `server/runtime/worker-backend-sessions/aepsnap_turn_${suffix}_as_${suffix}`,
        transientProviderInstanceId: null,
      });
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      );

      await expect(
        drainTestRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupAttempts += 1;
            throw new Error('NanoHost cleanup failed');
          },
          now: () => '2026-07-05T00:01:01.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) => hasRecoveryFailure(error, 'NanoHost cleanup failed'));
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-failed',
      });

      await drainTestRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupAttempts += 1;
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:02.000Z',
      });
      expect(cleanupAttempts).toBe(2);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([expect.objectContaining({ outcome: 'succeeded' })]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('terminalizes a cleaned releasing anchor without cleanup, redispatch, or adoption', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_already_cleaned';
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordBackendSession(coreDb, suffix, 'cleaned');
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:11.000Z',
        firstTerminalCause: 'worker-final-status',
      });

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(cleanupCalls).toBe(0);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('cleans a stale exact anchored session while preserving exclusion until cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_stale_anchor';

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'launching');
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closing', terminal_cause = 'heartbeat-timeout' WHERE attempt_id = ?"
        )
        .run(`lease_${suffix}`);

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves terminal handoff before closing an expired physically cleaned attempt', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_cleaned_expired_release';
    const projectionStates: unknown[] = [];
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'cleaned');
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        firstTerminalCause: 'worker-final-status',
      });
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET deadline = ? WHERE attempt_id = ?')
        .run('2026-07-05T00:00:30.000Z', `lease_${suffix}`);

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => {
          projectionStates.push(
            observeExecutionAttempts(coreDb).find(
              (attempt) => attempt.attempt_id === `lease_${suffix}`
            )?.phase
          );
          return { status: 'failed' as const };
        },
      });

      expect(cleanupCalls).toBe(0);
      expect(projectionStates).toEqual(['closing']);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('closes an already completed product attempt after complete recovery and admits its next Turn', async () => {
    const f = await createFinalReviewRecoveryFixture('restart_completed_product', 'completed');
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId).status).toBe('completed');
      assertRecoveryClosedAndNextTurnAdmitted(f);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('keeps a physically cleaned attempt closing until product terminal projection succeeds', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_projection_retry';
    let projectionAttempts = 0;
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            projectionAttempts += 1;
            throw new Error('product store write failed');
          },
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'product store write failed')
      );
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      );

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionAttempts += 1;
          return { status: 'failed' as const };
        },
      });
      expect(cleanupCalls).toBe(1);
      expect(projectionAttempts).toBe(2);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('replays a cleaned zero-input teardown at a later time without duplicating evidence', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_cleaned_evidence_replay';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds: [] });
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            throw new Error('crash after cleanup projection');
          },
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'crash after cleanup projection')
      );
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
        updatedAt: '2026-07-05T00:01:00.000Z',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:05:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects a pre-anchor product turn once and prevents its durable admission from redispatch', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-restart-product-projection-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turnId = 'turn_restart_product_projection';
    const agentSessionId = 'as_restart_product_projection';
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Recover this turn',
      { kind: 'user', id: 'user_local' },
      null,
      { turnId }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: turn.startedAt ?? '2026-07-05T00:00:01.000Z',
      id: agentSessionId,
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: turn.startedAt ?? '2026-07-05T00:00:01.000Z',
      workspaceId: turn.workspaceId,
    });
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId: 'ws_demo' });
    const admission = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_product_projection',
      requestId: 'request_product_projection',
      requestedAgentId: 'agent_codex_host',
      threadId: turn.threadId,
      turnId,
      turnInput: 'Recover this turn',
      workspaceId: turn.workspaceId,
      now: () => '2026-07-05T00:00:01.000Z',
    });
    attempts.createSchedulerExecutionAttempt(coreDb, {
      entry: admission,
      attemptId: 'lease_product_projection',
      preparationInput: { admission },
      now: () => '2026-07-05T00:00:02.000Z',
    });
    attempts.bindSchedulerExecutionAttemptSession(coreDb, {
      attemptId: 'lease_product_projection',
      agentSessionId,
    });
    const project = async () => {
      const result = terminalizeGovernedWorkerTurn({
        agentSessionId,
        completedAt: '2026-07-05T00:01:00.000Z',
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution stopped during NanoCore restart recovery.',
        outcome: 'failed',
        requestId: null,
        store: new FsStore({ dataRoot }),
        turnId,
      });
      expect(result.status).toBe('failed');
      return { status: 'failed' as const };
    };

    try {
      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Pre-anchor recovery must not clean a backend session.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: project,
      });
      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Terminal recovery must not clean a backend session.');
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: project,
      });

      const restartedStore = new FsStore({ dataRoot });
      expect(restartedStore.getTurnById(turnId)).toMatchObject({
        error: {
          code: 'worker_governance_restart_recovery',
          message: 'Worker execution stopped during NanoCore restart recovery.',
        },
        status: 'failed',
      });
      expect(restartedStore.getAgentSession(agentSessionId)).toMatchObject({
        message: 'Worker execution stopped during NanoCore restart recovery.',
        status: 'failed',
      });
      expect(
        restartedStore
          .getTurnEvents(turnId)
          .filter(
            (event) =>
              event.event === 'turn.completed' &&
              event.data.type === 'turn-completed' &&
              event.data.stopReason === 'error'
          )
      ).toHaveLength(1);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_product_projection'
        )?.phase
      ).toBe('closed');

      const turnExecutor = new RejectRecoveredTurnExecutor();
      const retry = await runSchedulerDispatchLoop({
        agentManifests: [
          {
            adapter: 'custom-http',
            deployments: ['local'],
            displayName: 'Codex Agent',
            id: 'agent_codex_host',
            kind: 'custom',
            runtime: 'custom',
            version: '0.0.2',
          },
        ],
        coreDb,
        heartbeatTimeoutMs: 30_000,
        maxDispatches: 1,
        providerRegistry: new ProviderRegistry([]),
        store: restartedStore,
        turnExecutor,
      });
      expect(retry.startedTurns).toEqual([]);
      expect(retry.terminalResult).toEqual({ reason: 'no-queued-entry', status: 'queued' });
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  // D72 retires Native health labels as Core phases; D151 forbids absence-derived proof.
  it.each([
    ['open', 'unknown'],
    ['open', 'accepted'],
    ['closing', 'unknown'],
    ['closing', 'accepted'],
  ] as const)('retains the original %s/%s operation without a durable backend anchor', async (phase, disposition) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `restart_missing_anchor_${phase}_${disposition}`;
    const cleanup = vi.fn(async () => {});
    const project = vi.fn(async () => ({ status: 'failed' as const }));
    try {
      dispatchLease(coreDb, suffix);
      let row = attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`);
      if (disposition === 'accepted')
        row = attempts.acceptSchedulerExecutionObservation(coreDb, {
          ...attempts.schedulerExecutionCorrelation(row),
          disposition: 'accepted',
          execution: 'pending',
          fenceRef: null,
          outcomeRef: null,
        });
      if (phase === 'closing')
        row = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
          attemptId: row.attemptId,
          cause: 'restart-inspection',
          now: () => '2026-07-05T00:00:09.000Z',
        });
      const input = {
        now: () => '2026-07-05T00:01:00.000Z',
        cleanupBackendSession: cleanup,
        projectRecoveredTurn: project,
      };
      expect(await recoverTestStartup(coreDb, input)).toEqual({ preparationFailedAttemptIds: [] });
      await drainTestRecovery(coreDb, input);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, row.attemptId)).toEqual({
        ...row,
        updatedAt: expect.any(String),
      });
      expect(cleanup).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails a stale pre-anchor lease that has no accepted launch heartbeat', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_prelaunch';

    try {
      dispatchLease(coreDb, suffix, { kind: 'user', id: LOCAL_USER_ID }, false);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closing', terminal_cause = 'startup-timeout' WHERE attempt_id = ?"
        )
        .run(`lease_${suffix}`);

      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closed');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves exclusion for a stale post-launch attempt without a durable backend anchor', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_launched';

    try {
      dispatchLease(coreDb, suffix);
      acceptNanoHostAttemptHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closing', terminal_cause = 'heartbeat-timeout' WHERE attempt_id = ?"
        )
        .run(`lease_${suffix}`);

      const recovery = await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(recovery).toEqual({ preparationFailedAttemptIds: [] });
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`)).toMatchObject({
        operationId: `operation_${suffix}`,
        fenceRef: null,
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not treat a stale starting lease without a heartbeat as proven pre-anchor', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_starting';

    try {
      dispatchLease(coreDb, suffix);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closing', terminal_cause = 'heartbeat-timeout' WHERE attempt_id = ?"
        )
        .run(`lease_${suffix}`);

      const recovery = await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(recovery).toEqual({ preparationFailedAttemptIds: [] });
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`)).toMatchObject({
        operationId: `operation_${suffix}`,
        fenceRef: null,
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed for an expired closing attempt without authoritative cleanup proof', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_expired_releasing';

    try {
      dispatchLease(coreDb, suffix);
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        firstTerminalCause: 'worker-final-status',
      });

      const recovery = await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:06:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(recovery).toEqual({ preparationFailedAttemptIds: [] });
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`)).toMatchObject({
        operationId: `operation_${suffix}`,
        fenceRef: null,
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects recovery into the owner-independent workspace for a non-local admission user', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_owner_workspace';
    const triggerActor = {
      kind: 'automation',
      id: 'automation_recovery_owner',
      responsibleUserId: 'user_recovery_owner',
    } as const;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix, triggerActor);
      recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        triggerActor,
        workspaceInputIds: [],
      });
      recordBackendSession(coreDb, suffix, 'launching');

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects restart recovery when the package trigger actor differs from admission', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_actor_mismatch';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix, {
        kind: 'automation',
        id: 'automation_admission',
        responsibleUserId: 'user_recovery_owner',
      });
      recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        triggerActor: {
          kind: 'automation',
          id: 'automation_package',
          responsibleUserId: 'user_recovery_owner',
        },
        workspaceInputIds: [],
      });
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'does not match scheduler trigger actor')
      );

      // AEP 273/293 and Scheduler 76 keep contradictory authority from cleanup effects.
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        physicalCleanedAt: null,
      });
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${suffix}`)).toMatchObject({
        phase: 'closing',
        operationId: `operation_${suffix}`,
        disposition: 'unknown',
        fenceRef: null,
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('attempts every anchored cleanup before reporting aggregated restart failure', async () => {
    const coreDb = createMigratedCoreDb();
    const cleanupCalls: string[] = [];

    try {
      dispatchLease(coreDb, 'aggregate_a');
      dispatchLease(coreDb, 'aggregate_b');
      recordBackendSession(coreDb, 'aggregate_a', 'launching');
      recordBackendSession(coreDb, 'aggregate_b', 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async (session) => {
            cleanupCalls.push(session.backendSessionId);
            if (session.backendSessionId === testNanoHostBackendSessionId('aggregate_a')) {
              throw new Error('aggregate cleanup A failed');
            }
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'aggregate cleanup A failed')
      );

      expect(cleanupCalls).toEqual([
        testNanoHostBackendSessionId('aggregate_a'),
        testNanoHostBackendSessionId('aggregate_b'),
      ]);
      expect(getWorkerBackendSession(coreDb, 'lease_aggregate_a')).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(getWorkerBackendSession(coreDb, 'lease_aggregate_b')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_aggregate_b'
        )?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fences mismatched product lineage before any physical cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'mismatched_package');
      recordBackendSession(coreDb, 'mismatched_package', 'launching');
      coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET thread_id = ? WHERE attempt_id = ?')
        .run('thread_attacker', 'lease_mismatched_package');

      await expect(
        recoverTestStartup(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'does not match scheduler lineage')
      );

      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_mismatched_package')).toMatchObject({
        state: 'launching',
      });
      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_mismatched_package'
        )?.phase
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('boots with an unowned backend anchor and retires it after definite cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'orphan_anchor');
      recordBackendSession(coreDb, 'orphan_anchor', 'launching');
      // Retain the canonical Core owner: D111 retires residency with no live attempt, while missing ownership remains fenced.
      const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: 'lease_orphan_anchor',
        cause: 'modeled-terminal-handoff',
      });
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      const correlation = attempts.schedulerExecutionCorrelation(closing);
      const released = await new SimulatedTurnExecutor({ coreDb }).release({
        ...correlation,
        proof,
      });
      attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation,
        proof,
        fenceRef: released.fenceRef!,
      });

      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_anchor')).toMatchObject({
        state: 'launching',
      });

      await drainTestRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_anchor')).toMatchObject({
        state: 'cleaned',
      });

      expect(
        coreDb.sqlite
          .prepare(
            "SELECT action FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ action: 'scheduler.orphan-backend-retired' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps an unowned effect-capable binding fenced when physical cleanup fails', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      dispatchLease(coreDb, 'orphan_cleanup_failure');
      recordBackendSession(coreDb, 'orphan_cleanup_failure', 'launching');
      // Retain the canonical Core owner: D111 retires residency with no live attempt, while missing ownership remains fenced.
      const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: 'lease_orphan_cleanup_failure',
        cause: 'modeled-terminal-handoff',
      });
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      const correlation = attempts.schedulerExecutionCorrelation(closing);
      const released = await new SimulatedTurnExecutor({ coreDb }).release({
        ...correlation,
        proof,
      });
      attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation,
        proof,
        fenceRef: released.fenceRef!,
      });
      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await expect(
        drainTestRecovery(coreDb, {
          cleanupBackendSession: async () => {
            throw new Error('backend unavailable');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) => hasRecoveryFailure(error, 'backend unavailable'));
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_cleanup_failure')).toMatchObject({
        state: 'cleanup-failed',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('finishes retirement of an orphan already physically cleaned before restart', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      dispatchLease(coreDb, 'orphan_physical_cleaned');
      recordBackendSession(coreDb, 'orphan_physical_cleaned', 'physical-cleaned');
      // Retain the canonical Core owner: D111 retires residency with no live attempt, while missing ownership remains fenced.
      const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: 'lease_orphan_physical_cleaned',
        cause: 'modeled-terminal-handoff',
      });
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      const correlation = attempts.schedulerExecutionCorrelation(closing);
      const released = await new SimulatedTurnExecutor({ coreDb }).release({
        ...correlation,
        proof,
      });
      attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation,
        proof,
        fenceRef: released.fenceRef!,
      });
      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      let cleanupCalls = 0;
      await drainTestRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_physical_cleaned')).toMatchObject({
        state: 'cleaned',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retires a terminal lease backend anchor without changing that lease', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'terminal_dirty_anchor');
      recordBackendSession(coreDb, 'terminal_dirty_anchor', 'launching');
      const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: 'lease_terminal_dirty_anchor',
        cause: 'terminal-product-handoff',
      });
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation: attempts.schedulerExecutionCorrelation(closing),
        proof,
        fenceRef: 'modeled-terminal-native-residency',
      });

      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_terminal_dirty_anchor')).toMatchObject({
        state: 'launching',
      });

      await drainTestRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_terminal_dirty_anchor')).toMatchObject({
        state: 'cleaned',
      });

      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_terminal_dirty_anchor'
        )?.phase
      ).toBe('closed');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records each unowned effect-capable binding cleanup independently', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      for (const suffix of ['shared_first', 'shared_second']) {
        dispatchLease(coreDb, suffix);
        recordBackendSession(coreDb, suffix, 'launching');
        // Retain the canonical Core owner: D111 retires residency with no live attempt, while missing ownership remains fenced.
        const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
          attemptId: `lease_${suffix}`,
          cause: 'modeled-terminal-handoff',
        });
        const proof = {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        } as const;
        const correlation = attempts.schedulerExecutionCorrelation(closing);
        const released = await new SimulatedTurnExecutor({ coreDb }).release({
          ...correlation,
          proof,
        });
        attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
          correlation,
          proof,
          fenceRef: released.fenceRef!,
        });
      }
      await prepareReconnectLease(coreDb, 'unrelated_survivor');
      const unrelated = getWorkerBackendSession(coreDb, 'lease_unrelated_survivor');
      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      let cleanupCalls = 0;
      await drainTestRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(2);
      for (const suffix of ['shared_first', 'shared_second']) {
        expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
          state: 'cleaned',
        });
      }

      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ count: 2 });
      expect(getWorkerBackendSession(coreDb, 'lease_unrelated_survivor')).toEqual(unrelated);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records one exact cleanup independently while the other failed boundary stays fenced', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      for (const suffix of ['failed_shared_first', 'failed_shared_second']) {
        dispatchLease(coreDb, suffix);
        recordBackendSession(coreDb, suffix, 'launching');
        // Retain the canonical Core owner: D111 retires residency with no live attempt, while missing ownership remains fenced.
        const closing = attempts.markSchedulerExecutionAttemptClosing(coreDb, {
          attemptId: `lease_${suffix}`,
          cause: 'modeled-terminal-handoff',
        });
        const proof = {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        } as const;
        const correlation = attempts.schedulerExecutionCorrelation(closing);
        const released = await new SimulatedTurnExecutor({ coreDb }).release({
          ...correlation,
          proof,
        });
        attempts.closeSchedulerExecutionAttemptWithFence(coreDb, {
          correlation,
          proof,
          fenceRef: released.fenceRef!,
        });
      }
      await prepareReconnectLease(coreDb, 'unrelated_survivor');
      const unrelated = getWorkerBackendSession(coreDb, 'lease_unrelated_survivor');
      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await expect(
        drainTestRecovery(coreDb, {
          cleanupBackendSession: async (session) => {
            if (session.agentSessionId === 'as_failed_shared_second')
              throw new Error('second cleanup unavailable');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toSatisfy((error: unknown) =>
        hasRecoveryFailure(error, 'second cleanup unavailable')
      );
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_first')).toMatchObject({
        state: 'cleaned',
      });
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_second')).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ count: 1 });

      await drainTestRecovery(coreDb, {
        cleanupBackendSession: async () => {},
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_first')).toMatchObject({
        state: 'cleaned',
      });
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_second')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ count: 2 });
      expect(getWorkerBackendSession(coreDb, 'lease_unrelated_survivor')).toEqual(unrelated);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('minimal scheduler reconnect contract', () => {
  it('cleans a sequence-zero-only process without claiming it launched work', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      await prepareReconnectLease(coreDb, 'prelaunch_only', false);
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_prelaunch_only'
        )?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('arms one bounded awaiting-reconnect lease without extending its deadline on replay', async () => {
    const coreDb = createMigratedCoreDb();
    let projectionCalls = 0;

    try {
      await prepareReconnectLease(coreDb, 'bounded_reconnect');
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('An eligible survivor must not be cleaned before its deadline.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => {
          projectionCalls += 1;
          return { status: 'failed' as const };
        },
        restoreBackendSession: async () => {},
      });
      const first = requireNanoHostExecutionAttempt(coreDb, 'lease_bounded_reconnect');
      const reconnectWindowMs =
        Date.parse(first.recoveryDeadline ?? '') - Date.parse('2026-07-05T00:01:00.000Z');

      expect(first).toMatchObject({ recoveryState: 'awaiting-reconnect', phase: 'open' });
      expect(reconnectWindowMs).toBe(300_000);

      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error(
            'A replayed boot must not clean a survivor before its original deadline.'
          );
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionCalls += 1;
          return { status: 'failed' as const };
        },
        restoreBackendSession: async () => {},
      });

      expect(requireNanoHostExecutionAttempt(coreDb, 'lease_bounded_reconnect')).toMatchObject({
        recoveryDeadline: first.recoveryDeadline,
        recoveryState: 'awaiting-reconnect',
      });
      expect(projectionCalls).toBe(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('hydrates one same-Epoch survivor while readiness is absent and rejects a different Epoch', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'graceful_same_epoch_reconnect';
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    store.createThread('ws_demo', 'Same-Epoch restart fixture', `thread_${suffix}`);
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-07-05T00:00:01.000Z',
      environmentPackageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      id: `as_${suffix}`,
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: null,
      status: 'busy',
      threadId: `thread_${suffix}`,
      updatedAt: '2026-07-05T00:00:01.000Z',
      workspaceId: 'ws_demo',
      workspaceRoots: [],
    });
    const fixture = await prepareReconnectLease(coreDb, suffix);
    const leaseId = `lease_${suffix}`;
    const runtimeTargetId = getWorkerBackendSession(coreDb, leaseId)!.runtimeTargetId;
    // The real backend restoration must join the same target selected by the original admission.
    coreDb.sqlite
      .prepare('UPDATE nanohost_runtime_targets SET target_id = ? WHERE target_id = ?')
      .run(runtimeTargetId, 'runtime-target-test');
    coreDb.sqlite
      .prepare('UPDATE worker_backend_sessions SET runtime_target_id = ? WHERE attempt_id = ?')
      .run(runtimeTargetId, leaseId);
    let cleanupRegistrations = 0;
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'image.acquire') {
          return { digest: request.input.imageReference };
        }
        if (request.kind === 'image.inspect') {
          return {
            digest: request.input.imageDigest,
            environmentDefaults: {
              defaultsDigest:
                'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
              values: {},
            },
            platform: { architecture: 'amd64', os: 'linux' },
            storageLayout: {
              family: 'openkit-worker',
              gid: 1000,
              targets: [{ target: '/sandbox' }, { target: '/workspace' }],
              uid: 1000,
              version: '1',
              workingDirectory: '/tmp/openkit-bootstrap',
            },
          };
        }
        if (request.kind === 'sandbox.create') {
          const storage = request.input.storage as {
            readonly attachmentGeneration: number;
            readonly layoutDigest: string;
            readonly scopeDigest: string;
            readonly storageRef: string;
            readonly targets: readonly { readonly target: string; readonly volumeRef: string }[];
          };
          return {
            sandboxId: request.input.sandboxId,
            state: 'created',
            storage: {
              ...storage,
              targets: storage.targets.map((target) => ({ ...target, initialized: true })),
            },
          };
        }
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      expectResultOnly() {
        cleanupRegistrations += 1;
        return new Promise<never>(() => undefined);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT OR IGNORE INTO users (
             id, display_name, email, email_verified, kind, status, created_at, updated_at
           ) VALUES (?, ?, ?, 0, 'human', 'active', 0, 0)`
        )
        .run(LOCAL_USER_ID, LOCAL_USER_ID, 'local@restart-fixture.openkit.invalid');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: LOCAL_USER_ID,
        workspaceId: 'ws_demo',
      });
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      let environmentPackage: AgentEnvironmentPackage;
      try {
        applyScopedMigrations(workspaceDb);
        environmentPackage = requireAgentEnvironmentPackageSnapshot(
          workspaceDb,
          'ws_demo',
          `aepsnap_turn_${suffix}_as_${suffix}`
        ).snapshot;
      } finally {
        workspaceDb.sqlite.close();
      }

      const initialRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        store,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const initialBackend = (
        initialRuntime.turnExecutor as unknown as {
          readonly backend: {
            materialize(
              environmentPackage: AgentEnvironmentPackage,
              context: { readonly workspaceRoots: [] }
            ): Promise<unknown>;
            planSession(environmentPackage: AgentEnvironmentPackage): {
              readonly backendSessionId: string;
            };
          };
        }
      ).backend;
      coreDb.sqlite
        .prepare(
          `UPDATE worker_backend_sessions
           SET backend_session_id = ?
           WHERE attempt_id = ?`
        )
        .run(initialBackend.planSession(environmentPackage).backendSessionId, leaseId);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-07-05T00:00:07.000Z'));
      try {
        await initialBackend.materialize(environmentPackage, { workspaceRoots: [] });
      } finally {
        vi.useRealTimers();
      }
      const harness = coreDb.sqlite
        .prepare(
          `SELECT h.adapter_id AS adapterId, h.adapter_version AS adapterVersion,
                  h.harness_compatibility_key AS harnessCompatibilityKey,
                  h.harness_instance_id AS harnessInstanceId
           FROM harness_instance_records h
           JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
           WHERE s.origin_physical_epoch = ?`
        )
        .get('a'.repeat(64)) as {
        readonly adapterId: 'codex';
        readonly adapterVersion: string;
        readonly harnessCompatibilityKey: string;
        readonly harnessInstanceId: string;
      };
      const agentSessionCompatibilityKey = deriveNanoHostAgentSessionCompatibilityKey({
        adapterId: harness.adapterId,
        adapterVersion: harness.adapterVersion,
        harnessCompatibilityKey: harness.harnessCompatibilityKey,
        sessionCompatibilityKey: agentSessionCompatibilityKeyFromPackage(environmentPackage),
        threadId: environmentPackage.scope.threadId,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey,
        agentSessionId: environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: `binding_${suffix}`,
        effectiveSetupGeneration: 1,
        harnessInstanceId: harness.harnessInstanceId,
        threadId: environmentPackage.scope.threadId,
        timestamp: '2026-07-05T00:00:07.000Z',
        workspaceId: environmentPackage.scope.workspaceId,
      });
      effects.length = 0;
      recordNanoHostRuntimeTargetConnectionClose(coreDb, {
        authoritativeGeneration: null,
        closedGeneration: 1,
        observedAt: '2026-07-05T00:00:08.000Z',
        targetId: runtimeTargetId,
      });

      const restartedRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        store,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      await expect(
        restartedRuntime.restoreBackendSession(getWorkerBackendSession(coreDb, leaseId)!)
      ).resolves.toBeUndefined();
      await recoverTestStartup(coreDb, {
        cleanupBackendSession: restartedRuntime.cleanupBackendSession,
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: restartedRuntime.prepareBackendCleanup,
        projectRecoveredTurn: async () => ({ status: 'failed' }),
        restoreBackendSession: restartedRuntime.restoreBackendSession,
      });

      expect(['open', 'closing']).toContain(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === leaseId)?.phase
      );
      expect(requireNanoHostExecutionAttempt(coreDb, leaseId)).toMatchObject({
        recoveryState: 'awaiting-reconnect',
      });
      expect(cleanupRegistrations).toBe(0);
      expect(effects).toEqual([]);
      const restartedBackend = (
        restartedRuntime.turnExecutor as unknown as {
          readonly backend: {
            prepareAgentSessionContinuity(input: {
              readonly agentSessionCompatibilityKey: string;
              readonly agentSessionId: string;
              readonly reuseAllowed: true;
              readonly threadId: string;
              readonly workspaceId: string;
            }): Promise<unknown>;
          };
        }
      ).backend;
      await expect(
        restartedBackend.prepareAgentSessionContinuity({
          agentSessionCompatibilityKey,
          agentSessionId: environmentPackage.scope.agentSessionId,
          reuseAllowed: true,
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        })
      ).rejects.toThrow(/not ready for admission/i);
      expect(() =>
        adoptNanoHostAttemptReconnect(coreDb, {
          acceptedAt: '2026-07-05T00:01:01.000Z',
          lineage: fixture.lineage,
          reconnectKey: fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:${leaseId}`,
          workerSequence: 2,
        })
      ).toThrow(
        expect.objectContaining({
          reason: 'reconnect-required',
        })
      );

      const differentGeneration = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'identity-test',
        observedAt: '2026-07-05T00:01:02.000Z',
        targetId: runtimeTargetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...differentGeneration,
        freshEmpty: true,
        observedAt: '2026-07-05T00:01:03.000Z',
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(() =>
        adoptNanoHostAttemptReconnect(coreDb, {
          acceptedAt: '2026-07-05T00:01:04.000Z',
          lineage: fixture.lineage,
          reconnectKey: fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:${leaseId}`,
          workerSequence: 2,
        })
      ).toThrow(
        expect.objectContaining({
          reason: 'attempt-changed',
        })
      );

      const sameGeneration = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'identity-test',
        observedAt: '2026-07-05T00:01:05.000Z',
        targetId: runtimeTargetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...sameGeneration,
        freshEmpty: true,
        observedAt: '2026-07-05T00:01:06.000Z',
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(
        adoptNanoHostAttemptReconnect(coreDb, {
          acceptedAt: '2026-07-05T00:01:07.000Z',
          lineage: fixture.lineage,
          reconnectKey: fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:${leaseId}`,
          workerSequence: 2,
        })
      ).toMatchObject({ recoveryState: null, phase: 'open' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('uses existing cleanup when read-only backend restoration fails before arming', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      await prepareReconnectLease(coreDb, 'restore_failure');
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        restoreBackendSession: async () => {
          throw new Error('The durable backend identity cannot be restored.');
        },
      });

      expect(cleanupCalls).toBe(1);
      expect(
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === 'lease_restore_failure'
        )?.phase
      ).toBe('closing');
      expect(requireNanoHostExecutionAttempt(coreDb, 'lease_restore_failure')).toMatchObject({
        recoveryDeadline: null,
        recoveryState: 'needs-evidence',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('adopts only the original process at the exact next sequence', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      const fixture = await prepareReconnectLease(coreDb, 'exact_reconnect');
      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        restoreBackendSession: async () => {},
      });
      const armed = requireNanoHostExecutionAttempt(coreDb, 'lease_exact_reconnect');

      const adopted = adoptNanoHostAttemptReconnect(coreDb, {
        acceptedAt: '2026-07-05T00:01:01.000Z',
        lineage: fixture.lineage,
        reconnectKey: fixture.reconnectKey,
        sandboxBindingRef: 'lease-binding:lease_exact_reconnect',
        workerSequence: 2,
      });

      expect(adopted).toMatchObject({
        heartbeatDeadline: armed.recoveryDeadline,
        lastWorkerSequence: 1,
        recoveryDeadline: null,
        recoveryState: null,
      });
      expect(
        acceptNanoHostAttemptHeartbeatByBinding(coreDb, {
          acceptedAt: '2026-07-05T00:01:01.000Z',
          lineage: fixture.lineage,
          sandboxBindingRef: 'lease-binding:lease_exact_reconnect',
          workerSequence: 2,
        })
      ).toMatchObject({ lastWorkerSequence: 2, phase: 'open' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'key',
    'lineage',
    'sequence',
    'deadline',
  ] as const)('rejects reconnect when %s does not match the armed lease', async (mismatch) => {
    const coreDb = createMigratedCoreDb();

    try {
      const suffix = `reject_${mismatch}`;
      const fixture = await prepareReconnectLease(coreDb, suffix);
      await recoverTestStartup(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        restoreBackendSession: async () => {},
      });
      const armed = requireNanoHostExecutionAttempt(coreDb, `lease_${suffix}`);
      const lineage =
        mismatch === 'lineage'
          ? { ...fixture.lineage, turnId: 'turn_from_another_worker' }
          : fixture.lineage;

      expect(() =>
        adoptNanoHostAttemptReconnect(coreDb, {
          acceptedAt:
            mismatch === 'deadline'
              ? (armed.recoveryDeadline ?? '2026-07-05T00:01:00.000Z')
              : '2026-07-05T00:01:01.000Z',
          lineage,
          reconnectKey:
            mismatch === 'key' ? reconnectKeyFor('wrong-process') : fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:lease_${suffix}`,
          workerSequence: mismatch === 'sequence' ? 3 : 2,
        })
      ).toThrow();
      expect(requireNanoHostExecutionAttempt(coreDb, `lease_${suffix}`)).toMatchObject({
        lastWorkerSequence: 1,
        recoveryDeadline: armed.recoveryDeadline,
        recoveryState: 'awaiting-reconnect',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('closes an expired reconnect attempt through complete recovery and admits its next Turn', async () => {
    const f = await createFinalReviewRecoveryFixture('reconnect_timeout', 'running');
    try {
      await recoverTestStartup(f.coreDb, f.input);
      const armed = requireNanoHostExecutionAttempt(f.coreDb, f.attemptId);
      expect(armed.recoveryState).toBe('awaiting-reconnect');
      if (!armed.recoveryDeadline) throw new Error('Restart did not arm exact reconnect.');
      f.clock.now = armed.recoveryDeadline;
      await drainTestRecovery(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId).status).toBe('interrupted');
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('interrupted');
      assertRecoveryClosedAndNextTurnAdmitted(f);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'proved',
    'proved-interrupted',
    'unknown',
    'partial',
  ] as const)('classifies failed preparation with Context input and zero handles without repeated cleanup: %s', async (proof) => {
    const f = await createFinalReviewRecoveryFixture(`early_image_${proof}`, 'failed-preparation');
    const original = f.store.getTurnById(f.turnId);
    dispatchLease(f.coreDb, 'early_image_sibling');
    recordBackendSession(f.coreDb, 'early_image_sibling');
    const sibling = getWorkerBackendSession(f.coreDb, 'lease_early_image_sibling');
    const db = openWorkspaceDb(f.coreDb.dataRoot, 'ws_demo');
    const cleanup = vi.fn(f.input.cleanupBackendSession);
    const release = vi.spyOn(f.input.executionBackend, 'release');
    try {
      const pkg = requireAgentEnvironmentPackageSnapshot(
        db,
        'ws_demo',
        `aepsnap_${f.turnId}_${f.agentSessionId}`
      ).snapshot;
      expect(pkg.workspace.inputs).toMatchObject([
        { access: 'read-only', id: `context_${f.turnId}`, source: { kind: 'generated' } },
      ]);
      if (proof === 'unknown')
        f.coreDb.sqlite
          .prepare(
            "UPDATE scheduler_execution_attempts SET disposition = 'unknown', operation_id = 'unproved-preparation' WHERE attempt_id = ?"
          )
          .run(f.attemptId);
      if (proof === 'partial') {
        recordCanonicalWorkspaceHandoff(db, pkg, '2026-07-05T00:00:04.000Z');
        db.sqlite.prepare('DELETE FROM backend_workspace_handles').run();
      }
      const input = { ...f.input, cleanupBackendSession: cleanup };
      let interruptedAttempt: ReturnType<typeof attempts.requireSchedulerExecutionAttempt> | null =
        null;
      if (proof === 'proved-interrupted') {
        release.mockRejectedValueOnce(new Error('release interrupted after handoff publication'));
        await expect(drainTestRecovery(f.coreDb, input)).rejects.toThrow(
          'Native attempt recovery failed.'
        );
        expect(getWorkerBackendSession(f.coreDb, f.attemptId)).toMatchObject({
          state: 'cleaned',
          workspaceHandoffState: 'complete',
        });
        interruptedAttempt = attempts.requireSchedulerExecutionAttempt(f.coreDb, f.attemptId);
        expect(interruptedAttempt).toMatchObject({
          phase: 'closing',
          terminalCause: 'execution-failed',
          outcomeRef: `turn:${f.turnId}:failed`,
          fenceRef: null,
        });
        expect(f.store.getTurnById(f.turnId)).toEqual(original);
      }
      const evidenceBeforeRetry = listWorkspaceRuntimeEvidence(db, 'ws_demo');
      if (proof === 'partial')
        await expect(drainTestRecovery(f.coreDb, input)).rejects.toThrow(
          'Native attempt recovery failed.'
        );
      else {
        await expect(drainTestRecovery(f.coreDb, input)).resolves.toBeUndefined();
        const evidence = listWorkspaceRuntimeEvidence(db, 'ws_demo');
        if (interruptedAttempt) expect(evidence).toEqual(evidenceBeforeRetry);
        f.clock.now = '2026-07-05T00:01:30.000Z';
        await expect(drainTestRecovery(f.coreDb, input)).resolves.toBeUndefined();
        expect(listWorkspaceRuntimeEvidence(db, 'ws_demo')).toEqual(evidence);
      }
      expect(f.store.getTurnById(f.turnId)).toEqual(original);
      expect(cleanup).not.toHaveBeenCalled();
      const proved = proof === 'proved' || proof === 'proved-interrupted';
      expect(release).toHaveBeenCalledTimes(proof === 'proved-interrupted' ? 2 : proved ? 1 : 0);
      const finalAttempt = attempts.requireSchedulerExecutionAttempt(f.coreDb, f.attemptId);
      expect(finalAttempt.phase).toBe(proved ? 'closed' : 'closing');
      if (interruptedAttempt) {
        expect(finalAttempt).toMatchObject({
          terminalCause: interruptedAttempt.terminalCause,
          outcomeRef: interruptedAttempt.outcomeRef,
          fenceRef: expect.any(String),
        });
        expect(release.mock.calls[1]).toEqual(release.mock.calls[0]);
        expect(release.mock.results.filter((result) => result.type === 'return')).toHaveLength(2);
        await expect(release.mock.results[0]?.value).rejects.toThrow(
          'release interrupted after handoff publication'
        );
        await expect(release.mock.results[1]?.value).resolves.toMatchObject({ state: 'released' });
      }
      expect(getWorkerBackendSession(f.coreDb, 'lease_early_image_sibling')).toEqual(sibling);
      if (proof !== 'partial') {
        expect(listBackendWorkspaceHandles(db, 'ws_demo')).toEqual([]);
        expect(listWorkspaceMaterializationRecords(db, 'ws_demo')).toEqual([]);
      }
      if (proof === 'unknown')
        expect(requireNanoHostExecutionAttempt(f.coreDb, f.attemptId)).toMatchObject({
          recoveryState: 'needs-evidence',
          disposition: 'unknown',
          outcomeRef: null,
          fenceRef: null,
        });
      expect(f.store.listArtifacts('ws_demo')).toEqual([]);
      if (proved) assertRecoveryClosedAndNextTurnAdmitted(f);
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });

  it('finishes failed-start cleanup before the real NanoHost release can close its attempt', async () => {
    const f = await createFinalReviewRecoveryFixture('failed_start_release_order', 'failed-start');
    try {
      await drainTestRecovery(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId).status).toBe('failed');
      assertRecoveryClosedAndNextTurnAdmitted(f);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'cleanup-pending',
    'physical-cleaned',
    'cleaned',
  ] as const)('defers %s to a live lifecycle owner and delegates accepted final-status closeout after it exits', async (state) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `live_owner_${state}`;
    const leaseId = `lease_${suffix}`;
    let active = true;
    const cleanupBackendSession = vi.fn(async () => {});
    const reconcileAcceptedFinalStatus = vi.fn(async () => {});
    const projectRecoveredTurn = vi.fn(async () => ({ status: 'completed' as const }));
    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, state);
      markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId: leaseId });
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: leaseId,
        firstTerminalCause: 'worker-final-status',
      });
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:07.000Z',
        lineage: {
          agentSessionId: `as_${suffix}`,
          packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
          requestId: `request_${suffix}`,
          threadId: `thread_${suffix}`,
          turnId: `turn_${suffix}`,
          workspaceId: 'ws_demo',
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });
      const original = getWorkerBackendSession(coreDb, leaseId);
      const input: RecoveryFixtureInput = {
        cleanupBackendSession,
        reconcileAcceptedFinalStatus,
        isTurnExecutionActive: (turnId) => active && turnId === `turn_${suffix}`,
        projectRecoveredTurn,
      };
      await drainTestRecovery(coreDb, input);
      expect(getWorkerBackendSession(coreDb, leaseId)).toEqual(original);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === leaseId)?.phase
      ).toBe('closing');
      expect(cleanupBackendSession).not.toHaveBeenCalled();
      expect(projectRecoveredTurn).not.toHaveBeenCalled();
      active = false;
      await drainTestRecovery(coreDb, input);
      expect(reconcileAcceptedFinalStatus).toHaveBeenCalledTimes(1);
      expect(reconcileAcceptedFinalStatus).toHaveBeenCalledWith(original);
      expect(cleanupBackendSession).not.toHaveBeenCalled();
      expect(projectRecoveredTurn).not.toHaveBeenCalled();
      expect(getWorkerBackendSession(coreDb, leaseId)).toEqual(original);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === leaseId)?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps an accepted completed final-status closeout with its owner before listen', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;
    let closeoutCalls = 0;
    let fallbackProjectionCalls = 0;
    let preparedIdentity:
      | Parameters<NonNullable<RecoveryFixtureInput['prepareBackendCleanup']>>[0]
      | null = null;

    try {
      const suffix = 'accepted_final_status';
      const fixture = await prepareReconnectLease(coreDb, suffix);
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:06.000Z',
        firstTerminalCause: 'worker-final-status',
      });
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:07.000Z',
        lineage: fixture.lineage,
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });
      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: (identity) => {
          preparedIdentity = identity;
        },
        projectRecoveredTurn: async (session) => {
          fallbackProjectionCalls += 1;
          expect(session).toMatchObject({
            agentSessionId: `as_${suffix}`,
            attemptId: `lease_${suffix}`,
            packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
            threadId: `thread_${suffix}`,
            turnId: `turn_${suffix}`,
            workspaceId: 'ws_demo',
          });
          return { status: 'failed' as const };
        },
        reconcileAcceptedFinalStatus: async () => {
          closeoutCalls += 1;
          return { status: 'completed' as const };
        },
      });

      expect({ cleanupCalls, closeoutCalls, fallbackProjectionCalls }).toEqual({
        cleanupCalls: 0,
        closeoutCalls: 0,
        fallbackProjectionCalls: 0,
      });
      expect(preparedIdentity).toMatchObject({
        agentSessionId: `as_${suffix}`,
        backendSessionId: testNanoHostBackendSessionId(suffix),
        packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
        runtimeTargetId: 'runtime-target-test',
      });
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps an accepted ask-user final-status closeout with its owner before listen', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;
    let closeoutCalls = 0;
    let fallbackProjectionCalls = 0;

    try {
      const suffix = 'accepted_ask_user';
      const fixture = await prepareReconnectLease(coreDb, suffix);
      beginOwnedAttemptCloseout(coreDb, {
        attemptId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:06.000Z',
        firstTerminalCause: 'worker-final-status',
      });
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:07.000Z',
        lineage: fixture.lineage,
        operation: 'final_status',
        record: { sequence: 1, status: 'blocked', stopReason: 'ask_user' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });

      await recoverTestStartup(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: () => undefined,
        projectRecoveredTurn: async () => {
          fallbackProjectionCalls += 1;
          return { status: 'failed' as const };
        },
        reconcileAcceptedFinalStatus: async () => {
          closeoutCalls += 1;
          return { status: 'interrupted' as const };
        },
      });

      expect({ cleanupCalls, closeoutCalls, fallbackProjectionCalls }).toEqual({
        cleanupCalls: 0,
        closeoutCalls: 0,
        fallbackProjectionCalls: 0,
      });
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === `lease_${suffix}`)
          ?.phase
      ).toBe('closing');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/** Revokes current Core authority without inferring any of the adapter's six release proofs. */
function beginOwnedAttemptCloseout(
  db: ReturnType<typeof openCoreDb>,
  input: {
    readonly attemptId: string;
    readonly firstTerminalCause: string;
    readonly outcome?: string;
    readonly now?: () => string;
  }
) {
  return attempts.markSchedulerExecutionAttemptClosing(db, {
    attemptId: input.attemptId,
    cause: input.firstTerminalCause,
    ...(input.now ? { now: input.now } : {}),
  });
}

/** Matches the deciding error through the current recovery owners' aggregate boundaries. */
function hasRecoveryFailure(error: unknown, expected: string | RegExp): boolean {
  if (error instanceof AggregateError)
    return error.errors.some((cause) => hasRecoveryFailure(cause, expected));
  if (!(error instanceof Error)) return false;
  return typeof expected === 'string'
    ? error.message.includes(expected)
    : expected.test(error.message);
}

/** Retains exact product and Native crash facts, optionally with an unpublished read-only Context input. */
async function createFinalReviewRecoveryFixture(
  suffix: string,
  boundary: 'running' | 'completed' | 'failed-start' | 'failed-preparation'
) {
  const coreDb = createMigratedCoreDb();
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const threadId = `thread_${suffix}`;
  const turnId = `turn_${suffix}`;
  const agentSessionId = `as_${suffix}`;
  const attemptId = `lease_${suffix}`;
  const packageSnapshotId = `aepsnap_turn_${suffix}_as_${suffix}`;
  store.createThread('ws_demo', 'Recover exact worker', threadId);
  store.createAgentSession({
    id: agentSessionId,
    agentId: 'agent_codex_host',
    workspaceId: 'ws_demo',
    threadId,
    status: 'busy',
    message: null,
    environmentPackageSnapshotId: packageSnapshotId,
    createdAt: '2026-07-05T00:00:01.000Z',
    updatedAt: '2026-07-05T00:00:01.000Z',
  });
  store.createTurn(
    'ws_demo',
    threadId,
    `Run ${suffix}`,
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      turnId,
      agentId: 'agent_codex_host',
      agentSessionId,
      status: 'pending',
      executorKind: 'worker',
      startedAt: '2026-07-05T00:00:01.000Z',
    }
  );
  store.updateTurn(turnId, { status: 'running' });
  if (boundary === 'running') await prepareReconnectLease(coreDb, suffix);
  else {
    dispatchLease(coreDb, suffix, undefined, boundary !== 'failed-preparation');
    if (boundary === 'failed-preparation') {
      const workspace = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        applyScopedMigrations(workspace);
        const contextRoot = mkdtempSync(join(tmpdir(), 'openkit-recovery-context-'));
        const context = '# Original bounded Task Context\n';
        writeFileSync(join(contextRoot, 'context.md'), context);
        const setup = createTestAgentSetup();
        admitTestNativeEnvironment(coreDb, setup.manifest);
        recordAgentEnvironmentPackageSnapshot(workspace, {
          createdAt: '2026-07-05T00:00:03.000Z',
          environmentPackage: resolveAgentEnvironmentPackage({
            coreDb,
            agentSetup: setup,
            agentSessionId,
            backend: { kind: 'openshell' },
            requestId: `request_${suffix}`,
            triggerActor: { kind: 'user', id: LOCAL_USER_ID },
            turn: store.getTurnById(turnId),
            turnInput: `Run ${suffix}`,
            workspaceRoots: [],
            preparedContextPackage: {
              contentDigest: `sha256:${createHash('sha256').update(context).digest('hex')}`,
              workspaceRoot: {
                access: 'read-only',
                id: `context_${turnId}`,
                sourceKind: 'materialized-dir',
                sourcePath: contextRoot,
                workerPath: workerSessionInputPaths(agentSessionId).contextRoot,
              },
            },
          }),
        });
      } finally {
        workspace.sqlite.close();
      }
    }
    recordBackendSession(
      coreDb,
      suffix,
      boundary === 'failed-preparation' || boundary === 'completed' ? 'cleaned' : 'physical-cleaned'
    );
  }
  const db = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  try {
    applyScopedMigrations(db);
    const pkg = requireAgentEnvironmentPackageSnapshot(db, 'ws_demo', packageSnapshotId).snapshot;
    if (boundary !== 'failed-preparation')
      recordCanonicalWorkspaceHandoff(db, pkg, '2026-07-05T00:00:04.000Z');
    else {
      const anchor = getWorkerBackendSession(coreDb, attemptId)!;
      const request = createNanoHostEffectRequest(anchor, attemptId, 'image.acquire', {
        imageReference:
          pkg.runtime.environment?.imageDigest ?? (pkg.runtime.image as { ref: string }).ref,
      });
      const intent = attempts.recordSchedulerExecutionOperation(coreDb, {
        attemptId,
        operationId: request.requestId!,
      });
      attempts.acceptSchedulerExecutionObservation(coreDb, {
        ...attempts.schedulerExecutionCorrelation(intent),
        disposition: 'not_accepted',
        execution: 'unknown',
        fenceRef: null,
        outcomeRef: null,
      });
    }
  } finally {
    db.sqlite.close();
  }
  if (
    boundary !== 'failed-preparation' &&
    getWorkerBackendSession(coreDb, attemptId)?.workspaceHandoffState === 'pending'
  )
    markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId });
  store.recordCommandRequest({
    command: 'turn.start',
    requestId: `request_${suffix}`,
    inputHash: `fixture:queue_${suffix}`,
    scope: { actorId: LOCAL_USER_ID, workspaceId: 'ws_demo', threadId },
    response: { kind: 'turn', id: turnId },
    createdAt: '2026-07-05T00:00:01.000Z',
  });
  if (boundary === 'completed') {
    // Retained canonical product completion predates the crash; recovery must preserve it and finish exclusion release.
    store.updateTurn(turnId, { status: 'completed', completedAt: '2026-07-05T00:00:08.000Z' });
    terminalizeGovernedWorkerTurn({
      store,
      turnId,
      agentSessionId,
      requestId: `request_${suffix}`,
      completedAt: '2026-07-05T00:00:08.000Z',
      outcome: 'interrupted',
      errorCode: 'worker_governance_restart_recovery',
      message: 'Recover original worker.',
    });
  } else if (boundary === 'failed-preparation') {
    attempts.markSchedulerExecutionAttemptClosing(coreDb, { attemptId, cause: 'execution-failed' });
    terminalizeGovernedWorkerTurn({
      store,
      turnId,
      agentSessionId,
      requestId: `request_${suffix}`,
      completedAt: '2026-07-05T00:00:08.000Z',
      outcome: 'failed',
      errorCode: 'worker_governance_turn_failed',
      message: 'Original image refusal.',
    });
  } else if (boundary === 'failed-start') {
    attempts.markSchedulerExecutionAttemptClosing(coreDb, {
      attemptId,
      cause: 'turn-start-failed',
      now: () => '2026-07-05T00:00:08.000Z',
    });
  }
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb,
    store,
    env: {},
    workerControlGateway: new WorkerControlGateway(),
    nanoHostSessionDispatch: {
      async effect() {
        throw new Error('Recovery cannot launch or replay a worker.');
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('No worker route is admitted during closeout.');
      },
      async fileExportResult() {
        throw new Error('No outside file export is pending.');
      },
      async workspaceCollectResult() {
        throw new Error('This package has no Workspace inputs.');
      },
      async imageBuildInput() {
        throw new Error('Recovery cannot rebuild the worker image.');
      },
    },
  });
  const executionBackend = runtime.turnExecutor.executionBackend!;
  const clock = { now: '2026-07-05T00:01:00.000Z' };
  const input: RunNanoHostAttemptRecoveryInput = {
    store,
    executionBackend,
    now: () => clock.now,
    // A definite external cleanup reply is modeled; the production owners record exact cleanup,
    // project handoff, publish the canonical outcome, derive barriers and invoke real Native release.
    cleanupBackendSession: async () => {},
    prepareBackendCleanup: () => {},
    restoreBackendSession: async () => {},
    reconcileAcceptedFinalStatus: async () => {
      throw new Error('This attempt has no final report.');
    },
    projectRecoveredTurn: async (subject) => {
      const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, subject.attemptId);
      const result = terminalizeGovernedWorkerTurn({
        store,
        turnId: subject.turnId,
        agentSessionId: subject.agentSessionId,
        requestId: admission.requestId,
        completedAt: input.now!(),
        outcome: 'interrupted',
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during scheduler recovery.',
      });
      if (result.status === 'pending' || result.status === 'running')
        throw new Error('Canonical recovery publication remains incomplete.');
      return { status: result.status };
    },
  };
  return { coreDb, store, threadId, turnId, agentSessionId, attemptId, input, clock };
}

/** Decides release using actual fenced closure and same-Thread/same-AgentSession admission, never cleanup counts. */
function assertRecoveryClosedAndNextTurnAdmitted(
  f: Awaited<ReturnType<typeof createFinalReviewRecoveryFixture>>
) {
  expect(getWorkerBackendSession(f.coreDb, f.attemptId)).toMatchObject({
    state: 'cleaned',
    physicalCleanedAt: expect.any(String),
    workspaceHandoffState: 'complete',
  });
  expect(attempts.requireSchedulerExecutionAttempt(f.coreDb, f.attemptId)).toMatchObject({
    phase: 'closed',
    fenceRef: expect.any(String),
  });
  const nextTurnId = `${f.turnId}_next`;
  f.store.createTurn(
    'ws_demo',
    f.threadId,
    'New authorized work',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      turnId: nextTurnId,
      agentId: 'agent_codex_host',
      agentSessionId: f.agentSessionId,
      executorKind: 'worker',
      status: 'pending',
    }
  );
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: LOCAL_USER_ID },
    queueEntryId: `queue_${nextTurnId}`,
    requestId: `request_${nextTurnId}`,
    requestedAgentId: 'agent_codex_host',
    threadId: f.threadId,
    turnId: nextTurnId,
    turnInput: 'New authorized work',
    workspaceId: 'ws_demo',
    now: () => f.clock.now,
  });
  const next = attempts.createSchedulerExecutionAttempt(f.coreDb, {
    entry,
    attemptId: `attempt_${nextTurnId}`,
    preparationInput: { admission: entry },
    now: () => f.clock.now,
  });
  expect(
    attempts.bindSchedulerExecutionAttemptSession(f.coreDb, {
      attemptId: next.attemptId,
      agentSessionId: f.agentSessionId,
      now: () => f.clock.now,
    })
  ).toMatchObject({
    phase: 'open',
    threadId: f.threadId,
    agentSessionId: f.agentSessionId,
    turnId: nextTurnId,
  });
}
