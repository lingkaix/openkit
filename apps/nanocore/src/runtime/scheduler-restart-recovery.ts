import { isDeepStrictEqual } from 'node:util';

import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { recordServerAuditEvent } from '../audit-events.js';
import {
  completeSchedulerSessionLease,
  requireSchedulerSessionLeaseAdmissionContext,
} from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { projectWorkerBackendCleanup } from './worker-backend-cleanup-projection.js';
import {
  getWorkerBackendSession,
  listWorkerBackendSessions,
  markWorkerBackendWorkspaceHandoffComplete,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
  workerBackendImageIdentity,
} from './worker-backend-sessions.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';
import type { WorkerGovernanceBackendSessionIdentity } from './worker-governance-backend.js';

const WORKER_RECONNECT_WINDOW_MS = 300_000;

/** Exact reconnect lineage required to adopt one already-running worker. */
export interface SchedulerRestartLineage {
  readonly agentSessionId: string;
  readonly backendSessionId: string;
  readonly buildLineage: {
    readonly argumentsDigest: string;
    readonly contextDigest: string;
    readonly inputDigest: string;
    readonly resultingImageDigest: string;
  };
  readonly leaseId: string;
  readonly nextSequence: number;
  readonly packageSnapshotId: string;
  readonly processKeyHash: string;
}

/**
 * Validates all reconnect authority before an existing process can be adopted.
 *
 * @param expected Durable reconnect lineage.
 * @param observed Lineage presented by the reconnecting worker.
 * @returns Closed acceptance result.
 */
export function validateSchedulerRestartLineage(
  expected: SchedulerRestartLineage,
  observed: SchedulerRestartLineage
): { readonly accepted: boolean } {
  return { accepted: isDeepStrictEqual(expected, observed) };
}

/** Product turn state established by restart recovery projection. */
export type RecoveredTurnStatus = 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'missing';

/** Durable lease context presented to product recovery for pre-anchor turns. */
export interface PreAnchorRecoveryContext {
  /** Scheduler lease id. */
  readonly leaseId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Package snapshot lineage id. */
  readonly packageSnapshotId: string;
}

/** Input for scheduler restart recovery. */
export interface RunSchedulerRestartRecoveryInput {
  /** Physically destroys one exact durable backend identity. */
  readonly cleanupBackendSession?: (
    session: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Registers exact cleanup result identities without awaiting or dispatching effects. */
  readonly prepareBackendCleanup?: (session: WorkerGovernanceBackendSessionIdentity) => void;
  /** Projects one recovered product turn and returns its authoritative terminal state. */
  readonly projectRecoveredTurn: (
    subject: WorkerBackendSessionRecord | PreAnchorRecoveryContext
  ) => Promise<{ readonly status: RecoveredTurnStatus }>;
  /** Restores read-only access to one exact backend session before reconnect is armed. */
  readonly restoreBackendSession?: (session: WorkerBackendSessionRecord) => Promise<void>;
}

/** Result of scheduler restart recovery. */
export interface SchedulerRestartRecoveryResult {
  /** Pre-anchor leases failed after product projection. */
  readonly preLaunchFailedLeaseIds: string[];
  /** Scheduler epoch minted for this process. */
  readonly schedulerEpoch: number;
}

/** Raw non-terminal lease fields required by restart recovery. */
interface LeaseRecoveryRow extends PreAnchorRecoveryContext {
  readonly backendAnchorState: 'unanchored' | 'anchored';
  readonly expiresAt: string;
  readonly lastAcceptedHeartbeatAt: string | null;
  readonly lastWorkerSequence: number | null;
  readonly status: string;
  readonly releaseReason: string | null;
  readonly recoveryDeadline: string | null;
  readonly recoveryState: string | null;
  readonly schedulerEpoch: number;
  readonly workerProcessKeyHash: string | null;
}

/** Loaded workspace authority used during backend cleanup. */
interface RecoveryWorkspace {
  readonly db: WorkspaceDb;
  readonly environmentPackage: AgentEnvironmentPackage;
}

/** One failure retained while every independent recovery row is attempted. */
interface RecoveryFailure {
  readonly error: unknown;
  readonly leaseId: string;
}

/**
 * Arms eligible live leases and transfers every other durable owner without external effects.
 *
 * @param coreDb Open Core database handle.
 * @param input Read-only restoration, product projection, and deterministic clock dependencies.
 * @returns New scheduler epoch and pre-anchor leases terminalized during classification.
 * @throws AggregateError after attempting every independent recovery row when any invariant fails.
 */
export async function runSchedulerRestartRecovery(
  coreDb: CoreDb,
  input: RunSchedulerRestartRecoveryInput
): Promise<SchedulerRestartRecoveryResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const schedulerEpoch = nextSchedulerEpoch(coreDb);
  const rows = listNonTerminalLeaseRows(coreDb);
  const failures: RecoveryFailure[] = [];
  const preLaunchFailedLeaseIds: string[] = [];

  for (const orphan of listOrphanBackendSessions(coreDb)) {
    try {
      if (orphan.state !== 'physical-cleaned') {
        moveSessionToCleanupPending(coreDb, orphan, now());
      }
    } catch (error) {
      failures.push({ error, leaseId: orphan.leaseId });
    }
  }

