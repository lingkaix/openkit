import type { ItemSchema } from '@openkit/protocol';
import type { z } from 'zod';

import { convertToLlm } from '../context/llm-projection.js';
import {
  LLM_PROJECTION_POLICY_VERSION,
  type LlmProjectionPolicy,
} from '../context/projection-policy.js';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { GoalReviewResolutionError, listGoalReviewRecordsForTask } from './goal-review-records.js';
import { getGoalRecord, listGoalTasks } from './goal-store.js';
import { type PreparedNextTurnContext, prepareNextTurnContext } from './prepare-next-turn.js';

type Item = z.infer<typeof ItemSchema>;

const GOAL_WORKER_CONTEXT_POLICY: LlmProjectionPolicy = {
  version: LLM_PROJECTION_POLICY_VERSION,
  defaultOutcome: 'model-visible',
  categoryOutcomes: {
    approval: 'ui-only',
    diagnostic: 'ui-only',
  },
};

/**
 * Input for preparing one selected goal task for worker delegation.
 */
export interface PrepareGoalTaskDelegationInput {
  /** Product store containing the exact Human Gate owner tuple. */
  readonly store: FsStore;
  /** Workspace that owns the goal task. */
  readonly workspaceId: string;
  /** User that owns the workspace database. */
  readonly userId?: string;
  /** Thread that owns the goal task. */
  readonly threadId: string;
  /** Goal that owns the task. */
  readonly goalId: string;
  /** Selected goal task id. */
  readonly taskId: string;
  /** Durable thread items to project into worker-visible context. */
  readonly threadItems: readonly Item[];
}

/**
 * Prepares one selected goal task for worker delegation without starting it.
 *
 * @param workspaceDb Open workspace-scope database handle for goal task state.
 * @param input Goal task delegation input.
 * @returns Authorized Task facts and context prepared for Coordinator composition.
 * @throws Error when the goal, task, or context package is unavailable.
 */
export function prepareGoalTaskDelegation(
  workspaceDb: WorkspaceDb,
  input: PrepareGoalTaskDelegationInput
): PreparedNextTurnContext {
  const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, input.goalId);

  if (!goal) {
    throw new Error(`Goal not found: ${input.workspaceId}/${input.threadId}/${input.goalId}`);
  }

  const task = listGoalTasks(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
  }).find((candidate) => candidate.taskId === input.taskId);

  if (!task) {
    throw new Error(`Goal task not found: ${input.goalId}/${input.taskId}`);
  }
  if (goal.planItemId === null || task.planItemId !== goal.planItemId) {
    throw new GoalReviewResolutionError(
      'recovery_required',
      'Goal task Plan lineage does not match the Goal.'
    );
  }

  const contextProjection = convertToLlm(input.threadItems, GOAL_WORKER_CONTEXT_POLICY);
  const gateContextRefs = latestGateContextRefs(input.store, task, input.threadItems);
  const reviewContext = latestGoalReviewContext(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: goal.goalId,
    taskId: task.taskId,
  });

  const prepared = prepareNextTurnContext({
    workspaceId: input.workspaceId,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    threadId: input.threadId,
    taskState: {
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      resources: task.resources,
      expectedArtifacts: task.expectedArtifacts,
      contextBudgetTokens: task.contextBudgetTokens,
      verification: task.verificationChecks,
      reviewPolicy: task.reviewPolicy,
      escalationConditions: task.escalationConditions,
    },
    contextProjection,
    reviewContext,
  });
  const gateContextIds = new Set(gateContextRefs.map((ref) => ref.id));
  return {
    ...prepared,
    contextRefs: [
      ...gateContextRefs,
      ...prepared.contextRefs.filter((ref) => !gateContextIds.has(ref.id)),
    ],
  };
}

/**
 * Resolves the exact closed Human Gate pair carried into the next Goal Task attempt.
 *
 * @param store Product store containing Approval owners.
 * @param task Goal Task whose latest Gate pointer is authoritative.
 * @param items Latest Thread Items available for delegation.
 * @returns Request and response Item refs in causal order, or an empty list.
 * @throws GoalReviewResolutionError when the durable pointer is absent or contradictory.
 */
