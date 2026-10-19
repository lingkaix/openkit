import { isDeepStrictEqual } from 'node:util';
import { GoalTaskLinkSchema } from '@openkit/app-api-schemas';
import {
  deriveEntityId,
  isSealedTurnTerminal,
  type PolicyResourceV1Schema,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import type { z } from 'zod';
import {
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import type { FsStore } from '../lib/store.js';
import {
  findSchedulerAdmissionForWorkerLineage,
  listSchedulerAdmissionEntriesForWorkspace,
  type SchedulerExecutionLineage,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';
import { goalPlanDigest, readGoalView } from './goal-owner.js';
import { commandInputHash } from './idempotent-command.js';
import { listThreadPendingRequests, pendingRequestSystemActor } from './pending-requests.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';

/** Retained Task facts with current Goal bounds; descriptive references grant no rights. */
export interface GoalTaskPolicyContext {
  /** Workspace that owns the Goal and exact Task. */
  readonly workspaceId: string;
  /** Goal linked by the existing Task owner. */
  readonly goalId: string;
  /** Ordinary Task Thread identity. */
  readonly taskThreadId: string;
  /** Actual effect Turn, which can follow the original Task request. */
  readonly turnId: string;
  /** Exact active Plan cited at Task reservation. */
  readonly planVersionId: string;
  /** Actual selected Worker from the effect Turn and scheduler request. */
  readonly agentId: string;
  /** Human responsible for the Goal and original Task request. */
  readonly responsibleUserId: string;
  /** Explicit typed Task bounds only; an empty set matches nothing. */
  readonly resources: readonly z.infer<typeof PolicyResourceV1Schema>[];
  /** Scheduler's immutable hash of the complete original request and provenance. */
  readonly requestInputHash: string;
}

/**
 * Reads retained Goal-linked Task bounds; live and captured-call entry owners check their own liveness.
 * @param input Exact authenticated Worker package lineage and its existing stores.
 * @returns Current typed Task context, or null for an ordinary Task with no Goal link.
 * @throws Error when a linked Task has missing, changed or contradictory facts, or its Goal scope ended.
 */
export function readGoalTaskPolicyContext(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly db: WorkspaceDb;
  readonly lineage: SchedulerExecutionLineage;
}): GoalTaskPolicyContext | null {
  const { coreDb, store, db, lineage } = input;
  const unavailable = () =>
    new Error('Goal Task Policy context requires current exact owner facts.');
  if (db.workspaceId !== lineage.workspaceId) throw unavailable();
  const addressedTurn = store.getTurnById(lineage.turnId);
  if (
    addressedTurn.workspaceId !== lineage.workspaceId ||
    addressedTurn.threadId !== lineage.threadId
  )
    throw unavailable();
  const row = db.sqlite
    .prepare('SELECT thread_id,goal_id,card_id,payload_json FROM goal_card_tasks WHERE thread_id=?')
    .get(lineage.threadId) as
    | { thread_id: string; goal_id: string; card_id: string; payload_json: string }
    | undefined;
  if (!row) return null;
  const link = GoalTaskLinkSchema.parse(JSON.parse(row.payload_json));
  if (link.threadId !== row.thread_id || link.goalId !== row.goal_id || link.cardId !== row.card_id)
    throw unavailable();
  const view = readGoalView(store, db, link.goalId);
  const goal = view.goal;
  const card = view.cards.find((value) => value.cardId === link.cardId);
  const plan = view.versions.find((value) => value.planVersionId === link.planVersionId);
  if (
    !goal ||
    goal.goalId !== link.goalId ||
    goal.workspaceId !== lineage.workspaceId ||
    goal.disposition ||
    !card ||
    card.goalId !== goal.goalId ||
    card.cancelled ||
    !plan ||
    plan.goalId !== goal.goalId ||
    goal.activePlanVersionId !== plan.planVersionId ||
    goalPlanDigest(plan.bytes) !== plan.digest ||
    JSON.stringify(plan.commitment) !== plan.bytes ||
    store.getThread(lineage.workspaceId, lineage.threadId).visibility !== 'workspace'
  )
    throw unavailable();
  // Card edits do not steer a running Task. Cancellation and active Plan replacement do end use.
  // Later Turns have their own Worker/package and can have a different human trigger.
  // Native Pending cause identifies system-authored frozen input; it supplies no Task scope.
  const pending = listThreadPendingRequests(db.sqlite, lineage.workspaceId, lineage.threadId);
  const readWorkerSource = (scope: SchedulerExecutionLineage) => {
    const admission = findSchedulerAdmissionForWorkerLineage(coreDb, scope);
    const turn = store.getTurn(scope.workspaceId, scope.threadId, scope.turnId);
    if (
      !admission ||
      admission.status !== 'admitted' ||
      !admission.requestId ||
      schedulerAdmissionInputHash(admission) !== admission.inputHash
    )
      throw unavailable();
    const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, scope).filter(
      (attempt) =>
        attempt.queueEntryId === admission.queueEntryId &&
        attempt.agentSessionId === scope.agentSessionId &&
        attempt.inputRef === scope.packageSnapshotId
    );
    const attempt = attempts[0];
    const checkpoint = getWorkerCheckpoint(db, scope.workspaceId, scope.threadId, scope.turnId);
    const outcomeInitiated = pending.some(
      (record) =>
        record.deliveryTurnId === turn.id &&
        record.deliveryCause === 'outcome' &&
        record.requesterKind === 'worker' &&
        record.agentId === admission.requestedAgentId
    );
    const initiatingItem = turn.items.find(
      (item) => item.id === deriveEntityId('it', ['task-user', turn.id])
    );
    if (
      !attempt ||
      attempts.length !== 1 ||
      attempt.backendId !== admission.backendId ||
      (isSealedTurnTerminal(turn.status) && attempt.disposition !== 'accepted') ||
      (attempt.phase === 'closed' && attempt.disposition === 'not_accepted') ||
      turn.agentSessionId !== scope.agentSessionId ||
      turn.agentId !== admission.requestedAgentId ||
      !isDeepStrictEqual(turn.triggerActor, admission.triggerActor) ||
      !initiatingItem ||
      initiatingItem.type !== 'user-message' ||
      initiatingItem.status !== 'completed' ||
      initiatingItem.workspaceId !== scope.workspaceId ||
      initiatingItem.threadId !== scope.threadId ||
      initiatingItem.turnId !== scope.turnId ||
      !isDeepStrictEqual(
        initiatingItem.actor,
        outcomeInitiated
          ? pendingRequestSystemActor(responsibleUserIdForActor(turn.triggerActor))
          : turn.triggerActor
      ) ||
      (!outcomeInitiated && initiatingItem.text !== admission.turnInput) ||
      (checkpoint
        ? checkpoint.requestId !== admission.requestId ||
          checkpoint.requestInputHash !== commandInputHash({ input: admission.turnInput }) ||
          (checkpoint.workerSessionId !== null &&
            checkpoint.workerSessionId !== scope.agentSessionId)
        : isSealedTurnTerminal(turn.status) &&
          (attempt.phase !== 'closed' || attempt.disposition !== 'accepted' || !attempt.fenceRef))
    )
      throw unavailable();
    return { admission, turn, checkpoint };
  };
  const current = readWorkerSource(lineage);
  // The Task owner declares these exact Thread and Turn names. Match that native source,
  // never the first parseable JSON or a later request that resembles a delegation.
  const originals = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
    workspaceId: lineage.workspaceId,
    statuses: ['admitted'],
  }).filter(
    (entry) =>
      entry.threadId === lineage.threadId &&
      entry.requestId &&
      entry.triggerActor.kind === 'user' &&
      entry.triggerActor.id === goal.responsibleUserId &&
      deriveEntityId('th', ['task', entry.requestId]) === lineage.threadId &&
      deriveEntityId('tu', {
        command: 'task.start',
        actorId: goal.responsibleUserId,
        workspaceId: lineage.workspaceId,
        threadId: lineage.threadId,
        requestId: entry.requestId,
      }) === entry.turnId
  );
  const original = originals[0];
  if (!original || originals.length !== 1) throw unavailable();
  const originalTurn = store.getTurn(lineage.workspaceId, lineage.threadId, original.turnId);
  const originalAttempts = listSchedulerExecutionAttemptsForTurn(coreDb, original).filter(
    (attempt) =>
      attempt.queueEntryId === original.queueEntryId &&
      attempt.agentSessionId === originalTurn.agentSessionId &&
      attempt.inputRef
  );
  const originalAttempt = originalAttempts[0];
  if (
    !originalAttempt ||
    originalAttempts.length !== 1 ||
    !originalAttempt.agentSessionId ||
    !originalAttempt.inputRef
  )
    throw unavailable();
  const source = readWorkerSource({
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    turnId: original.turnId,
    agentSessionId: originalAttempt.agentSessionId,
    packageSnapshotId: originalAttempt.inputRef,
  });
  const request = StructuredWorkerDelegationRequestSchema.parse(
    JSON.parse(source.admission.turnInput)
  );
  // Only the original Task preparation owns this required checkpoint and structured digest.
  if (
    serializeStructuredWorkerDelegationRequest(request) !== source.admission.turnInput ||
    (source.checkpoint
      ? source.checkpoint.contextDigest !== commandInputHash(request)
      : !isSealedTurnTerminal(source.turn.status))
  )
    throw unavailable();
  return {
    workspaceId: lineage.workspaceId,
    goalId: goal.goalId,
    taskThreadId: lineage.threadId,
    turnId: lineage.turnId,
    planVersionId: plan.planVersionId,
    agentId: current.admission.requestedAgentId,
    responsibleUserId: goal.responsibleUserId,
    resources: request.resources.flatMap((value) =>
      value.kind === 'policy' ? [value.resource] : []
    ),
    requestInputHash: source.admission.inputHash,
  };
}
