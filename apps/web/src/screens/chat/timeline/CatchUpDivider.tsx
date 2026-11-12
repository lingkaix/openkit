import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';

/**
 * The catch-up row at B. Counts come from the server digest, which this read
 * does not carry, so the row has no digest lines.
 */
export function CatchUpDivider({
  count,
  onEarlierUnread,
}: {
  count: number;
  onEarlierUnread: () => void;
}) {
  return (
    <fieldset
      data-catch-up-divider=""
      data-voice="fact"
      className="ok-catch-up ok-voice-fact m-0 min-w-0 border-0 p-0"
      aria-label={timelineCopy.newSinceHere}
    >
      <p className="ok-meta">{timelineCopy.newSinceHere}</p>
      {count > 0 ? (
        <Button variant="quiet" size="sm" onPress={onEarlierUnread}>
          {fillCopy(timelineCopy.earlierUnread, { count })}
        </Button>
      ) : null}
    </fieldset>
  );
}
