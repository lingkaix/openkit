import { fillCopy, timelineCopy } from './copy';

/** "3 of 5 done · now: Update tests" becomes "3/5 · Update tests". */
export function shortenProgress(progress: string): string {
  const match = /^(\d+) of (\d+) done(?: · now: (.+))?$/.exec(progress.trim());
  if (!match) return progress.trim();
  const step = match[3]?.trim();
  return step ? `${match[1]}/${match[2]} · ${step}` : `${match[1]}/${match[2]}`;
}

/** One sticky line. A count adds the cue and the opener mark. */
export function phoneBarLabel(nowText: string | null, needsCount: number): string {
  const needs =
    needsCount <= 0
      ? ''
      : needsCount === 1
        ? '1 needs you'
        : fillCopy(timelineCopy.phoneNeedsMany, { count: needsCount });
  const body = [nowText?.trim() || '', needs].filter((part) => part.length > 0).join(' · ');
  if (!body) return '';
  return needsCount > 0 ? `${body} ›` : body;
}

export type SheetKind = 'decision' | 'steps' | 'inspect';

/** One open sheet in the query string. The previous entry stays the Thread. */
export function openSheetSearch(current: string, kind: SheetKind, id: string): string {
  const next = new URLSearchParams(current);
  next.delete('decision');
  next.delete('steps');
  next.delete('inspect');
  next.set(kind, id);
  return next.toString();
}

export function closeSheetSearch(current: string): string {
  const next = new URLSearchParams(current);
  next.delete('decision');
  next.delete('steps');
  next.delete('inspect');
  return next.toString();
}
