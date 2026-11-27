import { isDeepStrictEqual } from 'node:util';
import { findNamedAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import type { SchedulerExecutionAttemptRecord } from '../runtime/execution-attempt-records.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import {
  createNanoHostCleanupContinuation,
  type NanoHostClaimedCleanupResult,
  type NanoHostCleanupCarriage,
  type NanoHostCleanupClaim,
  NanoHostCleanupFinalWon,
  type NanoHostUndispatchedCleanupClaim,
} from '../runtime/nanohost-cleanup-continuation.js';
import { readNanoHostReadyBindingCleanup } from '../runtime/nanohost-harness-records.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import type { WorkerBackendSessionRecord } from '../runtime/worker-backend-session-records.js';
import type { WorkerGovernanceBackendSessionIdentity } from '../runtime/worker-governance-backend.js';
import { commandInputHash } from '../storage/control-store-input.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { NanoHostOwnerBinding } from '../storage/control-store-worker-client.js';
import { hashNanoHostRecoveryObservation } from '../storage/control-store-worker-protocol.js';
import type { ControlNanoHostOrphanRetirementInput } from '../storage/core-journal-codecs.js';
import {
  inspectAcceptedNanoHostFinalInDb,
  inspectCoreNanoHostOrphanAudit,
  type NanoHostAcceptedFinalCommitment,
  type NanoHostFinalCloseDecision,
  readNanoHostFinalCloseDecision,
  verifyNanoHostCleanupSubmitPlacement,
} from '../storage/core-journal-native.js';
import { type CoreDb, openAdmittedWorkspaceReadDb } from '../storage/db.js';
import {
  hasExclusiveNanoHostCleanupOnly,
  type NanoHostCleanupOccurrence,
  type NanoHostPhysicalCleanupReceipt,
  type NanoHostRecoveryMutation,
  NanoHostRecoveryRefusal,
  prepareNanoHostCleanupOccurrence,
  readNanoHostCleanupOnly,
  readNanoHostInitialImageDecision,
  readNanoHostOrphanCleanup,
  readNanoHostPhysicalCleanupReceipt,
  readNanoHostPreparationOccurrence,
  readNanoHostRecoveryLease,
} from '../storage/nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from '../storage/nanohost-submitted-lease.js';
import type { StorageResult } from '../storage/storage-owner.js';

/** The existing restart closeout owner. Its guarded read rechecks the same commitment. */
export interface BootNanoHostAcceptedFinalCloseout {
  readonly coreDb: CoreDb;
  readonly reconcileAcceptedFinalStatus: (
    session: WorkerBackendSessionRecord,
    commitment: NanoHostAcceptedFinalCommitment,
    undispatchedClaim?: NanoHostUndispatchedCleanupClaim
  ) => Promise<unknown>;
}

type RecoveryWriteResult = Awaited<ReturnType<AdmittedNanoHostAttemptRecovery['commit']>>;
type PhysicalTransition = Extract<NanoHostRecoveryMutation, { kind: 'transition' }>;
type OrphanRetirement = Extract<NanoHostRecoveryMutation, { kind: 'retire-orphan' }>;
type OrphanAudit = NonNullable<ReturnType<typeof inspectCoreNanoHostOrphanAudit>>;

/** Application-owned ports to the configured transport and admitted Core and Native writers. */
export interface BootNanoHostCleanupOwners {
  readonly isTurnExecutionActive: (turnId: string) => boolean;
  readonly cleanupClaimedBackendSession: (
    identity: WorkerGovernanceBackendSessionIdentity,
    carriage: NanoHostCleanupCarriage
  ) => Promise<NanoHostClaimedCleanupResult>;
  readonly restoreClaimedCleanupResult: (
    session: WorkerBackendSessionRecord,
    occurrence: NanoHostCleanupOccurrence,
    accept: (proof: Extract<NanoHostClaimedCleanupResult, { kind: 'deleted' }>) => Promise<void>,
    observeUnknown?: () => Promise<void>
  ) => Promise<void>;
  readonly inspectIdleCleanup: (
    identity: WorkerGovernanceBackendSessionIdentity
  ) => Promise<Exclude<NanoHostClaimedCleanupResult, { kind: 'deleted' }> | null>;
  readonly commitPhysicalTransition: (
    input: PhysicalTransition,
    authorize?: () => boolean
  ) => Promise<RecoveryWriteResult>;
  readonly commitOrphanAudit: (input: ControlNanoHostOrphanRetirementInput) => Promise<void>;
  readonly commitOrphanRetirement: (
    input: OrphanRetirement,
    audit: OrphanAudit
  ) => Promise<RecoveryWriteResult>;
}

