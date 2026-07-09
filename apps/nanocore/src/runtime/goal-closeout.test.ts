import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { closeGoalRun } from './goal-closeout.js';
import { createGoalRecord, createGoalTask, getGoalRecord } from './goal-store.js';
import { createGoalVerificationRecord } from './goal-verification-records.js';

/**
 * Opens a migrated Core database for goal closeout tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-closeout-'));
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
 * Creates one goal with two task rows.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param statuses Task statuses to store.
 */
function seedGoalTasks(
  workspaceDb: WorkspaceDb,
  statuses: readonly ['completed' | 'skipped' | 'blocked', 'completed' | 'skipped' | 'blocked']
): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Close goal',
    objective: 'Close a completed goal.',
    status: 'verifying',
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
    acceptanceCriteria: ['First task is accepted.'],
    contextBudgetTokens: 8000,
    status: statuses[0],
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    taskId: 'task_2',
    title: 'Second task',
    objective: 'Complete second task.',
    orderIndex: 2,
    dependsOnTaskIds: ['task_1'],
    acceptanceCriteria: ['Second task is accepted.'],
    contextBudgetTokens: 8000,
    status: statuses[1],
  });
}

describe('goal closeout', () => {
  it('completes a goal after required tasks and verification pass', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTasks(workspaceDb, ['completed', 'skipped']);
      createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_final',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        status: 'passed',
        command: 'pnpm -w verify:release',
        summary: 'Release verification passed.',
        artifactIds: ['artifact_release_log'],
        outputPointers: ['logs/release.txt'],
      });

      const result = closeGoalRun(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        suggestedNextWork: ['Publish v0.0.6.'],
        now: () => '2026-05-31T00:05:00.000Z',
      });

      expect(result).toMatchObject({
        status: 'completed',
        stopReason: 'completed',
        summary: {
          completedTaskIds: ['task_1'],
          skippedTaskIds: ['task_2'],
          artifactIds: ['artifact_release_log'],
          verificationEvidenceIds: ['verify_final'],
          risks: [],
          suggestedNextWork: ['Publish v0.0.6.'],
        },
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo')).toMatchObject({
        status: 'completed',
        terminalStopReason: 'completed',
        updatedAt: '2026-05-31T00:05:00.000Z',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('blocks closeout when a required task or verification is not accepted', () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTasks(workspaceDb, ['completed', 'blocked']);
      createGoalVerificationRecord(workspaceDb, {
        verificationId: 'verify_failed',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_2',
        status: 'failed',
        command: 'pnpm test',
        summary: 'Tests failed.',
      });

      const result = closeGoalRun(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
      });

      expect(result).toMatchObject({
        status: 'blocked',
        stopReason: 'ask_user',
        summary: {
          completedTaskIds: ['task_1'],
          blockedTaskIds: ['task_2'],
          verificationEvidenceIds: ['verify_failed'],
          risks: [
            '1 required task is blocked or failed.',
            'No passing final verification record is available.',
          ],
        },
      });
      expect(getGoalRecord(workspaceDb, 'ws_demo', 'th_demo', 'goal_demo')?.status).toBe('blocked');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