  for (const row of rows) {
    try {
      const session = getWorkerBackendSession(coreDb, row.leaseId);
      if (!session) {
        if (!isProvenPreAnchorLease(row)) {
          throw new Error(`Scheduler lease ${row.leaseId} has no durable backend session anchor.`);
        }
        await recoverPreAnchorLease(coreDb, row, schedulerEpoch, input);
        preLaunchFailedLeaseIds.push(row.leaseId);
        continue;
      }

      await classifyAnchoredLease(coreDb, row, session, schedulerEpoch, now, input);
    } catch (error) {
      failures.push({ error, leaseId: row.leaseId });
    }
  }

  throwRecoveryFailures(failures);

  return {
    preLaunchFailedLeaseIds,
    schedulerEpoch,
  };
}

/**
 * Drains effect-owning restart work after the ordinary listener is available.
 *
 * @param coreDb Open Core database handle.
 * @param schedulerEpoch Current process scheduler epoch minted by the pre-listen scan.
 * @param input Existing cleanup, projection, and final-status closeout dependencies.
 */
export async function runSchedulerRecoveryMaintenance(
  coreDb: CoreDb,
  schedulerEpoch: number,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  const now = input.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const failures: RecoveryFailure[] = [];
  const expiredRows = listNonTerminalLeaseRows(coreDb).filter(
    (row) =>
      row.recoveryState === 'awaiting-reconnect' &&
      row.recoveryDeadline !== null &&
      row.recoveryDeadline <= timestamp
  );

  for (const row of expiredRows) {
    try {
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases
           SET recovery_state = 'needs-evidence', recovery_deadline = NULL
           WHERE lease_id = ?
             AND scheduler_epoch = ?
             AND recovery_state = 'awaiting-reconnect'
             AND recovery_deadline = ?
             AND recovery_deadline <= ?`
        )
        .run(row.leaseId, row.schedulerEpoch, row.recoveryDeadline, timestamp);
    } catch (error) {
      failures.push({ error, leaseId: row.leaseId });
    }
  }

  for (const row of listNonTerminalLeaseRows(coreDb)) {
    try {
      const session = getWorkerBackendSession(coreDb, row.leaseId);
      if (!session) {
        continue;
      }
      const acceptedFinalStatus = hasAcceptedFinalStatus(coreDb, row, session);
      const cleanupOwned = ['cleanup-pending', 'cleanup-failed'].includes(session.state);
      if (
        acceptedFinalStatus &&
        !cleanupOwned &&
        !['physical-cleaned', 'cleaned'].includes(session.state)
      ) {
        continue;
      }
      if (!acceptedFinalStatus && !cleanupOwned && row.recoveryState !== 'needs-evidence') {
        continue;
      }
      await recoverAnchoredLease(coreDb, row, session, schedulerEpoch, now, input);
    } catch (error) {
      failures.push({ error, leaseId: row.leaseId });
    }
  }

  for (const orphan of listOrphanBackendSessions(coreDb)) {
    try {
      await cleanupOrphanBackendSession(coreDb, orphan, now, input.cleanupBackendSession);
    } catch (error) {
      failures.push({ error, leaseId: orphan.leaseId });
    }
  }

  for (const group of listOrphanCapacityGroups(coreDb, failures)) {
    try {
      retireCleanedOrphanGroup(coreDb, group, now);
    } catch (error) {
      failures.push({ error, leaseId: group.sessions[0]!.leaseId });
    }
  }

  throwRecoveryFailures(failures);
}

/** Throws one aggregate after every independent recovery candidate was attempted. */
function throwRecoveryFailures(failures: readonly RecoveryFailure[]): void {
  if (failures.length === 0) {
    return;
  }
  throw new AggregateError(
    failures.map(({ error, leaseId }) =>
      error instanceof Error
        ? new Error(`Scheduler restart recovery failed for ${leaseId}: ${error.message}`, {
            cause: error,
          })
        : new Error(`Scheduler restart recovery failed for ${leaseId}: ${String(error)}`)
    ),
    failures.map(({ error }) => (error instanceof Error ? error.message : String(error))).join('; ')
  );
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

/** Lists every scheduler lease that still owns capacity. */
function listNonTerminalLeaseRows(coreDb: CoreDb): LeaseRecoveryRow[] {
  return coreDb.sqlite
    .prepare(
      `SELECT lease_id AS leaseId,
              workspace_id AS workspaceId,
              thread_id AS threadId,
              turn_id AS turnId,
              agent_session_id AS agentSessionId,
              package_snapshot_id AS packageSnapshotId,
              backend_anchor_state AS backendAnchorState,
              status,
              release_reason AS releaseReason,
              recovery_state AS recoveryState,
              recovery_deadline AS recoveryDeadline,
              scheduler_epoch AS schedulerEpoch,
              expires_at AS expiresAt,
              last_accepted_heartbeat_at AS lastAcceptedHeartbeatAt,
              last_worker_sequence AS lastWorkerSequence,
              worker_process_key_hash AS workerProcessKeyHash
       FROM scheduler_session_leases
       WHERE status IN ('planned', 'acquired', 'starting', 'active', 'idle', 'stale', 'releasing')
       ORDER BY lease_id ASC`
    )
    .all() as LeaseRecoveryRow[];
}

/** Lists backend anchors whose scheduler lease cannot be recovered. */
function listOrphanBackendSessions(coreDb: CoreDb): WorkerBackendSessionRecord[] {
  const nonTerminalLeaseIds = new Set(listNonTerminalLeaseRows(coreDb).map((row) => row.leaseId));
  return listWorkerBackendSessions(coreDb).filter((session) => {
    if (nonTerminalLeaseIds.has(session.leaseId)) {
      return false;
    }
    return session.state !== 'cleaned';
  });
}

/** Physically cleans one orphan only after proving its unowned lease-plan-capacity lineage. */
async function cleanupOrphanBackendSession(
  coreDb: CoreDb,
  originalSession: WorkerBackendSessionRecord,
  now: () => string,
  cleanupBackendSession: RunSchedulerRestartRecoveryInput['cleanupBackendSession']
): Promise<void> {
  const owner = coreDb.sqlite
    .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
    .get(originalSession.leaseId) as { status: string } | undefined;
  if (
    owner &&
    ['planned', 'acquired', 'starting', 'active', 'idle', 'stale', 'releasing'].includes(
      owner.status
    )
  ) {
    throw new Error(
      `Worker backend session ${originalSession.leaseId} acquired a live scheduler lease owner.`
    );
  }
  requireOrphanCapacityPlacement(coreDb, originalSession);
  await cleanupPhysicalSession(coreDb, originalSession, now, cleanupBackendSession);
}

/** One pool-wide orphan boundary whose target counts must settle together. */
interface OrphanCapacityGroup {
  readonly poolId: string;
  readonly sessions: readonly WorkerBackendSessionRecord[];
}

/** Groups durable orphans by pool after physical cleanup, excluding owners whose placement is unproved. */
function listOrphanCapacityGroups(
  coreDb: CoreDb,
  failures: RecoveryFailure[]
): OrphanCapacityGroup[] {
  const byPool = new Map<string, WorkerBackendSessionRecord[]>();
  for (const session of listOrphanBackendSessions(coreDb)) {
    try {
      const placement = requireOrphanCapacityPlacement(coreDb, session);
      const group = byPool.get(placement.poolId) ?? [];
      group.push(session);
      byPool.set(placement.poolId, group);
    } catch (error) {
      failures.push({ error, leaseId: session.leaseId });
    }
  }
  return [...byPool.entries()].map(([poolId, sessions]) => ({ poolId, sessions }));
}

/** Atomically retires a fully cleaned orphan pool and releases only its proved target and pool surplus. */
function retireCleanedOrphanGroup(
  coreDb: CoreDb,
  group: OrphanCapacityGroup,
  now: () => string
): void {
  if (group.sessions.some((session) => session.state !== 'physical-cleaned')) {
    return;
  }
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const placements = new Map<string, { targetId: string; poolId: string }>();
    const currentSessions = group.sessions.map(({ leaseId }) => {
      const session = getWorkerBackendSession(coreDb, leaseId);
      const currentOwner = coreDb.sqlite
        .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
        .get(leaseId) as { status: string } | undefined;
      if (
        !session ||
        session.state !== 'physical-cleaned' ||
        (currentOwner &&
          ['planned', 'acquired', 'starting', 'active', 'idle', 'stale', 'releasing'].includes(
            currentOwner.status
          ))
      ) {
        throw new Error(
          `Worker backend session ${leaseId} changed cleanup or live lease ownership.`
        );
      }
      const placement = requireOrphanCapacityPlacement(coreDb, session);
      if (placement.poolId !== group.poolId) {
        throw new Error(`Orphan backend session ${leaseId} changed scheduler capacity placement.`);
      }
      placements.set(leaseId, placement);
      return session;
    });
    releaseOrphanCapacityIfProven(coreDb, currentSessions, placements, group.poolId);
    for (const session of currentSessions) {
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'physical-cleaned',
        leaseId: session.leaseId,
        now,
        toState: 'cleaned',
      });
      recordServerAuditEvent({
        action: 'scheduler.orphan-backend-retired',
        category: 'system',
        coreDb,
        outcome: 'succeeded',
        resource: `server:worker-backend-session:${session.leaseId}`,
        severity: 'warning',
        summary: 'Unowned worker backend session physically cleaned and retired.',
        workspaceId: session.workspaceId,
        threadId: session.threadId,
        turnId: session.turnId,
        agentSessionId: session.agentSessionId,
      });
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Requires the retained lease's own executing plan, or one exact unleased plan, to identify the orphan boundary. */
function requireOrphanCapacityPlacement(
  coreDb: CoreDb,
  session: WorkerBackendSessionRecord
): { targetId: string; poolId: string } {
  const lease = coreDb.sqlite
    .prepare(`SELECT plan_id AS planId, workspace_id AS workspaceId,
    thread_id AS threadId, turn_id AS turnId, agent_session_id AS agentSessionId,
    package_snapshot_id AS packageSnapshotId, sandbox_binding_ref AS sandboxBindingRef,
    scheduler_epoch AS schedulerEpoch, target_id AS targetId, pool_id AS poolId
    FROM scheduler_session_leases WHERE lease_id = ?`)
    .get(session.leaseId) as
    | {
        planId: string;
        workspaceId: string;
        threadId: string;
        turnId: string;
        agentSessionId: string;
        packageSnapshotId: string;
        sandboxBindingRef: string;
        schedulerEpoch: number;
        targetId: string;
        poolId: string;
      }
    | undefined;
  const plans = coreDb.sqlite
    .prepare(`SELECT plan_id AS planId, workspace_id AS workspaceId,
    thread_id AS threadId, turn_id AS turnId, selected_target_id AS targetId,
    selected_pool_id AS poolId, scheduler_epoch AS schedulerEpoch, queue_entry_id AS queueEntryId
    FROM scheduler_placement_plans
    WHERE (? IS NULL OR plan_id = ?) AND workspace_id = ? AND thread_id = ? AND turn_id = ?
      AND status = 'executing'`)
    .all(
      lease?.planId ?? null,
      lease?.planId ?? null,
      session.workspaceId,
      session.threadId,
      session.turnId
    ) as Array<{
    planId: string;
    workspaceId: string;
    threadId: string;
    turnId: string;
    targetId: string;
    poolId: string;
    schedulerEpoch: number;
    queueEntryId: string;
  }>;
  const plan = plans.length === 1 ? plans[0] : undefined;
  if (!plan) {
    throw new Error(
      `Orphan backend session ${session.leaseId} has missing or contradictory scheduler capacity placement.`
    );
  }
  const admission = coreDb.sqlite
    .prepare(`SELECT workspace_id AS workspaceId, thread_id AS threadId,
    turn_id AS turnId FROM scheduler_admission_entries WHERE queue_entry_id = ?`)
    .get(plan.queueEntryId) as
    | { workspaceId: string; threadId: string; turnId: string }
    | undefined;
  const sameProductLineage =
    plan.workspaceId === session.workspaceId &&
    plan.threadId === session.threadId &&
    plan.turnId === session.turnId &&
    admission?.workspaceId === session.workspaceId &&
    admission.threadId === session.threadId &&
    admission.turnId === session.turnId;
  const sameLeaseLineage =
    !lease ||
    (lease.workspaceId === session.workspaceId &&
      lease.threadId === session.threadId &&
      lease.turnId === session.turnId &&
      lease.agentSessionId === session.agentSessionId &&
      lease.packageSnapshotId === session.packageSnapshotId &&
      lease.sandboxBindingRef === session.sandboxBindingRef &&
      lease.schedulerEpoch === plan.schedulerEpoch &&
      lease.targetId === plan.targetId &&
      lease.poolId === plan.poolId);
  if (!sameProductLineage || !sameLeaseLineage) {
    throw new Error(
      `Orphan backend session ${session.leaseId} has contradictory scheduler capacity placement.`
    );
  }
  const placement = { targetId: plan.targetId, poolId: plan.poolId };
  const target = coreDb.sqlite
    .prepare('SELECT pool_id AS poolId FROM scheduler_capacity_records WHERE target_id = ?')
    .get(placement.targetId) as { poolId: string } | undefined;
  if (!target || target.poolId !== placement.poolId) {
    throw new Error(
      `Orphan backend session ${session.leaseId} has contradictory scheduler capacity placement.`
    );
  }
  return placement;
}

/** Releases exactly the proved orphan surplus for a fully cleaned pool while other fences remain untouched. */
function releaseOrphanCapacityIfProven(
  coreDb: CoreDb,
  sessions: readonly WorkerBackendSessionRecord[],
  placements: ReadonlyMap<string, { targetId: string; poolId: string }>,
  poolId: string
): void {
  const leaseIds = new Set(sessions.map(({ leaseId }) => leaseId));
  const targetCounts = new Map<string, number>();
  for (const session of sessions) {
    const placement = placements.get(session.leaseId);
    if (!placement || placement.poolId !== poolId) {
      throw new Error(`Orphan backend session ${session.leaseId} has unproved capacity placement.`);
    }
    targetCounts.set(placement.targetId, (targetCounts.get(placement.targetId) ?? 0) + 1);
  }
  for (const other of listOrphanBackendSessions(coreDb)) {
    if (leaseIds.has(other.leaseId)) continue;
    const otherPlacement = requireOrphanCapacityPlacement(coreDb, other);
    if (otherPlacement.poolId === poolId) {
      throw new Error(`Orphan pool ${poolId} gained another dirty backend session before release.`);
    }
  }
  const otherFence = (
    coreDb.sqlite
      .prepare(`SELECT lease_id AS leaseId FROM scheduler_session_leases
    WHERE pool_id = ? AND status IN ('released', 'lost', 'failed')
      AND recovery_state IS NOT NULL`)
      .all(poolId) as Array<{ leaseId: string }>
  ).find(({ leaseId }) => !leaseIds.has(leaseId));
  if (otherFence) {
    throw new Error(
      `Orphan pool ${poolId} shares a capacity boundary with another recovery fence.`
    );
  }
  for (const runtimeTargetId of new Set(sessions.map(({ runtimeTargetId }) => runtimeTargetId))) {
    const sandboxFence = coreDb.sqlite
      .prepare(`SELECT sandbox_runtime_id FROM sandbox_runtime_records
      WHERE runtime_target_id = ? AND cleanup_state <> 'clean' LIMIT 1`)
      .get(runtimeTargetId);
    if (sandboxFence) {
      throw new Error(`Orphan pool ${poolId} shares an unproved Sandbox cleanup fence.`);
    }
  }
  const liveStatuses = "'planned', 'acquired', 'starting', 'active', 'idle', 'stale', 'releasing'";
  const pool = coreDb.sqlite
    .prepare(
      'SELECT current_admitted_session_count AS count FROM scheduler_worker_pools WHERE pool_id = ?'
    )
    .get(poolId) as { count: number } | undefined;
  const livePool = coreDb.sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM scheduler_session_leases WHERE pool_id = ? AND status IN (${liveStatuses})`
    )
    .get(poolId) as { count: number };
  if (!pool || pool.count !== livePool.count + sessions.length) {
    throw new Error(
      `Orphan pool ${poolId} has an unproved capacity surplus or another fence owner.`
    );
  }
  for (const [targetId, orphanCount] of targetCounts) {
    const target = coreDb.sqlite
      .prepare(
        `SELECT in_use_count AS inUseCount, version FROM scheduler_capacity_records WHERE target_id = ? AND pool_id = ?`
      )
      .get(targetId, poolId) as { inUseCount: number; version: number } | undefined;
    const liveTarget = coreDb.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM scheduler_session_leases WHERE target_id = ? AND status IN (${liveStatuses})`
      )
      .get(targetId) as { count: number };
    if (!target || target.inUseCount !== liveTarget.count + orphanCount) {
      throw new Error(
        `Orphan target ${targetId} has an unproved capacity surplus or another fence owner.`
      );
    }
    const capacityUpdate = coreDb.sqlite
      .prepare(`UPDATE scheduler_capacity_records SET in_use_count = ?, version = version + 1
      WHERE target_id = ? AND pool_id = ? AND in_use_count = ? AND version = ?`)
      .run(liveTarget.count, targetId, poolId, target.inUseCount, target.version);
    if (capacityUpdate.changes !== 1) {
      throw new Error(`Orphan target ${targetId} changed capacity before release.`);
    }
  }
  const poolUpdate = coreDb.sqlite
    .prepare(`UPDATE scheduler_worker_pools SET current_admitted_session_count = ?
    WHERE pool_id = ? AND current_admitted_session_count = ?`)
    .run(livePool.count, poolId, pool.count);
  if (poolUpdate.changes !== 1) {
    throw new Error(`Orphan pool ${poolId} changed capacity before release.`);
  }
}

/** Returns whether restart can prove that no physical session was ever anchored. */
function isProvenPreAnchorLease(row: LeaseRecoveryRow): boolean {
  return (
    row.backendAnchorState === 'unanchored' &&
    row.lastAcceptedHeartbeatAt === null &&
    (row.status === 'planned' ||
      row.status === 'acquired' ||
      (row.status === 'stale' && row.releaseReason === 'startup-timeout'))
  );
}

/** Projects and terminalizes one lease that never crossed the durable backend anchor boundary. */
async function recoverPreAnchorLease(
  coreDb: CoreDb,
  row: LeaseRecoveryRow,
  schedulerEpoch: number,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  const projection = await input.projectRecoveredTurn(row);
  const status = projection.status;
  terminalizeRecoveredLease(coreDb, row, status, schedulerEpoch, 'pre-anchor');
}

/** Classifies one anchored lease without waiting for a NanoHost or product-closeout effect. */
async function classifyAnchoredLease(
  coreDb: CoreDb,
  row: LeaseRecoveryRow,
  originalSession: WorkerBackendSessionRecord,
  schedulerEpoch: number,
  now: () => string,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  const acceptedFinalStatus = hasAcceptedFinalStatus(coreDb, row, originalSession);
  if (['cleanup-pending', 'cleanup-failed'].includes(originalSession.state)) {
    if (acceptedFinalStatus) {
      clearAcceptedFinalStatusRecoveryState(coreDb, row);
    }
    const fenced =
      originalSession.state === 'cleanup-failed'
        ? originalSession
        : moveSessionToCleanupPending(coreDb, originalSession, now());
    assertSessionMatchesLease(fenced, row);
    input.prepareBackendCleanup?.(toRestartBackendIdentity(fenced));
    return;
  }
  if (acceptedFinalStatus) {
    clearAcceptedFinalStatusRecoveryState(coreDb, row);
    if (['physical-cleaned', 'cleaned'].includes(originalSession.state)) {
      await recoverAnchoredLease(coreDb, row, originalSession, schedulerEpoch, now, input);
    } else {
      const fenced = moveSessionToCleanupPending(coreDb, originalSession, now());
      assertSessionMatchesLease(fenced, row);
      input.prepareBackendCleanup?.(toRestartBackendIdentity(fenced));
      await input.projectRecoveredTurn(originalSession);
    }
    return;
  }
  if (['physical-cleaned', 'cleaned'].includes(originalSession.state)) {
    await recoverAnchoredLease(coreDb, row, originalSession, schedulerEpoch, now, input);
    return;
  }
  if (hasReconnectAuthority(row, originalSession)) {
    let backendRestored = false;
    try {
      await input.restoreBackendSession?.(originalSession);
      backendRestored = input.restoreBackendSession !== undefined;
    } catch {
      // An unrestorable handle transfers to the existing fenced cleanup owner.
    }
    if (backendRestored) {
      const timestamp = now();
      if (
        row.expiresAt > timestamp &&
        (row.recoveryDeadline === null || row.recoveryDeadline > timestamp)
      ) {
        const recoveryDeadline =
          row.recoveryDeadline ??
          new Date(
            Math.min(Date.parse(row.expiresAt), Date.parse(timestamp) + WORKER_RECONNECT_WINDOW_MS)
          ).toISOString();
        const armed = coreDb.sqlite
          .prepare(
            `UPDATE scheduler_session_leases
             SET recovery_state = 'awaiting-reconnect', recovery_deadline = ?
             WHERE lease_id = ? AND scheduler_epoch = ? AND status IN ('active', 'idle')
               AND last_worker_sequence IS NOT NULL AND worker_process_key_hash IS NOT NULL`
          )
          .run(recoveryDeadline, row.leaseId, row.schedulerEpoch);
        if (armed.changes !== 1) {
          throw new Error(`Scheduler lease ${row.leaseId} changed while arming reconnect.`);
        }
        return;
      }
    }
  }

  const fenced = moveSessionToCleanupPending(coreDb, originalSession, now());
  assertSessionMatchesLease(fenced, row);
  input.prepareBackendCleanup?.(toRestartBackendIdentity(fenced));
}

/** Clears the generic evidence marker after exact accepted final-status ownership is proved. */
function clearAcceptedFinalStatusRecoveryState(coreDb: CoreDb, row: LeaseRecoveryRow): void {
  const result = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
       SET recovery_state = NULL, recovery_deadline = NULL
       WHERE lease_id = ?
         AND status = 'releasing'
         AND release_reason = 'worker-final-status'
         AND recovery_state IS NOT NULL`
    )
    .run(row.leaseId);
  if (row.recoveryState !== null && result.changes !== 1) {
    throw new Error(
      `Scheduler lease ${row.leaseId} changed while accepting final-status recovery.`
    );
  }
}

/** Cleans, projects, and terminalizes one anchored backend session. */
async function recoverAnchoredLease(
  coreDb: CoreDb,
  row: LeaseRecoveryRow,
  originalSession: WorkerBackendSessionRecord,
  schedulerEpoch: number,
  now: () => string,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  if (hasReconnectAuthority(row, originalSession)) {
    let backendRestored = false;
    try {
      await input.restoreBackendSession?.(originalSession);
      backendRestored = input.restoreBackendSession !== undefined;
    } catch {
      // An unrestorable handle falls through to the existing cleanup path.
    }
    if (backendRestored) {
      const timestamp = now();
      if (
        row.expiresAt > timestamp &&
        (row.recoveryDeadline === null || row.recoveryDeadline > timestamp)
      ) {
        const recoveryDeadline =
          row.recoveryDeadline ??
          new Date(
            Math.min(Date.parse(row.expiresAt), Date.parse(timestamp) + WORKER_RECONNECT_WINDOW_MS)
          ).toISOString();
        const armed = coreDb.sqlite
          .prepare(
            `UPDATE scheduler_session_leases
             SET recovery_state = 'awaiting-reconnect', recovery_deadline = ?
             WHERE lease_id = ? AND scheduler_epoch = ? AND status IN ('active', 'idle')
               AND last_worker_sequence IS NOT NULL AND worker_process_key_hash IS NOT NULL`
          )
          .run(recoveryDeadline, row.leaseId, row.schedulerEpoch);
        if (armed.changes !== 1) {
          throw new Error(`Scheduler lease ${row.leaseId} changed while arming reconnect.`);
        }
        return;
      }
    }
  }

  let session = await cleanupPhysicalSession(
    coreDb,
    getWorkerBackendSession(coreDb, row.leaseId) ?? originalSession,
    now,
    input.cleanupBackendSession
  );
  assertSessionMatchesLease(session, row);

  if (session.state === 'physical-cleaned') {
    const workspace = openRecoveryWorkspace(coreDb, row);
    try {
      assertEnvironmentPackageMatchesSession(workspace.environmentPackage, originalSession);
      const cleanupProjection = projectCleanup(workspace.db, session, workspace.environmentPackage);
      if (
        session.workspaceHandoffState === 'pending' &&
        cleanupProjection.workspaceHandoffComplete
      ) {
        session = markWorkerBackendWorkspaceHandoffComplete(coreDb, {
          leaseId: row.leaseId,
          now,
        });
      }
    } finally {
      workspace.db.sqlite.close();
    }
  }

  const projection = await input.projectRecoveredTurn(session);
  const status = projection.status;
  if (status === 'missing') {
    throw new Error(`Anchored scheduler lease ${row.leaseId} has no recoverable product turn.`);
  }
  if (session.state === 'physical-cleaned') {
    session = transitionWorkerBackendSessionState(coreDb, {
      fromState: 'physical-cleaned',
      leaseId: row.leaseId,
      now,
      toState: 'cleaned',
    });
  }
  terminalizeRecoveredLease(coreDb, row, status, schedulerEpoch, 'backend-cleanup');
}

/** Returns whether one exact live worker has enough durable authority to await reconnect. */
function hasReconnectAuthority(
  row: LeaseRecoveryRow,
  session: WorkerBackendSessionRecord
): boolean {
  return (
    sameRecoveryLineage(row, session) &&
    (row.status === 'active' || row.status === 'idle') &&
    session.state === 'launching' &&
    session.workspaceHandoffState === 'complete' &&
    row.lastWorkerSequence !== null &&
    row.lastWorkerSequence >= 1 &&
    row.workerProcessKeyHash !== null &&
    (row.recoveryState === null ||
      (row.recoveryState === 'awaiting-reconnect' && row.recoveryDeadline !== null))
  );
}

/** Returns whether exact durable final-status evidence is ready for ordinary closeout. */
function hasAcceptedFinalStatus(
  coreDb: CoreDb,
  row: LeaseRecoveryRow,
  session: WorkerBackendSessionRecord
): boolean {
  if (
    row.status !== 'releasing' ||
    row.releaseReason !== 'worker-final-status' ||
    !sameRecoveryLineage(row, session)
  ) {
    return false;
  }
  const { requestId } = requireSchedulerSessionLeaseAdmissionContext(coreDb, row.leaseId);
  return Boolean(
    getWorkerControlAcceptedFinalStatus(coreDb, {
      agentSessionId: row.agentSessionId,
      packageSnapshotId: row.packageSnapshotId,
      requestId,
      threadId: row.threadId,
      turnId: row.turnId,
      workspaceId: row.workspaceId,
    })
  );
}

/** Cleans one exact durable physical identity and records the stable completion instant. */
async function cleanupPhysicalSession(
  coreDb: CoreDb,
  originalSession: WorkerBackendSessionRecord,
  now: () => string,
  cleanupBackendSession: RunSchedulerRestartRecoveryInput['cleanupBackendSession']
): Promise<WorkerBackendSessionRecord> {
  if (['physical-cleaned', 'cleaned'].includes(originalSession.state)) {
    return originalSession;
  }
  let session =
    originalSession.state === 'cleanup-failed'
      ? originalSession
      : moveSessionToCleanupPending(coreDb, originalSession, now());
  if (!cleanupBackendSession) {
    throw new Error('Scheduler restart recovery requires a backend cleanup implementation.');
  }
  try {
    await cleanupBackendSession(toRestartBackendIdentity(session));
  } catch (error) {
    if (session.state === 'cleanup-pending') {
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        leaseId: session.leaseId,
        now,
        toState: 'cleanup-failed',
      });
    }
    throw error;
  }
  if (session.state === 'cleanup-failed') {
    session = moveSessionToCleanupPending(coreDb, session, now());
  }
  return transitionWorkerBackendSessionState(coreDb, {
    fromState: 'cleanup-pending',
    leaseId: session.leaseId,
    now,
    toState: 'physical-cleaned',
  });
}

