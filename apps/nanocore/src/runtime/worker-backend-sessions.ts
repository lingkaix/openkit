import type { CoreDb } from '../storage/db.js';
import type {
  WorkerBackendSessionPlacement,
  WorkerBackendSessionState,
  WorkerBackendWorkspaceHandoffState,
} from '../storage/schema/index.js';
import type { WorkerGovernanceBackendSessionIdentity } from './worker-governance-backend.js';

export type { WorkerBackendSessionState } from '../storage/schema/index.js';

/** Exact physical backend target persisted before any external effect. */
export interface WorkerBackendSessionTarget {
  /** Stable non-secret binding for the exact Cell lifecycle target. */
  readonly cellTargetId: string;
  /** Local or remote placement. */
  readonly placement: WorkerBackendSessionPlacement;
  /** Exact gateway name. */
  readonly gatewayName: string;
  /** Exact direct gateway endpoint, when configured. */
  readonly gatewayEndpoint: string | null;
}

/** Durable package-scoped physical backend session. */
export interface WorkerBackendSessionRecord {
  /** Scheduler lease that exclusively owns the session. */
  readonly leaseId: string;
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
  /** Physical backend family. */
  readonly backendKind: string;
  /** Stable data-root deployment that owns every physical artifact. */
  readonly deploymentId: string;
  /** Backend implementation version captured before physical effects. */
  readonly backendVersion: string | null;
  /** Immutable worker image reference captured from the package. */
  readonly workerImage: string;
  /** Exact physical backend target. */
  readonly backendTarget: WorkerBackendSessionTarget;
  /** Backend-native physical session id. */
  readonly backendSessionId: string;
  /** Data-root-relative backend-private staging directory. */
  readonly stagingDirectoryRef: string;
  /** Exact transient backend provider removed with the physical Cell epoch. */
  readonly transientProviderInstanceId: string | null;
  /** Cross-database workspace handle publication phase. */
  readonly workspaceHandoffState: WorkerBackendWorkspaceHandoffState;
  /** Durable physical lifecycle state. */
  readonly state: WorkerBackendSessionState;
  /** Stable physical cleanup completion time, when cleanup succeeded. */
  readonly physicalCleanedAt: string | null;
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Last lifecycle transition timestamp. */
  readonly updatedAt: string;
}

/** Input for recording the pre-effect backend identity. */
export interface RecordWorkerBackendSessionMaterializingInput {
  /** One indivisible pure backend plan whose lineage and physical names cannot be mixed. */
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  /** Backend implementation version captured before physical effects. */
  readonly backendVersion: string | null;
  /** Immutable worker image reference captured from the package. */
  readonly workerImage: string;
  /** Scheduler-owned product lineage not duplicated by the physical plan. */
  readonly lineage: {
    /** Workspace lineage id. */
    readonly workspaceId: string;
    /** Thread lineage id. */
    readonly threadId: string;
    /** Turn lineage id. */
    readonly turnId: string;
  };
  /** Deterministic clock for persistence and deadline validation. */
  readonly now?: () => string;
  /** Scheduler-owned non-secret sandbox binding reference. */
  readonly sandboxBindingRef: string;
}

/** Input for one compare-and-set backend session transition. */
export interface TransitionWorkerBackendSessionStateInput {
  /** Expected current state. */
  readonly fromState: WorkerBackendSessionState;
  /** Owning scheduler lease id. */
  readonly leaseId: string;
  /** Deterministic transition clock. */
  readonly now?: () => string;
  /** Required next state. */
  readonly toState: WorkerBackendSessionState;
}

/** Input for the atomic live-lease launch gate. */
export interface MarkWorkerBackendSessionLaunchingInput {
  /** Owning scheduler lease id. */
  readonly leaseId: string;
  /** Deterministic validation and transition clock. */
  readonly now?: () => string;
}

