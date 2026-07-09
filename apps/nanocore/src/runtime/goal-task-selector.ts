import type { GoalTaskRecord } from './goal-store.js';

/**
 * Selects the next ready goal task in deterministic plan order.
 *
 * @param tasks Goal task records to inspect.
 * @returns First ready task by order and id, or null when none is ready.
 */
export function selectNextReadyGoalTask(tasks: readonly GoalTaskRecord[]): GoalTaskRecord | null {
  return (
    tasks
      .filter((task) => task.status === 'ready')
      .toSorted((left, right) => {
        const orderDelta = left.orderIndex - right.orderIndex;

        return orderDelta === 0 ? left.taskId.localeCompare(right.taskId) : orderDelta;
      })
      .at(0) ?? null
  );
}
