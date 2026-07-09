import type { ItemSchema } from '@openkit/protocol';
import type { z } from 'zod';

import { convertToLlm } from '../context/llm-projection.js';
import {
  LLM_PROJECTION_POLICY_VERSION,
  type LlmProjectionPolicy,
} from '../context/projection-policy.js';
import type { StructuredWorkerDelegationRequestInput } from '../internal-agents/delegation.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { getGoalRecord, listGoalTasks } from './goal-store.js';
import {
  type PreparedNextTurn,
  type PrepareNextTurnTaskState,
  prepareNextTurn,
} from './prepare-next-turn.js';
import type { QueuedFollowUpInput, SafePointSteeringMessage } from './user-turn-queues.js';

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
  /** Queued safe-point steering messages selected for this turn. */
  readonly steeringMessages: readonly SafePointSteeringMessage[];
  /** Queued follow-up inputs selected for this turn. */
  readonly followUpInputs: readonly QueuedFollowUpInput[];
  /** Expected artifacts or file changes from the worker task. */
  readonly expectedArtifacts?: PrepareNextTurnTaskState['expectedArtifacts'];
  /** Verification commands or checks expected after worker execution. */
  readonly verification?: PrepareNextTurnTaskState['verification'];
  /** Stop conditions for the worker turn. */
  readonly stopConditions?: readonly string[];
}

/**
 * Prepares one selected goal task for worker delegation without starting it.
 *
 * @param coreDb Open Core database handles for repository context.
 * @param workspaceDb Open workspace-scope database handle for goal task state.
 * @param input Goal task delegation input.
 * @returns Prepared next-turn payload with repository, delegation request, and context digest.
 * @throws Error when the goal, task, repository, or context package is unavailable.
 */
export function prepareGoalTaskDelegation(
  coreDb: CoreDb,
  workspaceDb: WorkspaceDb,
  input: PrepareGoalTaskDelegationInput
): PreparedNextTurn {
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

  const contextProjection = convertToLlm(input.threadItems, GOAL_WORKER_CONTEXT_POLICY);

  return prepareNextTurn(coreDb, {
    workspaceId: input.workspaceId,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    threadId: input.threadId,
    goalState: {
      goalId: goal.goalId,
      title: goal.title,
      objective: goal.objective,
      acceptanceCriteria: ['Goal objective remains satisfied.'],
    },
    taskState: {
      taskId: task.taskId,
      title: task.title,
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      expectedArtifacts: input.expectedArtifacts ?? [
        { kind: 'artifact', description: 'Worker result summary and implementation evidence.' },
      ],
      verification:
        input.verification ??
        task.verificationChecks.map((check) => ({
          kind: check.kind,
          description: check.description,
          ...(check.command ? { command: check.command } : {}),
        })),
      stopConditions: input.stopConditions ?? ['Stop after completing the selected goal task.'],
    },
    contextProjection,
    steeringMessages: input.steeringMessages,
    followUpInputs: input.followUpInputs,
  });
}

/**
 * Structured delegation request hint type used by callers that already have plan details.
 */
export type GoalTaskDelegationExpectedArtifact =
  StructuredWorkerDelegationRequestInput['expectedArtifacts'][number];

/**
 * Structured delegation verification hint type used by callers that already have plan details.
 */
export type GoalTaskDelegationVerification =
  StructuredWorkerDelegationRequestInput['verification'][number];
