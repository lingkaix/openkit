import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { StopReason } from '@openkit/protocol';

import { type FsStore, projectTurnEventRequestId } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  listExportableAgentEnvironmentPackageSnapshots,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import {
  isSchedulerExecutionBusyRefusal,
  listSchedulerExecutionAttemptsForTurn,
} from './execution-attempt-records.js';
import {
  clearWorkerCheckpoint,
  getWorkerCheckpoint,
  listRecoverableWorkerCheckpoints,
  parseWorkerCheckpointContextAssembly,
  type WorkerCheckpointContextAssemblySummary,
  type WorkerCheckpointRecord,
} from './worker-checkpoints.js';
import { turnStatusForCanonicalWorkerStopReason } from './worker-control-records.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';
import {
  isTerminalWorkerTurnStage,
  type WorkerTurnStage,
  workerTurnStageForStopReason,
} from './worker-stage.js';

/**
 * Worker stages that still need visible recovery materialization.
 */
export type RecoverableWorkerTurnStage = Exclude<WorkerTurnStage, 'completed'>;

/**
 * Resolves the initiating human command scope for one exact worker checkpoint.
 *
 * @param coreDb Core database containing scheduler admission lineage.
 * @param checkpoint Worker checkpoint whose initiating command is being verified.
 * @returns Human actor, Workspace, and Thread command scope.
 * @throws Error when scheduler ownership or the human trigger identity is absent or contradictory.
 */
export function requireWorkerCheckpointHumanCommandScope(
  coreDb: CoreDb,
  checkpoint: WorkerCheckpointRecord
): { readonly actorId: string; readonly threadId: string; readonly workspaceId: string } {
  const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, {
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
  }).filter((attempt) => !isSchedulerExecutionBusyRefusal(attempt));
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt || attempt.agentSessionId !== checkpoint.workerSessionId) {
    throw new Error('Worker checkpoint has no exact execution attempt.');
  }

  const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, attempt.attemptId);
  if (admission.requestId !== checkpoint.requestId || admission.triggerActor.kind !== 'user') {
    throw new Error('Worker checkpoint has no exact human command identity.');
  }

  return {
    actorId: admission.triggerActor.id,
    threadId: checkpoint.threadId,
    workspaceId: checkpoint.workspaceId,
  };
}

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
  /**
   * Skips runtime-provenance re-import for one proved boot leftover.
   *
   * Only the stale direct-Task classifier sets this, and only after a null
   * worker session plus one closed, definite pre-effect failed-start attempt. Skipping does not claim provenance is complete or that no Worker ran.
   */
  readonly skipRuntimeProvenance?: boolean;
}

/**
 * Derives one checkpoint outcome from the exact released attempt and canonical product owner tuple.
 *
 * @param coreDb Open Core database containing exact scheduler execution authority.
 * @param store Product store containing the Turn and AgentSession owners.
 * @param workspaceDb Open workspace database containing the package and checkpoint owners.
 * @param checkpoint Exact request-bound worker checkpoint.
 * @returns Canonical stop reason accepted for the original worker lineage.
 * @throws Error when any durable owner is absent or contradictory.
 */
