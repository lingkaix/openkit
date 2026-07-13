import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  materializeInterruptedWorkerStates,
} from './worker-recovery.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';

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

/**
 * Creates one exact runtime stream and matching native-origin row.
 *
 * @param lineage Authoritative outer worker lineage.
 * @param streamRef Safe synthetic stream reference.
 * @param sourceKind Primary or runtime-thread stream class.
 * @param record Exact pinned Codex JSON frame.
 * @param origin Restricted native-origin fields for the frame.
 * @returns Exact bytes, manifest row, and native-origin index row.
 */
function createRecoveryRuntimeStream(
  lineage: WorkerLineage,
  streamRef: string,
  sourceKind: 'primary' | 'runtime-thread',
  record: Record<string, unknown>,
  origin: Partial<WorkerRuntimeNativeOriginIndexEntry>
) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const entry = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
    adapterVersion: '0.144.1',
    byteLength: bytes.byteLength,
    byteOffset: 0,
    eventKind: record.type,
    frameSequence: 0,
    frameSha256: runtimeSha256(bytes),
    lineage,
    ...origin,
    parseStatus: 'parsed',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streamRef,
  });
  return {
    bytes,
    entry,
    manifest: {
      bytes: bytes.byteLength,
      captureStatus: 'complete' as const,
      frameCount: 1,
      sha256: runtimeSha256(bytes),
      sourceKind,
      stableTerminal: true,
      streamRef,
    },
  };
}

/**
 * Imports one minimal valid retained runtime forest for checkpoint recovery tests.
 *
 * @param workspaceDb Workspace database that owns the retained provenance.
 * @returns Outer turn id plus stable raw evidence paths and original stream bytes.
 */
async function createRetainedRecoveryProvenance(workspaceDb: WorkspaceDb) {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Recover retained runtime provenance');
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent: store.getAgent('ws_demo', 'agent_codex_host'),
      agentSessionId: 'as_recovery_provenance',
      backend: {
        workerControlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      backendRequirements: {
        allowedKinds: ['openshell'],
        preferred: 'openshell',
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      providerSelection: { model: 'openai/gpt-5.2', providerId: 'agent-openrouter' },
      requestId: 'req_recovery_provenance',
      turn,
      turnInput: 'Recover retained runtime provenance',
      userId: workspaceDb.userId,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );
  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    createdAt: '2026-07-13T00:00:01.000Z',
    environmentPackage,
  });
  const lineage: WorkerLineage = {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId ?? null,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
  };
  const nativeThreadId = '019f0000-0000-7000-8000-000000000101';
  const nativeSessionId = '019f0000-0000-7000-8000-000000000110';
  const streams = [
    createRecoveryRuntimeStream(
      lineage,
      'stream-0000.jsonl',
      'primary',
      { thread_id: nativeThreadId, type: 'thread.started' },
      { nativeThreadId }
    ),
    createRecoveryRuntimeStream(
      lineage,
      'stream-0001.jsonl',
      'runtime-thread',
      {
        payload: {
          cwd: '/private/runtime-provenance',
          id: nativeThreadId,
          session_id: nativeSessionId,
          source: 'exec',
          timestamp: '2026-07-13T00:00:00.000Z',
        },
        timestamp: '2026-07-13T00:00:00.000Z',
        type: 'session_meta',
      },
      { nativeSessionId, nativeThreadId }
    ),
  ];
  const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-recovery-provenance-capture-'));
  const rawStreamsRoot = join(captureRoot, 'raw');
  const streamManifestPath = join(captureRoot, 'raw-streams.json');
  const nativeOriginIndexPath = join(captureRoot, 'native-origin-index.jsonl');
  const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
    adapterVersion: '0.144.1',
    captureStatus: 'complete',
    lineage,
    primaryStreamRef: 'stream-0000.jsonl',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streams: streams.map((stream) => stream.manifest),
  });
  mkdirSync(rawStreamsRoot, { recursive: true });
  writeFileSync(streamManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    nativeOriginIndexPath,
    `${streams.map((stream) => JSON.stringify(stream.entry)).join('\n')}\n`
  );
  for (const stream of streams) {
    writeFileSync(join(rawStreamsRoot, stream.manifest.streamRef), stream.bytes);
  }
  const workspaceRoot = join(
    workspaceDb.dataRoot,
    'users',
    workspaceDb.userId,
    'workspaces',
    workspaceDb.workspaceId
  );
  const imported = await importWorkerRuntimeProvenance({
    backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
    capture: { nativeOriginIndexPath, rawStreamsRoot, streamManifestPath },
    collectedAt: '2026-07-13T00:00:02.000Z',
    environmentPackage,
    workspaceDb,
    workspaceRoot,
  });
  expect(imported.complete).toBe(true);
  const stableStreamPath = join(
    workspaceRoot,
    'evidence',
    'backend',
    imported.rawBundleId,
    'raw',
    streams[0].manifest.streamRef
  );
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    stableStreamBytes: streams[0].bytes,
    stableStreamPath,
    turnId: turn.id,
  };
}

/** Computes the canonical prefixed SHA-256 digest for retained runtime bytes. */
function runtimeSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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

  it('cleans checkpoints only after terminal worker state is durably saved', async () => {
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
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_running',
          terminalStage: 'running_worker',
        })
      ).toBe(false);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_running')).not.toBeNull();
      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
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

  it('re-verifies retained required provenance before clearing a terminal checkpoint', async () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const retained = await createRetainedRecoveryProvenance(workspaceDb);
      const checkpoint = () =>
        upsertWorkerCheckpoint(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: retained.turnId,
          stage: 'saving',
          iteration: 1,
          workerSessionId: retained.agentSessionId,
          now: () => '2026-07-13T00:00:03.000Z',
        });
      const clear = () =>
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: retained.turnId,
          terminalStage: 'completed',
        });

      checkpoint();
      await expect(clear()).resolves.toBe(true);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', retained.turnId)).toBeNull();

      checkpoint();
      writeFileSync(
        retained.stableStreamPath,
        Buffer.concat([retained.stableStreamBytes, Buffer.from('tampered')])
      );
      await expect.soft(clear()).rejects.toThrow(/provenance/i);
      expect
        .soft(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', retained.turnId))
        .not.toBeNull();

      checkpoint();
      writeFileSync(retained.stableStreamPath, retained.stableStreamBytes);
      unlinkSync(retained.stableStreamPath);
      await expect.soft(clear()).rejects.toThrow(/provenance/i);
      expect
        .soft(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', retained.turnId))
        .not.toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
