import { createHash, timingSafeEqual } from 'node:crypto';
import { WorkerProcessKeySchema } from '@openkit/worker-protocol';
import type { SchedulerExecutionLineage } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import {
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
} from './execution-attempt-records.js';
import { getNanoHostRuntimeTarget } from './nanohost-runtime-target.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';

/** Adapter-private native liveness and credentials extend the generic attempt, never its phases. */
export interface NanoHostExecutionAttemptRecord extends SchedulerExecutionAttemptRecord {
  readonly agentSessionId: string;
  readonly inputRef: string;
  readonly bindingRef: string;
  readonly deadline: string | null;
  readonly sessionCompatibilityKey: string | null;
  readonly heartbeatTimeoutMs: number;
  readonly heartbeatDeadline: string;
  readonly startupDeadline: string;
  readonly lastAcceptedHeartbeatAt: string | null;
  readonly lastWorkerSequence: number | null;
  readonly recoveryState: string | null;
  readonly recoveryDeadline: string | null;
  readonly workerProcessKeyHash: string | null;
  readonly workerControlTokenHash: string | null;
  readonly workerInferenceTokenHash: string | null;
  readonly workerCapabilityTokenHash: string | null;
}

/** Adapter-private SQL projection; generic record readers never select these columns. */
interface NanoHostExecutionAttemptRow {
  readonly attempt_id: string;
}

/** Selects identities first so every native read passes through generic core-value validation. */
function nanoHostExecutionAttemptSelectSql(): string {
  return 'SELECT * FROM scheduler_execution_attempts';
}

/** Validates a prepared native correlation before reading its liveness proofs. */
function mapNanoHostExecutionAttemptRow(
  row: NanoHostExecutionAttemptRow,
  coreDb: CoreDb
): NanoHostExecutionAttemptRecord {
  const attempt = requireSchedulerExecutionAttempt(coreDb, row.attempt_id);
  const proof = coreDb.sqlite
    .prepare(`SELECT session_compatibility_key AS sessionCompatibilityKey,
    heartbeat_timeout_ms AS heartbeatTimeoutMs, heartbeat_deadline AS heartbeatDeadline,
    startup_deadline AS startupDeadline, last_accepted_heartbeat_at AS lastAcceptedHeartbeatAt,
    last_worker_sequence AS lastWorkerSequence, recovery_state AS recoveryState,
    recovery_deadline AS recoveryDeadline, worker_process_key_hash AS workerProcessKeyHash,
    worker_control_token_hash AS workerControlTokenHash, worker_inference_token_hash AS workerInferenceTokenHash,
    worker_capability_token_hash AS workerCapabilityTokenHash FROM scheduler_execution_attempts WHERE attempt_id = ?`)
    .get(attempt.attemptId) as Omit<
    NanoHostExecutionAttemptRecord,
    keyof SchedulerExecutionAttemptRecord
  >;
  if (!attempt.agentSessionId || !attempt.inputRef || !attempt.bindingRef || !proof.startupDeadline)
    throw new Error('NanoHost attempt has no complete submission binding.');
  return {
    ...attempt,
    ...proof,
    heartbeatDeadline: proof.heartbeatDeadline ?? proof.startupDeadline,
    agentSessionId: attempt.agentSessionId,
    inputRef: attempt.inputRef,
    bindingRef: attempt.bindingRef,
    deadline: attempt.deadline,
  };
}

