import { describe, expect, it } from 'vitest';

import { createDeterministicGoalPlanFallback } from './goal-plan.js';
import {
  DEFAULT_GOAL_TASK_REFERENCE_BUDGET_TOKENS,
  evaluateGoalTaskSizing,
} from './goal-task-sizing.js';

describe('goal task sizing guard', () => {
  it('allows under-budget tasks before worker dispatch', () => {
    const plan = createDeterministicGoalPlanFallback({
      goalTitle: 'Under budget goal',
      objective: 'Complete a small task.',
    });

    const result = evaluateGoalTaskSizing({ plan });

    expect(result).toEqual({
      ok: true,
      referenceBudgetTokens: DEFAULT_GOAL_TASK_REFERENCE_BUDGET_TOKENS,
      dispatchableTasks: [{ taskId: 'task_1', contextBudgetTokens: 12_000 }],
      oversizedTasks: [],
    });
  });

  it('marks oversized tasks for revision or split before worker dispatch', () => {
    const plan = createDeterministicGoalPlanFallback({
      goalTitle: 'Oversized goal',
      objective: 'Complete an oversized task.',
    });

    const result = evaluateGoalTaskSizing({
      referenceBudgetTokens: 10_000,
      plan: {
        ...plan,
        tasks: [
          {
            ...plan.tasks[0],
            contextBudgetTokens: 12_000,
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      referenceBudgetTokens: 10_000,
      dispatchableTasks: [],
      oversizedTasks: [
        {
          taskId: 'task_1',
          contextBudgetTokens: 12_000,
          recommendedAction: 'revise_or_split',
        },
      ],
    });
  });
});
