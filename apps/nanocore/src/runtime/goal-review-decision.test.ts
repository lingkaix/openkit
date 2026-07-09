import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { applyGoalReviewDecision } from './goal-review-decision.js';
import { createGoalRecord, createGoalTask, getGoalRecord } from './goal-store.js';

/**
 * Opens a migrated workspace database for goal review decision tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-review-decision-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one running goal with one reviewing task.
 *
 * @param workspaceDb Open workspace database handles.
 */
function seedReviewingTask(workspaceDb: WorkspaceDb): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Ship release',
    objective: 'Make v0.0.6 ready for release.',
    status: 'reviewing',
    now: () => '2026-05-31T00:00:00.000Z',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    taskId: 'task_demo',
    title: 'Review task',
    objective: 'Review completed worker output.',
    orderIndex: 1,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Review decision is deterministic.'],
    contextBudgetTokens: 8000,
    status: 'reviewing',
    now: () => '2026-05-31T00:01:00.000Z',
  });
}

describe('goal review decision helper', () => {
  it('accepts reviewed work and moves the task toward completion', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedReviewingTask(workspaceDb);

      const result = applyGoalReviewDecision(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'accept',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(result).toMatchObject({
        outcome: 'continue',
        terminal: false,
        task: {
          taskId: 'task_demo',
          status: 'completed',
          updatedAt: '2026-05-31T00:02:00.000Z',
        },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('maps refine and decompose decisions to needs_revision', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedReviewingTask(workspaceDb);

      const refine = applyGoalReviewDecision(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'refine',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(refine.outcome).toBe('needs_revision');
      expect(refine.task.status).toBe('needs_revision');

      const decompose = applyGoalReviewDecision(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'decompose',
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(decompose.outcome).toBe('decompose');
      expect(decompose.task.status).toBe('needs_revision');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('maps retry decisions back to ready for another worker attempt', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedReviewingTask(workspaceDb);

      const result = applyGoalReviewDecision(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'retry',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(result.outcome).toBe('retry');
      expect(result.task.status).toBe('ready');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('creates an awaiting_human outcome for ask_user decisions', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedReviewingTask(workspaceDb);

      const result = applyGoalReviewDecision(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'ask_user',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(result).toMatchObject({
        outcome: 'awaiting_human',
        terminal: false,
        task: { status: 'reviewing' },
        goal: { status: 'awaiting_user' },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('maps block and abort decisions to terminal outcomes', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      seedReviewingTask(workspaceDb);

      const blocked = applyGoalReviewDecision(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'block',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(blocked).toMatchObject({
        outcome: 'blocked',
        terminal: true,
        task: { status: 'blocked' },
        goal: { status: 'blocked' },
      });

      const abortedGoal = getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo');
      expect(abortedGoal?.terminalStopReason).toBe('ask_user');

      const aborted = applyGoalReviewDecision(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'abort',
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(aborted).toMatchObject({
        outcome: 'aborted',
        terminal: true,
        task: { status: 'failed' },
        goal: { status: 'aborted', terminalStopReason: 'aborted' },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
