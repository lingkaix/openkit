import { OperationError } from '../operation-error.js';
import type { CoreDb } from '../storage/db.js';
import { readNanoHostObservation } from '../storage/nanohost-observation-reader.js';
import { readNanoHostRecoveryLease } from '../storage/nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from '../storage/nanohost-submitted-lease.js';
import { resolveAdmittedNanoHostWorkerBinding } from '../storage/nanohost-worker-binding.js';
import {
  bindSchedulerExecutionAttemptSession,
  finalizeSchedulerExecutionAttemptInput,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
} from './execution-attempt-records.js';
import {
  NANO_HOST_HEARTBEAT_BUDGET_MS,
  nanoHostStartupDeadline,
} from './nanohost-attempt-clocks.js';
import type { getWorkerBackendSession } from './worker-backend-session-records.js';
import type { WorkerControlLineage } from './worker-control-gateway.js';

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

/** Native projections use the current acknowledged opening and its read snapshot. */
function readAttemptEvidence<Value>(
  coreDb: CoreDb,
  query: Parameters<typeof readNanoHostObservation<Value>>[1]
): Value {
  const observed = readNanoHostObservation(coreDb.dataRoot, query);
  if (observed.state !== 'ready')
    throw new OperationError(
      'operation_storage_unavailable',
      'NanoHost execution evidence is unavailable.',
      503
    );
  return observed.value;
}

/** Core-only frames cannot write Native liveness or publish a Native receipt. */
function nativeWriterRequired(): never {
  throw new OperationError(
    'operation_storage_unavailable',
    'NanoHost attempt mutation requires the admitted Native writer.',
    503
  );
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
  readonly lineage: WorkerControlLineage;
  /** Memory-only key retained by the original worker process. */
  readonly reconnectKey: string;
  /** Non-secret durable sandbox binding reference. */
  readonly sandboxBindingRef: string;
  /** Presented heartbeat sequence. */
  readonly workerSequence: number;
}

/** Route-token families bound independently to one execution attempt. */
export type NanoHostAttemptRouteTokenFamily = 'capability' | 'worker-control' | 'inference';

