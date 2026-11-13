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

export interface SheetLayer {
  kind: SheetKind;
  id: string;
}

const SHEET_KINDS = new Set<SheetKind>(['decision', 'steps', 'inspect']);

function historyRecord(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== 'object') return null;
  const wrapped = (state as { usr?: unknown }).usr;
  if (wrapped && typeof wrapped === 'object') return wrapped as Record<string, unknown>;
  return state as Record<string, unknown>;
}

function isSheetLayer(value: unknown): value is SheetLayer {
  if (!value || typeof value !== 'object') return false;
  const layer = value as { kind?: unknown; id?: unknown };
  return (
    typeof layer.kind === 'string' &&
    SHEET_KINDS.has(layer.kind as SheetKind) &&
    typeof layer.id === 'string' &&
    layer.id.length > 0
  );
}

/** Layers recorded on this history entry, oldest first. The query shows only the top. */
export function sheetStackOf(state: unknown): SheetLayer[] {
  const record = historyRecord(state);
  const raw = record?.sheetStack;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSheetLayer).slice(0, 2);
}

/**
 * Push a sheet under the current one, up to two deep.
 * A third open replaces the top and keeps the sheet beneath it.
 */
export function nextSheetStack(
  stack: readonly SheetLayer[],
  kind: SheetKind,
  id: string
): { mode: 'push' | 'replace'; stack: SheetLayer[] } {
  const layer = { kind, id };
  const current = stack.slice(0, 2);
  if (current.length >= 2) return { mode: 'replace', stack: [current[0]!, layer] };
  return { mode: 'push', stack: [...current, layer] };
}