/** Input for publishing the complete workspace handoff marker. */
export interface MarkWorkerBackendWorkspaceHandoffCompleteInput {
  /** Owning scheduler lease id. */
  readonly leaseId: string;
  /** Deterministic marker clock. */
  readonly now?: () => string;
}

/** Raw SQLite worker backend session row. */
interface WorkerBackendSessionRow {
  readonly lease_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly package_snapshot_id: string;
  readonly backend_kind: string;
  readonly deployment_id: string;
  readonly backend_version: string | null;
  readonly worker_image: string;
  readonly cell_target_id: string;
  readonly placement: WorkerBackendSessionPlacement;
  readonly gateway_name: string;
  readonly gateway_endpoint: string | null;
  readonly backend_session_id: string;
  readonly staging_directory_ref: string;
  readonly transient_provider_instance_id: string | null;
  readonly workspace_handoff_state: WorkerBackendWorkspaceHandoffState;
  readonly state: WorkerBackendSessionState;
  readonly physical_cleaned_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Raw scheduler lease fields required by the pre-effect insertion gate. */
interface WorkerBackendSessionLeaseRow {
  readonly lease_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly package_snapshot_id: string;
  readonly status: string;
  readonly expires_at: string;
  readonly heartbeat_deadline: string;
  readonly startup_deadline: string;
  readonly last_accepted_heartbeat_at: string | null;
  readonly backend_anchor_state: 'unanchored' | 'anchored';
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<WorkerBackendSessionState, readonly WorkerBackendSessionState[]>
> = {
  materializing: ['materialized', 'cleanup-pending'],
  materialized: ['launching', 'cleanup-pending'],
  launching: ['cleanup-pending'],
  'cleanup-pending': ['cleanup-failed', 'physical-cleaned'],
  'cleanup-failed': ['cleanup-pending'],
  'physical-cleaned': ['cleaned'],
  cleaned: [],
};

/**
 * Records the deterministic physical session identity before any backend effect.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact backend identity, lease binding, lineage, and validation clock.
 * @returns Inserted or exactly replayed durable session.
 * @throws Error when lease authority is missing, stale, terminal, or conflicting.
 */
export function recordWorkerBackendSessionMaterializing(
  coreDb: CoreDb,
  input: RecordWorkerBackendSessionMaterializingInput
): WorkerBackendSessionRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();
  let leaseId = '';

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const lease = coreDb.sqlite
      .prepare(
        `SELECT lease_id, workspace_id, thread_id, turn_id, agent_session_id,
                package_snapshot_id, status, expires_at, heartbeat_deadline,
                startup_deadline, last_accepted_heartbeat_at, backend_anchor_state
         FROM scheduler_session_leases
         WHERE sandbox_binding_ref = ?
         ORDER BY acquired_at DESC, lease_id DESC
         LIMIT 1`
      )
      .get(input.sandboxBindingRef) as WorkerBackendSessionLeaseRow | undefined;

    if (!lease || !leaseMatchesInput(lease, input)) {
      throw new Error('Scheduler lease binding does not match worker backend session lineage.');
    }
    leaseId = lease.lease_id;

    const deadline = lease.last_accepted_heartbeat_at
      ? lease.heartbeat_deadline
      : lease.startup_deadline;
    if (
      !['acquired', 'starting', 'active', 'idle'].includes(lease.status) ||
      lease.expires_at <= timestamp ||
      deadline <= timestamp
    ) {
      throw new Error('Scheduler lease is not live for worker backend materialization.');
    }

    const existing = selectWorkerBackendSession(coreDb, leaseId);
    if (existing) {
      const record = mapWorkerBackendSessionRow(existing);
      if (!workerBackendSessionMatchesInput(record, input)) {
        throw new Error('Worker backend session identity conflicts with its durable lease.');
      }
      if (record.state !== 'materializing') {
        throw new Error('Worker backend session is not materializing.');
      }
      if (lease.backend_anchor_state !== 'anchored') {
        throw new Error('Scheduler lease backend anchor marker is inconsistent.');
      }
      coreDb.sqlite.exec('COMMIT');
      return record;
    }

