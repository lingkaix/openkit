import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';
import { digestAnchorLocation, type TimelineDigest, visibleDigest } from './digest';
import { timelineJump } from './window';

/**
 * The catch-up row at B, plus the server digest under it.
 * The earlier-unread line comes only from the window that renders this divider.
 * A null or omitted server object is unknown. A loaded-window count is not a substitute.
 */
export function CatchUpDivider({
  digest = null,
  recorded,
}: {
  /** Accepted so existing callers still typecheck. It does not paint a count. */
  count?: number;
  /** Accepted so existing callers still typecheck. The divider jumps from `recorded.oldest`. */
  onEarlierUnread?: () => void;
  /** Digest from the timeline window that renders this divider. */
  digest?: TimelineDigest | null;
  /** Accepted so existing callers still typecheck. Omission is already unknown. */
  earlierUnreadUnresolved?: boolean;
  /** Server earlier-unread object from the current timeline window. */
  recorded?: ThreadTimelineResponse['earlierUnread'];
}) {
  const shown = digest;
  const location = useLocation();
  const navigate = useNavigate();
  const source = recorded;
  const catchUp = timelineJump({
    pathname: location.pathname,
    search: location.search,
    jump: { kind: 'catch-up' },
  });
  const line = earlierUnreadLine(source);
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
  source: ThreadTimelineResponse['earlierUnread'] | undefined
): { kind: 'jump'; text: string; itemId: string } | { kind: 'plain'; text: string } | null {
  if (source == null) return { kind: 'plain', text: timelineCopy.earlierUnreadUnknown };
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
