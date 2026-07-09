import type { StopReason } from '@openkit/protocol';

import type { WorkspaceDb } from '../storage/db.js';
import type { GoalReviewVerdict } from '../storage/schema/index.js';
import { applyGoalReviewDecision } from './goal-review-decision.js';
import type { GoalRecord, GoalTaskRecord } from './goal-store.js';
import { listGoalTasks, updateGoalStatus, updateGoalTask } from './goal-store.js';
import { selectNextReadyGoalTask } from './goal-task-selector.js';

/**
 * Supervise-loop outcome after a reviewed task is applied.
 */
export type GoalSuperviseAdvanceOutcome =
  | 'complete_next_task'
  | 'complete_goal'
  | 'continue'
  | 'retry'
  | 'needs_revision'
  | 'decompose'
  | 'awaiting_human'
  | 'blocked'
  | 'aborted';

/**
 * Input used to advance a goal after review.
 */
export interface AdvanceGoalAfterReviewInput {
  /** Workspace that owns the reviewed task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed task. */
  readonly threadId: string;
  /** Goal that owns the reviewed task. */
  readonly goalId: string;
  /** Reviewed task id. */
  readonly taskId: string;
  /** Review verdict to apply. */
  readonly verdict: GoalReviewVerdict;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Result returned after a goal is advanced past a review checkpoint.
 */
export interface AdvanceGoalAfterReviewResult {
  /** Supervise-loop outcome. */
  readonly outcome: GoalSuperviseAdvanceOutcome;
  /** Updated reviewed task. */
  readonly task: GoalTaskRecord;
  /** Updated goal when goal state changed. */
  readonly goal: GoalRecord | null;
  /** Next task selected for execution, if any. */
  readonly nextTask: GoalTaskRecord | null;
}

/**
 * Applies review, unlocks eligible dependents, and selects the next supervise step.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review advance input.
 * @returns Supervise-loop advance result.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
export function advanceGoalAfterReview(
  workspaceDb: WorkspaceDb,
  input: AdvanceGoalAfterReviewInput
): AdvanceGoalAfterReviewResult {
  const decision = applyGoalReviewDecision(workspaceDb, input);

  if (decision.terminal || decision.outcome === 'awaiting_human') {
    return {
      goal: decision.goal,
      nextTask: null,
      outcome: decision.outcome,
      task: decision.task,
    };
  }

  if (decision.outcome === 'retry') {
    const goal = setGoalCurrentTask(workspaceDb, input, decision.task.taskId, 'running', null);

    return {
      goal,
      nextTask: decision.task,
      outcome: 'retry',
      task: decision.task,
    };
  }

  if (decision.outcome === 'needs_revision' || decision.outcome === 'decompose') {
    return {
      goal: decision.goal,
      nextTask: null,
      outcome: decision.outcome,
      task: decision.task,
    };
  }

  const tasks = unlockDependentTasks(workspaceDb, input);
  const nextTask = selectNextReadyGoalTask(tasks);

  if (nextTask) {
    const goal = setGoalCurrentTask(workspaceDb, input, nextTask.taskId, 'running', null);

    return {
      goal,
      nextTask,
      outcome: 'complete_next_task',
      task: decision.task,
    };
  }

  if (tasks.every((task) => task.status === 'completed' || task.status === 'skipped')) {
    const goal = setGoalCurrentTask(workspaceDb, input, null, 'completed', 'completed');

    return {
      goal,
      nextTask: null,
      outcome: 'complete_goal',
      task: decision.task,
    };
  }

  return {
    goal: decision.goal,
    nextTask: null,
    outcome: 'continue',
    task: decision.task,
  };
}

/**
 * Unlocks pending goal tasks whose dependencies are all completed.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review advance input.
 * @returns Latest goal task list after unlocks.
 */
function unlockDependentTasks(
  workspaceDb: WorkspaceDb,
  input: AdvanceGoalAfterReviewInput
): GoalTaskRecord[] {
  const tasks = listGoalTasks(workspaceDb, input);
  const completedTaskIds = new Set(
    tasks.filter((task) => task.status === 'completed').map((task) => task.taskId)
  );

  for (const task of tasks) {
    if (
      task.status !== 'pending' ||
      task.dependsOnTaskIds.some((dependencyId) => !completedTaskIds.has(dependencyId))
    ) {
      continue;
    }

    updateGoalTask(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      taskId: task.taskId,
      status: 'ready',
      ...(input.now ? { now: input.now } : {}),
    });
  }

  return listGoalTasks(workspaceDb, input);
}

/**
 * Updates goal state for the selected current task.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review advance input.
 * @param currentTaskId Current task id, or null.
 * @param status Goal status to write.
 * @param terminalStopReason Terminal stop reason to write.
 * @returns Updated goal record.
 */
function setGoalCurrentTask(
  workspaceDb: WorkspaceDb,
  input: AdvanceGoalAfterReviewInput,
  currentTaskId: string | null,
  status: GoalRecord['status'],
  terminalStopReason: StopReason | null
): GoalRecord {
  return updateGoalStatus(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    status,
    currentTaskId,
    terminalStopReason,
    ...(input.now ? { now: input.now } : {}),
  });
}