/** Input used to accept one execution attempt heartbeat. */
export interface AcceptNanoHostAttemptHeartbeatInput {
  /** Stable execution attempt id. */
  readonly attemptId: string;
  /** Last worker sequence observed in the heartbeat. */
  readonly workerSequence: number;
  /** Heartbeat timeout in milliseconds from the accepted heartbeat timestamp. */
  readonly heartbeatTimeoutMs: number;
  /** Optional sequence-zero commitment to the worker process's reconnect key. */
  readonly workerProcessKeyHash?: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to accept a worker heartbeat through its durable sandbox binding. */
export interface AcceptNanoHostAttemptHeartbeatByBindingInput
  extends ResolveNanoHostAttemptTokenBindingInput {
  /** Worker sequence accepted by the worker-control gateway. */
  readonly workerSequence: number;
  /** NanoCore timestamp assigned to the accepted heartbeat. */
  readonly acceptedAt: string;
  /** Optional sequence-zero commitment to the worker process's reconnect key. */
  readonly workerProcessKeyHash?: string;
}

/** Input used to adopt one exact surviving worker process after NanoCore restarts. */
export interface AdoptNanoHostAttemptReconnectInput {
  /** NanoCore acceptance time for deadline checks. */
  readonly acceptedAt: string;
  /** Exact worker-control lineage bound to the attempt. */
  readonly lineage: SchedulerExecutionLineage;
  /** Memory-only key retained by the original worker process. */
  readonly reconnectKey: string;
  /** Non-secret durable sandbox binding reference. */
  readonly sandboxBindingRef: string;
  /** Exact next heartbeat sequence. */
  readonly workerSequence: number;
}

/** Route-token families bound independently to one execution attempt. */
export type NanoHostAttemptRouteTokenFamily = 'capability' | 'worker-control' | 'inference';

/** Input used to resolve a durable execution attempt token binding. */
export interface ResolveNanoHostAttemptTokenBindingInput {
  /** Non-secret sandbox binding reference that locates the owning attempt. */
  readonly sandboxBindingRef: string;
  /** Worker-control request lineage. */
  readonly lineage: SchedulerExecutionLineage;
  /** Presented live-memory route token when the call performs authentication. */
  readonly token?: string;
  /** Exact route-token family when the call performs authentication. */
  readonly tokenFamily?: NanoHostAttemptRouteTokenFamily;
  /** Optional deterministic clock used for request-time attempt liveness checks. */
  readonly now?: () => string;
}

/** Input used to bind the three route-token hashes to one live execution attempt. */
export interface BindNanoHostAttemptRouteTokenHashesInput {
  /** Stable execution attempt id. */
  readonly attemptId: string;
  /** Non-secret sandbox binding owned by the same attempt. */
  readonly sandboxBindingRef: string;
  /** Lowercase SHA-256 projection of the worker-control token. */
  readonly workerControlTokenHash: string;
  /** Lowercase SHA-256 projection of the independently generated inference token. */
  readonly workerInferenceTokenHash: string;
  /** Lowercase SHA-256 projection of the independently generated capability token. */
  readonly workerCapabilityTokenHash: string;
  /** Optional deterministic clock used for attempt liveness checks. */
  readonly now?: () => string;
}

/** Stable scheduler-domain failure raised when a attempt cannot accept a worker heartbeat. */
export class NanoHostAttemptHeartbeatRejectedError extends Error {
  /** Stable rejection reason for protocol projection. */
  public readonly reason:
    | 'attempt-not-live'
    | 'sequence-stale'
    | 'attempt-changed'
    | 'reconnect-required';

