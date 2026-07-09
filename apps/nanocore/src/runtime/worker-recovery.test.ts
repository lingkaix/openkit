import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  materializeInterruptedWorkerStates,
} from './worker-recovery.js';

/**
 * Opens a migrated workspace database for worker recovery tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('worker recovery materialization', () => {
  it('materializes pending worker checkpoints as interrupted read-model rows', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_running',
        goalId: 'goal_demo',
        taskId: 'task_running',
        stage: 'running_worker',
        iteration: 2,
        workerSessionId: 'session_running',
        contextDigest: 'ctxpkg_sha256_running',
        diagnosticsSummary: 'Authorization: Bearer live_secret while running',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_waiting',
        goalId: 'goal_demo',
        taskId: 'task_waiting',
        stage: 'waiting_for_user',
        iteration: 3,
        stopReason: 'needs_user_input',
        diagnosticsSummary: 'waiting for steering',
        now: () => '2026-05-31T00:05:00.000Z',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_completed',
        goalId: 'goal_demo',
        taskId: 'task_completed',
        stage: 'completed',
        iteration: 1,
        stopReason: 'completed',
        now: () => '2026-05-31T00:10:00.000Z',
      });

      const states = materializeInterruptedWorkerStates(workspaceDb, {
        now: () => '2026-05-31T01:00:00.000Z',
      });

      expect(states.map((state) => state.turnId)).toEqual(['turn_running', 'turn_waiting']);
      expect(states[0]).toMatchObject({
        kind: 'interrupted_worker_state',
        checkpointId: 'ws_demo:th_demo:turn_running',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_running',
        goalId: 'goal_demo',
        taskId: 'task_running',
        stage: 'running_worker',
        iteration: 2,
        workerSessionId: 'session_running',
        contextDigest: 'ctxpkg_sha256_running',
        diagnosticsSummary: 'Authorization: Bearer [redacted] while running',
        replayInstruction: false,
        choices: [
          {
            kind: 'inspect',
            label: 'Inspect interrupted worker evidence',
            recommended: true,
          },
          {
            kind: 'retry',
            label: 'Retry interrupted worker turn',
          },
          {
            kind: 'record_terminal',
            label: 'Record terminal worker state',
            allowedTerminalStages: ['completed', 'failed', 'aborted'],
          },
          {
            kind: 'request_human',
            label: 'Ask the user how to recover this worker turn',
          },
        ],
        materializedAt: '2026-05-31T01:00:00.000Z',
        sourceUpdatedAt: '2026-05-31T00:00:00.000Z',
      });
      expect(states[1]).toMatchObject({
        kind: 'interrupted_worker_state',
        stage: 'waiting_for_user',
        stopReason: 'needs_user_input',
        replayInstruction: false,
        materializedAt: '2026-05-31T01:00:00.000Z',
        sourceUpdatedAt: '2026-05-31T00:05:00.000Z',
      });
      expect(JSON.stringify(states)).not.toContain('live_secret');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('materializes failed worker checkpoints with terminal recovery choices', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_failed',
        goalId: 'goal_demo',
        taskId: 'task_failed',
        stage: 'failed',
        iteration: 1,
        stopReason: 'error',
        diagnosticsSummary: 'Worker failed token=live_secret',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const states = materializeInterruptedWorkerStates(workspaceDb, {
        now: () => '2026-05-31T01:00:00.000Z',
      });

      expect(states).toEqual([
        expect.objectContaining({
          kind: 'interrupted_worker_state',
          checkpointId: 'ws_demo:th_demo:turn_failed',
          stage: 'failed',
          stopReason: 'error',
          diagnosticsSummary: 'Worker failed token=[redacted]',
          replayInstruction: false,
          choices: expect.arrayContaining([
            expect.objectContaining({ kind: 'inspect', recommended: true }),
            expect.objectContaining({ kind: 'retry' }),
            expect.objectContaining({ kind: 'record_terminal' }),
            expect.objectContaining({ kind: 'request_human' }),
          ]),
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not expose automatic replay commands from recovered checkpoints', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_running',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const [state] = materializeInterruptedWorkerStates(workspaceDb, {
        now: () => '2026-05-31T01:00:00.000Z',
      });

      expect(state).toMatchObject({
        kind: 'interrupted_worker_state',
        replayInstruction: false,
      });
      expect(state).not.toHaveProperty('resumeCommand');
      expect(state).not.toHaveProperty('replayCommand');
      expect(state?.choices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'inspect' }),
          expect.objectContaining({ kind: 'retry' }),
          expect.objectContaining({ kind: 'record_terminal' }),
          expect.objectContaining({ kind: 'request_human' }),
        ])
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('cleans checkpoints only after terminal worker state is durably saved', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_completed',
        stage: 'saving',
        iteration: 4,
        now: () => '2026-05-31T00:00:00.000Z',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_running',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_running',
          terminalStage: 'running_worker',
        })
      ).toBe(false);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_running')).not.toBeNull();
      expect(
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_completed',
          terminalStage: 'completed',
        })
      ).toBe(true);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_completed')).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
