import { useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';
import {
  digestAnchorLocation,
  readTimelineDigest,
  subscribeTimelineDigest,
  type TimelineDigest,
  visibleDigest,
} from './digest';

/**
 * The catch-up row at B, plus the server digest under it.
 * Lines and coverage come from `thread.timeline`. A kind that read omits is not shown.
 */
export function CatchUpDivider({
  count,
  onEarlierUnread,
  digest,
}: {
  count: number;
  onEarlierUnread: () => void;
  /** Test double. The screen reads the published timeline digest when this is omitted. */
  digest?: TimelineDigest | null;
}) {
  const published = useSyncExternalStore(subscribeTimelineDigest, readTimelineDigest, () => null);
  const shown = digest === undefined ? published : digest;
  return (
    <fieldset
      data-catch-up-divider=""
      data-voice="fact"
      data-digest-coverage={shown?.coverage}
      className="ok-catch-up ok-voice-fact m-0 min-w-0 border-0 p-0"
      aria-label={timelineCopy.newSinceHere}
    >
      <p className="ok-meta">{timelineCopy.newSinceHere}</p>
      {count > 0 ? (
        <Button variant="quiet" size="sm" onPress={onEarlierUnread}>
          {fillCopy(timelineCopy.earlierUnread, { count })}
        </Button>
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
