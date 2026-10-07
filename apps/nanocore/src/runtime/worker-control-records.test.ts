import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { markSchedulerExecutionAttemptClosing } from './execution-attempt-records.js';
import {
  canonicalStopReasonForAcceptedWorkerFinalStatus,
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
  recordWorkerControlAcceptedRecord,
  resolveWorkerControlFinalStatusTokenBinding,
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

/** Establishes exact submitted attempt authority for the durable final-status waiter. */
function insertWorkerAttempt(coreDb: ReturnType<typeof openCoreDb>): void {
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: lineage.workspaceId,
    ownerUserId: 'user_local',
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'queue_events_wait',
    requestId: lineage.requestId,
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    turnId: lineage.turnId,
    turnInput: 'Wait for the exact durable worker final status',
    requestedAgentId: 'agent_worker',
    triggerActor: { kind: 'user', id: 'user_local' },
    now: () => '2026-07-15T00:00:00.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: 'lease_events_1',
    agentSessionId: lineage.agentSessionId,
    inputRef: lineage.packageSnapshotId,
    bindingRef: 'lease-binding:events-1',
    sessionCompatibilityKey: 'events-wait',
    operationId: 'submit:events-wait',
    now: () => '2026-07-15T00:00:00.000Z',
  });
}

/**
 * Creates one admission-backed submitted Native attempt for final-status binding tests.
 *
 * @param coreDb Open Core database handle.
 */
function createFinalStatusAttempt(coreDb: ReturnType<typeof openCoreDb>): void {
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: lineage.workspaceId,
    ownerUserId: 'user_local',
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    now: () => '2026-07-15T00:00:00.000Z',
    profileRef: 'profile_worker',
    queueEntryId: 'queue_events_final_status',
    requestId: lineage.requestId,
    requestedAgentId: 'agent_worker',
    threadId: lineage.threadId,
    triggerActor: { kind: 'user', id: 'user_local' },
    turnId: lineage.turnId,
    turnInput: 'Run final-status binding test',
    workspaceId: lineage.workspaceId,
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: 'lease_events_final_status',
    agentSessionId: lineage.agentSessionId,
    inputRef: lineage.packageSnapshotId,
    bindingRef: 'lease-binding:events-final-status',
    sessionCompatibilityKey: 'events-final-status',
    operationId: 'submit:events-final-status',
    now: () => new Date().toISOString(),
  });
}

describe('worker final-status token binding', () => {
  it('accepts exact live request lineage without projecting a physical owner', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:02.000Z'));
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-binding-live-')));
    applyMigrations(coreDb);
    createFinalStatusAttempt(coreDb);

    try {
      vi.setSystemTime(new Date('2026-07-15T00:00:10.000Z'));
      expect(
        resolveWorkerControlFinalStatusTokenBinding(coreDb, {
          lineage,
          sandboxBindingRef: 'lease-binding:events-final-status',
        })
      ).toEqual({ replayOnly: false, status: 'accepted' });
      expect(
        resolveWorkerControlFinalStatusTokenBinding(coreDb, {
          lineage: { ...lineage, requestId: 'req_events_other' },
          sandboxBindingRef: 'lease-binding:events-final-status',
        })
      ).toEqual({ reason: 'lineage-mismatch', status: 'rejected' });
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
  });

  it('admits closing replay only for an exact durable request id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:02.000Z'));
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-status-binding-replay-')));
    applyMigrations(coreDb);
    createFinalStatusAttempt(coreDb);
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:00:03.000Z',
      lineage: { ...lineage, requestId: 'req_events_other' },
      operation: 'final_status',
      record: { sequence: 8, status: 'completed', stopReason: 'completed' },
      recordKey: '8',
      sequence: 8,
    });
    markSchedulerExecutionAttemptClosing(coreDb, {
      attemptId: 'lease_events_final_status',
      now: () => '2026-07-15T00:00:04.000Z',
      cause: 'worker-final-status',
    });

    try {
      vi.setSystemTime(new Date('2026-07-15T00:00:10.000Z'));
      expect(
        resolveWorkerControlFinalStatusTokenBinding(coreDb, {
          lineage: { ...lineage, requestId: 'req_events_other' },
          sandboxBindingRef: 'lease-binding:events-final-status',
        })
      ).toEqual({ reason: 'lineage-mismatch', status: 'rejected' });
      expect(
        resolveWorkerControlFinalStatusTokenBinding(coreDb, {
          lineage,
          sandboxBindingRef: 'lease-binding:events-final-status',
        })
      ).toEqual({ reason: 'attempt-not-live', status: 'rejected' });

      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-15T00:00:05.000Z',
        lineage,
        operation: 'final_status',
        record: { sequence: 9, status: 'completed', stopReason: 'completed' },
        recordKey: '9',
        sequence: 9,
      });

      expect(
        resolveWorkerControlFinalStatusTokenBinding(coreDb, {
          lineage,
          sandboxBindingRef: 'lease-binding:events-final-status',
        })
      ).toEqual({ replayOnly: true, status: 'accepted' });
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
  });
});

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
        record: eventRecord(1),
        recordKey: '1',
        sequence: 1,
      });
      // Corrupt the durable artifact directly: the production recorder now validates ingress too.
      coreDb.sqlite
        .prepare('UPDATE worker_control_records SET record_json = ?')
        .run(JSON.stringify(record));
      expect(() => listWorkerControlAcceptedEvents(coreDb, lineage)).toThrow();
      coreDb.sqlite.close();
    }
  });
});

