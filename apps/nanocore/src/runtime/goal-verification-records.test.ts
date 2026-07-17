import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createGoalRecord, createGoalTask } from './goal-store.js';
import {
  createGoalVerificationRecord,
  getGoalVerificationRecord,
  listGoalVerificationRecordsForGoal,
  listGoalVerificationRecordsForTask,
} from './goal-verification-records.js';

/**
 * Opens a migrated Core database for goal verification record tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-verification-records-'));
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
 * Creates one goal with two tasks owned by the demo workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 */
function seedGoalTasks(workspaceDb: WorkspaceDb): void {
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
    planItemId: 'item_plan_demo',
    taskId: 'task_demo',
    title: 'Verify task',
    objective: 'Run focused verification.',
    orderIndex: 1,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Verification evidence is durable.'],
    contextBudgetTokens: 8000,
    resources: [],
    expectedArtifacts: [{ kind: 'test-result', description: 'Focused verification results.' }],
    verificationChecks: [
      {
        kind: 'test',
        description: 'Run the focused NanoCore tests.',
        command: 'pnpm --filter @openkit/nanocore test',
      },
    ],
    reviewPolicy: {
      required: true,
      reviewers: ['human'],
      instructions: 'Review the focused verification results.',
    },
    escalationConditions: [],
    now: () => '2026-05-31T00:01:00.000Z',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    planItemId: 'item_plan_demo',
    taskId: 'task_other',
    title: 'Other task',
    objective: 'Run other verification.',
    orderIndex: 2,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Other verification is durable.'],
    contextBudgetTokens: 8000,
    resources: [],
    expectedArtifacts: [{ kind: 'test-result', description: 'Other verification results.' }],
    verificationChecks: [
      { kind: 'manual', description: 'Confirm the other verification result is durable.' },
    ],
    reviewPolicy: {
      required: true,
      reviewers: ['human'],
      instructions: 'Review the other verification results.',
    },
    escalationConditions: [],
    now: () => '2026-05-31T00:01:30.000Z',
  });
}

describe('goal verification records', () => {
  it('creates, reads, and lists verification records by goal and task', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTasks(workspaceDb);

      const record = createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        commandId: 'cmd_test',
        command: 'pnpm --filter @openkit/nanocore test',
        status: 'passed',
        summary: 'Focused tests passed.',
        itemIds: ['item_result'],
        artifactIds: ['artifact_log'],
        outputPointers: ['logs/verify-demo.txt'],
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(record).toEqual({
        verificationId: 'verify_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        commandId: 'cmd_test',
        command: 'pnpm --filter @openkit/nanocore test',
        status: 'passed',
        summary: 'Focused tests passed.',
        itemIds: ['item_result'],
        artifactIds: ['artifact_log'],
        outputPointers: ['logs/verify-demo.txt'],
        createdAt: '2026-05-31T00:02:00.000Z',
        updatedAt: '2026-05-31T00:02:00.000Z',
      });
      expect(
        getGoalVerificationRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo', 'verify_demo')
      ).toEqual(record);
      expect(
        listGoalVerificationRecordsForGoal(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        }).map((verification) => verification.verificationId)
      ).toEqual(['verify_demo']);
      expect(
        listGoalVerificationRecordsForTask(workspaceDb, {
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

  it('records an audit event when verification evidence is stored', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTasks(workspaceDb);

      createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_audit',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        commandId: 'cmd_test',
        command: 'pnpm --filter @openkit/nanocore test',
        status: 'failed',
        summary: 'Focused tests failed.',
        now: () => '2026-05-31T00:02:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'goal.verification.record'`
          )
          .all()
      ).toEqual([
        {
          action: 'goal.verification.record',
          category: 'system',
          outcome: 'failed',
          resource: 'goal-verification:verify_audit',
          severity: 'warning',
          summary: 'Goal verification failed: Focused tests failed.',
          thread_id: 'th_demo',
          turn_id: 'turn_worker',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('lists goal verification records across tasks in deterministic order', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTasks(workspaceDb);

      createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_later',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_other',
        command: 'pnpm build',
        status: 'failed',
        summary: 'Build failed.',
        now: () => '2026-05-31T00:04:00.000Z',
      });
      createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_first',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        command: 'pnpm test',
        status: 'passed',
        summary: 'Tests passed.',
        now: () => '2026-05-31T00:03:00.000Z',
      });

      expect(
        listGoalVerificationRecordsForGoal(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        }).map((verification) => verification.verificationId)
      ).toEqual(['verify_first', 'verify_later']);
      expect(
        listGoalVerificationRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_other',
        }).map((verification) => verification.verificationId)
      ).toEqual(['verify_later']);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('redacts secret-like values before storing command, summary, and output pointers', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTasks(workspaceDb);

      const record = createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_redacted',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        command: 'OPENAI_API_KEY=sk-command pnpm test',
        status: 'failed',
        summary: 'Authorization: Bearer live_secret token=tok_secret failed.',
        outputPointers: ['logs/token=tok_secret/verify.txt'],
      });
      const serialized = JSON.stringify(record);

      expect(record.command).toBe('OPENAI_API_KEY=[redacted] pnpm test');
      expect(record.summary).toBe('Authorization: Bearer [redacted] token=[redacted] failed.');
      expect(serialized).not.toContain('sk-command');
      expect(serialized).not.toContain('tok_secret');
      expect(serialized).not.toContain('live_secret');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('represents unavailable manual verification without a command or task', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTasks(workspaceDb);

      const record = createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_manual',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: null,
        command: null,
        status: 'unavailable',
        summary: 'Manual verification is unavailable until a reviewer is assigned.',
      });

      expect(record).toMatchObject({
        taskId: null,
        command: null,
        status: 'unavailable',
        outputPointers: [],
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
