import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createGoalRecord, createGoalTask, listGoalTasks } from './goal-store.js';
import { recordGoalTaskWorkerOutcome } from './goal-worker-outcome.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

/**
 * Opens a migrated workspace database for goal worker outcome tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-worker-outcome-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Adds one running goal task and linked checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 */
function addRunningGoalTask(workspaceDb: WorkspaceDb): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Record outcome',
    objective: 'Record worker outcome.',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    planItemId: 'item_plan_demo',
    taskId: 'task_demo',
    title: 'Run worker',
    objective: 'Run the worker.',
    orderIndex: 0,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Worker outcome recorded.'],
    contextBudgetTokens: 12_000,
    resources: [],
    expectedArtifacts: [{ kind: 'artifact', description: 'Worker outcome evidence.' }],
    verificationChecks: [
      { kind: 'manual', description: 'Confirm the worker outcome is recorded.' },
    ],
    reviewPolicy: {
      required: true,
      reviewers: ['human'],
      instructions: 'Review the recorded worker outcome.',
    },
    escalationConditions: [],
    status: 'running',
  });
  upsertWorkerCheckpoint(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'tu_demo',
    goalId: 'goal_demo',
    taskId: 'task_demo',
    requestId: 'req_tu_demo',
    requestInputHash: 'sha256:tu_demo',
    stage: 'running_worker',
    iteration: 1,
    contextDigest: 'ctxpkg_sha256_demo',
  });
}

describe('goal worker terminal outcome', () => {
  it('records worker completion on the linked goal task', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      addRunningGoalTask(workspaceDb);

      const result = recordGoalTaskWorkerOutcome(workspaceDb, {
        authorityActor: { kind: 'user', id: 'user_1' },
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'tu_demo',
        stopReason: 'completed',
        itemIds: ['it_worker_summary'],
        artifactIds: ['ar_worker_result'],
      });

      expect(result.task.status).toBe('completed');
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        })[0]
      ).toMatchObject({
        status: 'completed',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_demo')).toMatchObject({
        stage: 'completed',
        stopReason: 'completed',
        diagnosticsSummary: '{"itemIds":["it_worker_summary"],"artifactIds":["ar_worker_result"]}',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records worker error on the linked goal task', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      addRunningGoalTask(workspaceDb);

      const result = recordGoalTaskWorkerOutcome(workspaceDb, {
        authorityActor: { kind: 'user', id: 'user_1' },
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'tu_demo',
        stopReason: 'error',
      });

      expect(result.task.status).toBe('failed');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_demo')).toMatchObject({
        stage: 'failed',
        stopReason: 'error',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('keeps a worker task running while the worker is awaiting human input', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      addRunningGoalTask(workspaceDb);

      const result = recordGoalTaskWorkerOutcome(workspaceDb, {
        authorityActor: { kind: 'user', id: 'user_1' },
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'tu_demo',
        stopReason: 'ask_user',
        itemIds: ['it_approval_request'],
      });

      expect(result.task.status).toBe('running');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_demo')).toMatchObject({
        stage: 'waiting_for_user',
        stopReason: 'ask_user',
        diagnosticsSummary: '{"itemIds":["it_approval_request"],"artifactIds":[]}',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records worker abort on the linked goal task with aborted stopReason', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      addRunningGoalTask(workspaceDb);

      const result = recordGoalTaskWorkerOutcome(workspaceDb, {
        authorityActor: { kind: 'user', id: 'user_1' },
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'tu_demo',
        stopReason: 'aborted',
      });

      expect(result.task.status).toBe('failed');
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_demo')).toMatchObject({
        stage: 'aborted',
        stopReason: 'aborted',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
