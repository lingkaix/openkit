import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  createGoalRecord,
  createGoalTask,
  getGoalRecord,
  listGoalTasks,
  updateGoalStatus,
  updateGoalTask,
} from './goal-store.js';
import { advanceGoalAfterReview } from './goal-supervise-advance.js';

/**
 * Opens a migrated workspace database for supervise advance tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-supervise-advance-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
    currentTaskId: 'task_1',
    now: () => '2026-05-31T00:00:00.000Z',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    planItemId: 'item_plan_demo',
    taskId: 'task_1',
    title: 'First task',
    objective: 'Complete first task.',
    orderIndex: 1,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['First task accepted.'],
    contextBudgetTokens: 8000,
    resources: [],
    expectedArtifacts: [{ kind: 'artifact', description: 'First task result.' }],
    verificationChecks: [
      { kind: 'manual', description: 'Confirm the first task meets its acceptance criterion.' },
    ],
    reviewPolicy: {
      required: true,
      reviewers: ['human'],
      instructions: 'Review the first task result.',
    },
    escalationConditions: [],
    status: 'reviewing',
    now: () => '2026-05-31T00:01:00.000Z',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    planItemId: 'item_plan_demo',
    taskId: 'task_2',
    title: 'Second task',
    objective: 'Continue with second task.',
    orderIndex: 2,
    dependsOnTaskIds: ['task_1'],
    acceptanceCriteria: ['Second task becomes ready.'],
    contextBudgetTokens: 8000,
    resources: [],
    expectedArtifacts: [{ kind: 'artifact', description: 'Second task result.' }],
    verificationChecks: [
      { kind: 'manual', description: 'Confirm the second task meets its acceptance criterion.' },
    ],
    reviewPolicy: {
      required: true,
      reviewers: ['human'],
      instructions: 'Review the second task result.',
    },
    escalationConditions: [],
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

      expect(result).toEqual({
        outcome: 'complete_next_task',
        task: { taskId: 'task_1', status: 'completed' },
        goal: {
          goalId: 'goal_demo',
          status: 'running',
          currentTaskId: null,
          terminalStopReason: null,
        },
        nextReadyTaskId: 'task_2',
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

  it('returns the reviewed task to ready when refinement is requested', () => {
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

      expect(result).toEqual({
        outcome: 'refine',
        task: { taskId: 'task_1', status: 'ready' },
        goal: {
          goalId: 'goal_demo',
          status: 'running',
          currentTaskId: null,
          terminalStopReason: null,
        },
        nextReadyTaskId: 'task_1',
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

      expect(result).toEqual({
        outcome: 'retry',
        task: { taskId: 'task_1', status: 'ready' },
        goal: {
          goalId: 'goal_demo',
          status: 'running',
          currentTaskId: null,
          terminalStopReason: null,
        },
        nextReadyTaskId: 'task_1',
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

  it('aborts the goal and fails the reviewed task', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedDependentGoal(workspaceDb);

      const result = advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_1',
        verdict: 'abort',
      });

      expect(result).toEqual({
        outcome: 'aborted',
        task: { taskId: 'task_1', status: 'failed' },
        goal: {
          goalId: 'goal_demo',
          status: 'aborted',
          currentTaskId: null,
          terminalStopReason: 'aborted',
        },
        nextReadyTaskId: null,
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
      updateGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_2',
        status: 'reviewing',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        status: 'reviewing',
        currentTaskId: 'task_2',
        terminalStopReason: null,
      });

      const result = advanceGoalAfterReview(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_2',
        verdict: 'accept',
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(result).toEqual({
        outcome: 'complete_goal',
        task: { taskId: 'task_2', status: 'completed' },
        goal: {
          goalId: 'goal_demo',
          status: 'completed',
          currentTaskId: null,
          terminalStopReason: 'completed',
        },
        nextReadyTaskId: null,
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo')?.status).toBe(
        'completed'
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
