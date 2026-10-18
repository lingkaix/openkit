import { isDeepStrictEqual } from 'node:util';
import { GoalTaskLinkSchema } from '@openkit/app-api-schemas';
import {
  deriveEntityId,
  isSealedTurnTerminal,
  type PolicyResourceV1Schema,
} from '@openkit/protocol';
import type { z } from 'zod';
import {
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import type { FsStore } from '../lib/store.js';
import {
  findSchedulerAdmissionForWorkerLineage,
  type SchedulerExecutionLineage,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';
import { goalPlanDigest, readGoalView } from './goal-owner.js';
import { commandInputHash } from './idempotent-command.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';

/** Retained Task facts with current Goal bounds; descriptive references grant no rights. */
export interface GoalTaskPolicyContext {
  /** Workspace that owns the Goal and exact Task. */
  readonly workspaceId: string;
  /** Goal linked by the existing Task owner. */
  readonly goalId: string;
  /** Ordinary Task Thread identity. */
  readonly taskThreadId: string;
  /** Original Worker Turn that owns the retained request and package. */
  readonly turnId: string;
  /** Exact active Plan cited at Task reservation. */
  readonly planVersionId: string;
  /** Selected Worker from the matching Turn and scheduler request. */
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
  const admission = findSchedulerAdmissionForWorkerLineage(coreDb, lineage);
  if (
    !admission ||
    admission.status !== 'admitted' ||
    !admission.requestId ||
    admission.triggerActor.kind !== 'user' ||
    admission.triggerActor.id !== goal.responsibleUserId ||
    schedulerAdmissionInputHash(admission) !== admission.inputHash
  )
    throw unavailable();
  const turn = addressedTurn;
  const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, lineage).filter(
    (attempt) =>
      attempt.queueEntryId === admission.queueEntryId &&
      attempt.agentSessionId === lineage.agentSessionId &&
      attempt.inputRef === lineage.packageSnapshotId
  );
  const attempt = attempts[0];
  const checkpoint = getWorkerCheckpoint(db, lineage.workspaceId, lineage.threadId, lineage.turnId);
  const request = StructuredWorkerDelegationRequestSchema.parse(JSON.parse(admission.turnInput));
  const initiatingItem = turn.items.find(
    (item) => item.id === deriveEntityId('it', ['task-user', turn.id])
  );
  if (
    !attempt ||
    attempts.length !== 1 ||
    attempt.backendId !== admission.backendId ||
    (isSealedTurnTerminal(turn.status) && attempt.disposition !== 'accepted') ||
    (attempt.phase === 'closed' && attempt.disposition === 'not_accepted') ||
    turn.agentSessionId !== lineage.agentSessionId ||
    turn.agentId !== admission.requestedAgentId ||
    !isDeepStrictEqual(turn.triggerActor, admission.triggerActor) ||
    !initiatingItem ||
    initiatingItem.type !== 'user-message' ||
    initiatingItem.status !== 'completed' ||
    initiatingItem.workspaceId !== lineage.workspaceId ||
    initiatingItem.threadId !== lineage.threadId ||
    initiatingItem.turnId !== lineage.turnId ||
    initiatingItem.text !== admission.turnInput ||
    !isDeepStrictEqual(initiatingItem.actor, turn.triggerActor) ||
    serializeStructuredWorkerDelegationRequest(request) !== admission.turnInput ||
    (checkpoint
      ? checkpoint.requestId !== admission.requestId ||
        checkpoint.requestInputHash !== commandInputHash({ input: admission.turnInput }) ||
        (checkpoint.workerSessionId !== null &&
          checkpoint.workerSessionId !== lineage.agentSessionId) ||
        checkpoint.contextDigest !== commandInputHash(request)
      : !isSealedTurnTerminal(turn.status) ||
        attempt.phase !== 'closed' ||
        attempt.disposition !== 'accepted' ||
        !attempt.fenceRef)
  )
    throw unavailable();
  return {
    workspaceId: lineage.workspaceId,
    goalId: goal.goalId,
    taskThreadId: lineage.threadId,
    turnId: lineage.turnId,
    planVersionId: plan.planVersionId,
    agentId: admission.requestedAgentId,
    responsibleUserId: goal.responsibleUserId,
    resources: request.resources.flatMap((value) =>
      value.kind === 'policy' ? [value.resource] : []
    ),
    requestInputHash: admission.inputHash,
  };
}