/** Reconstructs the backend cleanup boundary from the immutable Core manifest. */
function toRestartBackendIdentity(
  session: WorkerBackendSessionRecord
): WorkerGovernanceBackendSessionIdentity {
  return {
    agentSessionId: session.agentSessionId,
    backendKind: parseRestartBackendKind(session.backendKind),
    backendSessionId: session.backendSessionId,
    deploymentId: session.deploymentId,
    packageSnapshotId: session.packageSnapshotId,
    runtimeTargetId: session.runtimeTargetId,
    stagingDirectoryRef: session.stagingDirectoryRef,
    transientProviderInstanceId: session.transientProviderInstanceId,
  };
}

/** Parses one persisted backend family before it crosses the destructive cleanup boundary. */
function parseRestartBackendKind(
  backendKind: string
): WorkerGovernanceBackendSessionIdentity['backendKind'] {
  switch (backendKind) {
    case 'openshell':
    case 'docker':
    case 'kubernetes':
    case 'vm':
    case 'managed-sandbox':
    case 'custom':
      return backendKind;
    default:
      throw new Error(`Unsupported durable worker backend kind: ${backendKind}.`);
  }
}

/** Opens the lease Workspace and loads its immutable AEP snapshot. */
function openRecoveryWorkspace(coreDb: CoreDb, row: LeaseRecoveryRow): RecoveryWorkspace {
  const db = openWorkspaceDb(coreDb.dataRoot, row.workspaceId);
  try {
    applyScopedMigrations(db);
    const environmentPackage = requireAgentEnvironmentPackageSnapshot(
      db,
      row.workspaceId,
      row.packageSnapshotId
    ).snapshot;
    const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, row.leaseId);
    if (!isDeepStrictEqual(environmentPackage.scope.triggerActor, admission.triggerActor)) {
      throw new Error(
        `Agent environment package ${environmentPackage.snapshotId} does not match scheduler trigger actor.`
      );
    }
    return {
      db,
      environmentPackage,
    };
  } catch (error) {
    db.sqlite.close();
    throw error;
  }
}

