import { join } from 'node:path';

import type { StopReason } from '@openkit/protocol';

import type { FsStore } from '../lib/store.js';
import {
  listSchedulerSessionLeasesForTurn,
  requireSchedulerSessionLeaseAdmissionContext,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  listExportableAgentEnvironmentPackageSnapshots,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import { getGoalRecord, listGoalTasks } from './goal-store.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import {
  clearWorkerCheckpoint,
  getWorkerCheckpoint,
  listRecoverableWorkerCheckpoints,
  parseWorkerCheckpointContextAssembly,
  type WorkerCheckpointContextAssemblySummary,
  type WorkerCheckpointRecord,
} from './worker-checkpoints.js';
import {
  canonicalStopReasonForAcceptedWorkerFinalStatus,
  getWorkerControlAcceptedFinalStatus,
  turnStatusForCanonicalWorkerStopReason,
} from './worker-control-records.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';
import { isTerminalWorkerTurnStage, type WorkerTurnStage } from './worker-stage.js';

/**
 * Worker stages that still need visible recovery materialization.
 */
export type RecoverableWorkerTurnStage = Exclude<WorkerTurnStage, 'completed'>;

/**
 * Read-model row describing a worker turn that was interrupted before terminal save.
 */
export interface InterruptedWorkerStateRecord {
  /** Stable row kind used by App API projections. */
  readonly kind: 'interrupted_worker_state';
  /** Source checkpoint id. */
  readonly checkpointId: string;
  /** Workspace that owns the interrupted worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the interrupted worker turn. */
  readonly threadId: string;
  /** Turn represented by the interrupted state. */
  readonly turnId: string;
  /** Optional goal id associated with the interrupted worker turn. */
  readonly goalId: string | null;
  /** Optional goal task id associated with the interrupted worker turn. */
  readonly taskId: string | null;
  /** Last known recoverable worker stage. */
  readonly stage: RecoverableWorkerTurnStage;
  /** Worker iteration count at the source checkpoint. */
  readonly iteration: number;
  /** Optional host worker session id from the source checkpoint. */
  readonly workerSessionId: string | null;
  /** Optional context package digest from the source checkpoint. */
  readonly contextDigest: string | null;
  /** Product-safe context assembly summary from the source checkpoint. */
  readonly contextAssembly: WorkerCheckpointContextAssemblySummary | null;
  /** Optional stop reason known at interruption time. */
  readonly stopReason: StopReason | null;
  /** Redacted diagnostic summary from the source checkpoint. */
  readonly diagnosticsSummary: string | null;
  /** Interrupted states are visibility records, not replay instructions. */
  readonly replayInstruction: false;
  /** Typed recovery choices available to a user or Coordinator. */
  readonly choices: readonly InterruptedWorkerRecoveryChoice[];
  /** ISO timestamp for recovery materialization. */
  readonly materializedAt: string;
  /** ISO timestamp copied from the source checkpoint update. */
  readonly sourceUpdatedAt: string;
}

/**
 * Typed recovery choice surfaced for an interrupted worker turn.
 */
export type InterruptedWorkerRecoveryChoice =
  | {
      /** Inspect durable state and evidence before choosing a recovery action. */
      readonly kind: 'inspect';
      /** User-facing action label. */
      readonly label: string;
      /** True when this should be the first recovery step. */
      readonly recommended: true;
    }
  | {
      /** Retry the interrupted checkpoint through the existing recovery endpoint. */
      readonly kind: 'retry';
      /** User-facing action label. */
      readonly label: string;
    }
  | {
      /** Ask the user or coordinator how to proceed when evidence is insufficient. */
      readonly kind: 'request_human';
      /** User-facing action label. */
      readonly label: string;
    };

/**
 * Derived authority decision for one interrupted-worker retry request.
 */
export interface InterruptedWorkerRetryDecision {
  /** Whether the exact existing owners permit retry, inspection, or no recovery action. */
  readonly status:
    | 'eligible'
    | 'inspect-only'
    | 'reconnect-pending'
    | 'stale'
    | 'recovery-required';
  /** Exact source checkpoint, or null when no checkpoint exists. */
  readonly checkpoint: WorkerCheckpointRecord | null;
}

/**
 * Input used to clear a checkpoint after terminal state is durably saved.
 */
export interface ClearWorkerCheckpointAfterTerminalStateInput {
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Turn represented by the checkpoint. */
  readonly turnId: string;
}

/**
 * Proves one non-terminal checkpoint was already closed by the generic worker owners.
 *
 * @param coreDb Open Core database containing scheduler and worker-control authority.
 * @param store Product store containing the Turn and Agent Session owners.
 * @param workspaceDb Open workspace database containing the package and checkpoint owners.
 * @param checkpoint Exact request-bound worker checkpoint.
 * @returns Canonical stop reason accepted for the original worker lineage.
 * @throws Error when any durable owner is absent or contradictory.
 */
