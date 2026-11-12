import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';
import { digestAnchorLocation, type TimelineDigest, visibleDigest } from './digest';
import { timelineJump } from './window';

/**
 * The catch-up row at B, plus the server digest under it.
 * Lines and coverage come from `thread.timeline`. A kind that read omits is not shown.
 */
export function CatchUpDivider({
  count,
  onEarlierUnread,
  digest = null,
  earlierUnreadUnresolved = false,
}: {
  count: number;
  onEarlierUnread: () => void;
  /** Digest from the timeline window that renders this divider. */
  digest?: TimelineDigest | null;
  /** Unread ids this read cannot place, so no count or oldest is shown. */
  earlierUnreadUnresolved?: boolean;
}) {
  const shown = digest;
  const location = useLocation();
  const catchUp = timelineJump({
    pathname: location.pathname,
    search: location.search,
    jump: { kind: 'catch-up' },
  });
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
      {count > 0 ? (
        <Button variant="quiet" size="sm" onPress={onEarlierUnread}>
          {fillCopy(timelineCopy.earlierUnread, { count })}
        </Button>
      ) : earlierUnreadUnresolved ? (
        <p className="ok-meta">{timelineCopy.earlierUnreadUnknown}</p>
      ) : null}
      {shown ? <DigestLines digest={shown} /> : null}
    </fieldset>
  );
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
