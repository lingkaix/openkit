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

/** Depth recorded on the history entry. The query still holds one sheet. */
export function sheetDepthOf(state: unknown): number {
  if (!state || typeof state !== 'object') return 0;
  const record = state as { usr?: { sheetDepth?: unknown }; sheetDepth?: unknown };
  const raw = record.usr?.sheetDepth ?? record.sheetDepth;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * Sheets stack at most two deep. The third replaces the second.
 * The query keeps a single sheet; depth is the history stack.
 */
export function nextSheetDepth(depth: number): { mode: 'push' | 'replace'; depth: number } {
  if (depth >= 2) return { mode: 'replace', depth: 2 };
  return { mode: 'push', depth: depth + 1 };
}
