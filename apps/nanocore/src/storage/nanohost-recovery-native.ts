import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJsonText, readRetainedV1 } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { readSandboxReleaseRefusalOrder } from '../runtime/core-journal-records.js';
import {
  NANO_HOST_HEARTBEAT_BUDGET_MS,
  nanoHostStartupDeadline,
} from '../runtime/nanohost-attempt-clocks.js';
import type { NanoHostExecutionAttemptRecord } from '../runtime/nanohost-attempt-records.js';
import { drainNanoHostSandboxAdmission } from '../runtime/nanohost-harness-records.js';
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
import {
  assertControlProductWriter,
  ControlProductPreconditionError,
} from './control-store-product-records.js';
import type { CoreDb } from './db.js';

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

/** Reads the original receipt under the current target pin. Historical carriage also needs the Core submit proof. */
export function readNanoHostPhysicalCleanupReceipt(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease,
  expectedTarget: NanoHostRuntimeTargetRecord,
  verifyOriginalPlacement?: (session: WorkerBackendSessionRecord) => boolean
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
    !isDeepStrictEqual(target, expectedTarget)
  )
    return null;
  if (verifyOriginalPlacement) {
    const generation = Number(lease.grant.generation);
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      String(generation) !== lease.grant.generation ||
      !target.physicalEpoch ||
      generation > receipt.connectionGeneration ||
      receipt.connectionGeneration > target.connectionGeneration ||
      (generation === receipt.connectionGeneration &&
        receipt.physicalEpoch !== session.originPhysicalEpoch) ||
      (receipt.connectionGeneration === target.connectionGeneration &&
        receipt.physicalEpoch !== target.physicalEpoch) ||
      !verifyOriginalPlacement(session)
    )
      return null;
  } else if (
    receipt.connectionGeneration !== target.connectionGeneration ||
    receipt.physicalEpoch !== target.physicalEpoch
  )
    return null;
  return { grant: lease.grant, session, target, observedAt: receipt.observedAt };
}

