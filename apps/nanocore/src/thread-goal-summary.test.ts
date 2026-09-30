import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { goalStartOwnerIds } from './goal-routes.js';
import {
  claimPendingUserTurnRecord,
  createPendingUserTurnRecord,
  deriveSteeringTerminalIds,
  getPendingUserTurnRecord,
  getSteeringTerminalOutcome,
  type PendingUserTurnInput,
  type PendingUserTurnRecord,
} from './goal-steering-authority.js';
import { createDeterministicGoalPlanFallback } from './runtime/goal-plan.js';
import { createGoalReviewRecord } from './runtime/goal-review-records.js';
import {
  createGoalPlanRecord,
  createGoalRecord,
  createGoalTask,
  getGoalRecord,
  listGoalTasks,
  updateGoalStatus,
} from './runtime/goal-store.js';
import { createGoalVerificationRecord } from './runtime/goal-verification-records.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createInitialGoalIntentItem } from './test-support/goal-intent.js';
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

/** Seeds the immutable initial Plan authority named by direct Goal Task fixtures. */
function seedFixtureGoalPlanAuthority(
  workspaceDb: WorkspaceDb,
  threadId: string,
  goalId: string,
  taskIds: readonly string[]
): void {
  const goal = getGoalRecord(workspaceDb, workspaceDb.workspaceId, threadId, goalId);
  if (!goal) throw new Error('Goal fixture is missing before its Plan is seeded.');
  const fallback = createDeterministicGoalPlanFallback({
    goalTitle: goal.title,
    objective: goal.objective,
  });
  const tasks = listGoalTasks(workspaceDb, {
    workspaceId: workspaceDb.workspaceId,
    threadId,
    goalId,
  });
  if (JSON.stringify(tasks.map((task) => task.taskId)) !== JSON.stringify(taskIds)) {
    throw new Error('Goal fixture Tasks do not match its approved Plan.');
  }
  createGoalPlanRecord(workspaceDb, {
    workspaceId: workspaceDb.workspaceId,
    threadId,
    goalId,
    planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
    predecessorPlanItemId: null,
    sourceIntentItemId: goal.currentIntentItemId,
    sourceTaskEvidenceDigest: null,
    plan: {
      ...fallback,
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        objective: task.objective,
        acceptanceCriteria: task.acceptanceCriteria,
        contextBudgetTokens: task.contextBudgetTokens,
        resources: task.resources,
        expectedArtifacts: task.expectedArtifacts,
        verificationChecks: task.verificationChecks,
        reviewPolicy: task.reviewPolicy,
        dependsOnTaskIds: task.dependsOnTaskIds,
        escalationConditions: task.escalationConditions,
      })),
    },
    createdByRequestId: `req_${goalId}_fixture_plan`,
  });
  updateGoalStatus(workspaceDb, {
    workspaceId: workspaceDb.workspaceId,
    threadId,
    goalId,
    status: goal.status,
    planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
  });
}

