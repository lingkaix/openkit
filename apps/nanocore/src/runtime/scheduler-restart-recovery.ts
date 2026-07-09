import { randomUUID } from 'node:crypto';
import type { CoreDb } from '../storage/db.js';

/** Input for scheduler restart recovery. */
export interface RunSchedulerRestartRecoveryInput {
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Result of scheduler restart recovery. */
export interface SchedulerRestartRecoveryResult {
  /** Live leases adopted by the new scheduler epoch. */
  readonly adoptedLeaseIds: string[];
  /** Pre-launch leases failed and requeued. */
  readonly preLaunchFailedLeaseIds: string[];
  /** Scheduler epoch minted for this process. */
  readonly schedulerEpoch: number;
  /** Live leases marked stale during recovery. */
  readonly staleLeaseIds: string[];
}

interface LeaseRecoveryRow {
  readonly heartbeat_deadline: string;
  readonly last_accepted_heartbeat_at: string | null;
  readonly lease_id: string;
  readonly plan_id: string;
  readonly pool_id: string;
  readonly agent_session_id: string;
  readonly status: string;
  readonly package_snapshot_id: string;
  readonly target_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly workspace_id: string;
}

/**
 * Recovers durable scheduler lease state after NanoCore restart.
 *
 * @param coreDb Open Core database handle.
 * @param input Optional deterministic clock.
 * @returns New epoch and lease ids changed during recovery.
 */
export function runSchedulerRestartRecovery(
  coreDb: CoreDb,
  input: RunSchedulerRestartRecoveryInput = {}
): SchedulerRestartRecoveryResult {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const schedulerEpoch = nextSchedulerEpoch(coreDb);
  const rows = coreDb.sqlite
    .prepare(
      `SELECT
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
        heartbeat_deadline,
        last_accepted_heartbeat_at
      FROM scheduler_session_leases
      WHERE status IN ('planned', 'acquired', 'starting', 'active', 'idle')
      ORDER BY lease_id ASC`
    )
    .all() as LeaseRecoveryRow[];
  const adoptedLeaseIds: string[] = [];
  const preLaunchFailedLeaseIds: string[] = [];
  const staleLeaseIds: string[] = [];

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (isPreLaunchLease(row)) {
        failPreLaunchLease(coreDb, row, schedulerEpoch);
        preLaunchFailedLeaseIds.push(row.lease_id);
        continue;
      }

      if (row.heartbeat_deadline <= timestamp) {
        markLeaseStale(coreDb, row, schedulerEpoch);
        staleLeaseIds.push(row.lease_id);
        continue;
      }

      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET scheduler_epoch = ? WHERE lease_id = ?')
        .run(schedulerEpoch, row.lease_id);
      adoptedLeaseIds.push(row.lease_id);
    }

    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return { adoptedLeaseIds, preLaunchFailedLeaseIds, schedulerEpoch, staleLeaseIds };
}

/**
 * Computes the next scheduler epoch from durable scheduler records.
 *
 * @param coreDb Open Core database handle.
 * @returns One greater than the maximum stored scheduler epoch.
 */
export function nextSchedulerEpoch(coreDb: CoreDb): number {
  const row = coreDb.sqlite
    .prepare(
      `SELECT MAX(epoch) AS maxEpoch
      FROM (
        SELECT scheduler_epoch AS epoch FROM scheduler_placement_plans
        UNION ALL
        SELECT scheduler_epoch AS epoch FROM scheduler_session_leases
      )`
    )
    .get() as { maxEpoch: number | null };

  return (row.maxEpoch ?? 0) + 1;
}

/**
 * Returns whether a lease never produced launch evidence before restart.
 *
 * @param row Lease row.
 * @returns True when the lease should be failed and requeued.
 */
function isPreLaunchLease(row: LeaseRecoveryRow): boolean {
  return (
    (row.status === 'planned' || row.status === 'acquired') &&
    row.last_accepted_heartbeat_at === null
  );
}

/**
 * Fails a pre-launch lease, abandons its plan, requeues admission, and releases capacity.
 *
 * @param coreDb Open Core database handle.
 * @param row Lease row.
 * @param schedulerEpoch New scheduler epoch.
 */
function failPreLaunchLease(coreDb: CoreDb, row: LeaseRecoveryRow, schedulerEpoch: number): void {
  const plan = coreDb.sqlite
    .prepare(
      'SELECT queue_entry_id AS queueEntryId FROM scheduler_placement_plans WHERE plan_id = ?'
    )
    .get(row.plan_id) as { queueEntryId: string } | undefined;

  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
      SET status = 'failed',
          release_reason = 'scheduler-restart-pre-launch',
          recovery_state = 'needs-evidence',
          scheduler_epoch = ?
      WHERE lease_id = ?`
    )
    .run(schedulerEpoch, row.lease_id);
  coreDb.sqlite
    .prepare("UPDATE scheduler_placement_plans SET status = 'abandoned' WHERE plan_id = ?")
    .run(row.plan_id);

  if (plan) {
    coreDb.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'queued', denial_reason = NULL WHERE queue_entry_id = ?"
      )
      .run(plan.queueEntryId);
  }

  releaseClaimedCapacity(coreDb, row);
}

/**
 * Marks a live lease stale in the new scheduler epoch.
 *
 * @param coreDb Open Core database handle.
 * @param row Lease row.
 * @param schedulerEpoch New scheduler epoch.
 */
function markLeaseStale(coreDb: CoreDb, row: LeaseRecoveryRow, schedulerEpoch: number): void {
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
      SET status = 'stale',
          release_reason = 'heartbeat-timeout',
          recovery_state = 'needs-evidence',
          scheduler_epoch = ?
      WHERE lease_id = ?`
    )
    .run(schedulerEpoch, row.lease_id);
  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO scheduler_orphan_worker_evidence (
        evidence_id,
        lease_id,
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        pool_id,
        target_id,
        reason,
        scheduler_epoch,
        heartbeat_deadline,
        last_accepted_heartbeat_at,
        recorded_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      row.lease_id,
      row.workspace_id,
      row.thread_id,
      row.turn_id,
      row.agent_session_id,
      row.package_snapshot_id,
      row.pool_id,
      row.target_id,
      'restart-heartbeat-timeout',
      schedulerEpoch,
      row.heartbeat_deadline,
      row.last_accepted_heartbeat_at,
      new Date().toISOString()
    );
}

/**
 * Releases capacity claimed by a failed pre-launch lease.
 *
 * @param coreDb Open Core database handle.
 * @param row Lease row.
 */
function releaseClaimedCapacity(coreDb: CoreDb, row: LeaseRecoveryRow): void {
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_capacity_records
      SET in_use_count = CASE
            WHEN in_use_count > 0 THEN in_use_count - 1
            ELSE 0
          END,
          version = version + 1
      WHERE target_id = ? AND pool_id = ?`
    )
    .run(row.target_id, row.pool_id);
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_worker_pools
      SET current_admitted_session_count = CASE
            WHEN current_admitted_session_count > 0 THEN current_admitted_session_count - 1
            ELSE 0
          END,
          current_queue_depth = current_queue_depth + 1
      WHERE pool_id = ?`
    )
    .run(row.pool_id);
}