export function recoverAcceptedWorkerCheckpointStopReason(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  checkpoint: WorkerCheckpointRecord
): StopReason {
  let turn: ReturnType<FsStore['getTurnById']>;
  try {
    turn = store.getTurn(checkpoint.workspaceId, checkpoint.threadId, checkpoint.turnId);
  } catch {
    throw new Error('Worker checkpoint is missing its Turn owner.');
  }
  if (!checkpoint.workerSessionId || turn.agentSessionId !== checkpoint.workerSessionId) {
    throw new Error('Worker checkpoint has no exact Agent Session owner.');
  }

  let agentSession: ReturnType<FsStore['getAgentSession']>;
  try {
    agentSession = store.getAgentSession(checkpoint.workerSessionId);
  } catch {
    throw new Error('Worker checkpoint is missing its Agent Session.');
  }
  if (
    agentSession.workspaceId !== checkpoint.workspaceId ||
    agentSession.threadId !== checkpoint.threadId ||
    !agentSession.environmentPackageSnapshotId
  ) {
    throw new Error('Worker Agent Session contradicts its checkpoint lineage.');
  }

  let environmentPackage: ReturnType<typeof requireAgentEnvironmentPackageSnapshot>['snapshot'];
  try {
    environmentPackage = requireAgentEnvironmentPackageSnapshot(
      workspaceDb,
      checkpoint.workspaceId,
      agentSession.environmentPackageSnapshotId
    ).snapshot;
  } catch {
    throw new Error('Worker checkpoint is missing its environment package.');
  }
  if (
    environmentPackage.scope.userId !== store.getUserId() ||
    environmentPackage.scope.workspaceId !== checkpoint.workspaceId ||
    environmentPackage.scope.threadId !== checkpoint.threadId ||
    environmentPackage.scope.turnId !== checkpoint.turnId ||
    environmentPackage.scope.agentSessionId !== checkpoint.workerSessionId ||
    environmentPackage.scope.requestId !== checkpoint.requestId
  ) {
    throw new Error('Worker environment package contradicts its checkpoint lineage.');
  }

  const leases = listSchedulerSessionLeasesForTurn(coreDb, {
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
  });
  const lease = leases[0];
  if (
    leases.length !== 1 ||
    !lease ||
    lease.agentSessionId !== checkpoint.workerSessionId ||
    lease.packageSnapshotId !== environmentPackage.snapshotId ||
    lease.recoveryState !== null
  ) {
    throw new Error('Worker checkpoint has no exact terminal scheduler lease.');
  }
  const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, lease.leaseId);
  if (admission.userId !== store.getUserId() || admission.requestId !== checkpoint.requestId) {
    throw new Error('Worker scheduler admission contradicts its command owner.');
  }

  const backendSession = getWorkerBackendSession(coreDb, lease.leaseId);
  if (
    !backendSession ||
    backendSession.workspaceId !== checkpoint.workspaceId ||
    backendSession.threadId !== checkpoint.threadId ||
    backendSession.turnId !== checkpoint.turnId ||
    backendSession.agentSessionId !== checkpoint.workerSessionId ||
    backendSession.packageSnapshotId !== environmentPackage.snapshotId ||
    backendSession.workspaceHandoffState !== 'complete' ||
    backendSession.state !== 'cleaned'
  ) {
    throw new Error('Worker checkpoint has no complete backend closeout.');
  }

  const accepted = getWorkerControlAcceptedFinalStatus(coreDb, {
    agentSessionId: checkpoint.workerSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: checkpoint.requestId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
    workspaceId: checkpoint.workspaceId,
  });
  if (!accepted) {
    throw new Error('Worker checkpoint has no accepted final status.');
  }
  const stopReason = canonicalStopReasonForAcceptedWorkerFinalStatus(accepted);
  if (stopReason === 'ask_user') {
    throw new Error('Worker ask_user recovery requires an exact human Gate.');
  }

  const expectedTurnStatus = turnStatusForCanonicalWorkerStopReason(stopReason);
  const expectedLeaseStatus = expectedTurnStatus === 'failed' ? 'failed' : 'released';
  const expectedAgentSessionStatus =
    expectedTurnStatus === 'completed'
      ? 'idle'
      : expectedTurnStatus === 'cancelled'
        ? 'interrupted'
        : 'failed';
  const terminalEvent = store
    .getTurnEvents(checkpoint.turnId)
    .find(
      (event) =>
        event.event === 'turn.completed' &&
        event.data.type === 'turn-completed' &&
        event.data.stopReason === stopReason
    );
  if (
    turn.status !== expectedTurnStatus ||
    agentSession.status !== expectedAgentSessionStatus ||
    lease.status !== expectedLeaseStatus ||
    !terminalEvent
  ) {
    throw new Error('Worker generic closeout contradicts its accepted final status.');
  }
  return stopReason;
}

