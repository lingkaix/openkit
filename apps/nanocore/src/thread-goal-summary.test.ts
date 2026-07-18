import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { classifyGoalStepCheckpointAfterSchedulerRecovery } from './goal-routes.js';
import { StructuredWorkerDelegationRequestSchema } from './internal-agents/delegation.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { recordProductPermissionDecision } from './policy/permission-decisions.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import { listGoalReviewRecordsForTask } from './runtime/goal-review-records.js';
import {
  createGoalRecord,
  createGoalTask,
  getGoalRecord,
  listGoalRecordsForThread,
  listGoalTasks,
  updateGoalStatus,
} from './runtime/goal-store.js';
import { createGoalVerificationRecord } from './runtime/goal-verification-records.js';
import type { TurnExecutor, TurnStartRuntimeContext } from './runtime/types.js';
import {
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import {
  getWorkerCheckpoint,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './runtime/worker-checkpoints.js';
import { recordWorkerControlAcceptedRecord } from './runtime/worker-control-records.js';
import {
  ensureConfiguredSchedulerBaseline,
  listSchedulerAdmissionEntriesForWorkspace,
  listSchedulerSessionLeasesForTurn,
  requireSchedulerSessionLease,
  upsertSchedulerCapacityRecord,
} from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { upsertWorkspaceRepositoryResource } from './workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const GOAL_TASK_EXECUTION_FIELDS = {
  planItemId: 'it_goal_plan_fixture',
  resources: [
    {
      kind: 'repository' as const,
      reference: 'linked workspace repository',
      reason: 'The approved Task uses the linked repository.',
    },
  ],
  expectedArtifacts: [
    {
      kind: 'artifact' as const,
      description: 'Worker result summary and implementation evidence.',
    },
  ],
  verificationChecks: [
    { kind: 'manual' as const, description: 'Review the worker output and evidence.' },
  ],
  reviewPolicy: {
    required: true,
    reviewers: ['human'] as ['human'],
    instructions: 'Review the worker result and verification evidence.',
  },
  escalationConditions: ['Escalate if the approved Task cannot be completed as specified.'],
};

/** Simulator variant that reaches its user-input Gate during the original worker attempt. */
class UserInputGateTurnExecutor extends SimulatedTurnExecutor {
  /**
   * Advances the deterministic simulator from its approval Gate to its user-input Gate.
   *
   * @param store Product store containing the worker Turn.
   * @param turnId Worker Turn id.
   * @param input Structured worker request bytes.
   * @param context Runtime command lineage.
   */
  public override async startTurn(
    store: Parameters<SimulatedTurnExecutor['startTurn']>[0],
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    await super.startTurn(store, turnId, input, context);
    const turn = store.getTurnById(turnId);
    if (turn.humanGate?.kind !== 'approval') {
      throw new Error('Simulator did not produce its approval Gate.');
    }
    await super.respondApproval(store, turn.humanGate.approvalRequestId, 'granted', context);
  }
}

/**
 * Opens a migrated Core database for thread goal summary route tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-goal-summary-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Seeds the default ready repository resource for local-mode Goal Mode tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @param repositoryPath Host-local repository path to link.
 */
function seedReadyRepository(coreDb: CoreDb, repositoryPath: string): void {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
  try {
    applyScopedMigrations(workspaceDb);
    upsertWorkspaceRepositoryResource(workspaceDb, {
      workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      workspaceId: 'ws_demo',
      displayName: 'Ready repository',
      localPath: repositoryPath,
      now: () => '2026-05-31T00:00:00.000Z',
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Opens a migrated workspace database for goal summary tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Posts one Goal start command through the public App API.
 *
 * @param app NanoCore app under test.
 * @param threadId Thread receiving the Goal.
 * @param body Goal start request body.
 * @param workspaceId Workspace receiving the Goal.
 * @returns Public App API response.
 */
function postGoalStart(
  app: ReturnType<typeof createApp>,
  threadId: string,
  body: Record<string, unknown>,
  workspaceId = 'ws_demo'
): Promise<Response> {
  return app.request(`/api/app/workspaces/${workspaceId}/threads/${threadId}/goal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Posts one identified Goal pause or resume command through the public App API.
 *
 * @param app NanoCore app under test.
 * @param threadId Thread receiving the lifecycle command.
 * @param command Goal lifecycle command path.
 * @param requestId Stable command request id.
 * @returns Public App API response.
 */
function postGoalLifecycle(
  app: ReturnType<typeof createApp>,
  threadId: string,
  command: 'pause' | 'resume',
  requestId: string
): Promise<Response> {
  return app.request(`/api/app/workspaces/ws_demo/threads/${threadId}/goal/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId }),
  });
}

/**
 * Seeds the exact non-terminal Turn and checkpoint pair owned by one active Goal.
 *
 * @param store App-local durable store.
 * @param workspaceDb Open workspace database.
 * @param threadId Thread that owns the worker Turn.
 * @param goalId Goal that owns the worker Turn.
 * @param turnId Stable worker Turn id.
 * @returns Seeded non-terminal Turn.
 */
function seedActiveGoalWorkerTurn(
  store: ReturnType<typeof createDemoStore>,
  workspaceDb: WorkspaceDb,
  threadId: string,
  goalId: string,
  turnId: string
) {
  const turn = store.createTurn('ws_demo', threadId, 'Continue the active Goal task.', null, {
    turnId,
  });
  const runningTurn = store.updateTurn(turn.id, { status: 'running' });
  upsertWorkerCheckpoint(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId,
    turnId,
    goalId,
    requestId: `req_${turnId}`,
    requestInputHash: `sha256:${turnId}`,
    stage: 'running_worker',
    iteration: 0,
  });

  return runningTurn;
}

/**
 * Creates a synchronous worker fixture that completes every started turn with artifact evidence.
 *
 * @param startContexts Optional collector for scheduler-owned start contexts.
 * @returns Turn executor suitable for repeated live Goal Mode steps.
 */
function createCompletingGoalTurnExecutor(
  startContexts: TurnStartRuntimeContext[] = []
): TurnExecutor {
  return {
    capabilities: {
      approvals: true,
      interrupts: true,
      artifacts: true,
      workspaceConfig: true,
      workspaceKnowledgeEditing: true,
      questions: true,
    },
    eventFamilies: [],
    async startTurn(workerStore, turnId, input, context = { requestId: null, workspaceRoots: [] }) {
      startContexts.push(context);
      const turn = workerStore.getTurnById(turnId);
      const timestamp = turn.startedAt ?? '2026-05-31T00:00:00.000Z';
      const agentSession = workerStore.createAgentSession({
        id: context.agentSessionId ?? `session_${turnId}`,
        agentId: turn.agentId!,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        status: 'busy',
        message: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      workerStore.updateTurn(turnId, { agentSessionId: agentSession.id });
      workerStore.createArtifact({
        id: `art_${turnId}`,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId,
        kind: 'summary',
        title: 'Worker result',
        status: 'ready',
        summary: 'Worker evidence ready.',
        version: 1,
        content: { format: 'markdown', body: input },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const completedTurn = workerStore.updateTurn(turnId, {
        status: 'completed',
        completedAt: timestamp,
        durationMs: 0,
      });
      workerStore.updateAgentSession(agentSession.id, { status: 'idle', updatedAt: timestamp });
      workerStore.emitTurnEvent(turnId, {
        event: 'turn.completed',
        requestId: null,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId,
        data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
      });
    },
  };
}

/**
 * Creates a worker fixture that persists a failed turn before rejecting startup.
 *
 * @param startContexts Optional collector for scheduler-owned start contexts.
 * @returns Turn executor that models a governed worker startup failure.
 */
function createFailingGoalTurnExecutor(
  startContexts: TurnStartRuntimeContext[] = []
): TurnExecutor {
  return {
    capabilities: {
      approvals: true,
      interrupts: true,
      artifacts: true,
      workspaceConfig: true,
      workspaceKnowledgeEditing: true,
      questions: true,
    },
    eventFamilies: [],
    async startTurn(
      workerStore,
      turnId,
      _input,
      context = { requestId: null, workspaceRoots: [] }
    ) {
      startContexts.push(context);
      const turn = workerStore.getTurnById(turnId);
      workerStore.updateTurn(turnId, {
        status: 'failed',
        error: { code: 'worker_start_failed', message: 'Worker start failed.' },
        completedAt: turn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      throw new Error('injected worker start failure');
    },
  };
}

/**
 * Lists permission decision rows for one action.
 *
 * @param workspaceDb Workspace database handle.
 * @param action Product action to filter.
 * @returns Matching permission decision rows.
 */
function listPermissionDecisionsForAction(
  workspaceDb: WorkspaceDb,
  action: string
): Array<{
  action: string;
  enforcement_point: string;
  reason_code: string;
  result: string;
}> {
  return workspaceDb.sqlite
    .prepare(
      `SELECT action, enforcement_point, reason_code, result
       FROM permission_decisions
       WHERE action = ?
       ORDER BY created_at, decision_id`
    )
    .all(action) as Array<{
    action: string;
    enforcement_point: string;
    reason_code: string;
    result: string;
  }>;
}

/**
 * Creates a signed-in Better Auth-compatible test double.
 *
 * @returns Better Auth stub that authenticates every request.
 */
function createSignedInAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({ user: { id: LOCAL_USER_ID } }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

describe('thread goal summary app API', () => {
  it('returns null when the thread has no goal', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'No goal thread');

    try {
      const app = createApp({ coreDb, store });
      const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ goal: null });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a planning goal with empty task counts', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Planning goal thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_planning',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Plan v0.0.6 release',
        objective: 'Prepare the release plan for user approval.',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const app = createApp({ coreDb, store });
      const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        goal: {
          goalId: 'goal_planning',
          workspaceId: 'ws_demo',
          threadId: thread.id,
          status: 'planning',
          title: 'Plan v0.0.6 release',
          objective: 'Prepare the release plan for user approval.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          terminalSummary: null,
          updatedAt: '2026-05-31T00:00:00.000Z',
        },
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('returns running task counts and terminal state for closed goals', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Running goal thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_running',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship v0.0.6',
        objective: 'Finish every release task.',
        status: 'running',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_running',
        taskId: 'task_done',
        title: 'Finish earlier task',
        objective: 'Close the completed task.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The completed task is recorded.'],
        contextBudgetTokens: 4000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        status: 'completed',
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_running',
        taskId: 'task_current',
        title: 'Build read model',
        objective: 'Expose the goal summary read model.',
        orderIndex: 1,
        dependsOnTaskIds: ['task_done'],
        acceptanceCriteria: ['The App API route returns the read model.'],
        contextBudgetTokens: 6000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        status: 'running',
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_running',
        taskId: 'task_next',
        title: 'Verify release',
        objective: 'Run the release verification.',
        orderIndex: 2,
        dependsOnTaskIds: ['task_current'],
        acceptanceCriteria: ['Release verification passes.'],
        contextBudgetTokens: 8000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        status: 'pending',
      });
      createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_final',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_running',
        taskId: 'task_done',
        status: 'passed',
        command: 'pnpm -w verify:release',
        summary: 'Release verification passed.',
        artifactIds: ['artifact_release_log'],
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_running',
        status: 'completed',
        currentTaskId: 'task_current',
        terminalStopReason: 'completed',
        now: () => '2026-05-31T00:20:00.000Z',
      });

      const app = createApp({ coreDb, store });
      const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        goal: {
          goalId: 'goal_running',
          status: 'completed',
          currentTask: {
            taskId: 'task_current',
            title: 'Build read model',
            status: 'running',
            orderIndex: 1,
          },
          taskCounts: {
            pending: 1,
            ready: 0,
            running: 1,
            reviewing: 0,
            completed: 1,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: {
            status: 'completed',
            stopReason: 'completed',
          },
          terminalSummary: {
            completedTaskIds: ['task_done'],
            blockedTaskIds: [],
            artifactIds: ['artifact_release_log'],
            verificationEvidence: [
              {
                verificationId: 'verify_final',
                status: 'passed',
                summary: 'Release verification passed.',
                command: 'pnpm -w verify:release',
                artifactIds: ['artifact_release_log'],
              },
            ],
            risks: ['2 required task is not accepted.'],
            suggestedNextWork: [],
          },
          updatedAt: '2026-05-31T00:20:00.000Z',
        },
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('starts and replays one request-owned planning goal', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Goal start thread');
    const request = {
      requestId: 'goal-start-1',
      objective: 'Make v0.0.6 ready to publish.',
      title: 'Ship v0.0.6',
    };

    try {
      const app = createApp({ coreDb, store });
      const missingRequestIdRes = await postGoalStart(app, thread.id, {
        objective: request.objective,
      });
      expect(missingRequestIdRes.status).toBe(400);
      await expect(missingRequestIdRes.json()).resolves.toMatchObject({ code: 'invalid_request' });
      const res = await postGoalStart(app, thread.id, request);

      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        goal: { goalId: string; updatedAt: string };
        objectiveItemId: string;
      };
      expect(payload).toMatchObject({
        goal: {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          status: 'planning',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
        },
      });
      const replayRes = await postGoalStart(app, thread.id, request);
      expect(replayRes.status).toBe(200);
      await expect(replayRes.json()).resolves.toEqual(payload);
      const conflictRes = await postGoalStart(app, thread.id, {
        ...request,
        objective: 'Replace the original objective.',
      });
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      const items = store.listThreadItems('ws_demo', thread.id);
      expect(items).toEqual([
        expect.objectContaining({
          id: payload.objectiveItemId,
          type: 'user-message',
          status: 'completed',
          causationId: request.requestId,
          text: 'Make v0.0.6 ready to publish.',
        }),
      ]);
      const workspaceDb = createWorkspaceDb(coreDb);
      try {
        expect(
          listGoalRecordsForThread(workspaceDb, { workspaceId: 'ws_demo', threadId: thread.id })
        ).toEqual([
          expect.objectContaining({
            goalId: payload.goal.goalId,
            status: 'planning',
            createdByItemId: payload.objectiveItemId,
          }),
        ]);
        expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(1);
        const receipt = store
          .listCommandRequests()
          .find((record) => record.requestId === request.requestId);
        expect(receipt).toMatchObject({
          command: 'goal.start',
          response: { id: payload.goal.goalId, kind: 'goal' },
        });
        expect(receipt?.response).not.toHaveProperty('snapshot');
        updateGoalStatus(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: payload.goal.goalId,
          status: 'completed',
          terminalStopReason: 'completed',
        });
      } finally {
        workspaceDb.sqlite.close();
      }
      const nextGoalRes = await postGoalStart(app, thread.id, {
        requestId: 'goal-start-2',
        objective: 'Start the next Goal.',
      });
      expect(nextGoalRes.status).toBe(200);
      const clarificationRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/chat`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'chat-after-goal-start', input: 'Help.' }),
        }
      );
      expect(clarificationRes.status).toBe(202);
      const historicalReplayRes = await postGoalStart(app, thread.id, request);
      expect(historicalReplayRes.status).toBe(200);
      await expect(historicalReplayRes.json()).resolves.toMatchObject({
        goal: {
          goalId: payload.goal.goalId,
          pendingHumanAttention: { required: false, reason: null },
        },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts the first goal in two workspaces without reusing the objective item identity', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const firstThread = store.createThread('ws_demo', 'First workspace goal');
    const secondWorkspace = store.createWorkspace('Second goal workspace');
    const secondThread = store.createThread(secondWorkspace.id, 'Second workspace goal');
    const app = createApp({ coreDb, store });

    try {
      const firstRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${firstThread.id}/goal`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-start-first-workspace',
            objective: 'Complete the first workspace goal.',
          }),
        }
      );
      const secondRes = await app.request(
        `/api/app/workspaces/${secondWorkspace.id}/threads/${secondThread.id}/goal`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-start-second-workspace',
            objective: 'Complete the second workspace goal.',
          }),
        }
      );

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      const first = (await firstRes.json()) as {
        goal: { goalId: string };
        objectiveItemId: string;
      };
      const second = (await secondRes.json()) as {
        goal: { goalId: string };
        objectiveItemId: string;
      };
      expect(first.goal.goalId).not.toBe(second.goal.goalId);
      expect(first.objectiveItemId).not.toBe(second.objectiveItemId);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects starting a second active goal in the same thread', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Duplicate goal thread');
    const app = createApp({ coreDb, store });

    try {
      const firstRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'goal-start-active-1',
          objective: 'Make v0.0.6 ready to publish.',
          title: 'Ship v0.0.6',
        }),
      });
      expect(firstRes.status).toBe(200);

      const secondRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'goal-start-active-2',
          objective: 'Start a competing active goal.',
          title: 'Competing goal',
        }),
      });

      expect(secondRes.status).toBe(409);
      await expect(secondRes.json()).resolves.toMatchObject({
        code: 'goal_already_active',
        message: 'Thread already has an active goal.',
      });
      const workspaceDb = createWorkspaceDb(coreDb);
      try {
        expect(
          listGoalRecordsForThread(workspaceDb, { workspaceId: 'ws_demo', threadId: thread.id })
        ).toHaveLength(1);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails Goal start closed when its receipt or owner tuple is incomplete', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const receiptGapThread = store.createThread('ws_demo', 'Goal start receipt gap');
    const partialOwnerThread = store.createThread('ws_demo', 'Goal start partial owner');
    const app = createApp({ coreDb, store });
    const receiptGapRequest = {
      requestId: 'goal-start-receipt-gap',
      objective: 'Recover this Goal start.',
    };

    try {
      const receiptWrite = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated Goal start receipt failure');
      });
      const receiptGapRes = await postGoalStart(app, receiptGapThread.id, receiptGapRequest);
      receiptWrite.mockRestore();
      expect(receiptGapRes.status).toBe(409);
      await expect(receiptGapRes.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const receiptGapCounts = {
        items: store.listThreadItems('ws_demo', receiptGapThread.id).length,
        turns: store.listThreadTurns('ws_demo', receiptGapThread.id).length,
      };
      const sameInputReplayRes = await postGoalStart(app, receiptGapThread.id, receiptGapRequest);
      expect(sameInputReplayRes.status).toBe(409);
      await expect(sameInputReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      const receiptGapReplayRes = await postGoalStart(app, receiptGapThread.id, {
        ...receiptGapRequest,
        title: receiptGapRequest.objective,
      });
      expect(receiptGapReplayRes.status).toBe(409);
      await expect(receiptGapReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect({
        items: store.listThreadItems('ws_demo', receiptGapThread.id).length,
        turns: store.listThreadTurns('ws_demo', receiptGapThread.id).length,
      }).toEqual(receiptGapCounts);
      expect(
        store
          .listCommandRequests()
          .find((record) => record.requestId === receiptGapRequest.requestId)
      ).toBeUndefined();

      const itemWrite = vi.spyOn(store, 'createItem').mockImplementationOnce(() => {
        throw new Error('simulated Goal start Item failure');
      });
      const partialRequest = {
        requestId: 'goal-start-partial-owner',
        objective: 'Do not replace this partial Goal start.',
      };
      const partialRes = await postGoalStart(app, partialOwnerThread.id, partialRequest);
      itemWrite.mockRestore();
      expect(partialRes.status).toBe(409);
      await expect(partialRes.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const partialReplayRes = await postGoalStart(app, partialOwnerThread.id, partialRequest);
      expect(partialReplayRes.status).toBe(409);
      await expect(partialReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect(store.listThreadTurns('ws_demo', partialOwnerThread.id)).toHaveLength(1);
      expect(store.listThreadItems('ws_demo', partialOwnerThread.id)).toEqual([]);
      const workspaceDb = createWorkspaceDb(coreDb);
      try {
        expect(
          listGoalRecordsForThread(workspaceDb, {
            workspaceId: 'ws_demo',
            threadId: receiptGapThread.id,
          })
        ).toHaveLength(1);
        expect(
          listGoalRecordsForThread(workspaceDb, {
            workspaceId: 'ws_demo',
            threadId: partialOwnerThread.id,
          })
        ).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
    }
  });

  it('fails Goal steering closed when the worker cannot prove delivery', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Unavailable steering delivery');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_running',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Goal without delivery proof',
        objective: 'Reject input until the real worker can receive it.',
        status: 'running',
      });
      seedActiveGoalWorkerTurn(store, workspaceDb, thread.id, 'goal_running', 'turn_goal_running');

      const app = createApp({ coreDb, store });
      const response = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/steering`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'req_unavailable',
            message: 'Do not acknowledge input that the worker cannot receive.',
          }),
        }
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: 'goal_steering_delivery_unavailable',
      });
      expect(store.listThreadItems('ws_demo', thread.id)).toEqual([]);
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('creates a deterministic plan and persists approved goal tasks through app routes', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Goal planning thread');
    const app = createApp({ coreDb, store });

    try {
      const startRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'goal-start-planning-1',
          objective: 'Make v0.0.6 ready to publish.',
          title: 'Ship v0.0.6',
        }),
      });

      expect(startRes.status).toBe(200);

      const pauseBeforeApprovalRes = await postGoalLifecycle(
        app,
        thread.id,
        'pause',
        'goal-pause-before-approval'
      );

      expect(pauseBeforeApprovalRes.status).toBe(409);
      await expect(pauseBeforeApprovalRes.json()).resolves.toMatchObject({
        code: 'goal_not_running',
      });

      const missingRequestPlanRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(missingRequestPlanRes.status).toBe(400);
      await expect(missingRequestPlanRes.json()).resolves.toMatchObject({
        code: 'invalid_request',
      });

      const planReceiptSpy = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated plan receipt write failure');
      });
      const failedPlanRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-create-1' }),
        }
      );
      planReceiptSpy.mockRestore();

      expect(failedPlanRes.status).toBe(409);
      await expect(failedPlanRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      const committedPlanOwners = {
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      };
      expect(
        store.getCommandRequest('goal.plan', 'goal-plan-create-1', {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        })
      ).toBeNull();

      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-create-1' }),
        }
      );
      const planPayload = (await planRes.json()) as {
        status: string;
        goal: { goalId: string; status: string; taskCounts: { ready: number } };
        planItemId: string;
        planner: { plan: unknown };
        plan: {
          tasks: readonly [
            { taskId: string; title: string; verificationChecks: readonly unknown[] },
          ];
        };
      };

      expect(planRes.status).toBe(200);
      expect(planPayload).toMatchObject({
        status: 'awaiting_plan_approval',
        goal: {
          status: 'awaiting_plan_approval',
          taskCounts: { ready: 0 },
          pendingHumanAttention: {
            required: true,
            reason: 'Goal plan needs approval.',
          },
        },
        planner: {
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          requiredApprovals: ['plan_approval'],
          contextRefs: expect.arrayContaining([
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: thread.id },
          ]),
        },
        plan: {
          tasks: [
            {
              taskId: 'task_1',
              title: 'Ship v0.0.6',
            },
          ],
        },
      });
      expect(planPayload.planner.plan).toEqual(planPayload.plan);
      expect(
        store.getCommandRequest('goal.plan', 'goal-plan-create-1', {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        })?.response
      ).toEqual({ kind: 'goal_plan', id: planPayload.planItemId });

      const replayedPlanRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-create-1' }),
        }
      );
      expect(replayedPlanRes.status).toBe(200);
      await expect(replayedPlanRes.json()).resolves.toEqual(planPayload);
      expect({
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      }).toEqual(committedPlanOwners);

      const retiredPlanApproveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-retired-input-1',
            planItemId: planPayload.planItemId,
            plan: planPayload.plan,
          }),
        }
      );

      expect(retiredPlanApproveRes.status).toBe(400);
      await expect(retiredPlanApproveRes.json()).resolves.toMatchObject({
        code: 'invalid_request',
      });

      const mismatchedApproveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-mismatch-1',
            planItemId: 'it_goal_plan_other',
          }),
        }
      );

      expect(mismatchedApproveRes.status).toBe(409);
      await expect(mismatchedApproveRes.json()).resolves.toMatchObject({
        code: 'stale',
      });

      const approveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-approve-1',
            planItemId: planPayload.planItemId,
          }),
        }
      );

      expect(approveRes.status).toBe(200);
      const approvedPayload = await approveRes.json();
      expect(approvedPayload).toMatchObject({
        goal: {
          goalId: planPayload.goal.goalId,
          status: 'running',
          taskCounts: {
            ready: 1,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
        },
        readyTasks: [{ taskId: 'task_1', status: 'ready' }],
        startsWorkerTurn: false,
      });
      const replayedApproveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-approve-1',
            planItemId: planPayload.planItemId,
          }),
        }
      );

      expect(replayedApproveRes.status).toBe(200);
      await expect(replayedApproveRes.json()).resolves.toEqual(approvedPayload);

      const conflictingApproveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-approve-1',
            planItemId: 'it_goal_plan_other',
          }),
        }
      );

      expect(conflictingApproveRes.status).toBe(409);
      await expect(conflictingApproveRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      const unownedReplayRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-approve-2',
            planItemId: planPayload.planItemId,
          }),
        }
      );

      expect(unownedReplayRes.status).toBe(409);
      await expect(unownedReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });

      const failedPauseReceipt = vi
        .spyOn(store, 'recordCommandRequest')
        .mockImplementationOnce(() => {
          throw new Error('simulated atomic pause receipt failure');
        });
      const failedPauseRes = await postGoalLifecycle(
        app,
        thread.id,
        'pause',
        'goal-pause-rollback'
      );
      failedPauseReceipt.mockRestore();

      expect(failedPauseRes.status).toBe(400);
      await expect(failedPauseRes.json()).resolves.toMatchObject({ code: 'goal_pause_failed' });
      const boundaryDb = createWorkspaceDb(coreDb);
      try {
        expect(
          store.getCommandRequest(
            'goal.pause',
            'goal-pause-rollback',
            { workspaceId: 'ws_demo', threadId: thread.id },
            boundaryDb
          )
        ).toBeNull();
        expect(
          listGoalRecordsForThread(boundaryDb, {
            workspaceId: 'ws_demo',
            threadId: thread.id,
          }).at(-1)?.status
        ).toBe('running');
        const pendingTurn = store.createTurn(
          'ws_demo',
          thread.id,
          'Pending Goal worker admission.'
        );
        store.updateTurn(pendingTurn.id, { status: 'pending' });
        const pendingPauseRes = await postGoalLifecycle(
          app,
          thread.id,
          'pause',
          'goal-pause-pending-turn'
        );
        expect(pendingPauseRes.status).toBe(409);
        await expect(pendingPauseRes.json()).resolves.toMatchObject({
          code: 'goal_pause_active_turn',
        });

        updateGoalStatus(boundaryDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: planPayload.goal.goalId,
          status: 'paused',
        });
        const pendingResumeRes = await postGoalLifecycle(
          app,
          thread.id,
          'resume',
          'goal-resume-pending-turn'
        );
        expect(pendingResumeRes.status).toBe(409);
        await expect(pendingResumeRes.json()).resolves.toMatchObject({
          code: 'goal_resume_active_turn',
        });
        store.updateTurn(pendingTurn.id, { status: 'cancelled' });

        updateGoalStatus(boundaryDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: planPayload.goal.goalId,
          status: 'running',
          currentTaskId: 'task_1',
        });
        const contradictoryPauseRes = await postGoalLifecycle(
          app,
          thread.id,
          'pause',
          'goal-pause-contradictory'
        );
        expect(contradictoryPauseRes.status).toBe(409);
        await expect(contradictoryPauseRes.json()).resolves.toMatchObject({
          code: 'recovery_required',
        });
        updateGoalStatus(boundaryDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: planPayload.goal.goalId,
          status: 'running',
          currentTaskId: null,
        });
      } finally {
        boundaryDb.sqlite.close();
      }

      const pauseRes = await postGoalLifecycle(app, thread.id, 'pause', 'goal-pause-1');

      expect(pauseRes.status).toBe(200);
      const pausePayload = await pauseRes.json();
      expect(pausePayload).toMatchObject({
        outcome: 'paused',
        goal: {
          goalId: planPayload.goal.goalId,
          status: 'paused',
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
        },
      });
      const receiptDb = createWorkspaceDb(coreDb);
      try {
        expect(
          store.getCommandRequest(
            'goal.pause',
            'goal-pause-1',
            { workspaceId: 'ws_demo', threadId: thread.id },
            receiptDb
          )?.response
        ).toEqual({ kind: 'goal', id: planPayload.goal.goalId });
      } finally {
        receiptDb.sqlite.close();
      }

      const pausedStepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'step-while-paused' }),
        }
      );

      expect(pausedStepRes.status).toBe(409);
      await expect(pausedStepRes.json()).resolves.toMatchObject({
        code: 'goal_paused',
      });

      const resumeRes = await postGoalLifecycle(app, thread.id, 'resume', 'goal-resume-1');

      expect(resumeRes.status).toBe(200);
      await expect(resumeRes.json()).resolves.toMatchObject({
        outcome: 'resumed',
        goal: {
          goalId: planPayload.goal.goalId,
          status: 'running',
          taskCounts: {
            ready: 1,
          },
        },
      });

      const historicalPauseReplayRes = await postGoalLifecycle(
        app,
        thread.id,
        'pause',
        'goal-pause-1'
      );
      expect(historicalPauseReplayRes.status).toBe(200);
      await expect(historicalPauseReplayRes.json()).resolves.toMatchObject({
        outcome: 'paused',
        goal: { goalId: planPayload.goal.goalId, status: 'running' },
      });

      const secondPauseRes = await postGoalLifecycle(app, thread.id, 'pause', 'goal-pause-2');
      expect(secondPauseRes.status).toBe(200);
      await expect(secondPauseRes.json()).resolves.toMatchObject({
        outcome: 'paused',
        goal: { status: 'paused' },
      });

      const historicalResumeReplayRes = await postGoalLifecycle(
        app,
        thread.id,
        'resume',
        'goal-resume-1'
      );
      expect(historicalResumeReplayRes.status).toBe(200);
      await expect(historicalResumeReplayRes.json()).resolves.toMatchObject({
        outcome: 'resumed',
        goal: { goalId: planPayload.goal.goalId, status: 'paused' },
      });

      const secondResumeRes = await postGoalLifecycle(app, thread.id, 'resume', 'goal-resume-2');
      expect(secondResumeRes.status).toBe(200);
      await expect(secondResumeRes.json()).resolves.toMatchObject({
        outcome: 'resumed',
        goal: { status: 'running' },
      });
      const workspaceDb = createWorkspaceDb(coreDb);
      try {
        expect(
          listGoalTasks(workspaceDb, {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            goalId: planPayload.goal.goalId,
          })
        ).toEqual([
          expect.objectContaining({
            taskId: 'task_1',
            title: 'Ship v0.0.6',
            status: 'ready',
            verificationChecks: planPayload.plan.tasks[0].verificationChecks,
          }),
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }

      const superviseRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/test/supervise/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(superviseRes.status).toBe(200);
      await expect(superviseRes.json()).resolves.toMatchObject({
        goal: {
          goalId: planPayload.goal.goalId,
          status: 'completed',
          taskCounts: {
            completed: 1,
            ready: 0,
          },
          terminalState: {
            status: 'completed',
            stopReason: 'completed',
          },
        },
        task: {
          taskId: 'task_1',
          status: 'completed',
        },
        worker: {
          stopReason: 'completed',
          checkpointStage: 'completed',
        },
        review: {
          reviewId: `review_${planPayload.goal.goalId}_task_1`,
          verdict: 'accept',
        },
        advance: {
          outcome: 'complete_goal',
          nextReadyTaskId: null,
        },
      });
      const permissionDb = createWorkspaceDb(coreDb);
      try {
        const workerTurnId = store.listThreadTurns('ws_demo', thread.id).at(-1)?.id;

        expect(workerTurnId).toBeDefined();
        expect(
          getWorkerCheckpoint(permissionDb, 'ws_demo', thread.id, workerTurnId!)
        ).toMatchObject({
          workerSessionId: null,
        });
        expect(
          listGoalReviewRecordsForTask(permissionDb, {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            goalId: planPayload.goal.goalId,
            taskId: 'task_1',
          })
        ).toEqual([
          expect.objectContaining({
            prompt: 'Review the deterministic worker evidence.',
            createdByRequestId: `goal-test-supervise:${planPayload.goal.goalId}:task_1`,
            verdict: 'accept',
            reason: null,
            revisionInstruction: null,
            resolutionRequestId: `goal-test-supervise:${planPayload.goal.goalId}:task_1`,
            resolvedByActorId: 'user_local',
            resolutionSnapshot: {
              outcome: 'complete_goal',
              task: { taskId: 'task_1', status: 'completed' },
              goal: {
                goalId: planPayload.goal.goalId,
                status: 'completed',
                currentTaskId: null,
                terminalStopReason: 'completed',
              },
              nextReadyTaskId: null,
            },
          }),
        ]);
        expect(listPermissionDecisionsForAction(permissionDb, 'runtime.launch')).toContainEqual({
          action: 'runtime.launch',
          enforcement_point: 'goal.test.supervise.worker_start',
          reason_code: 'goal_worker_start_allowed',
          result: 'allow',
        });
      } finally {
        permissionDb.sqlite.close();
      }

      const terminalHalfStateRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-approve-after-terminal',
            planItemId: planPayload.planItemId,
          }),
        }
      );

      expect(terminalHalfStateRes.status).toBe(409);
      await expect(terminalHalfStateRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });

      const nextGoalRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-start-next-release',
            objective: 'Prepare the next release.',
          }),
        }
      );
      expect(nextGoalRes.status).toBe(200);

      const supersededHalfStateRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-approve-after-superseded',
            planItemId: planPayload.planItemId,
          }),
        }
      );

      expect(supersededHalfStateRes.status).toBe(409);
      await expect(supersededHalfStateRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('hides the deterministic supervise route outside local mode', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Server supervise route thread');

    try {
      ensureLocalUser(coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: LOCAL_USER_ID,
        workspaceId: 'ws_demo',
      });
      const app = createApp({
        auth: createSignedInAuthStub(),
        coreDb,
        mode: 'server',
        store,
      });
      const res = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/test/supervise/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(res.status).toBe(404);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('replays Goal Plan revisions and fails closed on incomplete command ownership', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Goal plan revision thread');
    const app = createApp({ coreDb, store });

    try {
      await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'goal-start-revision-1',
          objective: 'Make v0.0.7 ready to publish.',
          title: 'Ship v0.0.7',
        }),
      });

      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-revision-create-1' }),
        }
      );
      const planPayload = (await planRes.json()) as {
        goal: { goalId: string; status: string };
        planItemId: string;
      };

      expect(planRes.status).toBe(200);
      expect(planPayload.goal.status).toBe('awaiting_plan_approval');

      const missingRevisionRequestRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            revision: 'This mutation has no request identity.',
          }),
        }
      );

      expect(missingRevisionRequestRes.status).toBe(400);
      await expect(missingRevisionRequestRes.json()).resolves.toMatchObject({
        code: 'invalid_request',
      });

      const revisionRequest = {
        requestId: '00000000-0000-4000-8000-000000000302',
        revision: 'Split documentation and verification into separate review gates.',
      };
      const reviseRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(revisionRequest),
        }
      );
      const revisePayload = (await reviseRes.json()) as {
        goal: { goalId: string; status: string };
        revisionItemId: string;
        startsWorkerTurn: boolean;
      };

      expect(reviseRes.status).toBe(200);
      expect(revisePayload).toMatchObject({
        goal: {
          goalId: planPayload.goal.goalId,
          status: 'planning',
        },
        revisionItemId: expect.stringMatching(/^it_goal_plan_revision_/),
        startsWorkerTurn: false,
      });
      const revisionItem = store
        .listThreadItems('ws_demo', thread.id)
        .find((item) => item.id === revisePayload.revisionItemId);
      expect(revisionItem).toMatchObject({
        causationId: revisionRequest.requestId,
        parentItemId: planPayload.planItemId,
        status: 'completed',
        text: revisionRequest.revision,
        type: 'user-message',
      });
      expect(store.getTurn('ws_demo', thread.id, revisionItem?.turnId ?? 'missing')).toMatchObject({
        status: 'completed',
      });
      const revisionCounts = {
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      };
      const revisionReceipt = store
        .listCommandRequests()
        .find((record) => record.requestId === revisionRequest.requestId);
      expect(revisionReceipt).toMatchObject({
        command: 'goal.plan.revise',
        response: {
          id: planPayload.goal.goalId,
          kind: 'goal',
        },
      });
      expect(revisionReceipt?.response).not.toHaveProperty('snapshot');

      const replayRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(revisionRequest),
        }
      );
      expect(replayRes.status).toBe(200);
      await expect(replayRes.json()).resolves.toEqual(revisePayload);
      expect({
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      }).toEqual(revisionCounts);

      const conflictRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...revisionRequest,
            revision: 'Reuse the request identity with different input.',
          }),
        }
      );
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect({
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      }).toEqual(revisionCounts);

      const staleApproveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'goal-plan-revision-stale-1',
            planItemId: planPayload.planItemId,
          }),
        }
      );

      expect(staleApproveRes.status).toBe(409);
      await expect(staleApproveRes.json()).resolves.toMatchObject({
        code: 'stale',
      });

      const revisedPlanRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-revision-create-2' }),
        }
      );
      expect(revisedPlanRes.status).toBe(200);

      const receiptGapRequest = {
        requestId: '00000000-0000-4000-8000-000000000303',
        revision: 'Recover the original revision owners when receipt publication fails.',
      };
      const receiptWriteSpy = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated revision receipt write failure');
      });
      const receiptGapRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(receiptGapRequest),
        }
      );
      receiptWriteSpy.mockRestore();
      expect(receiptGapRes.status).toBe(409);
      await expect(receiptGapRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      const receiptGapCounts = {
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      };
      const receiptGapReplayRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(receiptGapRequest),
        }
      );
      expect(receiptGapReplayRes.status).toBe(409);
      await expect(receiptGapReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect({
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      }).toEqual(receiptGapCounts);
      expect(
        store
          .listCommandRequests()
          .find((record) => record.requestId === receiptGapRequest.requestId)
      ).toBeUndefined();
      const thirdPlanRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'goal-plan-revision-create-3' }),
        }
      );
      expect(thirdPlanRes.status).toBe(200);
      const partialOwnerCounts = {
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      };
      const partialRequest = {
        requestId: '00000000-0000-4000-8000-000000000304',
        revision: 'Leave a Turn-only revision owner tuple.',
      };
      const createItemSpy = vi.spyOn(store, 'createItem').mockImplementationOnce(() => {
        throw new Error('simulated revision Item write failure');
      });
      const partialRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(partialRequest),
        }
      );
      createItemSpy.mockRestore();
      expect(partialRes.status).toBe(409);
      await expect(partialRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      const failedOwnerCounts = {
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      };
      expect(failedOwnerCounts).toEqual({
        items: partialOwnerCounts.items,
        turns: partialOwnerCounts.turns + 1,
      });

      const partialReplayRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(partialRequest),
        }
      );
      expect(partialReplayRes.status).toBe(409);
      await expect(partialReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect({
        items: store.listThreadItems('ws_demo', thread.id).length,
        turns: store.listThreadTurns('ws_demo', thread.id).length,
      }).toEqual(failedOwnerCounts);
      expect(
        store.listCommandRequests().find((record) => record.requestId === partialRequest.requestId)
      ).toBeUndefined();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('runs one real Goal Mode step through the worker envelope', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Real goal step thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-real-goal-step-repo-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedReadyRepository(coreDb, repositoryPath);
      const contextTurn = store.createTurn('ws_demo', thread.id, 'Provide context');
      store.createItem({
        id: `it_context_${thread.id}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: contextTurn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Use the linked repository and produce evidence.',
        createdAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
      });
      store.updateTurn(contextTurn.id, {
        status: 'completed',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_real_step',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Run real step',
        objective: 'Run one bounded worker step.',
        status: 'running',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_real_step',
        status: 'running',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_real_step',
        taskId: 'task_real_step',
        title: 'Produce worker evidence',
        objective: 'Produce worker evidence for the goal.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Worker evidence is recorded.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review worker evidence.' }],
        status: 'ready',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const startContexts: TurnStartRuntimeContext[] = [];
      const turnExecutor = createCompletingGoalTurnExecutor(startContexts);
      const app = createApp({ coreDb, store, turnExecutor });
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER fail_goal_launch_checkpoint
        BEFORE INSERT ON worker_turn_checkpoints
        BEGIN
          SELECT RAISE(ABORT, 'injected Goal launch checkpoint failure');
        END;
      `);
      const fencedStepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_step' }),
        }
      );
      expect(fencedStepRes.status).toBe(400);
      await expect(fencedStepRes.json()).resolves.toMatchObject({ code: 'goal_step_failed' });
      expect(startContexts).toEqual([]);
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_real_step')).toMatchObject({
        currentTaskId: null,
        status: 'running',
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_real_step',
        })
      ).toEqual([expect.objectContaining({ taskId: 'task_real_step', status: 'ready' })]);
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_turn_checkpoints').get()
      ).toEqual({ count: 0 });
      workspaceDb.sqlite.exec('DROP TRIGGER fail_goal_launch_checkpoint');
      const receiptWrite = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated Goal receipt write failure');
      });
      const interruptedStepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_step' }),
        }
      );
      receiptWrite.mockRestore();

      expect(interruptedStepRes.status).toBe(409);
      await expect(interruptedStepRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      const workerTurnId = store.listThreadTurns('ws_demo', thread.id).at(-1)?.id;
      expect(workerTurnId).toBeDefined();
      const workerTurn = store.getTurn('ws_demo', thread.id, workerTurnId!);
      expect(workerTurn.agentSessionId).not.toBeNull();
      updateWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: workerTurnId!,
        workerSessionId: workerTurn.agentSessionId,
      });
      const checkpoint = getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, workerTurnId!);
      expect(checkpoint).not.toBeNull();
      await expect(
        classifyGoalStepCheckpointAfterSchedulerRecovery({
          coreDb,
          store,
          workspaceDb,
          checkpoint: checkpoint!,
        })
      ).resolves.toBe('complete');

      const stepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_step' }),
        }
      );

      expect(stepRes.status).toBe(200);
      const stepPayload = await stepRes.json();
      expect(stepPayload).toMatchObject({
        goal: {
          goalId: 'goal_real_step',
          status: 'reviewing',
          currentTask: {
            taskId: 'task_real_step',
            status: 'reviewing',
          },
          pendingHumanAttention: {
            required: true,
            reason: 'Worker result needs review.',
          },
        },
      });
      expect(stepPayload).not.toHaveProperty('result');
      expect(startContexts).toEqual([
        expect.objectContaining({
          agentSessionId: expect.any(String),
          requestId: 'req_goal_step',
          sandboxBindingRef: expect.stringMatching(/^lease-binding:/),
        }),
      ]);
      const sandboxBindingRef = startContexts[0]!.sandboxBindingRef!;
      const lease = requireSchedulerSessionLease(
        coreDb,
        sandboxBindingRef.slice('lease-binding:'.length)
      );
      const admissions = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        userId: LOCAL_USER_ID,
        workspaceId: 'ws_demo',
        statuses: ['admitted'],
      });
      expect(lease).toMatchObject({
        sandboxBindingRef,
        status: 'released',
        releaseReason: 'turn-completed',
        turnId: workerTurnId,
      });
      expect(admissions).toEqual([
        expect.objectContaining({
          requestedAgentId: 'agent_codex_host',
          turnId: workerTurnId,
        }),
      ]);
      const unresolvedReviews = listGoalReviewRecordsForTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_real_step',
        taskId: 'task_real_step',
      }).filter((review) => review.resolvedAt === null);

      expect(unresolvedReviews).toHaveLength(1);
      const review = unresolvedReviews[0]!;
      expect(review).toMatchObject({
        prompt: 'Review the completed worker output before Goal Mode continues.',
        createdByRequestId: 'req_goal_step',
        verdict: null,
        reason: null,
        revisionInstruction: null,
        turnId: workerTurnId,
        artifactIds: expect.arrayContaining([expect.stringMatching(/^art_/)]),
        resolvedAt: null,
        resolutionRequestId: null,
        resolvedByActorId: null,
        resolutionSnapshot: null,
      });
      const firstWorkerRequest = StructuredWorkerDelegationRequestSchema.parse(
        JSON.parse(store.getArtifact('ws_demo', `art_${workerTurnId}`).content.body)
      );
      expect(firstWorkerRequest).toEqual({
        schemaVersion: 1,
        objective: 'Produce worker evidence for the goal.',
        acceptanceCriteria: ['Worker evidence is recorded.'],
        contextRefs: [
          { kind: 'workspace', id: 'ws_demo' },
          { kind: 'thread', id: thread.id },
          { kind: 'item', id: `it_context_${thread.id}` },
        ],
        resources: GOAL_TASK_EXECUTION_FIELDS.resources,
        expectedArtifacts: [
          { kind: 'artifact', description: 'Worker result summary and implementation evidence.' },
        ],
        constraints: { maxContextTokens: 12_000, maxWorkerIterations: 1 },
        verification: [{ kind: 'manual', description: 'Review worker evidence.' }],
        reviewPolicy: GOAL_TASK_EXECUTION_FIELDS.reviewPolicy,
        escalationConditions: GOAL_TASK_EXECUTION_FIELDS.escalationConditions,
        reviewContext: null,
      });

      const attentionRes = await app.request('/api/app/workspaces/ws_demo/action-center');
      expect(attentionRes.status).toBe(200);
      await expect(attentionRes.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            source: {
              type: 'goal_review',
              reviewId: review.reviewId,
              goalId: 'goal_real_step',
              taskId: 'task_real_step',
              workspaceId: 'ws_demo',
              threadId: thread.id,
            },
            actions: [
              expect.objectContaining({ kind: 'accept_review' }),
              expect.objectContaining({ kind: 'request_refinement' }),
              expect.objectContaining({ kind: 'retry_work' }),
              expect.objectContaining({ kind: 'abort' }),
            ],
          }),
        ]),
      });

      const replayRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_step' }),
        }
      );
      expect(replayRes.status).toBe(200);
      const replayPayload = (await replayRes.json()) as typeof stepPayload;
      expect(replayPayload.goal).toEqual(stepPayload.goal);
      expect(replayPayload).not.toHaveProperty('result');
      expect(startContexts).toHaveLength(1);
      const stepReceipt = store.getCommandRequest(
        'goal.step',
        'req_goal_step',
        { workspaceId: 'ws_demo', threadId: thread.id },
        workspaceDb
      );
      expect(stepReceipt).toMatchObject({
        command: 'goal.step',
        response: {
          kind: 'goal',
          id: 'goal_real_step',
        },
      });

      const repeatedStepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_step_while_reviewing' }),
        }
      );

      expect(repeatedStepRes.status).toBe(409);
      await expect(repeatedStepRes.json()).resolves.toMatchObject({ code: 'goal_not_running' });
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_real_step',
          taskId: 'task_real_step',
        }).filter((candidate) => candidate.resolvedAt === null)
      ).toHaveLength(1);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, workerTurnId!)).toBeNull();

      const refineRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goals/goal_real_step/reviews/${review.reviewId}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'req_goal_review_refine',
            verdict: 'refine',
            revisionInstruction: 'Add the missing restart evidence.',
          }),
        }
      );
      expect(refineRes.status).toBe(200);
      const resolvedReview = listGoalReviewRecordsForTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_real_step',
        taskId: 'task_real_step',
      }).find((candidate) => candidate.reviewId === review.reviewId)!;
      const priorTurn = structuredClone(store.getTurn('ws_demo', thread.id, workerTurnId!));

      const refinedStepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_refined_step' }),
        }
      );
      expect(refinedStepRes.status).toBe(200);
      const refinedStep = (await refinedStepRes.json()) as typeof stepPayload;
      expect(refinedStep).not.toHaveProperty('result');
      const refinedWorkerTurnId = store.listThreadTurns('ws_demo', thread.id).at(-1)?.id;
      expect(refinedWorkerTurnId).toBeDefined();
      expect(refinedWorkerTurnId).not.toBe(workerTurnId);
      expect(store.getTurn('ws_demo', thread.id, workerTurnId!)).toEqual(priorTurn);
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_real_step',
          taskId: 'task_real_step',
        }).find((candidate) => candidate.reviewId === review.reviewId)
      ).toEqual(resolvedReview);
      const refinedWorkerRequest = StructuredWorkerDelegationRequestSchema.parse(
        JSON.parse(store.getArtifact('ws_demo', `art_${refinedWorkerTurnId}`).content.body)
      );
      expect(refinedWorkerRequest).toMatchObject({
        objective: 'Produce worker evidence for the goal.',
        acceptanceCriteria: ['Worker evidence is recorded.'],
        expectedArtifacts: [
          { kind: 'artifact', description: 'Worker result summary and implementation evidence.' },
        ],
        verification: [{ kind: 'manual', description: 'Review worker evidence.' }],
        reviewContext: {
          reviewId: review.reviewId,
          verdict: 'refine',
          reason: null,
          revisionInstruction: 'Add the missing restart evidence.',
          priorTurnId: workerTurnId,
          evidence: {
            itemIds: review.itemIds,
            artifactIds: review.artifactIds,
          },
        },
      });
      const refinementReview = listGoalReviewRecordsForTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_real_step',
        taskId: 'task_real_step',
      }).find((candidate) => candidate.resolvedAt === null)!;
      const retryRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goals/goal_real_step/reviews/${refinementReview.reviewId}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'req_goal_review_retry',
            verdict: 'retry',
            reason: 'The refined verification did not complete.',
          }),
        }
      );
      expect(retryRes.status).toBe(200);

      const retriedStepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_retried_step' }),
        }
      );
      expect(retriedStepRes.status).toBe(200);
      const retriedStep = (await retriedStepRes.json()) as typeof stepPayload;
      expect(retriedStep).not.toHaveProperty('result');
      const retriedWorkerTurnId = store.listThreadTurns('ws_demo', thread.id).at(-1)?.id;
      expect(retriedWorkerTurnId).toBeDefined();
      expect(retriedWorkerTurnId).not.toBe(refinedWorkerTurnId);
      const retriedWorkerRequest = StructuredWorkerDelegationRequestSchema.parse(
        JSON.parse(store.getArtifact('ws_demo', `art_${retriedWorkerTurnId}`).content.body)
      );
      expect(retriedWorkerRequest.reviewContext).toEqual({
        reviewId: refinementReview.reviewId,
        verdict: 'retry',
        reason: 'The refined verification did not complete.',
        revisionInstruction: null,
        priorTurnId: refinedWorkerTurnId,
        evidence: {
          itemIds: refinementReview.itemIds,
          artifactIds: refinementReview.artifactIds,
        },
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('preserves the Goal launch tuple and releases scheduler capacity when worker startup fails', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Failing goal step thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-failing-goal-step-repo-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedReadyRepository(coreDb, repositoryPath);
      const contextTurn = store.createTurn('ws_demo', thread.id, 'Provide failure context');
      store.createItem({
        id: `it_context_${thread.id}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: contextTurn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Start the worker and preserve failure evidence.',
        createdAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
      });
      store.updateTurn(contextTurn.id, {
        status: 'completed',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_failing_step',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Fail one worker step',
        objective: 'Preserve terminal state when worker startup fails.',
        status: 'running',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_failing_step',
        status: 'running',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_failing_step',
        taskId: 'task_failing_step',
        title: 'Start the failing worker',
        objective: 'Start one worker that fails during startup.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Failure state is durable.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review failure state.' }],
        status: 'ready',
      });

      const startContexts: TurnStartRuntimeContext[] = [];
      const app = createApp({
        coreDb,
        store,
        turnExecutor: createFailingGoalTurnExecutor(startContexts),
      });
      const stepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_failing_step' }),
        }
      );

      expect(stepRes.status).toBe(409);
      await expect(stepRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(
        listGoalRecordsForThread(workspaceDb, { workspaceId: 'ws_demo', threadId: thread.id })
      ).toEqual([
        expect.objectContaining({
          goalId: 'goal_failing_step',
          status: 'running',
          currentTaskId: 'task_failing_step',
          terminalStopReason: null,
        }),
      ]);
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_failing_step',
        })
      ).toEqual([expect.objectContaining({ taskId: 'task_failing_step', status: 'running' })]);

      const admission = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        userId: LOCAL_USER_ID,
        workspaceId: 'ws_demo',
        statuses: ['admitted'],
      })[0]!;
      const sandboxBindingRef = startContexts[0]!.sandboxBindingRef!;
      const lease = requireSchedulerSessionLease(
        coreDb,
        sandboxBindingRef.slice('lease-binding:'.length)
      );

      expect(lease).toMatchObject({
        status: 'failed',
        releaseReason: 'turn-start-failed',
        recoveryState: 'needs-evidence',
        turnId: admission.turnId,
      });
      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, admission.turnId)
      ).toMatchObject({
        requestId: 'req_goal_failing_step',
        requestInputHash: expect.stringMatching(/^sha256:/),
        stage: 'failed',
        stopReason: 'error',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT in_use_count AS inUseCount
             FROM scheduler_capacity_records
             WHERE target_id = 'target_local'`
          )
          .get()
      ).toEqual({ inUseCount: 0 });

      const failedTurnCount = store.listThreadTurns('ws_demo', thread.id).length;
      const retryRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_failing_step' }),
        }
      );
      expect(retryRes.status).toBe(409);
      await expect(retryRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(startContexts).toHaveLength(1);
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(failedTurnCount);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          userId: LOCAL_USER_ID,
          workspaceId: 'ws_demo',
          statuses: ['admitted'],
        })
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('cancels a deferred Goal admission instead of leaving a background worker launch', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Deferred goal step thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-deferred-goal-step-repo-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedReadyRepository(coreDb, repositoryPath);
      const contextTurn = store.createTurn('ws_demo', thread.id, 'Provide deferred context');
      store.createItem({
        id: `it_context_${thread.id}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: contextTurn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Do not launch this worker after the synchronous step fails.',
        createdAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
      });
      store.updateTurn(contextTurn.id, {
        status: 'completed',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_deferred_step',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Defer one worker step',
        objective: 'Cancel a worker admission that cannot dispatch immediately.',
        status: 'running',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_deferred_step',
        status: 'running',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_deferred_step',
        taskId: 'task_deferred_step',
        title: 'Attempt a saturated worker',
        objective: 'Attempt one worker while scheduler capacity is saturated.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['No queued worker remains.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review scheduler state.' }],
        status: 'ready',
      });
      ensureConfiguredSchedulerBaseline(coreDb, { placement: 'local' });
      upsertSchedulerCapacityRecord(coreDb, {
        targetId: 'target_local',
        poolId: 'pool_local',
        capacityClass: 'local',
        concurrencyCeiling: 2,
        inUseCount: 2,
        queueDepth: 0,
        observationSource: 'configured',
        observedAt: '2026-05-31T00:00:00.000Z',
      });

      const startContexts: TurnStartRuntimeContext[] = [];
      const app = createApp({
        coreDb,
        store,
        turnExecutor: createCompletingGoalTurnExecutor(startContexts),
      });
      const stepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_deferred_step' }),
        }
      );

      expect(stepRes.status).toBe(409);
      await expect(stepRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(startContexts).toEqual([]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          userId: LOCAL_USER_ID,
          workspaceId: 'ws_demo',
          statuses: ['queued'],
        })
      ).toEqual([]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          userId: LOCAL_USER_ID,
          workspaceId: 'ws_demo',
          statuses: ['cancelled'],
        })
      ).toEqual([expect.objectContaining({ requestId: 'req_goal_deferred_step' })]);
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_deferred_step',
        })
      ).toEqual([expect.objectContaining({ taskId: 'task_deferred_step', status: 'running' })]);
      expect(
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        })
      ).toEqual([
        expect.objectContaining({
          goalId: 'goal_deferred_step',
          status: 'running',
          currentTaskId: 'task_deferred_step',
          terminalStopReason: null,
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('continues no-review Goal Mode until every dependent task completes', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Dependent no-review goal thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-no-review-goal-step-repo-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedReadyRepository(coreDb, repositoryPath);
      const contextTurn = store.createTurn('ws_demo', thread.id, 'Provide context');
      store.createItem({
        id: `it_context_${thread.id}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: contextTurn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Complete both dependent tasks without review gates.',
        createdAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
      });
      store.updateTurn(contextTurn.id, {
        status: 'completed',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_no_review',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Run dependent tasks',
        objective: 'Complete two dependent tasks without review.',
        status: 'running',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_no_review',
        status: 'running',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_no_review',
        taskId: 'task_no_review_1',
        title: 'Complete first task',
        objective: 'Complete the first dependency.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The first task completes.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review the first task output.' }],
        reviewPolicy: {
          ...GOAL_TASK_EXECUTION_FIELDS.reviewPolicy,
          required: false,
        },
        status: 'ready',
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_no_review',
        taskId: 'task_no_review_2',
        title: 'Complete second task',
        objective: 'Complete the task unlocked by the first dependency.',
        orderIndex: 1,
        dependsOnTaskIds: ['task_no_review_1'],
        acceptanceCriteria: ['The second task completes.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review the second task output.' }],
        reviewPolicy: {
          ...GOAL_TASK_EXECUTION_FIELDS.reviewPolicy,
          required: false,
        },
        status: 'pending',
      });

      const app = createApp({
        coreDb,
        store,
        turnExecutor: createCompletingGoalTurnExecutor(),
      });
      const href = `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`;
      const retiredOverrideRes = await app.request(href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'req_goal_retired_review_override',
          reviewPolicyOverride: 'none',
        }),
      });
      expect(retiredOverrideRes.status).toBe(400);
      await expect(retiredOverrideRes.json()).resolves.toMatchObject({ code: 'invalid_request' });

      workspaceDb.sqlite.exec(`
        CREATE TRIGGER fail_goal_checkpoint_cleanup
        BEFORE DELETE ON worker_turn_checkpoints
        BEGIN
          SELECT RAISE(ABORT, 'injected checkpoint cleanup failure');
        END;
      `);

      const firstRes = await app.request(href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_goal_no_review_1' }),
      });

      expect(firstRes.status).toBe(409);
      await expect(firstRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        }).find((goal) => goal.goalId === 'goal_no_review')
      ).toMatchObject({ status: 'running', currentTaskId: null, terminalStopReason: null });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_no_review',
        }).map((task) => ({ taskId: task.taskId, status: task.status }))
      ).toEqual([
        { taskId: 'task_no_review_1', status: 'completed' },
        { taskId: 'task_no_review_2', status: 'ready' },
      ]);
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_no_review',
          taskId: 'task_no_review_1',
        })
      ).toEqual([]);
      const firstWorkerTurnId = store.listThreadTurns('ws_demo', thread.id).at(-1)?.id;
      expect(firstWorkerTurnId).toBeDefined();
      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, firstWorkerTurnId!)
      ).toMatchObject({ stage: 'completed', stopReason: 'completed' });
      const firstReceipt = store.getCommandRequest(
        'goal.step',
        'req_goal_no_review_1',
        { workspaceId: 'ws_demo', threadId: thread.id },
        workspaceDb
      );
      expect(firstReceipt).toMatchObject({
        command: 'goal.step',
        response: {
          kind: 'goal',
          id: 'goal_no_review',
        },
      });
      const unresolvedTurnCount = store.listThreadTurns('ws_demo', thread.id).length;
      const competingRes = await app.request(href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_goal_no_review_competing' }),
      });
      expect(competingRes.status).toBe(409);
      await expect(competingRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(unresolvedTurnCount);
      workspaceDb.sqlite.exec('DROP TRIGGER fail_goal_checkpoint_cleanup');

      const firstTurnCount = store.listThreadTurns('ws_demo', thread.id).length;
      const firstReplayRes = await app.request(href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_goal_no_review_1' }),
      });
      expect(firstReplayRes.status).toBe(200);
      await expect(firstReplayRes.json()).resolves.toMatchObject({
        goal: { status: 'running', currentTask: null },
      });
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(firstTurnCount);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, firstWorkerTurnId!)).toBeNull();

      const secondRes = await app.request(href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_goal_no_review_2' }),
      });

      expect(secondRes.status).toBe(200);
      await expect(secondRes.json()).resolves.toMatchObject({
        goal: {
          status: 'completed',
          currentTask: null,
          taskCounts: { completed: 2, ready: 0 },
          terminalState: { status: 'completed', stopReason: 'completed' },
          terminalSummary: { risks: [] },
        },
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_no_review',
        }).map((task) => ({ taskId: task.taskId, status: task.status }))
      ).toEqual([
        { taskId: 'task_no_review_1', status: 'completed' },
        { taskId: 'task_no_review_2', status: 'completed' },
      ]);
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_no_review',
          taskId: 'task_no_review_2',
        })
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('fails closed on an accepted Goal final status without a command receipt', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Atomic goal review thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-atomic-goal-review-repo-'));
    const requestId = '00000000-0000-4000-8000-000000000271';
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedReadyRepository(coreDb, repositoryPath);
      const contextTurn = store.createTurn('ws_demo', thread.id, 'Provide context');
      store.createItem({
        id: `it_context_${thread.id}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: contextTurn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Produce reviewable worker evidence.',
        createdAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
      });
      store.updateTurn(contextTurn.id, {
        status: 'completed',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_atomic_review',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Persist review atomically',
        objective: 'Create one review gate atomically.',
        status: 'running',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_atomic_review',
        status: 'running',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_atomic_review',
        taskId: 'task_atomic_review',
        title: 'Produce review evidence',
        objective: 'Produce evidence for the atomic review gate.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The review gate is stored atomically.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review worker evidence.' }],
        status: 'ready',
      });
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER fail_goal_checkpoint_terminal
        BEFORE UPDATE OF stage ON worker_turn_checkpoints
        WHEN OLD.goal_id = 'goal_atomic_review'
          AND OLD.stage = 'running_worker'
          AND NEW.stage IN ('completed', 'failed', 'aborted', 'waiting_for_user')
        BEGIN
          SELECT RAISE(ABORT, 'injected checkpoint terminal failure');
        END;
      `);

      const completingExecutor = createCompletingGoalTurnExecutor();
      const acceptedFinalStatusExecutor: TurnExecutor = {
        ...completingExecutor,
        getAgentSession(workerStore, workspaceId, threadId) {
          const session = workerStore.listThreadAgentSessions(workspaceId, threadId).at(-1);
          return session
            ? {
                backend: null,
                configVersion: session.configVersion,
                id: session.id,
                message: session.message,
                sandboxSummary: session.sandboxSummary,
                stale: session.stale,
                status: session.status,
                workspaceRoots: session.workspaceRoots,
              }
            : null;
        },
        async startTurn(workerStore, turnId, input, context) {
          if (!context?.agentSessionId || !context.sandboxBindingRef || !context.requestId) {
            throw new Error('Accepted final-status fixture requires scheduler lineage.');
          }
          const turn = workerStore.getTurnById(turnId);
          const environmentPackage = resolveAgentEnvironmentPackage({
            agent: workerStore.getAgent('ws_demo', 'agent_codex_host'),
            agentSessionId: context.agentSessionId,
            backend: {
              workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
              kind: 'openshell',
              sandboxImageRef: 'openkit/worker-codex:dev',
            },
            requestId: context.requestId,
            turn,
            turnInput: input,
            userId: workerStore.getUserId(),
            workspaceCwd: '/workspace',
            workspaceRoots: [],
          });
          recordAgentEnvironmentPackageSnapshot(workspaceDb, {
            createdAt: turn.startedAt ?? '2026-05-31T00:00:00.000Z',
            environmentPackage,
          });
          workerStore.createAgentSession({
            agentId: 'agent_codex_host',
            createdAt: turn.startedAt ?? '2026-05-31T00:00:00.000Z',
            environmentPackageSnapshotId: environmentPackage.snapshotId,
            id: context.agentSessionId,
            message: null,
            status: 'busy',
            threadId: turn.threadId,
            updatedAt: turn.startedAt ?? '2026-05-31T00:00:00.000Z',
            workspaceId: turn.workspaceId,
          });
          workerStore.updateTurn(turnId, { agentSessionId: context.agentSessionId });
          const backendSession = recordWorkerBackendSessionMaterializing(coreDb, {
            backendVersion: '0.0.80',
            identity: {
              agentSessionId: context.agentSessionId,
              backendKind: 'openshell',
              backendSessionId: `openkit-${context.agentSessionId}`,
              backendTarget: {
                cellTargetId: 'cell-test',
                gatewayEndpoint: null,
                gatewayName: 'openshell',
                placement: 'local',
              },
              deploymentId: 'deployment-test',
              packageSnapshotId: environmentPackage.snapshotId,
              stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
              transientProviderInstanceId: null,
            },
            lineage: { threadId: turn.threadId, turnId, workspaceId: turn.workspaceId },
            sandboxBindingRef: context.sandboxBindingRef,
            workerImage: environmentPackage.runtime.image.ref,
          });
          markWorkerBackendWorkspaceHandoffComplete(coreDb, { leaseId: backendSession.leaseId });
          for (const [fromState, toState] of [
            ['materializing', 'materialized'],
            ['materialized', 'launching'],
            ['launching', 'cleanup-pending'],
            ['cleanup-pending', 'physical-cleaned'],
            ['physical-cleaned', 'cleaned'],
          ] as const) {
            transitionWorkerBackendSessionState(coreDb, {
              fromState,
              leaseId: backendSession.leaseId,
              toState,
            });
          }
          await completingExecutor.startTurn(workerStore, turnId, input, context);
          const completedTurn = workerStore.getTurnById(turnId);
          const idleSession = workerStore.updateAgentSession(context.agentSessionId, {
            message: null,
            status: 'idle',
          });
          workerStore.emitTurnEvent(turnId, {
            data: { agentSession: idleSession, type: 'agent-session-updated' },
            event: 'agent.session.updated',
            requestId: context.requestId,
            threadId: turn.threadId,
            turnId,
            workspaceId: turn.workspaceId,
          });
          workerStore.emitTurnEvent(turnId, {
            data: { stopReason: 'completed', turn: completedTurn, type: 'turn-completed' },
            event: 'turn.completed',
            requestId: context.requestId,
            threadId: turn.threadId,
            turnId,
            workspaceId: turn.workspaceId,
          });
          recordWorkerControlAcceptedRecord(coreDb, {
            acceptedAt: '2026-05-31T00:00:01.000Z',
            lineage: {
              agentSessionId: context.agentSessionId,
              packageSnapshotId: environmentPackage.snapshotId,
              requestId: context.requestId,
              threadId: turn.threadId,
              turnId,
              workspaceId: turn.workspaceId,
            },
            operation: 'final_status',
            record: { sequence: 1, status: 'completed', stopReason: 'completed' },
            recordKey: '1',
            sequence: 1,
          });
        },
      };
      const app = createApp({
        coreDb,
        store,
        turnExecutor: acceptedFinalStatusExecutor,
      });
      const stepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId }),
        }
      );

      expect(stepRes.status).toBe(409);
      await expect(stepRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        }).find((goal) => goal.goalId === 'goal_atomic_review')
      ).toMatchObject({
        status: 'running',
        currentTaskId: 'task_atomic_review',
        terminalStopReason: null,
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_atomic_review',
        })
      ).toEqual([expect.objectContaining({ taskId: 'task_atomic_review', status: 'running' })]);
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_atomic_review',
          taskId: 'task_atomic_review',
        })
      ).toEqual([]);
      const workerTurnId = store.listThreadTurns('ws_demo', thread.id).at(-1)?.id;
      expect(workerTurnId).toBeDefined();
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, workerTurnId!)).toMatchObject({
        stage: 'running_worker',
        stopReason: null,
      });
      const lease = listSchedulerSessionLeasesForTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: workerTurnId!,
      })[0];
      expect(lease).toMatchObject({ status: 'released' });

      workspaceDb.sqlite.exec('DROP TRIGGER fail_goal_checkpoint_terminal');
      const replayStarts: TurnStartRuntimeContext[] = [];
      const restartedApp = createApp({
        coreDb,
        store,
        turnExecutor: createCompletingGoalTurnExecutor(replayStarts),
      });
      const turnCount = store.listThreadTurns('ws_demo', thread.id).length;
      const replayRes = await restartedApp.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId }),
        }
      );

      expect(replayRes.status).toBe(409);
      await expect(replayRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(replayStarts).toEqual([]);
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(turnCount);
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_atomic_review',
          taskId: 'task_atomic_review',
        })
      ).toEqual([]);
      expect(
        store.getCommandRequest(
          'goal.step',
          requestId,
          { workspaceId: 'ws_demo', threadId: thread.id },
          workspaceDb
        )
      ).toBeNull();
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, workerTurnId!)).toMatchObject({
        stage: 'running_worker',
        stopReason: null,
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('waits for an asynchronous Goal Mode worker turn before collecting evidence', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Async worker goal step thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-async-goal-step-repo-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedReadyRepository(coreDb, repositoryPath);
      const contextTurn = store.createTurn('ws_demo', thread.id, 'Provide context');
      store.createItem({
        id: `it_context_${thread.id}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: contextTurn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Use the linked repository and wait for asynchronous worker completion.',
        createdAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
      });
      store.updateTurn(contextTurn.id, {
        status: 'completed',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_async_step',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Run async step',
        objective: 'Run one asynchronous worker step.',
        status: 'running',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_async_step',
        status: 'running',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_async_step',
        taskId: 'task_async_step',
        title: 'Produce async worker evidence',
        objective: 'Produce async worker evidence for the goal.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Worker evidence is recorded after completion.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review async worker evidence.' }],
        status: 'ready',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const turnExecutor: TurnExecutor = {
        capabilities: {
          approvals: true,
          interrupts: true,
          artifacts: true,
          workspaceConfig: true,
          workspaceKnowledgeEditing: true,
          questions: true,
        },
        eventFamilies: ['turn.completed'],
        async startTurn(workerStore, turnId, input) {
          queueMicrotask(() => {
            const turn = workerStore.getTurnById(turnId);
            const timestamp = turn.startedAt ?? '2026-05-31T00:00:00.000Z';
            workerStore.createArtifact({
              id: `art_async_${turnId}`,
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId,
              kind: 'summary',
              title: 'Async worker result',
              status: 'ready',
              summary: 'Async worker evidence ready.',
              version: 1,
              content: {
                format: 'markdown',
                body: input,
              },
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            const completedTurn = workerStore.updateTurn(turnId, {
              status: 'completed',
              completedAt: timestamp,
              durationMs: 0,
            });
            workerStore.emitTurnEvent(turnId, {
              event: 'turn.completed',
              requestId: null,
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId,
              data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
            });
          });
        },
      };
      const app = createApp({ coreDb, store, turnExecutor });
      const stepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_async_step' }),
        }
      );

      expect(stepRes.status).toBe(200);
      const stepPayload = await stepRes.json();
      expect(stepPayload).toMatchObject({
        goal: {
          goalId: 'goal_async_step',
          status: 'reviewing',
          currentTask: {
            taskId: 'task_async_step',
            status: 'reviewing',
          },
        },
      });
      expect(stepPayload).not.toHaveProperty('result');
      const reviews = listGoalReviewRecordsForTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_async_step',
        taskId: 'task_async_step',
      }).filter((review) => review.resolvedAt === null);

      expect(reviews).toEqual([
        expect.objectContaining({
          prompt: 'Review the completed worker output before Goal Mode continues.',
          createdByRequestId: 'req_goal_async_step',
          verdict: null,
          reason: null,
          revisionInstruction: null,
          resolutionRequestId: null,
          resolvedByActorId: null,
          resolutionSnapshot: null,
        }),
      ]);
      const attentionRes = await app.request('/api/app/workspaces/ws_demo/action-center');
      await expect(attentionRes.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            source: {
              type: 'goal_review',
              reviewId: reviews[0]!.reviewId,
              goalId: 'goal_async_step',
              taskId: 'task_async_step',
              workspaceId: 'ws_demo',
              threadId: thread.id,
            },
            actions: [
              expect.objectContaining({ kind: 'accept_review' }),
              expect.objectContaining({ kind: 'request_refinement' }),
              expect.objectContaining({ kind: 'retry_work' }),
              expect.objectContaining({ kind: 'abort' }),
            ],
          }),
        ]),
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    { gateKind: 'approval' as const, executor: () => new SimulatedTurnExecutor() },
    { gateKind: 'user-input' as const, executor: () => new UserInputGateTurnExecutor() },
  ])('closes a Goal Mode worker $gateKind Gate without resuming it', async ({
    gateKind,
    executor,
  }) => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Human approval goal step thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-human-goal-step-repo-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedReadyRepository(coreDb, repositoryPath);
      const contextTurn = store.createTurn('ws_demo', thread.id, 'Provide context');
      store.createItem({
        id: `it_context_${thread.id}`,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: contextTurn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Use the linked repository and surface any human approval gate.',
        createdAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
      });
      store.updateTurn(contextTurn.id, {
        status: 'completed',
        completedAt: contextTurn.startedAt ?? '2026-05-31T00:00:00.000Z',
        durationMs: 0,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_human_step',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Pause for approval',
        objective: 'Run until a human approval gate appears.',
        status: 'running',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_human_step',
        status: 'running',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_human_step',
        taskId: 'task_human_step',
        title: 'Request approval',
        objective: 'Reach the simulator approval gate.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The Action Center exposes the approval.'],
        contextBudgetTokens: 12_000,
        ...GOAL_TASK_EXECUTION_FIELDS,
        verificationChecks: [{ kind: 'manual', description: 'Review the approval row.' }],
        status: 'ready',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const app = createApp({ coreDb, store, turnExecutor: executor() });
      const stepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000303' }),
        }
      );

      expect(stepRes.status).toBe(200);
      const stepPayload = await stepRes.json();
      expect(stepPayload).toMatchObject({
        goal: {
          goalId: 'goal_human_step',
          status: 'awaiting_user',
          currentTask: {
            taskId: 'task_human_step',
            status: 'running',
          },
          pendingHumanAttention: {
            required: true,
            reason: 'Goal is awaiting user input.',
          },
        },
      });
      expect(stepPayload).not.toHaveProperty('result');
      expect(
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        }).find((goal) => goal.goalId === 'goal_human_step')
      ).toMatchObject({ terminalStopReason: null });

      const attentionRes = await app.request('/api/app/workspaces/ws_demo/action-center');
      expect(attentionRes.status).toBe(200);
      await expect(attentionRes.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: gateKind === 'approval' ? 'approval' : 'question',
          }),
        ]),
      });

      const recoveryRes = await app.request('/api/app/recovery/interrupted-workers');
      expect(recoveryRes.status).toBe(200);
      const recoveryPayload = (await recoveryRes.json()) as {
        readonly items: ReadonlyArray<{ readonly checkpointId: string }>;
      };
      const workerTurnId = store.listThreadTurns('ws_demo', thread.id).at(-1)?.id;
      expect(workerTurnId).toBeDefined();
      expect(recoveryPayload.items).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkpointId: `ws_demo:${thread.id}:${workerTurnId}`,
          }),
        ])
      );

      if (!workerTurnId) {
        throw new Error('Goal worker Turn was not created.');
      }
      const waitingCheckpoint = getWorkerCheckpoint(
        workspaceDb,
        'ws_demo',
        thread.id,
        workerTurnId
      );
      expect(waitingCheckpoint).not.toBeNull();
      await expect(
        classifyGoalStepCheckpointAfterSchedulerRecovery({
          coreDb,
          store,
          workspaceDb,
          checkpoint: waitingCheckpoint!,
        })
      ).resolves.toBe('live');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, workerTurnId)).not.toBeNull();
      const waitingTurn = store.getTurn('ws_demo', thread.id, workerTurnId);
      const gate = waitingTurn.humanGate;
      expect(gate?.kind).toBe(gateKind);
      if (!gate || gate.kind !== gateKind) {
        throw new Error(`Expected ${gateKind} Gate.`);
      }
      if (gate.kind === 'user-input') {
        const requestItem = waitingTurn.items.find((item) => item.id === gate.itemId);
        if (requestItem?.type !== 'user-input-request') {
          throw new Error('Expected the worker user-input request Item.');
        }
        const invalidRequestId = '00000000-0000-4000-8000-000000000306';
        const invalidResponse = await app.request('/api/turns', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: invalidRequestId,
            workspaceId: 'ws_demo',
            threadId: thread.id,
            turnId: workerTurnId,
            answers: { tone: ['concise'], extra: ['unsupported'] },
          }),
        });

        expect(invalidResponse.status).toBe(400);
        await expect(invalidResponse.json()).resolves.toMatchObject({ code: 'invalid_request' });
        expect(
          store.getCommandRequest('turn.input.submit', invalidRequestId, {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            turnId: workerTurnId,
          })
        ).toBeNull();
        const secretRequestId = '00000000-0000-4000-8000-000000000307';
        store.updateItem(requestItem.id, {
          questions: requestItem.questions.map((question) => ({ ...question, isSecret: true })),
        });

        const secretResponse = await app.request('/api/turns', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: secretRequestId,
            workspaceId: 'ws_demo',
            threadId: thread.id,
            turnId: workerTurnId,
            answers: { tone: ['concise'] },
          }),
        });

        expect(secretResponse.status).toBe(400);
        await expect(secretResponse.json()).resolves.toMatchObject({
          code: 'secret_input_not_supported',
        });
        expect(
          store.getCommandRequest('turn.input.submit', secretRequestId, {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            turnId: workerTurnId,
          })
        ).toBeNull();
        const rejectedTurn = store.getTurn('ws_demo', thread.id, workerTurnId);
        expect(rejectedTurn).toMatchObject({
          status: 'awaiting_human',
          humanGate: gate,
        });
        expect(rejectedTurn.items.find((item) => item.id === gate.itemId)).toMatchObject({
          questions: [expect.objectContaining({ isSecret: true })],
        });
        expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, workerTurnId)).toEqual(
          waitingCheckpoint
        );
        expect(
          store
            .listThreadItems('ws_demo', thread.id)
            .filter((item) => item.id === `it_user_input_response_${workerTurnId}`)
        ).toHaveLength(0);

        store.updateItem(requestItem.id, { questions: requestItem.questions });
      }
      const responseRequestId =
        gateKind === 'approval'
          ? '00000000-0000-4000-8000-000000000304'
          : '00000000-0000-4000-8000-000000000305';
      if (gate.kind === 'approval') {
        recordProductPermissionDecision({
          workspaceDb,
          decisionId: 'pd_goal_gate_requires_approval',
          ownerScope: 'workspace',
          workspaceId: 'ws_demo',
          policyEngineVersion: 'test:v1',
          policySnapshotId: 'test_goal_gate_policy',
          subjectSummary: { kind: 'test' },
          action: 'repo.push',
          resourceSummary: { turnId: workerTurnId },
          contextSummary: { threadId: thread.id, turnId: workerTurnId },
          result: 'require_approval',
          reasonCode: 'test_approval_required',
          enforcementPoint: 'test.goal_gate',
          requiredApprovalKind: 'permission',
          approvalId: gate.approvalRequestId,
        });
      }
      const response =
        gate.kind === 'approval'
          ? await app.request(`/api/approvals/${gate.approvalRequestId}/respond`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                requestId: responseRequestId,
                workspaceId: 'ws_demo',
                threadId: thread.id,
                turnId: workerTurnId,
                decision: 'granted',
              }),
            })
          : await app.request('/api/turns', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                requestId: responseRequestId,
                workspaceId: 'ws_demo',
                threadId: thread.id,
                turnId: workerTurnId,
                answers: { tone: ['concise'] },
              }),
            });

      expect(response.status).toBe(gate.kind === 'approval' ? 200 : 202);
      const responseItemId =
        gate.kind === 'approval'
          ? `it_approval_decision_${workerTurnId}`
          : `it_user_input_response_${workerTurnId}`;
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_human_step',
        })
      ).toEqual([
        expect.objectContaining({
          taskId: 'task_human_step',
          status: 'ready',
          latestGateContextItemId: responseItemId,
        }),
      ]);
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_human_step')).toMatchObject({
        status: 'running',
        currentTaskId: null,
        terminalStopReason: null,
      });
      expect(store.getTurn('ws_demo', thread.id, workerTurnId)).toMatchObject({
        status: 'completed',
        humanGate: null,
      });
      expect(
        store.listThreadItems('ws_demo', thread.id).filter((item) => item.id === responseItemId)
      ).toHaveLength(1);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, workerTurnId)).toBeNull();

      const replay =
        gate.kind === 'approval'
          ? await app.request(`/api/approvals/${gate.approvalRequestId}/respond`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                requestId: responseRequestId,
                workspaceId: 'ws_demo',
                threadId: thread.id,
                turnId: workerTurnId,
                decision: 'granted',
              }),
            })
          : await app.request('/api/turns', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                requestId: responseRequestId,
                workspaceId: 'ws_demo',
                threadId: thread.id,
                turnId: workerTurnId,
                answers: { tone: ['concise'] },
              }),
            });
      expect(replay.status).toBe(response.status);
      expect(
        store.listThreadItems('ws_demo', thread.id).filter((item) => item.id === responseItemId)
      ).toHaveLength(1);

      const nextStepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000306' }),
        }
      );
      expect(nextStepRes.status).toBe(200);
      const nextTurn = store.listThreadTurns('ws_demo', thread.id).at(-1);
      const nextInput = nextTurn
        ? store
            .listThreadItems('ws_demo', thread.id)
            .find((item) => item.id === `it_user_${nextTurn.id}`)
        : null;
      expect(nextInput?.type).toBe('user-message');
      if (nextInput?.type !== 'user-message') {
        throw new Error('Next Goal worker input was not persisted.');
      }
      const nextRequest = StructuredWorkerDelegationRequestSchema.parse(JSON.parse(nextInput.text));
      expect(nextRequest.contextRefs.slice(2, 4)).toEqual([
        { kind: 'item', id: gate.itemId },
        { kind: 'item', id: responseItemId },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
