import type { GoalReviewResolutionSnapshot, GoalReviewVerdict } from '@openkit/app-api-schemas';

import type { WorkspaceDb } from '../storage/db.js';
import { GoalReviewResolutionError } from './goal-review-records.js';
import type { GoalTaskRecord } from './goal-store.js';
import { listGoalTasks, updateGoalStatus, updateGoalTask } from './goal-store.js';
import { selectNextReadyGoalTask } from './goal-task-selector.js';

/**
 * Input used to advance a Goal after one human Review decision.
 */
export interface AdvanceGoalAfterReviewInput {
  /** Workspace that owns the reviewed Task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed Task. */
  readonly threadId: string;
  /** Goal that owns the reviewed Task. */
  readonly goalId: string;
  /** Reviewed Task id. */
  readonly taskId: string;
  /** Human Review verdict to apply. */
  readonly verdict: GoalReviewVerdict;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Applies one human Review verdict and returns its bounded immutable result.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Scoped Review decision.
 * @returns Bounded Task and Goal resolution snapshot.
 * @throws GoalReviewResolutionError when accepted state has no valid continuation.
 */
export function advanceGoalAfterReview(
  workspaceDb: WorkspaceDb,
  input: AdvanceGoalAfterReviewInput
): GoalReviewResolutionSnapshot {
  if (input.verdict === 'refine' || input.verdict === 'retry') {
    const task = updateReviewedTask(workspaceDb, input, 'ready');
    const goal = updateResolutionGoal(workspaceDb, input, 'running', null);

    return {
      outcome: input.verdict,
      task: { taskId: task.taskId, status: 'ready' },
      goal,
      nextReadyTaskId: task.taskId,
    };
  }

  if (input.verdict === 'abort') {
    const task = updateReviewedTask(workspaceDb, input, 'failed');
    const goal = updateResolutionGoal(workspaceDb, input, 'aborted', 'aborted');

    return {
      outcome: 'aborted',
      task: { taskId: task.taskId, status: 'failed' },
      goal,
      nextReadyTaskId: null,
    };
  }

  const task = updateReviewedTask(workspaceDb, input, 'completed');
  const tasks = unlockDependentTasks(workspaceDb, input);
  const nextReadyTask = selectNextReadyGoalTask(tasks);

  if (nextReadyTask) {
    const goal = updateResolutionGoal(workspaceDb, input, 'running', null);

    return {
      outcome: 'complete_next_task',
      task: { taskId: task.taskId, status: 'completed' },
      goal,
      nextReadyTaskId: nextReadyTask.taskId,
    };
  }

  if (tasks.every((candidate) => candidate.status === 'completed')) {
    const goal = updateResolutionGoal(workspaceDb, input, 'completed', 'completed');

    return {
      outcome: 'complete_goal',
      task: { taskId: task.taskId, status: 'completed' },
      goal,
      nextReadyTaskId: null,
    };
  }

  throw new GoalReviewResolutionError(
    'recovery_required',
    'Accepted Goal Review has no valid next-ready Task or completed Goal.'
  );
}

/**
 * Updates the reviewed Task to its resolved lifecycle state.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Scoped Review decision.
 * @param status Task status produced by the verdict.
 * @returns Updated Task record.
 */
function updateReviewedTask(
  workspaceDb: WorkspaceDb,
  input: AdvanceGoalAfterReviewInput,
  status: Extract<GoalTaskRecord['status'], 'ready' | 'completed' | 'failed'>
): GoalTaskRecord {
  return updateGoalTask(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    taskId: input.taskId,
    status,
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Updates the Goal after Review while leaving launch authority unclaimed.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Scoped Review decision.
 * @param status Goal status produced by the verdict.
 * @param terminalStopReason Terminal stop reason, or null.
 * @returns Bounded updated Goal projection.
 */
function updateResolutionGoal(
  workspaceDb: WorkspaceDb,
  input: AdvanceGoalAfterReviewInput,
  status: GoalReviewResolutionSnapshot['goal']['status'],
  terminalStopReason: GoalReviewResolutionSnapshot['goal']['terminalStopReason']
): GoalReviewResolutionSnapshot['goal'] {
  const goal = updateGoalStatus(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    status,
    currentTaskId: null,
    terminalStopReason,
    ...(input.now ? { now: input.now } : {}),
  });

  return {
    goalId: goal.goalId,
    status,
    currentTaskId: null,
    terminalStopReason,
  };
}

/**
 * Unlocks pending Tasks whose dependencies are all completed.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Scoped Review decision.
 * @returns Latest Goal Task list after unlocks.
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
