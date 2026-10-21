import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readThreadRuntimeActivity, readWorkObservations } from '../storage/work-observations.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { markSchedulerExecutionAttemptClosing } from './execution-attempt-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import {
  getWorkerBackendSession,
  recordWorkerBackendSessionMaterializing,
} from './worker-backend-sessions.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import {
  canonicalStopReasonForAcceptedWorkerFinalStatus,
  createWorkerControlAcceptedRecordRecorder,
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
  recordWorkerControlAcceptedRecord,
  resolveWorkerControlFinalStatusTokenBinding,
  waitForWorkerControlFinalStatus,
} from './worker-control-records.js';
import { createWorkerControlSequenceRecorder } from './worker-control-sequences.js';

const lineage: WorkerLineage = {
  agentSessionId: 'as_00000000-0000-7e3a-a966-bbf1c9a21fcc',
  packageSnapshotId: 'aepsnap_events_1',
  requestId: 'req_events_1',
  threadId: 'th_00000000-0000-7ccc-992e-e88b1e35ca99',
  turnId: 'tu_00000000-0000-7056-a6b5-80ab0aaa7f63',
  workspaceId: 'ws_00000000-0000-708d-8de8-225685139ab1',
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
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    now: () => '2026-07-15T00:00:00.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'lease_events_1'),
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
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    now: () => '2026-07-15T00:00:00.000Z',
    profileRef: 'profile_worker',
    queueEntryId: 'queue_events_final_status',
    requestId: lineage.requestId,
    requestedAgentId: 'agent_worker',
    threadId: lineage.threadId,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    turnId: lineage.turnId,
    turnInput: 'Run final-status binding test',
    workspaceId: lineage.workspaceId,
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'lease_events_final_status'),
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
      attemptId: testEntityId('attempt', 'lease_events_final_status'),
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
      { ...lineage, workspaceId: 'ws_00000000-0000-734b-bd0c-14f97b7a79e8' },
      { ...lineage, threadId: 'th_00000000-0000-7bcd-b2ee-62461f26417e' },
      { ...lineage, turnId: 'tu_00000000-0000-7fa0-af79-2182b18f7840' },
      { ...lineage, agentSessionId: 'as_00000000-0000-7644-b75e-e0ae1ac7e602' },
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
      agentSessionId: 'as_00000000-0000-732f-9aef-8202afffc559',
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
      eventRecord(1, { ...lineage, workspaceId: 'ws_00000000-0000-7aae-857d-5f1cc2c3e110' }),
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
  it('writes v1 control records and retains cause diagnostics online and after database reopen', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-failure-cause-'));
    let coreDb = openCoreDb(dataRoot);
    onTestFinished(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    });
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
      const retained = coreDb.sqlite
        .prepare(`SELECT schema_version AS schemaVersion,
        record_json FROM worker_control_records`)
        .get();
      expect(retained).toMatchObject({ schemaVersion: 1 });
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      expect(getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toMatchObject({ diagnostics });
      expect(
        coreDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion,
        record_json FROM worker_control_records`)
          .get()
      ).toEqual(retained);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses unknown control versions before receipt decode, replay or closing token admission', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:02.000Z'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-version-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => {
      vi.useRealTimers();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    });
    try {
      applyMigrations(coreDb);
      createFinalStatusAttempt(coreDb);
      const event = eventRecord(1);
      const input = {
        acceptedAt: '2026-07-15T00:00:03.000Z',
        lineage,
        operation: 'event_append' as const,
        record: event,
        recordKey: '1',
        sequence: 1,
      };
      recordWorkerControlAcceptedRecord(coreDb, input);
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-15T00:00:05.000Z',
        lineage,
        operation: 'final_status',
        record: { sequence: 9, status: 'completed', stopReason: 'completed' },
        recordKey: '9',
        sequence: 9,
      });
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: testEntityId('attempt', 'lease_events_final_status'),
        now: () => '2026-07-15T00:00:04.000Z',
        cause: 'worker-final-status',
      });
      coreDb.sqlite.exec("UPDATE worker_control_records SET schema_version = 2, record_json = '{'");
      coreDb.sqlite.exec(`CREATE TRIGGER reject_unsupported_control_insert BEFORE INSERT ON worker_control_records
        BEGIN SELECT RAISE(FAIL, 'Unsupported control record reached an INSERT'); END`);
      expect(() => listWorkerControlAcceptedEvents(coreDb, lineage)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => getWorkerControlAcceptedFinalStatus(coreDb, lineage)).toThrow(
        'Unsupported retained record format.'
      );
      expect(() => recordWorkerControlAcceptedRecord(coreDb, input)).toThrow(
        'Unsupported retained record format.'
      );
      vi.setSystemTime(new Date('2026-07-15T00:00:10.000Z'));
      expect(() =>
        resolveWorkerControlFinalStatusTokenBinding(coreDb, {
          lineage,
          sandboxBindingRef: 'lease-binding:events-final-status',
        })
      ).toThrow('Unsupported retained record format.');
      expect(
        coreDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, record_json
        FROM worker_control_records ORDER BY sequence`)
          .all()
      ).toEqual([
        { schemaVersion: 2, record_json: '{' },
        { schemaVersion: 2, record_json: '{' },
      ]);
    } finally {
      vi.useRealTimers();
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
        attemptId: testEntityId('attempt', 'lease_events_1'),
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
        attemptId: testEntityId('attempt', 'lease_events_1'),
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
        attemptId: testEntityId('attempt', 'lease_events_1'),
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

/** Native final evidence remains the prerequisite; online and restart callers share the durable cause mapping. */
it.each([
  ['turn-cancelled', 'aborted'],
  ['raw-output-exhausted', 'budget_exhausted'],
  ['raw-output-unavailable', 'error'],
] as const)('maps proved native stop for %s to %s', (cause, expected) => {
  const accepted = {
    acceptedAt: new Date().toISOString(),
    status: 'cancelled' as const,
    stopReason: 'aborted',
    diagnostics: [],
  };
  expect(canonicalStopReasonForAcceptedWorkerFinalStatus(accepted, cause)).toBe(expected);
  expect(() =>
    canonicalStopReasonForAcceptedWorkerFinalStatus({ ...accepted, status: 'completed' }, cause)
  ).toThrow('canonical');
});

/** Real Turn, named retained AEP, token-authenticated gateway, receipts and restricted body store. */
async function nativeReceiver(captureValue: 'on' | 'off' = 'on', bound: number | null = 8) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-ret2-receiver-'));
  let coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  store.setLiveCaptureCoverage({ scope: 'server', value: captureValue });
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Native receiver',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }
  );
  const agentSessionId = testEntityId('as', 'ret2-native');
  const pkg = resolveAgentEnvironmentPackage({
    captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
    agentSetup: createTestAgentSetup(),
    agentSessionId,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    backend: { kind: 'openshell' },
    turn,
    workspaceRoots: [],
    requestId: 'req_ret2',
  });
  // Explicit admitted package fixture; real policy selection has its own resolver test.
  pkg.observability.evidence = { ...pkg.observability.evidence };
  delete pkg.observability.evidence.nativeLogMaxBytes;
  if (bound !== null) pkg.observability.evidence.nativeLogMaxBytes = bound;
  await store.createAgentSession({
    id: agentSessionId,
    agentId: pkg.agent.agentId,
    workspaceId: pkg.scope.workspaceId,
    threadId: turn.threadId,
    status: 'busy',
    message: null,
    createdAt: turn.startedAt!,
    updatedAt: turn.startedAt!,
  });
  await store.updateTurn(turn.id, { agentSessionId });
  const db = openWorkspaceDb(root, pkg.scope.workspaceId);
  applyScopedMigrations(db);
  recordAgentEnvironmentPackageSnapshot(db, { environmentPackage: pkg, createdAt: pkg.createdAt });
  const owner = { threadId: turn.threadId, turnId: turn.id };
  let activePackage = pkg;
  let activeTokens = {
    workerControlToken: 'A'.repeat(43),
    workerInferenceToken: 'B'.repeat(43),
    workerCapabilityToken: 'C'.repeat(43),
  };
  const selectedLineage = {
    ...owner,
    workspaceId: pkg.scope.workspaceId,
    agentSessionId,
    requestId: 'req_ret2',
    packageSnapshotId: pkg.snapshotId,
  };
  const makeGateway = () => {
    const gateway = new WorkerControlGateway({
      sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
    });
    gateway.registerSession(activePackage, activeTokens);
    return gateway;
  };
  let gateway = makeGateway();
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const send = async (
    sequence: number,
    type: string,
    data: unknown,
    options: { authorization?: string; lineage?: typeof selectedLineage } = {}
  ) => {
    const recordLineage = options.lineage ?? selectedLineage;
    try {
      return {
        accepted: (
          await gateway.appendEvent({
            authorization: options.authorization ?? `Bearer ${activeTokens.workerControlToken}`,
            lineage: selectedLineage,
            record: {
              schemaVersion: 1,
              kind: 'event',
              lineage: recordLineage,
              sequence,
              event: { type, data },
            },
          })
        ).accepted,
        error: null,
      };
    } catch (error) {
      return { accepted: false, error };
    }
  };
  // This accepted control proves registration, database, binding and transport setup on the RED base.
  expect((await send(0, 'worker.heartbeat', { status: 'running' })).accepted).toBe(true);
  return {
    get coreDb() {
      return coreDb;
    },
    db,
    root,
    pkg,
    owner,
    lineage: selectedLineage,
    store,
    send,
    rows: () => readWorkObservations(db, owner),
    receipts: () =>
      coreDb.sqlite
        .prepare('SELECT record_json FROM worker_control_records ORDER BY sequence')
        .all(),
    restart: () => {
      coreDb.sqlite.close();
      coreDb = openCoreDb(root);
      gateway = makeGateway();
    },
    secondPackage: async () => {
      const second = { ...pkg, snapshotId: `${pkg.snapshotId}_second` };
      recordAgentEnvironmentPackageSnapshot(db, {
        environmentPackage: second,
        createdAt: second.createdAt,
      });
      selectedLineage.packageSnapshotId = second.snapshotId;
      activePackage = second;
      activeTokens = {
        workerControlToken: 'E'.repeat(43),
        workerInferenceToken: 'F'.repeat(43),
        workerCapabilityToken: 'G'.repeat(43),
      };
      gateway.registerSession(activePackage, activeTokens);
      // Authenticate the second package before a quota refusal can count as evidence.
      expect((await send(0, 'worker.heartbeat', { status: 'running' })).accepted).toBe(true);
    },
  };
}

