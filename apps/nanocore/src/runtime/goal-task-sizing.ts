import {
  GOAL_PLAN_TASK_MAX_CONTEXT_TOKENS,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
} from './goal-plan.js';

/** Default reference budget used to decide whether one goal task is oversized. */
export const DEFAULT_GOAL_TASK_REFERENCE_BUDGET_TOKENS = GOAL_PLAN_TASK_MAX_CONTEXT_TOKENS;

/**
 * Input for evaluating approved goal task sizing.
 */
export interface EvaluateGoalTaskSizingInput {
  /** Plan output containing tasks to evaluate. */
  readonly plan: GoalPlanOutput;
  /** Optional context budget reference. */
  readonly referenceBudgetTokens?: number;
}

/**
 * Goal task that can be dispatched under the current reference budget.
 */
export interface DispatchableGoalTaskSizing {
  /** Planned task id. */
  readonly taskId: string;
  /** Estimated task context budget. */
  readonly contextBudgetTokens: number;
}

/**
 * Goal task that must be revised or split before dispatch.
 */
export interface OversizedGoalTaskSizing {
  /** Planned task id. */
  readonly taskId: string;
  /** Estimated task context budget. */
  readonly contextBudgetTokens: number;
  /** Required pre-dispatch remediation. */
  readonly recommendedAction: 'revise_or_split';
}

/**
 * Task sizing guard result.
 */
export interface GoalTaskSizingResult {
  /** True when every task fits the reference budget. */
  readonly ok: boolean;
  /** Reference budget used for the evaluation. */
  readonly referenceBudgetTokens: number;
  /** Tasks that may continue toward dispatch. */
  readonly dispatchableTasks: readonly DispatchableGoalTaskSizing[];
  /** Tasks that require revision or splitting before dispatch. */
  readonly oversizedTasks: readonly OversizedGoalTaskSizing[];
}

/**
 * Evaluates plan task context estimates before worker dispatch.
 *
 * @param input Plan and optional reference budget.
 * @returns Sizing guard result.
 */
export function evaluateGoalTaskSizing(input: EvaluateGoalTaskSizingInput): GoalTaskSizingResult {
  const plan = GoalPlanOutputSchema.parse(input.plan);
  const referenceBudgetTokens =
    input.referenceBudgetTokens ?? DEFAULT_GOAL_TASK_REFERENCE_BUDGET_TOKENS;
  const dispatchableTasks: DispatchableGoalTaskSizing[] = [];
  const oversizedTasks: OversizedGoalTaskSizing[] = [];

  for (const task of plan.tasks) {
    if (task.contextBudgetTokens > referenceBudgetTokens) {
      oversizedTasks.push({
        taskId: task.taskId,
        contextBudgetTokens: task.contextBudgetTokens,
        recommendedAction: 'revise_or_split',
      });
    } else {
      dispatchableTasks.push({
        taskId: task.taskId,
        contextBudgetTokens: task.contextBudgetTokens,
      });
    }
  }

  return {
    ok: oversizedTasks.length === 0,
    referenceBudgetTokens,
    dispatchableTasks: oversizedTasks.length === 0 ? dispatchableTasks : [],
    oversizedTasks,
  };
}
