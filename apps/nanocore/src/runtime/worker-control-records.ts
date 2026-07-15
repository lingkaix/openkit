import {
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordSchema,
} from '@openkit/worker-protocol';
import {
  requireSchedulerSessionLeaseAdmissionContext,
  resolveSchedulerLeaseTokenBinding,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import type {
  WorkerControlAcceptedRecordRecorder,
  WorkerControlAcceptedRecordRecorderInput,
  WorkerControlFinalStatusTokenBindingResolution,
  WorkerControlLineage,
  WorkerControlTokenBindingInput,
} from './worker-control-gateway.js';

/**
 * Creates a server-scope SQLite recorder for accepted worker-control records.
 *
 * @param coreDb Server-scope Core database.
 * @returns Durable accepted-record recorder.
 */
export function createWorkerControlAcceptedRecordRecorder(
  coreDb: CoreDb
): WorkerControlAcceptedRecordRecorder {
  return {
    record(input) {
      recordWorkerControlAcceptedRecord(coreDb, input);
    },
  };
}

/**
 * Stores one product-safe accepted worker-control record.
 *
 * @param coreDb Server-scope Core database.
 * @param input Accepted worker-control record.
 */
export function recordWorkerControlAcceptedRecord(
  coreDb: CoreDb,
  input: WorkerControlAcceptedRecordRecorderInput
): void {
  coreDb.sqlite
    .prepare(
      `
      INSERT OR IGNORE INTO worker_control_records (
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        request_id,
        operation,
        record_key,
        sequence,
        record_json,
        accepted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.lineage.requestId ?? null,
      input.operation,
      input.recordKey,
      input.sequence ?? null,
      JSON.stringify(input.record),
      input.acceptedAt
    );
}

/**
 * Reads canonical events durably accepted for one complete worker package lineage.
 *
 * @param coreDb Server-scope Core database.
 * @param lineage Exact package lineage selector.
 * @returns Canonical accepted events ordered by worker sequence.
 * @throws Error when durable event JSON is invalid or contradicts the selected lineage.
 */
export function listWorkerControlAcceptedEvents(
  coreDb: CoreDb,
  lineage: WorkerControlLineage
): WorkerCanonicalEventRecord[] {
  const rows = coreDb.sqlite
    .prepare(
      `
      SELECT record_json AS recordJson
      FROM worker_control_records
      WHERE workspace_id = ?
        AND thread_id = ?
        AND turn_id = ?
        AND agent_session_id = ?
        AND package_snapshot_id = ?
        AND request_id IS ?
        AND operation = 'event_append'
      ORDER BY sequence ASC
      `
    )
    .all(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      lineage.requestId ?? null
    ) as Array<{ readonly recordJson: string }>;

  return rows.map((row) => {
    const record = WorkerCanonicalEventRecordSchema.parse(JSON.parse(row.recordJson));

    if (!sameWorkerControlLineage(record.lineage, lineage)) {
      throw new Error('Durable worker event record contradicts its indexed package lineage.');
    }

    return record;
  });
}

/**
 * Checks complete worker package lineage equality, including nullable request identity.
 *
 * @param left First worker lineage.
 * @param right Second worker lineage.
 * @returns True only when all package scope fields are equal.
 */
function sameWorkerControlLineage(
  left: WorkerControlLineage,
  right: WorkerControlLineage
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.agentSessionId === right.agentSessionId &&
    left.packageSnapshotId === right.packageSnapshotId &&
    (left.requestId ?? null) === (right.requestId ?? null)
  );
}

/**
 * Resolves live final-status acceptance or exact replay during release grace.
 *
 * @param coreDb Server-scope Core database.
 * @param input Sandbox binding and worker lineage.
 * @returns Live acceptance, replay-only acceptance, or a stable rejection.
 */
export function resolveWorkerControlFinalStatusTokenBinding(
  coreDb: CoreDb,
  input: WorkerControlTokenBindingInput
): WorkerControlFinalStatusTokenBindingResolution {
  const live = resolveSchedulerLeaseTokenBinding(coreDb, input);

  if (live.status === 'accepted') {
    const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, live.lease.leaseId);

    if ((admission.requestId ?? null) !== (input.lineage.requestId ?? null)) {
      return { reason: 'lineage-mismatch', status: 'rejected' };
    }

    return { ownerUserId: admission.userId, replayOnly: false, status: 'accepted' };
  }

  if (live.reason !== 'lease-not-live') {
    return live;
  }

  const row = coreDb.sqlite
    .prepare(
      `SELECT lease_id AS leaseId, expires_at AS expiresAt
         FROM scheduler_session_leases
        WHERE sandbox_binding_ref = ?
          AND workspace_id = ?
          AND thread_id = ?
          AND turn_id = ?
          AND agent_session_id = ?
          AND package_snapshot_id = ?
          AND status = 'releasing'
          AND EXISTS (
            SELECT 1
              FROM worker_control_records
             WHERE worker_control_records.workspace_id = scheduler_session_leases.workspace_id
               AND worker_control_records.thread_id = scheduler_session_leases.thread_id
               AND worker_control_records.turn_id = scheduler_session_leases.turn_id
               AND worker_control_records.agent_session_id = scheduler_session_leases.agent_session_id
               AND worker_control_records.package_snapshot_id = scheduler_session_leases.package_snapshot_id
               AND worker_control_records.operation = 'final_status'
          )`
    )
    .get(
      input.sandboxBindingRef,
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId
    ) as { expiresAt: string; leaseId: string } | undefined;

  if (!row || row.expiresAt <= new Date().toISOString()) {
    return live;
  }

  const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, row.leaseId);

  if ((admission.requestId ?? null) !== (input.lineage.requestId ?? null)) {
    return { reason: 'lineage-mismatch', status: 'rejected' };
  }

  return { ownerUserId: admission.userId, replayOnly: true, status: 'accepted' };
}
