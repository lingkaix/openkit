import type { CoreDb } from './storage/db.js';
import type {
  SchedulerSessionLeaseStatus,
  SessionSnapshotKind,
  SessionSnapshotStatus,
} from './storage/schema/index.js';

/** Snapshot record stored in the server-scoped continuity ledger. */
export interface SessionSnapshotRecord {
  /** Stable snapshot id. */
  readonly snapshotId: string;
  /** Source agent session id. */
  readonly agentSessionId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Optional thread-affinity lineage id. */
  readonly threadId: string | null;
  /** Turn lineage id that triggered the snapshot. */
  readonly turnId: string;
  /** Agent Environment Package snapshot id captured at snapshot time. */
  readonly aepSnapshotId: string;
  /** Snapshot storage mechanism. */
  readonly snapshotKind: SessionSnapshotKind;
  /** Redacted backend handle reference. */
  readonly backendHandleRef: string;
  /** Strict V1 compatibility key captured at snapshot time. */
  readonly sessionCompatibilityKey: string;
  /** Optional backend content digest. */
  readonly contentDigest: string | null;
  /** Snapshot creation timestamp. */
  readonly createdAt: string;
  /** Snapshot expiry timestamp. */
  readonly expiresAt: string;
  /** Snapshot lifecycle status. */
  readonly status: SessionSnapshotStatus;
}

/** Input accepted when recording a session snapshot. */
export type RecordSessionSnapshotInput = SessionSnapshotRecord;

/** Query used to list compatible, available session snapshots. */
export interface ListAvailableSessionSnapshotsInput {
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Optional thread-affinity lineage id. */
  readonly threadId?: string | null;
  /** Strict V1 compatibility key required by the turn. */
  readonly sessionCompatibilityKey: string;
  /** ISO timestamp used for expiry filtering. */
  readonly now: string;
}

/** Live session candidate considered by the strict V1 selector. */
export interface LiveSessionCandidate {
  /** Agent session id. */
  readonly agentSessionId: string;
  /** Projected live session status. */
  readonly status: 'ready' | 'idle' | 'starting' | 'interrupted' | 'failed' | 'closed';
  /** Strict V1 compatibility key, when known. */
  readonly sessionCompatibilityKey: string | null;
  /** Whether the session may be reused. */
  readonly reusable: boolean;
}

/** Suspended or serialized runtime-handle candidate considered by the selector. */
export interface ResumeHandleCandidate {
  /** Agent session id. */
  readonly agentSessionId: string;
  /** Projected resumable session status. */
  readonly status: 'suspended' | 'serialized' | 'closed' | 'failed';
  /** Strict V1 compatibility key, when known. */
  readonly sessionCompatibilityKey: string | null;
}

/** Snapshot candidate considered by the selector. */
export interface SnapshotCandidate {
  /** Snapshot id. */
  readonly snapshotId: string;
  /** Snapshot lifecycle status. */
  readonly status: SessionSnapshotStatus;
  /** Strict V1 compatibility key, when known. */
  readonly sessionCompatibilityKey: string | null;
  /** Snapshot expiry timestamp. */
  readonly expiresAt: string;
}

/** Input for strict V1 session continuity selection. */
export interface SelectAgentSessionContinuityInput {
  /** Strict V1 compatibility key required by the turn. */
  readonly requestedCompatibilityKey: string;
  /** ISO timestamp used for expiry filtering. */
  readonly now: string;
  /** Reusable live session candidates. */
  readonly liveSessions: readonly LiveSessionCandidate[];
  /** Resume-handle candidates. */
  readonly resumeHandles: readonly ResumeHandleCandidate[];
  /** Snapshot candidates. */
  readonly snapshots: readonly SnapshotCandidate[];
}

/** Selected continuity path. */
export type AgentSessionContinuitySelection =
  | { readonly kind: 'live-session'; readonly agentSessionId: string }
  | { readonly kind: 'resume-handle'; readonly agentSessionId: string }
  | { readonly kind: 'snapshot-restore'; readonly snapshotId: string }
  | { readonly kind: 'fresh-session' };

/** Candidate rejection reason returned for diagnostics and audit. */
export type AgentSessionContinuityRejectionReason =
  | 'not-reusable'
  | 'not-live'
  | 'not-resumable'
  | 'snapshot-not-available'
  | 'snapshot-expired'
  | 'compatibility-key-mismatch'
  | 'compatibility-key-missing';