/** Input used to resolve a durable execution attempt token binding. */
export interface ResolveNanoHostAttemptTokenBindingInput {
  /** Non-secret sandbox binding reference that locates the owning attempt. */
  readonly sandboxBindingRef: string;
  /** Worker-control request lineage. */
  readonly lineage: WorkerControlLineage;
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
    | 'heartbeat-already-accepted'
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

/** The retired Core heartbeat entry is held; admitted heartbeats use their Native writer. */
export function acceptNanoHostAttemptHeartbeat(
  _coreDb: CoreDb,
  _input: AcceptNanoHostAttemptHeartbeatInput
): NanoHostExecutionAttemptRecord {
  return nativeWriterRequired();
}

/** The retired Core binding entry cannot publish a Native heartbeat. */
export function acceptNanoHostAttemptHeartbeatByBinding(
  _coreDb: CoreDb,
  _input: AcceptNanoHostAttemptHeartbeatByBindingInput
): NanoHostExecutionAttemptRecord {
  return nativeWriterRequired();
}

/** Reconnect proof belongs to the admitted Native heartbeat writer. */
export function adoptNanoHostAttemptReconnect(
  _coreDb: CoreDb,
  _input: AdoptNanoHostAttemptReconnectInput
): NanoHostExecutionAttemptRecord {
  return nativeWriterRequired();
}

/** The Core-only frame holds even when it carries a hash rather than the raw process key. */
export function adoptNanoHostAttemptReconnectHash(
  _coreDb: CoreDb,
  _input: Omit<AdoptNanoHostAttemptReconnectInput, 'reconnectKey'> & {
    readonly processKeyHash: string;
    readonly heartbeatFingerprint?: string;
  }
): NanoHostExecutionAttemptRecord {
  return nativeWriterRequired();
}

/** Route-token hashes are decided with the original admitted NanoHost submission. */
export function bindNanoHostAttemptRouteTokenHashes(
  _coreDb: CoreDb,
  _input: BindNanoHostAttemptRouteTokenHashesInput
): NanoHostExecutionAttemptRecord {
  return nativeWriterRequired();
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
  const { token, tokenFamily } = input;
  if ((token === undefined) !== (tokenFamily === undefined))
    return { status: 'rejected', reason: 'binding-not-found' };
  return readAttemptEvidence(coreDb, (sqlite) =>
    resolveAdmittedNanoHostWorkerBinding(
      coreDb,
      sqlite,
      {
        sandboxBindingRef: input.sandboxBindingRef,
        lineage: input.lineage,
        ...(token === undefined ? {} : { token }),
        ...(tokenFamily === undefined ? {} : { tokenFamily }),
      },
      input.now?.()
    )
  );
}

/** Resolves the exact Turn lease; a resident Sandbox may be shared by several leases. */
export function resolveLiveNanoHostAttemptLease(
  coreDb: CoreDb,
  input: Pick<ResolveNanoHostAttemptTokenBindingInput, 'lineage' | 'now'> & {
    readonly attemptId: string;
  }
): NanoHostAttemptTokenBindingResolution {
  const original = readRetainedNanoHostSubmission(coreDb, input.attemptId);
  if (!original) return { status: 'rejected', reason: 'binding-not-found' };
  const resolved = resolveNanoHostAttemptTokenBinding(coreDb, {
    ...input,
    sandboxBindingRef: original.lease.attempt.bindingRef,
  });
  return resolved.status === 'accepted' && resolved.attempt.attemptId !== input.attemptId
    ? { status: 'rejected', reason: 'lineage-mismatch' }
    : resolved;
}

/** Reads the exact original submission, or the clock-only projection before a submit exists. */
export function requireNanoHostExecutionAttempt(
  coreDb: CoreDb,
  attemptId: string
): NanoHostExecutionAttemptRecord {
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  const { agentSessionId, inputRef, bindingRef } = attempt;
  if (attempt.backendId !== 'nanohost' || !agentSessionId || !inputRef || !bindingRef)
    throw new Error('NanoHost attempt has no complete preparation binding.');
  if (attempt.deadline !== null) {
    const original = readRetainedNanoHostSubmission(coreDb, attemptId);
    if (!original) throw new Error('NanoHost attempt has no original submitted grant.');
    return readAttemptEvidence(
      coreDb,
      (sqlite) => readNanoHostRecoveryLease(sqlite, original.lease).attempt
    );
  }

  const startupDeadline = nanoHostStartupDeadline(attempt);
  return {
    ...attempt,
    agentSessionId,
    inputRef,
    bindingRef,
    startupDeadline,
    heartbeatTimeoutMs: NANO_HOST_HEARTBEAT_BUDGET_MS,
    heartbeatDeadline: startupDeadline,
    sessionCompatibilityKey: null,
    lastAcceptedHeartbeatAt: null,
    lastWorkerSequence: null,
    recoveryState: null,
    recoveryDeadline: null,
    workerProcessKeyHash: null,
    workerControlTokenHash: null,
    workerInferenceTokenHash: null,
    workerCapabilityTokenHash: null,
  };
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
  coreDb.sqlite
    .transaction(() => {
      bindSchedulerExecutionAttemptSession(coreDb, input);
      finalizeSchedulerExecutionAttemptInput(coreDb, input);
    })
    .immediate();
}

/** Rechecks the existing reconnect eligibility from current native and backend records. */
export function isNanoHostAttemptReconnectEligible(
  native: NanoHostExecutionAttemptRecord,
  session: NonNullable<ReturnType<typeof getWorkerBackendSession>>,
  timestamp: string
): boolean {
  return (
    session.attemptId === native.attemptId &&
    session.workspaceId === native.workspaceId &&
    session.threadId === native.threadId &&
    session.turnId === native.turnId &&
    session.agentSessionId === native.agentSessionId &&
    session.packageSnapshotId === native.inputRef &&
    native.phase === 'open' &&
    native.deadline !== null &&
    native.deadline > timestamp &&
    session.state === 'launching' &&
    session.workspaceHandoffState === 'complete' &&
    native.lastWorkerSequence !== null &&
    native.lastWorkerSequence >= 1 &&
    native.workerProcessKeyHash !== null &&
    (native.recoveryState === null || native.recoveryState === 'awaiting-reconnect') &&
    (native.recoveryDeadline === null || native.recoveryDeadline > timestamp)
  );
}

/** Admitted recovery owns the original reconnect clock and proof. */
export function armNanoHostAttemptReconnect(
  _coreDb: CoreDb,
  _input: {
    readonly attemptId: string;
    readonly classifiedAt: string;
    readonly expectedRecoveryDeadline: string | null;
    readonly now?: () => string;
  }
): void {
  nativeWriterRequired();
}

/** Needs-evidence follows the separate Core close on the admitted recovery owner. */
export function markNanoHostAttemptNeedsEvidence(_coreDb: CoreDb, _attemptId: string): void {
  nativeWriterRequired();
}

/** Adapter-private contradictions prevent a stopped-server no-effect proof from discarding owned execution. */
export function hasNanoHostAttemptOwnershipEvidence(coreDb: CoreDb, attemptId: string): boolean {
  requireSchedulerExecutionAttempt(coreDb, attemptId);
  return readAttemptEvidence(coreDb, (sqlite) =>
    Boolean(
      sqlite.prepare('SELECT 1 FROM worker_backend_sessions WHERE attempt_id = ?').get(attemptId)
    )
  );
}