/**
 * Materializes only checkpoints whose existing owners prove an interrupted worker closeout.
 *
 * @param coreDb Open Core database handle containing scheduler authority.
 * @param store App-local product Turn and Agent Session store.
 * @param workspaceDb Open workspace-scope database handle.
 * @returns Interrupted worker state rows for visible restart recovery.
 */
export function materializeInterruptedWorkerStates(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb
): InterruptedWorkerStateRecord[] {
  const materializedAt = new Date().toISOString();

  return listRecoverableWorkerCheckpoints(workspaceDb).flatMap((checkpoint) => {
    const decision = resolveInterruptedWorkerRetryDecision(coreDb, store, workspaceDb, {
      workspaceId: checkpoint.workspaceId,
      threadId: checkpoint.threadId,
      turnId: checkpoint.turnId,
    });

    return decision.status === 'eligible' || decision.status === 'inspect-only'
      ? [createInterruptedWorkerState(checkpoint, materializedAt, decision.status === 'eligible')]
      : [];
  });
}

/**
 * Derives retry authority from the exact checkpoint, product, and scheduler owners.
 *
 * @param coreDb Open Core database handle containing scheduler authority.
 * @param store App-local product Turn and Agent Session store.
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Exact Workspace, Thread, and Turn lineage.
 * @returns One non-durable retry authority decision and its source checkpoint when present.
 */
export function resolveInterruptedWorkerRetryDecision(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string }
): InterruptedWorkerRetryDecision {
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  if (!checkpoint) {
    return { status: 'recovery-required', checkpoint: null };
  }

  let turn: ReturnType<FsStore['getTurn']>;
  try {
    turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  } catch {
    return { status: 'recovery-required', checkpoint };
  }

  const agentSessionId = checkpoint.workerSessionId;
  if (!agentSessionId || turn.agentSessionId !== agentSessionId) {
    return { status: 'recovery-required', checkpoint };
  }

  let agentSession: ReturnType<FsStore['getAgentSession']>;
  try {
    agentSession = store.getAgentSession(agentSessionId);
  } catch {
    return { status: 'recovery-required', checkpoint };
  }
  if (agentSession.workspaceId !== input.workspaceId || agentSession.threadId !== input.threadId) {
    return { status: 'recovery-required', checkpoint };
  }

  const leases = listSchedulerSessionLeasesForTurn(coreDb, input);
  if (leases.length !== 1 || leases[0]?.agentSessionId !== agentSessionId) {
    return { status: 'recovery-required', checkpoint };
  }
  const lease = leases[0];

  if (
    (lease.status === 'active' || lease.status === 'idle') &&
    lease.recoveryState === 'awaiting-reconnect'
  ) {
    return { status: 'reconnect-pending', checkpoint };
  }
  if (['acquired', 'starting', 'active', 'idle'].includes(lease.status)) {
    return { status: 'stale', checkpoint };
  }

  if (
    (checkpoint.stage !== 'preparing' && checkpoint.stage !== 'running_worker') ||
    checkpoint.stopReason !== null ||
    turn.status !== 'interrupted' ||
    agentSession.status !== 'interrupted' ||
    lease.status !== 'released' ||
    lease.recoveryState !== null ||
    lease.releaseReason !== 'scheduler-restart-backend-cleanup'
  ) {
    return { status: 'recovery-required', checkpoint };
  }

  if (checkpoint.goalId === null && checkpoint.taskId === null) {
    return { status: 'eligible', checkpoint };
  }
  if (checkpoint.goalId === null || checkpoint.taskId === null) {
    return { status: 'inspect-only', checkpoint };
  }

  const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, checkpoint.goalId);
  const task = goal
    ? listGoalTasks(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: checkpoint.goalId,
      }).find((candidate) => candidate.taskId === checkpoint.taskId)
    : null;

  return goal?.status === 'running' &&
    goal.currentTaskId === checkpoint.taskId &&
    task?.status === 'running'
    ? { status: 'eligible', checkpoint }
    : { status: 'inspect-only', checkpoint };
}

/**
 * Clears one checkpoint after its terminal worker state has been durably saved.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Cleanup input identifying the stored checkpoint.
 * @returns True when a checkpoint row was deleted.
 */