/** The original close authority and pre-claim Native observation. */
export interface BootNanoHostCleanupRequest
  extends Omit<NanoHostCleanupClaim, 'firstCommand' | 'deleteRequestId'> {
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  /** Closed orphan cleanup has no final-publication decision. */
  readonly finalDecision: NanoHostFinalCloseDecision | null;
  readonly now: () => string;
}

/** The first command selected by the physical owner before the claim is posted. */
export interface BootNanoHostFirstCleanup extends BootNanoHostCleanupRequest {
  readonly firstOperation: NanoHostCleanupOccurrence['firstOperation'];
  /** Runs in the writer's existing posting hold against the original close decision. */
  readonly authorize: () => boolean;
}

type BootCleanupResult = StorageResult<
  'nanohost' | 'control-kernel',
  NanoHostPhysicalCleanupReceipt | 'delegated-final'
>;

/** Adds the claim-winner entry without granting old readers dispatch authority on a pending row. */
export interface BootNanoHostRecovery extends AdmittedNanoHostAttemptRecovery {
  /** Posts a new claim and owns its sole live continuation after the FULL ACK. */
  claimCleanup(request: BootNanoHostFirstCleanup): Promise<BootCleanupResult>;
  /** Registers a retained result receiver during Boot and returns its post-listen continuation. */
  restoreClaimResult(lease: NanoHostCleanupClaim['lease'], now: () => string): Promise<void>;
  /** Registers an original cleanup-only result without constructing a Worker submission. */
  restorePreparationResult(
    attempt: SchedulerExecutionAttemptRecord,
    now: () => string
  ): Promise<void>;
  /** Settles an unresolved original claim by authenticated absence on a later fresh Epoch. */
  settleClaimAbsence(
    claim: Omit<BootNanoHostCleanupRequest, 'finalDecision'>
  ): Promise<BootCleanupResult>;
  /** Reads the existing idle result and settles its original claim without entering the dispatcher. */
  settleIdleClaimResult(
    claim: Omit<BootNanoHostCleanupRequest, 'finalDecision'>
  ): Promise<BootCleanupResult>;
}

