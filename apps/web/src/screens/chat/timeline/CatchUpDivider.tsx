import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { type QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';
import { digestAnchorLocation, type TimelineDigest, visibleDigest } from './digest';
import { type HeldTimeline, timelineJump } from './window';

/**
 * The catch-up row at B, plus the server digest under it.
 * Lines and coverage come from `thread.timeline`. A kind that read omits is not shown.
 */
function recordedFromWindow(
  client: QueryClient | undefined
): ThreadTimelineResponse['earlierUnread'] | undefined {
  if (!client) return undefined;
  const active = client
    .getQueryCache()
    .findAll({ queryKey: ['thread-timeline'] })
    .filter((query) => query.getObserversCount() > 0);
  for (const query of active) {
    const data = query.state.data as HeldTimeline | undefined;
    if (data && Object.hasOwn(data, 'earlierUnread')) return data.earlierUnread;
  }
  return undefined;
}

export function CatchUpDivider({
  count,
  onEarlierUnread,
  digest = null,
  earlierUnreadUnresolved = false,
  recorded,
}: {
  count: number;
  onEarlierUnread: () => void;
  /** Digest from the timeline window that renders this divider. */
  digest?: TimelineDigest | null;
  /** Unread ids this read cannot place, so no count or oldest is shown. */
  earlierUnreadUnresolved?: boolean;
  /** Server earlier-unread object. Omit to read the timeline window, then the loaded-window fallback. */
  recorded?: ThreadTimelineResponse['earlierUnread'];
}) {
  const shown = digest;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useContext(QueryClientContext);
  const source = recorded !== undefined ? recorded : recordedFromWindow(queryClient);
  const catchUp = timelineJump({
    pathname: location.pathname,
    search: location.search,
    jump: { kind: 'catch-up' },
  });
  const line = earlierUnreadLine(source, count, earlierUnreadUnresolved);
  return (
    <fieldset
      data-catch-up-divider=""
      data-voice="fact"
      data-digest-coverage={shown?.coverage}
      className="ok-catch-up ok-voice-fact m-0 min-w-0 border-0 p-0"
      aria-label={timelineCopy.newSinceHere}
    >
      <p className="ok-meta">
        <Link
          to={{ pathname: catchUp.pathname, search: catchUp.search }}
          replace
          className="inline-flex min-h-11 items-center"
        >
          {timelineCopy.newSinceHere}
        </Link>
      </p>
      <div className="ok-earlier-unread">
        {line?.kind === 'jump' ? (
          <Button
            variant="quiet"
            size="sm"
            onPress={() => {
              if (!line.itemId) {
                onEarlierUnread();
                return;
              }
              const target = timelineJump({
                pathname: location.pathname,
                search: location.search,
                jump: { kind: 'item', itemId: line.itemId },
              });
              navigate({ pathname: target.pathname, search: target.search }, { replace: true });
            }}
          >
            {line.text}
          </Button>
        ) : line?.kind === 'plain' ? (
          <p className="ok-meta">{line.text}</p>
        ) : null}
      </div>
      {shown ? <DigestLines digest={shown} /> : null}
    </fieldset>
  );
}

function earlierUnreadLine(
  source: ThreadTimelineResponse['earlierUnread'] | undefined,
  count: number,
  unresolved: boolean
): { kind: 'jump'; text: string; itemId: string } | { kind: 'plain'; text: string } | null {
  if (source === undefined) {
    if (count > 0) {
      return { kind: 'jump', text: fillCopy(timelineCopy.earlierUnread, { count }), itemId: '' };
    }
    return unresolved ? { kind: 'plain', text: timelineCopy.earlierUnreadUnknown } : null;
  }
  if (source === null) return { kind: 'plain', text: timelineCopy.earlierUnreadUnknown };
  if (source.count <= 0) return null;
  const text = source.capped
    ? timelineCopy.earlierUnreadCapped
    : fillCopy(timelineCopy.earlierUnread, { count: source.count });
  if (!source.oldest) return { kind: 'plain', text };
  return { kind: 'jump', text, itemId: source.oldest.itemId };
}

function DigestLines({ digest }: { digest: TimelineDigest }) {
  const view = visibleDigest(digest);
  const navigate = useNavigate();
  const location = useLocation();
  if (view.lines.length === 0 && !view.partial) return null;
  return (
    <>
      {view.lines.length > 0 ? (
        <ul
          data-digest-lines=""
          className="m-0 flex w-full basis-full list-none flex-col gap-1 p-0"
        >
          {view.lines.map((line) => (
            <li key={line.kind}>
              <Button
                variant="quiet"
                size="sm"
                data-digest-kind={line.kind}
                onPress={() => {
                  const target = digestAnchorLocation({
                    pathname: location.pathname,
                    search: location.search,
                    anchor: line.anchor,
                  });
                  navigate({ pathname: target.pathname, search: target.search }, { replace: true });
                }}
              >
                {line.label}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {view.partial ? <p className="ok-meta w-full basis-full">{view.partial}</p> : null}
    </>
  );
}
