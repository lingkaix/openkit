import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createGoalRecord, createGoalTask } from './goal-store.js';
import { runGoalTaskVerification } from './goal-task-verification.js';
import { listGoalVerificationRecordsForTask } from './goal-verification-records.js';

/**
 * Opens a migrated Core database for goal task verification tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-task-verification-'));
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
 * Creates one goal task with the provided verification checks.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param verificationChecks Verification checks stored on the task.
 */
function seedGoalTask(
  workspaceDb: WorkspaceDb,
  verificationChecks: Parameters<typeof createGoalTask>[1]['verificationChecks']
): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Verify release',
    objective: 'Verify v0.0.6 release work.',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    taskId: 'task_demo',
    title: 'Run verification',
    objective: 'Run configured verification.',
    orderIndex: 1,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Verification evidence is stored.'],
    contextBudgetTokens: 8000,
    verificationChecks,
  });
}

describe('goal task verification', () => {
  it('runs configured command verification and stores passed records', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb, [
        {
          kind: 'command',
          description: 'Run focused tests.',
          command: 'pnpm --filter @openkit/nanocore test',
        },
      ]);

      const result = await runGoalTaskVerification({
        coreDb,
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        idPrefix: 'verify_demo',
        runCommand: async (command) => ({
          outputPointers: ['logs/test.txt'],
          status: 'passed',
          summary: `Command passed: ${command}`,
        }),
      });

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        verificationId: 'verify_demo_1',
        taskId: 'task_demo',
        turnId: 'turn_worker',
        commandId: 'verify_demo_1_command',
        command: 'pnpm --filter @openkit/nanocore test',
        status: 'passed',
        summary: 'Command passed: pnpm --filter @openkit/nanocore test',
        outputPointers: ['logs/test.txt'],
      });
      expect(
        listGoalVerificationRecordsForTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
        })
      ).toEqual(result.records);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('stores failed command verification records', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb, [
        {
          kind: 'test',
          description: 'Run build.',
          command: 'pnpm build',
        },
      ]);

      const result = await runGoalTaskVerification({
        coreDb,
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        idPrefix: 'verify_failed',
        runCommand: async () => ({
          outputPointers: ['logs/build.txt'],
          status: 'failed',
          summary: 'Build failed.',
        }),
      });

      expect(result.records[0]).toMatchObject({
        command: 'pnpm build',
        status: 'failed',
        summary: 'Build failed.',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records unavailable verification when commands cannot run', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      seedGoalTask(workspaceDb, [
        {
          kind: 'manual',
          description: 'Confirm release notes manually.',
        },
      ]);

      const result = await runGoalTaskVerification({
        coreDb,
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        idPrefix: 'verify_manual',
      });

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        verificationId: 'verify_manual_1',
        command: null,
        status: 'unavailable',
        summary: 'Manual verification unavailable: Confirm release notes manually.',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
