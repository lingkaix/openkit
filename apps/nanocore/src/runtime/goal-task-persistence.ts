import type { WorkspaceDb } from '../storage/db.js';
import { type GoalPlanOutput, GoalPlanOutputSchema, type GoalPlanTask } from './goal-plan.js';
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
 * @throws Error when a task depends on a missing task or task ids are duplicated.
 */
export function persistApprovedGoalTasks(
  input: PersistApprovedGoalTasksInput
): PersistApprovedGoalTasksResult {
  const plan = GoalPlanOutputSchema.parse(input.plan);

  assertValidPlanDependencies(plan.tasks);

  const tasks = plan.tasks.map((task, index) =>
    createGoalTask(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      taskId: task.taskId,
      title: task.title,
      objective: task.objective,
      orderIndex: index,
      dependsOnTaskIds: task.dependsOnTaskIds,
      acceptanceCriteria: task.acceptanceCriteria,
      contextBudgetTokens: task.contextBudgetTokens,
      verificationChecks: task.verificationChecks,
      status: task.dependsOnTaskIds.length === 0 ? 'ready' : 'pending',
    })
  );

  return { tasks };
}

/**
 * Validates task ids and dependencies before storage writes begin.
 *
 * @param tasks Planned tasks to validate.
 * @throws Error when task ids are duplicated or dependencies reference missing tasks.
 */
function assertValidPlanDependencies(tasks: readonly GoalPlanTask[]): void {
  const taskIds = new Set<string>();

  for (const task of tasks) {
    if (taskIds.has(task.taskId)) {
      throw new Error(`Plan task id is duplicated: ${task.taskId}.`);
    }

    taskIds.add(task.taskId);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOnTaskIds) {
      if (!taskIds.has(dependencyId)) {
        throw new Error(`Plan task ${task.taskId} depends on missing task ${dependencyId}.`);
      }
    }
  }
}
