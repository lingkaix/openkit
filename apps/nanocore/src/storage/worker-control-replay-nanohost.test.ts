// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { readWorkerControlDuplicateReceipt } from '../runtime/worker-control-final-status.js';
import { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import { readAcceptedRecords } from '../runtime/worker-control-rebuild.js';
import {
  listWorkerControlAcceptedEvents,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/extensions/nanohost/', import.meta.url)
);
const lineage: WorkerLineage = {
  agentSessionId: 'as_00000000-0000-7e3a-a966-bbf1c9a21fcc',
  packageSnapshotId: 'aepsnap_replay_1',
  requestId: 'req_replay_1',
  threadId: 'th_00000000-0000-7ccc-992e-e88b1e35ca99',
  turnId: 'tu_00000000-0000-7056-a6b5-80ab0aaa7f63',
  workspaceId: 'ws_00000000-0000-708d-8de8-225685139ab1',
};

it('reads exact NanoHost duplicate receipts and ordered product events after reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-worker-replay-'));
  const path = join(root, 'state.sqlite');
  const acceptedAt = '2026-11-20T00:00:04.000Z';
  const artifact = {
    artifactId: 'artifact-original',
    sequence: 1,
    title: 'Report',
    path: 'report.txt',
    mediaType: 'text/plain',
    noticedAt: '2026-11-20T00:00:00.000Z',
  };
  const ack = {
    sequence: 2,
    refreshId: 'refresh-original',
    status: 'applied',
    message: null,
    acknowledgedAt: '2026-11-20T00:00:01.000Z',
  };
  const artifactKey = String(artifact.sequence);
  const ackKey = String(ack.sequence);
  const first: WorkerCanonicalEventRecord = {
    kind: 'event',
    schemaVersion: 1,
    sequence: 11,
    lineage,
    event: { type: 'worker.heartbeat', data: { status: 'running' } },
  };
  const last = { ...first, sequence: 10 };
  const observation: WorkerCanonicalEventRecord = {
    ...first,
    sequence: 3,
    event: {
      type: 'observation.recorded',
      data: {
        observationId: 'observation-original',
        sourceRef: 'source-original',
        sourceSequence: 0,
        observedAt: acceptedAt,
        fact: {
          kind: 'assistant',
          runtimeOriginRef: null,
          phase: 'updated',
          messageRef: 'message-original',
          representation: 'delta',
        },
        content: {
          state: 'expected',
          mediaType: 'text/plain',
          boundary: 'assistant.text',
          bytes: 1,
          sha256: 'sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
          chunkCount: 1,
        },
      },
    },
  };
  const chunk: WorkerCanonicalEventRecord = {
    ...first,
    sequence: 4,
    event: {
      type: 'observation.content.chunk',
      data: {
        observationId: 'observation-original',
        chunkIndex: 0,
        byteOffset: 0,
        encoding: 'base64',
        data: 'YQ==',
      },
    },
  };
  let sqlite = new Database(path);
  try {
    migrate(drizzle(sqlite), { migrationsFolder });
    sqlite.transaction(() => {
      for (const [operation, recordKey, record] of [
        ['artifact_notice', artifactKey, { ...artifact, additiveField: true }],
        ['supply_refresh_ack', ackKey, ack],
      ] as const) {
        writeWorkerControlAcceptedRecord(
          { sqlite },
          { lineage, operation, recordKey, sequence: record.sequence, acceptedAt, record }
        );
      }
      // Insert out of acceptance order with the lower sequence at the later timestamp.
      for (const [record, time] of [
        [last, '2026-11-20T00:00:05.000Z'],
        [observation, acceptedAt],
        [chunk, acceptedAt],
        [first, '2026-11-20T00:00:03.000Z'],
      ] as const) {
        writeWorkerControlAcceptedRecord(
          { sqlite },
          {
            lineage,
            operation: 'event_append',
            recordKey: String(record.sequence),
            sequence: record.sequence,
            record,
            acceptedAt: time,
          }
        );
      }
      writeWorkerControlAcceptedRecord(
        { sqlite },
        {
          lineage,
          operation: 'heartbeat',
          recordKey: 'heartbeat',
          acceptedAt,
          record: { status: 'running' },
        }
      );
      // An inert heartbeat must be excluded before retained-version decoding.
      sqlite
        .prepare(
          "UPDATE worker_control_records SET schema_version = 2 WHERE operation = 'heartbeat'"
        )
        .run();
    })();

    sqlite.close();
    sqlite = new Database(path, { fileMustExist: true });
    const owner = { sqlite };
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name = 'scheduler_execution_attempts'")
        .get()
    ).toBeUndefined();
    expect(
      readWorkerControlDuplicateReceipt(owner, lineage, 'artifact_notice', artifactKey)
    ).toEqual(artifact);
    expect(readWorkerControlDuplicateReceipt(owner, lineage, 'supply_refresh_ack', ackKey)).toEqual(
      ack
    );
    for (const [selector, operation, key] of [
      [lineage, 'supply_refresh_ack', artifactKey],
      [lineage, 'artifact_notice', '999'],
      [{ ...lineage, packageSnapshotId: 'aepsnap_other' }, 'artifact_notice', artifactKey],
      [
        { ...lineage, agentSessionId: 'as_00000000-0000-7e3a-a966-bbf1c9a21fcd' },
        'artifact_notice',
        artifactKey,
      ],
    ] as const) {
      expect(readWorkerControlDuplicateReceipt(owner, selector, operation, key)).toBeUndefined();
    }
    const records = readAcceptedRecords(owner, lineage);
    expect(records.events).toEqual([first, last]);
    expect(records.artifacts).toMatchObject([artifact]);
    expect(records.supplyRefreshAcks).toEqual([ack]);
  } finally {
    if (sqlite.open) sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('restores consecutive Worker event sequences with the same accepted timestamp after reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-worker-replay-tie-'));
  const path = join(root, 'state.sqlite');
  const acceptedAt = '2026-11-20T00:00:04.000Z';
  let sqlite = new Database(path);
  try {
    migrate(drizzle(sqlite), { migrationsFolder });
    for (const sequence of [9, 10]) {
      sqlite.transaction(() => {
        const record: WorkerCanonicalEventRecord = {
          kind: 'event',
          schemaVersion: 1,
          sequence,
          lineage,
          event: { type: 'worker.heartbeat', data: { status: 'running' } },
        };
        writeWorkerControlAcceptedRecord(
          { sqlite },
          {
            lineage,
            operation: 'event_append',
            recordKey: String(sequence),
            sequence,
            record,
            acceptedAt,
          }
        );
      })();
    }

    sqlite.close();
    sqlite = new Database(path, { fileMustExist: true, readonly: true });
    const owner = { sqlite };
    const records = readAcceptedRecords(owner, lineage);
    const gateway = new WorkerControlGateway();
    gateway.restoreSession({
      ...records,
      lineage,
      registeredAt: acceptedAt,
      sandboxBindingRef: 'fixture-replay-binding',
      workerControlTokenHash: 'a'.repeat(64),
      workerInferenceTokenHash: 'b'.repeat(64),
      workerCapabilityTokenHash: 'c'.repeat(64),
    });
    expect(listWorkerControlAcceptedEvents(owner, lineage).map((event) => event.sequence)).toEqual([
      9, 10,
    ]);
    expect.soft(records.events.map((event) => event.sequence)).toEqual([9, 10]);
    expect
      .soft(
        gateway.getSessionSnapshot(lineage.packageSnapshotId)?.events.map((event) => event.sequence)
      )
      .toEqual([9, 10]);
  } finally {
    if (sqlite.open) sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