  /**
   * Creates one scheduler heartbeat rejection.
   *
   * @param reason Stable domain rejection reason.
   * @param message Product-safe diagnostic message.
   */
  public constructor(reason: NanoHostAttemptHeartbeatRejectedError['reason'], message: string) {
    super(message);
    this.name = 'NanoHostAttemptHeartbeatRejectedError';
    this.reason = reason;
  }
}

/** Result from resolving a durable execution attempt token binding. */
export type NanoHostAttemptTokenBindingResolution =
  | {
      /** Token binding is valid for a live attempt. */
      readonly status: 'accepted';
      /** Bound live attempt. */
      readonly attempt: NanoHostExecutionAttemptRecord;
    }
  | {
      /** Token binding is not usable. */
      readonly status: 'rejected';
      /** Stable rejection reason. */
      readonly reason:
        | 'binding-not-found'
        | 'lineage-mismatch'
        | 'attempt-not-live'
        | 'reconnect-required';
    };

/**
 * Accepts one heartbeat for a live execution attempt.
 *
 * @param coreDb Open Core database handle.
 * @param input Heartbeat input.
 * @returns Updated execution attempt.
 * @throws Error when the attempt cannot accept heartbeats or the heartbeat is stale.
 */
export function acceptNanoHostAttemptHeartbeat(
  coreDb: CoreDb,
  input: AcceptNanoHostAttemptHeartbeatInput
): NanoHostExecutionAttemptRecord {
  const attempt = requireNanoHostExecutionAttempt(coreDb, input.attemptId);
  const timestamp = input.now?.() ?? new Date().toISOString();
  const workerProcessKeyHash = resolveHeartbeatProcessKeyHash(attempt, input);

  if (!canAcceptHeartbeat(attempt.phase) || attempt.recoveryState !== null) {
    throw new NanoHostAttemptHeartbeatRejectedError(
      'attempt-not-live',
      `Scheduler execution attempt ${input.attemptId} cannot accept heartbeat.`
    );
  }

  const workerDeadline = attempt.lastAcceptedHeartbeatAt
    ? attempt.heartbeatDeadline
    : attempt.startupDeadline;

  if (!attempt.deadline || attempt.deadline <= timestamp || workerDeadline <= timestamp) {
    throw new NanoHostAttemptHeartbeatRejectedError(
      'attempt-not-live',
      `Scheduler execution attempt ${input.attemptId} heartbeat is stale.`
    );
  }

  if (attempt.lastWorkerSequence !== null) {
    if (input.workerSequence < attempt.lastWorkerSequence) {
      throw new NanoHostAttemptHeartbeatRejectedError(
        'sequence-stale',
        `Scheduler execution attempt ${input.attemptId} heartbeat sequence is stale.`
      );
    }
    if (input.workerSequence === attempt.lastWorkerSequence) {
      return attempt;
    }
  }

  const update = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_execution_attempts
      SET phase = 'open',
          heartbeat_deadline = ?,
          last_accepted_heartbeat_at = ?,
          last_worker_sequence = ?,
          worker_process_key_hash = ?
      WHERE attempt_id = ?
        AND phase = ?
        AND deadline = ?
        AND COALESCE(heartbeat_deadline, startup_deadline) = ?
        AND startup_deadline = ?
        AND last_accepted_heartbeat_at IS ?
        AND last_worker_sequence IS ?
        AND worker_process_key_hash IS ?`
    )
    .run(
      addMilliseconds(timestamp, input.heartbeatTimeoutMs),
      timestamp,
      input.workerSequence,
      workerProcessKeyHash,
      input.attemptId,
      attempt.phase,
      attempt.deadline,
      attempt.heartbeatDeadline,
      attempt.startupDeadline,
      attempt.lastAcceptedHeartbeatAt,
      attempt.lastWorkerSequence,
      attempt.workerProcessKeyHash
    );

  if (update.changes !== 1) {
    const current = requireNanoHostExecutionAttempt(coreDb, input.attemptId);

    if (
      current.lastWorkerSequence === input.workerSequence &&
      current.workerProcessKeyHash === workerProcessKeyHash
    ) {
      return current;
    }

    if (current.lastWorkerSequence !== null && current.lastWorkerSequence > input.workerSequence) {
      throw new NanoHostAttemptHeartbeatRejectedError(
        'sequence-stale',
        `Scheduler execution attempt ${input.attemptId} heartbeat sequence is stale.`
      );
    }

    throw new NanoHostAttemptHeartbeatRejectedError(
      'attempt-changed',
      `Scheduler execution attempt ${input.attemptId} cannot accept heartbeat after a concurrent attempt change.`
    );
  }

  return requireNanoHostExecutionAttempt(coreDb, input.attemptId);
}

/**
 * Accepts one authenticated worker-control heartbeat for its durable execution attempt.
 *
 * @param coreDb Open Core database handle.
 * @param input Sandbox binding, lineage, sequence, and accepted timestamp.
 * @returns Updated execution attempt.
 * @throws Error when the binding is invalid or the attempt is no longer live.
 */
export function acceptNanoHostAttemptHeartbeatByBinding(
  coreDb: CoreDb,
  input: AcceptNanoHostAttemptHeartbeatByBindingInput
): NanoHostExecutionAttemptRecord {
  const resolution = resolveNanoHostAttemptTokenBinding(coreDb, {
    lineage: input.lineage,
    now: () => input.acceptedAt,
    sandboxBindingRef: input.sandboxBindingRef,
  });

  if (resolution.status === 'rejected') {
    throw new NanoHostAttemptHeartbeatRejectedError(
      'attempt-not-live',
      `Scheduler heartbeat binding rejected: ${resolution.reason}.`
    );
  }

  return acceptNanoHostAttemptHeartbeat(coreDb, {
    heartbeatTimeoutMs: resolution.attempt.heartbeatTimeoutMs,
    attemptId: resolution.attempt.attemptId,
    now: () => input.acceptedAt,
    workerSequence: input.workerSequence,
    ...(input.workerProcessKeyHash ? { workerProcessKeyHash: input.workerProcessKeyHash } : {}),
  });
}

/**
 * Adopts one exact surviving worker process without advancing its heartbeat sequence.
 *
 * The caller must run this inside the normal heartbeat transaction so the subsequent sequence
 * acceptance rolls the adoption back if the canonical heartbeat cannot be committed.
 *
 * @param coreDb Open Core database handle.
 * @param input Process key, lineage, deadline, and exact next sequence.
 * @returns Lease after the reconnect-only fields are cleared.
 * @throws NanoHostAttemptHeartbeatRejectedError when any durable authority check fails.
 */
export function adoptNanoHostAttemptReconnect(
  coreDb: CoreDb,
  input: AdoptNanoHostAttemptReconnectInput
): NanoHostExecutionAttemptRecord {
  const row = coreDb.sqlite
    .prepare(`${nanoHostExecutionAttemptSelectSql()} WHERE binding_ref = ?`)
    .get(input.sandboxBindingRef) as NanoHostExecutionAttemptRow | undefined;
  if (!row) {
    throwReconnectRejected('attempt-not-live', 'Worker reconnect binding is unknown.');
  }
  const attempt = mapNanoHostExecutionAttemptRow(row, coreDb);
  if (!attemptMatchesLineage(attempt, input.lineage)) {
    throwReconnectRejected('attempt-changed', 'Worker reconnect lineage is not authoritative.');
  }
  if (
    attempt.phase !== 'open' ||
    attempt.recoveryState !== 'awaiting-reconnect' ||
    !attempt.recoveryDeadline ||
    attempt.recoveryDeadline <= input.acceptedAt ||
    !attempt.deadline ||
    attempt.deadline <= input.acceptedAt
  ) {
    throwReconnectRejected('attempt-not-live', 'Worker reconnect deadline or attempt is not live.');
  }
  if (
    attempt.lastWorkerSequence === null ||
    input.workerSequence !== attempt.lastWorkerSequence + 1
  ) {
    throwReconnectRejected('sequence-stale', 'Worker reconnect must use the exact next sequence.');
  }
  const reconnectKey = WorkerProcessKeySchema.parse(input.reconnectKey);
  const presentedHash = createHash('sha256')
    .update(Buffer.from(reconnectKey, 'base64url'))
    .digest();
  const storedHash = attempt.workerProcessKeyHash
    ? Buffer.from(attempt.workerProcessKeyHash, 'base64url')
    : Buffer.alloc(0);
  if (storedHash.length !== presentedHash.length || !timingSafeEqual(storedHash, presentedHash)) {
    throwReconnectRejected('attempt-changed', 'Worker reconnect process key does not match.');
  }
  const backendSession = getWorkerBackendSession(coreDb, attempt.attemptId);
  if (
    !backendSession ||
    backendSession.workspaceId !== attempt.workspaceId ||
    backendSession.threadId !== attempt.threadId ||
    backendSession.turnId !== attempt.turnId ||
    backendSession.agentSessionId !== attempt.agentSessionId ||
    backendSession.packageSnapshotId !== attempt.inputRef ||
    backendSession.sandboxBindingRef !== attempt.bindingRef
  ) {
    throwReconnectRejected('attempt-changed', 'Worker reconnect backend lineage changed.');
  }
  if (backendSession.state !== 'launching' || backendSession.workspaceHandoffState !== 'complete') {
    throwReconnectRejected('attempt-not-live', 'Worker reconnect backend is not live.');
  }
  const runtimeTarget = getNanoHostRuntimeTarget(coreDb, backendSession.runtimeTargetId);
  if (!runtimeTarget || runtimeTarget.deploymentId !== backendSession.deploymentId) {
    throwReconnectRejected('attempt-changed', 'Worker reconnect RuntimeTarget identity changed.');
  }
  if (
    !runtimeTarget.predecessorFenced ||
    !runtimeTarget.ready ||
    !runtimeTarget.freshEmpty ||
    runtimeTarget.physicalEpoch === null
  ) {
    throwReconnectRejected(
      'reconnect-required',
      'Worker reconnect is waiting for current physical Epoch authority.'
    );
  }
  if (runtimeTarget.physicalEpoch !== backendSession.originPhysicalEpoch) {
    throwReconnectRejected('attempt-changed', 'Worker reconnect physical Epoch identity changed.');
  }
  const update = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_execution_attempts
       SET recovery_state = NULL,
           recovery_deadline = NULL,
           heartbeat_deadline = ?
       WHERE attempt_id = ?
         AND recovery_state = 'awaiting-reconnect'
         AND recovery_deadline = ?
         AND last_worker_sequence = ?
         AND worker_process_key_hash = ?`
    )
    .run(
      attempt.recoveryDeadline,
      attempt.attemptId,
      attempt.recoveryDeadline,
      attempt.lastWorkerSequence,
      attempt.workerProcessKeyHash
    );
  if (update.changes !== 1) {
    throwReconnectRejected('attempt-changed', 'Worker reconnect lost its compare-and-set race.');
  }
  return requireNanoHostExecutionAttempt(coreDb, attempt.attemptId);
}