describe('durable failure diagnostics', () => {
  it('retains admitted cause diagnostics online and after database reopen', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-failure-cause-'));
    let coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const diagnostics = {
      failureCause: 'DeepSeek model returned a completed response with no content.',
      cleanup: 'host stopped',
    };
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:01:01.000Z',
      lineage,
      operation: 'final_status',
      record: { sequence: 9, status: 'failed', stopReason: 'error', diagnostics },
      recordKey: '9',
      sequence: 9,
    });
    try {
      expect(getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toMatchObject({ diagnostics });
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      expect(getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toMatchObject({ diagnostics });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    null,
    { failureCause: 7 },
    ['native failure'],
  ])('refuses malformed durable diagnostics: %j', (diagnostics) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-invalid-failure-cause-')));
    applyMigrations(coreDb);
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:01:01.000Z',
      lineage,
      operation: 'final_status',
      record: { sequence: 9, status: 'failed', stopReason: 'error', diagnostics },
      recordKey: '9',
      sequence: 9,
    });
    try {
      expect(() => getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toThrow();
    } finally {
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
    insertWorkerAttempt(coreDb);

    try {
      const completion = waitForWorkerControlFinalStatus(coreDb, {
        attemptId: 'lease_events_1',
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
        stopReason: 'completed',
      });
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
  });

  it('accepts only exact durable lineage and lets accepted final status outlive attempt expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T02:00:01.000Z'));
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-final-status-lineage-')));
    applyMigrations(coreDb);
    insertWorkerAttempt(coreDb);
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
        attemptId: 'lease_events_1',
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
        attemptId: 'lease_events_1',
        lineage,
      })
    ).resolves.toEqual({
      acceptedAt: '2026-07-15T00:00:25.000Z',
      status: 'completed',
      stopReason: 'completed',
    });

    coreDb.sqlite.close();
    vi.useRealTimers();
  });
});

describe('accepted worker final-status canonicalization', () => {
  it.each([
    ['completed', 'completed'],
    ['blocked', 'length'],
    ['blocked', 'budget_exhausted'],
    ['cancelled', 'aborted'],
    ['interrupted', 'aborted'],
    ['failed', 'error'],
    ['degraded', 'error'],
    ['lost', 'error'],
  ] as const)('canonicalizes %s with %s', (status, stopReason) => {
    expect(
      canonicalStopReasonForAcceptedWorkerFinalStatus({
        acceptedAt: '2026-07-15T00:01:01.000Z',
        status,
        stopReason,
      })
    ).toBe(stopReason);
  });

  it('fails closed when an accepted final status still carries the removed ask_user stop reason', () => {
    expect(() =>
      canonicalStopReasonForAcceptedWorkerFinalStatus({
        acceptedAt: '2026-07-15T00:01:01.000Z',
        status: 'blocked',
        stopReason: 'ask_user',
      })
    ).toThrow('recovery_required');
  });

  it.each([
    ['completed', 'error'],
    ['blocked', 'completed'],
    ['cancelled', 'error'],
    ['failed', 'failed'],
    ['lost', 'unknown'],
  ] as const)('rejects incompatible %s with %s', (status, stopReason) => {
    expect(() =>
      canonicalStopReasonForAcceptedWorkerFinalStatus({
        acceptedAt: '2026-07-15T00:01:01.000Z',
        status,
        stopReason,
      })
    ).toThrow('Accepted worker final status has no canonical Core StopReason.');
  });
});
