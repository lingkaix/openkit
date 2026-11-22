import { createHash, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NanoHostAttemptTokenBindingResolution } from '../runtime/nanohost-attempt-records.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import {
  getWorkerBackendSessionByPackage,
  readNanoHostWorkerRouteBinding,
} from '../runtime/worker-backend-session-records.js';
import type {
  WorkerControlFinalStatusTokenBindingResolution,
  WorkerControlLineage,
  WorkerControlTokenBindingInput,
} from '../runtime/worker-control-gateway.js';
import {
  getWorkerControlAcceptedFinalStatus,
  hasPendingWorkerCancellationFinal,
} from '../runtime/worker-control-records.js';
import type { CoreDb } from './db.js';
import { hasAcknowledgedNanoHostClosedPlacement } from './nanohost-epoch-invalidation-native.js';
import { readNanoHostRecoveryLease } from './nanohost-recovery-native.js';
import {
  type NanoHostWorkerCoordinates,
  readRetainedNanoHostSubmission,
} from './nanohost-submitted-lease.js';

type Binding = Pick<WorkerControlTokenBindingInput, 'sandboxBindingRef' | 'lineage'> & {
  readonly tokenHash?: string;
  readonly tokenFamily?: WorkerControlTokenBindingInput['tokenFamily'];
};

export function nanoHostWorkerLineage(original: NanoHostWorkerCoordinates): WorkerControlLineage {
  const { workspaceId, threadId, turnId, agentSessionId, inputRef } = original.lease.attempt;
  return {
    workspaceId,
    threadId,
    turnId,
    agentSessionId,
    packageSnapshotId: inputRef,
    requestId: original.requestId,
  };
}

export function matchesNanoHostWorkerLineage(
  original: NanoHostWorkerCoordinates,
  actual: WorkerControlLineage
): boolean {
  const expected = nanoHostWorkerLineage(original);
  return (
    expected.workspaceId === actual.workspaceId &&
    expected.threadId === actual.threadId &&
    expected.turnId === actual.turnId &&
    expected.agentSessionId === actual.agentSessionId &&
    expected.packageSnapshotId === actual.packageSnapshotId &&
    expected.requestId === (actual.requestId ?? null)
  );
}

/** Shared read-only binding validation for App, hydration and the Native writers. */
export function inspectNanoHostWorkerBinding(
  sqlite: Database.Database,
  original: NanoHostWorkerCoordinates,
  input: Binding
) {
  if (input.sandboxBindingRef !== original.lease.grant.bindingRef)
    return { status: 'rejected', reason: 'binding-not-found' } as const;
  if (!matchesNanoHostWorkerLineage(original, input.lineage))
    return { status: 'rejected', reason: 'lineage-mismatch' } as const;
  const native = readNanoHostRecoveryLease(sqlite, original.lease);
  if (input.tokenHash !== undefined) {
    const { attempt } = native;
    const hash =
      input.tokenFamily === 'capability'
        ? attempt.workerCapabilityTokenHash
        : input.tokenFamily === 'inference'
          ? attempt.workerInferenceTokenHash
          : attempt.workerControlTokenHash;
    if (
      !hash ||
      !/^[0-9a-f]{64}$/.test(input.tokenHash) ||
      !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(input.tokenHash, 'hex'))
    )
      return { status: 'rejected', reason: 'binding-not-found' } as const;
  }
  const { session } = native;
  const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
  const currentPlacement =
    session.state === 'launching' &&
    session.physicalCleanedAt === null &&
    session.workspaceHandoffState === 'complete' &&
    !!target?.ready &&
    target.freshEmpty &&
    target.predecessorFenced &&
    target.deploymentId === session.deploymentId &&
    target.physicalEpoch === session.originPhysicalEpoch;
  return {
    status: 'accepted',
    ...native,
    currentPlacement,
    target,
    submissionGeneration: original.lease.grant.generation,
  } as const;
}

export function nanoHostWorkerBindingLiveness(
  native: Extract<ReturnType<typeof inspectNanoHostWorkerBinding>, { status: 'accepted' }>,
  now: string
) {
  if (
    !native.currentPlacement ||
    native.attempt.phase !== 'open' ||
    !native.attempt.deadline ||
    native.attempt.deadline <= now
  )
    return { status: 'rejected', reason: 'attempt-not-live' } as const;
  const { proof } = native;
  if (
    proof.recoveryState === 'awaiting-reconnect' &&
    proof.recoveryDeadline &&
    proof.recoveryDeadline > now
  )
    return { status: 'rejected', reason: 'reconnect-required' } as const;
  if (proof.recoveryState || proof.heartbeatDeadline <= now)
    return { status: 'rejected', reason: 'attempt-not-live' } as const;
  return { status: 'accepted', attempt: native.attempt } as const;
}