export function recoverWorkerCheckpointStopReason(
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
    throw new Error('Worker checkpoint has no exact AgentSession owner.');
  }

  let agentSession: ReturnType<FsStore['getAgentSession']>;
  try {
    agentSession = store.getAgentSession(checkpoint.workerSessionId);
  } catch {
    throw new Error('Worker checkpoint is missing its AgentSession.');
  }
  if (
    agentSession.workspaceId !== checkpoint.workspaceId ||
    agentSession.threadId !== checkpoint.threadId ||
    turn.agentId !== agentSession.agentId
  ) {
    throw new Error('Worker AgentSession contradicts its checkpoint lineage.');
  }

  const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, {
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
  }).filter((attempt) => !isSchedulerExecutionBusyRefusal(attempt));
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt || attempt.agentSessionId !== checkpoint.workerSessionId) {
    throw new Error('Worker checkpoint has no exact execution attempt.');
  }
  const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, attempt.attemptId);
  if (admission.requestId !== checkpoint.requestId) {
    throw new Error('Worker scheduler admission contradicts its command owner.');
  }

  let stopReason = checkpoint.stopReason;
  if (stopReason && checkpoint.stage !== workerTurnStageForStopReason(stopReason)) {
    throw new Error('Worker checkpoint contradicts its recorded StopReason.');
  }
  if (agentSession.environmentPackageSnapshotId) {
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
      !isDeepStrictEqual(environmentPackage.scope.triggerActor, admission.triggerActor) ||
      environmentPackage.scope.workspaceId !== checkpoint.workspaceId ||
      environmentPackage.scope.threadId !== checkpoint.threadId ||
      environmentPackage.scope.turnId !== checkpoint.turnId ||
      environmentPackage.scope.agentSessionId !== checkpoint.workerSessionId ||
      environmentPackage.scope.requestId !== checkpoint.requestId ||
      attempt.inputRef !== environmentPackage.snapshotId
    ) {
      throw new Error('Worker environment package contradicts its checkpoint lineage.');
    }
    // Native final-status verification and every release barrier belong behind the adapter.
    // A closed attempt with its exact retained fence proves those owners settled, while the
    // product terminal event supplies the canonical StopReason without parsing Native proof.
    if (attempt.phase !== 'closed' || !attempt.fenceRef || !attempt.operationId)
      throw new Error('Worker checkpoint has no complete execution closeout.');
  } else if (
    !stopReason ||
    checkpoint.stage === 'preparing' ||
    checkpoint.stage === 'running_worker' ||
    attempt.phase !== 'closed' ||
    attempt.disposition !== 'not_accepted' ||
    attempt.operationId !== null ||
    attempt.inputRef !== null
  ) {
    throw new Error('Pre-effect worker checkpoint has no definite terminal closeout.');
  }
  const events = store.getTurnEvents(checkpoint.turnId);
  const terminalEvents = events.filter(
    (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
  );
  const terminalEvent = terminalEvents[0];
  if (terminalEvents.length !== 1 || terminalEvent?.data.type !== 'turn-completed')
    throw new Error('Worker checkpoint has no exact product terminal event.');
  const productStopReason = terminalEvent.data.stopReason;
  if (stopReason && stopReason !== productStopReason)
    throw new Error('Worker checkpoint contradicts its product terminal event.');
  stopReason = productStopReason;
  if (
    terminalEvent.workspaceId !== checkpoint.workspaceId ||
    terminalEvent.threadId !== checkpoint.threadId ||
    terminalEvent.turnId !== checkpoint.turnId ||
    terminalEvent.data.turn.id !== checkpoint.turnId ||
    terminalEvent.data.turn.workspaceId !== checkpoint.workspaceId ||
    terminalEvent.data.turn.threadId !== checkpoint.threadId ||
    terminalEvent.data.turn.agentId !== turn.agentId ||
    !isDeepStrictEqual(terminalEvent.data.turn.triggerActor, turn.triggerActor)
  ) {
    throw new Error('Worker product terminal event contradicts its checkpoint lineage.');
  }

  if (!stopReason) {
    throw new Error('Worker checkpoint has no canonical StopReason.');
  }

  const closedApprovalGate = classifyClosedWorkerApprovalGate(store, turn);
  // An exact Approval Gate closure belongs to its response command; ordinary closeout
  // belongs to the initiating checkpoint/admission command, even when App ids need projection.
  const publicationRequestId = projectTurnEventRequestId(
    closedApprovalGate?.responseRequestId ?? checkpoint.requestId,
    checkpoint.workspaceId,
    checkpoint.threadId
  );
  if (terminalEvent.requestId !== publicationRequestId) {
    throw new Error('Worker product terminal event contradicts its command owner.');
  }
  const expectedTurnStatus = closedApprovalGate
    ? closedApprovalGate.stopReason === 'aborted'
      ? 'interrupted'
      : 'completed'
    : turnStatusForCanonicalWorkerStopReason(stopReason);

  let expectedAgentSessionStatus =
    closedApprovalGate?.stopReason === 'completed'
      ? 'closed'
      : expectedTurnStatus === 'completed'
        ? 'idle'
        : expectedTurnStatus === 'interrupted'
          ? 'interrupted'
          : 'failed';
  // Live closeout publishes idle when it retains a reusable binding.
  // That publication outlives the backend binding and proves the historical retention decision.
  const sessionPublications = events.filter(
    (event) =>
      event.event === 'agent.session.updated' && event.data.type === 'agent-session-updated'
  );
  const sessionEvents = sessionPublications.filter(
    (event) =>
      event.data.type === 'agent-session-updated' &&
      ['idle', 'closed', 'failed', 'interrupted'].includes(event.data.agentSession.status)
  );
  // Execution observations must precede both the first closeout publication and turn.completed.
  // A later nonterminal publication for this Turn contradicts ordinary and repaired closeout alike.
  const closeoutSequence = Math.min(
    sessionEvents[0]?.sequence ?? terminalEvent.sequence,
    terminalEvent.sequence
  );
  if (
    sessionPublications.some(
      (event) => event.sequence >= closeoutSequence && !sessionEvents.includes(event)
    )
  ) {
    throw new Error('Worker AgentSession publication contradicts its checkpoint lineage.');
  }
  const sessionEvent = sessionEvents.at(-1);
  if (sessionEvent) {
    if (
      sessionEvent.data.type !== 'agent-session-updated' ||
      sessionEvent.workspaceId !== checkpoint.workspaceId ||
      sessionEvent.threadId !== checkpoint.threadId ||
      sessionEvent.turnId !== checkpoint.turnId ||
      sessionEvent.requestId !== publicationRequestId ||
      sessionEvent.data.agentSession.id !== agentSession.id ||
      sessionEvent.data.agentSession.agentId !== agentSession.agentId ||
      sessionEvent.data.agentSession.createdAt !== agentSession.createdAt ||
      sessionEvent.data.agentSession.workspaceId !== checkpoint.workspaceId ||
      sessionEvent.data.agentSession.threadId !== checkpoint.threadId ||
      Date.parse(sessionEvent.data.agentSession.updatedAt) > Date.parse(sessionEvent.timestamp)
    ) {
      throw new Error('Worker AgentSession publication contradicts its checkpoint lineage.');
    }
    const publishedSession = sessionEvent.data.agentSession;
    // The terminalization owner can lose the Session event write yet publish turn.completed.
    // Its retry publishes the original completion snapshot without replacing the terminal event.
    // Prove that decided content, not how long the repair took; fresh post-terminal changes
    // and a second closeout publication cannot establish this missing-publication repair.
    const repairedPublication =
      !closedApprovalGate &&
      (stopReason === 'completed' || stopReason === 'error' || stopReason === 'aborted') &&
      sessionEvents.length === 1 &&
      sessionEvent.sequence > terminalEvent.sequence &&
      publishedSession.updatedAt === terminalEvent.data.turn.completedAt &&
      terminalEvent.data.turn.completedAt === turn.completedAt &&
      terminalEvent.data.turn.agentSessionId === agentSession.id &&
      isDeepStrictEqual(terminalEvent.data.turn.error, turn.error) &&
      isDeepStrictEqual(publishedSession.sandboxSummary, agentSession.sandboxSummary) &&
      publishedSession.message ===
        (publishedSession.status === 'idle' ? null : turn.error?.message);
    const precedingPublication =
      sessionEvent.sequence < terminalEvent.sequence &&
      Date.parse(sessionEvent.timestamp) <= Date.parse(terminalEvent.timestamp);
    if (!precedingPublication && !repairedPublication) {
      throw new Error('Worker AgentSession publication contradicts its checkpoint lineage.');
    }
    const retained =
      !closedApprovalGate &&
      Boolean(agentSession.environmentPackageSnapshotId) &&
      publishedSession.status === 'idle';
    if (publishedSession.status !== expectedAgentSessionStatus && !retained) {
      throw new Error('Worker generic closeout contradicts its canonical StopReason.');
    }
    expectedAgentSessionStatus = publishedSession.status;
    // Idle reclamation may close the binding after this Turn finished.
    // Recovery preserves the later owner's write instead of reopening the AgentSession.
    const closedLater =
      publishedSession.status === 'idle' &&
      agentSession.status === 'closed' &&
      Date.parse(agentSession.updatedAt) > Date.parse(terminalEvent.timestamp);
    if (closedLater) expectedAgentSessionStatus = 'closed';
    else if (agentSession.updatedAt !== publishedSession.updatedAt) {
      throw new Error('Worker generic closeout contradicts its canonical StopReason.');
    }
  }
  if (
    turn.status !== expectedTurnStatus ||
    terminalEvent.data.turn.status !== expectedTurnStatus ||
    agentSession.status !== expectedAgentSessionStatus ||
    attempt.phase !== 'closed' ||
    terminalEvents.length !== 1 ||
    terminalEvents[0]?.data.type !== 'turn-completed' ||
    terminalEvents[0].data.stopReason !== stopReason
  ) {
    throw new Error('Worker generic closeout contradicts its canonical StopReason.');
  }
  return stopReason;
}