/** Advances any effect-owning state to cleanup-pending. */
function moveSessionToCleanupPending(
  coreDb: CoreDb,
  session: WorkerBackendSessionRecord,
  timestamp: string
): WorkerBackendSessionRecord {
  if (session.state === 'cleanup-pending') {
    return session;
  }
  return transitionWorkerBackendSessionState(coreDb, {
    fromState: session.state,
    leaseId: session.leaseId,
    now: () => timestamp,
    toState: 'cleanup-pending',
  });
}

/** Projects one stable physical cleanup attempt into the workspace database. */
function projectCleanup(
  workspaceDb: WorkspaceDb,
  session: WorkerBackendSessionRecord,
  environmentPackage: AgentEnvironmentPackage
): ReturnType<typeof projectWorkerBackendCleanup> {
  if (!session.physicalCleanedAt) {
    throw new Error(`Worker backend session ${session.leaseId} has no physical cleanup time.`);
  }
  return projectWorkerBackendCleanup(workspaceDb, {
    agentSessionId: session.agentSessionId,
    backendType: session.backendKind,
    backendVersion: session.backendVersion,
    backendSessionId: session.backendSessionId,
    completedAt: session.physicalCleanedAt,
    outcome: 'succeeded',
    environmentPackage,
    packageSnapshotId: session.packageSnapshotId,
    placement: 'local',
    threadId: session.threadId,
    turnId: session.turnId,
    workerImage: workerBackendImageIdentity(session.backendLineage),
    workspaceHandoffState: session.workspaceHandoffState,
    workspaceId: session.workspaceId,
  });
}