export async function clearWorkerCheckpointAfterTerminalState(
  workspaceDb: WorkspaceDb,
  input: ClearWorkerCheckpointAfterTerminalStateInput
): Promise<boolean> {
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  if (!checkpoint || !isTerminalWorkerTurnStage(checkpoint.stage)) {
    return false;
  }
  const environmentPackage = listExportableAgentEnvironmentPackageSnapshots(
    workspaceDb,
    input.workspaceId
  ).find(
    (record) =>
      record.turnId === input.turnId &&
      (!checkpoint.workerSessionId || record.agentSessionId === checkpoint.workerSessionId)
  )?.snapshot;
  if (environmentPackage?.control.transcript?.runtimeProvenance) {
    const rawBundle = workspaceDb.sqlite
      .prepare(
        `SELECT evidence_bundle_id, backend_type, created_at
        FROM evidence_bundles
        WHERE workspace_id = ?
          AND thread_id = ?
          AND turn_id = ?
          AND agent_session_id = ?
          AND source_kind = 'worker-runtime-provenance-raw'
        LIMIT 1`
      )
      .get(
        input.workspaceId,
        input.threadId,
        input.turnId,
        environmentPackage.scope.agentSessionId
      ) as
      | { evidence_bundle_id: string; backend_type: string | null; created_at: string }
      | undefined;
    if (!rawBundle) {
      throw new Error('Required retained runtime provenance is missing.');
    }
    const runtime = workspaceDb.sqlite
      .prepare(
        `SELECT backend_version, placement
        FROM runtime_evidence
        WHERE workspace_id = ?
          AND turn_id = ?
          AND agent_session_id = ?
          AND phase = 'transcript-collection'
        LIMIT 1`
      )
      .get(input.workspaceId, input.turnId, environmentPackage.scope.agentSessionId) as
      | { backend_version: string | null; placement: 'local' | 'remote' | 'unknown' }
      | undefined;
    const workspaceRoot = join(
      workspaceDb.dataRoot,
      'users',
      workspaceDb.userId,
      'workspaces',
      workspaceDb.workspaceId
    );
    const rawRoot = join(workspaceRoot, 'evidence', 'backend', rawBundle.evidence_bundle_id);
    const verified = await importWorkerRuntimeProvenance({
      backend: {
        kind: rawBundle.backend_type ?? environmentPackage.backend.preferred,
        placement: runtime?.placement ?? 'unknown',
        version: runtime?.backend_version ?? null,
      },
      capture: {
        nativeOriginIndexPath: join(rawRoot, 'native-origin-index.jsonl'),
        rawStreamsRoot: join(rawRoot, 'raw'),
        streamManifestPath: join(rawRoot, 'raw-streams.json'),
      },
      collectedAt: rawBundle.created_at,
      environmentPackage,
      workspaceDb,
      workspaceRoot,
    }).catch(() => {
      throw new Error('Required retained runtime provenance verification failed.');
    });
    if (!verified.complete) {
      throw new Error('Required retained runtime provenance verification failed.');
    }
  }

  return clearWorkerCheckpoint(workspaceDb, input.workspaceId, input.threadId, input.turnId);
}

/**
 * Creates one interrupted worker state row from a source checkpoint.
 *
 * @param checkpoint Source pending worker checkpoint.
 * @param materializedAt ISO timestamp for recovery materialization.
 * @param retryAvailable Whether the exact Goal or Task continuation owner permits retry.
 * @returns Interrupted worker read-model row.
 */
function createInterruptedWorkerState(
  checkpoint: WorkerCheckpointRecord,
  materializedAt: string,
  retryAvailable: boolean
): InterruptedWorkerStateRecord {
  return {
    kind: 'interrupted_worker_state',
    checkpointId: checkpoint.checkpointId,
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
    goalId: checkpoint.goalId,
    taskId: checkpoint.taskId,
    stage: checkpoint.stage as RecoverableWorkerTurnStage,
    iteration: checkpoint.iteration,
    workerSessionId: checkpoint.workerSessionId,
    contextDigest: checkpoint.contextDigest,
    contextAssembly: parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary),
    stopReason: checkpoint.stopReason,
    diagnosticsSummary: checkpoint.diagnosticsSummary,
    replayInstruction: false,
    choices: createInterruptedWorkerRecoveryChoices(retryAvailable),
    materializedAt,
    sourceUpdatedAt: checkpoint.updatedAt,
  };
}

/**
 * Creates the V1 typed recovery choices for an interrupted worker checkpoint.
 *
 * @param retryAvailable Whether the existing business owner permits retry.
 * @returns Product-safe recovery choices.
 */
function createInterruptedWorkerRecoveryChoices(
  retryAvailable: boolean
): readonly InterruptedWorkerRecoveryChoice[] {
  const choices: InterruptedWorkerRecoveryChoice[] = [
    {
      kind: 'inspect',
      label: 'Inspect interrupted worker evidence',
      recommended: true,
    },
    {
      kind: 'request_human',
      label: 'Ask the user how to recover this worker turn',
    },
  ];

  if (retryAvailable) {
    choices.splice(1, 0, {
      kind: 'retry',
      label: 'Retry interrupted worker turn',
    });
  }

  return choices;
}