/**
 * Classifies one closed worker Approval Gate from its exact request, decision, and owners.
 *
 * @param store Product store containing the Turn, Items, Approval, and terminal event.
 * @param turn Terminal Turn whose prior Gate may have been closed.
 * @returns Exact Approval closure, or null when the owner tuple is absent or contradictory.
 */
export function classifyClosedWorkerApprovalGate(
  store: FsStore,
  turn: ReturnType<FsStore['getTurnById']>
): {
  readonly requestItemId: string;
  readonly responseRequestId: string;
  readonly responseItemId: string;
  readonly stopReason: Extract<StopReason, 'aborted' | 'completed'>;
} | null {
  if (turn.status !== 'completed' && turn.status !== 'interrupted') {
    return null;
  }

  const candidates: Array<{
    readonly requestItemId: string;
    readonly responseRequestId: string;
    readonly responseItemId: string;
    readonly stopReason: Extract<StopReason, 'aborted' | 'completed'>;
  }> = [];
  for (const response of turn.items) {
    if (response.status !== 'completed') {
      continue;
    }
    if (response.type !== 'approval-decision') {
      continue;
    }
    if (response.actor.kind === 'system' && response.actor.id === 'nanocore-repo-push-policy') {
      continue;
    }
    const requests = turn.items.filter(
      (item) =>
        item.type === 'approval-request' &&
        item.status === 'completed' &&
        item.approvalRequestId === response.approvalRequestId
    );
    if (requests.length !== 1 || !requests[0]) {
      continue;
    }
    try {
      const approval = store.getApproval(response.approvalRequestId);
      if (
        approval.workspaceId !== turn.workspaceId ||
        approval.threadId !== turn.threadId ||
        approval.turnId !== turn.id ||
        approval.status !== response.decision ||
        approval.resolvedAt === null
      ) {
        continue;
      }
    } catch {
      continue;
    }
    candidates.push({
      requestItemId: requests[0].id,
      responseRequestId: response.causationId,
      responseItemId: response.id,
      stopReason: response.decision === 'denied' ? 'aborted' : 'completed',
    });
  }

  const closure = candidates[0];
  if (candidates.length !== 1 || !closure) {
    return null;
  }
  const terminalEvents = store
    .getTurnEvents(turn.id)
    .filter((event) => event.event === 'turn.completed' && event.data.type === 'turn-completed');
  const terminalEvent = terminalEvents[0];
  const expectedTurnStatus = closure.stopReason === 'aborted' ? 'interrupted' : 'completed';
  if (
    turn.status !== expectedTurnStatus ||
    terminalEvents.length !== 1 ||
    terminalEvent?.data.type !== 'turn-completed' ||
    terminalEvent.data.stopReason !== closure.stopReason ||
    !terminalEvent.requestId ||
    closure.responseRequestId !== terminalEvent.requestId
  ) {
    return null;
  }
  return closure;
}

