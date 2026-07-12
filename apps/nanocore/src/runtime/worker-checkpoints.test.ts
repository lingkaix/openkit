import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import {
  clearWorkerCheckpoint,
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';

/**
 * Opens a migrated workspace database for worker checkpoint tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-checkpoints-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('worker checkpoint storage', () => {
  it('creates compact evidence diagnostics for checkpoint summaries', () => {
    expect(createWorkerCheckpointEvidenceDiagnostics({ itemIds: [], artifactIds: [] })).toBeNull();
    expect(
      createWorkerCheckpointEvidenceDiagnostics({
        itemIds: ['it_worker_summary'],
        artifactIds: ['ar_worker_result'],
      })
    ).toBe('{"itemIds":["it_worker_summary"],"artifactIds":["ar_worker_result"]}');
  });

  it('creates and reads worker checkpoints without replay semantics', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        stage: 'running_worker',
        iteration: 2,
        workerSessionId: 'session_demo',
        contextDigest: 'ctxpkg_sha256_abc',
        stopReason: null,
        diagnosticsSummary: 'worker is running',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(checkpoint).toMatchObject({
        checkpointId: 'ws_demo:th_demo:turn_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        stage: 'running_worker',
        iteration: 2,
        workerSessionId: 'session_demo',
        contextDigest: 'ctxpkg_sha256_abc',
        replayInstruction: false,
        createdAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:00:00.000Z',
      });
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_demo')).toEqual(
        checkpoint
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('updates and clears worker checkpoints', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const updated = updateWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: 'provider failed',
        now: () => '2026-05-31T00:10:00.000Z',
      });

      expect(updated).toMatchObject({
        stage: 'failed',
        stopReason: 'error',
        diagnosticsSummary: 'provider failed',
        updatedAt: '2026-05-31T00:10:00.000Z',
      });
      expect(clearWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_demo')).toBe(true);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_demo')).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records one audit event when a checkpoint first transitions to a terminal stage', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_direct_terminal',
        stage: 'completed',
        iteration: 1,
        stopReason: 'completed',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_terminal',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
      ).toEqual({ count: 0 });

      updateWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_terminal',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-05-31T00:10:00.000Z',
      });
      updateWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_terminal',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-05-31T00:11:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'worker.checkpoint.terminal'`
          )
          .all()
      ).toEqual([
        {
          action: 'worker.checkpoint.terminal',
          category: 'system',
          outcome: 'succeeded',
          resource: 'worker-checkpoint:ws_demo:th_demo:turn_terminal',
          severity: 'info',
          summary: 'Worker checkpoint terminal: completed',
          thread_id: 'th_demo',
          turn_id: 'turn_terminal',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records one runtime evidence row when a checkpoint first transitions to a terminal stage', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_runtime_evidence',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: 'session_demo',
        contextDigest: 'sha256:ctx_demo',
        diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics({
          itemIds: ['it_worker_summary'],
          artifactIds: ['artifact_worker_result'],
        }),
        now: () => '2026-05-31T00:00:00.000Z',
      });

      updateWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_runtime_evidence',
        stage: 'completed',
        stopReason: 'completed',
        diagnosticsSummary: 'Authorization: Bearer live_secret',
        now: () => '2026-05-31T00:10:00.000Z',
      });
      updateWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_runtime_evidence',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-05-31T00:11:00.000Z',
      });

      expect(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo')).toMatchObject([
        {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_runtime_evidence',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          agentSessionId: 'session_demo',
          phase: 'teardown',
          summary: 'Worker checkpoint terminal: completed.',
          outcome: 'succeeded',
          stopReason: 'completed',
          evidenceBundleIds: [],
          requiredFeatures: ['runtime.evidence.v1'],
          createdAt: '2026-05-31T00:10:00.000Z',
          completedAt: '2026-05-31T00:10:00.000Z',
          collectedAt: '2026-05-31T00:10:00.000Z',
        },
      ]);
      expect(JSON.stringify(listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo'))).not.toContain(
        'live_secret'
      );
      expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toMatchObject([
        {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_runtime_evidence',
          agentSessionId: 'session_demo',
          capabilityId: 'runtime.worker_turn',
          family: 'runtime',
          operation: 'worker.checkpoint.terminal',
          providerRef: 'nanocore-runtime',
          serviceRef: 'worker-checkpoint',
          redactionClass: 'metadata-only',
          status: 'succeeded',
        },
      ]);
      expect(listWorkspaceUsageRecords(workspaceDb, 'ws_demo')).toMatchObject([
        {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_runtime_evidence',
          agentSessionId: 'session_demo',
          category: 'runtime',
          unit: 'sandbox_sessions',
          quantity: 1,
          providerRef: 'nanocore-runtime',
          source: 'worker-checkpoint-terminal',
          recordedAt: '2026-05-31T00:10:00.000Z',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('redacts checkpoint diagnostics and stores no secret columns', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const checkpoint = upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_secret',
        stage: 'recovering',
        iteration: 1,
        diagnosticsSummary: 'Authorization: Bearer live_secret token=tok_secret',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      const columns = workspaceDb.sqlite
        .prepare('PRAGMA table_info(worker_turn_checkpoints)')
        .all() as Array<{ name: string }>;

      expect(checkpoint.diagnosticsSummary).toBe(
        'Authorization: Bearer [redacted] token=[redacted]'
      );
      expect(JSON.stringify(checkpoint)).not.toContain('live_secret');
      expect(JSON.stringify(checkpoint)).not.toContain('tok_secret');
      expect(
        columns.some((column) => /secret|token|credential|password|env/i.test(column.name))
      ).toBe(false);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
