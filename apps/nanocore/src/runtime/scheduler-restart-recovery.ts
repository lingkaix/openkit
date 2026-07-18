import type { AgentEnvironmentPackage } from '@openkit/config-schema';
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
} from './worker-backend-sessions.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';
import type { WorkerGovernanceBackendSessionIdentity } from './worker-governance-backend.js';

const WORKER_RECONNECT_WINDOW_MS = 60_000;

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
  /** Agent session lineage id. */
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
  /** Projects one recovered product turn and returns its authoritative terminal state. */
  readonly projectRecoveredTurn: (
    subject: WorkerBackendSessionRecord | PreAnchorRecoveryContext
  ) => Promise<{ readonly status: RecoveredTurnStatus }>;
  /** Resumes the existing closeout path when final status was durable before the restart. */
  readonly reconcileAcceptedFinalStatus?: (
    session: WorkerBackendSessionRecord
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
 * Arms eligible live leases for bounded reconnect and closes every other durable owner at boot.
 *
 * @param coreDb Open Core database handle.
 * @param input Physical cleanup, product projection, and deterministic clock dependencies.
 * @returns New scheduler epoch and pre-anchor leases terminalized during recovery.
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
      await cleanupPhysicalSession(coreDb, orphan, now, input.cleanupBackendSession);
      failures.push({
        error: new Error(
          `Worker backend session ${orphan.leaseId} has no non-terminal scheduler lease owner.`
        ),
        leaseId: orphan.leaseId,
      });
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

      await recoverAnchoredLease(coreDb, row, session, schedulerEpoch, now, input);
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
 * Cleans only reconnect candidates whose one boot-armed deadline has expired.
 *
 * @param coreDb Open Core database handle.
 * @param input Existing cleanup, projection, and final-status closeout dependencies.
 */
export async function runExpiredSchedulerReconnectCleanup(
  coreDb: CoreDb,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const failures: RecoveryFailure[] = [];
  const rows = listNonTerminalLeaseRows(coreDb).filter(
    (row) =>
      row.recoveryState === 'awaiting-reconnect' &&
      row.recoveryDeadline !== null &&
      row.recoveryDeadline <= timestamp
  );

  for (const row of rows) {
    try {
      const claimed = coreDb.sqlite
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
      if (claimed.changes !== 1) {
        continue;
      }
      const session = getWorkerBackendSession(coreDb, row.leaseId);
      if (!session) {
        throw new Error(`Scheduler lease ${row.leaseId} has no durable backend session anchor.`);
      }
      await recoverAnchoredLease(
        coreDb,
        { ...row, recoveryDeadline: null, recoveryState: 'needs-evidence' },
        session,
        row.schedulerEpoch,
        () => timestamp,
        input
      );
    } catch (error) {
      failures.push({ error, leaseId: row.leaseId });
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
    const lease = coreDb.sqlite
      .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
      .get(session.leaseId) as { status: string } | undefined;
    return !lease || session.state !== 'cleaned';
  });
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

/** Cleans, projects, and terminalizes one anchored backend session. */
async function recoverAnchoredLease(
  coreDb: CoreDb,
  row: LeaseRecoveryRow,
  originalSession: WorkerBackendSessionRecord,
  schedulerEpoch: number,
  now: () => string,
  input: RunSchedulerRestartRecoveryInput
): Promise<void> {
  const acceptedFinalStatus = await reconcileAcceptedFinalStatus(
    coreDb,
    row,
    originalSession,
    input
  );
  if (acceptedFinalStatus) {
    if (acceptedFinalStatus.status === 'missing') {
      throw new Error(`Anchored scheduler lease ${row.leaseId} has no recoverable product turn.`);
    }
    terminalizeRecoveredLease(
      coreDb,
      row,
      acceptedFinalStatus.status,
      schedulerEpoch,
      acceptedFinalStatus.status === 'interrupted' ? 'accepted-final-status' : 'backend-cleanup'
    );
    return;
  }
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

/** Re-enters normal closeout only when an exact durable final status already exists. */
async function reconcileAcceptedFinalStatus(
  coreDb: CoreDb,
  row: LeaseRecoveryRow,
  session: WorkerBackendSessionRecord,
  input: RunSchedulerRestartRecoveryInput
): Promise<{ readonly status: RecoveredTurnStatus } | null> {
  if (row.status !== 'releasing' || row.releaseReason !== 'worker-final-status') {
    return null;
  }
  if (!sameRecoveryLineage(row, session)) {
    return null;
  }
  const { requestId } = requireSchedulerSessionLeaseAdmissionContext(coreDb, row.leaseId);
  const accepted = getWorkerControlAcceptedFinalStatus(coreDb, {
    agentSessionId: row.agentSessionId,
    packageSnapshotId: row.packageSnapshotId,
    requestId,
    threadId: row.threadId,
    turnId: row.turnId,
    workspaceId: row.workspaceId,
  });
  if (!accepted) {
    return null;
  }
  if (!input.reconcileAcceptedFinalStatus) {
    throw new Error(
      `Scheduler lease ${row.leaseId} requires accepted final-status reconciliation.`
    );
  }
  return input.reconcileAcceptedFinalStatus(session);
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
  const session = moveSessionToCleanupPending(coreDb, originalSession, now());
  if (!cleanupBackendSession) {
    throw new Error('Scheduler restart recovery requires a backend cleanup implementation.');
  }
  try {
    await cleanupBackendSession(toRestartBackendIdentity(session));
  } catch (error) {
    transitionWorkerBackendSessionState(coreDb, {
      fromState: 'cleanup-pending',
      leaseId: session.leaseId,
      now,
      toState: 'cleanup-failed',
    });
    throw error;
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
    backendTarget: session.backendTarget,
    deploymentId: session.deploymentId,
    packageSnapshotId: session.packageSnapshotId,
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

/** Opens the admission owner's workspace and loads its immutable AEP snapshot. */
function openRecoveryWorkspace(coreDb: CoreDb, row: LeaseRecoveryRow): RecoveryWorkspace {
  const { userId } = requireSchedulerSessionLeaseAdmissionContext(coreDb, row.leaseId);
  const db = openWorkspaceDb(coreDb.dataRoot, userId, row.workspaceId);
  try {
    applyScopedMigrations(db);
    return {
      db,
      environmentPackage: requireAgentEnvironmentPackageSnapshot(
        db,
        row.workspaceId,
        row.packageSnapshotId
      ).snapshot,
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
    placement: session.backendTarget.placement,
    threadId: session.threadId,
    turnId: session.turnId,
    workerImage: session.workerImage,
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
    environmentPackage.runtime.image.ref !== session.workerImage
  ) {
    throw new Error(
      `Agent environment package ${environmentPackage.snapshotId} does not match backend session lineage.`
    );
  }
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
