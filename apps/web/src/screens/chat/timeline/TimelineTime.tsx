import { formatTimelineTime, useTimelineNow } from './time';

/**
 * One instant. The visible text is relative within 24 hours.
 * Hover and long-press read the absolute time from `title`.
 */
export function TimelineTime({ iso, now }: { iso: string; now?: number }) {
  const clock = useTimelineNow();
  const formatted = formatTimelineTime(iso, now ?? clock);
  return (
    <time dateTime={formatted.dateTime} title={formatted.title}>
      {formatted.text}
    </time>
  );
}
