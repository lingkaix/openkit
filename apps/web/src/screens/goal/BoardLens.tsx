import { KanbanCard, KanbanColumn } from '../../primitives';
import type { ThreadGoalSummary } from './data';
import { useGoalPlan } from './data';
import { GoalReviewGate } from './PlanLens';

export interface BoardLensProps {
  workspaceId: string;
  threadId: string;
  goal: ThreadGoalSummary;
  /** Open a card back into the Thread lens (D-007). */
  onOpenThread: () => void;
}

interface BoardCard {
  id: string;
  title: string;
  meta?: string;
  column: 'todo' | 'progress' | 'done';
}

/**
 * Derive kanban cards from the plan (when present) and the goal summary. Done is
 * a projection only — never a drop target (D-007 weak-interaction rule).
 */
function buildBoardCards(
  goal: ThreadGoalSummary,
  planTasks?: ReadonlyArray<{ taskId: string; title: string }> | null
): BoardCard[] {
  const cards: BoardCard[] = [];

  if (planTasks && planTasks.length > 0) {
    for (const task of planTasks) {
      const isCurrent = goal.currentTask?.taskId === task.taskId;
      const completedIds = new Set(goal.terminalSummary?.completedTaskIds ?? []);
      if (completedIds.has(task.taskId) || goal.status === 'completed') {
        cards.push({ id: task.taskId, title: task.title, column: 'done', meta: 'Done' });
      } else if (isCurrent) {
        cards.push({
          id: task.taskId,
          title: task.title,
          column: 'progress',
          meta: goal.currentTask?.status,
        });
      } else {
        cards.push({ id: task.taskId, title: task.title, column: 'todo', meta: 'Queued' });
      }
    }
    return cards;
  }

  if (goal.taskCounts.pending > 0 || goal.taskCounts.ready > 0) {
    cards.push({
      id: 'todo-bucket',
      title:
        goal.taskCounts.pending + goal.taskCounts.ready === 1
          ? '1 queued task'
          : `${goal.taskCounts.pending + goal.taskCounts.ready} queued tasks`,
      column: 'todo',
    });
  }
  if (goal.currentTask) {
    cards.push({
      id: goal.currentTask.taskId,
      title: goal.currentTask.title,
      column: 'progress',
      meta: goal.currentTask.status,
    });
  } else if (goal.taskCounts.running > 0 || goal.taskCounts.reviewing > 0) {
    cards.push({
      id: 'progress-bucket',
      title: 'In-progress work',
      column: 'progress',
    });
  }
  if (goal.taskCounts.completed > 0) {
    const ids = goal.terminalSummary?.completedTaskIds;
    if (ids && ids.length > 0) {
      for (const id of ids) {
        cards.push({ id, title: id, column: 'done', meta: 'Done' });
      }
    } else {
      cards.push({
        id: 'done-bucket',
        title: `${goal.taskCounts.completed} completed`,
        column: 'done',
        meta: 'Done',
      });
    }
  }
  return cards;
}

/**
 * Board lens (board 06) — kanban projection of goal data. Cards open back into
 * the Thread lens. Done is display-only; there is no control that moves a card
 * into Done via drag (keyboard/button Skip stays conceptual for v1).
 */
export function BoardLens({ workspaceId, threadId, goal, onOpenThread }: BoardLensProps) {
  const planQuery = useGoalPlan(workspaceId, threadId, goal.status);
  const cards = buildBoardCards(goal, planQuery.data?.plan.tasks);
  const todo = cards.filter((c) => c.column === 'todo');
  const progress = cards.filter((c) => c.column === 'progress');
  const done = cards.filter((c) => c.column === 'done');

  return [
    <GoalReviewGate key="review" workspaceId={workspaceId} threadId={threadId} goal={goal} />,
    <section key="board" className="mt-5 flex gap-3 overflow-x-auto pb-2" aria-label="Goal board">
      <KanbanColumn title="To do" count={todo.length}>
        {todo.map((card) => (
          <KanbanCard
            key={card.id}
            title={card.title}
            hue="scout"
            initials="WK"
            worker="Worker"
            meta={card.meta}
            onOpen={onOpenThread}
          />
        ))}
      </KanbanColumn>
      <KanbanColumn title="In progress" count={progress.length}>
        {progress.map((card) => (
          <KanbanCard
            key={card.id}
            title={card.title}
            hue="quill"
            initials="WK"
            worker="Worker"
            meta={card.meta}
            onOpen={onOpenThread}
          />
        ))}
      </KanbanColumn>
      <KanbanColumn title="Done" count={done.length}>
        {done.map((card) => (
          <KanbanCard
            key={card.id}
            title={card.title}
            hue="ledger"
            initials="WK"
            worker="Worker"
            meta={card.meta}
            onOpen={onOpenThread}
          />
        ))}
      </KanbanColumn>
    </section>,
  ];
}
