/**
 * Pure navigation rules for the timeline.
 * Scroll anchoring stays in the window module. This file only decides admission,
 * history payload, anchor aliases and whether a jump pushes or replaces.
 */

export interface TimelineHistoryState {
  scrollTop: number;
  expandedRunIds: string[];
}

const ANCHOR_KEYS = ['turn', 'turnId', 'item', 'row', 'attention', 'catchUp'] as const;

/** Dashboard content may show only after a read that started on this mount succeeds. */
export function contentAdmitted(input: {
  succeeded: boolean;
  fetching: boolean;
  updatedAt: number;
  mountedAt: number;
}): boolean {
  return input.succeeded && !input.fetching && input.updatedAt >= input.mountedAt;
}

/** Thread id in a chat, task or goal path, including a goal output opened under that thread. */
export function viewingThreadId(pathname: string): string | null {
  const match = /^\/(?:chat|tasks|goals)\/[^/]+\/([^/]+)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Same-thread jumps replace. Opening another surface pushes. */
export function historyModeForHref(currentPathname: string, href: string): 'push' | 'replace' {
  let nextPath = href;
  try {
    nextPath = new URL(href, 'http://localhost').pathname;
  } catch {
    nextPath = href.split('?')[0] ?? href;
  }
  return nextPath === currentPathname ? 'replace' : 'push';
}

/** Spec names, with the names the shipped window already reads. */
export function turnIdFromSearch(params: URLSearchParams): string | null {
  return params.get('turn') || params.get('turnId');
}

/** Spec row anchor, with the shipped attention name. */
export function rowIdFromSearch(params: URLSearchParams): string | null {
  return params.get('row') || params.get('attention');
}

/** Drops timeline anchors. Scrolling itself never calls this. */
export function replaceAnchorSearch(current: string): string {
  const next = new URLSearchParams(current);
  for (const key of ANCHOR_KEYS) next.delete(key);
  return next.toString();
}

function usrOf(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== 'object') return null;
  const record = state as { usr?: unknown };
  if (!record.usr || typeof record.usr !== 'object') return null;
  return record.usr as Record<string, unknown>;
}

/** Scroll and expanded runs stored on the history entry. Missing state stays empty. */
export function readTimelineHistory(state: unknown): TimelineHistoryState | null {
  const usr = usrOf(state);
  const timeline = usr?.timeline;
  if (!timeline || typeof timeline !== 'object') return null;
  const body = timeline as { scrollTop?: unknown; expandedRunIds?: unknown };
  const scrollTop = typeof body.scrollTop === 'number' && body.scrollTop >= 0 ? body.scrollTop : 0;
  const expandedRunIds = Array.isArray(body.expandedRunIds)
    ? body.expandedRunIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return { scrollTop, expandedRunIds };
}

/**
 * Merges scroll or expanded runs into the current history entry without changing the URL.
 * A missing history state (unit tests) is left alone.
 */
export function writeTimelineHistory(
  history: Pick<History, 'state' | 'replaceState'>,
  patch: Partial<TimelineHistoryState>,
  url?: string | URL | null
): void {
  if (history.state == null) return;
  const current = history.state as { usr?: Record<string, unknown> };
  const usr = { ...(current.usr ?? {}) };
  const previous = readTimelineHistory(history.state) ?? { scrollTop: 0, expandedRunIds: [] };
  usr.timeline = { ...previous, ...patch };
  const next = { ...current, usr };
  if (url == null) history.replaceState(next, '');
  else history.replaceState(next, '', url);
}
