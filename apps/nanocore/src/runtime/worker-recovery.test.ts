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
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';
import { clearWorkerCheckpointAfterTerminalState } from './worker-recovery.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';

/**
 * Opens a migrated workspace database for worker recovery tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
  const turn = store.createTurn('ws_demo', 'th_demo', 'Recover retained runtime provenance', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      }),
      agentSessionId: 'as_recovery_provenance',
      backend: {
        workerControlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_recovery_provenance',
      triggerActor: { kind: 'user', id: 'user_demo' },
      turn,
      turnInput: 'Recover retained runtime provenance',
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
  const workspaceRoot = join(workspaceDb.dataRoot, 'workspaces', workspaceDb.workspaceId);
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
  it('cleans checkpoints only after terminal worker state is durably saved', async () => {
    const workspaceDb = createWorkspaceDb();

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_completed',
        requestId: 'req_turn_completed',
        requestInputHash: 'sha256:turn_completed',
        stage: 'completed',
        iteration: 4,
        now: () => '2026-05-31T00:00:00.000Z',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_running',
        requestId: 'req_turn_running',
        requestInputHash: 'sha256:turn_running',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_running',
        })
      ).toBe(false);
      expect(getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', 'turn_running')).not.toBeNull();
      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_completed',
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
          requestId: `req_${retained.turnId}`,
          requestInputHash: `sha256:${retained.turnId}`,
          stage: 'completed',
          iteration: 1,
          workerSessionId: retained.agentSessionId,
          now: () => '2026-07-13T00:00:03.000Z',
        });
      const clear = () =>
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: retained.turnId,
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
