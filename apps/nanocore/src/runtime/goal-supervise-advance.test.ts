import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createGoalRecord, createGoalTask, getGoalRecord, listGoalTasks } from './goal-store.js';
import { advanceGoalAfterReview } from './goal-supervise-advance.js';

/**
 * Opens a migrated workspace database for supervise advance tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-supervise-advance-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one reviewing task and one dependent pending task.
 *
 * @param workspaceDb Open workspace database handles.
 */
function seedDependentGoal(workspaceDb: WorkspaceDb): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Advance goal',
    objective: 'Advance after review.',
    status: 'reviewing',
    now: () => '2026-05-31T00:00:00.000Z',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    taskId: 'task_1',
    title: 'First task',
    objective: 'Complete first task.',
    orderIndex: 1,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['First task accepted.'],
    contextBudgetTokens: 8000,
    status: 'reviewing',
    now: () => '2026-05-31T00:01:00.000Z',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    taskId: 'task_2',
    title: 'Second task',
    objective: 'Continue with second task.',
    orderIndex: 2,
    dependsOnTaskIds: ['task_1'],
    acceptanceCriteria: ['Second task becomes ready.'],
    contextBudgetTokens: 8000,
    status: 'pending',
    now: () => '2026-05-31T00:01:30.000Z',
  });
}

describe('goal supervise advance', () => {
  it('accepts a task and unlocks the next dependent task', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedDependentGoal(workspaceDb);

      const result = advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_1',
        verdict: 'accept',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(result).toMatchObject({
        outcome: 'complete_next_task',
        nextTask: { taskId: 'task_2', status: 'ready' },
        task: { taskId: 'task_1', status: 'completed' },
        goal: { status: 'running', currentTaskId: 'task_2' },
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        }).map((task) => ({ taskId: task.taskId, status: task.status }))
      ).toEqual([
        { taskId: 'task_1', status: 'completed' },
        { taskId: 'task_2', status: 'ready' },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not unlock dependents when review needs revision', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedDependentGoal(workspaceDb);

      const result = advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_1',
        verdict: 'refine',
      });

      expect(result).toMatchObject({
        outcome: 'needs_revision',
        nextTask: null,
        task: { taskId: 'task_1', status: 'needs_revision' },
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        }).find((task) => task.taskId === 'task_2')?.status
      ).toBe('pending');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('keeps retry tasks ready without unlocking dependents', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedDependentGoal(workspaceDb);

      const result = advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_1',
        verdict: 'retry',
      });

      expect(result).toMatchObject({
        outcome: 'retry',
        nextTask: { taskId: 'task_1', status: 'ready' },
        task: { taskId: 'task_1', status: 'ready' },
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        }).find((task) => task.taskId === 'task_2')?.status
      ).toBe('pending');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('moves blocked review outcomes into blocked goal state', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedDependentGoal(workspaceDb);

      const result = advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_1',
        verdict: 'block',
      });

      expect(result).toMatchObject({
        outcome: 'blocked',
        nextTask: null,
        task: { status: 'blocked' },
        goal: { status: 'blocked' },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('completes the goal when accepted work leaves no next task', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedDependentGoal(workspaceDb);
      advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_1',
        verdict: 'accept',
      });

      const result = advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_2',
        verdict: 'accept',
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(result).toMatchObject({
        outcome: 'complete_goal',
        nextTask: null,
        task: { taskId: 'task_2', status: 'completed' },
        goal: { status: 'completed', currentTaskId: null, terminalStopReason: 'completed' },
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo')?.status).toBe(
        'completed'
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
