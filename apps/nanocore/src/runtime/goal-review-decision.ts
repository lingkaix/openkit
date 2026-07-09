import type { StopReason } from '@openkit/protocol';

import type { WorkspaceDb } from '../storage/db.js';
import type { GoalReviewVerdict } from '../storage/schema/index.js';
import type { GoalRecord, GoalTaskRecord } from './goal-store.js';
import { updateGoalStatus, updateGoalTask } from './goal-store.js';

/**
 * Deterministic supervise-loop outcome produced by a review verdict.
 */
export type GoalReviewDecisionOutcome =
  | 'continue'
  | 'needs_revision'
  | 'retry'
  | 'decompose'
  | 'awaiting_human'
  | 'blocked'
  | 'aborted';

/**
 * Input used to apply one review checkpoint verdict.
 */
export interface ApplyGoalReviewDecisionInput {
  /** Workspace that owns the reviewed task. */
  readonly workspaceId: string;
  /** Thread that owns the reviewed task. */
  readonly threadId: string;
  /** Goal that owns the reviewed task. */
  readonly goalId: string;
  /** Reviewed goal task id. */
  readonly taskId: string;
  /** Review verdict to apply. */
  readonly verdict: GoalReviewVerdict;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Result returned after a review checkpoint verdict has been applied.
 */
export interface GoalReviewDecisionResult {
  /** Supervise-loop outcome for the caller. */
  readonly outcome: GoalReviewDecisionOutcome;
  /** Whether the decision terminates the current goal flow. */
  readonly terminal: boolean;
  /** Updated task record. */
  readonly task: GoalTaskRecord;
  /** Updated goal record when the verdict changes goal state. */
  readonly goal: GoalRecord | null;
}

/**
 * Applies a deterministic review checkpoint verdict to app-local goal task state.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review decision input.
 * @returns Deterministic decision result for the supervise loop.
 * @throws Error when the goal or task does not exist in the requested scope.
 */
export function applyGoalReviewDecision(
  workspaceDb: WorkspaceDb,
  input: ApplyGoalReviewDecisionInput
): GoalReviewDecisionResult {
  switch (input.verdict) {
    case 'accept':
      return updateTaskOnly(workspaceDb, input, 'completed', 'continue', false);
    case 'refine':
      return updateTaskOnly(workspaceDb, input, 'needs_revision', 'needs_revision', false);
    case 'retry':
      return updateTaskOnly(workspaceDb, input, 'ready', 'retry', false);
    case 'decompose':
      return updateTaskOnly(workspaceDb, input, 'needs_revision', 'decompose', false);
    case 'ask_user':
      return updateTaskAndGoal(workspaceDb, input, {
        taskStatus: 'reviewing',
        goalStatus: 'awaiting_user',
        outcome: 'awaiting_human',
        terminal: false,
        terminalStopReason: null,
      });
    case 'block':
      return updateTaskAndGoal(workspaceDb, input, {
        taskStatus: 'blocked',
        goalStatus: 'blocked',
        outcome: 'blocked',
        terminal: true,
        terminalStopReason: 'ask_user',
      });
    case 'abort':
      return updateTaskAndGoal(workspaceDb, input, {
        taskStatus: 'failed',
        goalStatus: 'aborted',
        outcome: 'aborted',
        terminal: true,
        terminalStopReason: 'aborted',
      });
  }
}

/**
 * Applies a review decision that only changes task state.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review decision input.
 * @param taskStatus Task status to write.
 * @param outcome Supervise-loop outcome.
 * @param terminal Whether the outcome is terminal.
 * @returns Deterministic decision result.
 */
function updateTaskOnly(
  workspaceDb: WorkspaceDb,
  input: ApplyGoalReviewDecisionInput,
  taskStatus: GoalTaskRecord['status'],
  outcome: GoalReviewDecisionOutcome,
  terminal: boolean
): GoalReviewDecisionResult {
  const task = updateGoalTask(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    taskId: input.taskId,
    status: taskStatus,
    ...(input.now ? { now: input.now } : {}),
  });

  return { goal: null, outcome, task, terminal };
}

/**
 * Options for applying a review decision that changes task and goal state.
 */
interface UpdateTaskAndGoalOptions {
  /** Task status to write. */
  readonly taskStatus: GoalTaskRecord['status'];
  /** Goal status to write. */
  readonly goalStatus: GoalRecord['status'];
  /** Supervise-loop outcome. */
  readonly outcome: GoalReviewDecisionOutcome;
  /** Whether the outcome is terminal. */
  readonly terminal: boolean;
  /** Terminal stop reason to store on the goal. */
  readonly terminalStopReason: StopReason | null;
}

/**
 * Applies a review decision that changes both task and goal state.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review decision input.
 * @param options Task and goal state transition options.
 * @returns Deterministic decision result.
 */
function updateTaskAndGoal(
  workspaceDb: WorkspaceDb,
  input: ApplyGoalReviewDecisionInput,
  options: UpdateTaskAndGoalOptions
): GoalReviewDecisionResult {
  const task = updateGoalTask(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    taskId: input.taskId,
    status: options.taskStatus,
    ...(input.now ? { now: input.now } : {}),
  });
  const goal = updateGoalStatus(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    status: options.goalStatus,
    currentTaskId: input.taskId,
    terminalStopReason: options.terminalStopReason,
    ...(input.now ? { now: input.now } : {}),
  });

  return {
    goal,
    outcome: options.outcome,
    task,
    terminal: options.terminal,
  };
}
