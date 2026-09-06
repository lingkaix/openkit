import { setTimeout as delay } from 'node:timers/promises';
import { type StopReason, StopReasonSchema, type TurnStatus } from '@openkit/protocol';
import {
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordSchema,
  WorkerCanonicalTerminalStatusSchema,
} from '@openkit/worker-protocol';
import {
  requireSchedulerSessionLeaseAdmissionContext,
  resolveSchedulerLeaseTokenBinding,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import type {
  WorkerControlAcceptedRecordRecorder,
  WorkerControlAcceptedRecordRecorderInput,
  WorkerControlFinalStatus,
  WorkerControlFinalStatusTokenBindingResolution,
  WorkerControlLineage,
  WorkerControlTokenBindingInput,
} from './worker-control-gateway.js';

/** Default interval for observing one scheduler-owned durable final status. */
const WORKER_FINAL_STATUS_POLL_INTERVAL_MS = 100;

/** Inputs for waiting until one exact scheduler-owned worker has durably completed. */
export interface WaitForWorkerControlFinalStatusInput {
  /** Scheduler lease that owns the worker. */
  readonly leaseId: string;
  /** Complete worker-control lineage that the final status must match. */
  readonly lineage: WorkerControlLineage;
}

/** Durable final-status fields required by online and restart closeout. */
export type AcceptedWorkerFinalStatus = Pick<
  WorkerControlFinalStatus,
  'acceptedAt' | 'status' | 'stopReason'
>;

/**
 * Validates one accepted worker status against the closed Core stop-reason mapping.
 *
 * @param accepted Durable worker-control terminal facts.
 * @returns Canonical Core stop reason.
 * @throws Error when the raw stop reason is unknown or incompatible with the worker status.
 */
export function canonicalStopReasonForAcceptedWorkerFinalStatus(
  accepted: AcceptedWorkerFinalStatus
): StopReason {
  const parsed = StopReasonSchema.safeParse(accepted.stopReason);
  if (!parsed.success) {
    throw new Error('Accepted worker final status has no canonical Core StopReason.');
  }

  const stopReason = parsed.data;
  const compatible =
    (accepted.status === 'completed' && stopReason === 'completed') ||
    (accepted.status === 'blocked' &&
      (stopReason === 'length' ||
        stopReason === 'budget_exhausted' ||
        stopReason === 'ask_user')) ||
    ((accepted.status === 'cancelled' || accepted.status === 'interrupted') &&
      stopReason === 'aborted') ||
    ((accepted.status === 'failed' ||
      accepted.status === 'degraded' ||
      accepted.status === 'lost') &&
      stopReason === 'error');

  if (!compatible) {
    throw new Error('Accepted worker final status has no canonical Core StopReason.');
  }
  return stopReason;
}

/**
 * Maps one canonical worker stop reason to its product Turn status.
 *
 * @param stopReason Canonical Core stop reason.
 * @returns Product Turn status required by that reason.
 */
export function turnStatusForCanonicalWorkerStopReason(stopReason: 'aborted'): 'interrupted';
export function turnStatusForCanonicalWorkerStopReason(
  stopReason: Exclude<StopReason, 'ask_user'>
): Extract<TurnStatus, 'interrupted' | 'completed' | 'failed'>;
export function turnStatusForCanonicalWorkerStopReason(
  stopReason: StopReason
): Extract<TurnStatus, 'awaiting_human' | 'interrupted' | 'completed' | 'failed'>;
export function turnStatusForCanonicalWorkerStopReason(
  stopReason: StopReason
): Extract<TurnStatus, 'awaiting_human' | 'interrupted' | 'completed' | 'failed'> {
  if (stopReason === 'completed' || stopReason === 'length' || stopReason === 'budget_exhausted') {
    return 'completed';
  }
  if (stopReason === 'ask_user') {
    return 'awaiting_human';
  }
  return stopReason === 'aborted' ? 'interrupted' : 'failed';
}

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

/** Reads the accepted final status for one exact worker lineage. */
export function getWorkerControlAcceptedFinalStatus(
  coreDb: CoreDb,
  lineage: WorkerControlLineage
): AcceptedWorkerFinalStatus | null {
  const row = coreDb.sqlite
    .prepare(
      `SELECT record_json AS recordJson, accepted_at AS acceptedAt
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
    ) as { readonly acceptedAt: string; readonly recordJson: string } | undefined;
  if (!row) {
    return null;
  }
  const record = JSON.parse(row.recordJson) as {
    readonly status?: unknown;
    readonly stopReason?: unknown;
  };
  const status = WorkerCanonicalTerminalStatusSchema.parse(record.status);
  if (typeof record.stopReason !== 'string') {
    throw new Error('Durable worker final status has no stop reason.');
  }
  return { acceptedAt: row.acceptedAt, status, stopReason: record.stopReason };
}

/**
 * Waits until one exact worker final status is durable or its lease can no longer complete.
 *
 * A final status accepted before lease expiry remains authoritative after expiry. Without that
 * record, only pre-terminal live lease states may continue waiting.
 *
 * @param coreDb Server-scope Core database.
 * @param input Exact lease, worker lineage, clock, and optional poll interval.
 * @throws Error when lineage is absent, the lease expires, or its state becomes non-waitable.
 */
export async function waitForWorkerControlFinalStatus(
  coreDb: CoreDb,
  input: WaitForWorkerControlFinalStatusInput
): Promise<AcceptedWorkerFinalStatus> {
  for (;;) {
    const lease = coreDb.sqlite
      .prepare(
        `SELECT status, expires_at AS expiresAt
         FROM scheduler_session_leases
         WHERE lease_id = ?
           AND workspace_id = ?
           AND thread_id = ?
           AND turn_id = ?
           AND agent_session_id = ?
           AND package_snapshot_id = ?`
      )
      .get(
        input.leaseId,
        input.lineage.workspaceId,
        input.lineage.threadId,
        input.lineage.turnId,
        input.lineage.agentSessionId,
        input.lineage.packageSnapshotId
      ) as { readonly expiresAt: string; readonly status: string } | undefined;

    if (!lease) {
      throw new Error('Worker completion lease does not match the exact durable lineage.');
    }
    const accepted = getWorkerControlAcceptedFinalStatus(coreDb, input.lineage);
    if (accepted) {
      return accepted;
    }
    if (!['acquired', 'starting', 'active', 'idle'].includes(lease.status)) {
      throw new Error(`Worker lease became ${lease.status} before durable final status.`);
    }
    if (lease.expiresAt <= new Date().toISOString()) {
      throw new Error('Worker lease expired before durable final status.');
    }

    await delay(WORKER_FINAL_STATUS_POLL_INTERVAL_MS);
  }
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
               AND worker_control_records.request_id IS ?
               AND worker_control_records.operation = 'final_status'
          )`
    )
    .get(
      input.sandboxBindingRef,
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.lineage.requestId ?? null
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
