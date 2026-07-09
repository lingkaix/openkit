import { describe, expect, it } from 'vitest';

import type { GoalTaskRecord } from './goal-store.js';
import { selectNextReadyGoalTask } from './goal-task-selector.js';

/**
 * Creates a goal task record fixture for selector tests.
 *
 * @param input Task fixture overrides.
 * @returns Goal task record.
 */
function task(input: Partial<GoalTaskRecord> & Pick<GoalTaskRecord, 'taskId'>): GoalTaskRecord {
  return {
    taskId: input.taskId,
    workspaceId: input.workspaceId ?? 'ws_demo',
    threadId: input.threadId ?? 'th_demo',
    goalId: input.goalId ?? 'goal_demo',
    status: input.status ?? 'ready',
    title: input.title ?? input.taskId,
    objective: input.objective ?? `Complete ${input.taskId}.`,
    orderIndex: input.orderIndex ?? 0,
    dependsOnTaskIds: input.dependsOnTaskIds ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? ['Task is complete.'],
    contextBudgetTokens: input.contextBudgetTokens ?? 12_000,
    createdAt: input.createdAt ?? '2026-05-31T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-05-31T00:00:00.000Z',
  };
}

describe('goal task selector', () => {
  it('returns the first ready task by plan order', () => {
    expect(
      selectNextReadyGoalTask([
        task({ taskId: 'task_later', orderIndex: 2 }),
        task({ taskId: 'task_first', orderIndex: 1 }),
      ])
    ).toMatchObject({ taskId: 'task_first' });
  });

  it('ignores pending tasks with unmet dependencies and terminal task statuses', () => {
    expect(
      selectNextReadyGoalTask([
        task({ taskId: 'task_pending', orderIndex: 0, status: 'pending' }),
        task({ taskId: 'task_completed', orderIndex: 1, status: 'completed' }),
        task({ taskId: 'task_skipped', orderIndex: 2, status: 'skipped' }),
        task({ taskId: 'task_blocked', orderIndex: 3, status: 'blocked' }),
        task({ taskId: 'task_failed', orderIndex: 4, status: 'failed' }),
        task({ taskId: 'task_ready', orderIndex: 5, status: 'ready' }),
      ])
    ).toMatchObject({ taskId: 'task_ready' });
  });

  it('returns null when no task is ready', () => {
    expect(
      selectNextReadyGoalTask([
        task({ taskId: 'task_pending', status: 'pending' }),
        task({ taskId: 'task_done', status: 'completed' }),
      ])
    ).toBeNull();
  });
});
