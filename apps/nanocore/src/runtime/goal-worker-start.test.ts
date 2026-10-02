import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ensureLocalUser } from '../auth/identity.js';
import * as scheduler from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createGoalRecord, createGoalTask, listGoalTasks } from './goal-store.js';
import { startGoalTaskWorkerTurn } from './goal-worker-start.js';
import type { PreparedNextTurn } from './prepare-next-turn.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

const USER_ACTOR = { kind: 'user', id: 'user_demo' } as const;

/**
 * Opens a migrated workspace database for goal worker start tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-worker-start-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
    createdByItemId: 'it_initial_intent_goal_demo',
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
        triggerActor: USER_ACTOR,
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
      expect(result.turn.triggerActor).toEqual(USER_ACTOR);
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
          triggerActor: USER_ACTOR,
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

it.each([
  'syntax',
  'unknown-key',
] as const)('keeps %s start diagnostics safe in the checkpoint and Action Center', async (variant) => {
  const marker = 'ROW_SECRET_X9';
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-start-publication-'));
  const store = createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  const parsed = z
    .object({ id: z.string() })
    .strict()
    .safeParse({ id: 'demo', [marker]: 'private' });
  if (parsed.success) throw new Error('Expected retained schema failure.');
  const error = variant === 'syntax' ? new SyntaxError(marker) : parsed.error;
  try {
    addReadyGoalTask(workspaceDb);
    await expect(
      startGoalTaskWorkerTurn({
        workspaceDb,
        store,
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_publication',
        requestInputHash: 'sha256:publication',
        prepared: preparedFixture(),
        startWorker: () => {
          throw error;
        },
      })
    ).rejects.toBe(error);
    const checkpoint = getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'tu_1');
    expect(checkpoint).toMatchObject({
      stage: 'failed',
      stopReason: 'error',
      diagnosticsSummary: 'The retained record could not be read.',
    });
    expect(store.getTurnById('tu_1')).toMatchObject({
      error: { code: 'worker_start_failed', message: 'Worker start failed.' },
    });
    // A terminal start failure is not actionable; exercise the later summary publisher on an interrupted recovery tuple.
    const recoveryTurn = store.createTurn('ws_demo', 'th_demo', 'Inspect checkpoint diagnostics', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(recoveryTurn.id, { status: 'interrupted', agentSessionId: 'as_recovery' });
    store.createAgentSession({
      id: 'as_recovery',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      agentId: 'agent_codex_host',
      status: 'interrupted',
      message: 'Interrupted recovery fixture.',
      createdAt: '2026-07-18T01:00:06.000Z',
      updatedAt: '2026-07-18T01:00:06.000Z',
    });
    upsertWorkerCheckpoint(workspaceDb, {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: recoveryTurn.id,
      requestId: 'req_recovery_projection',
      requestInputHash: 'sha256:recovery',
      stage: 'preparing',
      iteration: 0,
      workerSessionId: 'as_recovery',
      diagnosticsSummary: checkpoint!.diagnosticsSummary,
    });
    vi.spyOn(scheduler, 'listSchedulerSessionLeasesForTurn').mockReturnValue([
      {
        agentSessionId: 'as_recovery',
        status: 'released',
        recoveryState: null,
        releaseReason: 'scheduler-restart-backend-cleanup',
      } as ReturnType<typeof scheduler.listSchedulerSessionLeasesForTurn>[number],
    ]);
    const app = createApp({ coreDb, store });
    const response = await app.request('/api/app/workspaces/ws_demo/action-center');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'checkpoint_recovery',
          summary: 'The retained record could not be read.',
        }),
      ])
    );
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(JSON.stringify(checkpoint)).not.toContain(marker);
  } finally {
    vi.restoreAllMocks();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});
