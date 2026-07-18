import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { TurnStartValidationError } from './orchestrator.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';
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

/** Returns the shared prepared worker input used by loop boundary tests. */
function preparedWorkerTurn(reviewRequired: boolean) {
  return {
    repository: {
      id: 'repo_default',
      workspaceId: 'ws_demo',
      displayName: 'OpenKit',
      localPath: '/repo/openkit',
      isDefault: true,
      diagnosticsStatus: 'ready' as const,
      diagnosticsSummary: null,
      createdAt: '2026-05-31T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
    },
    delegationRequest: {
      schemaVersion: 1 as const,
      objective: 'Run the selected task.',
      acceptanceCriteria: ['Task passes.'],
      contextRefs: [],
      resources: [],
      expectedArtifacts: [],
      constraints: { maxContextTokens: 1000, maxWorkerIterations: 1 },
      verification: [],
      reviewPolicy: {
        required: reviewRequired,
        reviewers: reviewRequired ? ['human'] : [],
        instructions: reviewRequired ? 'Review the worker result.' : null,
      },
      escalationConditions: [],
      reviewContext: null,
    },
    contextPackageDigest: 'ctxpkg_sha256_demo',
  };
}

describe('worker turn loop', () => {
  it('runs one worker turn and persists its checkpoint', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      const prepareCalls: unknown[][] = [];
      const result = await runWorkerTurnLoop({
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        requestId: 'req_worker_1',
        requestInputHash: 'sha256:worker_1',
        reviewRequired: true,
        remainingWorkerIterations: 1,
        prepare: (...args) => {
          prepareCalls.push(args);
          return preparedWorkerTurn(true);
        },
        reserveTurn: () => ({ turnId: 'turn_worker_1' }),
        startWorker: () => ({ workerSessionId: 'session_worker_1' }),
        awaitWorker: () => ({
          stopReason: 'completed',
          itemIds: ['it_done'],
          artifactIds: ['art_done'],
        }),
      });

      expect(prepareCalls).toEqual([[]]);
      expect(result).not.toHaveProperty('queues');
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
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records a redacted failed checkpoint when the worker boundary throws', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      await expect(
        runWorkerTurnLoop({
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          requestId: 'req_worker_error',
          requestInputHash: 'sha256:worker_error',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(true),
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
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps the preparing checkpoint when product recovery is required after worker cleanup', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = createWorkspaceDb(coreDb);

    try {
      await expect(
        runWorkerTurnLoop({
          workspaceDb,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          requestId: 'req_worker_human_gate',
          requestInputHash: 'sha256:worker_human_gate',
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => preparedWorkerTurn(false),
          reserveTurn: () => ({ turnId: 'turn_worker_human_gate' }),
          startWorker: () => {
            throw new TurnStartValidationError(
              'recovery_required',
              'Worker requested human input without an exact product Gate.',
              409
            );
          },
          awaitWorker: () => ({ stopReason: 'completed' }),
        })
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });

      expect(
        getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_worker_human_gate')
      ).toMatchObject({
        stage: 'preparing',
        stopReason: null,
      });
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
