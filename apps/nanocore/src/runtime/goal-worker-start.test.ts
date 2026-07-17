import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createGoalRecord, createGoalTask, listGoalTasks } from './goal-store.js';
import { startGoalTaskWorkerTurn } from './goal-worker-start.js';
import type { PreparedNextTurn } from './prepare-next-turn.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';

/**
 * Opens a migrated workspace database for goal worker start tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-worker-start-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Builds a prepared worker delegation fixture.
 *
 * @returns Prepared next-turn payload.
 */
function preparedFixture(): PreparedNextTurn {
  return {
    repository: {
      workspaceId: 'ws_demo',
      resourceId: 'repo_default',
      type: 'git_repository',
      displayName: 'OpenKit',
      localPath: '/tmp/openkit',
      diagnosticsStatus: 'ready',
      createdAt: '2026-05-31T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
      validation: null,
    },
    delegationRequest: {
      schemaVersion: 1,
      objective: 'Run release verification.',
      acceptanceCriteria: ['Verification passes.'],
      contextRefs: [{ kind: 'item', id: 'item_context' }],
      resources: [],
      expectedArtifacts: [],
      constraints: {
        maxContextTokens: 240_000,
        maxWorkerIterations: 1,
      },
      verification: [{ kind: 'manual', description: 'Manual verification.' }],
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
        instructions: 'Review worker output.',
      },
      escalationConditions: [],
      reviewContext: null,
    },
    contextPackageDigest: 'ctxpkg_sha256_worker_start',
  };
}

/**
 * Adds one ready goal task to storage.
 *
 * @param workspaceDb Open workspace-scope database handle.
 */
function addReadyGoalTask(workspaceDb: WorkspaceDb): void {
  createGoalRecord(workspaceDb, {
    workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    title: 'Worker start',
    objective: 'Start worker task.',
  });
  createGoalTask(workspaceDb, {
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    goalId: 'goal_demo',
    planItemId: 'it_goal_plan_demo',
    taskId: 'task_demo',
    title: 'Run worker',
    objective: 'Run the worker turn.',
    orderIndex: 0,
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Worker started.'],
    contextBudgetTokens: 12_000,
    resources: [],
    expectedArtifacts: [],
    verificationChecks: [{ kind: 'manual', description: 'Confirm the worker started.' }],
    reviewPolicy: {
      required: true,
      reviewers: ['human'],
      instructions: 'Review worker output.',
    },
    escalationConditions: [],
    status: 'ready',
  });
}

describe('goal worker start', () => {
  it('starts a worker turn, marks the task running, and persists a checkpoint', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    store.createThread('ws_demo', 'Worker start thread');

    try {
      addReadyGoalTask(workspaceDb);
      const result = await startGoalTaskWorkerTurn({
        workspaceDb,
        store,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_goal_worker',
        requestInputHash: 'sha256:goal_worker',
        prepared: preparedFixture(),
        startWorker: async () => ({ workerSessionId: 'session_worker_1' }),
      });

      expect(result.turn.id).toBe('tu_1');
      expect(result.workerSessionId).toBe('session_worker_1');
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        })[0]
      ).toMatchObject({
        taskId: 'task_demo',
        status: 'running',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', result.turn.id)).toMatchObject({
        goalId: 'goal_demo',
        taskId: 'task_demo',
        stage: 'running_worker',
        workerSessionId: 'session_worker_1',
        contextDigest: 'ctxpkg_sha256_worker_start',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records worker start failure before leaving the long-running boundary', async () => {
    const workspaceDb = createWorkspaceDb();
    const store = createDemoStore();
    store.createThread('ws_demo', 'Worker failure thread');

    try {
      addReadyGoalTask(workspaceDb);

      await expect(
        startGoalTaskWorkerTurn({
          workspaceDb,
          store,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          requestId: 'req_goal_worker_failure',
          requestInputHash: 'sha256:goal_worker_failure',
          prepared: preparedFixture(),
          startWorker: async () => {
            throw new Error('worker unavailable');
          },
        })
      ).rejects.toThrow('worker unavailable');
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
        })[0]
      ).toMatchObject({
        taskId: 'task_demo',
        status: 'failed',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_1')).toMatchObject({
        stage: 'failed',
        stopReason: 'error',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