/** Proves the original Integration is drained and the exact historical route grant is revoked. */
export function verifyNanoHostTerminalDrainAndRevocation(
  sqlite: Database.Database,
  lease: NanoHostRecoveryLease
): boolean {
  const { attempt, grant } = lease;
  if (
    attempt.phase !== 'closed' ||
    attempt.disposition !== 'accepted' ||
    !attempt.fenceRef ||
    attempt.attemptId !== grant.attemptId ||
    attempt.turnId !== grant.turnId ||
    attempt.backendId !== grant.backendId ||
    attempt.operationId !== grant.operationId ||
    attempt.inputRef !== grant.inputRef ||
    attempt.bindingRef !== grant.bindingRef ||
    attempt.deadline !== grant.deadline
  )
    return false;
  const native = readNanoHostWorkerLease({ sqlite }, grant, attempt);
  if (
    !native ||
    native.session.state !== 'cleaned' ||
    native.session.workspaceHandoffState !== 'complete' ||
    !native.session.physicalCleanedAt ||
    attempt.fenceRef !== `worker-backend:${attempt.attemptId}:${native.session.physicalCleanedAt}`
  )
    return false;

  // Historical route hashes remain evidence. Live route authorization requires the current open
  // Core phase and launching Native placement, both revoked for this exact retained tuple.
  if (
    sqlite
      .prepare(`SELECT 1 FROM agent_session_runtime_bindings
        WHERE current_attempt_id = ? OR current_turn_id = ? LIMIT 1`)
      .get(attempt.attemptId, attempt.turnId) ||
    sqlite
      .prepare(`SELECT 1 FROM harness_instance_records WHERE harness_instance_id = ?
        AND operation_id = ? AND operation_state IN ('queued', 'dispatched', 'unknown')`)
      .get(native.binding.harnessInstanceId, native.binding.harnessOperationId)
  )
    return false;
  const resident = sqlite
    .prepare(`SELECT b.schema_version AS bindingVersion, h.schema_version AS harnessVersion,
      (b.workspace_id = @workspaceId AND b.thread_id = @threadId AND
       b.harness_instance_id = @harnessInstanceId AND
       b.current_turn_id IS NULL AND b.current_attempt_id IS NULL AND
       b.lifecycle_state IN ('open', 'closed') AND b.cleanup_state = 'clean' AND
       h.lifecycle_state = 'open' AND h.drain_state = 'accepting' AND
       s.runtime_target_id = @targetId AND s.origin_physical_epoch = @physicalEpoch AND
       s.lifecycle_state = 'open' AND s.health_state = 'ready' AND
       s.drain_state = 'accepting' AND s.cleanup_state = 'clean') AS clean
      FROM agent_session_runtime_bindings b
      LEFT JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
      LEFT JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
      WHERE b.agent_session_id = @agentSessionId`)
    .get({
      workspaceId: attempt.workspaceId,
      threadId: attempt.threadId,
      agentSessionId: attempt.agentSessionId,
      harnessInstanceId: native.binding.harnessInstanceId,
      targetId: native.session.runtimeTargetId,
      physicalEpoch: native.session.originPhysicalEpoch,
    }) as { bindingVersion: unknown; harnessVersion: unknown; clean: number | null } | undefined;
  if (!resident) return true;
  if (resident.clean !== 1) return false;
  return readRetainedV1({ schemaVersion: resident.bindingVersion }, () =>
    readRetainedV1({ schemaVersion: resident.harnessVersion }, () => true)
  );
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
  input: NanoHostRecoveryMutation,
  verifyOriginalPlacement?: (session: WorkerBackendSessionRecord) => boolean
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
    if (
      !target ||
      !readNanoHostPhysicalCleanupReceipt(sqlite, input.lease, target, verifyOriginalPlacement)
    )
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

/** Finishes the exact Core order inside the Native writer. The parent alone is not proof. */
export function applySandboxReleaseRefusalDrain(
  owner: { readonly sqlite: Database.Database },
  core: CoreDb,
  executionId: string
): void {
  assertControlProductWriter(owner.sqlite);
  owner.sqlite
    .transaction(() => {
      const refuse = (): never => {
        throw new ControlProductPreconditionError();
      };
      const order = readSandboxReleaseRefusalOrder(core, executionId) ?? refuse();
      const target = getNanoHostRuntimeTarget(owner, order.targetId);
      if (
        !target?.ready ||
        !target.predecessorFenced ||
        !target.freshEmpty ||
        target.physicalEpoch !== order.physicalEpoch
      )
        refuse();
      const parent = owner.sqlite.prepare(`SELECT lifecycle_state AS lifecycle,
      health_state AS health, drain_state AS drain, cleanup_state AS cleanup
      FROM sandbox_runtime_records WHERE sandbox_runtime_id=? AND sandbox_binding_ref=?
        AND runtime_target_id=? AND origin_physical_epoch=?`);
      const read = () =>
        parent.get(order.runtimeId, order.bindingRef, order.targetId, order.physicalEpoch) as
          | { lifecycle: string; health: string; drain: string; cleanup: string }
          | undefined;
      const resident = read();
      if (
        !resident ||
        resident.lifecycle !== 'open' ||
        resident.health !== 'ready' ||
        resident.cleanup !== 'clean'
      )
        refuse();
      const incomplete = () =>
        owner.sqlite
          .prepare(`SELECT 1 FROM harness_instance_records
      WHERE sandbox_runtime_id=? AND (lifecycle_state <> 'failed' OR drain_state <> 'draining')
      LIMIT 1`)
          .get(order.runtimeId) !== undefined;
      if (resident?.drain === 'draining' && !incomplete()) return;
      drainNanoHostSandboxAdmission(owner, {
        sandboxBindingRef: order.bindingRef,
        originPhysicalEpoch: order.physicalEpoch,
      });
      if (read()?.drain !== 'draining' || incomplete()) refuse();
    })
    .immediate();
}
