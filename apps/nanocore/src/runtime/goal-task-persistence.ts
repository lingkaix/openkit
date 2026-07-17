import type { WorkspaceDb } from '../storage/db.js';
import {
  assertValidGoalPlanGraph,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
} from './goal-plan.js';
import { createGoalTask, type GoalTaskRecord } from './goal-store.js';

/**
 * Input for persisting approved plan tasks as goal tasks.
 */
export interface PersistApprovedGoalTasksInput {
  /** Open workspace-scope database handle. */
  readonly workspaceDb: WorkspaceDb;
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal that owns the approved plan. */
  readonly goalId: string;
  /** Immutable Goal Plan and visible Item id. */
  readonly planItemId: string;
  /** Approved plan output to persist. */
  readonly plan: GoalPlanOutput;
}

/**
 * Result returned after approved tasks are persisted.
 */
export interface PersistApprovedGoalTasksResult {
  /** Stored goal task records. */
  readonly tasks: readonly GoalTaskRecord[];
}

/**
 * Persists approved plan tasks into durable goal task records.
 *
 * @param input Approved plan task persistence input.
 * @returns Stored goal task records in plan order.
 * @throws Error when task ids, dependencies, or dependency ordering are invalid.
 */
export function persistApprovedGoalTasks(
  input: PersistApprovedGoalTasksInput
): PersistApprovedGoalTasksResult {
  const plan = GoalPlanOutputSchema.parse(input.plan);

  assertValidGoalPlanGraph(plan.tasks);

  const tasks = plan.tasks.map((task, index) =>
    createGoalTask(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      planItemId: input.planItemId,
      taskId: task.taskId,
      title: task.title,
      objective: task.objective,
      orderIndex: index,
      dependsOnTaskIds: task.dependsOnTaskIds,
      acceptanceCriteria: task.acceptanceCriteria,
      contextBudgetTokens: task.contextBudgetTokens,
      resources: task.resources,
      expectedArtifacts: task.expectedArtifacts,
      verificationChecks: task.verificationChecks,
      reviewPolicy: task.reviewPolicy,
      escalationConditions: task.escalationConditions,
      status: task.dependsOnTaskIds.length === 0 ? 'ready' : 'pending',
    })
  );

  return { tasks };
}