describe('Goal review decision lineage', () => {
  it('denies a Goal Review whose scoped owner is outside the authorized path Workspace', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const authorizedThread = store.createThread('ws_demo', 'Authorized review Thread');
    const foreignWorkspace = store.createWorkspace('Foreign Goal Workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign Goal Thread');
    const foreignIntentItemId = createInitialGoalIntentItem({
      store,
      workspaceId: foreignWorkspace.id,
      threadId: foreignThread.id,
      objective: 'Remain in the foreign Workspace.',
      userId: 'user_local',
    });
    const foreignTurn = store.createTurn(
      foreignWorkspace.id,
      foreignThread.id,
      'Foreign reviewed work',
      { kind: 'user', id: 'user_local' }
    );
    const foreignDb = openWorkspaceDb(coreDb.dataRoot, foreignWorkspace.id);
    applyScopedMigrations(foreignDb);
    createGoalRecord(foreignDb, {
      createdByItemId: foreignIntentItemId,
      goalId: 'goal_foreign_lineage',
      objective: 'Remain in the foreign Workspace.',
      status: 'reviewing',
      threadId: foreignThread.id,
      title: 'Foreign Goal',
      workspaceExists: (workspaceId) => workspaceId === foreignWorkspace.id,
      workspaceId: foreignWorkspace.id,
    });
    createGoalTask(foreignDb, {
      ...GOAL_TASK_EXECUTION_FIELDS,
      acceptanceCriteria: ['The foreign Task remains isolated.'],
      contextBudgetTokens: 1024,
      dependsOnTaskIds: [],
      goalId: 'goal_foreign_lineage',
      objective: 'Review foreign work.',
      orderIndex: 0,
      status: 'reviewing',
      taskId: 'task_foreign_lineage',
      threadId: foreignThread.id,
      title: 'Foreign Task',
      workspaceId: foreignWorkspace.id,
    });
    seedFixtureGoalPlanAuthority(foreignDb, foreignThread.id, 'goal_foreign_lineage', [
      'task_foreign_lineage',
    ]);
    updateGoalStatus(foreignDb, {
      currentTaskId: 'task_foreign_lineage',
      goalId: 'goal_foreign_lineage',
      planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
      status: 'reviewing',
      threadId: foreignThread.id,
      workspaceId: foreignWorkspace.id,
    });
    createGoalReviewRecord(foreignDb, {
      createdByRequestId: 'goal-review-foreign-create',
      goalId: 'goal_foreign_lineage',
      prompt: 'Review foreign work.',
      reviewId: 'review_foreign_lineage',
      taskId: 'task_foreign_lineage',
      threadId: foreignThread.id,
      turnId: foreignTurn.id,
      workspaceId: foreignWorkspace.id,
    });
    foreignDb.sqlite.close();
    const app = createApp({ coreDb, dataRoot: coreDb.dataRoot, store });

    try {
      const response = await app.request(
        `/api/app/workspaces/ws_demo/threads/${authorizedThread.id}/goals/goal_foreign_lineage/reviews/review_foreign_lineage/decision`,
        {
          body: JSON.stringify({ requestId: 'goal-review-foreign-decision', verdict: 'accept' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );

      expect(response.status, await response.clone().text()).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('Goal command actor identity', () => {
  it('derives Goal start owners from the explicit authenticated actor', () => {
    const command = {
      owningCommand: 'goal.start' as const,
      requestId: 'goal-start-actor-scope',
      threadId: 'th_actor_scope',
      workspaceId: 'ws_demo',
    };

    expect(goalStartOwnerIds({ ...command, actorId: 'user_1' })).not.toEqual(
      goalStartOwnerIds({ ...command, actorId: 'user_2' })
    );
  });
});

/**
 * Opens a migrated Core database for thread goal summary route tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-goal-summary-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: LOCAL_USER_ID,
    workspaceId: 'ws_demo',
  });
  return coreDb;
}

/**
 * Opens a migrated workspace database for goal summary tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Posts one terminal Goal steering command through the public App API.
 *
 * @param app NanoCore app under test.
 * @param threadId Thread that owns the pending input.
 * @param pendingTurnId Exact pending owner identity.
 * @param command Terminal command path.
 * @param requestId Terminal command request identity.
 * @returns Public App API response.
 */
function postGoalSteeringTerminal(
  app: ReturnType<typeof createApp>,
  threadId: string,
  pendingTurnId: string,
  command: 'follow-up' | 'cancel',
  requestId: string
): Promise<Response> {
  return app.request(
    `/api/app/workspaces/ws_demo/threads/${threadId}/goal/steering/${pendingTurnId}/${command}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    }
  );
}

/** Human actor whose exact identity must survive terminal steering follow-up conversion. */
const TERMINAL_STEERING_SOURCE_ACTOR = {
  kind: 'user',
  id: 'user_steering_source',
} as const;

/** Seeded terminal Goal steering owner used by public route tests. */
interface TerminalGoalSteeringFixture {
  /** Original terminal Goal id. */
  readonly goalId: string;
  /** Exact pending steering owner. */
  readonly pending: PendingUserTurnRecord;
  /** Original input text copied by follow-up conversion. */
  readonly text: string;
}

/**
 * Seeds one complete accepted send tuple whose original Goal and Turn are terminal.
 *
 * @param store App-local durable store.
 * @param workspaceDb Open Workspace database.
 * @param threadId Thread that owns the steering input.
 * @param suffix Stable fixture identity suffix.
 * @param terminal Whether the original Goal and Turn should be terminalized.
 * @param input Exact pending input identity.
 * @returns Complete pending owner and original input.
 */
function seedTerminalGoalSteering(
  store: ReturnType<typeof createDemoStore>,
  workspaceDb: WorkspaceDb,
  threadId: string,
  suffix: string,
  terminal = true,
  input: PendingUserTurnInput = { kind: 'message' }
): TerminalGoalSteeringFixture {
  const goalId = `goal_steering_${suffix}`;
  const activeTurnId = `tu_steering_${suffix}`;
  const requestId = `steering-send-${suffix}`;
  const receivedAt = '2026-07-18T02:00:00.000Z';
  const text =
    input.kind === 'message'
      ? `Preserve steering input ${suffix}.`
      : `Use Workspace Material ${input.materialId} revision ${input.revisionId}.`;

  const initialIntentItemId = createInitialGoalIntentItem({
    store,
    workspaceId: 'ws_demo',
    threadId,
    objective: text,
    userId: TERMINAL_STEERING_SOURCE_ACTOR.id,
    at: receivedAt,
  });
  createGoalRecord(workspaceDb, {
    createdByItemId: initialIntentItemId,
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId,
    workspaceId: 'ws_demo',
    threadId,
    title: `Terminal steering ${suffix}`,
    objective: text,
    status: 'running',
    now: () => receivedAt,
  });
  store.createTurn('ws_demo', threadId, text, TERMINAL_STEERING_SOURCE_ACTOR, null, {
    turnId: activeTurnId,
    startedAt: receivedAt,
  });
  const pending = createPendingUserTurnRecord(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId,
    goalId,
    activeTurnId,
    requestId,
    input,
    receivedAt,
  });
  store.createItem({
    id: pending.contentItemId,
    workspaceId: 'ws_demo',
    threadId,
    turnId: activeTurnId,
    type: 'user-message',
    status: 'completed',
    actor: TERMINAL_STEERING_SOURCE_ACTOR,
    text,
    parentItemId: null,
    causationId: requestId,
    createdAt: receivedAt,
    completedAt: receivedAt,
  });
  if (terminal) {
    store.updateTurn(activeTurnId, {
      status: 'completed',
      completedAt: receivedAt,
      durationMs: 0,
    });
    updateGoalStatus(workspaceDb, {
      workspaceId: 'ws_demo',
      threadId,
      goalId,
      status: 'completed',
      currentTaskId: null,
      terminalStopReason: 'completed',
      now: () => receivedAt,
    });
  }
  store.recordCommandRequest(
    {
      command: 'goal.steering.send',
      requestId,
      scope: { workspaceId: 'ws_demo', threadId },
      inputHash: commandInputHash(
        input.kind === 'message'
          ? { message: text }
          : {
              materialId: input.materialId,
              revisionId: input.revisionId,
              contentDigest: input.contentDigest,
              note: text,
            }
      ),
      response: { kind: 'pending_user_turn', id: pending.pendingTurnId },
      createdAt: receivedAt,
    },
    workspaceDb
  );

  return { goalId, pending, text };
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
      const initialIntentItemId = createInitialGoalIntentItem({
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        objective: 'Prepare the release plan for user approval.',
        userId: 'user_local',
      });
      createGoalRecord(workspaceDb, {
        createdByItemId: initialIntentItemId,
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
      const initialIntentItemId = createInitialGoalIntentItem({
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        objective: 'Finish every release task.',
        userId: 'user_local',
      });
      createGoalRecord(workspaceDb, {
        createdByItemId: initialIntentItemId,
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
      seedFixtureGoalPlanAuthority(workspaceDb, thread.id, 'goal_running', [
        'task_done',
        'task_current',
        'task_next',
      ]);
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_running',
        status: 'completed',
        planItemId: GOAL_TASK_EXECUTION_FIELDS.planItemId,
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

  it('refuses Goal start before writing a Turn, Item, or command receipt', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const app = createApp({ coreDb, store });
    try {
      const beforeTurns = store.listThreadTurns('ws_demo', 'th_demo').length;
      const beforeItems = store.listThreadItems('ws_demo', 'th_demo').length;
      const response = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/goal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_unavailable_goal', objective: 'Plan a release.' }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'goal_mode_unavailable' });
      expect(store.listThreadTurns('ws_demo', 'th_demo')).toHaveLength(beforeTurns);
      expect(store.listThreadItems('ws_demo', 'th_demo')).toHaveLength(beforeItems);
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('converts terminal Goal steering into one deterministic completed follow-up and replays its outcome', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T03:00:00.000Z'));
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Terminal steering follow-up');
    const fixture = seedTerminalGoalSteering(store, workspaceDb, thread.id, 'follow-up');
    const terminalRequestId = 'steering-follow-up-1';
    const ids = deriveSteeringTerminalIds({
      workspaceId: 'ws_demo',
      threadId: thread.id,
      pendingTurnId: fixture.pending.pendingTurnId,
      terminalRequestId,
    });
    const app = createApp({ coreDb, store });

    try {
      const receiptFailure = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated follow-up receipt failure');
      });
      const failed = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'follow-up',
        terminalRequestId
      );
      receiptFailure.mockRestore();
      expect(failed.status).toBe(400);
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', thread.id)).toEqual(
        expect.objectContaining({
          terminalClaimKind: 'follow-up',
          terminalClaimId: ids.followUpTurnId,
          terminalClaimedAt: '2026-07-18T03:00:00.000Z',
        })
      );
      expect(
        getSteeringTerminalOutcome(workspaceDb, 'ws_demo', thread.id, fixture.pending.pendingTurnId)
      ).toBeNull();
      expect(store.getTurn('ws_demo', thread.id, ids.followUpTurnId).status).toBe('completed');

      const response = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'follow-up',
        terminalRequestId
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toEqual({
        state: 'follow-up',
        pendingTurnId: fixture.pending.pendingTurnId,
        requestId: terminalRequestId,
        sourceRequestId: fixture.pending.requestId,
        contentItemId: fixture.pending.contentItemId,
        goalId: fixture.goalId,
        activeTurnId: fixture.pending.activeTurnId,
        followUpTurnId: ids.followUpTurnId,
        followUpItemId: ids.followUpItemId,
      });
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', thread.id)).toBeNull();
      expect(
        getSteeringTerminalOutcome(workspaceDb, 'ws_demo', thread.id, fixture.pending.pendingTurnId)
      ).toEqual({
        workspaceId: 'ws_demo',
        threadId: thread.id,
        pendingTurnId: fixture.pending.pendingTurnId,
        outcomeId: ids.outcomeId,
        state: 'follow-up',
        sendRequestId: fixture.pending.requestId,
        terminalRequestId,
        contentItemId: fixture.pending.contentItemId,
        goalId: fixture.goalId,
        activeTurnId: fixture.pending.activeTurnId,
        inputKind: 'message',
        materialId: null,
        revisionId: null,
        contentDigest: null,
        followUpTurnId: ids.followUpTurnId,
        followUpItemId: ids.followUpItemId,
        acceptedAt: '2026-07-18T03:00:00.000Z',
      });
      expect(store.getTurn('ws_demo', thread.id, ids.followUpTurnId)).toEqual(
        expect.objectContaining({
          id: ids.followUpTurnId,
          triggerActor: TERMINAL_STEERING_SOURCE_ACTOR,
          status: 'completed',
          error: null,
          configVersion: null,
          startedAt: '2026-07-18T03:00:00.000Z',
          completedAt: '2026-07-18T03:00:00.000Z',
          durationMs: 0,
          items: [
            expect.objectContaining({
              id: ids.followUpItemId,
              type: 'user-message',
              status: 'completed',
              actor: TERMINAL_STEERING_SOURCE_ACTOR,
              text: fixture.text,
              parentItemId: fixture.pending.contentItemId,
              causationId: terminalRequestId,
              createdAt: '2026-07-18T03:00:00.000Z',
              completedAt: '2026-07-18T03:00:00.000Z',
            }),
          ],
        })
      );
      expect(
        store.getCommandRequest(
          'goal.steering.follow_up',
          terminalRequestId,
          {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            pendingTurnId: fixture.pending.pendingTurnId,
          },
          workspaceDb
        )?.response
      ).toEqual({ kind: 'steering_terminal_outcome', id: ids.outcomeId });

      const second = seedTerminalGoalSteering(
        store,
        workspaceDb,
        thread.id,
        'follow-up-reused-request'
      );
      const turnsBeforeReuse = store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id);
      const itemsBeforeReuse = store.listThreadItems('ws_demo', thread.id).map((item) => item.id);
      const reusedRequest = await postGoalSteeringTerminal(
        app,
        thread.id,
        second.pending.pendingTurnId,
        'follow-up',
        terminalRequestId
      );
      expect(reusedRequest.status).toBe(409);
      await expect(reusedRequest.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', thread.id)).toEqual(second.pending);
      expect(
        getSteeringTerminalOutcome(workspaceDb, 'ws_demo', thread.id, second.pending.pendingTurnId)
      ).toBeNull();
      expect(store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id)).toEqual(
        turnsBeforeReuse
      );
      expect(store.listThreadItems('ws_demo', thread.id).map((item) => item.id)).toEqual(
        itemsBeforeReuse
      );
      expect(
        store.getCommandRequest(
          'goal.steering.follow_up',
          terminalRequestId,
          {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            pendingTurnId: second.pending.pendingTurnId,
          },
          workspaceDb
        )
      ).toBeNull();
      const initialIntentItemId = createInitialGoalIntentItem({
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        objective: 'Replay must not retarget this Goal.',
        userId: 'user_local',
      });
      createGoalRecord(workspaceDb, {
        createdByItemId: initialIntentItemId,
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_newer_after_follow_up',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Newer Goal',
        objective: 'Replay must not retarget this Goal.',
        status: 'running',
      });
      store.createTurn('ws_demo', thread.id, 'Keep the newer Goal active.', {
        kind: 'user',
        id: 'user_local',
      });
      const replay = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'follow-up',
        terminalRequestId
      );
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual(payload);
      expect(
        store.listThreadTurns('ws_demo', thread.id).filter((turn) => turn.id === ids.followUpTurnId)
      ).toHaveLength(1);

      const competingCancel = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'cancel',
        'steering-cancel-after-follow-up'
      );
      expect(competingCancel.status).toBe(409);
      await expect(competingCancel.json()).resolves.toMatchObject({ code: 'conflict' });

      expect(() =>
        store.updateItem(ids.followUpItemId, { text: 'Contradict the immutable copied input.' })
      ).toThrow(/is terminal and does not admit this write/);
    } finally {
      vi.useRealTimers();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('cancels terminal Goal steering atomically without requiring an idle Thread', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Terminal steering cancellation');
    const fixture = seedTerminalGoalSteering(store, workspaceDb, thread.id, 'cancel', true, {
      kind: 'material',
      materialId: 'material_cancel',
      revisionId: 'revision_cancel',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    });
    const app = createApp({ coreDb, store });
    const terminalRequestId = 'steering-cancel-1';
    const ids = deriveSteeringTerminalIds({
      workspaceId: 'ws_demo',
      threadId: thread.id,
      pendingTurnId: fixture.pending.pendingTurnId,
      terminalRequestId,
    });
    store.createTurn('ws_demo', thread.id, 'New work may remain active during cancellation.', {
      kind: 'user',
      id: 'user_local',
    });
    const turnsBefore = store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id);
    const itemsBefore = store.listThreadItems('ws_demo', thread.id).map((item) => item.id);

    try {
      const receiptFailure = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated terminal receipt failure');
      });
      const failed = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'cancel',
        terminalRequestId
      );
      receiptFailure.mockRestore();
      expect(failed.status).toBe(400);
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', thread.id)).toEqual(
        expect.objectContaining({ terminalClaimKind: null, terminalClaimId: null })
      );
      expect(
        getSteeringTerminalOutcome(workspaceDb, 'ws_demo', thread.id, fixture.pending.pendingTurnId)
      ).toBeNull();

      const response = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'cancel',
        terminalRequestId
      );
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload).toEqual({
        state: 'cancelled',
        pendingTurnId: fixture.pending.pendingTurnId,
        requestId: terminalRequestId,
        sourceRequestId: fixture.pending.requestId,
        contentItemId: fixture.pending.contentItemId,
        goalId: fixture.goalId,
        activeTurnId: fixture.pending.activeTurnId,
      });
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', thread.id)).toBeNull();
      expect(
        getSteeringTerminalOutcome(workspaceDb, 'ws_demo', thread.id, fixture.pending.pendingTurnId)
      ).toEqual(
        expect.objectContaining({
          outcomeId: ids.outcomeId,
          state: 'cancelled',
          inputKind: 'material',
          materialId: 'material_cancel',
          revisionId: 'revision_cancel',
          contentDigest: `sha256:${'a'.repeat(64)}`,
        })
      );
      expect(store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id)).toEqual(
        turnsBefore
      );
      expect(store.listThreadItems('ws_demo', thread.id).map((item) => item.id)).toEqual(
        itemsBefore
      );
      expect(
        store.getCommandRequest(
          'goal.steering.cancel',
          terminalRequestId,
          {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            pendingTurnId: fixture.pending.pendingTurnId,
          },
          workspaceDb
        )?.response
      ).toEqual({ kind: 'steering_terminal_outcome', id: ids.outcomeId });

      const replay = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'cancel',
        terminalRequestId
      );
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual(payload);
    } finally {
      vi.restoreAllMocks();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('requires a terminal original Goal and an idle Thread only for follow-up conversion', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const nonterminalThread = store.createThread('ws_demo', 'Nonterminal steering Goal');
    const nonterminal = seedTerminalGoalSteering(
      store,
      workspaceDb,
      nonterminalThread.id,
      'nonterminal',
      false
    );
    const busyThread = store.createThread('ws_demo', 'Busy terminal steering Thread');
    const busy = seedTerminalGoalSteering(store, workspaceDb, busyThread.id, 'busy');
    store.createTurn('ws_demo', busyThread.id, 'Keep this Thread busy.', {
      kind: 'user',
      id: 'user_local',
    });
    const sameRequestThread = store.createThread('ws_demo', 'Reused steering identity');
    const sameRequest = seedTerminalGoalSteering(
      store,
      workspaceDb,
      sameRequestThread.id,
      'same-request'
    );
    const app = createApp({ coreDb, store });

    try {
      const nonterminalResponse = await postGoalSteeringTerminal(
        app,
        nonterminalThread.id,
        nonterminal.pending.pendingTurnId,
        'cancel',
        'steering-cancel-nonterminal'
      );
      expect(nonterminalResponse.status).toBe(409);
      await expect(nonterminalResponse.json()).resolves.toMatchObject({ code: 'conflict' });

      const busyResponse = await postGoalSteeringTerminal(
        app,
        busyThread.id,
        busy.pending.pendingTurnId,
        'follow-up',
        'steering-follow-up-busy'
      );
      expect(busyResponse.status).toBe(409);
      await expect(busyResponse.json()).resolves.toMatchObject({ code: 'thread_busy' });

      const sameRequestResponse = await postGoalSteeringTerminal(
        app,
        sameRequestThread.id,
        sameRequest.pending.pendingTurnId,
        'cancel',
        sameRequest.pending.requestId
      );
      expect(sameRequestResponse.status).toBe(409);
      await expect(sameRequestResponse.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', nonterminalThread.id)).toEqual(
        expect.objectContaining({ terminalClaimKind: null })
      );
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', busyThread.id)).toEqual(
        expect.objectContaining({ terminalClaimKind: null })
      );
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', sameRequestThread.id)).toEqual(
        expect.objectContaining({ terminalClaimKind: null })
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('retains a winning follow-up claim and fails closed on half proof', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Half follow-up proof');
    const fixture = seedTerminalGoalSteering(store, workspaceDb, thread.id, 'half-proof');
    const terminalRequestId = 'steering-follow-up-half-proof';
    const ids = deriveSteeringTerminalIds({
      workspaceId: 'ws_demo',
      threadId: thread.id,
      pendingTurnId: fixture.pending.pendingTurnId,
      terminalRequestId,
    });
    const acceptedAt = '2026-07-18T03:10:00.000Z';
    claimPendingUserTurnRecord(workspaceDb, {
      workspaceId: 'ws_demo',
      threadId: thread.id,
      pendingTurnId: fixture.pending.pendingTurnId,
      terminalClaimKind: 'follow-up',
      terminalClaimId: ids.followUpTurnId,
      terminalClaimedAt: acceptedAt,
    });
    store.createTurn('ws_demo', thread.id, fixture.text, { kind: 'user', id: 'user_local' }, null, {
      turnId: ids.followUpTurnId,
      startedAt: acceptedAt,
    });
    store.updateTurn(ids.followUpTurnId, {
      status: 'completed',
      completedAt: acceptedAt,
      durationMs: 0,
    });
    const app = createApp({ coreDb, store });

    try {
      const response = await postGoalSteeringTerminal(
        app,
        thread.id,
        fixture.pending.pendingTurnId,
        'follow-up',
        terminalRequestId
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(getPendingUserTurnRecord(workspaceDb, 'ws_demo', thread.id)).toEqual(
        expect.objectContaining({
          terminalClaimKind: 'follow-up',
          terminalClaimId: ids.followUpTurnId,
          terminalClaimedAt: acceptedAt,
        })
      );
      expect(
        store.getCommandRequest(
          'goal.steering.follow_up',
          terminalRequestId,
          {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            pendingTurnId: fixture.pending.pendingTurnId,
          },
          workspaceDb
        )
      ).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
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
});
