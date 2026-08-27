import { Card, StatusChip } from '../../primitives';
import { ThreadStream } from '../chat/ThreadStream';
import type { ThreadGoalSummary } from './data';
import { GoalReviewGate } from './PlanLens';

export interface ThreadLensProps {
  workspaceId: string | null;
  threadId: string;
  goal: ThreadGoalSummary;
  /** When true (runtime disconnected), inline approvals are read-only. */
  readOnly?: boolean;
}

/**
 * Thread lens (board 05c) — conversation stream with a catch-up card derived
 * from the goal summary (current task, pending attention, task counts). No
 * invented kernel fields.
 */
export function ThreadLens({ workspaceId, threadId, goal, readOnly }: ThreadLensProps) {
  const catchUpParts: string[] = [];
  if (goal.currentTask) {
    catchUpParts.push(`Current: ${goal.currentTask.title} (${goal.currentTask.status}).`);
  }
  if (goal.pendingHumanAttention.required && goal.pendingHumanAttention.reason) {
    catchUpParts.push(goal.pendingHumanAttention.reason);
  }
  const { pending, running, completed, blocked } = goal.taskCounts;
  catchUpParts.push(
    `Tasks — pending ${pending}, running ${running}, completed ${completed}${blocked ? `, blocked ${blocked}` : ''}.`
  );

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">Catch-up</p>
            <p className="mt-1 text-sm text-fg">{catchUpParts.join(' ')}</p>
          </div>
          <StatusChip tone="informative" dot>
            {goal.status}
          </StatusChip>
        </div>
      </Card>
      <GoalReviewGate
        workspaceId={workspaceId ?? ''}
        threadId={threadId}
        goal={goal}
        readOnly={readOnly || !workspaceId}
      />
      <ThreadStream
        workspaceId={workspaceId}
        threadId={threadId}
        readOnly={readOnly}
        emptyTitle="No goal activity yet"
      />
    </div>
  );
}