/** Verifies that the Core lease and physical anchor have identical authority lineage. */
function assertSessionMatchesLease(
  session: WorkerBackendSessionRecord,
  row: LeaseRecoveryRow
): void {
  if (
    session.leaseId !== row.leaseId ||
    session.workspaceId !== row.workspaceId ||
    session.threadId !== row.threadId ||
    session.turnId !== row.turnId ||
    session.agentSessionId !== row.agentSessionId ||
    session.packageSnapshotId !== row.packageSnapshotId
  ) {
    throw new Error(`Worker backend session ${session.leaseId} does not match scheduler lineage.`);
  }
}

/** Checks the immutable lease/session lineage without throwing during survivor classification. */
function sameRecoveryLineage(row: LeaseRecoveryRow, session: WorkerBackendSessionRecord): boolean {
  return (
    session.leaseId === row.leaseId &&
    session.workspaceId === row.workspaceId &&
    session.threadId === row.threadId &&
    session.turnId === row.turnId &&
    session.agentSessionId === row.agentSessionId &&
    session.packageSnapshotId === row.packageSnapshotId
  );
}

/** Verifies that the immutable package snapshot owns the exact persisted session lineage. */
function assertEnvironmentPackageMatchesSession(
  environmentPackage: AgentEnvironmentPackage,
  session: WorkerBackendSessionRecord
): void {
  const { scope } = environmentPackage;
  if (
    environmentPackage.snapshotId !== session.packageSnapshotId ||
    scope.workspaceId !== session.workspaceId ||
    scope.threadId !== session.threadId ||
    scope.turnId !== session.turnId ||
    scope.agentSessionId !== session.agentSessionId ||
    environmentPackage.backend.preferred !== session.backendKind ||
    !runtimeImageMatchesBackendLineage(environmentPackage.runtime.image, session.backendLineage)
  ) {
    throw new Error(
      `Agent environment package ${environmentPackage.snapshotId} does not match backend session lineage.`
    );
  }
}