/**
 * Binds the three independently generated route-token hashes to one live attempt.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact attempt, sandbox binding, and hash-only token projections.
 * @returns Updated execution attempt.
 * @throws Error when the attempt is not live, ownership differs, or hashes were already changed.
 */
export function bindNanoHostAttemptRouteTokenHashes(
  coreDb: CoreDb,
  input: BindNanoHostAttemptRouteTokenHashesInput
): NanoHostExecutionAttemptRecord {
  assertLowercaseSha256(input.workerControlTokenHash, 'Worker-control token hash');
  assertLowercaseSha256(input.workerInferenceTokenHash, 'Worker-inference token hash');
  assertLowercaseSha256(input.workerCapabilityTokenHash, 'Worker-capability token hash');

  if (
    new Set([
      input.workerControlTokenHash,
      input.workerInferenceTokenHash,
      input.workerCapabilityTokenHash,
    ]).size !== 3
  ) {
    throw new Error('Worker route-token hashes must be distinct.');
  }

  const attempt = requireNanoHostExecutionAttempt(coreDb, input.attemptId);
  const timestamp = input.now?.() ?? new Date().toISOString();
  const workerDeadline = attempt.lastAcceptedHeartbeatAt
    ? attempt.heartbeatDeadline
    : attempt.startupDeadline;

  if (
    attempt.bindingRef !== input.sandboxBindingRef ||
    !canAcceptHeartbeat(attempt.phase) ||
    (attempt.deadline !== null && attempt.deadline <= timestamp) ||
    workerDeadline <= timestamp
  ) {
    throw new Error(`execution attempt cannot bind route tokens: ${input.attemptId}`);
  }

  if (
    attempt.workerControlTokenHash ||
    attempt.workerInferenceTokenHash ||
    attempt.workerCapabilityTokenHash
  ) {
    if (
      attempt.workerControlTokenHash === input.workerControlTokenHash &&
      attempt.workerInferenceTokenHash === input.workerInferenceTokenHash &&
      attempt.workerCapabilityTokenHash === input.workerCapabilityTokenHash
    ) {
      return attempt;
    }

    throw new Error(`execution attempt route-token hashes already differ: ${input.attemptId}`);
  }

  const update = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_execution_attempts
       SET worker_control_token_hash = ?,
           worker_inference_token_hash = ?,
           worker_capability_token_hash = ?
       WHERE attempt_id = ?
         AND binding_ref = ?
         AND phase = 'open'
         AND CASE
               WHEN last_accepted_heartbeat_at IS NULL THEN startup_deadline
               ELSE heartbeat_deadline
             END > ?
         AND worker_control_token_hash IS NULL
         AND worker_inference_token_hash IS NULL
         AND worker_capability_token_hash IS NULL`
    )
    .run(
      input.workerControlTokenHash,
      input.workerInferenceTokenHash,
      input.workerCapabilityTokenHash,
      input.attemptId,
      input.sandboxBindingRef,
      timestamp
    );

  if (update.changes !== 1) {
    throw new Error(
      `execution attempt route-token binding changed concurrently: ${input.attemptId}`
    );
  }

  return requireNanoHostExecutionAttempt(coreDb, input.attemptId);
}

/**
 * Resolves a non-secret sandbox binding and optional route token through durable attempt records.
 *
 * @param coreDb Open Core database handle.
 * @param input Binding, lineage, and optional family-authentication input.
 * @returns Accepted attempt or stable rejection reason.
 */
export function resolveNanoHostAttemptTokenBinding(
  coreDb: CoreDb,
  input: ResolveNanoHostAttemptTokenBindingInput
): NanoHostAttemptTokenBindingResolution {
  const row = coreDb.sqlite
    .prepare(`${nanoHostExecutionAttemptSelectSql()} WHERE binding_ref = ?`)
    .get(input.sandboxBindingRef) as NanoHostExecutionAttemptRow | undefined;

  if (!row) {
    return { status: 'rejected', reason: 'binding-not-found' };
  }

  const attempt = mapNanoHostExecutionAttemptRow(row, coreDb);
  const timestamp = input.now?.() ?? new Date().toISOString();

  if (!attemptMatchesLineage(attempt, input.lineage)) {
    return { status: 'rejected', reason: 'lineage-mismatch' };
  }

  if ((input.token === undefined) !== (input.tokenFamily === undefined)) {
    return { status: 'rejected', reason: 'binding-not-found' };
  }

  if (input.token !== undefined && input.tokenFamily !== undefined) {
    const expectedHash =
      input.tokenFamily === 'worker-control'
        ? attempt.workerControlTokenHash
        : input.tokenFamily === 'inference'
          ? attempt.workerInferenceTokenHash
          : attempt.workerCapabilityTokenHash;

    if (!expectedHash || !matchesRouteTokenHash(input.token, expectedHash)) {
      return { status: 'rejected', reason: 'binding-not-found' };
    }
  }

  if (
    attempt.recoveryState === 'awaiting-reconnect' &&
    attempt.recoveryDeadline !== null &&
    attempt.recoveryDeadline > timestamp &&
    attempt.deadline !== null &&
    attempt.deadline > timestamp
  ) {
    return { status: 'rejected', reason: 'reconnect-required' };
  }

  const workerDeadline = attempt.lastAcceptedHeartbeatAt
    ? attempt.heartbeatDeadline
    : attempt.startupDeadline;

  if (
    !canAcceptHeartbeat(attempt.phase) ||
    attempt.recoveryState !== null ||
    !attempt.deadline ||
    attempt.deadline <= timestamp ||
    workerDeadline <= timestamp
  ) {
    return { status: 'rejected', reason: 'attempt-not-live' };
  }

  return { status: 'accepted', attempt: attempt };
}

/**
 * Lists live execution attempts that can be restored into worker-control serving state.
 *
 * @param coreDb Open Core database handle.
 * @returns Restorable live execution attempts.
 */
export function listRestorableNanoHostExecutionAttempts(
  coreDb: CoreDb
): NanoHostExecutionAttemptRecord[] {
  const table = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('scheduler_execution_attempts');

  if (!table) {
    return [];
  }

  const rows = coreDb.sqlite
    .prepare(
      `${nanoHostExecutionAttemptSelectSql()}
      WHERE phase = 'open' AND deadline IS NOT NULL
        AND binding_ref IS NOT NULL
        AND worker_control_token_hash IS NOT NULL
        AND worker_inference_token_hash IS NOT NULL
        AND worker_capability_token_hash IS NOT NULL
      ORDER BY created_at ASC, attempt_id ASC`
    )
    .all() as NanoHostExecutionAttemptRow[];

  return rows.map((row) => mapNanoHostExecutionAttemptRow(row, coreDb));
}

/**
 * Reads one execution attempt or throws.
 *
 * @param coreDb Open Core database handle.
 * @param attemptId execution attempt id.
 * @returns Stored execution attempt.
 * @throws Error when the attempt does not exist.
 */
export function requireNanoHostExecutionAttempt(
  coreDb: CoreDb,
  attemptId: string
): NanoHostExecutionAttemptRecord {
  const row = coreDb.sqlite
    .prepare(`${nanoHostExecutionAttemptSelectSql()} WHERE attempt_id = ?`)
    .get(attemptId) as NanoHostExecutionAttemptRow | undefined;

  if (!row) {
    throw new Error(`Scheduler execution attempt not found: ${attemptId}`);
  }

  return mapNanoHostExecutionAttemptRow(row, coreDb);
}

/**
 * Validates one lowercase SHA-256 projection before durable publication.
 *
 * @param value Candidate lowercase hexadecimal digest.
 * @param label Product-safe field label for failures.
 * @throws Error when the value is not exactly one lowercase SHA-256 digest.
 */
function assertLowercaseSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

/**
 * Compares one presented route token with a durable lowercase SHA-256 projection.
 *
 * @param token Presented 43-character unpadded base64url token.
 * @param expectedHash Durable lowercase hexadecimal digest.
 * @returns True only when the token is well formed and its digest matches in constant time.
 */
function matchesRouteTokenHash(token: string, expectedHash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return false;
  }

  const actual = Buffer.from(
    createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'),
    'ascii'
  );
  const expected = Buffer.from(expectedHash, 'ascii');

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Returns whether a attempt status can accept worker heartbeats.
 *
 * @param status Lease status.
 * @returns True when heartbeats may update the attempt.
 */
function canAcceptHeartbeat(status: SchedulerExecutionAttemptRecord['phase']): boolean {
  return status === 'open';
}

/** Resolves the immutable process-key hash committed by the sequence-zero heartbeat. */
function resolveHeartbeatProcessKeyHash(
  attempt: NanoHostExecutionAttemptRecord,
  input: AcceptNanoHostAttemptHeartbeatInput
): string | null {
  const candidate = input.workerProcessKeyHash
    ? WorkerProcessKeySchema.parse(input.workerProcessKeyHash)
    : null;
  if (!attempt.workerProcessKeyHash && candidate && input.workerSequence !== 0) {
    throwReconnectRejected('sequence-stale', 'Only sequence zero may bind a worker process key.');
  }
  if (attempt.workerProcessKeyHash && candidate && candidate !== attempt.workerProcessKeyHash) {
    throwReconnectRejected('attempt-changed', 'Worker process key hash changed after binding.');
  }
  return attempt.workerProcessKeyHash ?? candidate;
}

/** Throws one stable scheduler heartbeat rejection for reconnect authority failures. */
function throwReconnectRejected(
  reason: NanoHostAttemptHeartbeatRejectedError['reason'],
  message: string
): never {
  throw new NanoHostAttemptHeartbeatRejectedError(reason, message);
}

/**
 * Checks whether a attempt matches worker-control request lineage.
 *
 * @param attempt execution attempt.
 * @param lineage Worker-control lineage.
 * @returns True when the durable attempt owns the request lineage.
 */
function attemptMatchesLineage(
  attempt: NanoHostExecutionAttemptRecord,
  lineage: SchedulerExecutionLineage
): boolean {
  return (
    attempt.workspaceId === lineage.workspaceId &&
    attempt.threadId === lineage.threadId &&
    attempt.turnId === lineage.turnId &&
    attempt.agentSessionId === lineage.agentSessionId &&
    attempt.inputRef === lineage.packageSnapshotId
  );
}

/**
 * Adds milliseconds to an ISO timestamp.
 *
 * @param iso Timestamp to offset.
 * @param milliseconds Milliseconds to add.
 * @returns Offset ISO timestamp.
 */
function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}
/** Binds the existing native preparation correlation without fixing or extending the submit deadline. */
export function bindNanoHostAttemptPreparation(
  coreDb: CoreDb,
  input: {
    readonly attemptId: string;
    readonly agentSessionId: string;
    readonly inputRef: string;
    readonly bindingRef: string;
    readonly sessionCompatibilityKey: string;
    readonly now?: () => string;
  }
): void {
  const updated = coreDb.sqlite
    .prepare(`UPDATE scheduler_execution_attempts SET agent_session_id = ?,
    input_ref = ?, binding_ref = ?, session_compatibility_key = ?, startup_deadline = COALESCE(startup_deadline, ?)
    WHERE attempt_id = ? AND phase = 'open' AND (agent_session_id IS NULL OR agent_session_id = ?)
      AND (input_ref IS NULL OR input_ref = ?) AND (binding_ref IS NULL OR binding_ref = ?)`)
    .run(
      input.agentSessionId,
      input.inputRef,
      input.bindingRef,
      input.sessionCompatibilityKey,
      new Date(
        Date.parse(requireSchedulerExecutionAttempt(coreDb, input.attemptId).createdAt) + 1_500_000
      ).toISOString(),
      input.attemptId,
      input.agentSessionId,
      input.inputRef,
      input.bindingRef
    );
  if (updated.changes !== 1) throw new Error('Native preparation lost its exact attempt binding.');
}

/** Adapter-private contradictions prevent a stopped-server no-effect proof from discarding owned execution. */
export function hasNanoHostAttemptOwnershipEvidence(coreDb: CoreDb, attemptId: string): boolean {
  const row = coreDb.sqlite
    .prepare(
      `SELECT last_accepted_heartbeat_at AS heartbeat, last_worker_sequence AS sequence, worker_process_key_hash AS processKey, worker_control_token_hash AS controlToken, worker_inference_token_hash AS inferenceToken, worker_capability_token_hash AS capabilityToken FROM scheduler_execution_attempts WHERE attempt_id = ?`
    )
    .get(attemptId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Native no-effect proof has no exact attempt.');
  if (Object.values(row).some((value) => value !== null)) return true;
  return Boolean(
    coreDb.sqlite
      .prepare('SELECT 1 FROM worker_backend_sessions WHERE attempt_id = ?')
      .get(attemptId)
  );
}

/** Keeps destructive Workspace cleanup fenced until every uncertain Native attempt has exact positive cleanup evidence. */
export function hasUnprovedNanoHostWorkspaceCleanup(coreDb: CoreDb, workspaceId: string): boolean {
  return Boolean(
    coreDb.sqlite
      .prepare(
        `SELECT 1 FROM scheduler_execution_attempts AS attempt WHERE workspace_id = ? AND (
          phase <> 'closed' OR (recovery_state = 'needs-evidence' AND NOT EXISTS (
            SELECT 1 FROM worker_backend_sessions AS backend
            WHERE backend.attempt_id = attempt.attempt_id
              AND backend.workspace_id = attempt.workspace_id AND backend.thread_id = attempt.thread_id
              AND backend.turn_id = attempt.turn_id AND backend.agent_session_id = attempt.agent_session_id
              AND backend.package_snapshot_id = attempt.input_ref AND backend.state = 'cleaned'
              AND backend.physical_cleaned_at IS NOT NULL
          ))) LIMIT 1`
      )
      .get(workspaceId)
  );
}
