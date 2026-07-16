import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { listPendingUserTurns } from './pending-user-turns.js';
import { enqueueFollowUpInput, enqueueSteeringForSafePoint } from './user-turn-queues.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';
import type { WorkerTurnLoopPrepareInput } from './worker-turn-loop.js';
import { runWorkerTurnLoop } from './worker-turn-loop.js';

/**
 * Opens a migrated Core database for worker-turn loop tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-turn-loop-'));
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

describe('worker turn loop', () => {
  it('selects queued inputs without consuming them before delivery proof', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      enqueueSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'steer_1',
        contentDigest: 'digest_steer_1',
        contentItemId: 'it_steer_1',
      });
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'follow_1',
        contentDigest: 'digest_follow_1',
        contentItemId: 'it_follow_1',
      });
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'follow_2',
        contentDigest: 'digest_follow_2',
        contentItemId: 'it_follow_2',
      });

      const prepareInputs: WorkerTurnLoopPrepareInput[] = [];
      const result = await runWorkerTurnLoop({
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        reviewRequired: true,
        remainingWorkerIterations: 1,
        followUpDrainMode: 'one_at_a_time',
        prepare: (input) => {
          prepareInputs.push(input);

          return {
            repository: {
              id: 'repo_default',
              workspaceId: 'ws_demo',
              displayName: 'OpenKit',
              localPath: '/repo/openkit',
              isDefault: true,
              diagnosticsStatus: 'ready',
              diagnosticsSummary: null,
              createdAt: '2026-05-31T00:00:00.000Z',
              updatedAt: '2026-05-31T00:00:00.000Z',
            },
            delegationRequest: {
              objective: 'Run the selected task.',
              acceptanceCriteria: ['Task passes.'],
              contextRefs: [],
              expectedArtifacts: [],
              constraints: {
                maxContextTokens: 1000,
                maxWorkerIterations: 1,
                requiresUserConfirmation: true,
                stopConditions: ['Stop after completion.'],
              },
              verification: [],
              reviewPolicy: {
                required: true,
                reviewers: ['internal'],
                instructions: 'Review the worker result.',
              },
            },
            contextPackageDigest: 'ctxpkg_sha256_demo',
            steeringMessages: input.steeringMessages,
            followUpInputs: input.followUpInputs,
          };
        },
        reserveTurn: () => ({ turnId: 'turn_worker_1' }),
        startWorker: () => ({ workerSessionId: 'session_worker_1' }),
        awaitWorker: () => ({
          stopReason: 'completed',
          itemIds: ['it_done'],
          artifactIds: ['art_done'],
        }),
      });

      expect(prepareInputs).toHaveLength(1);
      expect(
        prepareInputs[0]?.steeringMessages.map((message) => message.pendingTurn.requestId)
      ).toEqual(['steer_1']);
      expect(
        prepareInputs[0]?.followUpInputs.map((message) => message.pendingTurn.requestId)
      ).toEqual(['follow_1']);
      expect(result).toMatchObject({
        turnId: 'turn_worker_1',
        workerSessionId: 'session_worker_1',
        stopDecision: {
          outcome: 'review',
          shouldStop: true,
          stopReason: 'completed',
        },
        evidence: {
          itemIds: ['it_done'],
          artifactIds: ['art_done'],
        },
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_worker_1')).toMatchObject(
        {
          goalId: 'goal_demo',
          taskId: 'task_demo',
          stage: 'completed',
          workerSessionId: 'session_worker_1',
          contextDigest: 'ctxpkg_sha256_demo',
          stopReason: 'completed',
        }
      );
      expect(latestPermissionDecision(workspaceDb)).toMatchObject({
        action: 'runtime.launch',
        enforcement_point: 'runtime.worker_turn_loop.start',
        reason_code: 'worker_turn_start_allowed',
        result: 'allow',
      });
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['steer_1', 'follow_1', 'follow_2']);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records a redacted failed checkpoint when the worker boundary throws', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      enqueueSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'steer_failed',
        contentItemId: 'it_steer_failed',
      });
      await expect(
        runWorkerTurnLoop({
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => ({
            repository: {
              id: 'repo_default',
              workspaceId: 'ws_demo',
              displayName: 'OpenKit',
              localPath: '/repo/openkit',
              isDefault: true,
              diagnosticsStatus: 'ready',
              diagnosticsSummary: null,
              createdAt: '2026-05-31T00:00:00.000Z',
              updatedAt: '2026-05-31T00:00:00.000Z',
            },
            delegationRequest: {
              objective: 'Run the selected task.',
              acceptanceCriteria: ['Task passes.'],
              contextRefs: [],
              expectedArtifacts: [],
              constraints: {
                maxContextTokens: 1000,
                maxWorkerIterations: 1,
                requiresUserConfirmation: true,
                stopConditions: ['Stop after completion.'],
              },
              verification: [],
              reviewPolicy: {
                required: true,
                reviewers: ['internal'],
                instructions: 'Review the worker result.',
              },
            },
            contextPackageDigest: 'ctxpkg_sha256_demo',
            steeringMessages: [],
            followUpInputs: [],
          }),
          reserveTurn: () => ({ turnId: 'turn_worker_error' }),
          startWorker: () => {
            throw new Error('Worker failed Authorization: Bearer live_secret');
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toThrow('Worker failed');

      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_worker_error')
      ).toMatchObject({
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: 'Worker failed Authorization: Bearer [redacted]',
      });
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['steer_failed']);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/**
 * Reads the newest permission decision row from a workspace database.
 *
 * @param workspaceDb Workspace database handle.
 * @returns Newest permission decision row.
 */
function latestPermissionDecision(workspaceDb: WorkspaceDb): {
  action: string;
  enforcement_point: string;
  reason_code: string;
  result: string;
} {
  return workspaceDb.sqlite
    .prepare(
      `SELECT action, enforcement_point, reason_code, result
       FROM permission_decisions
       ORDER BY created_at DESC, decision_id DESC
       LIMIT 1`
    )
    .get() as {
    action: string;
    enforcement_point: string;
    reason_code: string;
    result: string;
  };
}
