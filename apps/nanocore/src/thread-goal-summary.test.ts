import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { listGoalReviewRecordsForTask } from './runtime/goal-review-records.js';
import {
  createGoalRecord,
  createGoalTask,
  listGoalRecordsForThread,
  listGoalTasks,
  updateGoalStatus,
} from './runtime/goal-store.js';
import { createGoalVerificationRecord } from './runtime/goal-verification-records.js';
import type { TurnExecutor } from './runtime/types.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { upsertWorkspaceRepositoryResource } from './workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

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
 * Creates a synchronous worker fixture that completes every started turn with artifact evidence.
 *
 * @returns Turn executor suitable for repeated live Goal Mode steps.
 */
function createCompletingGoalTurnExecutor(): TurnExecutor {
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
    async startTurn(workerStore, turnId, input) {
      const turn = workerStore.getTurnById(turnId);
      const timestamp = turn.startedAt ?? '2026-05-31T00:00:00.000Z';
      const artifact = workerStore.createArtifact({
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
      workerStore.createItem({
        id: `it_artifact_${turnId}`,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId,
        type: 'artifact-reference',
        status: 'completed',
        artifactId: artifact.id,
        title: artifact.title,
        summary: artifact.summary,
        createdAt: timestamp,
        completedAt: timestamp,
      });
      workerStore.updateTurn(turnId, {
        status: 'completed',
        completedAt: timestamp,
        durationMs: 0,
      });
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          terminalSummary: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
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
            needsRevision: 0,
            completed: 1,
            blocked: 0,
            failed: 0,
            skipped: 0,
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
            skippedTaskIds: [],
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
            risks: ['2 required task is not accepted or skipped.'],
            suggestedNextWork: [],
          },
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
          updatedAt: '2026-05-31T00:20:00.000Z',
        },
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('starts a planning goal from a normal thread and records the objective item', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Goal start thread');

    try {
      const app = createApp({ coreDb, store });
      const res = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objective: 'Make v0.0.6 ready to publish.',
          title: 'Ship v0.0.6',
        }),
      });

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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
        },
      });

      const items = store.listThreadItems('ws_demo', thread.id);
      expect(items).toEqual([
        expect.objectContaining({
          id: payload.objectiveItemId,
          type: 'user-message',
          status: 'completed',
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
      } finally {
        workspaceDb.sqlite.close();
      }
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
          objective: 'Make v0.0.6 ready to publish.',
          title: 'Ship v0.0.6',
        }),
      });
      expect(firstRes.status).toBe(200);

      const secondRes = await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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

  it('queues steering for a running goal at the next safe point', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Queued steering thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_running',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Steer running goal',
        objective: 'Keep active work aligned with the user.',
        status: 'running',
      });

      const app = createApp({ coreDb, store });
      const res = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/steering`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'req_steering',
            message: 'Prioritize release notes before the publish check.',
          }),
        }
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        state: 'queued',
        goal: {
          goalId: 'goal_running',
          status: 'running',
          steering: {
            pendingSteeringCount: 1,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
        },
      });
      expect(store.listThreadItems('ws_demo', thread.id)).toEqual([
        expect.objectContaining({
          type: 'user-message',
          status: 'completed',
          text: 'Prioritize release notes before the publish check.',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('blocks steering behind a human gate as pending follow-up input', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Blocked steering thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_awaiting_user',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Await user goal',
        objective: 'Ask for required user input.',
        status: 'awaiting_user',
      });

      const app = createApp({ coreDb, store });
      const res = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/steering`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'req_follow_up',
            message: 'Use the conservative rollout path.',
          }),
        }
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        state: 'blocked',
        goal: {
          goalId: 'goal_awaiting_user',
          status: 'awaiting_user',
          pendingHumanAttention: {
            required: true,
            reason: 'Goal is awaiting user input.',
          },
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 1,
            appliedSteeringCount: 0,
          },
        },
      });
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
          objective: 'Make v0.0.6 ready to publish.',
          title: 'Ship v0.0.6',
        }),
      });

      expect(startRes.status).toBe(200);

      const pauseBeforeApprovalRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/pause`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(pauseBeforeApprovalRes.status).toBe(409);
      await expect(pauseBeforeApprovalRes.json()).resolves.toMatchObject({
        code: 'goal_not_running',
      });

      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      const planPayload = (await planRes.json()) as {
        status: string;
        goal: { goalId: string; status: string; taskCounts: { ready: number } };
        planItemId: string;
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
        planItemId: 'it_goal_plan_tu_2',
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

      const mismatchedApproveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            planItemId: 'it_goal_plan_other',
            plan: planPayload.plan,
          }),
        }
      );

      expect(mismatchedApproveRes.status).toBe(400);
      await expect(mismatchedApproveRes.json()).resolves.toMatchObject({
        code: 'goal_plan_mismatch',
      });

      const approveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            planItemId: planPayload.planItemId,
            plan: planPayload.plan,
          }),
        }
      );

      expect(approveRes.status).toBe(200);
      await expect(approveRes.json()).resolves.toMatchObject({
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
      const pauseRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/pause`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(pauseRes.status).toBe(200);
      await expect(pauseRes.json()).resolves.toMatchObject({
        goal: {
          goalId: planPayload.goal.goalId,
          status: 'paused',
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
        },
      });

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

      const resumeRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/resume`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(resumeRes.status).toBe(200);
      await expect(resumeRes.json()).resolves.toMatchObject({
        goal: {
          goalId: planPayload.goal.goalId,
          status: 'running',
          taskCounts: {
            ready: 1,
          },
        },
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
          nextTaskId: null,
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
        expect(listPermissionDecisionsForAction(permissionDb, 'runtime.launch')).toContainEqual({
          action: 'runtime.launch',
          enforcement_point: 'goal.test.supervise.worker_start',
          reason_code: 'goal_worker_start_allowed',
          result: 'allow',
        });
      } finally {
        permissionDb.sqlite.close();
      }
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

  it('returns a drafted Goal Mode plan to planning when revisions are requested', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Goal plan revision thread');
    const app = createApp({ coreDb, store });

    try {
      await app.request(`/api/app/workspaces/ws_demo/threads/${thread.id}/goal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objective: 'Make v0.0.7 ready to publish.',
          title: 'Ship v0.0.7',
        }),
      });

      const planRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      const planPayload = (await planRes.json()) as {
        goal: { status: string };
        planItemId: string;
        plan: unknown;
      };

      expect(planRes.status).toBe(200);
      expect(planPayload.goal.status).toBe('awaiting_plan_approval');

      const reviseRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/revise`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000302',
            revision: 'Split documentation and verification into separate review gates.',
          }),
        }
      );

      expect(reviseRes.status).toBe(200);
      await expect(reviseRes.json()).resolves.toMatchObject({
        goal: {
          status: 'planning',
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
        },
        revisionItemId: expect.stringMatching(/^it_goal_plan_revision_/),
        startsWorkerTurn: false,
      });

      const staleApproveRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            planItemId: planPayload.planItemId,
            plan: planPayload.plan,
          }),
        }
      );

      expect(staleApproveRes.status).toBe(409);
      await expect(staleApproveRes.json()).resolves.toMatchObject({
        code: 'goal_not_awaiting_plan_approval',
      });

      const revisedPlanRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(revisedPlanRes.status).toBe(200);
      await expect(revisedPlanRes.json()).resolves.toMatchObject({
        status: 'awaiting_plan_approval',
        goal: { status: 'awaiting_plan_approval' },
      });
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
        verificationChecks: [{ kind: 'manual', description: 'Review worker evidence.' }],
        status: 'ready',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const turnExecutor = createCompletingGoalTurnExecutor();
      const app = createApp({ coreDb, store, turnExecutor });
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
        worker: {
          stopReason: 'completed',
          checkpointStage: 'completed',
          evidence: {
            artifactIds: expect.arrayContaining([expect.stringMatching(/^art_/)]),
          },
        },
        coordinator: {
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          worker: {
            agentId: 'agent_codex_host',
            displayName: 'Codex Host Agent',
            runtime: 'codex',
          },
          expectedStopCondition: 'one bounded worker turn',
          contextRefs: expect.arrayContaining([
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: thread.id },
          ]),
        },
        decision: {
          schemaVersion: 1,
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          requestId: 'req_goal_step',
          outcome: 'review',
          shouldStop: true,
          stopReason: 'completed',
          rationale: 'Worker turn completed and needs human review before Goal Mode continues.',
          contextRefs: expect.arrayContaining([
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: thread.id },
          ]),
          evidence: {
            itemIds: expect.arrayContaining([expect.stringMatching(/^it_artifact_/)]),
            artifactIds: expect.arrayContaining([expect.stringMatching(/^art_/)]),
          },
        },
        pendingAttention: {
          kind: 'review',
          reason: 'Worker result needs review.',
        },
      });
      const unresolvedReviews = listGoalReviewRecordsForTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_real_step',
        taskId: 'task_real_step',
      }).filter((review) => review.resolvedAt === null);

      expect(unresolvedReviews).toHaveLength(1);
      const review = unresolvedReviews[0]!;
      expect(review).toMatchObject({
        verdict: 'accept',
        turnId: stepPayload.worker.turnId,
        itemIds: stepPayload.worker.evidence.itemIds,
        artifactIds: stepPayload.worker.evidence.artifactIds,
        resolvedAt: null,
      });

      const attentionRes = await app.request('/api/app/workspaces/ws_demo/action-center');
      expect(attentionRes.status).toBe(200);
      await expect(attentionRes.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            source: expect.objectContaining({
              type: 'goal_review',
              reviewId: review.reviewId,
            }),
            actions: expect.arrayContaining([expect.objectContaining({ kind: 'accept_review' })]),
          }),
        ]),
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
      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, stepPayload.worker.turnId)
      ).toBeNull();
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
        verificationChecks: [{ kind: 'manual', description: 'Review the first task output.' }],
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
        verificationChecks: [{ kind: 'manual', description: 'Review the second task output.' }],
        status: 'pending',
      });

      const app = createApp({
        coreDb,
        store,
        turnExecutor: createCompletingGoalTurnExecutor(),
      });
      const href = `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`;
      const firstRes = await app.request(href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'req_goal_no_review_1',
          reviewPolicyOverride: 'none',
        }),
      });

      expect(firstRes.status).toBe(200);
      const firstPayload = await firstRes.json();
      expect(firstPayload).toMatchObject({
        goal: {
          status: 'running',
          currentTask: { taskId: 'task_no_review_2', status: 'ready' },
          taskCounts: { completed: 1, pending: 0, ready: 1 },
        },
        decision: { outcome: 'continue', shouldStop: false, stopReason: 'completed' },
        pendingAttention: null,
      });
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

      const secondRes = await app.request(href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'req_goal_no_review_2',
          reviewPolicyOverride: 'none',
        }),
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
        decision: { outcome: 'complete', shouldStop: true, stopReason: 'completed' },
        pendingAttention: null,
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

  it('rolls back review creation when the reviewing goal transition fails', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Atomic goal review thread');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-atomic-goal-review-repo-'));
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
        verificationChecks: [{ kind: 'manual', description: 'Review worker evidence.' }],
        status: 'ready',
      });
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER fail_goal_review_transition
        BEFORE UPDATE OF status ON goal_records
        WHEN NEW.goal_id = 'goal_atomic_review' AND NEW.status = 'reviewing'
        BEGIN
          SELECT RAISE(ABORT, 'injected goal review transition failure');
        END;
      `);

      const app = createApp({
        coreDb,
        store,
        turnExecutor: createCompletingGoalTurnExecutor(),
      });
      const stepRes = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: 'req_goal_atomic_review' }),
        }
      );

      expect(stepRes.status).toBe(400);
      await expect(stepRes.json()).resolves.toMatchObject({ code: 'goal_step_failed' });
      expect(
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        }).find((goal) => goal.goalId === 'goal_atomic_review')
      ).toMatchObject({ status: 'failed', terminalStopReason: 'error' });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_atomic_review',
        })
      ).toEqual([expect.objectContaining({ taskId: 'task_atomic_review', status: 'completed' })]);
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_atomic_review',
          taskId: 'task_atomic_review',
        })
      ).toEqual([]);
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
            const artifact = workerStore.createArtifact({
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
            workerStore.createItem({
              id: `it_async_artifact_${turnId}`,
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId,
              type: 'artifact-reference',
              status: 'completed',
              artifactId: artifact.id,
              title: artifact.title,
              summary: artifact.summary,
              createdAt: timestamp,
              completedAt: timestamp,
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
          body: JSON.stringify({
            requestId: 'req_goal_async_step',
            reviewPolicyOverride: 'human',
          }),
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
        worker: {
          stopReason: 'completed',
          checkpointStage: 'completed',
          evidence: {
            artifactIds: expect.arrayContaining([expect.stringMatching(/^art_async_/)]),
          },
        },
      });
      const reviews = listGoalReviewRecordsForTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_async_step',
        taskId: 'task_async_step',
      }).filter((review) => review.resolvedAt === null);

      expect(reviews).toEqual([expect.objectContaining({ verdict: 'accept' })]);
      const attentionRes = await app.request('/api/app/workspaces/ws_demo/action-center');
      await expect(attentionRes.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            source: expect.objectContaining({
              type: 'goal_review',
              reviewId: reviews[0]!.reviewId,
            }),
            actions: expect.arrayContaining([expect.objectContaining({ kind: 'accept_review' })]),
          }),
        ]),
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps a Goal Mode step active when the worker pauses for human approval', async () => {
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
        verificationChecks: [{ kind: 'manual', description: 'Review the approval row.' }],
        status: 'ready',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const app = createApp({ coreDb, store, turnExecutor: new SimulatedTurnExecutor() });
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
        worker: {
          stopReason: 'ask_user',
          checkpointStage: 'waiting_for_user',
        },
        contextAssembly: {
          contextRefs: expect.arrayContaining([
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: thread.id },
            { kind: 'item', id: `it_context_${thread.id}` },
          ]),
          repositoryResourceId: 'repo_default',
          steeringMessageCount: 0,
          followUpInputCount: 0,
        },
        decision: {
          outcome: 'ask_user',
          shouldStop: true,
        },
        pendingAttention: {
          kind: 'user_input',
        },
      });

      const attentionRes = await app.request('/api/app/workspaces/ws_demo/action-center');
      expect(attentionRes.status).toBe(200);
      await expect(attentionRes.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: 'approval',
            source: expect.objectContaining({ type: 'approval' }),
          }),
        ]),
      });

      const recoveryRes = await app.request('/api/app/recovery/interrupted-workers');
      expect(recoveryRes.status).toBe(200);
      await expect(recoveryRes.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            checkpointId: `ws_demo:${thread.id}:${stepPayload.worker.turnId}`,
            choices: expect.arrayContaining([
              expect.objectContaining({ kind: 'inspect', recommended: true }),
              expect.objectContaining({ kind: 'retry' }),
              expect.objectContaining({ kind: 'record_terminal' }),
              expect.objectContaining({ kind: 'request_human' }),
            ]),
            contextAssembly: {
              contextDigest: stepPayload.contextAssembly.contextDigest,
              contextRefs: expect.arrayContaining([
                { kind: 'workspace', id: 'ws_demo' },
                { kind: 'thread', id: thread.id },
                { kind: 'item', id: `it_context_${thread.id}` },
              ]),
              repositoryResourceId: 'repo_default',
              steeringMessageCount: 0,
              followUpInputCount: 0,
            },
          }),
        ]),
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