/** Checks immutable AEP reference/build inputs against the persisted backend lineage. */
function runtimeImageMatchesBackendLineage(
  image: AgentEnvironmentPackage['runtime']['image'],
  lineage: WorkerBackendSessionRecord['backendLineage']
): boolean {
  if (image.kind === 'reference') {
    return 'imageRef' in lineage && lineage.imageRef === image.ref;
  }
  return (
    'buildArgumentsDigest' in lineage &&
    lineage.buildArgumentsDigest === image.argumentsDigest &&
    lineage.buildContextDigest === image.contextDigest &&
    lineage.buildInputDigest === image.input.digest
  );
}

/** Applies the authoritative recovered turn outcome and releases scheduler capacity atomically. */
function terminalizeRecoveredLease(
  coreDb: CoreDb,
  row: LeaseRecoveryRow,
  status: RecoveredTurnStatus,
  schedulerEpoch: number,
  reason: 'pre-anchor' | 'backend-cleanup' | 'accepted-final-status'
): void {
  const completed = status === 'completed';
  const released = completed || status === 'interrupted' || status === 'cancelled';
  completeSchedulerSessionLease(coreDb, {
    ...(reason === 'pre-anchor' && !completed ? { admissionStatus: 'cancelled' as const } : {}),
    leaseId: row.leaseId,
    planStatus: reason === 'pre-anchor' ? 'abandoned' : 'completed',
    recoveryState:
      reason === 'accepted-final-status' && status === 'interrupted' ? 'needs-evidence' : null,
    releaseReason: completed ? 'scheduler-restart-turn-completed' : `scheduler-restart-${reason}`,
    schedulerEpoch,
    terminalStatus: released ? 'released' : 'failed',
  });
}
