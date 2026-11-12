import { Link } from 'react-router-dom';
import type { ThreadAudience } from './audience';
import { fillCopy } from './copy';
import { timelineNotices } from './notices';
import { hrefOf, resolve } from './resolve';

const linkClass =
  'inline-flex min-h-11 items-center text-xs font-bold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus';

/**
 * "From: <title> · run at hh:mm" after the audience check.
 * A hidden source shows the denial sentence and no title. A pending read shows nothing.
 */
export function BackLink({
  workspaceId,
  threadId,
  turnId,
  audience,
}: {
  workspaceId: string | null;
  threadId: string | null;
  turnId?: string | null;
  /**
   * Kept so existing callers can pass an artifact, audit, or call time.
   * That instant is not the run start, so it never becomes "run at".
   */
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
  // No read on this surface carries the run's startedAt. Do not guess it from recordedAt.
  const label = fillCopy(timelineNotices.backLinkNoTime, { title });
  const href = hrefOf(resolved);
  if (!href) return null;
  return (
    <Link to={href} className={linkClass}>
      {label}
    </Link>
  );
}
