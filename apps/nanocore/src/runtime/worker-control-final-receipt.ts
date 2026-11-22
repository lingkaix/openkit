import { readRetainedV1 } from '@openkit/protocol';
import { WorkerCanonicalTerminalEventDataSchema } from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
import type { NanoHostExecutionAttemptRecord } from './nanohost-attempt-records.js';
import type { WorkerControlFinalStatus, WorkerControlLineage } from './worker-control-gateway.js';

type WorkerControlReceiptDb = { readonly sqlite: Database.Database };

/** Durable final-status fields required by online and restart closeout. */
export type AcceptedWorkerFinalStatus = Pick<
  WorkerControlFinalStatus,
  'acceptedAt' | 'diagnostics' | 'status' | 'stopReason'
>;

/** Reads the accepted final status for one exact worker lineage. */
export function getWorkerControlAcceptedFinalStatus(
  owner: WorkerControlReceiptDb,
  lineage: WorkerControlLineage
): AcceptedWorkerFinalStatus | null {
  const row = owner.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, record_json AS recordJson, accepted_at AS acceptedAt
       FROM worker_control_records
       WHERE workspace_id = ?
         AND thread_id = ?
         AND turn_id = ?
         AND agent_session_id = ?
         AND package_snapshot_id = ?
         AND request_id IS ?
         AND operation = 'final_status'
       LIMIT 1`
    )
    .get(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      lineage.requestId ?? null
    ) as
    | { readonly schemaVersion: unknown; readonly acceptedAt: string; readonly recordJson: string }
    | undefined;
  if (!row) {
    return null;
  }
  const raw = readRetainedV1(row, () => JSON.parse(row.recordJson)) as Record<string, unknown>;
  // Reuse terminal admission's schema while leaving unrelated durable record fields alone.
  const record = WorkerCanonicalTerminalEventDataSchema.parse({
    ...(raw.diagnostics !== undefined ? { diagnostics: raw.diagnostics } : {}),
    status: raw.status,
    stopReason: raw.stopReason,
  });
  return {
    acceptedAt: row.acceptedAt,
    ...(record.diagnostics ? { diagnostics: record.diagnostics } : {}),
    status: record.status,
    stopReason: record.stopReason,
  };
}

/**
 * Checks current cancellation and native authority for a first final without restoring effect authority.
 *
 * @param attempt Exact native attempt whose token and lineage are checked by the caller.
 * @param timestamp Current time for the unchanged submission and native liveness deadlines.
 * @returns Whether the cancellation-owned first-final opportunity remains available.
 */
export function hasPendingWorkerCancellationFinal(
  attempt: NanoHostExecutionAttemptRecord,
  timestamp: string
): boolean {
  const workerDeadline = attempt.lastAcceptedHeartbeatAt
    ? attempt.heartbeatDeadline
    : attempt.startupDeadline;
  const now = Date.parse(timestamp);
  return (
    attempt.phase === 'closing' &&
    ['turn-cancelled', 'raw-output-exhausted', 'raw-output-unavailable'].includes(
      attempt.terminalCause ?? ''
    ) &&
    attempt.recoveryState === null &&
    attempt.fenceRef === null &&
    Boolean(attempt.workerControlTokenHash) &&
    Date.parse(attempt.deadline ?? '') > now &&
    Date.parse(workerDeadline) > now
  );
}
