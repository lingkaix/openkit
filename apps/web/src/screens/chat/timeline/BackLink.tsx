import { Link } from 'react-router-dom';
import type { ThreadAudience } from './audience';
import { fillCopy } from './copy';
import { timelineNotices } from './notices';
import { hrefOf, resolve } from './resolve';
import { formatClockTime } from './time';

const linkClass =
  'inline-flex min-h-11 items-center text-xs font-bold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus';

/** Hour and minute from a recorded instant. An unparseable value is omitted. */
export function runClock(iso: string | null | undefined): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  const clock = formatClockTime(iso);
  return clock === iso ? null : clock;
}

/**
 * "From: <title> · run at hh:mm" after the audience check.
 * A hidden source shows the denial sentence and no title. A pending read shows nothing.
 */
export function BackLink({
  workspaceId,
  threadId,
  turnId,
  recordedAt,
  audience,
}: {
  workspaceId: string | null;
  threadId: string | null;
  turnId?: string | null;
  recordedAt?: string | null;
  audience: ThreadAudience;
}) {
  if (!workspaceId || !threadId) return null;
  if (audience.status === 'pending' || audience.status === 'unknown') return null;
  if (audience.status === 'denied') {
    return <p className="text-xs text-fg-muted">{timelineNotices.sourceNotAvailable}</p>;
  }
  const facts = new Map([[threadId, { activity: audience.activity, name: audience.name }]]);
  const resolved = resolve(
    {
      kind: 'thread',
      workspaceId,
      threadId,
      turnId: turnId ?? undefined,
    },
    { threads: facts }
  );
  if ('unavailable' in resolved) {
    return <p className="text-xs text-fg-muted">{timelineNotices.sourceNotAvailable}</p>;
  }
  const title = audience.name?.trim() || timelineNotices.untitledConversation;
  const clock = turnId ? runClock(recordedAt) : null;
  const label = clock
    ? fillCopy(timelineNotices.backLink, { title, time: clock })
    : fillCopy(timelineNotices.backLinkNoTime, { title });
  const href = hrefOf(resolved);
  if (!href) return null;
  return (
    <Link to={href} className={linkClass}>
      {label}
    </Link>
  );
}
