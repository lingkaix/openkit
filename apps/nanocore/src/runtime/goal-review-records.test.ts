import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createGoalReviewRecord,
  getGoalReviewRecord,
  listGoalReviewRecordsForTask,
  resolveGoalReviewRecord,
} from './goal-review-records.js';
import { createGoalRecord, createGoalTask, getGoalRecord, listGoalTasks } from './goal-store.js';

/**
 * Opens a migrated Core database for goal review record tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-review-records-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Opens a migrated workspace database paired with the Core database.
 *
 * @param coreDb Migrated Core database handles.
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one goal and task owned by the demo workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 */
function seedGoalTask(workspaceDb: WorkspaceDb): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Ship release',
    objective: 'Make v0.0.6 ready for release.',
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
    acceptanceCriteria: ['Review evidence is durable.'],
    contextBudgetTokens: 8000,
    now: () => '2026-05-31T00:01:00.000Z',
  });
}

describe('goal review records', () => {
  it('creates, reads, and lists review records by goal task', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);

      const record = createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        itemIds: ['item_result', 'item_review'],
        artifactIds: ['artifact_patch'],
        verificationEvidence: [
          {
            commandId: 'verify_test',
            status: 'passed',
            summary: 'Focused tests passed.',
          },
        ],
        verdict: 'accept',
        reason: 'Worker output satisfies the acceptance criteria.',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(record).toEqual({
        reviewId: 'review_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        itemIds: ['item_result', 'item_review'],
        artifactIds: ['artifact_patch'],
        verificationEvidence: [
          {
            commandId: 'verify_test',
            status: 'passed',
            summary: 'Focused tests passed.',
          },
        ],
        verdict: 'accept',
        reason: 'Worker output satisfies the acceptance criteria.',
        createdAt: '2026-05-31T00:02:00.000Z',
        updatedAt: '2026-05-31T00:02:00.000Z',
        resolvedAt: null,
        resolutionRequestId: null,
        resolutionSnapshot: null,
      });
      expect(
        getGoalReviewRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo', 'review_demo')
      ).toEqual(record);
      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
        })
      ).toEqual([record]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('lists review records in deterministic task order', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);

      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_later',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'retry',
        reason: 'Retry with clearer verification evidence.',
        now: () => '2026-05-31T00:04:00.000Z',
      });
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_first',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'refine',
        reason: 'Refine the implementation details.',
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(
        listGoalReviewRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
        }).map((record) => record.reviewId)
      ).toEqual(['review_first', 'review_later']);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records an audit event when a goal review record is stored', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);

      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_audit',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        verdict: 'retry',
        reason: 'Retry with stronger verification.',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'goal.review.record'`
          )
          .all()
      ).toEqual([
        {
          action: 'goal.review.record',
          category: 'system',
          outcome: 'failed',
          resource: 'goal-review:review_audit',
          severity: 'warning',
          summary: 'Goal review retry: Retry with stronger verification.',
          thread_id: 'th_demo',
          turn_id: 'turn_worker',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('redacts secret-like values before storing reason and evidence', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);

      const record = createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_redacted',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        itemIds: ['item_result'],
        artifactIds: ['artifact_patch'],
        verificationEvidence: [
          {
            commandId: 'verify_secret',
            summary: 'Authorization: Bearer live_secret token=tok_secret api_key=sk-review',
          },
        ],
        verdict: 'block',
        reason: 'Blocked by token=tok_secret and Authorization: Bearer live_secret.',
      });
      const serialized = JSON.stringify(record);

      expect(record.reason).toBe(
        'Blocked by token=[redacted] and Authorization: Bearer [redacted]'
      );
      expect(serialized).not.toContain('tok_secret');
      expect(serialized).not.toContain('live_secret');
      expect(serialized).not.toContain('sk-review');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects review records outside the requested goal task scope', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);

      expect(() =>
        createGoalReviewRecord(workspaceDb, {
          reviewId: 'review_wrong_goal',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_missing',
          taskId: 'task_demo',
          verdict: 'accept',
          reason: 'Should not persist.',
        })
      ).toThrow('Goal not found: ws_demo/th_demo/goal_missing');

      expect(() =>
        createGoalReviewRecord(workspaceDb, {
          reviewId: 'review_wrong_task',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_missing',
          verdict: 'accept',
          reason: 'Should not persist.',
        })
      ).toThrow('Goal task not found: goal_demo/task_missing');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('marks a goal review record resolved with a request id', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_resolved',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        verdict: 'retry',
        reason: 'Retry with stronger verification.',
        now: () => '2026-05-31T00:02:00.000Z',
      });
      const goal = getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo')!;
      const task = listGoalTasks(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
      })[0]!;
      const resolutionSnapshot = {
        outcome: 'retry' as const,
        task: { ...task, status: 'ready' as const },
        goal: { ...goal, status: 'running' as const, currentTaskId: task.taskId },
        nextTask: { ...task, status: 'ready' as const },
      };

      const resolved = resolveGoalReviewRecord(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        reviewId: 'review_resolved',
        requestId: 'review-resolution-1',
        resolutionSnapshot,
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(resolved).toMatchObject({
        reviewId: 'review_resolved',
        resolvedAt: '2026-05-31T00:03:00.000Z',
        resolutionRequestId: 'review-resolution-1',
        resolutionSnapshot,
        updatedAt: '2026-05-31T00:03:00.000Z',
      });
      expect(
        getGoalReviewRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo', 'review_resolved')
      ).toMatchObject({
        resolvedAt: '2026-05-31T00:03:00.000Z',
        resolutionRequestId: 'review-resolution-1',
        resolutionSnapshot,
      });
      expect(
        resolveGoalReviewRecord(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          reviewId: 'review_resolved',
          requestId: 'review-resolution-2',
          resolutionSnapshot: {
            outcome: 'complete_goal',
            task: { ...task, status: 'completed' },
            goal: { ...goal, status: 'completed', currentTaskId: null },
            nextTask: null,
          },
          now: () => '2026-05-31T00:04:00.000Z',
        })
      ).toEqual(resolved);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
