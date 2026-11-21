import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJsonText } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  NANO_HOST_HEARTBEAT_BUDGET_MS,
  nanoHostStartupDeadline,
} from '../runtime/nanohost-attempt-clocks.js';
import type { NanoHostExecutionAttemptRecord } from '../runtime/nanohost-attempt-records.js';
import {
  getNanoHostRuntimeTarget,
  type NanoHostRuntimeTargetRecord,
} from '../runtime/nanohost-runtime-target-records.js';
import {
  bindNanoHostWorkerRoutes,
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  type NanoHostSubmissionPlacement,
  readNanoHostSubmissionPlacement,
  readNanoHostWorkerLease,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
} from '../runtime/worker-backend-session-records.js';
import type { ExecutionGrant } from './control-kernel-port.js';
import { assertControlProductWriter } from './control-store-product-records.js';

const clock = z.iso.datetime({ precision: 3 });
const physicalCleanup = z.strictObject({
  connectionGeneration: z.number().int().positive().safe(),
  physicalEpoch: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: clock,
});
export const NanoHostWorkerRecoveryState = z.strictObject({
  version: z.literal(1),
  sessionCompatibilityKey: z.string().nullable(),
  startupDeadline: clock,
  heartbeatTimeoutMs: z.number().int().positive().safe(),
  heartbeatDeadline: clock,
  lastAcceptedHeartbeatAt: clock.nullable(),
  lastWorkerSequence: z.number().int().nonnegative().safe().nullable(),
  workerProcessKeyHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable(),
  recoveryState: z.enum(['awaiting-reconnect', 'needs-evidence']).nullable(),
  recoveryDeadline: clock.nullable(),
  physicalCleanup: physicalCleanup.optional(),
});
export type NanoHostWorkerRecoveryState = z.output<typeof NanoHostWorkerRecoveryState>;

export type SubmittedNanoHostGrant = Extract<ExecutionGrant, { readonly deadline: string }>;

export interface NanoHostRecoveryLease {
  readonly grant: SubmittedNanoHostGrant;
  readonly attempt: Omit<
    NanoHostExecutionAttemptRecord,
    | keyof NanoHostWorkerRecoveryState
    | 'workerControlTokenHash'
    | 'workerInferenceTokenHash'
    | 'workerCapabilityTokenHash'
  >;
}

export type NanoHostRecoveryMutation = {
  readonly lease: NanoHostRecoveryLease;
  readonly expectedSession: WorkerBackendSessionRecord;
  readonly expectedRecovery: NanoHostWorkerRecoveryState;
  readonly observedAt: string;
} & (
  | { readonly kind: 'arm-reconnect'; readonly classifiedAt: string }
  | { readonly kind: 'needs-evidence' }
  | {
      readonly kind: 'transition';
      readonly toState: 'cleanup-pending' | 'cleanup-failed' | 'physical-cleaned';
      readonly target: NanoHostRuntimeTargetRecord;
    }
  | { readonly kind: 'finish-cleanup' | 'retire-orphan' }
  | { readonly kind: 'workspace-handoff' }
);

export function readNanoHostRecoveryLease(sqlite: Database.Database, lease: NanoHostRecoveryLease) {
  const { grant, attempt } = lease;
  if (
    grant.attemptId !== attempt.attemptId ||
    grant.turnId !== attempt.turnId ||
    grant.operationId !== attempt.operationId ||
    grant.inputRef !== attempt.inputRef ||
    grant.bindingRef !== attempt.bindingRef ||
    grant.deadline !== attempt.deadline ||
    grant.backendId !== attempt.backendId
  )
    throw new Error('NanoHost recovery grant does not cover the original attempt.');
  const native = readNanoHostWorkerLease({ sqlite }, grant, attempt);
  if (!native) throw new Error('NanoHost recovery has no original native lease.');
  const json = sqlite
    .prepare('SELECT worker_recovery_json FROM worker_backend_sessions WHERE attempt_id = ?')
    .pluck()
    .get(attempt.attemptId);
  if (typeof json !== 'string')
    throw new Error('NanoHost recovery has no original liveness proof.');
  const proof = NanoHostWorkerRecoveryState.parse(JSON.parse(json));
  if (canonicalJsonText(proof) !== json) throw new Error('NanoHost recovery proof is invalid.');
  const { version: _version, physicalCleanup: _physicalCleanup, ...liveness } = proof;
  return {
    session: native.session,
    proof,
    attempt: {
      ...attempt,
      ...liveness,
      workerControlTokenHash: native.binding.control,
      workerInferenceTokenHash: native.binding.inference,
      workerCapabilityTokenHash: native.binding.capability,
    } satisfies NanoHostExecutionAttemptRecord,
  };
}

