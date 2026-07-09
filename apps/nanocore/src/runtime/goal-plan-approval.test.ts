import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createDeterministicGoalPlanFallback } from './goal-plan.js';
import { approveGoalPlan, rejectGoalPlan, reviseGoalPlan } from './goal-plan-approval.js';
import { createGoalRecord, getGoalRecord } from './goal-store.js';

/**
 * Opens a migrated workspace database for goal plan approval tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-plan-approval-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('goal plan approval flow', () => {
  it('approves a plan into ready task state without starting a worker', () => {
    const workspaceDb = createWorkspaceDb();

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

      const result = approveGoalPlan({
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_approval',
        planItemId: 'it_goal_plan_goal_approval',
        plan,
      });

      expect(result).toEqual({
        status: 'approved',
        startsWorkerTurn: false,
        readyTasks: [{ taskId: 'task_1', status: 'ready' }],
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_approval')).toMatchObject({
        status: 'running',
        planItemId: 'it_goal_plan_goal_approval',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects a plan into awaiting user or blocked state with a reason', () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Reject plan thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_reject',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Reject plan',
        objective: 'Reject the current plan.',
      });

      const result = rejectGoalPlan({
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_reject',
        reason: 'The plan needs a smaller first task.',
        nextStatus: 'awaiting_user',
      });

      expect(result).toMatchObject({
        status: 'awaiting_user',
        startsWorkerTurn: false,
        reasonItem: {
          type: 'status',
          title: 'Plan rejected',
          summary: 'The plan needs a smaller first task.',
        },
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_reject')).toMatchObject({
        status: 'awaiting_user',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records revision input and returns the goal to planning without starting a worker', () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Revise plan thread');

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_revise',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Revise plan',
        objective: 'Revise the current plan.',
      });

      const result = reviseGoalPlan({
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_revise',
        revision: 'Split the first task into setup and implementation.',
      });

      expect(result).toMatchObject({
        status: 'planning',
        startsWorkerTurn: false,
        revisionItem: {
          type: 'user-message',
          text: 'Split the first task into setup and implementation.',
        },
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', thread.id, 'goal_revise')).toMatchObject({
        status: 'planning',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