/**
 * Classifies one closed worker user-input Gate from its exact request and response Items.
 *
 * @param store Product store containing the Turn and terminal event.
 * @param turn Terminal Turn whose prior Gate may have been closed.
 * @returns Exact user-input closure, or null when the Item tuple is absent or contradictory.
 */
export function classifyClosedWorkerUserInputGate(
  store: FsStore,
  turn: ReturnType<FsStore['getTurnById']>
): {
  readonly requestItemId: string;
  readonly responseRequestId: string;
  readonly responseItemId: string;
  readonly stopReason: Extract<StopReason, 'completed'>;
} | null {
  if (turn.status !== 'completed') {
    return null;
  }
  const candidates: Array<{
    readonly requestItemId: string;
    readonly responseItemId: string;
    readonly stopReason: Extract<StopReason, 'completed'>;
  }> = [];
  for (const response of turn.items) {
    if (response.type !== 'user-input-response' || response.status !== 'completed') {
      continue;
    }
    const requests = turn.items.filter(
      (item) =>
        item.type === 'user-input-request' &&
        item.status === 'completed' &&
        item.userInputRequestId === response.userInputRequestId
    );
    const request = requests[0];
    if (
      requests.length !== 1 ||
      !request ||
      request.type !== 'user-input-request' ||
      JSON.stringify(Object.keys(response.answers).sort()) !==
        JSON.stringify(request.questions.map((question) => question.id).sort())
    ) {
      continue;
    }
    candidates.push({
      requestItemId: request.id,
      responseItemId: response.id,
      stopReason: 'completed',
    });
  }
  const closure = candidates[0];
  if (candidates.length !== 1 || !closure) {
    return null;
  }
  const terminalEvents = store
    .getTurnEvents(turn.id)
    .filter((event) => event.event === 'turn.completed' && event.data.type === 'turn-completed');
  const terminalEvent = terminalEvents[0];
  if (
    terminalEvents.length !== 1 ||
    terminalEvent?.data.type !== 'turn-completed' ||
    terminalEvent.data.stopReason !== 'completed' ||
    !terminalEvent.requestId
  ) {
    return null;
  }
  return { ...closure, responseRequestId: terminalEvent.requestId };
}