/** A live or maintenance preparation joins this same original admitted cleanup entry. */
export async function cleanupNanoHostPreparation(
  coreDb: CoreDb,
  owner: Pick<NanoHostOwnerBinding, 'read' | 'readWorkerCompletion' | 'commitCleanupOnly'>,
  attempt: SchedulerExecutionAttemptRecord,
  selectOperation: (
    identity: WorkerGovernanceBackendSessionIdentity
  ) => NanoHostCleanupOccurrence['firstOperation'],
  dispatch: BootNanoHostCleanupOwners['cleanupClaimedBackendSession'],
  authorize: () => boolean,
  now: () => string,
  finish = false,
  readyBinding?: true
): Promise<WorkerBackendSessionRecord> {
  const observe = () => {
    const read = owner.readWorkerCompletion((sqlite) => {
      const actual = requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
      const original = readNanoHostCleanupOnly(sqlite, actual);
      const target =
        original && getNanoHostRuntimeTarget({ sqlite }, original.session.runtimeTargetId);
      if (
        !original ||
        !target ||
        !target.ready ||
        !target.freshEmpty ||
        !target.predecessorFenced ||
        !target.physicalEpoch ||
        !isDeepStrictEqual(actual, attempt) ||
        coreDb.sqlite
          .prepare(`SELECT 1 FROM scheduler_execution_attempts
          WHERE attempt_id<>? AND phase<>'closed' AND
            (turn_id=? OR agent_session_id=? OR binding_ref=?) LIMIT 1`)
          .get(attempt.attemptId, attempt.turnId, attempt.agentSessionId, attempt.bindingRef) ||
        (!readyBinding && !hasExclusiveNanoHostCleanupOnly(sqlite, original.session))
      )
        throw new ControlProductPreconditionError();
      if (readyBinding) {
        const workspace = openAdmittedWorkspaceReadDb(coreDb.dataRoot, actual.workspaceId);
        try {
          const pkg = findNamedAgentEnvironmentPackageSnapshot(
            workspace,
            actual.workspaceId,
            original.session.agentSessionId,
            original.session.packageSnapshotId
          );
          if (
            !pkg ||
            !readNanoHostReadyBindingCleanup(
              coreDb,
              sqlite,
              workspace,
              pkg.snapshot,
              actual,
              original,
              target
            )
          )
            throw new ControlProductPreconditionError();
        } finally {
          workspace.sqlite.close();
        }
      }
      return { ...original, target };
    });
    if (read.state !== 'ready') throw new ControlProductPreconditionError();
    return read.value;
  };
  const post = (
    before: ReturnType<typeof observe>,
    classification: Parameters<NanoHostOwnerBinding['commitCleanupOnly']>[0]['classification'],
    observedAt = now()
  ) =>
    owner.commitCleanupOnly(
      {
        attemptId: attempt.attemptId,
        observationHash: commandInputHash({
          attempt,
          session: before.session,
          proof: before.proof,
        }),
        target: before.target,
        ...(readyBinding ? { readyBinding } : {}),
        observedAt,
        classification,
      },
      authorize
    );
  const initial = observe();
  if (initial.proof?.physicalCleanup) {
    if (initial.proof.physicalCleanup.observedAt !== initial.session.physicalCleanedAt)
      throw new ControlProductPreconditionError();
    if (!finish || initial.session.state === 'cleaned') return initial.session;
    const acknowledged = await post(initial, { kind: 'finish' });
    if (acknowledged.state !== 'ready' || acknowledged.value.state !== 'cleaned')
      throw new ControlProductPreconditionError();
    return acknowledged.value;
  }
  if (finish) throw new ControlProductPreconditionError();
  if (!readyBinding && attempt.operationId !== null && attempt.deadline === null) {
    const workspace = openAdmittedWorkspaceReadDb(coreDb.dataRoot, initial.session.workspaceId);
    const observedAt = now();
    let occurrence: ReturnType<typeof readNanoHostPreparationOccurrence>;
    let decision: ReturnType<typeof readNanoHostInitialImageDecision>;
    try {
      const pkg = findNamedAgentEnvironmentPackageSnapshot(
        workspace,
        workspace.workspaceId,
        initial.session.agentSessionId,
        initial.session.packageSnapshotId
      )?.snapshot;
      if (!pkg) throw new ControlProductPreconditionError();
      const preparation = owner.readWorkerCompletion((sqlite) =>
        readNanoHostPreparationOccurrence(
          workspace,
          sqlite,
          pkg,
          attempt,
          initial.session,
          initial.target,
          initial
        )
      );
      if (preparation.state !== 'ready' || !preparation.value)
        throw new ControlProductPreconditionError();
      occurrence = preparation.value;
      if (occurrence === 'image')
        decision = readNanoHostInitialImageDecision(
          workspace,
          pkg,
          attempt,
          initial.session,
          initial.target,
          observedAt
        );
    } finally {
      workspace.sqlite.close();
    }
    if (occurrence === 'image') {
      if (decision === 'unknown-hold') throw new NanoHostRecoveryRefusal('image-outcome-unknown');
      if (!decision) throw new ControlProductPreconditionError();
      await post(initial, { kind: 'image', decision }, observedAt).catch(() => null);
      const retained = observe();
      if (
        retained.session.state !== 'physical-cleaned' ||
        retained.proof?.imageDecision !== decision ||
        retained.proof.physicalCleanup?.observedAt !== observedAt
      )
        throw new ControlProductPreconditionError();
      return retained.session;
    }
  }
  const identity = cleanupIdentity(initial.session);
  let before = initial;
  const canClaim = ['materializing', 'materialized'].includes(initial.session.state);
  const occurrence = canClaim
    ? prepareNanoHostCleanupOccurrence(initial.session, initial.target, selectOperation(identity))
    : initial.proof?.occurrence;
  if (canClaim) {
    if (!occurrence) throw new ControlProductPreconditionError();
    const ack = await post(initial, { kind: 'claim', occurrence });
    if (ack.state !== 'ready') throw new ControlProductPreconditionError();
    before = observe();
    if (
      !isDeepStrictEqual(before.session, ack.value) ||
      !isDeepStrictEqual(before.proof?.occurrence, occurrence)
    )
      throw new ControlProductPreconditionError();
  } else if (initial.target.physicalEpoch === initial.session.originPhysicalEpoch) {
    // A reopened same-Epoch claim can only settle its retained result, never issue a new command.
    throw new ControlProductPreconditionError();
  }
  const continuation =
    canClaim && occurrence
      ? createNanoHostCleanupContinuation(owner, {
          firstCommand: { kind: occurrence.firstOperation, requestId: occurrence.firstRequestId },
          deleteRequestId: occurrence.deleteRequestId,
        })
      : null;
  const assertCurrent = () => {
    if (!authorize() || !isDeepStrictEqual(observe(), before))
      throw new ControlProductPreconditionError();
  };
  let result: NanoHostClaimedCleanupResult;
  try {
    assertCurrent();
    result = await dispatch(identity, {
      target: before.target,
      assertCurrent,
      cleanupOnly: true,
      captureReadOnly: true,
      admit: (command) => {
        assertCurrent();
        if (!continuation) throw new ControlProductPreconditionError();
        continuation.admit(command);
      },
    });
    if (
      result.kind === 'idle-deleted' ||
      (result.kind === 'deleted' && !continuation?.admittedDelete(result.requestId))
    )
      throw new ControlProductPreconditionError();
  } catch (error) {
    if (canClaim && !(error instanceof ControlProductPreconditionError))
      await post(before, { kind: 'failed' }).catch(() => null);
    throw error;
  }
  const settledAt = now();
  await post(before, { kind: 'result', result }, settledAt).catch(() => null);
  const settled = observe();
  if (
    settled.session.state !== 'physical-cleaned' ||
    settled.proof?.physicalCleanup?.observedAt !== settledAt ||
    !isDeepStrictEqual(settled.proof.occurrence, before.proof?.occurrence ?? null)
  )
    throw new ControlProductPreconditionError();
  return settled.session;
}