/** Consumes the verified original Core submission and the redacted queued turn.start. */
export function applyNanoHostWorkerSubmission(
  sqlite: Database.Database,
  input: {
    readonly lease: NanoHostRecoveryLease;
    readonly placement: NanoHostSubmissionPlacement;
    readonly command: Parameters<typeof bindNanoHostWorkerRoutes>[3];
    readonly observedAt: string;
    readonly sessionCompatibilityKey?: string;
  }
): WorkerBackendSessionRecord {
  assertControlProductWriter(sqlite);
  const { lease, placement } = input;
  const observedAt = clock.parse(input.observedAt);
  const startupDeadline = nanoHostStartupDeadline(lease.attempt);
  if (
    lease.attempt.phase !== 'open' ||
    observedAt < lease.attempt.createdAt ||
    observedAt >= startupDeadline ||
    observedAt >= lease.grant.deadline ||
    placement.workspaceId !== lease.attempt.workspaceId ||
    placement.threadId !== lease.attempt.threadId ||
    placement.agentSessionId !== lease.attempt.agentSessionId
  )
    throw new Error('NanoHost submission has no current original startup authority.');
  // A caught Native refusal may never leave launch, route hashes or liveness partially published.
  return sqlite.transaction(() => {
    const owner = { sqlite };
    const session = getWorkerBackendSession(owner, lease.grant.attemptId);
    if (session?.state !== 'launching') {
      if (!readNanoHostSubmissionPlacement(owner, lease.grant, placement))
        throw new Error('NanoHost submission placement changed.');
      transitionWorkerBackendSessionState(owner, {
        attemptId: lease.grant.attemptId,
        fromState: 'materialized',
        toState: 'launching',
        now: () => observedAt,
      });
    }
    bindNanoHostWorkerRoutes(owner, lease.grant, placement, input.command);
    initializeNanoHostRecoveryLease(sqlite, lease, {
      version: 1,
      sessionCompatibilityKey: input.sessionCompatibilityKey ?? null,
      startupDeadline,
      heartbeatTimeoutMs: NANO_HOST_HEARTBEAT_BUDGET_MS,
      heartbeatDeadline: startupDeadline,
      lastAcceptedHeartbeatAt: null,
      lastWorkerSequence: null,
      workerProcessKeyHash: null,
      recoveryState: null,
      recoveryDeadline: null,
    });
    return readNanoHostRecoveryLease(sqlite, lease).session;
  })();
}

/** Read the original physical result only while its exact admitted target remains current. */
export function readNanoHostPhysicalCleanupReceipt(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  expectedTarget: NanoHostRuntimeTargetRecord
) {
  const { session, proof, attempt } = readNanoHostRecoveryLease(sqlite, lease);
  const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
  const receipt = proof.physicalCleanup;
  if (
    attempt.phase === 'open' ||
    (session.state !== 'physical-cleaned' && session.state !== 'cleaned') ||
    !receipt ||
    receipt.observedAt !== session.physicalCleanedAt ||
    !target?.ready ||
    !target.freshEmpty ||
    !target.predecessorFenced ||
    target.deploymentId !== session.deploymentId ||
    !isDeepStrictEqual(target, expectedTarget) ||
    receipt.connectionGeneration !== target.connectionGeneration ||
    receipt.physicalEpoch !== target.physicalEpoch
  )
    return null;
  return { grant: lease.grant, session, target, observedAt: receipt.observedAt };
}

/** The lifecycle writer supplies the first liveness tuple with the original granted route binding.
 * An exact repeat may inspect the retained tuple. It cannot reset an accepted heartbeat or window.
 */
