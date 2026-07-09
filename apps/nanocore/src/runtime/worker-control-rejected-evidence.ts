import { randomUUID } from 'node:crypto';
import type { CoreDb } from '../storage/db.js';
import type { WorkerControlLineage } from './worker-control-gateway.js';

/** Product-safe rejected worker-control evidence row. */
export interface WorkerControlRejectedEvidenceRecord {
  /** Stable rejected evidence id. */
  readonly rejectionId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Agent session lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** Worker control request id when supplied. */
  readonly requestId: string | null;
  /** NanoCore relay route that rejected the request. */
  readonly route: string;
  /** Worker-control operation being attempted. */
  readonly operation: string;
  /** Stable gateway error code. */
  readonly errorCode: string;
  /** HTTP status returned to the worker. */
  readonly httpStatus: number;
  /** Product-safe rejection message. */
  readonly message: string;
  /** ISO timestamp when NanoCore rejected the request. */
  readonly rejectedAt: string;
}

/** Input used to store one rejected worker-control verification evidence row. */
export interface WorkerControlRejectedEvidenceInput {
  /** Worker lineage from the rejected control request. */
  readonly lineage: WorkerControlLineage;
  /** NanoCore relay route that rejected the request. */
  readonly route: string;
  /** Worker-control operation being attempted. */
  readonly operation: string;
  /** Stable gateway error code. */
  readonly errorCode: string;
  /** HTTP status returned to the worker. */
  readonly httpStatus: number;
  /** Product-safe rejection message. */
  readonly message: string;
  /** ISO timestamp when NanoCore rejected the request. */
  readonly rejectedAt: string;
}

/** Raw rejected worker-control evidence SQLite row. */
interface WorkerControlRejectedEvidenceRow {
  readonly rejection_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly package_snapshot_id: string;
  readonly request_id: string | null;
  readonly route: string;
  readonly operation: string;
  readonly error_code: string;
  readonly http_status: number;
  readonly message: string;
  readonly rejected_at: string;
}

/**
 * Stores one product-safe rejected worker-control evidence row.
 *
 * @param coreDb Server-scope Core database.
 * @param input Rejected evidence input.
 */
export function recordWorkerControlRejectedEvidence(
  coreDb: CoreDb,
  input: WorkerControlRejectedEvidenceInput
): void {
  coreDb.sqlite
    .prepare(
      `
      INSERT INTO worker_control_rejected_evidence (
        rejection_id,
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        request_id,
        route,
        operation,
        error_code,
        http_status,
        message,
        rejected_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      randomUUID(),
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.lineage.requestId ?? null,
      input.route,
      input.operation,
      input.errorCode,
      input.httpStatus,
      input.message,
      input.rejectedAt
    );
}

/**
 * Lists rejected worker-control evidence for one workspace read model.
 *
 * @param coreDb Server-scope Core database.
 * @param workspaceId Workspace id to project.
 * @returns Matching evidence rows in deterministic rejection order.
 */
export function listWorkerControlRejectedEvidenceForWorkspace(
  coreDb: CoreDb,
  workspaceId: string
): WorkerControlRejectedEvidenceRecord[] {
  return (
    coreDb.sqlite
      .prepare(
        `
        SELECT
          rejection_id,
          workspace_id,
          thread_id,
          turn_id,
          agent_session_id,
          package_snapshot_id,
          request_id,
          route,
          operation,
          error_code,
          http_status,
          message,
          rejected_at
        FROM worker_control_rejected_evidence
        WHERE workspace_id = ?
        ORDER BY rejected_at ASC, rejection_id ASC
        `
      )
      .all(workspaceId) as WorkerControlRejectedEvidenceRow[]
  ).map(mapWorkerControlRejectedEvidenceRow);
}

/**
 * Maps one raw rejected worker-control evidence row.
 *
 * @param row Raw SQLite row.
 * @returns Product-safe evidence record.
 */
function mapWorkerControlRejectedEvidenceRow(
  row: WorkerControlRejectedEvidenceRow
): WorkerControlRejectedEvidenceRecord {
  return {
    rejectionId: row.rejection_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    agentSessionId: row.agent_session_id,
    packageSnapshotId: row.package_snapshot_id,
    requestId: row.request_id,
    route: row.route,
    operation: row.operation,
    errorCode: row.error_code,
    httpStatus: row.http_status,
    message: row.message,
    rejectedAt: row.rejected_at,
  };
}
