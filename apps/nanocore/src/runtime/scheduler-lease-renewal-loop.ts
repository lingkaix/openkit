import {
  renewSchedulerSessionLease,
  type SchedulerSessionLeaseRecord,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';

/** Input for one scheduler lease-renewal loop iteration. */
export interface RunSchedulerLeaseRenewalLoopInput {
  /** Returns true when the lease package snapshot may be renewed without a supply refresh. */
  readonly canRenewPackageSnapshot?: (lease: SchedulerLeaseRenewalCandidate) => boolean;
  /** Maximum total lifetime from original acquisition without explicit policy override. */
  readonly maxTotalLeaseMs: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Duration added from the current loop time for each renewed lease. */
  readonly renewalDurationMs: number;
  /** Renew leases whose expiry is within this lead window. */
  readonly renewalLeadMs: number;
}

/** Result of one scheduler lease-renewal loop iteration. */
export interface SchedulerLeaseRenewalLoopResult {
  /** Leases skipped because their package snapshot needs an unsupported refresh. */
  readonly packageRefreshBlocked: SchedulerLeaseRenewalCandidate[];
  /** Leases renewed by this iteration. */
  readonly renewed: SchedulerSessionLeaseRecord[];
}

/** Lease candidate considered for renewal. */
export interface SchedulerLeaseRenewalCandidate {
  /** Original lease acquisition timestamp. */
  readonly acquiredAt: string;
  /** Agent session lineage id. */
  readonly agentSessionId: string;
  /** Current lease expiry timestamp. */
  readonly expiresAt: string;
  /** Stable lease id. */
  readonly leaseId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
}

interface RenewableLeaseRow {
  readonly acquired_at: string;
  readonly agent_session_id: string;
  readonly expires_at: string;
  readonly lease_id: string;
  readonly package_snapshot_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly workspace_id: string;
}

/**
 * Runs one durable scheduler lease-renewal iteration.
 *
 * @param coreDb Open Core database handle.
 * @param input Renewal policy and clock input.
 * @returns Leases renewed by this iteration.
 */
export function runSchedulerLeaseRenewalLoop(
  coreDb: CoreDb,
  input: RunSchedulerLeaseRenewalLoopInput
): SchedulerLeaseRenewalLoopResult {
  if (input.maxTotalLeaseMs <= 0 || input.renewalDurationMs <= 0 || input.renewalLeadMs < 0) {
    throw new Error('Scheduler lease renewal loop requires positive timing windows.');
  }

  const timestamp = input.now?.() ?? new Date().toISOString();
  const renewalCutoff = addMilliseconds(timestamp, input.renewalLeadMs);
  const rows = coreDb.sqlite
    .prepare(
      `SELECT
        leases.lease_id,
        leases.workspace_id,
        leases.thread_id,
        leases.turn_id,
        leases.agent_session_id,
        leases.package_snapshot_id,
        leases.acquired_at,
        leases.expires_at
      FROM scheduler_session_leases AS leases
      JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
      JOIN scheduler_target_health_records AS health ON health.target_id = leases.target_id
      WHERE leases.status IN ('acquired', 'starting', 'active', 'idle')
        AND leases.expires_at > ?
        AND leases.heartbeat_deadline > ?
        AND leases.expires_at <= ?
        AND pools.status = 'active'
        AND health.health_state IN ('healthy', 'degraded', 'probation')
      ORDER BY leases.expires_at ASC, leases.lease_id ASC`
    )
    .all(timestamp, timestamp, renewalCutoff) as RenewableLeaseRow[];
  const packageRefreshBlocked: SchedulerLeaseRenewalCandidate[] = [];
  const renewed: SchedulerSessionLeaseRecord[] = [];

  for (const row of rows) {
    const candidate = mapRenewableLeaseRow(row);
    if (input.canRenewPackageSnapshot && !input.canRenewPackageSnapshot(candidate)) {
      packageRefreshBlocked.push(candidate);
      continue;
    }

    const requestedExpiresAt = addMilliseconds(timestamp, input.renewalDurationMs);
    const maxExpiresAt = addMilliseconds(candidate.acquiredAt, input.maxTotalLeaseMs);
    const expiresAt = minIsoTimestamp(requestedExpiresAt, maxExpiresAt);

    if (expiresAt <= candidate.expiresAt) {
      continue;
    }

    renewed.push(
      renewSchedulerSessionLease(coreDb, {
        expiresAt,
        leaseId: candidate.leaseId,
        now: () => timestamp,
      })
    );
  }

  return { packageRefreshBlocked, renewed };
}

/**
 * Maps a renewal query row into the public candidate shape.
 *
 * @param row Raw SQLite row.
 * @returns Renewal candidate.
 */
function mapRenewableLeaseRow(row: RenewableLeaseRow): SchedulerLeaseRenewalCandidate {
  return {
    acquiredAt: row.acquired_at,
    agentSessionId: row.agent_session_id,
    expiresAt: row.expires_at,
    leaseId: row.lease_id,
    packageSnapshotId: row.package_snapshot_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    workspaceId: row.workspace_id,
  };
}

/**
 * Adds milliseconds to an ISO timestamp.
 *
 * @param timestamp ISO timestamp.
 * @param milliseconds Milliseconds to add.
 * @returns ISO timestamp after the duration.
 */
function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

/**
 * Returns the earlier ISO timestamp.
 *
 * @param left First ISO timestamp.
 * @param right Second ISO timestamp.
 * @returns Earlier timestamp.
 */
function minIsoTimestamp(left: string, right: string): string {
  return left <= right ? left : right;
}
