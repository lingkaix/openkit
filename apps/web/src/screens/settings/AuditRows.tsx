import { Link } from 'react-router-dom';
import { ListRow, StatusChip, type StatusTone } from '../../primitives';
import { conversationThreadPath } from '../chat/data';
import type { ThreadAudience } from '../chat/timeline/audience';
import { useThreadAudience } from '../chat/timeline/audience';
import { BackLink } from '../chat/timeline/BackLink';
import type { AuditEventDisplayRow, PermissionDecisionDisplayRow } from './data';

type ThreadActivity = Parameters<typeof conversationThreadPath>[2];

/**
 * Reads conversation.navigation for the workspaces on the loaded rows.
 * A client without that operation stays on the chat route and does not invent a Task.
 *
 * @param workspaceIds Workspace ids recorded on the current rows.
 * @returns A lookup that is pending only while a real navigation read is in flight.
 */
export function useThreadActivity(workspaceIds: readonly (string | null | undefined)[]) {
  return useThreadAudience(workspaceIds);
}

const threadLinkClass =
  'inline-flex min-h-11 items-center break-all text-xs font-bold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus';

/** Activity route for one recorded thread. Pending navigation renders nothing. */
export function ThreadLink({
  workspaceId,
  threadId,
  activity,
}: {
  workspaceId: string | null;
  threadId: string | null;
  activity: ThreadActivity | 'pending';
}) {
  if (!workspaceId || !threadId || activity === 'pending') return null;
  return (
    <Link to={conversationThreadPath(workspaceId, threadId, activity)} className={threadLinkClass}>
      {activityLinkName(activity)}
    </Link>
  );
}

function activityLinkName(activity: ThreadActivity): string {
  if (activity === 'task') return 'Open the Task';
  if (activity === 'goal') return 'Open the Goal';
  return 'Open the Assistant';
}

/**
 * Maps producer status values to the fixed Design vocabulary.
 *
 * @param value Capability, audit, or permission status.
 * @returns Plain status label and semantic tone.
 */
export function evidenceStatus(value: string): { label: string; tone: StatusTone } {
  switch (value) {
    case 'queued':
      return { label: 'Queued', tone: 'neutral' };
    case 'running':
      return { label: 'Running', tone: 'informative' };
    case 'succeeded':
      return { label: 'Done', tone: 'positive' };
    case 'allow':
      return { label: 'Approved', tone: 'positive' };
    case 'require_approval':
      return { label: 'Awaiting approval', tone: 'notice' };
    case 'require_escalation':
    case 'defer':
    case 'not_applicable':
      return { label: 'Blocked', tone: 'notice' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'denied':
    case 'deny':
      return { label: 'Rejected', tone: 'negative' };
    case 'failed':
      return { label: 'Failed', tone: 'negative' };
    case 'error':
      return { label: 'Error', tone: 'negative' };
  }
  return { label: 'Error', tone: 'negative' };
}

/** Renders one recorded instant, or an explicit unavailable label when the producer omitted it. */
export function RecordedTime({ value }: { value?: string }) {
  return (
    <p className="text-xs text-fg-muted">
      {value ? (
        <time dateTime={value} title={value}>
          {new Date(value).toLocaleString(undefined, { timeZoneName: 'short' })}
        </time>
      ) : (
        'Not recorded'
      )}
    </p>
  );
}

/**
 * Renders one whitelisted audit-event row with its recorded actor and lineage.
 *
 * @param props Safe audit metadata.
 */
export function AuditEventRow({
  event,
  activity = 'unknown',
  audience = { status: 'unknown' },
}: {
  event: AuditEventDisplayRow;
  activity?: ThreadActivity | 'pending';
  /** Audience for the From line. Unknown or pending shows no title. */
  audience?: ThreadAudience;
}) {
  const status = evidenceStatus(event.outcome);
  const linkActivity = activity === 'pending' ? null : activity;
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{event.action}</p>
        <p className="text-xs text-fg-muted">{event.summary}</p>
        <p className="text-xs text-fg-muted">{event.category}</p>
        <p className="break-all text-xs text-fg-muted">
          {event.actor ? `Actor: ${event.actor.kind} · ${event.actor.id}` : 'Actor not recorded'}
        </p>
        <ThreadLink
          workspaceId={event.workspaceId}
          threadId={event.threadId}
          activity={linkActivity ?? 'pending'}
        />
        <BackLink
          workspaceId={event.workspaceId}
          threadId={event.threadId}
          turnId={event.turnId}
          recordedAt={event.recordedAt}
          audience={audience}
        />
        {event.turnId ? (
          <p className="break-all text-xs text-fg-muted">Turn: {event.turnId}</p>
        ) : null}
        {event.requestId ? (
          <p className="break-all text-xs text-fg-muted">Request: {event.requestId}</p>
        ) : null}
        {event.action === 'turn.interrupt' && event.outcome === 'succeeded' ? (
          <p className="text-xs text-fg-muted">
            Stop request accepted. Runtime cleanup is not confirmed by this event.
          </p>
        ) : null}
        {event.recordedAt ? (
          <p className="break-all text-xs text-fg-muted">{event.recordedAt}</p>
        ) : null}
        <RecordedTime value={event.recordedAt} />
      </div>
      <StatusChip tone={status.tone} dot>
        {status.label}
      </StatusChip>
    </ListRow>
  );
}

/**
 * Renders one whitelisted permission-decision row.
 *
 * @param props Safe decision metadata.
 */
export function PermissionDecisionRow({ decision }: { decision: PermissionDecisionDisplayRow }) {
  const status = evidenceStatus(decision.result);
  return (
    <div id={`decision-${decision.decisionId}`} tabIndex={-1}>
      <ListRow>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-fg-strong">{decision.action}</p>
          {decision.createdAt ? (
            <p className="break-all text-xs text-fg-muted">{decision.createdAt}</p>
          ) : null}
          <RecordedTime value={decision.createdAt} />
        </div>
        <StatusChip tone={status.tone} dot>
          {status.label}
        </StatusChip>
      </ListRow>
    </div>
  );
}