export function initializeNanoHostRecoveryLease(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  liveness: NanoHostWorkerRecoveryState
): void {
  assertControlProductWriter(sqlite);
  const native = readNanoHostWorkerLease({ sqlite }, lease.grant, lease.attempt);
  const state = NanoHostWorkerRecoveryState.parse(liveness);
  if (
    !native ||
    native.session.state !== 'launching' ||
    lease.attempt.phase !== 'open' ||
    state.recoveryState !== null ||
    state.recoveryDeadline !== null ||
    state.lastAcceptedHeartbeatAt !== null ||
    state.lastWorkerSequence !== null ||
    state.workerProcessKeyHash !== null ||
    state.physicalCleanup !== undefined ||
    state.heartbeatDeadline !== state.startupDeadline
  )
    throw new Error('NanoHost recovery initialization lacks its first granted placement.');
  const json = canonicalJsonText(state);
  const written = sqlite
    .prepare(`UPDATE worker_backend_sessions SET worker_recovery_json = ?
    WHERE attempt_id = ? AND worker_recovery_json IS NULL`)
    .run(json, lease.grant.attemptId);
  if (
    written.changes === 0 &&
    !isDeepStrictEqual(readNanoHostRecoveryLease(sqlite, lease).proof, state)
  )
    throw new Error('NanoHost recovery initialization already advanced.');
}

/** Call only after the original Core decision. The admitted Native writer rechecks all local facts. */
export function applyNanoHostRecoveryMutation(
  sqlite: Database.Database,
  input: NanoHostRecoveryMutation
): WorkerBackendSessionRecord {
  assertControlProductWriter(sqlite);
  const observedAt = clock.parse(input.observedAt);
  const { session, proof, attempt } = readNanoHostRecoveryLease(sqlite, input.lease);
  if (
    !isDeepStrictEqual(session, input.expectedSession) ||
    !isDeepStrictEqual(proof, input.expectedRecovery)
  )
    throw new Error('NanoHost recovery ownership changed.');
  const owner = { sqlite };
  const key = { attemptId: session.attemptId, now: () => observedAt };
  if (input.kind === 'finish-cleanup' || input.kind === 'retire-orphan') {
    if (
      attempt.phase === 'open' ||
      session.state !== 'physical-cleaned' ||
      (input.kind === 'retire-orphan' && attempt.phase !== 'closed')
    )
      throw new Error('NanoHost recovery has no completed physical cleanup.');
    if (session.workspaceHandoffState !== 'complete')
      throw new Error('NanoHost recovery Workspace handoff is incomplete.');
    const target = getNanoHostRuntimeTarget(owner, session.runtimeTargetId);
    if (!target || !readNanoHostPhysicalCleanupReceipt(sqlite, input.lease, target))
      throw new Error('NanoHost recovery physical cleanup receipt is unavailable.');
    return transitionWorkerBackendSessionState(owner, {
      ...key,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
    });
  }
  if (input.kind === 'transition') {
    const target = getNanoHostRuntimeTarget(owner, session.runtimeTargetId);
    if (
      !target ||
      !isDeepStrictEqual(target, input.target) ||
      !target.ready ||
      !target.freshEmpty ||
      !target.predecessorFenced ||
      !target.physicalEpoch ||
      target.deploymentId !== session.deploymentId ||
      attempt.phase === 'open'
    )
      throw new Error('NanoHost recovery placement changed.');
    return sqlite.transaction(() => {
      const changed = transitionWorkerBackendSessionState(owner, {
        ...key,
        fromState: session.state,
        toState: input.toState,
      });
      if (input.toState === 'physical-cleaned') {
        writeRecovery(sqlite, session, proof, {
          ...proof,
          physicalCleanup: {
            observedAt,
            connectionGeneration: target.connectionGeneration,
            physicalEpoch: target.physicalEpoch!,
          },
        });
      }
      return changed;
    })();
  }
  if (input.kind === 'workspace-handoff') {
    if (attempt.phase === 'open' || !session.physicalCleanedAt)
      throw new Error('NanoHost recovery handoff has no physical result.');
    return markWorkerBackendWorkspaceHandoffComplete(owner, key);
  }
  if (input.kind === 'needs-evidence') {
    if (attempt.phase !== 'closing') throw new Error('NanoHost recovery attempt is not closing.');
    writeRecovery(sqlite, session, proof, { ...proof, recoveryState: 'needs-evidence' });
    return session;
  }
  if (input.kind !== 'arm-reconnect') throw new Error('Unknown NanoHost recovery stage.');
  const classifiedAt = clock.parse(input.classifiedAt);
  const recoveryDeadline =
    proof.recoveryDeadline ??
    new Date(
      Math.min(Date.parse(input.lease.grant.deadline), Date.parse(classifiedAt) + 300_000)
    ).toISOString();
  if (
    attempt.phase !== 'open' ||
    session.state !== 'launching' ||
    session.workspaceHandoffState !== 'complete' ||
    proof.lastWorkerSequence === null ||
    proof.lastWorkerSequence < 1 ||
    proof.workerProcessKeyHash === null ||
    proof.recoveryState === 'needs-evidence' ||
    recoveryDeadline > input.lease.grant.deadline ||
    recoveryDeadline <= observedAt
  )
    throw new Error('NanoHost reconnect authority changed.');
  writeRecovery(sqlite, session, proof, {
    ...proof,
    recoveryState: 'awaiting-reconnect',
    recoveryDeadline,
  });
  return session;
}