    coreDb.sqlite
      .prepare(
        `INSERT INTO worker_backend_sessions (
           lease_id, workspace_id, thread_id, turn_id, agent_session_id,
           package_snapshot_id, backend_kind, deployment_id, backend_version, worker_image, cell_target_id, placement, gateway_name,
           gateway_endpoint, backend_session_id,
           staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
           state, physical_cleaned_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'materializing', NULL, ?, ?)`
      )
      .run(
        leaseId,
        input.lineage.workspaceId,
        input.lineage.threadId,
        input.lineage.turnId,
        input.identity.agentSessionId,
        input.identity.packageSnapshotId,
        input.identity.backendKind,
        input.identity.deploymentId,
        input.backendVersion,
        input.workerImage,
        input.identity.backendTarget.cellTargetId,
        input.identity.backendTarget.placement,
        input.identity.backendTarget.gatewayName,
        input.identity.backendTarget.gatewayEndpoint,
        input.identity.backendSessionId,
        input.identity.stagingDirectoryRef,
        input.identity.transientProviderInstanceId,
        timestamp,
        timestamp
      );
    const anchorMarker = coreDb.sqlite
      .prepare(
        `UPDATE scheduler_session_leases
         SET backend_anchor_state = 'anchored'
         WHERE lease_id = ? AND backend_anchor_state = 'unanchored'`
      )
      .run(leaseId);
    if (anchorMarker.changes !== 1) {
      throw new Error('Scheduler lease backend anchor marker changed before insertion.');
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return requireWorkerBackendSession(coreDb, leaseId);
}

/**
 * Applies one allowed compare-and-set lifecycle transition.
 *
 * @param coreDb Open Core database handle.
 * @param input Expected state, next state, lease id, and transition clock.
 * @returns Updated durable session.
 * @throws Error when the requested transition is invalid or the state changed concurrently.
 */
export function transitionWorkerBackendSessionState(
  coreDb: CoreDb,
  input: TransitionWorkerBackendSessionStateInput
): WorkerBackendSessionRecord {
  if (!ALLOWED_TRANSITIONS[input.fromState].includes(input.toState)) {
    throw new Error(
      `Worker backend session transition is invalid: ${input.fromState} -> ${input.toState}.`
    );
  }
  const timestamp = input.now?.() ?? new Date().toISOString();
  const result = coreDb.sqlite
    .prepare(
      `UPDATE worker_backend_sessions
       SET state = ?,
           physical_cleaned_at = CASE WHEN ? = 'physical-cleaned' THEN ? ELSE physical_cleaned_at END,
           updated_at = ?
       WHERE lease_id = ? AND state = ?`
    )
    .run(input.toState, input.toState, timestamp, timestamp, input.leaseId, input.fromState);

  if (result.changes !== 1) {
    throw new Error('Worker backend session state changed before transition.');
  }
  return requireWorkerBackendSession(coreDb, input.leaseId);
}

/**
 * Atomically validates live scheduler authority and opens the physical launch gate.
 *
 * @param coreDb Open Core database handle.
 * @param input Owning lease and validation clock.
 * @returns Session transitioned from materialized to launching.
 * @throws Error when lease authority, deadlines, anchor state, or session state is invalid.
 */
export function markWorkerBackendSessionLaunching(
  coreDb: CoreDb,
  input: MarkWorkerBackendSessionLaunchingInput
): WorkerBackendSessionRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const row = coreDb.sqlite
      .prepare(
        `SELECT sessions.state,
                sessions.workspace_handoff_state AS workspaceHandoffState,
                leases.status,
                leases.expires_at AS expiresAt,
                leases.heartbeat_deadline AS heartbeatDeadline,
                leases.startup_deadline AS startupDeadline,
                leases.last_accepted_heartbeat_at AS lastAcceptedHeartbeatAt,
                leases.backend_anchor_state AS backendAnchorState
         FROM worker_backend_sessions AS sessions
         JOIN scheduler_session_leases AS leases ON leases.lease_id = sessions.lease_id
         WHERE sessions.lease_id = ?`
      )
      .get(input.leaseId) as
      | {
          readonly backendAnchorState: 'unanchored' | 'anchored';
          readonly expiresAt: string;
          readonly heartbeatDeadline: string;
          readonly lastAcceptedHeartbeatAt: string | null;
          readonly startupDeadline: string;
          readonly state: WorkerBackendSessionState;
          readonly status: string;
          readonly workspaceHandoffState: WorkerBackendWorkspaceHandoffState;
        }
      | undefined;
    const deadline = row?.lastAcceptedHeartbeatAt ? row.heartbeatDeadline : row?.startupDeadline;
    if (
      !row ||
      row.state !== 'materialized' ||
      row.workspaceHandoffState !== 'complete' ||
      row.backendAnchorState !== 'anchored' ||
      !['acquired', 'starting', 'active', 'idle'].includes(row.status) ||
      row.expiresAt <= timestamp ||
      !deadline ||
      deadline <= timestamp
    ) {
      throw new Error('Scheduler lease is not live for worker backend launch.');
    }
    const transition = coreDb.sqlite
      .prepare(
        `UPDATE worker_backend_sessions
         SET state = 'launching', updated_at = ?
         WHERE lease_id = ? AND state = 'materialized'`
      )
      .run(timestamp, input.leaseId);
    if (transition.changes !== 1) {
      throw new Error('Worker backend session state changed before launch.');
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return requireWorkerBackendSession(coreDb, input.leaseId);
}

/**
 * Marks the exact workspace handle set as published after its workspace transaction commits.
 *
 * @param coreDb Open Core database handle.
 * @param input Owning lease and marker clock.
 * @returns Updated durable backend session.
 * @throws Error when the marker changed concurrently.
 */
export function markWorkerBackendWorkspaceHandoffComplete(
  coreDb: CoreDb,
  input: MarkWorkerBackendWorkspaceHandoffCompleteInput
): WorkerBackendSessionRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const result = coreDb.sqlite
    .prepare(
      `UPDATE worker_backend_sessions
       SET workspace_handoff_state = 'complete', updated_at = ?
       WHERE lease_id = ? AND workspace_handoff_state = 'pending'`
    )
    .run(timestamp, input.leaseId);
  if (result.changes !== 1) {
    throw new Error('Worker backend workspace handoff changed before publication.');
  }
  return requireWorkerBackendSession(coreDb, input.leaseId);
}

/**
 * Reads one durable backend session by scheduler lease.
 *
 * @param coreDb Open Core database handle.
 * @param leaseId Owning scheduler lease id.
 * @returns Durable session or null when no physical identity was recorded.
 */
export function getWorkerBackendSession(
  coreDb: CoreDb,
  leaseId: string
): WorkerBackendSessionRecord | null {
  const row = selectWorkerBackendSession(coreDb, leaseId);
  return row ? mapWorkerBackendSessionRow(row) : null;
}

/**
 * Lists all durable backend sessions in stable lease order.
 *
 * @param coreDb Open Core database handle.
 * @returns Durable session rows.
 */
export function listWorkerBackendSessions(coreDb: CoreDb): WorkerBackendSessionRecord[] {
  const rows = coreDb.sqlite
    .prepare(`${workerBackendSessionSelectSql()} ORDER BY lease_id ASC`)
    .all() as WorkerBackendSessionRow[];
  return rows.map(mapWorkerBackendSessionRow);
}

/** Reads one durable backend session or throws. */
function requireWorkerBackendSession(coreDb: CoreDb, leaseId: string): WorkerBackendSessionRecord {
  const session = getWorkerBackendSession(coreDb, leaseId);
  if (!session) {
    throw new Error(`Worker backend session not found: ${leaseId}`);
  }
  return session;
}

/** Selects one raw durable backend session row. */
function selectWorkerBackendSession(
  coreDb: CoreDb,
  leaseId: string
): WorkerBackendSessionRow | undefined {
  return coreDb.sqlite
    .prepare(`${workerBackendSessionSelectSql()} WHERE lease_id = ?`)
    .get(leaseId) as WorkerBackendSessionRow | undefined;
}

/** Returns the canonical worker backend session select projection. */
function workerBackendSessionSelectSql(): string {
  return `SELECT lease_id, workspace_id, thread_id, turn_id, agent_session_id,
                 package_snapshot_id, backend_kind, deployment_id, backend_version, worker_image, cell_target_id, placement, gateway_name,
                 gateway_endpoint, backend_session_id,
                 staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
                 state, physical_cleaned_at, created_at, updated_at
          FROM worker_backend_sessions`;
}

/** Checks complete scheduler lineage equality. */
function leaseMatchesInput(
  lease: WorkerBackendSessionLeaseRow,
  input: RecordWorkerBackendSessionMaterializingInput
): boolean {
  return (
    lease.workspace_id === input.lineage.workspaceId &&
    lease.thread_id === input.lineage.threadId &&
    lease.turn_id === input.lineage.turnId &&
    lease.agent_session_id === input.identity.agentSessionId &&
    lease.package_snapshot_id === input.identity.packageSnapshotId
  );
}

/** Checks whether an existing anchor is an exact retry of the insertion input. */
function workerBackendSessionMatchesInput(
  record: WorkerBackendSessionRecord,
  input: RecordWorkerBackendSessionMaterializingInput
): boolean {
  return (
    record.workspaceId === input.lineage.workspaceId &&
    record.threadId === input.lineage.threadId &&
    record.turnId === input.lineage.turnId &&
    record.agentSessionId === input.identity.agentSessionId &&
    record.packageSnapshotId === input.identity.packageSnapshotId &&
    record.backendKind === input.identity.backendKind &&
    record.deploymentId === input.identity.deploymentId &&
    record.backendVersion === input.backendVersion &&
    record.workerImage === input.workerImage &&
    record.backendSessionId === input.identity.backendSessionId &&
    record.stagingDirectoryRef === input.identity.stagingDirectoryRef &&
    record.transientProviderInstanceId === input.identity.transientProviderInstanceId &&
    record.backendTarget.cellTargetId === input.identity.backendTarget.cellTargetId &&
    record.backendTarget.placement === input.identity.backendTarget.placement &&
    record.backendTarget.gatewayName === input.identity.backendTarget.gatewayName &&
    record.backendTarget.gatewayEndpoint === input.identity.backendTarget.gatewayEndpoint
  );
}

/** Maps a raw SQLite row to the durable public record. */
function mapWorkerBackendSessionRow(row: WorkerBackendSessionRow): WorkerBackendSessionRecord {
  return {
    leaseId: row.lease_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    agentSessionId: row.agent_session_id,
    packageSnapshotId: row.package_snapshot_id,
    backendKind: row.backend_kind,
    deploymentId: row.deployment_id,
    backendVersion: row.backend_version,
    workerImage: row.worker_image,
    backendTarget: {
      cellTargetId: row.cell_target_id,
      placement: row.placement,
      gatewayName: row.gateway_name,
      gatewayEndpoint: row.gateway_endpoint,
    },
    backendSessionId: row.backend_session_id,
    stagingDirectoryRef: row.staging_directory_ref,
    transientProviderInstanceId: row.transient_provider_instance_id,
    workspaceHandoffState: row.workspace_handoff_state,
    state: row.state,
    physicalCleanedAt: row.physical_cleaned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
