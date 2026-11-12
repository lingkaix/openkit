import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useCoreClient } from '../../../app/core-client';
import { accountGeneration } from '../../account/generation';
import type { ThreadAudience } from './audience';
import { fillCopy } from './copy';
import { timelineNotices } from './notices';
import { hrefOf, resolve } from './resolve';
import { formatClockTime } from './time';

/**
 * Recorded run start for the back-link clock.
 * An explicit null stays blank. Otherwise turn.read supplies Turn.startedAt.
 * Artifact, audit, and call times are never accepted here.
 */
function useRecordedRunStart(
  workspaceId: string | null,
  threadId: string | null,
  turnId: string | null | undefined,
  startedAt: string | null | undefined,
  audienceOpen: boolean
): string | null {
  const client = useCoreClient();
  const lookup =
    startedAt === undefined && audienceOpen && Boolean(workspaceId && threadId && turnId);
  const query = useQuery({
    queryKey: ['timeline-run-start', workspaceId ?? '', threadId ?? '', turnId ?? ''],
    enabled: lookup,
    retry: false,
    queryFn: async () => {
      const generation = accountGeneration();
      const read = client.operations['turn.read'];
      if (typeof read !== 'function' || !workspaceId || !threadId || !turnId) return null;
      const turn = await read({ workspaceId, threadId, turnId });
      if (generation !== accountGeneration()) {
        throw new Error('Discarded an earlier account response.');
      }
      const at = turn?.startedAt;
      return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
    },
  });
  if (startedAt !== undefined) {
    return typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt))
      ? startedAt
      : null;
  }
  return query.data ?? null;
}

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
  startedAt,
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
  /**
   * Recorded run start from a run row or turn.read.
   * Null means the read has no clock. Omit it to read turn.startedAt.
   */
  startedAt?: string | null;
  audience: ThreadAudience;
}) {
  const recordedStart = useRecordedRunStart(
    workspaceId,
    threadId,
    turnId,
    startedAt,
    audience.status === 'open'
  );
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
  const clock =
    recordedStart && Number.isFinite(Date.parse(recordedStart))
      ? formatClockTime(recordedStart)
      : null;
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
