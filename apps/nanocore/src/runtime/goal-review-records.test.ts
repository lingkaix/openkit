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
import { createGoalRecord, createGoalTask } from './goal-store.js';

/**
 * Opens a migrated Core database for Goal Review record tests.
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
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one Goal and reviewing Task owned by the demo workspace.
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
    status: 'reviewing',
    currentTaskId: 'task_demo',
    now: () => '2026-05-31T00:00:00.000Z',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    planItemId: 'item_plan_demo',
    taskId: 'task_demo',
    title: 'Review task',
    objective: 'Review completed worker output.',
    orderIndex: 1,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Review evidence is durable.'],
    contextBudgetTokens: 8000,
    resources: [],
    expectedArtifacts: [{ kind: 'artifact', description: 'Durable review evidence.' }],
    verificationChecks: [
      { kind: 'manual', description: 'Confirm the review evidence is complete.' },
    ],
    reviewPolicy: {
      required: true,
      reviewers: ['human'],
      instructions: 'Review the completed worker output.',
    },
    escalationConditions: [],
    status: 'reviewing',
    now: () => '2026-05-31T00:01:00.000Z',
  });
}

/**
 * Creates one unresolved Review with complete creation lineage.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param reviewId Stable Review id.
 * @param createdAt Deterministic creation timestamp.
 * @returns Stored unresolved Review.
 */
function createUnresolvedReview(
  workspaceDb: WorkspaceDb,
  reviewId = 'review_demo',
  createdAt = '2026-05-31T00:02:00.000Z'
) {
  return createGoalReviewRecord(workspaceDb, {
    reviewId,
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
    prompt: 'Review the worker evidence against the accepted Task.',
    createdByRequestId: 'goal-step-1',
    now: () => createdAt,
  });
}

describe('goal review records', () => {
  it('creates, reads, and lists an unresolved Review by Goal Task', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);
      const record = createUnresolvedReview(workspaceDb);

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
        prompt: 'Review the worker evidence against the accepted Task.',
        createdByRequestId: 'goal-step-1',
        verdict: null,
        reason: null,
        revisionInstruction: null,
        createdAt: '2026-05-31T00:02:00.000Z',
        updatedAt: '2026-05-31T00:02:00.000Z',
        resolvedAt: null,
        resolutionRequestId: null,
        resolvedByActorId: null,
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

  it('lists Reviews in deterministic Task order', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);
      createUnresolvedReview(workspaceDb, 'review_later', '2026-05-31T00:04:00.000Z');
      createUnresolvedReview(workspaceDb, 'review_first', '2026-05-31T00:03:00.000Z');

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

  it('redacts creation evidence and records an unresolved-review audit event', () => {
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
        turnId: 'turn_worker',
        verificationEvidence: [
          { summary: 'Authorization: Bearer live_secret token=tok_secret api_key=sk-review' },
        ],
        prompt: 'Review token=tok_secret before deciding.',
        createdByRequestId: 'goal-step-secret',
        now: () => '2026-05-31T00:02:00.000Z',
      });
      const serialized = JSON.stringify(record);

      expect(record.prompt).toBe('Review token=[redacted] before deciding.');
      expect(serialized).not.toContain('tok_secret');
      expect(serialized).not.toContain('live_secret');
      expect(serialized).not.toContain('sk-review');
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, outcome, severity, summary
            FROM audit_events
            WHERE action = 'goal.review.record'`
          )
          .all()
      ).toEqual([
        {
          action: 'goal.review.record',
          outcome: 'succeeded',
          severity: 'info',
          summary: 'Goal review requested: Review token=[redacted] before deciding.',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects Review records outside the requested Goal Task scope', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);
      const base = {
        reviewId: 'review_wrong_scope',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        prompt: 'Review this Task.',
        createdByRequestId: 'goal-step-1',
      };

      expect(() =>
        createGoalReviewRecord(workspaceDb, { ...base, goalId: 'goal_missing' })
      ).toThrow('Goal not found: ws_demo/th_demo/goal_missing');
      expect(() =>
        createGoalReviewRecord(workspaceDb, {
          ...base,
          goalId: 'goal_demo',
          taskId: 'task_missing',
        })
      ).toThrow('Goal task not found: goal_demo/task_missing');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('resolves once, replays the winner, and rejects conflicting or stale decisions', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);
      createUnresolvedReview(workspaceDb, 'review_resolved');
      const resolutionSnapshot = {
        outcome: 'retry' as const,
        task: { taskId: 'task_demo', status: 'ready' as const },
        goal: {
          goalId: 'goal_demo',
          status: 'running' as const,
          currentTaskId: null,
          terminalStopReason: null,
        },
        nextReadyTaskId: 'task_demo',
      };
      const decision = {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        reviewId: 'review_resolved',
        requestId: 'review-resolution-1',
        actorId: 'user_demo',
        verdict: 'retry' as const,
        reason: 'Retry with token=tok_secret.',
        resolutionSnapshot,
        now: () => '2026-05-31T00:03:00.000Z',
      };

      const resolved = resolveGoalReviewRecord(workspaceDb, decision);

      expect(resolved).toMatchObject({
        verdict: 'retry',
        reason: 'Retry with token=[redacted]',
        revisionInstruction: null,
        resolvedAt: '2026-05-31T00:03:00.000Z',
        resolutionRequestId: 'review-resolution-1',
        resolvedByActorId: 'user_demo',
        resolutionSnapshot,
      });
      expect(resolveGoalReviewRecord(workspaceDb, decision)).toEqual(resolved);
      expect(() =>
        resolveGoalReviewRecord(workspaceDb, {
          ...decision,
          verdict: 'abort',
          reason: 'Abort instead.',
        })
      ).toThrowError(expect.objectContaining({ code: 'idempotency_key_conflict' }));
      expect(() =>
        resolveGoalReviewRecord(workspaceDb, {
          ...decision,
          requestId: 'review-resolution-2',
        })
      ).toThrowError(expect.objectContaining({ code: 'stale' }));
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects a partially persisted decision tuple as recovery-required state', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb);
      createUnresolvedReview(workspaceDb, 'review_partial');
      workspaceDb.sqlite
        .prepare(
          `UPDATE goal_review_records
          SET verdict = 'accept'
          WHERE workspace_id = 'ws_demo' AND review_id = 'review_partial'`
        )
        .run();

      expect(() =>
        getGoalReviewRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo', 'review_partial')
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