/** Called inside the accepted Native heartbeat transaction after its original sequence decision. */
export function recordNanoHostRecoveryHeartbeat(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  input: {
    readonly sequence: number;
    readonly acceptedAt: string;
    readonly processKeyHash?: string;
    readonly reconnectProcessKeyHash?: string;
  }
): void {
  assertControlProductWriter(sqlite);
  const { attempt, proof, session } = readNanoHostRecoveryLease(sqlite, lease);
  const acceptedAt = clock.parse(input.acceptedAt);
  if (
    attempt.phase !== 'open' ||
    session.state !== 'launching' ||
    acceptedAt >= lease.grant.deadline ||
    (proof.lastAcceptedHeartbeatAt !== null && acceptedAt < proof.lastAcceptedHeartbeatAt) ||
    (proof.lastWorkerSequence !== null && input.sequence <= proof.lastWorkerSequence) ||
    (input.processKeyHash !== undefined &&
      (input.sequence !== 0 || proof.workerProcessKeyHash !== null))
  )
    throw new Error('NanoHost heartbeat liveness changed.');

  if (proof.recoveryState === 'awaiting-reconnect') {
    const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
    const presented = Buffer.from(input.reconnectProcessKeyHash ?? '');
    const retained = Buffer.from(proof.workerProcessKeyHash ?? '');
    if (
      !proof.recoveryDeadline ||
      proof.recoveryDeadline <= acceptedAt ||
      proof.lastWorkerSequence === null ||
      input.sequence !== proof.lastWorkerSequence + 1 ||
      presented.length !== 43 ||
      retained.length !== 43 ||
      !timingSafeEqual(presented, retained) ||
      session.workspaceHandoffState !== 'complete' ||
      !target ||
      !target.ready ||
      !target.freshEmpty ||
      !target.predecessorFenced ||
      target.deploymentId !== session.deploymentId ||
      target.physicalEpoch !== session.originPhysicalEpoch
    )
      throw new Error('NanoHost heartbeat has no exact reconnect authority.');
  } else if (
    proof.recoveryState !== null ||
    input.reconnectProcessKeyHash !== undefined ||
    acceptedAt >= proof.heartbeatDeadline
  ) {
    throw new Error('NanoHost heartbeat liveness changed.');
  }

  writeRecovery(
    sqlite,
    session,
    proof,
    NanoHostWorkerRecoveryState.parse({
      ...proof,
      heartbeatDeadline: new Date(Date.parse(acceptedAt) + proof.heartbeatTimeoutMs).toISOString(),
      lastAcceptedHeartbeatAt: acceptedAt,
      lastWorkerSequence: input.sequence,
      workerProcessKeyHash: input.processKeyHash ?? proof.workerProcessKeyHash,
      recoveryState: null,
      recoveryDeadline: null,
    })
  );
}

function writeRecovery(
  sqlite: Database.Database,
  session: WorkerBackendSessionRecord,
  expected: NanoHostWorkerRecoveryState,
  next: NanoHostWorkerRecoveryState
) {
  const changed = sqlite
    .prepare(`UPDATE worker_backend_sessions SET worker_recovery_json = ?
    WHERE attempt_id = ? AND worker_recovery_json = ?`)
    .run(canonicalJsonText(next), session.attemptId, canonicalJsonText(expected));
  if (changed.changes !== 1) throw new Error('NanoHost recovery liveness changed.');
}
