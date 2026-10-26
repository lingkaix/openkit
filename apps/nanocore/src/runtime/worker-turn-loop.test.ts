import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { serializeStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import * as attempts from './execution-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from './nanohost-harness-records.js';
import { TurnStartValidationError } from './orchestrator.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import {
  markWorkerBackendSessionLaunching,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  workerBackendLineageFromRuntimeImage,
} from './worker-backend-sessions.js';
import { getWorkerCheckpoint, updateWorkerCheckpoint } from './worker-checkpoints.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';
import {
  endWorkerTurnJournalRelease,
  endWorkerTurnMaterialization,
  prepareWorkerTurnJournalIntents,
} from './worker-governance-turn-executor.js';
import { resolveInterruptedWorkerRetryDecision } from './worker-recovery.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import type { RunWorkerTurnLoopInput, WorkerTurnLoopStartWorkerInput } from './worker-turn-loop.js';
import { runWorkerTurnLoop } from './worker-turn-loop.js';

/**
 * Opens a migrated Core database for worker-turn loop tests.
 *
 * @returns Migrated Core database handles.
 */
async function createCoreDb(): Promise<CoreDb> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-turn-loop-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  return coreDb;
}

/**
 * Opens a migrated workspace database paired with the Core database.
 *
 * @param coreDb Migrated Core database handles.
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/** Returns the shared prepared worker input used by loop boundary tests. */
function preparedWorkerTurn(reviewRequired: boolean) {
  return {
    delegationRequest: {
      schemaVersion: 1 as const,
      objective: 'Run the selected task.',
      acceptanceCriteria: ['Task passes.'],
      contextRefs: [{ kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' }],
      resources: [],
      expectedArtifacts: [],
      constraints: { maxContextTokens: 1000, maxWorkerIterations: 1 },
      verification: [{ kind: 'manual', description: 'Inspect the worker result.' }],
      reviewPolicy: {
        required: reviewRequired,
        reviewers: ['human'],
        instructions: 'Review the worker result.',
      },
      escalationConditions: [],
      reviewContext: null,
    },
    contextPackageDigest: 'ctxpkg_sha256_demo',
  };
}

describe('worker turn loop', () => {
  it('runs one worker turn and persists its checkpoint', async () => {
    const coreDb = await createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });

    try {
      const prepareCalls: unknown[][] = [];
      const result = await runWorkerTurnLoop({
        store,
        coreDb,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_worker_1',
        requestInputHash: 'sha256:worker_1',
        reviewRequired: true,
        remainingWorkerIterations: 1,
        prepare: (...args) => {
          prepareCalls.push(args);
          return preparedWorkerTurn(true);
        },
        reservedTurnId: 'tu_00000000-0000-70bb-b641-bbcd02b08432',
        reserveTurn: () => ({ turnId: 'tu_00000000-0000-70bb-b641-bbcd02b08432' }),
        startWorker: admittedWorker(
          coreDb,
          store,
          'req_worker_1',
          testEntityId('as', 'session_worker_1')
        ),
        awaitWorker: () => ({
          stopReason: 'completed',
          itemIds: ['it_00000000-0000-7815-a0f2-b025bd06cb71'],
          artifactIds: [testEntityId('ar', 'art_done')],
        }),
      });

      expect(prepareCalls).toEqual([[]]);
      expect(result).not.toHaveProperty('queues');
      expect(result).toMatchObject({
        turnId: 'tu_00000000-0000-70bb-b641-bbcd02b08432',
        workerSessionId: testEntityId('as', 'session_worker_1'),
        stopDecision: {
          outcome: 'review',
          shouldStop: true,
          stopReason: 'completed',
        },
        evidence: {
          itemIds: ['it_00000000-0000-7815-a0f2-b025bd06cb71'],
          artifactIds: [testEntityId('ar', 'art_done')],
        },
      });
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-70bb-b641-bbcd02b08432'
        )
      ).toMatchObject({
        goalId: 'goal_demo',
        taskId: 'task_demo',
        stage: 'completed',
        workerSessionId: testEntityId('as', 'session_worker_1'),
        contextDigest: 'ctxpkg_sha256_demo',
        stopReason: 'completed',
      });
      expect(latestPermissionDecision(workspaceDb)).toMatchObject({
        action: 'runtime.launch',
        enforcement_point: 'runtime.worker_turn_loop.start',
        reason_code: 'worker_turn_start_allowed',
        result: 'allow',
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records a redacted failed checkpoint when the worker boundary throws', async () => {
    const coreDb = await createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });

    try {
      await expect(
        runWorkerTurnLoop({
          store,
          coreDb,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          requestId: 'req_worker_error',
          requestInputHash: 'sha256:worker_error',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(true),
          reservedTurnId: 'tu_00000000-0000-77df-adbb-60408251b537',
          reserveTurn: () => ({ turnId: 'tu_00000000-0000-77df-adbb-60408251b537' }),
          startWorker: () => {
            throw new Error('Worker failed Authorization: Bearer live_secret');
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toThrow('Worker failed');

      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-77df-adbb-60408251b537'
        )
      ).toMatchObject({
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: 'Worker failed Authorization: Bearer [redacted]',
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps the preparing checkpoint when product recovery is required after worker cleanup', async () => {
    const coreDb = await createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });

    try {
      await expect(
        runWorkerTurnLoop({
          store,
          coreDb,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          requestId: 'req_worker_human_gate',
          requestInputHash: 'sha256:worker_human_gate',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(false),
          reservedTurnId: 'tu_00000000-0000-73bc-a823-88c41cce6d2d',
          reserveTurn: () => ({ turnId: 'tu_00000000-0000-73bc-a823-88c41cce6d2d' }),
          startWorker: () => {
            throw new TurnStartValidationError(
              'recovery_required',
              'Worker requested human input without an exact product Gate.',
              409
            );
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });

      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-73bc-a823-88c41cce6d2d'
        )
      ).toMatchObject({
        stage: 'preparing',
        stopReason: null,
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects removed authority before reservation, decision, checkpoint, or worker effects', async () => {
    const coreDb = await createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const timestamp = '2026-07-19T00:00:00.000Z';
    const now = Date.parse(timestamp);
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind
        ) VALUES ('usr_00000000-0000-7f44-93c6-043af05a4ae7', 'Removed Worker', 'removed-worker@example.com', false, ?, ?, 'human')`
      )
      .run(now, now);
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES ('ws_00000000-0000-7000-8000-000000000001', 'usr_00000000-0000-7f44-93c6-043af05a4ae7', 'removed', NULL, ?, ?, 2, ?, ?)`
      )
      .run(timestamp, timestamp, timestamp, timestamp);
    let reserveCalls = 0;
    let workerCalls = 0;

    try {
      await expect(
        runWorkerTurnLoop({
          store,
          coreDb,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7f44-93c6-043af05a4ae7' },
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          requestId: 'req_worker_removed_authority',
          requestInputHash: 'sha256:worker_removed_authority',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(false),
          reservedTurnId: 'tu_00000000-0000-7e51-b48b-2bc309ffc97d',
          reserveTurn: () => {
            reserveCalls += 1;
            return { turnId: 'tu_00000000-0000-7e51-b48b-2bc309ffc97d' };
          },
          startWorker: () => {
            workerCalls += 1;
            return { workerSessionId: 'session_worker_removed_authority' };
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });

      expect(reserveCalls).toBe(0);
      expect(workerCalls).toBe(0);
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-7e51-b48b-2bc309ffc97d'
        )
      ).toBeNull();
      expect(
        (
          workspaceDb.sqlite
            .prepare('SELECT COUNT(*) AS count FROM permission_decisions')
            .get() as {
            count: number;
          }
        ).count
      ).toBe(0);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('admits usable presented server-admin bearer for runtime.launch without membership', async () => {
    const coreDb = await createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES ('usr_00000000-0000-7916-9acc-f85082f95261', 'Admin Worker', 'admin-worker@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7916-9acc-f85082f95261',
      scope: 'server-admin',
      tokenId: 'token_admin_worker',
      workspaceIds: [],
    });
    let reserveCalls = 0;
    let workerCalls = 0;

    try {
      const result = await runWorkerTurnLoop({
        store,
        coreDb,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7916-9acc-f85082f95261' },
        requestActor: {
          kind: 'token',
          tokenId: 'token_admin_worker',
          tokenScope: 'server-admin',
          tokenWorkspaceIds: [],
          userId: 'usr_00000000-0000-7916-9acc-f85082f95261',
        },
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        requestId: 'req_worker_admin_authority',
        requestInputHash: 'sha256:worker_admin_authority',
        reviewRequired: false,
        remainingWorkerIterations: 0,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_00000000-0000-760d-af55-17911ecc38a5',
        reserveTurn: () => {
          reserveCalls += 1;
          return { turnId: 'tu_00000000-0000-760d-af55-17911ecc38a5' };
        },
        startWorker: async (input) => {
          workerCalls += 1;
          return admittedWorker(
            coreDb,
            store,
            'req_worker_admin_authority',
            testEntityId('as', 'session_worker_admin_authority'),
            'usr_00000000-0000-7916-9acc-f85082f95261',
            {
              kind: 'token',
              tokenId: 'token_admin_worker',
              tokenScope: 'server-admin',
              tokenWorkspaceIds: [],
              userId: 'usr_00000000-0000-7916-9acc-f85082f95261',
            }
          )(input);
        },
        awaitWorker: () => ({ stopReason: 'completed' }),
      });

      expect(result.turnId).toBe('tu_00000000-0000-760d-af55-17911ecc38a5');
      expect(reserveCalls).toBe(1);
      expect(workerCalls).toBe(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/**
 * Reads the newest permission decision row from a workspace database.
 *
 * @param workspaceDb Workspace database handle.
 * @returns Newest permission decision row.
 */
function latestPermissionDecision(workspaceDb: WorkspaceDb): {
  action: string;
  enforcement_point: string;
  reason_code: string;
  result: string;
} {
  return workspaceDb.sqlite
    .prepare(
      `SELECT action, enforcement_point, reason_code, result
       FROM permission_decisions
       ORDER BY created_at DESC, decision_id DESC
       LIMIT 1`
    )
    .get() as {
    action: string;
    enforcement_point: string;
    reason_code: string;
    result: string;
  };
}

it('bounds quoting worker errors in the loop checkpoint before rethrowing', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  const error = new SyntaxError('ROW_SECRET_X9');
  try {
    await expect(
      runWorkerTurnLoop({
        store,
        coreDb,
        workspaceDb,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_publication',
        requestInputHash: 'sha256:publication',
        reviewRequired: false,
        remainingWorkerIterations: 0,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_00000000-0000-7718-9293-4265e25b9375',
        reserveTurn: () => ({ turnId: 'tu_00000000-0000-7718-9293-4265e25b9375' }),
        startWorker: () => {
          throw error;
        },
        awaitWorker: () => ({ stopReason: 'completed' }),
      })
    ).rejects.toBe(error);
    const checkpoint = getWorkerCheckpoint(
      workspaceDb,
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'tu_00000000-0000-7718-9293-4265e25b9375'
    );
    expect(checkpoint).toMatchObject({
      stage: 'failed',
      stopReason: 'error',
      diagnosticsSummary: 'The record could not be processed.',
    });
    expect(JSON.stringify(checkpoint)).not.toContain('ROW_SECRET_X9');
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

/** Publishes native callback authority and original journal intent for modeled interrupted work. */
function admittedWorker(
  coreDb: CoreDb,
  store: import('../lib/store.js').FsStore,
  requestId: string,
  agentSessionId: string,
  actorId = 'usr_00000000-0000-7000-8000-000000000001',
  requestActor?: import('../auth/identity.js').Actor,
  hooks: {
    execute?: (turnId: string) => Promise<void>;
    interruptedRecovery?: true;
    observe?: WorkerTurnLoopStartWorkerInput['onAdmitted'];
  } = {}
) {
  return async ({ turnId, prepared, onAdmitted }: WorkerTurnLoopStartWorkerInput) => {
    const manifest = createTestAgentSetup().manifest;
    // The loop owns checkpoint projection, not the outside executor's terminal or release proof.
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const threadId = 'th_00000000-0000-7000-8000-000000000001';
    const timestamp = new Date().toISOString();
    if (!store.listThreadAgentSessions(workspaceId, threadId).some((s) => s.id === agentSessionId))
      await store.createAgentSession({
        id: agentSessionId,
        agentId: manifest.id,
        workspaceId,
        threadId,
        status: 'busy',
        message: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const prompt = serializeStructuredWorkerDelegationRequest(prepared.delegationRequest);
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue_loop_${turnId}`,
      requestId,
      turnId,
      threadId,
      workspaceId,
      requestedAgentId: manifest.id,
      triggerActor: { kind: 'user', id: actorId },
      turnInput: prompt,
      serverAdminTokenId:
        requestActor?.kind === 'token' && requestActor.tokenScope === 'server-admin'
          ? (requestActor.tokenId ?? null)
          : null,
    });
    const attempt = recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId: testEntityId('attempt', `loop:${turnId}`),
      agentSessionId,
      inputRef: `aepsnap_${turnId}_${agentSessionId}`,
      bindingRef: `worker-loop:${turnId}`,
      sessionCompatibilityKey: 'sha256:fixture',
      now: () => timestamp,
    });
    const admitted = await store.createTurn(
      workspaceId,
      threadId,
      prompt,
      { kind: 'user', id: actorId },
      null,
      { turnId, agentId: manifest.id, agentSessionId }
    );
    await onAdmitted(admitted, agentSessionId);
    await hooks.observe?.(admitted, agentSessionId);
    if (hooks.interruptedRecovery) {
      const setup = createTestAgentSetup();
      admitTestNativeEnvironment(coreDb, manifest);
      const target = recordTestNativeRuntimeTarget(coreDb);
      const db = openWorkspaceDb(coreDb.dataRoot, workspaceId);
      try {
        const environmentPackage = resolveAgentEnvironmentPackage({
          coreDb,
          agentSessionId,
          agentSetup: setup,
          backend: { kind: 'openshell' },
          createdAt: timestamp,
          requestId,
          turn: admitted,
          turnInput: prompt,
          triggerActor: admitted.triggerActor,
          workspaceRoots: [],
        });
        recordAgentEnvironmentPackageSnapshot(db, { environmentPackage, createdAt: timestamp });
        await store.updateAgentSession(agentSessionId, {
          environmentPackageSnapshotId: environmentPackage.snapshotId,
        });
        await store.updateTurn(
          turnId,
          { agentSessionId },
          { journalIntents: prepareWorkerTurnJournalIntents(db, environmentPackage, attempt, null) }
        );
        const hex = turnId.slice(3).replaceAll('-', '');
        const backendSessionId = `nh-${hex.slice(0, 16)}-${hex.slice(16)}`;
        // This explicit outside peer allocates no physical process or Workspace inputs.
        recordWorkerBackendSessionMaterializing(coreDb, {
          identity: {
            agentSessionId,
            backendKind: 'openshell',
            backendSessionId,
            deploymentId: target.deploymentId,
            packageSnapshotId: environmentPackage.snapshotId,
            runtimeTargetId: target.targetId,
            stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
            transientProviderInstanceId: null,
          },
          backendVersion: 'test',
          backendLineage: workerBackendLineageFromRuntimeImage(environmentPackage.runtime.image),
          lineage: { workspaceId, threadId, turnId },
          sandboxBindingRef: attempt.bindingRef!,
        });
        transitionWorkerBackendSessionState(coreDb, {
          attemptId: attempt.attemptId,
          fromState: 'materializing',
          toState: 'materialized',
        });
        markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId: attempt.attemptId });
        const submitted = attempts.recordSchedulerExecutionOperation(coreDb, {
          attemptId: attempt.attemptId,
          operationId: `worker-loop:${turnId}`,
          submission: true,
        });
        attempts.acceptSchedulerExecutionObservation(
          coreDb,
          await new SimulatedTurnExecutor({ coreDb }).submit({
            ...attempts.schedulerExecutionCorrelation(submitted),
            deadline: submitted.deadline!,
          })
        );
        markWorkerBackendSessionLaunching(coreDb, { attemptId: attempt.attemptId });
        await endWorkerTurnMaterialization(store, db, turnId, 'completed', [backendSessionId]);
      } finally {
        db.sqlite.close();
      }
    }
    await hooks.execute?.(turnId);
    return { workerSessionId: agentSessionId };
  };
}

/** Callback tests hold the outside worker effect after actual native admission publication. */
it.each([
  'fresh',
  'selected-current',
] as const)('binds the exact %s AgentSession before outside worker entry and acknowledgement', async (kind) => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  const sessionId =
    kind === 'selected-current'
      ? 'as_00000000-0000-754f-9277-4058a2a883d1'
      : 'as_00000000-0000-7df9-8dd9-3222dd5f7145';
  const at = '2026-10-06T00:00:00.000Z';
  if (kind === 'selected-current')
    await store.createAgentSession({
      id: sessionId,
      sessionCompatibilityKey: 'sha256:fixture',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      agentId: createTestAgentSetup().manifest.id,
      status: 'idle',
      message: null,
      createdAt: at,
      updatedAt: at,
    });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const running = runWorkerTurnLoop({
    coreDb,
    store,
    workspaceDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    requestId: 'req_held',
    requestInputHash: 'sha256:held',
    reviewRequired: false,
    prepare: () => preparedWorkerTurn(false),
    reservedTurnId: 'tu_00000000-0000-7dd2-9b14-67b4800ebb85',
    reserveTurn: () => ({ turnId: 'tu_00000000-0000-7dd2-9b14-67b4800ebb85' }),
    startWorker: admittedWorker(
      coreDb,
      store,
      'req_held',
      sessionId,
      'usr_00000000-0000-7000-8000-000000000001',
      undefined,
      {
        observe: () => {
          expect(
            getWorkerCheckpoint(
              workspaceDb,
              'ws_00000000-0000-7000-8000-000000000001',
              'th_00000000-0000-7000-8000-000000000001',
              'tu_00000000-0000-7dd2-9b14-67b4800ebb85'
            )
          ).toMatchObject({
            stage: 'running_worker',
            workerSessionId: sessionId,
            stopReason: null,
          });
        },
        execute: async () => {
          entered.resolve();
          await release.promise;
        },
      }
    ),
    awaitWorker: () => ({ stopReason: 'aborted' }),
  });
  try {
    await Promise.race([entered.promise, running]);
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7dd2-9b14-67b4800ebb85'
      )
    ).toMatchObject({
      stage: 'running_worker',
      workerSessionId: sessionId,
    });
    release.resolve();
    await running;
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7dd2-9b14-67b4800ebb85'
      )
    ).toMatchObject({
      stage: 'aborted',
      stopReason: 'aborted',
      workerSessionId: sessionId,
    });
  } finally {
    release.resolve();
    await running.catch(() => {});
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it.each([
  'authority-denial',
  'restart-cleanup',
  'incomplete-lease',
] as const)('preserves admitted interruption through %s and reopened classification without a second launch', async (failure) => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  const error = new TurnStartValidationError(
    'workspace_access_denied',
    'Workspace access denied.',
    403
  );
  let launches = 0;
  const sessionId = 'as_00000000-0000-74bb-aa9a-de1be4d761f4';
  try {
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestId: 'req_interrupted',
        requestInputHash: 'sha256:interrupted',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_00000000-0000-725e-ab73-6634f596ac13',
        reserveTurn: () => ({ turnId: 'tu_00000000-0000-725e-ab73-6634f596ac13' }),
        startWorker: admittedWorker(
          coreDb,
          store,
          'req_interrupted',
          sessionId,
          'usr_00000000-0000-7000-8000-000000000001',
          undefined,
          {
            interruptedRecovery: true,
            execute: async (turnId) => {
              launches++;
              const at = new Date().toISOString();
              const [attempt] = attempts.listSchedulerExecutionAttemptsForTurn(coreDb, {
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                threadId: 'th_00000000-0000-7000-8000-000000000001',
                turnId,
              });
              attempts.markSchedulerExecutionAttemptClosing(coreDb, {
                attemptId: attempt!.attemptId,
                cause: 'authority-revoked',
              });
              await terminalizeGovernedWorkerTurn({
                store,
                turnId,
                agentSessionId: sessionId,
                requestId: 'req_interrupted',
                completedAt: at,
                outcome: 'interrupted',
                errorCode: 'worker_governance_restart_recovery',
                message: 'Worker execution was interrupted during scheduler recovery.',
              });
              throw error;
            },
          }
        ),
        awaitWorker: () => ({ stopReason: 'completed' }),
      })
    ).rejects.toBe(error);
    const checkpoint = getWorkerCheckpoint(
      workspaceDb,
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'tu_00000000-0000-725e-ab73-6634f596ac13'
    )!;
    expect(checkpoint).toMatchObject({
      stage: 'running_worker',
      stopReason: null,
      workerSessionId: sessionId,
    });
    const [original] = attempts.listSchedulerExecutionAttemptsForTurn(coreDb, checkpoint);
    const lineage = {
      ...checkpoint,
      agentSessionId: sessionId,
      packageSnapshotId: original!.inputRef!,
    };
    expect(getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toBeNull();
    if (failure !== 'authority-denial') {
      const runtime = createConfiguredWorkerLifecycleRuntime({ coreDb, store, env: {} });
      await runNanoHostAttemptRecoveryMaintenance(coreDb, {
        store,
        executionBackend: runtime.turnExecutor.executionBackend!,
        // The outside peer acknowledges deletion of only its modeled allocation.
        cleanupBackendSession: async (identity) => {
          expect(identity).toMatchObject({
            agentSessionId: sessionId,
            packageSnapshotId: original!.inputRef,
          });
        },
        reconcileExecutions: async () => {},
        prepareBackendCleanup: () => false,
        restoreBackendSession: async () => {},
        reconcileAcceptedFinalStatus: async () => {
          throw new Error('No final was reported.');
        },
        projectRecoveredTurn: async (subject) => {
          const turn = store.getTurnById(subject.turnId);
          if (turn.status !== 'interrupted') throw new Error('Original interruption is missing.');
          return { status: turn.status };
        },
      });
      const closed = attempts.requireSchedulerExecutionAttempt(coreDb, original!.attemptId);
      expect(closed).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
      await endWorkerTurnJournalRelease(store, workspaceDb, checkpoint.turnId, closed.fenceRef!);
      expect(getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toBeNull();
    }
    if (failure === 'incomplete-lease')
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET agent_session_id=? WHERE turn_id=?')
        .run('as_00000000-0000-7099-938c-16baf0c1baa4', checkpoint.turnId);
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    const reopenedCore = openCoreDb(coreDb.dataRoot);
    const reopenedWorkspace = openWorkspaceDb(
      coreDb.dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    await openTestNativeWorkspace(reopenedWorkspace);
    try {
      const reopenedStore = await createDemoStore({ dataRoot: coreDb.dataRoot });
      expect(
        getWorkerCheckpoint(
          reopenedWorkspace,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          checkpoint.turnId
        )
      ).toEqual(checkpoint);
      expect(
        resolveInterruptedWorkerRetryDecision(
          reopenedCore,
          reopenedStore,
          reopenedWorkspace,
          checkpoint
        ).status
      ).toBe(
        failure === 'restart-cleanup'
          ? 'eligible'
          : failure === 'authority-denial'
            ? 'stale'
            : 'recovery-required'
      );
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb: reopenedCore,
          store: reopenedStore,
          workspaceDb: reopenedWorkspace,
          checkpoint,
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(
        getWorkerCheckpoint(
          reopenedWorkspace,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          checkpoint.turnId
        )
      ).toEqual(checkpoint);
      expect(launches).toBe(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      reopenedWorkspace.sqlite.close();
      reopenedCore.sqlite.close();
    }
  } finally {
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  }
});

it('refuses mismatched callback lineage before acknowledgement or executor effects', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  let acknowledgements = 0;
  let launches = 0;
  try {
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestId: 'req_mismatch',
        requestInputHash: 'sha256:mismatch',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_00000000-0000-7d96-b42c-d1bcafa20670',
        reserveTurn: () => ({ turnId: 'tu_00000000-0000-7d96-b42c-d1bcafa20670' }),
        startWorker: ({ onAdmitted, ...input }) =>
          admittedWorker(
            coreDb,
            store,
            'req_mismatch',
            'as_00000000-0000-7c7c-9c87-2e281beb00cd',
            'usr_00000000-0000-7000-8000-000000000001',
            undefined,
            {
              observe: () => {
                acknowledgements++;
              },
              execute: async () => {
                launches++;
              },
            }
          )({
            ...input,
            onAdmitted: (turn, _session) =>
              onAdmitted(turn, 'as_00000000-0000-7099-938c-16baf0c1baa4'),
          }),
        awaitWorker: () => ({ stopReason: 'completed' }),
      })
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(acknowledgements).toBe(0);
    expect(launches).toBe(0);
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7d96-b42c-d1bcafa20670'
      )
    ).toMatchObject({
      stage: 'preparing',
      workerSessionId: null,
      stopReason: null,
    });
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('late admission callbacks preserve a terminal binding and cannot recreate a lost checkpoint', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  let callback!: WorkerTurnLoopStartWorkerInput['onAdmitted'];
  try {
    await runWorkerTurnLoop({
      coreDb,
      store,
      workspaceDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      requestId: 'req_late',
      requestInputHash: 'sha256:late',
      reviewRequired: false,
      prepare: () => preparedWorkerTurn(false),
      reservedTurnId: 'tu_00000000-0000-7b56-819e-feee751c1be8',
      reserveTurn: () => ({ turnId: 'tu_00000000-0000-7b56-819e-feee751c1be8' }),
      startWorker: (input) => {
        callback = input.onAdmitted;
        return admittedWorker(
          coreDb,
          store,
          'req_late',
          'as_00000000-0000-74d5-8679-7772bcbbc47b'
        )(input);
      },
      awaitWorker: () => ({ stopReason: 'completed' }),
    });
    const before = getWorkerCheckpoint(
      workspaceDb,
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'tu_00000000-0000-7b56-819e-feee751c1be8'
    );
    expect(before).toMatchObject({
      stage: 'completed',
      stopReason: 'completed',
      workerSessionId: 'as_00000000-0000-74d5-8679-7772bcbbc47b',
    });
    await expect(
      callback(
        store.getTurnById('tu_00000000-0000-7b56-819e-feee751c1be8'),
        'as_00000000-0000-74d5-8679-7772bcbbc47b'
      )
    ).rejects.toThrow(TurnStartValidationError);
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7b56-819e-feee751c1be8'
      )
    ).toEqual(before);
    await shutdownControlStoreWorkerClient();
    // Fault injection loses the exact checkpoint; the loop fixture has no terminal release proof.
    expect(
      workspaceDb.sqlite
        .prepare(
          'DELETE FROM worker_turn_checkpoints WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?'
        )
        .run(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-7b56-819e-feee751c1be8'
        ).changes
    ).toBe(1);
    await expect(
      callback(
        store.getTurnById('tu_00000000-0000-7b56-819e-feee751c1be8'),
        'as_00000000-0000-74d5-8679-7772bcbbc47b'
      )
    ).rejects.toThrow(TurnStartValidationError);
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7b56-819e-feee751c1be8'
      )
    ).toBeNull();
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('a late completion error preserves an already terminal checkpoint and its exact session', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  const error = new Error('Late completion failure');
  let terminal: ReturnType<typeof getWorkerCheckpoint>;
  try {
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestId: 'req_terminal',
        requestInputHash: 'sha256:terminal',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_00000000-0000-7356-ad77-7e36b7c4e23b',
        reserveTurn: () => ({ turnId: 'tu_00000000-0000-7356-ad77-7e36b7c4e23b' }),
        startWorker: admittedWorker(
          coreDb,
          store,
          'req_terminal',
          'as_00000000-0000-7fc9-a4b3-5d9a4fa54ed7'
        ),
        awaitWorker: async () => {
          terminal = await updateWorkerCheckpoint(workspaceDb, {
            authorityActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-7356-ad77-7e36b7c4e23b',
            stage: 'completed',
            stopReason: 'completed',
          });
          throw error;
        },
      })
    ).rejects.toBe(error);
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7356-ad77-7e36b7c4e23b'
      )
    ).toEqual(terminal!);
    expect(terminal!).toMatchObject({
      stage: 'completed',
      stopReason: 'completed',
      workerSessionId: 'as_00000000-0000-7fc9-a4b3-5d9a4fa54ed7',
    });
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('removes only its live never-leased cancelled preparation and retains cancellation before refusal', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  try {
    const independent = await runWorkerTurnLoop({
      coreDb,
      store,
      workspaceDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      requestId: 'req_independent',
      requestInputHash: 'sha256:independent',
      reviewRequired: false,
      prepare: () => preparedWorkerTurn(false),
      reservedTurnId: 'tu_00000000-0000-75a0-878a-b5fb1687f8c1',
      reserveTurn: () => ({ turnId: 'tu_00000000-0000-75a0-878a-b5fb1687f8c1' }),
      startWorker: () => {
        throw new TurnStartValidationError('recovery_required', 'Retain preparation.', 409);
      },
      awaitWorker: () => ({ stopReason: 'completed' }),
    }).catch(() =>
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-75a0-878a-b5fb1687f8c1'
      )
    );
    await expect(
      runWorkerTurnLoop({
        coreDb,
        store,
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestId: 'req_cancelled',
        requestInputHash: 'sha256:cancelled',
        reviewRequired: false,
        prepare: () => preparedWorkerTurn(false),
        reservedTurnId: 'tu_00000000-0000-7545-87f1-1b9ca5ac5e2b',
        reserveTurn: () => ({ turnId: 'tu_00000000-0000-7545-87f1-1b9ca5ac5e2b' }),
        startWorker: cancelledWorker(coreDb, 'req_cancelled'),
        awaitWorker: () => {
          throw new Error('No worker outcome exists.');
        },
      })
    ).rejects.toThrow('Controlled pre-admission preparation refusal.');
    expect(
      coreDb.sqlite
        .prepare('SELECT status FROM scheduler_admission_entries WHERE request_id=?')
        .get('req_cancelled')
    ).toEqual({ status: 'cancelled' });
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7545-87f1-1b9ca5ac5e2b'
      )
    ).toBeNull();
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-75a0-878a-b5fb1687f8c1'
      )
    ).toEqual(independent);
    expect(
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
    for (const table of ['worker_backend_sessions', 'worker_control_records'])
      expect(coreDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    expect(
      workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM runtime_evidence').get()
    ).toEqual({ count: 0 });
    expect(
      workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM permission_decisions').get()
    ).toEqual({ count: 2 });
    expect(store.listCommandRequests()).toEqual([]);
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

/** Cancels exact never-attempted intent before product publication; no Native effects exist. */
function cancelledWorker(coreDb: CoreDb, requestId: string) {
  return ({ turnId, prepared }: WorkerTurnLoopStartWorkerInput): never => {
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue_cancel_${turnId}`,
      requestId,
      turnId,
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      requestedAgentId: createTestAgentSetup().manifest.id,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      turnInput: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
    });
    cancelSchedulerAdmissionEntry(coreDb, {
      queueEntryId: entry.queueEntryId,
      workspaceId: entry.workspaceId,
    });
    throw new Error('Controlled pre-admission preparation refusal.');
  };
}

/**
 * Builds a real loop, scheduler and storage invocation with one controlled pre-admission preparation refusal.
 * @param coreDb Core admission owner.
 * @param workspaceDb Workspace checkpoint owner.
 * @param store Canonical product history owner.
 * @param mutate Fault injected after cancellation and before the loop receives the refusal.
 * @returns Invocation using the production admission and dispatch path.
 */
function cancelledLoopInput(
  coreDb: CoreDb,
  workspaceDb: WorkspaceDb,
  store: import('../lib/store.js').FsStore,
  mutate: () => void | Promise<void> = () => {}
): RunWorkerTurnLoopInput {
  return {
    coreDb,
    workspaceDb,
    store,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    requestId: 'req_refusal',
    requestInputHash: 'sha256:refusal',
    reviewRequired: false,
    prepare: () => preparedWorkerTurn(false),
    reservedTurnId: 'tu_00000000-0000-7952-9279-bc2b017e274b',
    reserveTurn: () => ({ turnId: 'tu_00000000-0000-7952-9279-bc2b017e274b' }),
    startWorker: async (input) => {
      try {
        return cancelledWorker(coreDb, 'req_refusal')(input);
      } catch (error) {
        await mutate();
        throw error;
      }
    },
    awaitWorker: () => {
      throw new Error('A refused preparation has no worker outcome.');
    },
  };
}

it.each([
  'lease',
  'turn',
  'global-turn',
  'session',
  'backend',
  'control',
  'runtime-evidence',
  'changed-checkpoint',
  'changed-admission',
  'cancellation-failed',
  'rollback',
] as const)('preserves cancelled preparation when %s defeats the no-execution proof', async (kind) => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  const at = '2026-10-06T00:00:00.000Z';
  let before: ReturnType<typeof getWorkerCheckpoint>;
  if (kind === 'cancellation-failed')
    coreDb.sqlite.exec(`CREATE TRIGGER refuse_cancel
      BEFORE UPDATE OF status ON scheduler_admission_entries WHEN NEW.status='cancelled'
      BEGIN SELECT RAISE(ABORT, 'Cancellation storage failure'); END`);
  const input = cancelledLoopInput(coreDb, workspaceDb, store, async () => {
    if (kind === 'lease') {
      const row = coreDb.sqlite
        .prepare('SELECT queue_entry_id AS id FROM scheduler_admission_entries WHERE turn_id=?')
        .get('tu_00000000-0000-7952-9279-bc2b017e274b') as { id: string };
      coreDb.sqlite
        .prepare("UPDATE scheduler_admission_entries SET status='queued' WHERE queue_entry_id=?")
        .run(row.id);
      recordTestExecutionAttempt(coreDb, {
        entry: requireSchedulerAdmissionEntry(coreDb, row.id),
        attemptId: 'attempt_00000000-0000-752d-b6ea-948c6ffce000',
        agentSessionId: 'as_00000000-0000-7c9b-868b-c8bf0628ce98',
        inputRef: 'aepsnap_refusal',
        bindingRef: 'attempt-binding:refusal',
        sessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
        now: () => at,
      });
      coreDb.sqlite
        .prepare("UPDATE scheduler_admission_entries SET status='cancelled' WHERE queue_entry_id=?")
        .run(row.id);
    }
    if (kind === 'turn' || kind === 'global-turn') {
      const threadId =
        kind === 'global-turn'
          ? (await store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Other owner')).id
          : 'th_00000000-0000-7000-8000-000000000001';
      await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        threadId,
        'Contradictory execution',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        undefined,
        { turnId: 'tu_00000000-0000-7952-9279-bc2b017e274b' }
      );
    }
    if (kind === 'session') {
      coreDb.sqlite
        .prepare(`INSERT INTO nanohost_runtime_targets (
        target_id, identity_id, deployment_id, connection_generation, predecessor_fenced,
        ready, fresh_empty, physical_epoch, observed_at, slot_count
      ) VALUES ('nanohost', 'identity', 'deployment', 1, 1, 1, 1, ?, ?, 1)`)
        .run('e'.repeat(64), at);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: 'e'.repeat(64),
        sandboxBindingRef: 'sandbox-binding',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding',
        sandboxRuntimeId: 'sandbox',
        runtimeTargetId: 'nanohost',
        timestamp: at,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'as_00000000-0000-7c9b-868b-c8bf0628ce98',
        agentSessionRuntimeBindingId: 'as-binding',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        timestamp: at,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      coreDb.sqlite
        .prepare('UPDATE agent_session_runtime_bindings SET current_turn_id=?')
        .run('tu_00000000-0000-7952-9279-bc2b017e274b');
    }
    if (kind === 'backend')
      coreDb.sqlite
        .prepare(`INSERT INTO worker_backend_sessions (
        attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, backend_kind, deployment_id,
        backend_session_id, staging_directory_ref, workspace_handoff_state, state, created_at, updated_at, origin_physical_epoch
        ) VALUES ('lease_refusal', 'ws_00000000-0000-7000-8000-000000000001', 'th_00000000-0000-7000-8000-000000000001', 'tu_00000000-0000-7952-9279-bc2b017e274b', 'as_00000000-0000-7c9b-868b-c8bf0628ce98', 'aepsnap_refusal', 'openshell', 'deployment',
        'backend', 'staging', 'pending', 'materializing', ?, ?, ?)`)
        .run(at, at, 'e'.repeat(64));
    if (kind === 'control')
      coreDb.sqlite
        .prepare(`INSERT INTO worker_control_records (
        workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, request_id, operation, record_key, sequence, record_json, accepted_at
        ) VALUES ('ws_00000000-0000-7000-8000-000000000001', 'th_00000000-0000-7000-8000-000000000001', 'tu_00000000-0000-7952-9279-bc2b017e274b', 'as_00000000-0000-7c9b-868b-c8bf0628ce98', 'aepsnap_refusal', 'req_refusal', 'observe', 'key', 1, '{}', ?)`)
        .run(at);
    if (kind === 'runtime-evidence')
      workspaceDb.sqlite
        .prepare(`INSERT INTO runtime_evidence (
        runtime_evidence_id, workspace_id, thread_id, turn_id, placement, phase, summary, upload_manifest_json, download_manifest_json,
        outcome, evidence_bundle_ids_json, content_digests_json, required_features_json, created_at
        ) VALUES ('rte_refusal', 'ws_00000000-0000-7000-8000-000000000001', 'th_00000000-0000-7000-8000-000000000001', 'tu_00000000-0000-7952-9279-bc2b017e274b', 'local', 'checkpoint', 'Contradiction', '[]', '[]', 'unknown', '[]', '[]', '[]', ?)`)
        .run(at);
    if (kind === 'changed-checkpoint') {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite
        .prepare(
          "UPDATE worker_turn_checkpoints SET request_input_hash='sha256:changed' WHERE turn_id='tu_00000000-0000-7952-9279-bc2b017e274b'"
        )
        .run();
      await openTestNativeWorkspace(workspaceDb);
    }
    if (kind === 'changed-admission')
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_admission_entries SET turn_input='changed' WHERE turn_id='tu_00000000-0000-7952-9279-bc2b017e274b'"
        )
        .run();
    if (kind === 'rollback') {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.exec(`CREATE TRIGGER refuse_removal
        BEFORE DELETE ON worker_turn_checkpoints BEGIN SELECT RAISE(ABORT, 'Workspace removal failure'); END`);
      await openTestNativeWorkspace(workspaceDb);
    }
    before = getWorkerCheckpoint(
      workspaceDb,
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'tu_00000000-0000-7952-9279-bc2b017e274b'
    );
  });
  try {
    if (kind === 'rollback') {
      const refusal = runWorkerTurnLoop(input);
      await expect(refusal).rejects.toBeInstanceOf(ControlStoreWorkerError);
      await expect(refusal).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
    } else await expect(runWorkerTurnLoop(input)).rejects.toThrow();
    if (kind === 'lease') {
      // Retained execution contradicts the cancelled admission's no-execution claim.
      // Placement plans have no successor relation; keep the exact attempt/admission link.
      const exists = coreDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
        )
        .get();
      expect(exists, 'This fault must positively retain execution evidence.').toBeDefined();
      expect(
        coreDb.sqlite
          .prepare('SELECT turn_id FROM scheduler_execution_attempts WHERE turn_id = ?')
          .all('tu_00000000-0000-7952-9279-bc2b017e274b')
      ).toEqual([{ turn_id: 'tu_00000000-0000-7952-9279-bc2b017e274b' }]);
    }
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7952-9279-bc2b017e274b'
      )
    ).toEqual(before!);
    expect(before!).toMatchObject({ stage: 'preparing', workerSessionId: null, stopReason: null });
    expect(
      coreDb.sqlite
        .prepare('SELECT status FROM scheduler_admission_entries WHERE request_id=?')
        .get('req_refusal')
    ).toEqual({ status: kind === 'cancellation-failed' ? 'queued' : 'cancelled' });
    if (kind === 'rollback') {
      const reopenedCore = openCoreDb(coreDb.dataRoot);
      const reopenedWorkspace = openWorkspaceDb(
        coreDb.dataRoot,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      await openTestNativeWorkspace(reopenedWorkspace);
      try {
        const residual = getWorkerCheckpoint(
          reopenedWorkspace,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-7952-9279-bc2b017e274b'
        );
        expect(residual).toEqual(before!);
        await expect(
          classifyDirectTaskCheckpointAfterSchedulerRecovery({
            coreDb: reopenedCore,
            store,
            workspaceDb: reopenedWorkspace,
            checkpoint: residual!,
          })
        ).rejects.toMatchObject({ code: 'recovery_required' });
        expect(
          getWorkerCheckpoint(
            reopenedWorkspace,
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001',
            'tu_00000000-0000-7952-9279-bc2b017e274b'
          )
        ).toEqual(before!);
      } finally {
        reopenedWorkspace.sqlite.close();
        reopenedCore.sqlite.close();
      }
    }
    if (!['lease', 'session', 'global-turn', 'turn'].includes(kind)) {
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb,
          store,
          workspaceDb,
          checkpoint: before!,
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-7952-9279-bc2b017e274b'
        )
      ).toEqual(before!);
    }
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('cancelled request replay cannot prepare or launch again after checkpoint removal, including reopened storage', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  await expect(runWorkerTurnLoop(cancelledLoopInput(coreDb, workspaceDb, store))).rejects.toThrow();
  await shutdownControlStoreWorkerClient();
  workspaceDb.sqlite.close();
  coreDb.sqlite.close();
  const reopenedCore = openCoreDb(coreDb.dataRoot);
  const reopenedWorkspace = openWorkspaceDb(
    coreDb.dataRoot,
    'ws_00000000-0000-7000-8000-000000000001'
  );
  await openTestNativeWorkspace(reopenedWorkspace);
  try {
    const replay = cancelledLoopInput(
      reopenedCore,
      reopenedWorkspace,
      await createDemoStore({ dataRoot: coreDb.dataRoot })
    );
    const prepare = vi.fn(replay.prepare);
    const startWorker = vi.fn(replay.startWorker);
    await expect(runWorkerTurnLoop({ ...replay, prepare, startWorker })).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
    expect(
      getWorkerCheckpoint(
        reopenedWorkspace,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7952-9279-bc2b017e274b'
      )
    ).toBeNull();
    expect(
      reopenedCore.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
    ).toEqual({ count: 1 });
  } finally {
    await shutdownControlStoreWorkerClient();
    reopenedWorkspace.sqlite.close();
    reopenedCore.sqlite.close();
  }
});

it.each([
  'usr_00000000-0000-73d4-904a-d4c4b905df7c',
  'usr_00000000-0000-7000-8000-000000000001',
])('an unrelated admission with the same request ID does not block or erase this reserved Turn (%s)', async (actorId) => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  try {
    // Request UUID alone is not command identity: actor and Thread scope remain exact.
    const unrelated = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_other',
      requestId: 'req_refusal',
      turnId: 'tu_00000000-0000-7bf1-990f-799cdaa2a481',
      threadId:
        actorId === 'usr_00000000-0000-7000-8000-000000000001'
          ? 'th_00000000-0000-78ce-b458-8347d12d1da2'
          : 'th_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      requestedAgentId: createTestAgentSetup().manifest.id,
      triggerActor: { kind: 'user', id: actorId },
      turnInput: serializeStructuredWorkerDelegationRequest(
        preparedWorkerTurn(false).delegationRequest
      ),
    });
    cancelSchedulerAdmissionEntry(coreDb, {
      queueEntryId: unrelated.queueEntryId,
      workspaceId: unrelated.workspaceId,
    });
    const other = coreDb.sqlite
      .prepare(
        "SELECT * FROM scheduler_admission_entries WHERE turn_id='tu_00000000-0000-7bf1-990f-799cdaa2a481'"
      )
      .get();
    await expect(
      runWorkerTurnLoop(cancelledLoopInput(coreDb, workspaceDb, store))
    ).rejects.toThrow();
    expect(
      getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7952-9279-bc2b017e274b'
      )
    ).toBeNull();
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT * FROM scheduler_admission_entries WHERE turn_id='tu_00000000-0000-7bf1-990f-799cdaa2a481'"
        )
        .get()
    ).toEqual(other);
    expect(
      coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
    ).toEqual({ count: 2 });
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

it('process loss after durable cancellation leaves preparation for fail-closed restart inspection', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  const input = cancelledLoopInput(coreDb, workspaceDb, store);
  let signalCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    signalCancellation = resolve;
  });
  // Abandon the live invocation after Core commits, before its refusal returns to the loop. No cleanup callback survives this simulated process-loss boundary.
  void runWorkerTurnLoop({
    ...input,
    startWorker: async (start) => {
      try {
        return await input.startWorker(start);
      } catch {
        signalCancellation();
        return new Promise<never>(() => {});
      }
    },
  });
  await cancellation;
  const before = getWorkerCheckpoint(
    workspaceDb,
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'tu_00000000-0000-7952-9279-bc2b017e274b'
  );
  expect(before).toMatchObject({ stage: 'preparing', workerSessionId: null, stopReason: null });
  expect(
    coreDb.sqlite
      .prepare(
        "SELECT status FROM scheduler_admission_entries WHERE turn_id='tu_00000000-0000-7952-9279-bc2b017e274b'"
      )
      .get()
  ).toEqual({ status: 'cancelled' });
  await shutdownControlStoreWorkerClient();
  workspaceDb.sqlite.close();
  coreDb.sqlite.close();
  const reopenedCore = openCoreDb(coreDb.dataRoot);
  const reopenedWorkspace = openWorkspaceDb(
    coreDb.dataRoot,
    'ws_00000000-0000-7000-8000-000000000001'
  );
  await openTestNativeWorkspace(reopenedWorkspace);
  try {
    await expect(
      classifyDirectTaskCheckpointAfterSchedulerRecovery({
        coreDb: reopenedCore,
        store,
        workspaceDb: reopenedWorkspace,
        checkpoint: before!,
      })
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(
      getWorkerCheckpoint(
        reopenedWorkspace,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'tu_00000000-0000-7952-9279-bc2b017e274b'
      )
    ).toEqual(before);

    expect(
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
  } finally {
    await shutdownControlStoreWorkerClient();
    reopenedWorkspace.sqlite.close();
    reopenedCore.sqlite.close();
  }
});

it('a changed reservation cannot overwrite the declared command Turn identity', async () => {
  const coreDb = await createCoreDb();
  const workspaceDb = createWorkspaceDb(coreDb);
  const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
  try {
    const input = cancelledLoopInput(coreDb, workspaceDb, store);
    const startWorker = vi.fn(input.startWorker);
    await expect(
      runWorkerTurnLoop({
        ...input,
        startWorker,
        reserveTurn: () => ({ turnId: 'tu_00000000-0000-78cc-bf54-1d1b079a2d9c' }),
      })
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(startWorker).not.toHaveBeenCalled();
    expect(
      workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_turn_checkpoints').get()
    ).toEqual({ count: 0 });
    expect(
      coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
    ).toEqual({ count: 0 });
  } finally {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