export function latestGateContextRefs(
  store: FsStore,
  task: ReturnType<typeof listGoalTasks>[number],
  items: readonly Item[]
): PreparedNextTurnContext['contextRefs'] {
  if (!task.latestGateContextItemId) {
    return [];
  }
  const response = items.find((item) => item.id === task.latestGateContextItemId);
  const requests =
    response?.type === 'approval-decision'
      ? items.filter(
          (item) =>
            item.type === 'approval-request' &&
            item.turnId === response.turnId &&
            item.approvalRequestId === response.approvalRequestId
        )
      : response?.type === 'user-input-response'
        ? items.filter(
            (item) =>
              item.type === 'user-input-request' &&
              item.turnId === response.turnId &&
              item.userInputRequestId === response.userInputRequestId
          )
        : [];
  const request = requests.length === 1 ? requests[0] : null;
  const commonTupleMatches =
    response?.status === 'completed' &&
    request?.status === 'completed' &&
    response.workspaceId === task.workspaceId &&
    response.threadId === task.threadId &&
    request.workspaceId === response.workspaceId &&
    request.threadId === response.threadId;
  let ownerMatches = false;
  if (
    commonTupleMatches &&
    response.type === 'approval-decision' &&
    request?.type === 'approval-request'
  ) {
    try {
      const approval = store.getApproval(response.approvalRequestId);
      ownerMatches =
        approval.workspaceId === response.workspaceId &&
        approval.threadId === response.threadId &&
        approval.turnId === response.turnId &&
        approval.status === response.decision &&
        approval.resolvedAt !== null;
    } catch {
      ownerMatches = false;
    }
  } else if (
    commonTupleMatches &&
    response.type === 'user-input-response' &&
    request?.type === 'user-input-request'
  ) {
    const questionIds = request.questions.map((question) => question.id).sort();
    ownerMatches =
      JSON.stringify(Object.keys(response.answers).sort()) === JSON.stringify(questionIds);
  }
  if (!request || !response || !commonTupleMatches || !ownerMatches) {
    throw new GoalReviewResolutionError(
      'recovery_required',
      'Latest Goal Task Human Gate context is incomplete or contradictory.'
    );
  }
  return [
    { kind: 'item', id: request.id },
    { kind: 'item', id: response.id },
  ];
}

/**
 * Selects the sticky latest resolved Review context for one ready Goal Task.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Exact Goal Task lineage selected for delegation.
 * @returns Resolved refine or retry context, or null when the Task has no Review.
 * @throws GoalReviewResolutionError when the latest Review contradicts a ready Task.
 */
function latestGoalReviewContext(
  workspaceDb: WorkspaceDb,
  input: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly goalId: string;
    readonly taskId: string;
  }
): PreparedNextTurnContext['workerRequestDetails']['reviewContext'] {
  const latest = listGoalReviewRecordsForTask(workspaceDb, input).at(-1);

  if (!latest) {
    return null;
  }

  const snapshot = latest.resolutionSnapshot;
  const resolvedTupleMatches =
    latest.resolvedAt !== null &&
    latest.resolutionRequestId !== null &&
    latest.resolvedByActorId !== null &&
    snapshot !== null &&
    (latest.verdict === 'refine' || latest.verdict === 'retry') &&
    snapshot.outcome === latest.verdict &&
    snapshot.task.taskId === input.taskId &&
    snapshot.task.status === 'ready' &&
    snapshot.goal.goalId === input.goalId &&
    snapshot.goal.status === 'running' &&
    snapshot.goal.currentTaskId === null &&
    snapshot.goal.terminalStopReason === null &&
    snapshot.nextReadyTaskId === input.taskId;

  if (!resolvedTupleMatches) {
    throw new GoalReviewResolutionError(
      'recovery_required',
      'Latest Goal Review contradicts the selected ready Task.'
    );
  }

  if (latest.verdict === 'refine' && latest.revisionInstruction !== null) {
    return {
      reviewId: latest.reviewId,
      verdict: 'refine',
      reason: latest.reason,
      revisionInstruction: latest.revisionInstruction,
      priorTurnId: latest.turnId,
      evidence: { itemIds: [...latest.itemIds], artifactIds: [...latest.artifactIds] },
    };
  }

  if (latest.verdict === 'retry' && latest.reason !== null && latest.revisionInstruction === null) {
    return {
      reviewId: latest.reviewId,
      verdict: 'retry',
      reason: latest.reason,
      revisionInstruction: null,
      priorTurnId: latest.turnId,
      evidence: { itemIds: [...latest.itemIds], artifactIds: [...latest.artifactIds] },
    };
  }

  throw new GoalReviewResolutionError(
    'recovery_required',
    'Latest Goal Review decision fields are contradictory.'
  );
}
