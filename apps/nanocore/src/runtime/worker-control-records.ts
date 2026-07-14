import {
  requireSchedulerSessionLeaseAdmissionContext,
  resolveSchedulerLeaseTokenBinding,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import type {
  WorkerControlAcceptedRecordRecorder,
  WorkerControlAcceptedRecordRecorderInput,
  WorkerControlFinalStatusTokenBindingResolution,
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
    return { replayOnly: false, status: 'accepted' };
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

  return { replayOnly: true, status: 'accepted' };
}
