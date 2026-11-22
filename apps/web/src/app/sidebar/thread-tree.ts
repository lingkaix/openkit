import type { ConversationNavigationResponse } from '@openkit/app-api-schemas';

/** One conversation.navigation row: the Thread record, its activity, state and unread count. */
export type ConversationRow = ConversationNavigationResponse['items'][number];

/** Which Thread types a Workspace group shows (ia.md §1, group ⋯ menu "Show"). */
export type ThreadTypeFilter = 'all' | 'chat' | 'task' | 'goal';

/** A visible row with at most one level of children (ia.md §1 nesting). */
export interface ThreadNode {
  readonly row: ConversationRow;
  /** Name of the direct parent when this row was flattened under a higher ancestor. */
  readonly via: string | null;
  readonly children: readonly ThreadNode[];
}

/** Rows kept by a type filter. Needs repair rows show only under All. */
export function filterThreadRows(
  rows: readonly ConversationRow[],
  filter: ThreadTypeFilter
): ConversationRow[] {
  return filter === 'all' ? [...rows] : rows.filter((row) => row.activity === filter);
}

/** The visible name of a Thread row. */
export function threadRowName(row: ConversationRow): string {
  return row.thread.name ?? row.thread.preview;
}

/**
 * Nests visible rows by `thread.parentThreadId`, one level deep (ia.md §1).
 *
 * - A child renders under its visible parent in the same list.
 * - A deeper descendant flattens under its top visible ancestor and keeps the name of
 *   its direct parent in `via`.
 * - A row whose parent is not in the list stays at the top level.
 * - Order is the input order: a parent keeps its place, children keep their relative order.
 * - A parent cycle cannot hide rows: the walk stops at the first repeated Thread, and a row
 *   in a cycle stays at the top level.
 */
export function nestThreadRows(rows: readonly ConversationRow[]): ThreadNode[] {
  const byId = new Map(rows.map((row) => [row.thread.id, row]));
  const topOf = new Map<string, string>();
  for (const row of rows) {
    const seen = new Set<string>([row.thread.id]);
    let top = row.thread.id;
    let parentId = row.thread.parentThreadId ?? null;
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      top = parentId;
      parentId = byId.get(parentId)?.thread.parentThreadId ?? null;
    }
    // A cycle (parentId already seen) leaves the row at the top level.
    topOf.set(row.thread.id, parentId && seen.has(parentId) ? row.thread.id : top);
  }
  const children = new Map<string, ThreadNode[]>();
  for (const row of rows) {
    const top = topOf.get(row.thread.id) ?? row.thread.id;
    if (top === row.thread.id) continue;
    const parentId = row.thread.parentThreadId ?? null;
    const parent = parentId ? byId.get(parentId) : undefined;
    const via = parentId && parentId !== top && parent ? threadRowName(parent) : null;
    const list = children.get(top) ?? [];
    list.push({ row, via, children: [] });
    children.set(top, list);
  }
  return rows
    .filter((row) => topOf.get(row.thread.id) === row.thread.id)
    .map((row) => ({ row, via: null, children: children.get(row.thread.id) ?? [] }));
}

/** The one trailing indicator a row shows, by priority (ia.md §1). */
export type ThreadIndicator =
  | { readonly kind: 'needs-you' }
  | { readonly kind: 'unread'; readonly count: number }
  | { readonly kind: 'working' }
  | { readonly kind: 'none' };

/**
 * Picks the trailing indicator: needs you first, then an unread count, then working.
 * A row never shows a dot and a count together. A pending reply counts as working.
 */
export function threadIndicator(
  row: Pick<ConversationRow, 'state' | 'unreadCount'>,
  awaitingReply: boolean
): ThreadIndicator {
  if (row.state === 'needs-you') return { kind: 'needs-you' };
  if (typeof row.unreadCount === 'number' && row.unreadCount > 0) {
    return { kind: 'unread', count: row.unreadCount };
  }
  if (row.state === 'working' || awaitingReply) return { kind: 'working' };
  return { kind: 'none' };
}

const ACTIVITY_LABEL: Record<ConversationRow['activity'], string> = {
  chat: 'Chat',
  task: 'Task',
  goal: 'Goal',
  unknown: 'Needs repair',
};

/** The type word of a row: Chat, Task, Goal, or Needs repair. */
export function threadActivityLabel(activity: ConversationRow['activity']): string {
  // An activity this build does not know reads as a row that needs repair.
  return ACTIVITY_LABEL[activity] ?? ACTIVITY_LABEL.unknown;
}

/**
 * The hint and assistive description of a row, for example "Task · Working · via Plan".
 * It names the state even when the trailing indicator shows something with higher priority.
 */
export function threadRowDescription(
  row: ConversationRow,
  awaitingReply: boolean,
  via: string | null
): string {
  const status =
    row.state === 'needs-you'
      ? 'Needs you'
      : awaitingReply
        ? 'Waiting for response'
        : row.state === 'working'
          ? 'Working'
          : 'Idle';
  const count = typeof row.unreadCount === 'number' ? row.unreadCount : 0;
  const unread = count > 0 ? ` · ${count} unread ${count === 1 ? 'reply' : 'replies'}` : '';
  return `${threadActivityLabel(row.activity)} · ${status}${unread}${via ? ` · via ${via}` : ''}`;
}

/** Top-level rows a group shows before "Show more" (ia.md §1). */
export const GROUP_PAGE_ROWS = 15;