/** Expected native bytes use source coordinates, never transport byteOffset as native position. */
function nativeMetadata(
  f: ReturnType<typeof nativeReceiver>,
  id: string,
  bytes: Buffer,
  options: {
    kind?: 'runtime-log' | 'native-transcript';
    sourceKind?: 'stderr' | 'stdout-log';
    sourceRef?: string;
    sourceSequence?: number;
    start?: number;
    chunkCount?: number;
  } = {}
) {
  const kind = options.kind ?? 'runtime-log';
  const start = options.start ?? 32;
  return {
    observationId: id,
    sourceRef: options.sourceRef ?? `source-${id}`,
    sourceSequence: options.sourceSequence ?? 0,
    observedAt: f.pkg.createdAt,
    fact: {
      kind,
      runtimeOriginRef: 'native-origin',
      coverage: 'collecting',
      native: {
        harness: 'codex',
        authoredVersion: 'test',
        measuredVersion: null,
        imageDigest: null,
        format: kind === 'runtime-log' ? 'application/octet-stream' : 'codex-session-jsonl',
        preLaunchWatermark: 32,
        range: { start, end: start + bytes.length },
        observedBytes: bytes.length,
        retainedBytes: bytes.length,
        omittedBytes: null,
        sourceEnded: false,
        ...(kind === 'runtime-log' ? { logSource: options.sourceKind ?? 'stderr' } : {}),
      },
    },
    content: {
      state: 'expected',
      mediaType: 'application/octet-stream',
      boundary: 'native-content-v1',
      bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      chunkCount: options.chunkCount ?? (bytes.length ? 1 : 0),
    },
  };
}

