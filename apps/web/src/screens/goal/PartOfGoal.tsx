import { Link } from 'react-router-dom';
import { timelineCopy } from '../chat/timeline/copy';
import { useGoalView } from './data';

/**
 * Back-link from a Task to its Goal card.
 * Admission stores the Coordinator thread as the Task's parent. goal.read finds the Goal there.
 * A Task with no parent thread cannot discover its Goal with today's read.
 */
export function PartOfGoal({
  workspaceId,
  threadId,
  parentThreadId,
}: {
  workspaceId: string | null;
  threadId: string;
  parentThreadId?: string;
}) {
  const view = useGoalView(workspaceId, parentThreadId ?? '');
  const goal = view.data?.goal;
  const task = view.data?.tasks.find((entry) => entry.threadId === threadId);
  if (!workspaceId || !goal || !task || goal.threadId !== parentThreadId) return null;
  return (
    <Link
      className="shrink-0 text-sm font-bold text-accent"
      to={`/goals/${encodeURIComponent(workspaceId)}/${encodeURIComponent(goal.threadId)}?card=${encodeURIComponent(task.cardId)}`}
    >
      {timelineCopy.partOfGoal}
    </Link>
  );
}