/** Rejected selector candidate. */
export interface AgentSessionContinuityRejectedCandidate {
  /** Candidate family. */
  readonly candidateKind: 'live-session' | 'resume-handle' | 'snapshot';
  /** Stable candidate id. */
  readonly candidateId: string;
  /** Typed rejection reason. */
  readonly reason: AgentSessionContinuityRejectionReason;
}

/** Result of strict V1 session continuity selection. */
export interface AgentSessionContinuitySelectionResult {
  /** Selected path. */
  readonly selected: AgentSessionContinuitySelection;
  /** Rejected candidates in evaluation order. */
  readonly rejectedCandidates: readonly AgentSessionContinuityRejectedCandidate[];
}

/** Recovery option offered after a scheduler lease outcome. */
export type AgentSessionRecoveryOption =
  | 'retry_fresh_session'
  | 'retry_replacement_session'
  | 'restore_from_snapshot'
  | 'mark_turn_failed'
  | 'request_human_decision';

/** Input for lease-outcome session recovery option computation. */
export interface ComputeAgentSessionRecoveryOptionsInput {
  /** Terminal scheduler lease status. */
  readonly leaseStatus: Extract<SchedulerSessionLeaseStatus, 'released' | 'lost' | 'failed'>;
  /** Typed lease release reason. */
  readonly releaseReason: string;
  /** Whether an eligible snapshot exists for this recovery point. */
  readonly hasEligibleSnapshot: boolean;
}

/** Recovery option matrix output. */
export interface AgentSessionRecoveryOptions {
  /** Projected session transition. */
  readonly sessionTransition: 'idle' | 'closed' | 'failed' | 'interrupted';
  /** Closed option set offered to workflow or human decision code. */
  readonly options: readonly AgentSessionRecoveryOption[];
  /** Default option for automatic recovery when policy allows it. */
  readonly defaultOption: AgentSessionRecoveryOption | null;
}

interface SessionSnapshotRow {
  readonly snapshot_id: string;
  readonly agent_session_id: string;
  readonly workspace_id: string;
  readonly thread_id: string | null;
  readonly turn_id: string;
  readonly aep_snapshot_id: string;
  readonly snapshot_kind: SessionSnapshotKind;
  readonly backend_handle_ref: string;
  readonly session_compatibility_key: string;
  readonly content_digest: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly status: SessionSnapshotStatus;
}

/**
 * Records one durable server-scoped session snapshot row.
 *
 * @param coreDb Open Core database handle.
 * @param input Snapshot record to persist.
 * @returns Stored snapshot record.
 */