/** Builds the existing bounded binary transport record without a replacement producer. */
function nativeChunk(observationId: string, bytes: Buffer, chunkIndex = 0, byteOffset = 0) {
  return {
    observationId,
    chunkIndex,
    byteOffset,
    encoding: 'base64',
    data: bytes.toString('base64'),
  };
}

/** Reads only storage-owned publication refs through the existing restricted body reader. */
function nativeBodies(f: ReturnType<typeof nativeReceiver>) {
  return f
    .rows()
    .filter((row) => row.type === 'content.published')
    .map((row) => {
      const ref = row.refs!.find((ref) => ref.edge === 'publication')!;
      const parent = f.rows().find((candidate) => candidate.id === row.parent)!;
      const bytes = readWorkObservationBody(f.db, {
        ...f.owner,
        bundleId: ref.locator,
        createdAt: parent.ts,
        sha256: ref.digest!,
      });
      return { ref, bytes: bytes === null ? null : Buffer.from(bytes) };
    });
}

/** Records an image through the existing trusted backend owner, without a Worker-supplied grant. */
function nativeImageBinding(
  f: ReturnType<typeof nativeReceiver>,
  imageRef: string,
  bindingLineage = f.lineage
) {
  const { coreDb } = f;
  const now = () => f.pkg.createdAt;
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: bindingLineage.workspaceId,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'queue_ret2_image',
    requestId: bindingLineage.requestId,
    workspaceId: bindingLineage.workspaceId,
    threadId: bindingLineage.threadId,
    turnId: bindingLineage.turnId,
    turnInput: 'Retain the exact backend image binding',
    requestedAgentId: f.pkg.agent.agentId,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    now,
  });
  const attemptId = testEntityId('attempt', 'ret2-image');
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId,
    agentSessionId: bindingLineage.agentSessionId,
    inputRef: bindingLineage.packageSnapshotId,
    bindingRef: 'lease-binding:ret2-image',
    sessionCompatibilityKey: 'ret2-image',
    now,
  });
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'deployment-ret2-image',
    identityId: 'nanohost-ret2-image',
    observedAt: now(),
    targetId: 'runtime-target-ret2-image',
  });
  upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    observedAt: now(),
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
  const recorded = recordWorkerBackendSessionMaterializing(coreDb, {
    backendLineage: { kind: 'reference', imageRef },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: bindingLineage.agentSessionId,
      backendKind: f.pkg.backend.preferred,
      backendSessionId: 'nh-ret2-image',
      deploymentId: target.deploymentId,
      packageSnapshotId: bindingLineage.packageSnapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${bindingLineage.packageSnapshotId}`,
      transientProviderInstanceId: null,
    },
    lineage: bindingLineage,
    now,
    sandboxBindingRef: 'lease-binding:ret2-image',
  });
  expect(getWorkerBackendSession(coreDb, attemptId)).toEqual(recorded);
  expect(recorded).toMatchObject({
    workspaceId: bindingLineage.workspaceId,
    threadId: bindingLineage.threadId,
    turnId: bindingLineage.turnId,
    agentSessionId: bindingLineage.agentSessionId,
    packageSnapshotId: bindingLineage.packageSnapshotId,
    backendLineage: { imageRef },
  });
  return recorded;
}

// WCP §Authentication: each registered package must prove its own token and exact lineage.
it('RET-2 authenticates the second package with its own token before and after reopen', async () => {
  const f = await nativeReceiver();
  await f.secondPackage();
  expect(
    (
      await f.send(
        1,
        'worker.heartbeat',
        { status: 'running' },
        {
          authorization: `Bearer ${'A'.repeat(43)}`,
        }
      )
    ).accepted
  ).toBe(false);
  expect((await f.send(1, 'worker.heartbeat', { status: 'running' })).accepted).toBe(true);
  f.restart();
  expect((await f.send(1, 'worker.heartbeat', { status: 'running' })).accepted).toBe(true);
});

// RET §Native Transcripts And Runtime Logs: admitted image identity belongs to the backend owner.
it('RET-2 retains the exact trusted backend image binding independently of native metadata', async () => {
  const f = await nativeReceiver();
  const binding = nativeImageBinding(f, `registry.test/worker@sha256:${'a'.repeat(64)}`);
  f.restart();
  expect(getWorkerBackendSession(f.coreDb, binding.attemptId)).toEqual(binding);
  expect((await f.send(1, 'worker.heartbeat', { status: 'running' })).accepted).toBe(true);
});

// RET §Native Transcripts And Runtime Logs: only the exact trusted binding can verify an image claim.
it('RET-2 accepts a trusted image match and unknown identity but refuses a fresh-source wrong digest', async () => {
  const f = await nativeReceiver();
  const trustedDigest = `sha256:${'a'.repeat(64)}`;
  nativeImageBinding(f, `registry.test/worker@${trustedDigest}`);
  const match = nativeMetadata(f, 'trusted-match', Buffer.from('x'));
  const matched = {
    ...match,
    fact: { ...match.fact, native: { ...match.fact.native, imageDigest: trustedDigest } },
  };
  expect((await f.send(1, 'observation.recorded', matched)).accepted).toBe(true);
  expect(f.rows()[0]!.payload).toEqual(matched);
  const before = f.receipts();
  // Both source identity and event sequence are fresh: no earlier source claim can reject this.
  const wrong = nativeMetadata(f, 'wrong-image-fresh-source', Buffer.from('y'));
  expect(
    (
      await f.send(2, 'observation.recorded', {
        ...wrong,
        fact: {
          ...wrong.fact,
          native: { ...wrong.fact.native, imageDigest: `sha256:${'b'.repeat(64)}` },
        },
      })
    ).accepted
  ).toBe(false);
  expect(f.receipts()).toEqual(before);
  expect(f.rows()).toHaveLength(1);
  const unknown = nativeMetadata(f, 'unknown-image', Buffer.from('z'));
  expect((await f.send(3, 'observation.recorded', unknown)).accepted).toBe(true);
  expect(f.rows()[1]!.payload).toEqual(unknown);
});

// WCP native provenance: an unbound Worker-reported digest stays descriptive, never capture authority.
it.each([
  'missing',
  'foreign-package',
  'foreign-session',
  'non-digest',
] as const)('RET-2 a %s trusted image binding cannot verify or authorize a Worker image claim', async (binding) => {
  const f = await nativeReceiver();
  if (binding !== 'missing') {
    nativeImageBinding(
      f,
      binding === 'non-digest'
        ? 'registry.test/worker:authored-label'
        : `registry.test/worker@sha256:${'a'.repeat(64)}`,
      {
        ...f.lineage,
        ...(binding === 'foreign-package' ? { packageSnapshotId: 'aep_foreign_image' } : {}),
        ...(binding === 'foreign-session'
          ? { agentSessionId: testEntityId('as', 'foreign-image') }
          : {}),
      }
    );
  }
  const first = nativeMetadata(f, 'unverified-image', Buffer.from('x'));
  const claimed = {
    ...first,
    fact: {
      ...first.fact,
      native: { ...first.fact.native, imageDigest: `sha256:${'b'.repeat(64)}` },
    },
  };
  expect((await f.send(1, 'observation.recorded', claimed)).accepted).toBe(true);
  expect(f.rows()[0]!.payload).toEqual(claimed);
  expect(f.rows()[0]!.obs).toBe('worker-shim');
  // An earlier unverified claim cannot become authority for the next native source range.
  const next = nativeMetadata(f, 'another-unverified-image', Buffer.from('y'), {
    sourceRef: first.sourceRef,
    sourceSequence: 1,
    start: 33,
  });
  const changedClaim = {
    ...next,
    fact: {
      ...next.fact,
      native: { ...next.fact.native, imageDigest: `sha256:${'c'.repeat(64)}` },
    },
  };
  expect((await f.send(2, 'observation.recorded', changedClaim)).accepted).toBe(true);
  expect(f.rows()[1]!.payload).toEqual(changedClaim);
  const before = f.receipts();
  const overCap = nativeMetadata(f, 'image-cannot-grant-budget', Buffer.alloc(9));
  expect(
    (
      await f.send(3, 'observation.recorded', {
        ...overCap,
        fact: {
          ...overCap.fact,
          native: { ...overCap.fact.native, imageDigest: claimed.fact.native.imageDigest },
        },
      })
    ).accepted
  ).toBe(false);
  expect(f.receipts()).toEqual(before);
  expect(f.rows()).toHaveLength(2);
});

// Web §Runtime Activity In The Thread Timeline: unsupported/unavailable collectors map to unavailable.
it.each([
  'off',
  'unavailable',
] as const)('RET-2 a sole native %s observation cannot project collecting, partial or progress', async (state) => {
  const f = await nativeReceiver(state === 'off' ? 'off' : 'on');
  const value = nativeMetadata(f, 'sole-source', Buffer.alloc(0));
  const observation = {
    ...value,
    fact: {
      ...value.fact,
      coverage: state,
      ...(state === 'unavailable' ? { reason: 'source-missing' } : {}),
      native: { ...value.fact.native, range: null, observedBytes: null },
    },
    content: state === 'off' ? { state: 'off' } : { state: 'unavailable', reason: 'unsupported' },
  };
  expect((await f.send(1, 'observation.recorded', observation)).accepted).toBe(true);
  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]!.payload).toEqual(observation);
  const activity = readThreadRuntimeActivity(f.db, {
    threadId: f.owner.threadId,
    turnIds: [f.owner.turnId],
  });
  expect(activity).toHaveLength(1);
  expect(activity[0]!.coverage).toBe('unavailable');
  expect(activity[0]!.contentCapture).toBe(state === 'off' ? 'off' : 'on');
  expect(activity[0]!.entries).toEqual([]);
  expect(nativeBodies(f)).toEqual([]);
  expect(f.store.getTurnById(f.owner.turnId).items).toEqual([]);
});

// RET §Native Transcripts And Runtime Logs: a truncated prefix is incomplete; Web §Runtime Activity In The Thread Timeline: partial capture stays partial.
it('RET-2 projects an unavailable native source with a published truncated prefix as partial without progress', async () => {
  const f = await nativeReceiver('on', 3);
  const bytes = Buffer.from('abc');
  const value = nativeMetadata(f, 'published-truncated-prefix', bytes, { start: 64 });
  const observation = {
    ...value,
    fact: {
      ...value.fact,
      coverage: 'unavailable',
      reason: 'limit-exceeded',
      native: {
        ...value.fact.native,
        range: { start: 64, end: 67 },
        observedBytes: 8,
        retainedBytes: 3,
        omittedBytes: 5,
      },
    },
  };
  expect(observation.content.bytes).toBe(3);
  expect((await f.send(1, 'observation.recorded', observation)).accepted).toBe(true);
  expect(nativeBodies(f)).toEqual([]);
  expect(
    (await f.send(2, 'observation.content.chunk', nativeChunk('published-truncated-prefix', bytes)))
      .accepted
  ).toBe(true);
  expect(f.rows().find((row) => row.type === 'runtime.observed')!.payload).toEqual(observation);
  expect(f.rows().filter((row) => row.type === 'content.published')).toHaveLength(1);
  const bodies = nativeBodies(f);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.bytes).toEqual(Buffer.from('abc'));
  const activity = readThreadRuntimeActivity(f.db, {
    threadId: f.owner.threadId,
    turnIds: [f.owner.turnId],
  });
  expect(activity).toHaveLength(1);
  expect(activity[0]!.coverage).toBe('partial');
  expect(activity[0]!.entries).toEqual([]);
  expect(f.store.getTurnById(f.owner.turnId).items).toEqual([]);
});

// RET §§Native Transcripts And Runtime Logs, Capture Safety And Restricted Access; WCP incremental observations.
it.each([
  'semantic-control',
  'native',
] as const)('RET-2 %s publishes exact binary and split UTF-8 only after verified chunks, with safe receipts and no ordinary body', async (mode) => {
  const f = await nativeReceiver();
  const bytes = Buffer.concat([Buffer.from([255, 0]), Buffer.from('雪\r\n')]);
  const native = nativeMetadata(f, 'binary', bytes, { chunkCount: 2 });
  const metadata =
    mode === 'native'
      ? native
      : {
          ...native,
          fact: {
            kind: 'assistant',
            runtimeOriginRef: null,
            phase: 'updated',
            messageRef: 'control',
            representation: 'delta',
          },
          content: { ...native.content, mediaType: 'text/plain', boundary: 'assistant.text' },
        };
  expect((await f.send(1, 'observation.recorded', metadata)).accepted).toBe(true);
  expect(
    (await f.send(2, 'observation.content.chunk', nativeChunk('binary', bytes.subarray(0, 3))))
      .accepted
  ).toBe(true);
  expect(nativeBodies(f)).toEqual([]);
  f.restart();
  // Fault at the existing body adoption boundary: staged bytes exist, but publication cannot write.
  const bundle = f.db.sqlite
    .prepare('SELECT evidence_bundle_id AS id FROM evidence_bundles')
    .get() as { id: string };
  const publicationPath = join(
    f.root,
    'workspaces',
    f.lineage.workspaceId,
    'evidence',
    'backend',
    bundle.id,
    'raw',
    'content'
  );
  mkdirSync(publicationPath);
  const priorReceipts = f.receipts();
  expect(
    (await f.send(3, 'observation.content.chunk', nativeChunk('binary', bytes.subarray(3), 1, 3)))
      .accepted
  ).toBe(false);
  expect(f.receipts()).toEqual(priorReceipts);
  expect(nativeBodies(f)).toEqual([]);
  rmSync(publicationPath, { recursive: true });
  expect(
    (await f.send(3, 'observation.content.chunk', nativeChunk('binary', bytes.subarray(3), 1, 3)))
      .accepted
  ).toBe(true);
  const [body] = nativeBodies(f);
  expect(body!.bytes).toEqual(bytes);
  expect(body!.ref.digest).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(body!.ref.scope).toEqual({ workspaceId: f.lineage.workspaceId, pathClass: 'backend' });
  const retained = f.rows().find((row) => row.type === 'runtime.observed')!;
  expect(retained.payload).toEqual(metadata);
  expect(retained.refs).toContainEqual({
    kind: 'aep-snapshot',
    scope: { workspaceId: f.lineage.workspaceId },
    locator: f.pkg.snapshotId,
    edge: 'association',
  });
  expect(JSON.stringify(f.receipts())).not.toContain(bytes.subarray(3).toString('base64'));
  expect(
    f.db.sqlite.prepare('SELECT retention_class, sensitivity_class FROM evidence_bundles').all()
  ).toEqual([{ retention_class: 'restricted-raw', sensitivity_class: 'restricted' }]);
  const activity = readThreadRuntimeActivity(f.db, {
    threadId: f.owner.threadId,
    turnIds: [f.owner.turnId],
  });
  expect(activity[0]!.entries.every((entry) => !('text' in entry))).toBe(true);
  expect(f.store.getTurnById(f.owner.turnId).items).toEqual([]);
});

// RET §Native Transcripts And Runtime Logs: combined per-Turn budget, immutable admission, transcripts independent.
it('RET-2 shares the cap across concurrent stderr/stdout sources and packages; reopen and replay cannot recharge it', async () => {
  const f = await nativeReceiver();
  const stderr = nativeMetadata(f, 'stderr', Buffer.from('abcd'));
  const stdout = nativeMetadata(f, 'stdout', Buffer.from('efgh'), { sourceKind: 'stdout-log' });
  expect((await f.send(1, 'observation.recorded', stderr)).accepted).toBe(true);
  // Reserve both units before either publishes: loss cannot free the potential bytes.
  expect((await f.send(2, 'observation.recorded', stdout)).accepted).toBe(true);
  expect(
    (
      await f.send(
        3,
        'observation.recorded',
        nativeMetadata(f, 'unpublished-overflow', Buffer.from('i'))
      )
    ).accepted
  ).toBe(false);
  expect(
    (await f.send(4, 'observation.content.chunk', nativeChunk('stderr', Buffer.from('abcd'))))
      .accepted
  ).toBe(true);
  f.restart();
  expect((await f.send(1, 'observation.recorded', stderr)).accepted).toBe(true);
  expect(
    (await f.send(4, 'observation.content.chunk', nativeChunk('stderr', Buffer.from('abcd'))))
      .accepted
  ).toBe(true);
  expect(
    (await f.send(5, 'observation.content.chunk', nativeChunk('stdout', Buffer.from('efgh'))))
      .accepted
  ).toBe(true);
  expect(nativeBodies(f).map((body) => body.bytes)).toEqual([
    Buffer.from('abcd'),
    Buffer.from('efgh'),
  ]);
  await f.secondPackage();
  const excess = nativeMetadata(f, 'excess', Buffer.from('i'));
  expect((await f.send(1, 'observation.recorded', excess)).accepted).toBe(false);
  const truncation = {
    ...excess,
    fact: {
      ...excess.fact,
      coverage: 'unavailable',
      reason: 'limit-exceeded',
      native: {
        ...excess.fact.native,
        range: null,
        retainedBytes: 0,
        observedBytes: null,
        omittedBytes: null,
      },
    },
    content: { state: 'unavailable', reason: 'truncated' },
  };
  expect((await f.send(2, 'observation.recorded', truncation)).accepted).toBe(true);
  expect(f.rows().find((row) => row.payload.observationId === 'excess')!.payload).toEqual(
    truncation
  );
  const transcript = nativeMetadata(
    f,
    'transcript',
    Buffer.from('native transcript exceeds the log cap'),
    { kind: 'native-transcript' }
  );
  expect((await f.send(3, 'observation.recorded', transcript)).accepted).toBe(true);
  expect(
    (
      await f.send(
        4,
        'observation.content.chunk',
        nativeChunk('transcript', Buffer.from('native transcript exceeds the log cap'))
      )
    ).accepted
  ).toBe(true);
  expect(nativeBodies(f)).toHaveLength(3);
  expect(
    f
      .rows()
      .filter((row) => row.type === 'runtime.observed')
      .map((row) => row.payload.observationId)
  ).toEqual(['stderr', 'stdout', 'excess', 'transcript']);
});

// WCP §Authentication and §Incremental Work Observations: outer lineage and storage-owned publication authority.
it('RET-2 rejects foreign scope/package/source, forged publication and divergent content without acknowledging it', async () => {
  const f = await nativeReceiver();
  const bytes = Buffer.from('safe');
  const metadata = nativeMetadata(f, 'authorized', bytes);
  expect((await f.send(1, 'observation.recorded', metadata)).accepted).toBe(true);
  const before = f.receipts();
  // A rejected durable event can retain its fingerprint; later events use fresh sequence numbers.
  let sequence = 2;
  for (const change of [{ harness: 'other-harness' }, { authoredVersion: 'other-version' }]) {
    expect(
      (
        await f.send(sequence++, 'observation.recorded', {
          ...metadata,
          observationId: 'foreign-native',
          fact: { ...metadata.fact, native: { ...metadata.fact.native, ...change } },
        })
      ).accepted
    ).toBe(false);
  }
  expect(
    (
      await f.send(sequence++, 'observation.content.chunk', nativeChunk('authorized', bytes), {
        authorization: `Bearer ${'D'.repeat(43)}`,
      })
    ).accepted
  ).toBe(false);
  for (const lineage of [
    { ...f.lineage, workspaceId: testEntityId('ws', 'foreign') },
    { ...f.lineage, packageSnapshotId: 'aep_foreign' },
  ]) {
    expect(
      (
        await f.send(sequence++, 'observation.content.chunk', nativeChunk('authorized', bytes), {
          lineage,
        })
      ).accepted
    ).toBe(false);
  }
  expect(
    (await f.send(sequence++, 'observation.recorded', { ...metadata, sourceRef: 'foreign-source' }))
      .accepted
  ).toBe(false);
  expect(
    (await f.send(sequence++, 'observation.content.chunk', nativeChunk('unannounced', bytes)))
      .accepted
  ).toBe(false);
  expect(
    (
      await f.send(sequence++, 'observation.recorded', {
        ...metadata,
        observationId: 'forged',
        content: { state: 'published', ref: 'forged' },
        refs: [{ edge: 'publication', locator: 'forged' }],
      })
    ).accepted
  ).toBe(false);
  expect(f.receipts()).toEqual(before);
  const publishedSequence = sequence++;
  expect(
    (await f.send(publishedSequence, 'observation.content.chunk', nativeChunk('authorized', bytes)))
      .accepted
  ).toBe(true);
  const committed = f.receipts();
  expect(
    (
      await f.send(
        publishedSequence,
        'observation.content.chunk',
        nativeChunk('authorized', Buffer.from('evil'))
      )
    ).accepted
  ).toBe(false);
  expect(f.receipts()).toEqual(committed);
  expect(nativeBodies(f)[0]!.bytes).toEqual(bytes);
});

// RET §Capture Publication, Restart And Disposal: committed prefix and unavailability survive interrupted publication.
it('RET-2 retains an interrupted prefix and explicit failure; missing chunks and digest mismatch never publish', async () => {
  const f = await nativeReceiver();
  const first = nativeMetadata(f, 'prefix', Buffer.from('ok'));
  expect((await f.send(1, 'observation.recorded', first)).accepted).toBe(true);
  expect(
    (await f.send(2, 'observation.content.chunk', nativeChunk('prefix', Buffer.from('ok'))))
      .accepted
  ).toBe(true);
  const next = nativeMetadata(f, 'incomplete', Buffer.from('abcd'), {
    chunkCount: 2,
    sourceRef: first.sourceRef,
    sourceSequence: 1,
    start: 34,
  });
  expect((await f.send(3, 'observation.recorded', next)).accepted).toBe(true);
  expect(
    (await f.send(4, 'observation.content.chunk', nativeChunk('incomplete', Buffer.from('ab'))))
      .accepted
  ).toBe(true);
  f.restart();
  expect(nativeBodies(f).map((body) => body.bytes)).toEqual([Buffer.from('ok')]);
  const receipts = f.receipts();
  expect(
    (
      await f.send(
        5,
        'observation.content.chunk',
        nativeChunk('incomplete', Buffer.from('xx'), 1, 2)
      )
    ).accepted
  ).toBe(false);
  expect(f.receipts()).toEqual(receipts);
  const failure = {
    ...next,
    observationId: 'interrupted',
    sourceSequence: 2,
    fact: {
      ...next.fact,
      native: { ...next.fact.native, range: null, observedBytes: null, retainedBytes: 0 },
      coverage: 'unavailable',
      reason: 'collector-failed',
    },
    content: {
      state: 'unavailable',
      reason: 'capture-failed',
      expectedObservationId: 'incomplete',
    },
  };
  expect((await f.send(6, 'observation.recorded', failure)).accepted).toBe(true);
  expect(f.rows().find((row) => row.payload.observationId === 'interrupted')!.payload).toEqual(
    failure
  );
  expect(nativeBodies(f).map((body) => body.bytes)).toEqual([Buffer.from('ok')]);
  expect(
    readThreadRuntimeActivity(f.db, { threadId: f.owner.threadId, turnIds: [f.owner.turnId] })[0]!
      .coverage
  ).toBe('partial');
});

// RET §§Capture Coverage, Native Transcripts And Runtime Logs: OFF, missing source, failure and truncation are facts, not bodies.
it('RET-2 retains OFF/missing/failure/truncation distinctions and refuses content without named native authority', async () => {
  const f = await nativeReceiver('off');
  const value = nativeMetadata(f, 'disabled', Buffer.alloc(0));
  const off = {
    ...value,
    fact: {
      ...value.fact,
      coverage: 'off',
      native: { ...value.fact.native, range: null, observedBytes: null },
    },
    content: { state: 'off' },
  };
  expect((await f.send(1, 'observation.recorded', off)).accepted).toBe(true);
  expect(
    (await f.send(2, 'observation.recorded', nativeMetadata(f, 'forbidden', Buffer.from('x'))))
      .accepted
  ).toBe(false);
  const reasons = ['source-missing', 'collector-failed', 'limit-exceeded'] as const;
  for (const [index, reason] of reasons.entries()) {
    const unavailable = {
      ...value,
      observationId: `unavailable-${index}`,
      sourceSequence: index + 1,
      fact: {
        ...value.fact,
        coverage: 'unavailable',
        reason,
        native: { ...value.fact.native, range: null, observedBytes: null },
      },
      content: {
        state: 'unavailable',
        reason: ['unsupported', 'capture-failed', 'truncated'][index],
      },
    };
    expect((await f.send(index + 3, 'observation.recorded', unavailable)).accepted).toBe(true);
    expect(
      f.rows().find((row) => row.payload.observationId === unavailable.observationId)!.payload
    ).toEqual(unavailable);
  }
  expect(nativeBodies(f)).toEqual([]);
  expect(
    readThreadRuntimeActivity(f.db, { threadId: f.owner.threadId, turnIds: [f.owner.turnId] })[0]!
      .contentCapture
  ).toBe('off');
  const historical = await nativeReceiver('on', null);
  expect(
    (
      await historical.send(
        1,
        'observation.recorded',
        nativeMetadata(historical, 'no-authority', Buffer.from('x'))
      )
    ).accepted
  ).toBe(false);
  expect(historical.rows()).toEqual([]);
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
