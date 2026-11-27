import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { isSealedTurnTerminal, workspaceIdForOwner } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import {
  DISPLAY_PROJECTION_REFRESH_FIELDS,
  type FsStore,
  StoreRecordNotFoundError,
} from '../lib/store.js';
import {
  requireSchedulerAdmissionEntry,
  requireSchedulerExecutionAttemptAdmissionContext,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import { hashNanoHostFinalDecision } from '../storage/control-store-worker-protocol.js';
import {
  hasCoreWorkerFinalIntake,
  hasSurvivingNanoHostFinalEvidence,
  inspectAcceptedNanoHostFinalInDb,
  type NanoHostFinalCloseDecision,
  readNanoHostFinalCloseDecision,
  verifyNanoHostCleanupSubmitPlacement,
} from '../storage/core-journal-native.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { openAdmittedWorkspaceReadDb } from '../storage/db.js';
import {
  type NanoHostRecoveryLease,
  type NanoHostRecoveryMutation,
  readNanoHostPhysicalCleanupReceipt,
  readNanoHostRecoveryLease,
} from '../storage/nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from '../storage/nanohost-submitted-lease.js';
import type { AdmittedNanoHostTransportStorage } from '../storage/nanohost-transport-owner.js';
import type { StorageResult } from '../storage/storage-owner.js';
import { readWorkspaceObservationCutoff } from '../storage/work-observations.js';
import {
  findNamedAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import {
  closeSchedulerExecutionAttemptWithFence,
  isSchedulerExecutionBusyRefusal,
  listOpenSchedulerExecutionAttempts,
  listSchedulerExecutionAttemptsByTurnId,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
  schedulerExecutionCorrelation,
} from './execution-attempts.js';
import {
  isNanoHostAttemptReconnectEligible,
  type NanoHostExecutionAttemptRecord,
} from './nanohost-attempt-records.js';
import { createNanoHostEffectRequest } from './nanohost-effect-identity.js';
import {
  getNanoHostRuntimeTarget,
  type NanoHostRuntimeTargetRecord,
} from './nanohost-runtime-target-records.js';
import { readPendingRequest } from './pending-requests.js';
import { logRecoveryMaintenanceFailure } from './scheduler-attempt-maintenance-service.js';
import type { RunSchedulerRestartRecoveryInput } from './scheduler-restart-recovery.js';
import { projectWorkerBackendCleanup } from './worker-backend-cleanup-projection.js';
import {
  getWorkerBackendSession,
  listWorkerBackendSessions,
  type WorkerBackendSessionRecord,
  workerBackendImageIdentity,
} from './worker-backend-session-records.js';
import { isWorkerCancellationFinalCause } from './worker-control-final-receipt.js';
import {
  type AcceptedWorkerFinalStatus,
  getWorkerControlAcceptedFinalStatus,
  hasPendingWorkerCancellationFinal,
} from './worker-control-records.js';
import type { WorkerGovernanceBackendSessionIdentity } from './worker-governance-backend.js';
import { isAlreadyDecidedWorkerMcpItem } from './worker-mcp-decision.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import { hasPendingWorkspaceCapture } from './workspace-reconciliation-records.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceMaterializationRecords,
  requireCompleteBackendWorkspaceHandleHandoff,
} from './workspace-sync-records.js';
import { publishWorkspaceTakeoverEvaluation } from './workspace-takeover-publication.js';

/** A2 binds the selected read handle and the original Core decision plus Native FULL writer. */
export interface AdmittedNanoHostAttemptRecovery {
  readonly owner: Pick<AdmittedNanoHostTransportStorage['owner'], 'read'>;
  /** The Core writer compares the current original lease and the exact Native liveness observation. */
  close(input: {
    readonly lease: NanoHostRecoveryLease;
    readonly session: WorkerBackendSessionRecord;
    readonly proof: ReturnType<typeof readNanoHostRecoveryLease>['proof'];
    readonly cause: string;
    readonly observedAt: string;
    readonly outcomeRef?: string;
    /** K8b: hash of the final decision this close consumes. The Core close transaction recomputes it. */
    readonly finalHash?: string;
  }): Promise<StorageResult<'nanohost' | 'control-kernel', SchedulerExecutionAttemptRecord>>;
  /**
   * Verifies the original accepted Native final against its Core observation receipt (K8b).
   * An exact settled match goes to guarded closeout and returns `closed`. A `native-only` readback means that the
   * Native pair matches the original intake and that complete Core history proves the receipt absent.
   * Any other proof holds by throwing.
   */
  reconcileFinal(
    lease: NanoHostRecoveryLease,
    session: WorkerBackendSessionRecord,
    final: AcceptedWorkerFinalStatus
  ): Promise<'closed' | Extract<NanoHostFinalCloseDecision, { readonly state: 'native-only' }>>;
  commit(
    input: NanoHostRecoveryMutation,
    cleanup?: {
      /** Runs under the existing Core hold before posting the first Native cleanup transition. */
      readonly authorize: () => boolean;
      /** Hands off first cleanup before the same hold releases final admission. */
      readonly handoff: (session: WorkerBackendSessionRecord) => Promise<void>;
    }
  ): Promise<StorageResult<'nanohost' | 'control-kernel', WorkerBackendSessionRecord>>;
  /** Rechecks this exact target and the same decided cleanup scope at the physical carriage boundary. */
  cleanup(
    identity: WorkerGovernanceBackendSessionIdentity,
    target: NanoHostRuntimeTargetRecord,
    lease: NanoHostRecoveryLease
  ): Promise<
    StorageResult<
      'nanohost' | 'control-kernel',
      NonNullable<ReturnType<typeof readNanoHostPhysicalCleanupReceipt>>
    >
  >;
}

/** NanoHost-only recovery uses the existing physical cleanup and full accepted-final closeout owners. */
export interface RunNanoHostAttemptRecoveryInput extends RunSchedulerRestartRecoveryInput {
  readonly admittedNanoHostRecovery?: StorageResult<'nanohost', AdmittedNanoHostAttemptRecovery>;
  /** Same selected next-step pass used by normal cleanup; never a legacy classifier fallback. */
  readonly reconcileExecutions: () => Promise<void>;
  readonly cleanupBackendSession: (
    session: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
  /** Prepares original cleanup; true excludes an exact Core idle owner from orphan cleanup. */
  readonly prepareBackendCleanup: (session: WorkerGovernanceBackendSessionIdentity) => boolean;
  readonly restoreBackendSession: (session: WorkerBackendSessionRecord) => Promise<void>;
}
interface RecoveryWorkspace {
  readonly db: WorkspaceDb;
  readonly environmentPackage: AgentEnvironmentPackage;
}

function readRecovery<Value>(
  recovery: AdmittedNanoHostAttemptRecovery,
  query: (sqlite: Database.Database) => Value
): Value {
  const result = recovery.owner.read<Value>(query);
  if (result.state !== 'ready') throw new Error('NanoHost recovery owner is unavailable.');
  return result.value;
}

function retainedLease(coreDb: CoreDb, attemptId: string): NanoHostRecoveryLease {
  const retained = readRetainedNanoHostSubmission(coreDb, attemptId);
  if (!retained) throw new Error('NanoHost recovery is missing its original submitted Core grant.');
  return retained.lease;
}

function observeAdmittedAttempt(
  coreDb: CoreDb,
  recovery: AdmittedNanoHostAttemptRecovery,
  attemptId: string
) {
  const lease = retainedLease(coreDb, attemptId);
  return readRecovery(recovery, (sqlite) => readNanoHostRecoveryLease(sqlite, lease));
}

type RecoveryStage = NanoHostRecoveryMutation extends infer Mutation
  ? Mutation extends NanoHostRecoveryMutation
    ? Omit<Mutation, 'lease' | 'expectedSession' | 'expectedRecovery' | 'observedAt'>
    : never
  : never;

async function commitRecoveryStage(
  coreDb: CoreDb,
  recovery: AdmittedNanoHostAttemptRecovery,
  expectedSession: WorkerBackendSessionRecord,
  stage: RecoveryStage,
  observedAt: string,
  originalProof?: ReturnType<typeof readNanoHostRecoveryLease>['proof'],
  cleanup?: Parameters<AdmittedNanoHostAttemptRecovery['commit']>[1]
): Promise<WorkerBackendSessionRecord> {
  const lease = retainedLease(coreDb, expectedSession.attemptId);
  const current = readRecovery(recovery, (sqlite) => readNanoHostRecoveryLease(sqlite, lease));
  if (
    !isDeepStrictEqual(current.session, expectedSession) ||
    (originalProof && !isDeepStrictEqual(current.proof, originalProof))
  )
    throw new Error('NanoHost recovery state changed before submission.');
  const request = {
    ...stage,
    lease,
    observedAt,
    expectedSession,
    expectedRecovery: current.proof,
  };
  const result = cleanup ? await recovery.commit(request, cleanup) : await recovery.commit(request);
  if (result.state !== 'ready')
    throw new Error('NanoHost recovery requires the original writer acknowledgement.');
  return result.value;
}

async function closeAdmittedAttempt(
  coreDb: CoreDb,
  recovery: AdmittedNanoHostAttemptRecovery,
  current: ReturnType<typeof readNanoHostRecoveryLease>,
  cause: string,
  observedAt: string,
  outcomeRef?: string,
  finalDecision?: NanoHostFinalCloseDecision
): Promise<SchedulerExecutionAttemptRecord> {
  const lease = retainedLease(coreDb, current.session.attemptId);
  const result = await recovery.close({
    lease,
    session: current.session,
    proof: current.proof,
    cause,
    observedAt,
    ...(outcomeRef ? { outcomeRef } : {}),
    ...(finalDecision ? { finalHash: hashNanoHostFinalDecision(finalDecision) } : {}),
  });
  if (
    result.state !== 'ready' ||
    result.value.attemptId !== lease.grant.attemptId ||
    result.value.operationId !== lease.grant.operationId ||
    result.value.phase === 'open'
  )
    throw new Error('NanoHost recovery has no matching Core close acknowledgement.');
  return result.value;
}

/** Classifies native survivors independently before listen, retaining faults for maintenance. */
export async function classifyNanoHostAttemptsAfterRestart(
  coreDb: CoreDb,
  input: RunNanoHostAttemptRecoveryInput
): Promise<{ readonly failedAttemptIds: string[] }> {
  const failedAttemptIds: string[] = [];
  const recovery = input.admittedNanoHostRecovery;
  const timestamp = input.now?.() ?? new Date().toISOString();
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    if (!isScopeAdmitted(coreDb.dataRoot, 'workspace', attempt.workspaceId)) continue;
    if (!attempt.operationId || attempt.backendId !== input.executionBackend.id) continue;
    if (attempt.terminalCause === 'sandbox-release-refusal') continue;
    try {
      if (recovery?.state !== 'ready') {
        failedAttemptIds.push(attempt.attemptId);
        continue;
      }
      const admitted = recovery.value;
      const observation = observeAdmittedAttempt(coreDb, admitted, attempt.attemptId);
      const { session, proof, attempt: native } = observation;
      assertSessionMatchesAttempt(session, native);
      // Restart must preserve the bounded cancellation final without arming ordinary reconnect.
      if (
        session.state === 'launching' &&
        session.workspaceHandoffState === 'complete' &&
        hasPendingWorkerCancellationFinal(native, timestamp)
      )
        continue;
      const cutoff = readWorkspaceObservationCutoff(coreDb.dataRoot, attempt);
      const eligible = !cutoff && isNanoHostAttemptReconnectEligible(native, session, timestamp);
      if (eligible) {
        try {
          await commitRecoveryStage(
            coreDb,
            admitted,
            session,
            { kind: 'arm-reconnect', classifiedAt: timestamp },
            input.now?.() ?? new Date().toISOString(),
            proof
          );
          await input.restoreBackendSession(session);
          continue;
        } catch {
          // An ambiguous restore or Native acknowledgement retains the original lease.
          failedAttemptIds.push(attempt.attemptId);
          continue;
        }
      }
      await closeAdmittedAttempt(
        coreDb,
        admitted,
        observation,
        cutoff ? 'observation_limit_reached' : 'restart-native-recovery',
        timestamp
      );
      await commitRecoveryStage(
        coreDb,
        admitted,
        session,
        { kind: 'needs-evidence' },
        timestamp,
        proof
      );
      if (!['physical-cleaned', 'cleaned'].includes(session.state))
        requireRecoveryTarget(admitted, session);
    } catch {
      logRecoveryMaintenanceFailure('attempt-recovery', attempt);
      failedAttemptIds.push(attempt.attemptId);
    }
  }
  return { failedAttemptIds };
}

/** Drives exact original native cleanup after listen; product barriers remain with the executor owner. */
export async function runNanoHostAttemptRecoveryMaintenance(
  coreDb: CoreDb,
  input: RunNanoHostAttemptRecoveryInput
): Promise<void> {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const now = input.now ?? (() => new Date().toISOString());
  const errors: unknown[] = [];
  try {
    await input.reconcileExecutions();
  } catch (error) {
    errors.push(error);
  }
  const selection = input.admittedNanoHostRecovery;
  if (selection?.state !== 'ready') {
    if (errors.length) throw new AggregateError(errors, 'Native attempt recovery failed.');
    return;
  }
  const recovery = selection.value;
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    if (!isScopeAdmitted(coreDb.dataRoot, 'workspace', attempt.workspaceId)) continue;
    if (attempt.backendId !== input.executionBackend.id) continue;
    if (attempt.terminalCause === 'sandbox-release-refusal') continue;
    try {
      if (!attempt.operationId) continue;
      const observation = observeAdmittedAttempt(coreDb, recovery, attempt.attemptId);
      let { session } = observation;
      const native = observation.attempt;
      assertSessionMatchesAttempt(session, native);
      const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, attempt.attemptId);
      const { final, finalReceipt, evidence } = readRecovery(recovery, (sqlite) =>
        sqlite
          .transaction(() => ({
            final: getWorkerControlAcceptedFinalStatus(
              { sqlite },
              {
                agentSessionId: native.agentSessionId,
                packageSnapshotId: native.inputRef,
                requestId: admission.requestId,
                threadId: native.threadId,
                turnId: native.turnId,
                workspaceId: native.workspaceId,
              }
            ),
            // Native FULL writes the final record together with its final_status sequence receipt.
            finalReceipt: sqlite
              .prepare(`SELECT 1 FROM worker_control_sequence_fingerprints
              WHERE agent_session_id = ? AND package_snapshot_id = ? AND operation = 'final_status'`)
              .get(native.agentSessionId, native.inputRef),
            // The receipt key derives only from the original submit placement (K8b).
            evidence: hasSurvivingNanoHostFinalEvidence(coreDb, sqlite, attempt.attemptId, session),
          }))
          .deferred()
      );
      // K8b: a final receipt without its final record is contradictory proof. It holds before expiry.
      if (!final && finalReceipt)
        throw new Error('Native final record is missing for its accepted final receipt.');
      // The surviving terminal event, its receipt or the original Core receipt also contradict absence.
      if (!final && evidence)
        throw new Error(
          'Native final record is missing for its surviving accepted final evidence.'
        );
      // K8b: the close below consumes this proved absence or Native-only final. Core recomputes it.
      let finalDecision: NanoHostFinalCloseDecision = { state: 'absent' };
      if (final) {
        if (input.isTurnExecutionActive?.(attempt.turnId)) continue;
        const lease = retainedLease(coreDb, session.attemptId);
        const readback = await recovery.reconcileFinal(lease, session, final);
        // K8b: a Native-only final waits only until the original absolute deadline. The first pass at or
        // after it owns the next decision: closing ACK with the first cause, then first cleanup. It
        // bypasses capture publication, so pending capture sources stay preserved for the cleanup owner.
        if (readback === 'closed' || lease.grant.deadline > timestamp) continue;
        finalDecision = readback;
      } else {
        if (
          native.deadline &&
          native.deadline > timestamp &&
          hasCoreWorkerFinalIntake(coreDb, attempt.attemptId)
        )
          continue;
        // A settled final reaches capture recovery through the guarded restart closeout above.
        const captureWorkspace = openRecoveryWorkspace(coreDb, native);
        try {
          if (
            await hasPendingWorkspaceCapture(
              coreDb,
              captureWorkspace.db,
              session,
              captureWorkspace.environmentPackage,
              input.store,
              undefined,
              { attemptId: attempt.attemptId, commitment: finalDecision }
            )
          )
            continue;
        } finally {
          captureWorkspace.db.sqlite.close();
        }
      }
      const livenessExpired =
        native.lastAcceptedHeartbeatAt === null
          ? native.startupDeadline <= timestamp
          : native.heartbeatDeadline <= timestamp;
      if (finalDecision.state === 'absent') {
        // The live Native clock controls the no-final branch. A proved Native-only final above uses
        // its absolute deadline, even if a shorter liveness gate would still permit a reconnect.
        if (
          session.state === 'launching' &&
          session.workspaceHandoffState === 'complete' &&
          hasPendingWorkerCancellationFinal(native, timestamp)
        )
          continue;
        if (
          native.phase === 'open' &&
          native.recoveryState === 'awaiting-reconnect' &&
          native.recoveryDeadline !== null &&
          native.recoveryDeadline > timestamp &&
          native.deadline !== null &&
          native.deadline > timestamp
        )
          continue;
        if (
          native.phase === 'open' &&
          !livenessExpired &&
          native.recoveryState !== 'needs-evidence'
        )
          continue;
      }
      const closeClock = now();
      const closed = await closeAdmittedAttempt(
        coreDb,
        recovery,
        observation,
        livenessExpired ? 'native-liveness-expired' : 'native-cleanup',
        closeClock,
        undefined,
        finalDecision
      );
      const cleanupAuthority = { closed, closeClock, finalDecision };
      // Revoke stale native authority before deferring to a live completion waiter. Its phase
      // observation wakes that owner; the guard prevents a second physical cleanup takeover.
      if (input.isTurnExecutionActive?.(attempt.turnId)) continue;
      const workspace = openRecoveryWorkspace(coreDb, native);
      try {
        assertEnvironmentPackageMatchesSession(workspace.environmentPackage, session);
        if (
          (workspace.environmentPackage.scope.requestId ?? null) !==
            (admission.requestId ?? null) ||
          workspace.environmentPackage.agent.agentId !== admission.requestedAgentId
        )
          throw new Error('Native recovery package does not match its exact admission.');
        let anyHandoffRows =
          listBackendWorkspaceHandles(workspace.db, native.workspaceId).some(
            (handle) => handle.packageSnapshotId === native.inputRef
          ) ||
          listWorkspaceMaterializationRecords(workspace.db, native.workspaceId).some(
            (record) => record.packageSnapshotId === native.inputRef
          );
        // Handoff publication does not invalidate the original proof.
        // Release failure or Core exit before attempt closure leaves this same empty package to finish next pass.
        let materializationNotPublished =
          !anyHandoffRows &&
          native.deadline === null &&
          ['execution-failed', 'turn-start-failed'].includes(native.terminalCause ?? '') &&
          ['physical-cleaned', 'cleaned'].includes(session.state) &&
          session.physicalCleanedAt !== null &&
          isInitialImagePreparation(native, session, workspace.environmentPackage);
        if (
          !materializationNotPublished &&
          !anyHandoffRows &&
          workspace.environmentPackage.workspace.inputs.length > 0
        ) {
          await commitRecoveryStage(coreDb, recovery, session, { kind: 'needs-evidence' }, now());
          // Empty tables and a Turn-local cleanup marker cannot authorize deleting surviving Workspace output.
          // Require a different fresh Epoch before asking the existing cleanup owner to prove physical absence; that owner rechecks the exact proof.
          const target = requireRecoveryTarget(recovery, session);
          if (
            !target ||
            target.deploymentId !== session.deploymentId ||
            !target.predecessorFenced ||
            !target.ready ||
            !target.freshEmpty ||
            !target.physicalEpoch ||
            !/^[0-9a-f]{64}$/.test(target.physicalEpoch) ||
            target.physicalEpoch === session.originPhysicalEpoch
          )
            continue;
          const cleaned = await cleanupPhysicalSession(
            coreDb,
            recovery,
            session,
            now,
            target,
            cleanupAuthority
          );
          if (!cleaned) continue;
          session = cleaned;
          // Publication can finish while cleanup awaits its native acknowledgement.
          // New rows still belong to the existing takeover/disposition owner, never the empty-table path.
          anyHandoffRows =
            listBackendWorkspaceHandles(workspace.db, native.workspaceId).some(
              (handle) => handle.packageSnapshotId === native.inputRef
            ) ||
            listWorkspaceMaterializationRecords(workspace.db, native.workspaceId).some(
              (record) => record.packageSnapshotId === native.inputRef
            );
          // The capture guard already preserved every arrived source.
          // The old writer is gone, publication never occurred, and retained Worker storage is kept idle.
          // Recheck this same proof after a crash between handoff publication and release.
          materializationNotPublished =
            !anyHandoffRows &&
            ['physical-cleaned', 'cleaned'].includes(session.state) &&
            session.physicalCleanedAt !== null;
        }
        if (!materializationNotPublished) {
          if (
            await publishWorkspaceTakeoverEvaluation(
              workspace.db,
              native,
              workspace.environmentPackage,
              timestamp,
              ['physical-cleaned', 'cleaned'].includes(session.state)
            )
          )
            continue;
        }
        const cleaned = await cleanupPhysicalSession(
          coreDb,
          recovery,
          session,
          now,
          undefined,
          cleanupAuthority
        );
        if (!cleaned) continue;
        session = cleaned;
        const projection = await projectCleanup(
          workspace.db,
          session,
          workspace.environmentPackage,
          materializationNotPublished
        );
        if (!projection.workspaceHandoffComplete)
          throw new Error('Native cleanup workspace handoff is incomplete.');
        if (session.workspaceHandoffState === 'pending')
          session = await commitRecoveryStage(
            coreDb,
            recovery,
            session,
            { kind: 'workspace-handoff' },
            now()
          );
      } finally {
        workspace.db.sqlite.close();
      }
      if (hasCoreWorkerFinalIntake(coreDb, native.attemptId))
        throw new Error('The original Worker final still owns Turn publication.');
      let settled = false;
      if (native.terminalCause === 'turn-start-failed' && input.store) {
        settled = await settleTerminalFailedStart(
          coreDb,
          native.attemptId,
          input.store,
          input,
          timestamp,
          recovery
        );
      } else {
        await input.projectRecoveredTurn({ ...session, terminalCause: closed.terminalCause });
        settled =
          input.store !== undefined &&
          hasRecoveredTerminalHandoff(input.store, session, workspace.environmentPackage);
      }
      if (session.state === 'physical-cleaned')
        session = await commitRecoveryStage(
          coreDb,
          recovery,
          session,
          { kind: 'finish-cleanup' },
          now()
        );
      if (settled) {
        // Workspace evaluation prevented destructive loss of pending collection, and the
        // cleanup owner proved local destruction or an Epoch fence. Its handoff and teardown
        // evidence are durable. The terminal owner preserves accepted output and truthfully
        // interrupts unavailable output; no Integration stream or Turn route survives cleanup.
        const proof = {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        } as const;
        const terminal = input.store?.getTurnById(native.turnId);
        const settledAttempt = terminal
          ? await closeAdmittedAttempt(
              coreDb,
              recovery,
              observeAdmittedAttempt(coreDb, recovery, native.attemptId),
              `turn-${terminal.status}`,
              now(),
              `turn:${terminal.id}:${terminal.status}`
            )
          : requireSchedulerExecutionAttempt(coreDb, native.attemptId);
        const correlation = schedulerExecutionCorrelation(settledAttempt);
        const release = await input.executionBackend.release({ ...correlation, proof });
        if (
          release.state !== 'released' ||
          !release.fenceRef ||
          !isDeepStrictEqual(
            {
              attemptId: release.attemptId,
              backendId: release.backendId,
              inputRef: release.inputRef,
              bindingRef: release.bindingRef,
              operationId: release.operationId,
            },
            correlation
          )
        )
          throw new Error('Native recovery release has no exact backend fence.');
        await closeSchedulerExecutionAttemptWithFence(coreDb, {
          correlation,
          proof,
          fenceRef: release.fenceRef,
          now,
        });
      }
    } catch (error) {
      logNativeRecoveryFailure(
        attempt,
        'scheduler.native_attempt_recovery_failed',
        'Native attempt cleanup or terminal handoff check failed.'
      );
      errors.push(error);
    }
  }
  // Closed attempts can retain idle native bindings. No incoming Turn or synthetic attempt owns their retirement.
  for (const session of readRecovery(recovery, (sqlite) => listWorkerBackendSessions({ sqlite }))) {
    if (!isScopeAdmitted(coreDb.dataRoot, 'workspace', session.workspaceId)) continue;
    try {
      const owner = requireSchedulerExecutionAttempt(coreDb, session.attemptId);
      if (owner.backendId !== input.executionBackend.id || owner.phase !== 'closed') continue;
      if (session.state === 'cleaned') continue;
      // As in the open pass, only a submitted attempt is in this census. An unsubmitted failed start
      // has no grant for this retirement entry, and the failed-start pass below owns its hold.
      if (input.store && !owner.operationId && owner.terminalCause === 'turn-start-failed')
        continue;
      const original = observeAdmittedAttempt(coreDb, recovery, session.attemptId);
      if (!isDeepStrictEqual(original.session, session))
        throw new Error('Orphan recovery backend changed.');
      // Exact journal ownership excludes orphan cleanup even outside the current candidate page.
      if (input.prepareBackendCleanup(toRestartBackendIdentity(session))) continue;
      const captureWorkspace = openRecoveryWorkspace(coreDb, original.attempt);
      try {
        if (
          await hasPendingWorkspaceCapture(
            coreDb,
            captureWorkspace.db,
            session,
            captureWorkspace.environmentPackage,
            input.store
          )
        )
          continue;
      } finally {
        captureWorkspace.db.sqlite.close();
      }
      const cleaned = await cleanupPhysicalSession(coreDb, recovery, session, now);
      if (cleaned?.state === 'physical-cleaned')
        await commitRecoveryStage(coreDb, recovery, cleaned, { kind: 'retire-orphan' }, now());
    } catch (error) {
      logNativeRecoveryFailure(
        session,
        'scheduler.native_orphan_backend_recovery_failed',
        'Closed-attempt backend retirement check failed.'
      );
      errors.push(error);
    }
  }
  if (input.store) {
    const failedStarts = coreDb.sqlite
      .prepare(`SELECT attempt.attempt_id AS attemptId, attempt.workspace_id AS workspaceId,
      attempt.thread_id AS threadId, attempt.turn_id AS turnId, attempt.agent_session_id AS agentSessionId
      FROM scheduler_execution_attempts AS attempt
      JOIN scheduler_admission_entries AS admission ON admission.queue_entry_id = attempt.queue_entry_id
        AND admission.workspace_id = attempt.workspace_id AND admission.thread_id = attempt.thread_id
        AND admission.turn_id = attempt.turn_id
      WHERE attempt.phase = 'closed' AND admission.backend_id = ? ORDER BY attempt.rowid`)
      .all(input.executionBackend.id) as Array<
      Pick<
        SchedulerExecutionAttemptRecord,
        'attemptId' | 'workspaceId' | 'threadId' | 'turnId' | 'agentSessionId'
      >
    >;
    for (const attempt of failedStarts) {
      if (!isScopeAdmitted(coreDb.dataRoot, 'workspace', attempt.workspaceId)) continue;
      try {
        // The exact-claim decode refuses inside this guard, so one unproved claim stays its own hold.
        if (
          requireSchedulerExecutionAttempt(coreDb, attempt.attemptId).terminalCause !==
          'turn-start-failed'
        )
          continue;
        await settleTerminalFailedStart(
          coreDb,
          attempt.attemptId,
          input.store,
          input,
          timestamp,
          recovery
        );
      } catch (error) {
        logNativeRecoveryFailure(
          attempt,
          'scheduler.native_failed_start_recovery_required',
          'Failed-start product settlement check failed.'
        );
        errors.push(
          new Error(
            `recovery_required: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        );
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Native attempt recovery failed.');
}
/** Emits only fixed failed-check diagnostics and already known product ids; exceptions stay private. */
function logNativeRecoveryFailure(
  subject: Pick<
    SchedulerExecutionAttemptRecord,
    'attemptId' | 'workspaceId' | 'threadId' | 'turnId' | 'agentSessionId'
  >,
  errorCode: string,
  summary: string
): void {
  console.warn(
    JSON.stringify({
      severityText: 'WARN',
      body: summary,
      attributes: {
        'openkit.error.code': errorCode,
        'openkit.attempt.id': subject.attemptId,
        'openkit.workspace.id': subject.workspaceId,
        'openkit.thread.id': subject.threadId,
        'openkit.turn.id': subject.turnId,
        ...(subject.agentSessionId ? { 'openkit.agent.session.id': subject.agentSessionId } : {}),
      },
    })
  );
}

/** Reads the current physical authority from the same admitted Native owner. */
function requireRecoveryTarget(
  recovery: AdmittedNanoHostAttemptRecovery,
  session: WorkerBackendSessionRecord
): NanoHostRuntimeTargetRecord {
  const target = readRecovery(recovery, (sqlite) =>
    getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId)
  );
  if (
    !target ||
    target.deploymentId !== session.deploymentId ||
    !target.ready ||
    !target.freshEmpty ||
    !target.predecessorFenced ||
    !target.physicalEpoch
  )
    throw new Error('NanoHost recovery RuntimeTarget is unavailable.');
  return target;
}

/** Cleans one exact identity only while the target passed to the deciding writer stays current. */
async function cleanupPhysicalSession(
  coreDb: CoreDb,
  recovery: AdmittedNanoHostAttemptRecovery,
  originalSession: WorkerBackendSessionRecord,
  now: () => string,
  expectedTarget?: NanoHostRuntimeTargetRecord,
  authority?: {
    readonly closed: SchedulerExecutionAttemptRecord;
    readonly closeClock: string;
    readonly finalDecision: NanoHostFinalCloseDecision;
  }
): Promise<WorkerBackendSessionRecord | null> {
  const target = requireRecoveryTarget(recovery, originalSession);
  if (expectedTarget && !isDeepStrictEqual(target, expectedTarget))
    throw new Error('NanoHost recovery RuntimeTarget changed.');
  if (['physical-cleaned', 'cleaned'].includes(originalSession.state)) {
    const original = retainedLease(coreDb, originalSession.attemptId);
    const receipt = readRecovery(recovery, (sqlite) =>
      readNanoHostPhysicalCleanupReceipt(sqlite, original, target, (session) =>
        verifyNanoHostCleanupSubmitPlacement(coreDb, sqlite, original, session)
      )
    );
    if (!receipt) throw new Error('NanoHost recovery has no exact physical cleanup receipt.');
    return receipt.session;
  }
  const handoff = (session: WorkerBackendSessionRecord) => {
    if (!isDeepStrictEqual(requireRecoveryTarget(recovery, session), target))
      throw new Error('NanoHost recovery RuntimeTarget changed before physical cleanup.');
    return recovery.cleanup(
      toRestartBackendIdentity(session),
      target,
      retainedLease(coreDb, session.attemptId)
    );
  };
  const transition = { kind: 'transition', toState: 'cleanup-pending', target } as const;
  const { attemptId } = originalSession;
  let cleaned: Awaited<ReturnType<typeof handoff>> | undefined;
  if (authority) {
    // On reopen the phase alone cannot prove whether the first physical post ran.
    if (originalSession.state === 'cleanup-pending')
      throw new Error('NanoHost recovery requires the original physical cleanup receipt.');
    const winner: { final: AcceptedWorkerFinalStatus | null } = { final: null };
    try {
      await commitRecoveryStage(coreDb, recovery, originalSession, transition, now(), undefined, {
        authorize: () =>
          readRecovery(recovery, (sqlite) => {
            const readback = inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId);
            if (readback.state === 'settled') {
              winner.final = getWorkerControlAcceptedFinalStatus({ sqlite }, readback.lineage);
              return false;
            }
            const lease = retainedLease(coreDb, attemptId);
            const current = readNanoHostFinalCloseDecision(
              coreDb,
              sqlite,
              attemptId,
              originalSession
            );
            return (
              isDeepStrictEqual(lease.attempt, authority.closed) &&
              isDeepStrictEqual(current, authority.finalDecision) &&
              (authority.closeClock >= lease.grant.deadline ||
                (current.state === 'absent' &&
                  !isWorkerCancellationFinalCause(lease.attempt.terminalCause) &&
                  !hasCoreWorkerFinalIntake(coreDb, attemptId)))
            );
          }),
        handoff: async (session) => {
          cleaned = await handoff(session);
        },
      });
    } catch (error) {
      if (!winner.final) throw error;
      // Closeout uses the same owner holds, so it runs after the refused cleanup releases them.
      await recovery.reconcileFinal(
        retainedLease(coreDb, attemptId),
        originalSession,
        winner.final
      );
      return null;
    }
  } else {
    const session =
      originalSession.state === 'cleanup-pending'
        ? originalSession
        : await commitRecoveryStage(coreDb, recovery, originalSession, transition, now());
    cleaned = await handoff(session);
  }
  if (cleaned?.state !== 'ready')
    throw new Error('NanoHost recovery has no exact physical cleanup acknowledgement.');
  const retained = retainedLease(coreDb, attemptId);
  const receipt = readRecovery(recovery, (sqlite) =>
    readNanoHostPhysicalCleanupReceipt(sqlite, retained, target)
  );
  if (!receipt || !isDeepStrictEqual(cleaned.value, receipt))
    throw new Error('NanoHost recovery physical result changed before carriage.');
  return receipt.session;
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

/** Opens the attempt Workspace and loads its immutable AEP snapshot. */
function openRecoveryWorkspace(
  coreDb: CoreDb,
  row: NanoHostExecutionAttemptRecord
): RecoveryWorkspace {
  const db = openAdmittedWorkspaceReadDb(coreDb.dataRoot, row.workspaceId);
  try {
    const environmentPackage = requireAgentEnvironmentPackageSnapshot(
      db,
      row.workspaceId,
      row.inputRef
    ).snapshot;
    const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, row.attemptId);
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

/** Projects one stable physical cleanup attempt into the workspace database. */
function projectCleanup(
  workspaceDb: WorkspaceDb,
  session: WorkerBackendSessionRecord,
  environmentPackage: AgentEnvironmentPackage,
  materializationNotPublished = false
): ReturnType<typeof projectWorkerBackendCleanup> {
  if (!session.physicalCleanedAt) {
    throw new Error(`Worker backend session ${session.attemptId} has no physical cleanup time.`);
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
    materializationNotPublished,
    workspaceId: session.workspaceId,
  });
}

/** Verifies that the Core attempt and physical anchor have identical authority lineage. */
function assertSessionMatchesAttempt(
  session: WorkerBackendSessionRecord,
  row: Pick<
    SchedulerExecutionAttemptRecord,
    'attemptId' | 'workspaceId' | 'threadId' | 'turnId' | 'agentSessionId' | 'inputRef'
  >
): void {
  if (
    session.attemptId !== row.attemptId ||
    session.workspaceId !== row.workspaceId ||
    session.threadId !== row.threadId ||
    session.turnId !== row.turnId ||
    session.agentSessionId !== row.agentSessionId ||
    session.packageSnapshotId !== row.inputRef
  ) {
    throw new Error(
      `Worker backend session ${session.attemptId} does not match scheduler lineage.`
    );
  }
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

/** Checks critical product authority after the existing terminal callback completes successfully. */
function hasRecoveredTerminalHandoff(
  store: FsStore,
  backend: WorkerBackendSessionRecord,
  environmentPackage: AgentEnvironmentPackage
): boolean {
  const turn = store.getTurnById(backend.turnId);
  const session = store.getAgentSession(backend.agentSessionId);
  if (
    workspaceIdForOwner(turn.owner) !== backend.workspaceId ||
    turn.threadId !== backend.threadId ||
    turn.agentSessionId !== backend.agentSessionId ||
    session.workspaceId !== backend.workspaceId ||
    session.threadId !== backend.threadId ||
    session.agentId !== turn.agentId ||
    session.environmentPackageSnapshotId !== backend.packageSnapshotId ||
    environmentPackage.agent.agentId !== turn.agentId ||
    !isDeepStrictEqual(turn.triggerActor, environmentPackage.scope.triggerActor)
  )
    throw new Error('Native recovery terminal handoff has contradictory product lineage.');
  if (!isSealedTurnTerminal(turn.status) || !turn.completedAt) return false;
  const sessionStatus =
    turn.status === 'completed'
      ? 'idle'
      : turn.status === 'cancelled'
        ? 'interrupted'
        : turn.status;
  // The callback owns terminal publication and propagates partial writes. Event snapshots and
  // display fields are projections, not another scheduler release authority (Durable Scheduler
  // Design, Terminal Handoff); only the canonical Turn/AgentSession tuple is checked here.
  return session.status === sessionStatus;
}

/**
 * Proves definite non-acceptance against retained backend-owned execution evidence.
 *
 * A closed phase never erases heartbeat, sequence, process or credential evidence.
 * Compatibility planning alone is pre-effect and therefore does not contradict this proof.
 *
 * @param coreDb Existing attempt, runtime binding and backend owners.
 * @param attemptId Exact attempt whose absence of execution must be established.
 * @param nativeDb Admitted Native evidence connection for the sessionless Task reader.
 * @returns Whether no native execution evidence or competing binding remains.
 * @throws Error when the exact generic attempt is absent or invalid.
 */
export function hasNanoHostAttemptPreEffectProof(
  coreDb: CoreDb,
  attemptId: string,
  nativeDb?: Pick<Parameters<typeof getWorkerBackendSession>[0], 'sqlite'>
): boolean {
  return (
    nativeDb !== undefined &&
    hasNanoHostPreEffectEvidence(
      nativeDb.sqlite,
      requireSchedulerExecutionAttempt(coreDb, attemptId)
    )
  );
}

function hasNanoHostPreEffectEvidence(
  sqlite: Database.Database,
  attempt: SchedulerExecutionAttemptRecord
): boolean {
  return (
    attempt.disposition === 'not_accepted' &&
    attempt.operationId === null &&
    !getWorkerBackendSession({ sqlite }, attempt.attemptId) &&
    hasNanoHostAttemptNoExecutionEvidence(sqlite, attempt)
  );
}

/** Reads retained Native evidence without treating a closed attempt as proof of non-execution. */
function hasNanoHostAttemptNoExecutionEvidence(
  sqlite: Database.Database,
  attempt: SchedulerExecutionAttemptRecord
): boolean {
  return !(
    sqlite
      .prepare(`SELECT 1 FROM worker_backend_sessions WHERE attempt_id = ?
      AND (worker_recovery_json IS NOT NULL OR worker_route_binding_json IS NOT NULL)`)
      .get(attempt.attemptId) ||
    sqlite
      .prepare(`SELECT 1 FROM worker_control_sequence_fingerprints
      WHERE turn_id = ? AND (? IS NULL OR package_snapshot_id = ?) LIMIT 1`)
      .get(attempt.turnId, attempt.inputRef, attempt.inputRef) ||
    sqlite
      .prepare(`SELECT 1 FROM worker_control_records
      WHERE turn_id = ? AND (? IS NULL OR package_snapshot_id = ?) LIMIT 1`)
      .get(attempt.turnId, attempt.inputRef, attempt.inputRef) ||
    sqlite
      .prepare(`SELECT 1 FROM agent_session_runtime_bindings
      WHERE agent_session_id = ? OR current_turn_id = ? OR current_attempt_id = ? LIMIT 1`)
      .get(attempt.agentSessionId, attempt.turnId, attempt.attemptId)
  );
}

function hasAdmittedPreEffectProof(
  recovery: AdmittedNanoHostAttemptRecovery,
  attempt: SchedulerExecutionAttemptRecord
): boolean {
  return readRecovery(recovery, (sqlite) => hasNanoHostPreEffectEvidence(sqlite, attempt));
}

/** Busy siblings are Core decisions; their contradictory effects belong to the Native file. */
function hasNanoHostBusySiblingProofs(
  coreDb: CoreDb,
  recovery: AdmittedNanoHostAttemptRecovery,
  attempt: SchedulerExecutionAttemptRecord
): boolean {
  const siblings = listSchedulerExecutionAttemptsByTurnId(coreDb, attempt.turnId).filter(
    (sibling) => sibling.attemptId !== attempt.attemptId
  );
  if (siblings.some((sibling) => !isSchedulerExecutionBusyRefusal(sibling))) return false;
  if (siblings.length === 0) return true;
  return readRecovery(recovery, (sqlite) => {
    const originals = JSON.stringify(
      siblings.map(({ attemptId, agentSessionId, inputRef }) => ({
        attemptId,
        agentSessionId,
        inputRef,
      }))
    );
    return !(
      sqlite
        .prepare(`SELECT 1 FROM worker_backend_sessions
        WHERE attempt_id IN (SELECT json_extract(value, '$.attemptId') FROM json_each(?)) LIMIT 1`)
        .get(originals) ||
      sqlite
        .prepare(`SELECT 1 FROM worker_control_sequence_fingerprints
        WHERE turn_id = ? AND package_snapshot_id IN (
          SELECT json_extract(value, '$.inputRef') FROM json_each(?)
        ) LIMIT 1`)
        .get(attempt.turnId, originals) ||
      sqlite
        .prepare(`SELECT 1 FROM agent_session_runtime_bindings
        WHERE current_turn_id = ? OR agent_session_id IN (
          SELECT json_extract(value, '$.agentSessionId') FROM json_each(?)
        ) OR current_attempt_id IN (SELECT json_extract(value, '$.attemptId') FROM json_each(?)) LIMIT 1`)
        .get(attempt.turnId, originals, originals)
    );
  });
}

/**
 * Proves the cleaned, unused NanoHost preparation boundary for checkpoint-owned failed-start closeout.
 *
 * Pending handoff remains untouched because no materialization or handle was published. This does not grant cleanup or release authority.
 * @param coreDb Native attempt, binding and backend owners.
 * @param workspaceDb Exact Workspace materialization owners.
 * @param environmentPackage Original immutable package.
 * @param attemptId Original failed attempt.
 * @returns Whether the exact cleaned anchor positively proves no Worker was submitted.
 * @throws Error when retained native or package lineage is unreadable or contradictory.
 */
export function hasNanoHostUnusedFailedStartAnchorProof(
  coreDb: CoreDb,
  workspaceDb: WorkspaceDb,
  environmentPackage: AgentEnvironmentPackage,
  attemptId: string,
  nativeDb?: Pick<Parameters<typeof getWorkerBackendSession>[0], 'sqlite'>
): boolean {
  if (!nativeDb) return false;
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  const backend = getWorkerBackendSession(nativeDb, attemptId);
  if (
    !backend ||
    backend.state !== 'cleaned' ||
    !backend.physicalCleanedAt ||
    attempt.phase !== 'closed' ||
    attempt.disposition !== 'not_accepted' ||
    attempt.terminalCause !== 'turn-start-failed' ||
    attempt.operationId !== null ||
    attempt.deadline !== null ||
    attempt.outcomeRef !== null ||
    attempt.fenceRef !== null ||
    !hasNanoHostAttemptNoExecutionEvidence(nativeDb.sqlite, attempt)
  )
    return false;
  if (backend.sandboxBindingRef !== attempt.bindingRef) return false;
  assertSessionMatchesAttempt(backend, attempt);
  assertEnvironmentPackageMatchesSession(environmentPackage, backend);
  return (
    !listBackendWorkspaceHandles(workspaceDb, attempt.workspaceId).some(
      (handle) => handle.packageSnapshotId === environmentPackage.snapshotId
    ) &&
    !listWorkspaceMaterializationRecords(workspaceDb, attempt.workspaceId).some(
      (record) => record.packageSnapshotId === environmentPackage.snapshotId
    )
  );
}

/** Proves one failed-start attempt has no remaining execution owner before asking its product owner to finish publication. */
async function settleTerminalFailedStart(
  coreDb: CoreDb,
  attemptId: string,
  store: FsStore,
  input: RunNanoHostAttemptRecoveryInput,
  timestamp: string,
  recovery: AdmittedNanoHostAttemptRecovery
): Promise<boolean> {
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  if (attempt.backendId !== input.executionBackend.id)
    throw new Error('Failed-start attempt names an unavailable backend.');
  if (input.isTurnExecutionActive?.(attempt.turnId)) return false;
  const turn = store.getTurnById(attempt.turnId);
  if (['completed', 'interrupted', 'cancelled'].includes(turn.status)) return false;
  if (!attempt.agentSessionId) {
    if (
      turn.agentSessionId != null ||
      attempt.inputRef !== null ||
      attempt.operationId !== null ||
      attempt.disposition !== 'not_accepted'
    )
      throw new Error('Failed-start preparation has contradictory no-effect lineage.');
    const admission = requireSchedulerAdmissionEntry(coreDb, attempt.queueEntryId);
    if (
      workspaceIdForOwner(turn.owner) !== attempt.workspaceId ||
      turn.threadId !== attempt.threadId ||
      admission.turnId !== turn.id ||
      admission.status !== 'admitted' ||
      admission.requestedAgentId !== turn.agentId ||
      !isDeepStrictEqual(turn.triggerActor, admission.triggerActor)
    )
      throw new Error('Failed-start preparation has contradictory product lineage.');
    await terminalizeGovernedWorkerTurn({
      store,
      turnId: turn.id,
      agentSessionId: null,
      requestId: admission.requestId,
      completedAt: timestamp,
      outcome: 'failed',
      errorCode: turn.error?.code ?? 'worker_governance_turn_failed',
      message: turn.error?.message ?? 'The worker attempt failed to start.',
    });
    return true;
  }
  // An attempt can record a planned successor before the product owner creates or assigns it.
  // Only the Store's explicit not-found result proves absence; other read failures stay fatal.
  const unassigned = turn.agentSessionId == null;
  let session: ReturnType<FsStore['getAgentSession']> | null = null;
  try {
    session = store.getAgentSession(attempt.agentSessionId);
  } catch (error) {
    if (!unassigned || !(error instanceof StoreRecordNotFoundError)) throw error;
  }
  if (unassigned && session)
    throw new Error('Unassigned failed-start preparation already has a product AgentSession.');
  const admission = requireSchedulerAdmissionEntry(coreDb, attempt.queueEntryId);
  const workspaceDb = openAdmittedWorkspaceReadDb(coreDb.dataRoot, attempt.workspaceId);
  const workspace = { db: workspaceDb };
  try {
    if (unassigned) {
      const preparation = JSON.parse(attempt.preparationInputJson);
      if (
        attempt.phase !== 'closed' ||
        !hasAdmittedPreEffectProof(recovery, attempt) ||
        !preparation?.admission ||
        preparation.admission.queueEntryId !== admission.queueEntryId ||
        schedulerAdmissionInputHash(preparation.admission) !== admission.inputHash ||
        schedulerAdmissionInputHash(admission) !== admission.inputHash ||
        admission.backendId !== attempt.backendId ||
        (attempt.inputRef !== null &&
          attempt.inputRef !== `aepsnap_${attempt.turnId}_${attempt.agentSessionId}`) ||
        (attempt.inputRef !== null &&
          findNamedAgentEnvironmentPackageSnapshot(
            workspaceDb,
            attempt.workspaceId,
            attempt.agentSessionId,
            attempt.inputRef
          ) !== null) ||
        readRecovery(
          recovery,
          (sqlite) =>
            sqlite
              .prepare(
                'SELECT 1 FROM worker_backend_sessions WHERE agent_session_id = ? OR turn_id = ? LIMIT 1'
              )
              .get(attempt.agentSessionId, attempt.turnId) ||
            sqlite
              .prepare('SELECT 1 FROM worker_control_records WHERE turn_id = ? LIMIT 1')
              .get(attempt.turnId)
        )
      )
        throw new Error(
          'Unassigned failed-start preparation has unproved input or execution ownership.'
        );
    }
    const pkg =
      session && attempt.inputRef
        ? requireAgentEnvironmentPackageSnapshot(workspaceDb, attempt.workspaceId, attempt.inputRef)
            .snapshot
        : null;
    const sameLineage =
      workspaceIdForOwner(turn.owner) === attempt.workspaceId &&
      turn.threadId === attempt.threadId &&
      [admission, ...(session ? [session] : [])].every(
        (owner) => owner.workspaceId === attempt.workspaceId && owner.threadId === attempt.threadId
      );
    if (
      !sameLineage ||
      (!unassigned && turn.agentSessionId !== attempt.agentSessionId) ||
      admission.turnId !== attempt.turnId ||
      admission.status !== 'admitted' ||
      !admission.requestId ||
      session?.stale ||
      (session && session.agentId !== turn.agentId) ||
      admission.requestedAgentId !== turn.agentId ||
      !isDeepStrictEqual(turn.triggerActor, admission.triggerActor) ||
      (pkg &&
        (pkg.scope.workspaceId !== attempt.workspaceId ||
          pkg.scope.threadId !== attempt.threadId ||
          pkg.scope.turnId !== attempt.turnId ||
          pkg.scope.agentSessionId !== attempt.agentSessionId ||
          pkg.scope.requestId !== admission.requestId ||
          session?.environmentPackageSnapshotId !== attempt.inputRef ||
          pkg.agent.agentId !== turn.agentId ||
          !isDeepStrictEqual(pkg.scope.triggerActor, admission.triggerActor)))
    ) {
      throw new Error('Failed-start product, admission or package lineage disagrees.');
    }
    const competing = coreDb.sqlite
      .prepare(
        `SELECT attempt_id FROM scheduler_execution_attempts WHERE agent_session_id = ? AND attempt_id <> ?
       AND phase <> 'closed'`
      )
      .get(attempt.agentSessionId, attemptId);
    const admissions = coreDb.sqlite
      .prepare('SELECT queue_entry_id FROM scheduler_admission_entries WHERE turn_id = ?')
      .all(attempt.turnId);
    const otherBackend = readRecovery(recovery, (sqlite) =>
      sqlite
        .prepare(
          `SELECT attempt_id FROM worker_backend_sessions WHERE (turn_id = ? OR agent_session_id = ?)
       AND attempt_id <> ? AND state NOT IN ('physical-cleaned', 'cleaned')`
        )
        .get(attempt.turnId, attempt.agentSessionId, attemptId)
    );
    const turns = store.listThreadTurns(attempt.workspaceId, attempt.threadId);
    if (
      // Proved no-effect capacity deferrals share this Turn but hold no execution ownership.
      !hasNanoHostBusySiblingProofs(coreDb, recovery, attempt) ||
      admissions.length !== 1 ||
      competing ||
      otherBackend ||
      turns.some(
        (other) =>
          other.id !== turn.id &&
          other.agentSessionId === attempt.agentSessionId &&
          !['completed', 'failed', 'cancelled', 'interrupted'].includes(other.status)
      )
    )
      throw new Error('Failed-start attempt has a competing execution owner.');
    if (
      readRecovery(recovery, (sqlite) =>
        sqlite
          .prepare(
            "SELECT turn_id FROM worker_control_records WHERE turn_id = ? AND operation = 'final_status'"
          )
          .get(attempt.turnId)
      )
    )
      return false;
    if (
      workspace.db.sqlite
        .prepare('SELECT turn_id FROM worker_turn_checkpoints WHERE turn_id = ?')
        .get(attempt.turnId)
    ) {
      // Preserve checkpoint closeout ownership and report a nonterminal failed start as requiring inspection.
      if (!isSealedTurnTerminal(turn.status))
        throw new Error('Failed-start nonterminal Turn retains checkpoint-owned closeout.');
      return false;
    }
    const observation = attempt.operationId
      ? observeAdmittedAttempt(coreDb, recovery, attemptId)
      : null;
    const bindings = readRecovery(recovery, (sqlite) =>
      sqlite
        .prepare(
          `SELECT workspace_id AS workspaceId, thread_id AS threadId, agent_session_id AS agentSessionId,
       agent_session_compatibility_key AS compatibilityKey,
       lifecycle_state AS lifecycleState, cleanup_state AS cleanupState,
       current_turn_id AS currentTurnId, current_attempt_id AS currentAttemptId
       FROM agent_session_runtime_bindings WHERE agent_session_id = ? OR current_turn_id = ? OR current_attempt_id = ?`
        )
        .all(attempt.agentSessionId, attempt.turnId, attemptId)
    ) as Array<{
      workspaceId: string;
      threadId: string;
      agentSessionId: string;
      compatibilityKey: string;
      lifecycleState: string;
      cleanupState: string;
      currentTurnId: string | null;
      currentAttemptId: string | null;
    }>;
    if (
      bindings.some(
        (binding) =>
          binding.workspaceId !== attempt.workspaceId ||
          binding.threadId !== attempt.threadId ||
          binding.agentSessionId !== attempt.agentSessionId ||
          binding.compatibilityKey !== observation?.proof.sessionCompatibilityKey ||
          binding.currentTurnId !== null ||
          binding.currentAttemptId !== null ||
          !['open', 'closed', 'failed'].includes(binding.lifecycleState) ||
          binding.cleanupState !== 'clean'
      )
    ) {
      throw new Error('Failed-start runtime binding has unproved execution ownership.');
    }
    const { backend, noEffectAnchor } = readRecovery(recovery, (sqlite) => ({
      backend: getWorkerBackendSession({ sqlite }, attemptId),
      // A closed pre-effect attempt may retain only its unused Native preparation anchor.
      noEffectAnchor:
        attempt.phase === 'closed' &&
        attempt.disposition === 'not_accepted' &&
        attempt.operationId === null &&
        attempt.deadline === null &&
        hasNanoHostAttemptNoExecutionEvidence(sqlite, attempt),
    }));
    const native = observation?.attempt;
    if (backend) {
      if (
        !pkg ||
        (!native && !noEffectAnchor) ||
        !attempt.bindingRef ||
        backend.sandboxBindingRef !== attempt.bindingRef ||
        (!noEffectAnchor &&
          (!['physical-cleaned', 'cleaned'].includes(backend.state) ||
            !backend.physicalCleanedAt ||
            backend.workspaceHandoffState !== 'complete'))
      )
        throw new Error('Failed-start backend cleanup is not definite for this exact attempt.');
      assertSessionMatchesAttempt(backend, native ?? attempt);
      assertEnvironmentPackageMatchesSession(pkg, backend);
      const materializationNotPublished =
        noEffectAnchor &&
        !listBackendWorkspaceHandles(workspace.db, attempt.workspaceId).some(
          (handle) => handle.packageSnapshotId === pkg.snapshotId
        ) &&
        !listWorkspaceMaterializationRecords(workspace.db, attempt.workspaceId).some(
          (record) => record.packageSnapshotId === pkg.snapshotId
        );
      if (!materializationNotPublished)
        requireCompleteBackendWorkspaceHandleHandoff(workspace.db, pkg);
    } else if (!hasAdmittedPreEffectProof(recovery, attempt)) {
      throw new Error('Failed-start attempt has no positive pre-effect proof.');
    }
    const deliveryRows = workspace.db.sqlite
      .prepare('SELECT request_id AS requestId FROM pending_requests WHERE delivery_turn_id = ?')
      .all(turn.id) as Array<{ requestId: string }>;
    const outcomes = deliveryRows.map(({ requestId }) => {
      const record = readPendingRequest(workspace.db.sqlite, requestId);
      if (
        !record ||
        record.workspaceId !== attempt.workspaceId ||
        record.threadId !== attempt.threadId ||
        record.agentId !== turn.agentId ||
        record.deliveryCause === null ||
        !['frozen', 'delivered', 'delivery-unknown'].includes(record.delivery)
      ) {
        throw new Error('Failed-start outcome delivery lineage or proof disagrees.');
      }
      return record;
    });
    const unknown = outcomes.some(
      (record) =>
        record.delivery === 'delivery-unknown' ||
        (record.delivery === 'frozen' &&
          (attempt.disposition !== 'not_accepted' || attempt.operationId !== null))
    );
    // A terminal row is a decision, not proof that its session and events were durably published.
    const errorCode =
      turn.status === 'failed'
        ? turn.error?.code
        : unknown
          ? 'delivery_unknown'
          : 'worker_governance_turn_failed';
    const message =
      turn.status === 'failed'
        ? turn.error?.message
        : unknown
          ? 'Outcome delivery could not be proved after the worker failed to start.'
          : 'The worker attempt failed to start.';
    if (!errorCode || !message)
      throw new Error('Failed-start terminal failure has no authoritative diagnostic.');
    const terminalEvents = store
      .getTurnEvents(turn.id)
      .filter((event) => event.event === 'turn.completed');
    // Append-only completion may enlarge the current Item list after the terminal event.
    // Preserve every prior Item and require its canonical owner to prove each addition.
    if (
      terminalEvents.some(
        (event) =>
          event.workspaceId !== workspaceIdForOwner(turn.owner) ||
          event.threadId !== turn.threadId ||
          event.turnId !== turn.id ||
          event.data.type !== 'turn-completed' ||
          event.data.stopReason !== 'error' ||
          !isDeepStrictEqual(
            withoutItemDisplayFields(event.data.turn),
            withoutItemDisplayFields({
              ...turn,
              items: turn.items.slice(0, event.data.turn.items.length),
            })
          ) ||
          !turn.items
            .slice(event.data.turn.items.length)
            .every(
              (item) =>
                pkg !== null &&
                isAlreadyDecidedWorkerMcpItem(workspace.db, pkg, item, turn.completedAt)
            )
      )
    ) {
      throw new Error('Failed-start terminal publication contradicts its decided Turn.');
    }
    if (unknown)
      await store.applyPendingRequestCommand(attempt.workspaceId, {
        action: 'delivery-unknown',
        workspaceId: attempt.workspaceId,
        turnId: turn.id,
        now: timestamp,
      });
    await terminalizeGovernedWorkerTurn({
      store,
      turnId: turn.id,
      agentSessionId: session?.id ?? null,
      requestId: admission.requestId,
      completedAt: timestamp,
      errorCode,
      message,
      outcome: 'failed',
    });
    return true;
  } finally {
    workspace.db.sqlite.close();
  }
}

/**
 * Omits only the store-admitted Item display fields from a terminal snapshot comparison.
 *
 * @param turn Published or currently hydrated Turn.
 * @returns All Turn content and ordered Items with their decided non-display fields intact.
 */
function withoutItemDisplayFields(turn: ReturnType<FsStore['getTurnById']>) {
  return {
    ...turn,
    items: turn.items.map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(
          ([field]) => !DISPLAY_PROJECTION_REFRESH_FIELDS.some((allowed) => allowed === field)
        )
      )
    ),
  };
}

/** Correlates the initial image effect, which precedes Sandbox and Workspace materialization. */
function isInitialImagePreparation(
  attempt: NanoHostExecutionAttemptRecord,
  session: WorkerBackendSessionRecord,
  pkg: AgentEnvironmentPackage
): boolean {
  const image = pkg.runtime.environment
    ? { kind: 'reference' as const, ref: pkg.runtime.environment.imageDigest }
    : pkg.runtime.image;
  if (image.kind === 'reference')
    return (
      attempt.operationId ===
      createNanoHostEffectRequest(session, attempt.attemptId, 'image.acquire', {
        imageReference: image.ref,
      }).requestId
    );
  const request = createNanoHostEffectRequest(session, attempt.attemptId, 'image.build', {
    arguments: image.arguments,
    argumentsDigest: image.argumentsDigest,
    contextDigest: image.contextDigest,
    contextRef: image.contextRef,
    dockerfile: image.input.content,
    dockerfileDigest: image.input.digest,
    egress: image.egress,
    layerLimit: image.layerLimit,
    outputLimitBytes: image.outputLimitBytes,
    timeLimitSeconds: image.timeLimitSeconds,
  });
  return attempt.operationId === request.requestId;
}
