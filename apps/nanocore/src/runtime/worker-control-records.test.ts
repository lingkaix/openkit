import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  listWorkerControlAcceptedEvents,
  recordWorkerControlAcceptedRecord,
  waitForWorkerControlFinalStatus,
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

/** Inserts one exact scheduler lease for durable completion-wait tests. */
function insertWorkerLease(
  coreDb: ReturnType<typeof openCoreDb>,
  options: { expiresAt: string; status?: string } = {
    expiresAt: '2026-07-15T00:15:00.000Z',
  }
): void {
  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_session_leases (
        lease_id,
        plan_id,
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        pool_id,
        target_id,
        status,
        acquired_at,
        expires_at,
        heartbeat_deadline,
        startup_deadline,
        renewal_count,
        scheduler_epoch,
        sandbox_binding_ref,
        backend_anchor_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'lease_events_1',
      'plan_events_1',
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      'pool_events_1',
      'target_events_1',
      options.status ?? 'active',
      '2026-07-15T00:00:00.000Z',
      options.expiresAt,
      options.expiresAt,
      options.expiresAt,
      0,
      1,
      'lease-binding:events-1',
      'anchored'
    );
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

describe('durable worker final-status wait', () => {
  it('waits until the exact final status is durable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:01:00.000Z'));
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-final-status-wait-')));
    applyMigrations(coreDb);
    insertWorkerLease(coreDb);

    try {
      const completion = waitForWorkerControlFinalStatus(coreDb, {
        leaseId: 'lease_events_1',
        lineage,
      });
      let settled = false;
      completion.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-15T00:01:01.000Z',
        lineage,
        operation: 'final_status',
        record: { sequence: 9, status: 'completed', stopReason: 'completed' },
        recordKey: '9',
        sequence: 9,
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(completion).resolves.toEqual({
        acceptedAt: '2026-07-15T00:01:01.000Z',
        status: 'completed',
      });
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
  });

  it('accepts only exact durable lineage and lets accepted final status outlive lease expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:31.000Z'));
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-final-status-lineage-')));
    applyMigrations(coreDb);
    insertWorkerLease(coreDb, { expiresAt: '2026-07-15T00:00:30.000Z' });
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:00:20.000Z',
      lineage: { ...lineage, packageSnapshotId: 'aepsnap_events_other' },
      operation: 'final_status',
      record: { sequence: 9, status: 'completed', stopReason: 'completed' },
      recordKey: '9',
      sequence: 9,
    });

    await expect(
      waitForWorkerControlFinalStatus(coreDb, {
        leaseId: 'lease_events_1',
        lineage,
      })
    ).rejects.toThrow('expired before durable final status');

    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:00:25.000Z',
      lineage,
      operation: 'final_status',
      record: { sequence: 9, status: 'completed', stopReason: 'completed' },
      recordKey: '9',
      sequence: 9,
    });
    await expect(
      waitForWorkerControlFinalStatus(coreDb, {
        leaseId: 'lease_events_1',
        lineage,
      })
    ).resolves.toEqual({ acceptedAt: '2026-07-15T00:00:25.000Z', status: 'completed' });

    coreDb.sqlite.close();
    vi.useRealTimers();
  });
});