export function recordSessionSnapshot(
  coreDb: CoreDb,
  input: RecordSessionSnapshotInput
): SessionSnapshotRecord {
  validateNonEmpty(input.snapshotId, 'snapshotId');
  validateNonEmpty(input.agentSessionId, 'agentSessionId');
  validateNonEmpty(input.workspaceId, 'workspaceId');
  validateNonEmpty(input.turnId, 'turnId');
  validateNonEmpty(input.aepSnapshotId, 'aepSnapshotId');
  validateNonEmpty(input.backendHandleRef, 'backendHandleRef');
  validateNonEmpty(input.sessionCompatibilityKey, 'sessionCompatibilityKey');

  coreDb.sqlite
    .prepare(
      `INSERT INTO session_snapshots (
        snapshot_id,
        agent_session_id,
        workspace_id,
        thread_id,
        turn_id,
        aep_snapshot_id,
        snapshot_kind,
        backend_handle_ref,
        session_compatibility_key,
        content_digest,
        created_at,
        expires_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.snapshotId,
      input.agentSessionId,
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.aepSnapshotId,
      input.snapshotKind,
      input.backendHandleRef,
      input.sessionCompatibilityKey,
      input.contentDigest,
      input.createdAt,
      input.expiresAt,
      input.status
    );

  return requireSessionSnapshot(coreDb, input.snapshotId);
}

/**
 * Lists available snapshots matching the strict V1 compatibility key.
 *
 * @param coreDb Open Core database handle.
 * @param input Query filters.
 * @returns Available compatible snapshots in newest-first order.
 */
export function listAvailableSessionSnapshots(
  coreDb: CoreDb,
  input: ListAvailableSessionSnapshotsInput
): SessionSnapshotRecord[] {
  const rows = coreDb.sqlite
    .prepare(
      `${sessionSnapshotSelectSql()}
      WHERE workspace_id = ?
        AND (? IS NULL OR thread_id = ? OR thread_id IS NULL)
        AND session_compatibility_key = ?
        AND status = 'available'
        AND expires_at > ?
      ORDER BY created_at DESC, snapshot_id DESC`
    )
    .all(
      input.workspaceId,
      input.threadId ?? null,
      input.threadId ?? null,
      input.sessionCompatibilityKey,
      input.now
    ) as SessionSnapshotRow[];

  return rows.map(mapSessionSnapshotRow);
}

/**
 * Selects the strict V1 session continuity path.
 *
 * @param input Candidate sets and requested compatibility key.
 * @returns Selected path and rejected candidate diagnostics.
 */
export function selectAgentSessionContinuity(
  input: SelectAgentSessionContinuityInput
): AgentSessionContinuitySelectionResult {
  const rejectedCandidates: AgentSessionContinuityRejectedCandidate[] = [];

  for (const candidate of input.liveSessions) {
    const rejection = rejectLiveSession(candidate, input.requestedCompatibilityKey);
    if (!rejection) {
      return {
        rejectedCandidates,
        selected: { agentSessionId: candidate.agentSessionId, kind: 'live-session' },
      };
    }
    rejectedCandidates.push({
      candidateId: candidate.agentSessionId,
      candidateKind: 'live-session',
      reason: rejection,
    });
  }

  for (const candidate of input.resumeHandles) {
    const rejection = rejectResumeHandle(candidate, input.requestedCompatibilityKey);
    if (!rejection) {
      return {
        rejectedCandidates,
        selected: { agentSessionId: candidate.agentSessionId, kind: 'resume-handle' },
      };
    }
    rejectedCandidates.push({
      candidateId: candidate.agentSessionId,
      candidateKind: 'resume-handle',
      reason: rejection,
    });
  }

  for (const candidate of input.snapshots) {
    const rejection = rejectSnapshot(candidate, input.requestedCompatibilityKey, input.now);
    if (!rejection) {
      return {
        rejectedCandidates,
        selected: { kind: 'snapshot-restore', snapshotId: candidate.snapshotId },
      };
    }
    rejectedCandidates.push({
      candidateId: candidate.snapshotId,
      candidateKind: 'snapshot',
      reason: rejection,
    });
  }

  return { rejectedCandidates, selected: { kind: 'fresh-session' } };
}

/**
 * Computes the closed recovery option set for one terminal scheduler lease outcome.
 *
 * @param input Terminal lease outcome and snapshot eligibility.
 * @returns Session transition, options, and default option.
 */
export function computeAgentSessionRecoveryOptions(
  input: ComputeAgentSessionRecoveryOptionsInput
): AgentSessionRecoveryOptions {
  if (input.leaseStatus === 'released') {
    return {
      defaultOption: null,
      options: [],
      sessionTransition: input.releaseReason === 'completed' ? 'closed' : 'idle',
    };
  }

  if (input.leaseStatus === 'failed' && input.releaseReason === 'startup-timeout') {
    return {
      defaultOption: 'retry_fresh_session',
      options: ['retry_fresh_session', 'mark_turn_failed'],
      sessionTransition: 'failed',
    };
  }

  if (input.leaseStatus === 'lost') {
    return {
      defaultOption: 'retry_fresh_session',
      options: withOptionalSnapshot(
        ['retry_fresh_session', 'mark_turn_failed', 'request_human_decision'],
        input.hasEligibleSnapshot
      ),
      sessionTransition: 'failed',
    };
  }

  return {
    defaultOption: 'retry_replacement_session',
    options: withOptionalSnapshot(
      ['retry_replacement_session', 'mark_turn_failed', 'request_human_decision'],
      input.hasEligibleSnapshot
    ),
    sessionTransition: 'interrupted',
  };
}

/**
 * Reads one snapshot or fails when it is missing.
 *
 * @param coreDb Open Core database handle.
 * @param snapshotId Snapshot id.
 * @returns Stored snapshot record.
 */
function requireSessionSnapshot(coreDb: CoreDb, snapshotId: string): SessionSnapshotRecord {
  const row = coreDb.sqlite
    .prepare(`${sessionSnapshotSelectSql()} WHERE snapshot_id = ?`)
    .get(snapshotId) as SessionSnapshotRow | undefined;
  if (!row) {
    throw new Error(`Session snapshot not found: ${snapshotId}`);
  }
  return mapSessionSnapshotRow(row);
}

/**
 * Returns the SQL projection for session snapshot rows.
 *
 * @returns SELECT clause for session snapshot rows.
 */
function sessionSnapshotSelectSql(): string {
  return `SELECT
    snapshot_id,
    agent_session_id,
    workspace_id,
    thread_id,
    turn_id,
    aep_snapshot_id,
    snapshot_kind,
    backend_handle_ref,
    session_compatibility_key,
    content_digest,
    created_at,
    expires_at,
    status
    FROM session_snapshots`;
}

/**
 * Maps a database row into a public record.
 *
 * @param row Database row.
 * @returns Session snapshot record.
 */
function mapSessionSnapshotRow(row: SessionSnapshotRow): SessionSnapshotRecord {
  return {
    aepSnapshotId: row.aep_snapshot_id,
    agentSessionId: row.agent_session_id,
    backendHandleRef: row.backend_handle_ref,
    contentDigest: row.content_digest,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sessionCompatibilityKey: row.session_compatibility_key,
    snapshotId: row.snapshot_id,
    snapshotKind: row.snapshot_kind,
    status: row.status,
    threadId: row.thread_id,
    turnId: row.turn_id,
    workspaceId: row.workspace_id,
  };
}

/**
 * Validates that a required string is present.
 *
 * @param value Value to validate.
 * @param field Field name for diagnostics.
 */
function validateNonEmpty(value: string, field: string): void {
  if (value.trim() === '') {
    throw new Error(`Session snapshot ${field} is required.`);
  }
}

/**
 * Returns a live-session rejection reason, or null when accepted.
 *
 * @param candidate Candidate session.
 * @param requestedCompatibilityKey Required strict V1 compatibility key.
 * @returns Rejection reason or null.
 */
function rejectLiveSession(
  candidate: LiveSessionCandidate,
  requestedCompatibilityKey: string
): AgentSessionContinuityRejectionReason | null {
  if (!candidate.reusable) {
    return 'not-reusable';
  }
  if (candidate.status !== 'ready' && candidate.status !== 'idle') {
    return 'not-live';
  }
  return rejectCompatibilityKey(candidate.sessionCompatibilityKey, requestedCompatibilityKey);
}

/**
 * Returns a resume-handle rejection reason, or null when accepted.
 *
 * @param candidate Candidate resume handle.
 * @param requestedCompatibilityKey Required strict V1 compatibility key.
 * @returns Rejection reason or null.
 */
function rejectResumeHandle(
  candidate: ResumeHandleCandidate,
  requestedCompatibilityKey: string
): AgentSessionContinuityRejectionReason | null {
  if (candidate.status !== 'suspended' && candidate.status !== 'serialized') {
    return 'not-resumable';
  }
  return rejectCompatibilityKey(candidate.sessionCompatibilityKey, requestedCompatibilityKey);
}

/**
 * Returns a snapshot rejection reason, or null when accepted.
 *
 * @param candidate Candidate snapshot.
 * @param requestedCompatibilityKey Required strict V1 compatibility key.
 * @param now ISO timestamp used for expiry filtering.
 * @returns Rejection reason or null.
 */
function rejectSnapshot(
  candidate: SnapshotCandidate,
  requestedCompatibilityKey: string,
  now: string
): AgentSessionContinuityRejectionReason | null {
  if (candidate.status !== 'available') {
    return 'snapshot-not-available';
  }
  if (candidate.expiresAt <= now) {
    return 'snapshot-expired';
  }
  return rejectCompatibilityKey(candidate.sessionCompatibilityKey, requestedCompatibilityKey);
}

/**
 * Returns a compatibility rejection reason, or null when accepted.
 *
 * @param actual Candidate compatibility key.
 * @param expected Required strict V1 compatibility key.
 * @returns Rejection reason or null.
 */
function rejectCompatibilityKey(
  actual: string | null,
  expected: string
): AgentSessionContinuityRejectionReason | null {
  if (!actual) {
    return 'compatibility-key-missing';
  }
  if (actual !== expected) {
    return 'compatibility-key-mismatch';
  }
  return null;
}

/**
 * Inserts restore-from-snapshot after the retry option when a snapshot is eligible.
 *
 * @param base Base option set.
 * @param hasEligibleSnapshot Whether restore is eligible.
 * @returns Option set with optional snapshot restore.
 */
function withOptionalSnapshot(
  base: readonly AgentSessionRecoveryOption[],
  hasEligibleSnapshot: boolean
): AgentSessionRecoveryOption[] {
  if (!hasEligibleSnapshot) {
    return [...base];
  }
  const [first, ...rest] = base;
  return first ? [first, 'restore_from_snapshot', ...rest] : ['restore_from_snapshot'];
}
