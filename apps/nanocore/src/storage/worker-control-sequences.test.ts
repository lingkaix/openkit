import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerControlSequenceRecorder } from '../runtime/worker-control-sequences.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

describe('retained Worker control sequence fingerprints', () => {
  let dataRoot: string;
  let coreDb: CoreDb;
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
    coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
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
    coreDb = openCoreDb(dataRoot);
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

  it('refuses malformed retained JSON even when a retry supplies identical text', () => {
    expect(
      createWorkerControlSequenceRecorder(coreDb).accept({ ...input, fingerprint: original })
    ).toMatchObject({ status: 'accepted', duplicate: false });
    // Damage valid owner-produced state to prove retained-input failure stays closed.
    coreDb.sqlite
      .prepare('UPDATE worker_control_sequence_fingerprints SET fingerprint = ?')
      .run('{');
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);

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