/** Both live dispatch and recovered absence address the same original backend. */
function cleanupIdentity(
  session: WorkerBackendSessionRecord
): WorkerGovernanceBackendSessionIdentity {
  if (session.backendKind !== 'openshell') throw new ControlProductPreconditionError();
  return {
    agentSessionId: session.agentSessionId,
    backendKind: session.backendKind,
    backendSessionId: session.backendSessionId,
    deploymentId: session.deploymentId,
    packageSnapshotId: session.packageSnapshotId,
    runtimeTargetId: session.runtimeTargetId,
    stagingDirectoryRef: session.stagingDirectoryRef,
    transientProviderInstanceId: session.transientProviderInstanceId,
  };
}

/** Uses the same acknowledged owner that fenced the RuntimeTarget before serving. */
export function bindBootNanoHostAttemptRecovery(
  owner: NanoHostOwnerBinding,
  closeout: BootNanoHostAcceptedFinalCloseout,
  cleanupOwners?: BootNanoHostCleanupOwners
): BootNanoHostRecovery {
  const hold = { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' } as const;
  const { coreDb } = closeout;

  const settleCleanup = async (input: PhysicalTransition): Promise<BootCleanupResult> => {
    if (!cleanupOwners) return hold;
    const { target, expectedSession: session, expectedRecovery: proof } = input;
    const lease = readRetainedNanoHostSubmission(coreDb, input.lease.grant.attemptId)?.lease;
    if (
      !lease ||
      lease.attempt.phase === 'open' ||
      hashNanoHostRecoveryObservation({ lease, session, proof }) !==
        hashNanoHostRecoveryObservation({ lease: input.lease, session, proof })
    )
      return hold;
    // A late final can advance the Core attempt. It cannot replace this claim or its original result.
    const settled = await cleanupOwners
      .commitPhysicalTransition({ ...input, lease })
      .catch(() => null);
    const receipt = owner.read((sqlite) =>
      readNanoHostPhysicalCleanupReceipt(sqlite, lease, target, (original) =>
        verifyNanoHostCleanupSubmitPlacement(coreDb, sqlite, lease, original)
      )
    );
    if (
      receipt.state !== 'ready' ||
      !receipt.value ||
      !isDeepStrictEqual(cleanupIdentity(receipt.value.session), cleanupIdentity(session)) ||
      !isDeepStrictEqual(receipt.value.occurrence, proof.cleanupOccurrence ?? null) ||
      (settled?.state === 'ready' && !isDeepStrictEqual(settled.value, receipt.value.session))
    )
      return hold;
    return { state: 'ready', value: receipt.value };
  };

  const retireOrphan = async (input: OrphanRetirement): Promise<RecoveryWriteResult> => {
    if (!cleanupOwners || cleanupOwners.isTurnExecutionActive(input.lease.grant.turnId))
      return hold;
    const { lease, expectedSession: session, expectedRecovery: proof } = input;
    const read = owner.read((sqlite) =>
      readNanoHostOrphanCleanup(
        sqlite,
        input,
        hashNanoHostRecoveryObservation({ lease, session, proof }),
        (original) => verifyNanoHostCleanupSubmitPlacement(coreDb, sqlite, lease, original)
      )
    );
    if (read.state !== 'ready' || !read.value) return hold;
    const before = read.value;
    let audit = inspectCoreNanoHostOrphanAudit(coreDb, before);
    if (!audit) {
      // The original occurrence can already be durable when the Core ACK is lost.
      await cleanupOwners
        .commitOrphanAudit({ ...before, observedAt: input.observedAt })
        .catch(() => undefined);
      audit = inspectCoreNanoHostOrphanAudit(coreDb, before);
    }
    if (!audit) return hold;
    return cleanupOwners.commitOrphanRetirement({ ...input, observedAt: audit.acceptedAt }, audit);
  };

  return {
    owner,
    recoverUndeliveredSuccessor: owner.recoverUndeliveredSuccessor,
    close: owner.closeRecovery,
    commit: async (input, cleanup) => {
      if (input.kind === 'retire-orphan') return retireOrphan(input);
      return owner.classifyRecovery(input, cleanup);
    },
    reconcileFinal: async (lease, session) => {
      // K8b: one inspect-only join of the Native final pair with the original Core intake and receipt.
      const read = owner.read((sqlite) =>
        inspectAcceptedNanoHostFinalInDb(closeout.coreDb, sqlite, lease.grant.attemptId)
      );
      // Unavailable, missing, duplicate or contradictory proof holds with the recovery diagnostic.
      if (read.state !== 'ready' || read.value.state === 'held')
        throw new ControlProductPreconditionError();
      if (read.value.state === 'native-only') return read.value;
      await closeout.reconcileAcceptedFinalStatus(session, read.value);
      return 'closed';
    },
    cleanup: async () => hold,
    restorePreparationResult: async (attempt, now) => {
      if (!cleanupOwners) return;
      const read = owner.read((sqlite) => readNanoHostCleanupOnly(sqlite, attempt));
      if (read.state !== 'ready') throw new ControlProductPreconditionError();
      const original = read.value;
      const occurrence = original?.proof?.occurrence;
      if (
        !original ||
        !occurrence ||
        original.proof?.physicalCleanup ||
        !['cleanup-pending', 'cleanup-failed'].includes(original.session.state)
      )
        return;
      await cleanupOwners.restoreClaimedCleanupResult(
        original.session,
        occurrence,
        async (result) => {
          const target = owner.read((sqlite) =>
            getNanoHostRuntimeTarget({ sqlite }, original.session.runtimeTargetId)
          );
          if (target.state !== 'ready' || !target.value)
            throw new ControlProductPreconditionError();
          const observedAt = now();
          await owner
            .commitCleanupOnly(
              {
                attemptId: attempt.attemptId,
                observationHash: commandInputHash({ attempt, ...original }),
                target: target.value,
                ...(original.proof?.readyBindingProof ? { readyBinding: true as const } : {}),
                observedAt,
                classification: { kind: 'result', result },
              },
              () => !cleanupOwners.isTurnExecutionActive(attempt.turnId)
            )
            .catch(() => null);
          const receipt = owner.read((sqlite) => readNanoHostCleanupOnly(sqlite, attempt));
          if (
            receipt.state !== 'ready' ||
            !receipt.value ||
            receipt.value.session.state !== 'physical-cleaned' ||
            receipt.value.proof?.physicalCleanup?.observedAt !== observedAt ||
            !isDeepStrictEqual(receipt.value.proof.occurrence, occurrence)
          )
            throw new ControlProductPreconditionError();
        }
      );
    },
    settleIdleClaimResult: async ({ lease, session, proof, target, identity }) => {
      if (
        !cleanupOwners ||
        !isDeepStrictEqual(identity, cleanupIdentity(session)) ||
        lease.attempt.phase !== 'closed'
      )
        return hold;
      if (session.state === 'physical-cleaned' || session.state === 'cleaned') {
        const read = owner.read((sqlite) =>
          readNanoHostPhysicalCleanupReceipt(sqlite, lease, target, (original) =>
            verifyNanoHostCleanupSubmitPlacement(coreDb, sqlite, lease, original)
          )
        );
        return read.state === 'ready' &&
          read.value &&
          isDeepStrictEqual(read.value.session, session)
          ? { state: 'ready', value: read.value }
          : hold;
      }
      if (!['cleanup-pending', 'cleanup-failed'].includes(session.state)) return hold;
      const cleanupResult = await cleanupOwners.inspectIdleCleanup(identity);
      if (cleanupResult?.kind !== 'idle-deleted') return hold;
      return settleCleanup({
        kind: 'transition',
        toState: 'physical-cleaned',
        lease,
        expectedSession: session,
        expectedRecovery: proof,
        target,
        observedAt: cleanupResult.observedAt,
        cleanupResult,
      });
    },
    settleClaimAbsence: async ({ lease, session, proof, target, identity, now }) => {
      if (
        !cleanupOwners ||
        !proof.cleanupOccurrence ||
        (lease.attempt.phase === 'closing' && lease.attempt.fenceRef !== null) ||
        !isDeepStrictEqual(identity, cleanupIdentity(session)) ||
        target.physicalEpoch === session.originPhysicalEpoch ||
        (proof.cleanupUnknownAt !== undefined && target.observedAt <= proof.cleanupUnknownAt)
      )
        return hold;
      const assertCurrent = () => {
        if (cleanupOwners.isTurnExecutionActive(lease.grant.turnId))
          throw new ControlProductPreconditionError();
        const read = owner.readWorkerCompletion((sqlite) => {
          const current = readNanoHostRecoveryLease(sqlite, lease);
          const currentTarget = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
          return (
            lease.attempt.phase !== 'open' &&
            ['cleanup-pending', 'cleanup-failed'].includes(current.session.state) &&
            isDeepStrictEqual(current.session, session) &&
            isDeepStrictEqual(current.proof, proof) &&
            isDeepStrictEqual(currentTarget, target) &&
            target.ready &&
            target.freshEmpty &&
            target.predecessorFenced &&
            target.physicalEpoch &&
            target.identityId === proof.cleanupOccurrence?.identityId &&
            target.deploymentId === session.deploymentId &&
            verifyNanoHostCleanupSubmitPlacement(coreDb, sqlite, lease, session)
          );
        });
        if (read.state !== 'ready' || !read.value) throw new ControlProductPreconditionError();
      };
      assertCurrent();
      const result = await cleanupOwners.cleanupClaimedBackendSession(identity, {
        target,
        assertCurrent,
        admit: () => {
          throw new ControlProductPreconditionError();
        },
      });
      if (
        result.kind !== 'fenced-absence' ||
        result.originPhysicalEpoch !== session.originPhysicalEpoch
      )
        return hold;
      assertCurrent();
      return settleCleanup({
        lease,
        expectedSession: session,
        expectedRecovery: proof,
        kind: 'transition',
        target,
        toState: 'physical-cleaned',
        cleanupResult: result,
        observedAt: now(),
      });
    },
    restoreClaimResult: async (lease, now) => {
      if (
        !cleanupOwners ||
        lease.attempt.phase === 'open' ||
        (lease.attempt.phase === 'closing' && lease.attempt.fenceRef !== null)
      )
        throw new ControlProductPreconditionError();
      const retained = owner.read((sqlite) => {
        const { session, proof } = readNanoHostRecoveryLease(sqlite, lease);
        if (
          !['cleanup-pending', 'cleanup-failed'].includes(session.state) ||
          !proof.cleanupOccurrence ||
          proof.physicalCleanup ||
          !verifyNanoHostCleanupSubmitPlacement(coreDb, sqlite, lease, session)
        )
          return null;
        return { session, proof, occurrence: proof.cleanupOccurrence };
      });
      if (retained.state !== 'ready' || !retained.value)
        throw new ControlProductPreconditionError();
      const { session, proof, occurrence } = retained.value;
      await cleanupOwners.restoreClaimedCleanupResult(
        session,
        occurrence,
        async (cleanupResult) => {
          const target = owner.read((sqlite) =>
            getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId)
          );
          if (target.state !== 'ready' || !target.value)
            throw new ControlProductPreconditionError();
          const settled = await settleCleanup({
            lease,
            expectedSession: session,
            expectedRecovery: proof,
            kind: 'transition',
            target: target.value,
            toState: 'physical-cleaned',
            cleanupResult,
            observedAt: now(),
          });
          if (settled.state !== 'ready') throw new ControlProductPreconditionError();
        },
        async () => {
          const observedAt = now();
          const current = owner.read((sqlite) => {
            const lease = readRetainedNanoHostSubmission(coreDb, session.attemptId)?.lease;
            if (!lease) return null;
            const retained = readNanoHostRecoveryLease(sqlite, lease);
            const target = getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId);
            if (
              !target ||
              !isDeepStrictEqual(retained.proof.cleanupOccurrence, occurrence) ||
              !isDeepStrictEqual(cleanupIdentity(retained.session), cleanupIdentity(session))
            )
              return null;
            return {
              lease,
              target,
              expectedSession: retained.session,
              expectedRecovery: retained.proof,
            };
          });
          if (current.state !== 'ready' || !current.value)
            throw new ControlProductPreconditionError();
          const result = await cleanupOwners.commitPhysicalTransition({
            ...current.value,
            kind: 'transition',
            toState: 'cleanup-pending',
            cleanupUnknownRequestId: occurrence.deleteRequestId,
            observedAt,
          });
          if (result.state !== 'ready') throw new ControlProductPreconditionError();
        }
      );
    },
    claimCleanup: async (input) => {
      if (!cleanupOwners) return hold;
      const { session: before, proof: beforeProof, lease, target, identity } = input;
      if (
        !isDeepStrictEqual(identity, cleanupIdentity(before)) ||
        (lease.attempt.phase === 'closing' && lease.attempt.fenceRef !== null) ||
        !['materializing', 'materialized', 'launching'].includes(before.state) ||
        beforeProof.cleanupOccurrence ||
        beforeProof.physicalCleanup
      )
        return hold;
      const attemptId = lease.grant.attemptId;
      const occurrence = prepareNanoHostCleanupOccurrence(before, target, input.firstOperation);
      const acknowledged = await cleanupOwners
        .commitPhysicalTransition(
          {
            kind: 'transition',
            toState: 'cleanup-pending',
            lease,
            expectedSession: before,
            expectedRecovery: beforeProof,
            observedAt: input.now(),
            target,
            cleanupOccurrence: occurrence,
          },
          input.authorize
        )
        .catch(() => null);
      // Only this request's FULL ACK supplies the live right. A readback cannot replace a lost ACK.
      if (
        acknowledged?.state !== 'ready' ||
        acknowledged.value.state !== 'cleanup-pending' ||
        !isDeepStrictEqual(identity, cleanupIdentity(acknowledged.value))
      )
        return hold;
      const session = acknowledged.value;
      const proof = { ...beforeProof, cleanupOccurrence: occurrence };
      const claim = {
        session,
        proof,
        lease,
        target,
        firstCommand: { kind: occurrence.firstOperation, requestId: occurrence.firstRequestId },
        deleteRequestId: occurrence.deleteRequestId,
      };
      const continuation = createNanoHostCleanupContinuation(owner, claim);
      const verifyClaim = () => {
        if (cleanupOwners.isTurnExecutionActive(lease.grant.turnId))
          throw new ControlProductPreconditionError();
        const read = owner.readWorkerCompletion((sqlite) =>
          sqlite
            .transaction(() => {
              const current = readNanoHostRecoveryLease(sqlite, lease);
              if (
                session.state !== 'cleanup-pending' ||
                proof.physicalCleanup ||
                !isDeepStrictEqual(current.session, session) ||
                !isDeepStrictEqual(current.proof, proof) ||
                !isDeepStrictEqual(
                  getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId),
                  target
                ) ||
                !target.ready ||
                !target.freshEmpty ||
                !target.predecessorFenced ||
                !target.physicalEpoch ||
                !/^[a-f0-9]{64}$/.test(target.physicalEpoch) ||
                target.deploymentId !== session.deploymentId ||
                Number(lease.grant.generation) > target.connectionGeneration ||
                (Number(lease.grant.generation) === target.connectionGeneration &&
                  target.physicalEpoch !== session.originPhysicalEpoch) ||
                !verifyNanoHostCleanupSubmitPlacement(coreDb, sqlite, lease, session)
              )
                return null;
              if (continuation.hasAdmittedCommand()) return 'dispatch';
              if (lease.attempt.phase === 'closed' && input.finalDecision === null)
                return 'dispatch';
              if (
                lease.attempt.phase !== 'closing' ||
                lease.attempt.fenceRef ||
                !input.finalDecision
              )
                return null;
              const final = inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId);
              if (final.state === 'settled') return final;
              const decision = readNanoHostFinalCloseDecision(coreDb, sqlite, attemptId, session);
              if (
                !isDeepStrictEqual(decision, input.finalDecision) ||
                (decision.state === 'native-only' && input.now() < lease.grant.deadline)
              )
                return null;
              return 'dispatch';
            })
            .deferred()
        );
        if (read.state !== 'ready' || !read.value) throw new ControlProductPreconditionError();
        if (read.value === 'dispatch') return;
        const undispatchedClaim = continuation.withdraw(read.value);
        if (!undispatchedClaim) throw new ControlProductPreconditionError();
        throw new NanoHostCleanupFinalWon(read.value, undispatchedClaim);
      };
      const expected = { lease, expectedSession: session, expectedRecovery: proof, target };
      let result: NanoHostClaimedCleanupResult;
      try {
        await owner.afterWorkerControlAcknowledgement(verifyClaim);
        result = await cleanupOwners.cleanupClaimedBackendSession(identity, {
          target,
          admit: continuation.admit,
          assertCurrent: verifyClaim,
          captureReadOnly: input.finalDecision?.state === 'native-only',
        });
        if (
          (result.kind === 'deleted' && !continuation.admittedDelete(result.requestId)) ||
          (result.kind === 'fenced-absence' &&
            (result.originPhysicalEpoch !== session.originPhysicalEpoch ||
              result.originPhysicalEpoch === target.physicalEpoch))
        )
          return hold;
      } catch (error) {
        // A Core final post can be in flight at the synchronous queue guard. Read its ACK
        // before deciding, while the same unadmitted continuation can still be withdrawn.
        const winner =
          error instanceof ControlProductPreconditionError
            ? await owner.afterWorkerControlAcknowledgement(verifyClaim).then(
                () => null,
                (cause: unknown) => cause
              )
            : error;
        if (winner instanceof NanoHostCleanupFinalWon) {
          await closeout.reconcileAcceptedFinalStatus(
            session,
            winner.final,
            winner.undispatchedClaim
          );
          return { state: 'ready', value: 'delegated-final' };
        }
        if (error instanceof ControlProductPreconditionError) return hold;
        // A failed classification cannot replace the original failure or imply that cleanup succeeded.
        await cleanupOwners
          .commitPhysicalTransition({
            ...expected,
            kind: 'transition',
            toState: 'cleanup-failed',
            observedAt: input.now(),
          })
          .catch(() => undefined);
        throw error;
      }
      return settleCleanup({
        ...expected,
        kind: 'transition',
        toState: 'physical-cleaned',
        cleanupResult: result,
        observedAt: result.kind === 'idle-deleted' ? result.observedAt : input.now(),
      });
    },
  };
}