/** The human Gate is gone. Retained callers observe no active Gate. */
export function hasExactActiveHumanGate(
  _store: FsStore,
  _turn: ReturnType<FsStore['getTurnById']>
): boolean {
  return false;
}

/**
 * Materializes only checkpoints whose existing owners prove an interrupted worker closeout.
 *
 * @param coreDb Open Core database handle containing scheduler authority.
 * @param store App-local product Turn and AgentSession store.
 * @param workspaceDb Open workspace-scope database handle.
 * @param isCandidate Audience admission required before dependent checkpoint reads.
 * @returns Interrupted worker state rows for visible restart recovery.
 */
export function materializeInterruptedWorkerStates(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  isCandidate: (checkpoint: WorkerCheckpointRecord) => boolean
): InterruptedWorkerStateRecord[] {
  const materializedAt = new Date().toISOString();

  return listRecoverableWorkerCheckpoints(workspaceDb).flatMap((checkpoint) => {
    if (!isCandidate(checkpoint)) {
      return [];
    }
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
 * @param store App-local product Turn and AgentSession store.
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

  const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, input).filter(
    (attempt) => !isSchedulerExecutionBusyRefusal(attempt)
  );
  if (attempts.length !== 1 || attempts[0]?.agentSessionId !== agentSessionId) {
    return { status: 'recovery-required', checkpoint };
  }
  const attempt = attempts[0];

  if (attempt.phase === 'open') {
    return { status: 'reconnect-pending', checkpoint };
  }
  if (attempt.phase === 'closing') {
    return { status: 'stale', checkpoint };
  }

  if (
    (checkpoint.stage !== 'preparing' && checkpoint.stage !== 'running_worker') ||
    checkpoint.stopReason !== null ||
    turn.status !== 'interrupted' ||
    agentSession.status !== 'interrupted' ||
    attempt.phase !== 'closed'
  ) {
    return { status: 'recovery-required', checkpoint };
  }

  return checkpoint.goalId === null && checkpoint.taskId === null
    ? { status: 'eligible', checkpoint }
    : { status: 'inspect-only', checkpoint };
}

/**
 * Clears one checkpoint after its terminal worker state has been durably saved.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Cleanup input identifying the stored checkpoint.
 * @returns True when a checkpoint row was deleted.
 * @throws OperationError when required retained provenance is missing or fails the existing bounded verification; other cleanup failures remain unclassified.
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
  if (!input.skipRuntimeProvenance && environmentPackage?.control.transcript?.runtimeProvenance) {
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
      throw new OperationError(
        'recovery_retry_failed',
        'Required retained runtime provenance is missing.',
        400
      );
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
    const workspaceRoot = join(workspaceDb.dataRoot, 'workspaces', workspaceDb.workspaceId);
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
    }).catch((cause) => {
      throw new OperationError(
        'recovery_retry_failed',
        'Required retained runtime provenance verification failed.',
        400,
        { cause }
      );
    });
    if (!verified.complete) {
      throw new OperationError(
        'recovery_retry_failed',
        'Required retained runtime provenance verification failed.',
        400
      );
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
