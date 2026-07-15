import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  listWorkerControlAcceptedEvents,
  recordWorkerControlAcceptedRecord,
} from './worker-control-records.js';

const lineage: WorkerLineage = {
  agentSessionId: 'as_events_1',
  packageSnapshotId: 'aepsnap_events_1',
  requestId: 'req_events_1',
  threadId: 'th_events_1',
  turnId: 'turn_events_1',
  workspaceId: 'ws_events_1',
};

/**
 * Builds one canonical event record for durable reader tests.
 *
 * @param sequence Worker event sequence.
 * @param recordLineage Embedded canonical event lineage.
 * @returns Canonical heartbeat event record.
 */
function eventRecord(sequence: number, recordLineage = lineage): WorkerCanonicalEventRecord {
  return {
    event: { data: { status: 'running' }, type: 'worker.heartbeat' },
    kind: 'event',
    lineage: recordLineage,
    schemaVersion: 1,
    sequence,
  };
}

describe('worker control accepted event records', () => {
  it('reads canonical events only from the complete package lineage in sequence order', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-events-')));
    applyMigrations(coreDb);
    const second = eventRecord(2);
    const first = eventRecord(1);
    const otherLineages: WorkerLineage[] = [
      { ...lineage, workspaceId: 'ws_events_other' },
      { ...lineage, threadId: 'th_events_other' },
      { ...lineage, turnId: 'turn_events_other' },
      { ...lineage, agentSessionId: 'as_events_other' },
      { ...lineage, packageSnapshotId: 'aepsnap_events_other' },
      { ...lineage, requestId: null },
    ];

    const records: Array<readonly [WorkerCanonicalEventRecord, string]> = [
      [second, '2026-07-15T00:00:02.000Z'],
      [first, '2026-07-15T00:00:01.000Z'],
      ...otherLineages.map(
        (recordLineage, index) =>
          [
            eventRecord(index + 10, recordLineage),
            `2026-07-15T00:00:${String(index + 10).padStart(2, '0')}.000Z`,
          ] as const
      ),
    ];

    for (const [record, acceptedAt] of records) {
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt,
        lineage: record.lineage,
        operation: 'event_append',
        record,
        recordKey: String(record.sequence),
        sequence: record.sequence,
      });
    }
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:00:03.000Z',
      lineage,
      operation: 'heartbeat',
      record: { status: 'running' },
      recordKey: '3',
      sequence: 3,
    });

    expect(listWorkerControlAcceptedEvents(coreDb, lineage)).toEqual([first, second]);

    const nullRequestLineage = {
      ...lineage,
      agentSessionId: 'as_events_null_request',
      packageSnapshotId: 'aepsnap_events_null_request',
      requestId: null,
    };
    const nullRequestRecord = eventRecord(20, nullRequestLineage);
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:00:20.000Z',
      lineage: nullRequestLineage,
      operation: 'event_append',
      record: nullRequestRecord,
      recordKey: '20',
      sequence: 20,
    });
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:00:21.000Z',
      lineage: { ...nullRequestLineage, requestId: 'req_events_other' },
      operation: 'event_append',
      record: eventRecord(21, { ...nullRequestLineage, requestId: 'req_events_other' }),
      recordKey: '21',
      sequence: 21,
    });
    expect(listWorkerControlAcceptedEvents(coreDb, nullRequestLineage)).toEqual([
      nullRequestRecord,
    ]);
    coreDb.sqlite.close();
  });

  it('fails closed when a durable event record is invalid or contradicts its row lineage', () => {
    for (const record of [
      { invalid: true },
      eventRecord(1, { ...lineage, workspaceId: 'ws_embedded_other' }),
    ]) {
      const coreDb = openCoreDb(
        mkdtempSync(join(tmpdir(), 'openkit-worker-control-invalid-event-'))
      );
      applyMigrations(coreDb);
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-15T00:00:00.000Z',
        lineage,
        operation: 'event_append',
        record,
        recordKey: '1',
        sequence: 1,
      });

      expect(() => listWorkerControlAcceptedEvents(coreDb, lineage)).toThrow();
      coreDb.sqlite.close();
    }
  });
});
