import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createDeterministicGoalPlanFallback } from './goal-plan.js';
import { approveGoalPlan } from './goal-plan-approval.js';
import {
  createGoalPlanRecord,
  createGoalRecord,
  getGoalRecord,
  listGoalTasks,
  updateGoalStatus,
} from './goal-store.js';

const USER_ACTOR = { kind: 'user', id: 'user_demo' } as const;

/**
 * Opens a migrated workspace database for goal plan approval tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-plan-approval-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('goal plan approval flow', () => {
  it('loads the server-owned plan and atomically creates complete task snapshots', () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_approval',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Approve plan',
        objective: 'Approve the fallback plan.',
      });
      const plan = createDeterministicGoalPlanFallback({
        goalTitle: 'Approve plan',
        objective: 'Approve the fallback plan.',
      });
      const approvedPlan = {
        ...plan,
        tasks: [
          plan.tasks[0],
          {
            ...plan.tasks[0],
            taskId: 'task_2',
            title: 'Verify approved plan',
            dependsOnTaskIds: ['task_1'],
          },
        ],
      };
      const planTurn = store.createTurn('ws_demo', 'th_demo', 'Approve plan', USER_ACTOR);
      store.createItem({
        id: 'it_goal_plan_goal_approval',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: planTurn.id,
        type: 'plan',
        status: 'completed',
        title: 'Approve plan',
        summary: approvedPlan.goalSummary,
        steps: approvedPlan.tasks.map((task) => ({
          id: task.taskId,
          title: task.title,
          status: 'pending',
        })),
        createdAt: planTurn.startedAt ?? new Date().toISOString(),
        completedAt: planTurn.startedAt ?? new Date().toISOString(),
      });
      createGoalPlanRecord(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_approval',
        planItemId: 'it_goal_plan_goal_approval',
        plan: approvedPlan,
        createdByRequestId: 'req_goal_plan_create',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_approval',
        status: 'awaiting_plan_approval',
        planItemId: 'it_goal_plan_goal_approval',
      });

      const result = approveGoalPlan({
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_approval',
        planItemId: 'it_goal_plan_goal_approval',
      });

      expect(result).toEqual({
        status: 'approved',
        startsWorkerTurn: false,
        readyTasks: [{ taskId: 'task_1', status: 'ready' }],
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_approval')).toMatchObject({
        status: 'running',
        planItemId: 'it_goal_plan_goal_approval',
        currentTaskId: null,
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_approval',
        })
      ).toEqual([
        expect.objectContaining({
          ...plan.tasks[0],
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_approval',
          planItemId: 'it_goal_plan_goal_approval',
          orderIndex: 0,
          status: 'ready',
        }),
        expect.objectContaining({
          ...approvedPlan.tasks[1],
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_approval',
          planItemId: 'it_goal_plan_goal_approval',
          orderIndex: 1,
          status: 'pending',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects an invalid or corrupted stored plan before any approval mutation', () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_invalid_plan',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Reject plan',
        objective: 'Reject an invalid stored plan.',
      });
      const plan = createDeterministicGoalPlanFallback({
        goalTitle: 'Reject plan',
        objective: 'Reject an invalid stored plan.',
      });
      const planTurn = store.createTurn('ws_demo', 'th_demo', 'Reject plan', USER_ACTOR);
      store.createItem({
        id: 'it_goal_plan_invalid',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: planTurn.id,
        type: 'plan',
        status: 'completed',
        title: 'Reject plan',
        summary: plan.goalSummary,
        steps: plan.tasks.map((task) => ({
          id: task.taskId,
          title: task.title,
          status: 'pending',
        })),
        createdAt: planTurn.startedAt ?? new Date().toISOString(),
        completedAt: planTurn.startedAt ?? new Date().toISOString(),
      });
      createGoalPlanRecord(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_invalid_plan',
        planItemId: 'it_goal_plan_invalid',
        plan: {
          ...plan,
          tasks: [{ ...plan.tasks[0], dependsOnTaskIds: ['task_missing'] }],
        },
        createdByRequestId: 'req_goal_plan_invalid',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_invalid_plan',
        status: 'awaiting_plan_approval',
        planItemId: 'it_goal_plan_invalid',
      });

      expect(() =>
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_invalid_plan',
          planItemId: 'it_goal_plan_invalid',
        })
      ).toThrowError(expect.objectContaining({ code: 'goal_plan_invalid' }));
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_invalid_plan')).toMatchObject({
        status: 'awaiting_plan_approval',
        planItemId: 'it_goal_plan_invalid',
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_invalid_plan',
        })
      ).toEqual([]);

      workspaceDb.sqlite
        .prepare('UPDATE goal_plan_records SET plan_digest = ? WHERE plan_item_id = ?')
        .run(`sha256:${'0'.repeat(64)}`, 'it_goal_plan_invalid');
      expect(() =>
        approveGoalPlan({
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_invalid_plan',
          planItemId: 'it_goal_plan_invalid',
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects missing or non-Plan Item projections', () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_projection_lineage',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Verify plan projection',
        objective: 'Reject invalid Plan Item lineage.',
      });
      const plan = createDeterministicGoalPlanFallback({
        goalTitle: 'Verify plan projection',
        objective: 'Reject invalid Plan Item lineage.',
      });
      createGoalPlanRecord(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_projection_lineage',
        planItemId: 'it_goal_plan_missing',
        plan,
        createdByRequestId: 'req_goal_plan_missing',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_projection_lineage',
        status: 'awaiting_plan_approval',
        planItemId: 'it_goal_plan_missing',
      });
      const approvalInput = {
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_projection_lineage',
        planItemId: 'it_goal_plan_missing',
      } as const;

      expect(() => approveGoalPlan(approvalInput)).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );

      const wrongTypeTurn = store.createTurn(
        'ws_demo',
        'th_demo',
        'Wrong Plan Item type',
        USER_ACTOR
      );
      store.createItem({
        id: 'it_goal_plan_missing',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: wrongTypeTurn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'This Item cannot authorize Plan approval.',
        createdAt: wrongTypeTurn.startedAt ?? new Date().toISOString(),
        completedAt: wrongTypeTurn.startedAt ?? new Date().toISOString(),
      });
      expect(() => approveGoalPlan(approvalInput)).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