/** Checks first-final record authority without re-admitting the closed placement for effects. */
export function nanoHostWorkerCancellationFinalEligible(
  sqlite: Database.Database,
  native: Extract<ReturnType<typeof inspectNanoHostWorkerBinding>, { status: 'accepted' }>,
  now: string
): boolean {
  if (!hasPendingWorkerCancellationFinal(native.attempt, now)) return false;
  if (native.currentPlacement) return true;
  const { session, target, submissionGeneration } = native;
  return (
    session.state === 'launching' &&
    session.physicalCleanedAt === null &&
    session.workspaceHandoffState === 'complete' &&
    hasAcknowledgedNanoHostClosedPlacement(sqlite, target, {
      deploymentId: session.deploymentId,
      runtimeTargetId: session.runtimeTargetId,
      physicalEpoch: session.originPhysicalEpoch,
      generation: submissionGeneration,
    })
  );
}

export function resolveAdmittedNanoHostWorkerBinding(
  coreDb: CoreDb,
  sqlite: Database.Database,
  input: WorkerControlTokenBindingInput,
  now = new Date().toISOString()
): NanoHostAttemptTokenBindingResolution {
  const native = readBinding(coreDb, sqlite, input);
  return native.status === 'rejected' ? native : nanoHostWorkerBindingLiveness(native, now);
}

export function resolveAdmittedNanoHostFinalBinding(
  coreDb: CoreDb,
  sqlite: Database.Database,
  input: WorkerControlTokenBindingInput,
  now = new Date().toISOString()
): WorkerControlFinalStatusTokenBindingResolution {
  return sqlite
    .transaction((): WorkerControlFinalStatusTokenBindingResolution => {
      const native = readBinding(coreDb, sqlite, input);
      if (native.status === 'rejected') return native;
      const live = nanoHostWorkerBindingLiveness(native, now);
      if (!native.attempt.deadline || native.attempt.deadline <= now)
        return { status: 'rejected', reason: 'attempt-not-live' };
      if (getWorkerControlAcceptedFinalStatus({ sqlite }, input.lineage))
        return { status: 'accepted', replayOnly: true };
      if (live.status === 'accepted') return { status: 'accepted', replayOnly: false };
      // A Core decision can precede Native final acceptance across a lost acknowledgement.
      // Only the deciding writer may supply that exact semantic receipt.
      if (
        native.currentPlacement &&
        native.attempt.phase === 'closing' &&
        native.attempt.terminalCause === 'worker-final-status' &&
        native.attempt.fenceRef === null &&
        native.proof.recoveryState === null &&
        native.proof.heartbeatDeadline > now
      )
        return { status: 'accepted', replayOnly: false };
      if (nanoHostWorkerCancellationFinalEligible(sqlite, native, now))
        return { status: 'accepted', replayOnly: false, cancellationOnly: true };
      return live;
    })
    .deferred();
}

/** Resolves the only Native session named by the requested package and its pinned Core grant. */
export function readOriginalNanoHostWorkerCoordinates(
  coreDb: CoreDb,
  sqlite: Database.Database,
  input: Pick<Binding, 'sandboxBindingRef' | 'lineage'>
): NanoHostWorkerCoordinates | null {
  const session = getWorkerBackendSessionByPackage({ sqlite }, input.lineage.packageSnapshotId);
  if (!session || session.sandboxBindingRef !== input.sandboxBindingRef) return null;
  const original = readRetainedNanoHostSubmission(coreDb, session.attemptId);
  return original && readNanoHostWorkerRouteBinding({ sqlite }, original.lease.grant)
    ? original
    : null;
}

function readBinding(
  coreDb: CoreDb,
  sqlite: Database.Database,
  input: WorkerControlTokenBindingInput
) {
  const original = readOriginalNanoHostWorkerCoordinates(coreDb, sqlite, input);
  if (!original || (input.token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(input.token)))
    return { status: 'rejected', reason: 'binding-not-found' } as const;
  return inspectNanoHostWorkerBinding(sqlite, original, {
    lineage: input.lineage,
    sandboxBindingRef: input.sandboxBindingRef,
    tokenFamily: input.tokenFamily,
    ...(input.token === undefined
      ? {}
      : {
          tokenHash: createHash('sha256')
            .update(Buffer.from(input.token, 'base64url'))
            .digest('hex'),
        }),
  });
}
