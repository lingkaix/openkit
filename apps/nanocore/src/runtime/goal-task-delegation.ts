import type { ItemSchema } from '@openkit/protocol';
import type { z } from 'zod';

import { convertToLlm } from '../context/llm-projection.js';
import {
  LLM_PROJECTION_POLICY_VERSION,
  type LlmProjectionPolicy,
} from '../context/projection-policy.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
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
 * @param coreDb Open Core database handles for repository context.
 * @param workspaceDb Open workspace-scope database handle for goal task state.
 * @param input Goal task delegation input.
 * @returns Authorized Task facts and context prepared for Coordinator composition.
 * @throws Error when the goal, task, repository, or context package is unavailable.
 */
export function prepareGoalTaskDelegation(
  coreDb: CoreDb,
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
  const reviewContext = latestGoalReviewContext(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: goal.goalId,
    taskId: task.taskId,
  });

  return prepareNextTurnContext(coreDb, {
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
