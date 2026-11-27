import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerControlSequenceRecorder } from '../runtime/worker-control-sequences.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { nanoHostStoreDescriptor } from './nanohost-store-descriptor.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/extensions/nanohost/', import.meta.url)
);

/** The fingerprint table is retained by the shipped NanoHost journal, not Core. */
function openNanoHostOwner(dataRoot: string): { sqlite: Database.Database } {
  const path = join(dataRoot, 'server/extensions', nanoHostStoreDescriptor.owner, 'state.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  migrate(drizzle(sqlite), { migrationsFolder });
  return { sqlite };
}

describe('retained Worker control sequence fingerprints', () => {
  let dataRoot: string;
  let coreDb: { sqlite: Database.Database };
  const input = {
    lineage: {
      agentSessionId: testEntityId('as', 'retained-sequence'),
      packageSnapshotId: 'snapshot_retained_sequence',
      requestId: 'request_retained_sequence',
      threadId: testEntityId('th', 'retained-sequence'),
      turnId: testEntityId('tu', 'retained-sequence'),
      workspaceId: testEntityId('ws', 'retained-sequence'),
    },
    operation: 'supply_refresh_ack',
    sequence: 3,
  };
  const original = '{"status":"applied","sequence":3,"refreshId":"refresh_1"}';

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'openkit-retained-control-sequence-'));
    coreDb = openNanoHostOwner(dataRoot);
  });

  afterEach(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('replays equivalent historical JSON after restart without rewriting its recorded text', () => {
    expect(
      createWorkerControlSequenceRecorder(coreDb).accept({ ...input, fingerprint: original })
    ).toMatchObject({ status: 'accepted', duplicate: false });
    coreDb.sqlite.close();
    coreDb = openNanoHostOwner(dataRoot);
    const recorder = createWorkerControlSequenceRecorder(coreDb);

    // Worker Control: identical canonical payloads replay; changed and stale sequences refuse.
    expect
      .soft(
        recorder.accept({
          ...input,
          fingerprint: '{"refreshId":"refresh_1","sequence":3,"status":"applied"}',
        })
      )
      .toMatchObject({ status: 'accepted', duplicate: true, nextExpectedSequence: 4 });
    expect
      .soft(
        recorder.accept({
          ...input,
          fingerprint: '{"refreshId":"refresh_1","sequence":3,"status":"rejected"}',
        })
      )
      .toMatchObject({ status: 'conflict', code: 'worker_control_sequence_conflict' });
    expect
      .soft(recorder.accept({ ...input, sequence: 2, fingerprint: original }))
      .toMatchObject({ status: 'stale', code: 'worker_control_sequence_stale' });
    // Schema Evolution, Canonical Structured Values And Exact Bytes: historical text stays exact.
    expect(
      coreDb.sqlite.prepare('SELECT fingerprint FROM worker_control_sequence_fingerprints').all()
    ).toEqual([{ fingerprint: original }]);
  });

  it('keeps accepted observation metadata and chunks at their original positions after a cutoff', () => {
    const recorder = createWorkerControlSequenceRecorder(coreDb);
    const accept = (sequence: number, type: string, data: Record<string, unknown>) =>
      recorder.accept({
        ...input,
        operation: 'event_append',
        requireContinuous: true,
        sequence,
        fingerprint: JSON.stringify({ sequence, event: { type, data } }),
      });
    const metadata = { observationId: 'original-observation' };
    const chunk = { ...metadata, chunkIndex: 0, byteOffset: 0, sha256: 'a'.repeat(64) };
    expect(accept(0, 'observation.recorded', metadata)).toMatchObject({ status: 'accepted' });
    expect(accept(1, 'observation.recorded', metadata)).toMatchObject({
      status: 'conflict',
      code: 'worker_control_sequence_conflict',
    });
    expect(accept(1, 'observation.content.chunk', chunk)).toMatchObject({ status: 'accepted' });
    expect(accept(2, 'observation.content.chunk', chunk)).toMatchObject({
      status: 'conflict',
      code: 'worker_control_sequence_conflict',
    });
    expect(accept(1, 'observation.content.chunk', chunk)).toMatchObject({
      status: 'accepted',
      duplicate: true,
      nextExpectedSequence: 2,
    });
    expect(accept(2, 'observation.content.chunk', { ...chunk, chunkIndex: 1 })).toMatchObject({
      status: 'accepted',
      duplicate: false,
      nextExpectedSequence: 3,
    });
  });

  it('refuses malformed retained JSON even when a retry supplies identical text', () => {
    expect(
      createWorkerControlSequenceRecorder(coreDb).accept({ ...input, fingerprint: original })
    ).toMatchObject({ status: 'accepted', duplicate: false });
    // Damage valid owner-produced state to prove retained-input failure stays closed.
    coreDb.sqlite
      .prepare('UPDATE worker_control_sequence_fingerprints SET fingerprint = ?')
      .run('{');
    coreDb.sqlite.close();
    coreDb = openNanoHostOwner(dataRoot);

    let status = 'refused';
    try {
      status = createWorkerControlSequenceRecorder(coreDb).accept({
        ...input,
        fingerprint: '{',
      }).status;
    } catch {
      // Both a typed refusal and a retained-data exception fail closed.
    }
    expect(status).not.toBe('accepted');
    expect(
      coreDb.sqlite.prepare('SELECT fingerprint FROM worker_control_sequence_fingerprints').all()
    ).toEqual([{ fingerprint: '{' }]);
  });
});
