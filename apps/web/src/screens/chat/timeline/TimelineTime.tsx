import { useRef, useState } from 'react';
import { formatTimelineTime, useTimelineNow } from './time';

/** Long enough that a tap does not replace the relative time. */
const LONG_PRESS_MS = 500;

/**
 * One instant. The visible text is relative within 24 hours.
 * A long press shows the absolute time. The title is the same instant.
 */
export function TimelineTime({ iso, now }: { iso: string; now?: number }) {
  const clock = useTimelineNow();
  const formatted = formatTimelineTime(iso, now ?? clock);
  const [absolute, setAbsolute] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearTimer() {
    if (timer.current == null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }
  return (
    <time
      dateTime={formatted.dateTime}
      title={formatted.title}
      onPointerDown={() => {
        clearTimer();
        timer.current = setTimeout(() => setAbsolute(true), LONG_PRESS_MS);
      }}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      onPointerLeave={clearTimer}
    >
      {absolute ? formatted.title : formatted.text}
    </time>
  );
}
