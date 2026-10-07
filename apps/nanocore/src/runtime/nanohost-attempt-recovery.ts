import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { isSealedTurnTerminal } from '@openkit/protocol';
import { recordServerAuditEvent } from '../audit-events.js';
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
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { isAlreadyDecidedWorkerMcpItem } from '../worker-mcp-routes.js';
import {
  findNamedAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import {
  closeSchedulerExecutionAttemptWithFence,
  listOpenSchedulerExecutionAttempts,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import {
  type NanoHostExecutionAttemptRecord,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
import { createNanoHostEffectRequest } from './nanohost-effect-identity.js';
import { markFrozenDeliveryUnknown, readPendingRequest } from './pending-requests.js';
import type { RunSchedulerRestartRecoveryInput } from './scheduler-restart-recovery.js';
import { projectWorkerBackendCleanup } from './worker-backend-cleanup-projection.js';
import {
  getWorkerBackendSession,
  listWorkerBackendSessions,
  markWorkerBackendWorkspaceHandoffComplete,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
  workerBackendImageIdentity,
} from './worker-backend-sessions.js';
import { getWorkerControlAcceptedFinalStatus } from './worker-control-records.js';
import type { WorkerGovernanceBackendSessionIdentity } from './worker-governance-backend.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import {
  listWorkspaceReconciliationRecords,
  recordWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceMaterializationRecords,
  requireCompleteBackendWorkspaceHandleHandoff,
} from './workspace-sync-records.js';

/** NanoHost-only recovery uses the existing physical cleanup and full accepted-final closeout owners. */
export interface RunNanoHostAttemptRecoveryInput extends RunSchedulerRestartRecoveryInput {
  readonly cleanupBackendSession: (
    session: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
  readonly prepareBackendCleanup: (session: WorkerGovernanceBackendSessionIdentity) => void;
  readonly restoreBackendSession: (session: WorkerBackendSessionRecord) => Promise<void>;
  readonly reconcileAcceptedFinalStatus: (session: WorkerBackendSessionRecord) => Promise<unknown>;
}
interface RecoveryWorkspace {
  readonly db: WorkspaceDb;
  readonly environmentPackage: AgentEnvironmentPackage;
}

/** Classifies native survivors before listen without delivering or replaying a backend operation. */
export async function classifyNanoHostAttemptsAfterRestart(
  coreDb: CoreDb,
  input: RunNanoHostAttemptRecoveryInput
): Promise<void> {
  const errors: unknown[] = [];
  const timestamp = input.now?.() ?? new Date().toISOString();
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    if (!attempt.operationId) continue;
    try {
      const session = getWorkerBackendSession(coreDb, attempt.attemptId);
      if (!session) continue; // Original operation remains unknown; absence is not a fence.
      const native = requireNanoHostExecutionAttempt(coreDb, attempt.attemptId);
      assertSessionMatchesAttempt(session, native);
      const eligible =
        native.phase === 'open' &&
        native.deadline !== null &&
        native.deadline > timestamp &&
        session.state === 'launching' &&
        session.workspaceHandoffState === 'complete' &&
        native.lastWorkerSequence !== null &&
        native.lastWorkerSequence >= 1 &&
        native.workerProcessKeyHash !== null &&
        (native.recoveryState === null || native.recoveryState === 'awaiting-reconnect') &&
        (native.recoveryDeadline === null || native.recoveryDeadline > timestamp);
      if (eligible) {
        try {
          await input.restoreBackendSession(session);
          const deadline =
            native.recoveryDeadline ??
            new Date(
              Math.min(Date.parse(native.deadline!), Date.parse(timestamp) + 300_000)
            ).toISOString();
          const armed = coreDb.sqlite
            .prepare(
              `UPDATE scheduler_execution_attempts SET recovery_state = 'awaiting-reconnect', recovery_deadline = ? WHERE attempt_id = ? AND phase = 'open' AND recovery_deadline IS ?`
            )
            .run(deadline, attempt.attemptId, native.recoveryDeadline);
          if (armed.changes !== 1) throw new Error('Native reconnect ownership changed.');
          continue;
        } catch {
          /* Unrestorable native identity belongs to the existing cleanup owner. */
        }
      }
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: attempt.attemptId,
        cause: 'restart-native-recovery',
        ...(input.now ? { now: input.now } : {}),
      });
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET recovery_state = 'needs-evidence' WHERE attempt_id = ? AND phase = 'closing'"
        )
        .run(attempt.attemptId);
      if (!['physical-cleaned', 'cleaned'].includes(session.state)) {
        const fenced = moveSessionToCleanupPending(coreDb, session, timestamp);
        input.prepareBackendCleanup(toRestartBackendIdentity(fenced));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Native restart classification failed.');
}

/** Drives exact original native cleanup after listen; product barriers remain with the executor owner. */
export async function runNanoHostAttemptRecoveryMaintenance(
  coreDb: CoreDb,
  input: RunNanoHostAttemptRecoveryInput
): Promise<void> {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const now = input.now ?? (() => new Date().toISOString());
  const errors: unknown[] = [];
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
    try {
      let session = getWorkerBackendSession(coreDb, attempt.attemptId);
      if (!session || !attempt.agentSessionId || !attempt.inputRef) continue;
      const native = requireNanoHostExecutionAttempt(coreDb, attempt.attemptId);
      assertSessionMatchesAttempt(session, native);
      const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, attempt.attemptId);
      const final = getWorkerControlAcceptedFinalStatus(coreDb, {
        agentSessionId: native.agentSessionId,
        packageSnapshotId: native.inputRef,
        requestId: admission.requestId,
        threadId: native.threadId,
        turnId: native.turnId,
        workspaceId: native.workspaceId,
      });
      if (final) {
        if (!input.isTurnExecutionActive?.(attempt.turnId))
          await input.reconcileAcceptedFinalStatus(session);
        continue;
      }
      if (
        native.phase === 'open' &&
        native.recoveryState === 'awaiting-reconnect' &&
        native.recoveryDeadline !== null &&
        native.recoveryDeadline > timestamp &&
        native.deadline !== null &&
        native.deadline > timestamp
      )
        continue;
      const livenessExpired =
        native.lastAcceptedHeartbeatAt === null
          ? native.startupDeadline <= timestamp
          : native.heartbeatDeadline <= timestamp;
      if (native.phase === 'open' && !livenessExpired && native.recoveryState !== 'needs-evidence')
        continue;
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: attempt.attemptId,
        cause: livenessExpired ? 'native-liveness-expired' : 'native-cleanup',
        now,
      });
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
        const anyHandoffRows =
          listBackendWorkspaceHandles(workspace.db, native.workspaceId).some(
            (handle) => handle.packageSnapshotId === native.inputRef
          ) ||
          listWorkspaceMaterializationRecords(workspace.db, native.workspaceId).some(
            (record) => record.packageSnapshotId === native.inputRef
          );
        // Handoff publication does not invalidate the original proof.
        // Release failure or Core exit before attempt closure leaves this same empty package to finish next pass.
        const materializationNotPublished =
          !anyHandoffRows &&
          native.deadline === null &&
          ['execution-failed', 'turn-start-failed'].includes(native.terminalCause ?? '') &&
          ['physical-cleaned', 'cleaned'].includes(session.state) &&
          session.physicalCleanedAt !== null &&
          isInitialImagePreparation(native, session, workspace.environmentPackage);
        if (
          !materializationNotPublished &&
          session.workspaceHandoffState === 'pending' &&
          !anyHandoffRows &&
          workspace.environmentPackage.workspace.inputs.length > 0
        ) {
          // Empty tables do not prove no materialization.
          // Preserve the existing inspection classification without retrying unchanged unknown cleanup on every maintenance pass.
          coreDb.sqlite
            .prepare(
              "UPDATE scheduler_execution_attempts SET recovery_state = 'needs-evidence' WHERE attempt_id = ? AND phase = 'closing'"
            )
            .run(native.attemptId);
          continue;
        }
        if (
          !materializationNotPublished &&
          recordWorkspaceRecoveryEvaluation(
            workspace.db,
            native,
            workspace.environmentPackage,
            timestamp,
            ['physical-cleaned', 'cleaned'].includes(session.state)
          )
        )
          continue;
        session = await cleanupPhysicalSession(coreDb, session, now, input.cleanupBackendSession);
        const projection = projectCleanup(
          workspace.db,
          session,
          workspace.environmentPackage,
          materializationNotPublished
        );
        if (!projection.workspaceHandoffComplete)
          throw new Error('Native cleanup workspace handoff is incomplete.');
        if (session.workspaceHandoffState === 'pending')
          session = markWorkerBackendWorkspaceHandoffComplete(coreDb, {
            attemptId: attempt.attemptId,
            now,
          });
      } finally {
        workspace.db.sqlite.close();
      }
      let settled = false;
      if (native.terminalCause === 'turn-start-failed' && input.store) {
        settled = await settleTerminalFailedStart(
          coreDb,
          native.attemptId,
          input.store,
          input,
          timestamp
        );
      } else {
        await input.projectRecoveredTurn(session);
        settled =
          input.store !== undefined &&
          hasRecoveredTerminalHandoff(input.store, session, workspace.environmentPackage);
      }
      if (session.state === 'physical-cleaned')
        session = transitionWorkerBackendSessionState(coreDb, {
          fromState: 'physical-cleaned',
          attemptId: attempt.attemptId,
          toState: 'cleaned',
          now,
        });
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
          ? markSchedulerExecutionAttemptClosing(coreDb, {
              attemptId: native.attemptId,
              cause: `turn-${terminal.status}`,
              outcomeRef: `turn:${terminal.id}:${terminal.status}`,
              now,
            })
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
        closeSchedulerExecutionAttemptWithFence(coreDb, {
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
  for (const session of listWorkerBackendSessions(coreDb)) {
    if (session.state === 'cleaned') continue;
    try {
      const owner = requireSchedulerExecutionAttempt(coreDb, session.attemptId);
      if (owner.phase !== 'closed') continue;
      const cleaned = await cleanupPhysicalSession(
        coreDb,
        session,
        now,
        input.cleanupBackendSession
      );
      if (cleaned.state === 'physical-cleaned')
        coreDb.sqlite
          .transaction(() => {
            transitionWorkerBackendSessionState(coreDb, {
              fromState: 'physical-cleaned',
              attemptId: cleaned.attemptId,
              toState: 'cleaned',
              now,
            });
            recordServerAuditEvent({
              action: 'scheduler.orphan-backend-retired',
              category: 'system',
              coreDb,
              outcome: 'succeeded',
              resource: `server:worker-backend-session:${cleaned.attemptId}`,
              severity: 'warning',
              summary: 'Unowned worker backend session physically cleaned and retired.',
              workspaceId: cleaned.workspaceId,
              threadId: cleaned.threadId,
              turnId: cleaned.turnId,
              agentSessionId: cleaned.agentSessionId,
            });
          })
          .immediate();
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
      .prepare(`SELECT attempt_id AS attemptId, workspace_id AS workspaceId,
      thread_id AS threadId, turn_id AS turnId, agent_session_id AS agentSessionId
      FROM scheduler_execution_attempts WHERE phase = 'closed' AND terminal_cause = 'turn-start-failed'
      ORDER BY rowid`)
      .all() as Array<
      Pick<
        SchedulerExecutionAttemptRecord,
        'attemptId' | 'workspaceId' | 'threadId' | 'turnId' | 'agentSessionId'
      >
    >;
    for (const attempt of failedStarts) {
      try {
        await settleTerminalFailedStart(coreDb, attempt.attemptId, input.store, input, timestamp);
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

/** Cleans one exact durable physical identity and records the stable completion instant. */
async function cleanupPhysicalSession(
  coreDb: CoreDb,
  originalSession: WorkerBackendSessionRecord,
  now: () => string,
  cleanupBackendSession: RunNanoHostAttemptRecoveryInput['cleanupBackendSession']
): Promise<WorkerBackendSessionRecord> {
  if (['physical-cleaned', 'cleaned'].includes(originalSession.state)) {
    return originalSession;
  }
  let session =
    originalSession.state === 'cleanup-failed'
      ? originalSession
      : moveSessionToCleanupPending(coreDb, originalSession, now());
  if (!cleanupBackendSession) {
    throw new Error('Scheduler restart recovery requires a backend cleanup implementation.');
  }
  try {
    await cleanupBackendSession(toRestartBackendIdentity(session));
  } catch (error) {
    if (session.state === 'cleanup-pending') {
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        attemptId: session.attemptId,
        now,
        toState: 'cleanup-failed',
      });
    }
    throw error;
  }
  if (session.state === 'cleanup-failed') {
    session = moveSessionToCleanupPending(coreDb, session, now());
  }
  return transitionWorkerBackendSessionState(coreDb, {
    fromState: 'cleanup-pending',
    attemptId: session.attemptId,
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
  const db = openWorkspaceDb(coreDb.dataRoot, row.workspaceId);
  try {
    applyScopedMigrations(db);
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
    attemptId: session.attemptId,
    now: () => timestamp,
    toState: 'cleanup-pending',
  });
}

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
  row: NanoHostExecutionAttemptRecord
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
    turn.workspaceId !== backend.workspaceId ||
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
 * @returns Whether no native execution evidence or competing binding remains.
 * @throws Error when the exact generic attempt is absent or invalid.
 */
export function hasNanoHostAttemptPreEffectProof(coreDb: CoreDb, attemptId: string): boolean {
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  const nativeProof = coreDb.sqlite
    .prepare(`SELECT last_accepted_heartbeat_at, last_worker_sequence, worker_process_key_hash,
      worker_control_token_hash, worker_inference_token_hash, worker_capability_token_hash
      FROM scheduler_execution_attempts WHERE attempt_id = ?`)
    .get(attemptId) as Record<string, string | number | null>;
  const binding = coreDb.sqlite
    .prepare(`SELECT 1 FROM agent_session_runtime_bindings
      WHERE agent_session_id = ? OR current_turn_id = ? OR current_attempt_id = ? LIMIT 1`)
    .get(attempt.agentSessionId, attempt.turnId, attemptId);
  return (
    attempt.disposition === 'not_accepted' &&
    attempt.operationId === null &&
    !getWorkerBackendSession(coreDb, attemptId) &&
    !binding &&
    Object.values(nativeProof).every((value) => value === null)
  );
}

/** Proves one failed-start attempt has no remaining execution owner before asking its product owner to finish publication. */
async function settleTerminalFailedStart(
  coreDb: CoreDb,
  attemptId: string,
  store: FsStore,
  input: RunNanoHostAttemptRecoveryInput,
  timestamp: string
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
      turn.workspaceId !== attempt.workspaceId ||
      turn.threadId !== attempt.threadId ||
      admission.turnId !== turn.id ||
      admission.status !== 'admitted' ||
      admission.requestedAgentId !== turn.agentId ||
      !isDeepStrictEqual(turn.triggerActor, admission.triggerActor)
    )
      throw new Error('Failed-start preparation has contradictory product lineage.');
    terminalizeGovernedWorkerTurn({
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
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, attempt.workspaceId);
  const workspace = { db: workspaceDb };
  try {
    applyScopedMigrations(workspaceDb);
    if (unassigned) {
      const preparation = JSON.parse(attempt.preparationInputJson);
      if (
        attempt.phase !== 'closed' ||
        !hasNanoHostAttemptPreEffectProof(coreDb, attemptId) ||
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
        coreDb.sqlite
          .prepare(
            'SELECT 1 FROM worker_backend_sessions WHERE agent_session_id = ? OR turn_id = ? LIMIT 1'
          )
          .get(attempt.agentSessionId, attempt.turnId) ||
        coreDb.sqlite
          .prepare('SELECT 1 FROM worker_control_records WHERE turn_id = ? LIMIT 1')
          .get(attempt.turnId)
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
    const sameLineage = [turn, admission, ...(session ? [session] : [])].every(
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
    const attempts = coreDb.sqlite
      .prepare('SELECT attempt_id FROM scheduler_execution_attempts WHERE turn_id = ?')
      .all(attempt.turnId);
    const competing = coreDb.sqlite
      .prepare(
        `SELECT attempt_id FROM scheduler_execution_attempts WHERE agent_session_id = ? AND attempt_id <> ?
       AND phase <> 'closed'`
      )
      .get(attempt.agentSessionId, attemptId);
    const admissions = coreDb.sqlite
      .prepare('SELECT queue_entry_id FROM scheduler_admission_entries WHERE turn_id = ?')
      .all(attempt.turnId);
    const otherBackend = coreDb.sqlite
      .prepare(
        `SELECT attempt_id FROM worker_backend_sessions WHERE (turn_id = ? OR agent_session_id = ?)
       AND attempt_id <> ? AND state NOT IN ('physical-cleaned', 'cleaned')`
      )
      .get(attempt.turnId, attempt.agentSessionId, attemptId);
    const turns = store.listThreadTurns(attempt.workspaceId, attempt.threadId);
    if (
      attempts.length !== 1 ||
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
      workspace.db.sqlite
        .prepare('SELECT turn_id FROM worker_turn_checkpoints WHERE turn_id = ?')
        .get(attempt.turnId) ||
      coreDb.sqlite
        .prepare(
          "SELECT turn_id FROM worker_control_records WHERE turn_id = ? AND operation = 'final_status'"
        )
        .get(attempt.turnId)
    )
      return false;
    const nativeProof = coreDb.sqlite
      .prepare(`SELECT session_compatibility_key AS sessionCompatibilityKey
      FROM scheduler_execution_attempts WHERE attempt_id = ?`)
      .get(attemptId) as { sessionCompatibilityKey: string | null };
    const bindings = coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId, thread_id AS threadId, agent_session_id AS agentSessionId,
       agent_session_compatibility_key AS compatibilityKey,
       lifecycle_state AS lifecycleState, cleanup_state AS cleanupState,
       current_turn_id AS currentTurnId, current_attempt_id AS currentAttemptId
       FROM agent_session_runtime_bindings WHERE agent_session_id = ? OR current_turn_id = ? OR current_attempt_id = ?`
      )
      .all(attempt.agentSessionId, attempt.turnId, attemptId) as Array<{
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
          binding.compatibilityKey !== nativeProof.sessionCompatibilityKey ||
          binding.currentTurnId !== null ||
          binding.currentAttemptId !== null ||
          !['open', 'closed', 'failed'].includes(binding.lifecycleState) ||
          binding.cleanupState !== 'clean'
      )
    ) {
      throw new Error('Failed-start runtime binding has unproved execution ownership.');
    }
    const backend = getWorkerBackendSession(coreDb, attemptId);
    if (backend) {
      if (
        !pkg ||
        !attempt.bindingRef ||
        backend.sandboxBindingRef !== attempt.bindingRef ||
        !['physical-cleaned', 'cleaned'].includes(backend.state) ||
        !backend.physicalCleanedAt ||
        backend.workspaceHandoffState !== 'complete'
      )
        throw new Error('Failed-start backend cleanup is not definite for this exact attempt.');
      assertSessionMatchesAttempt(backend, requireNanoHostExecutionAttempt(coreDb, attemptId));
      assertEnvironmentPackageMatchesSession(pkg, backend);
      requireCompleteBackendWorkspaceHandleHandoff(workspace.db, pkg);
    } else if (!hasNanoHostAttemptPreEffectProof(coreDb, attemptId)) {
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
          event.workspaceId !== turn.workspaceId ||
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
    if (unknown) markFrozenDeliveryUnknown(workspace.db.sqlite, turn.id, timestamp);
    terminalizeGovernedWorkerTurn({
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

/** Evaluates stale Workspace ownership before teardown, preserving the existing synchronization decision ledger. */
function recordWorkspaceRecoveryEvaluation(
  db: WorkspaceDb,
  attempt: NanoHostExecutionAttemptRecord,
  environmentPackage: AgentEnvironmentPackage,
  timestamp: string,
  physicallyCleaned: boolean
): boolean {
  const handles = requireCompleteBackendWorkspaceHandleHandoff(db, environmentPackage);
  const existing = new Set(
    listWorkspaceReconciliationRecords(db, attempt.workspaceId).map((record) => record.id)
  );
  for (const handle of handles) {
    const id = `wrr_${attempt.attemptId}_${handle.id}`;
    if (handle.cleanupStatus !== 'pending' || existing.has(id)) continue;
    recordWorkspaceReconciliationRecord(db, {
      affectedRecordIds: [handle.materializationRecordId, handle.id],
      backendHandleSummary: {
        backendKind: handle.backendKind,
        cleanupStatus: handle.cleanupStatus,
        handleId: handle.id,
        workerSessionId: handle.workerSessionId,
      },
      backendReachability: {
        checkedAt: timestamp,
        detail: attempt.terminalCause,
        status: 'unavailable',
      },
      collectedOutputManifestIds: [],
      evidenceBundleIds: [`evb_workspace_materialization_${handle.materializationRecordId}`],
      finishedAt: null,
      id,
      quarantineRefs: [],
      requiredHumanDecision: 'inspect_recovery',
      retentionDecision: physicallyCleaned ? 'teardown-backend' : 'retain-backend',
      startedAt: timestamp,
      stateAfter: 'requires-human',
      stateBefore: attempt.phase,
      triggerReason: 'backend_takeover',
      workspaceId: attempt.workspaceId,
    });
  }
  return (
    !physicallyCleaned &&
    listWorkspaceReconciliationRecords(db, attempt.workspaceId).some(
      (record) =>
        record.stateAfter === 'requires-human' &&
        record.retentionDecision === 'retain-backend' &&
        handles.some((handle) => record.affectedRecordIds.includes(handle.id))
    )
  );
}
