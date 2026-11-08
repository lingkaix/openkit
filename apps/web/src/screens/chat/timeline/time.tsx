import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { fillCopy, timelineCopy } from './copy';

/** Relative copy stays inside this window. At and beyond it, the time is absolute. */
export const RELATIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Ordinary timeline clocks wait at least this long. Now's elapsed time is the exception. */
export const TIMELINE_CLOCK_MS = 30_000;

/** Now's elapsed time refreshes faster than the 30s clock, and never twice a second. */
export const NOW_ELAPSED_CLOCK_MS = 5_000;

const ABSOLUTE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const CLOCK_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Absolute clock time, used on hover and after 24 hours. */
export function formatAbsolute(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return ABSOLUTE.format(new Date(parsed));
}

/** Hour and minute, for a last-known clock time such as 10:42. */
export function formatClockTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return CLOCK_TIME.format(new Date(parsed));
}

/** Relative age. The caller already decided the instant is inside 24 hours. */
export function formatRelativeAge(deltaMs: number): string {
  const sec = Math.max(0, Math.floor(deltaMs / 1000));
  if (sec < 60) return `${sec} s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

/**
 * Visible instant. Relative within 24 hours, absolute at and beyond that, and absolute when the clock is ahead.
 */
export function formatTimelineTime(
  iso: string,
  now: number
): { text: string; dateTime: string; title: string } {
  const parsed = Date.parse(iso);
  const title = formatAbsolute(iso);
  if (!Number.isFinite(parsed)) return { text: title, dateTime: iso, title };
  const delta = now - parsed;
  if (delta < 0 || delta >= RELATIVE_WINDOW_MS) return { text: title, dateTime: iso, title };
  return { text: formatRelativeAge(delta), dateTime: iso, title };
}

/**
 * Duration for a run or a step. Steps under 1 second omit it.
 * // TB4: no server clock offset is on the dashboard. Callers pass the client clock.
 */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** ISO 8601 duration for a `<time datetime>` value. */
export function durationDateTime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(sec / 3600);
  const min = Math.floor((sec % 3600) / 60);
  const rest = sec % 60;
  let value = 'PT';
  if (hours > 0) value += `${hours}H`;
  if (min > 0) value += `${min}M`;
  if (rest > 0 || (hours === 0 && min === 0)) value += `${rest}S`;
  return value;
}

/** Age taken from the attention row's own `ageSeconds`. This does not recompute it. */
export function formatAgeSeconds(ageSeconds: number): string {
  return formatRelativeAge(ageSeconds * 1000);
}

/** Staleness copy. The age is already measured. */
export function stalenessLabel(ageMs: number): string {
  return fillCopy(timelineCopy.updatedAgo, { ago: formatRelativeAge(ageMs) });
}

const TimelineClockContext = createContext<number | null>(null);

/** Share a clock the parent already owns. */
export function TimelineNowProvider({ now, children }: { now: number; children: ReactNode }) {
  return <TimelineClockContext.Provider value={now}>{children}</TimelineClockContext.Provider>;
}

/** One clock for the timeline. Elapsed Now states tick faster than everything else. */
export function TimelineClock({ live, children }: { live: boolean; children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Date.now()),
      live ? NOW_ELAPSED_CLOCK_MS : TIMELINE_CLOCK_MS
    );
    return () => clearInterval(timer);
  }, [live]);
  return <TimelineClockContext.Provider value={now}>{children}</TimelineClockContext.Provider>;
}

/** The shared clock, or the time this component mounted when no clock is above it. */
export function useTimelineNow(): number {
  const value = useContext(TimelineClockContext);
  const [mounted] = useState(() => Date.now());
  return value ?? mounted;
}

/** True when the person asked for reduced motion. Missing matchMedia means motion is allowed. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof matchMedia !== 'function') return false;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
  return reduced;
}
