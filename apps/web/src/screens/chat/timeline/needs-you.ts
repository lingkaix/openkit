import type { HumanAttentionRow } from '@openkit/app-api-schemas';
import { fillCopy, timelineCopy } from './copy';
import { looksLikeIdentifier } from './present';

const GENERIC_ATTENTION_TITLE = new Set(['Answer required', 'Approval required']);
const GENERIC_ATTENTION_SUMMARY = new Set([
  'Answer the question on its pending request.',
  'Review and respond to the approval request.',
]);

const ATTENTION_TITLE_MAX = 80;

/** One line, shortened, for a Needs you row. */
export function shortenAttentionText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= ATTENTION_TITLE_MAX) return flat;
  return `${flat.slice(0, ATTENTION_TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Prefer the request's own question or title.
 * A generic title stays until the row, or the loaded request it already names, carries the words.
 */
export function attentionDisplayTitle(
  title: string,
  summary?: string | null,
  question?: string | null
): string {
  const asked = question?.replace(/\s+/g, ' ').trim();
  if (asked && !looksLikeIdentifier(asked)) return shortenAttentionText(asked);
  if (!GENERIC_ATTENTION_TITLE.has(title)) return shortenAttentionText(title);
  const detail = summary?.replace(/\s+/g, ' ').trim();
  if (detail && !GENERIC_ATTENTION_SUMMARY.has(detail) && !looksLikeIdentifier(detail))
    return shortenAttentionText(detail);
  return title;
}

/**
 * One attention row, already projected. `blocking` and `ageSeconds` are reused.
 * The timeline does not compute them.
 */
export interface NeedsYouRow {
  id: string;
  title: string;
  blocking: boolean;
  ageSeconds?: number;
  createdAt: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  taskLabel?: string;
  surfaceHref?: string | null;
}

/** Blocking rows first, then oldest. Both facts are already on the row. */
export function orderNeedsYou<T extends { blocking?: boolean; createdAt: string }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((left, right) => {
    const leftRank = left.blocking === true ? 0 : 1;
    const rightRank = right.blocking === true ? 0 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return Date.parse(left.createdAt) - Date.parse(right.createdAt);
  });
}

/** Rows for this Thread, or for a Goal and its linked Tasks. Other rows stay out. */
export function scopeNeedsYou<T extends { threadId?: string }>(
  rows: readonly T[],
  threadIds: readonly string[]
): T[] {
  const allowed = new Set(threadIds);
  return rows.filter((row) => row.threadId != null && allowed.has(row.threadId));
}

/** Several rows collapse to one line. One row keeps its title. */
export function needsYouSummary(rows: readonly { title: string }[]): string {
  if (rows.length === 0) return '';
  if (rows.length === 1) return rows[0]!.title;
  return `${fillCopy(timelineCopy.needsYouCount, { count: rows.length })} · ${fillCopy(timelineCopy.needsYouNext, { title: rows[0]!.title })}`;
}

export type NeedsYouActivation =
  | { type: 'anchor'; threadId: string; itemId: string }
  | { type: 'surface'; href: string }
  | { type: 'none' };

/**
 * A timeline anchor is the row's own Thread, Turn, and Item.
 * Anything else opens the owning surface. No identifier is invented.
 */
export function needsYouActivation(row: NeedsYouRow): NeedsYouActivation {
  if (row.threadId && row.turnId && row.itemId) {
    return { type: 'anchor', threadId: row.threadId, itemId: row.itemId };
  }
  if (row.surfaceHref) return { type: 'surface', href: row.surfaceHref };
  return { type: 'none' };
}

/** Scroll to the card and move focus to it. False when that card is not loaded. */
export function focusTimelineItem(itemId: string): boolean {
  return focusElement(`timeline-item-${itemId}`);
}

/** Scroll to a Goal card. False when that card is not on the board. */
export function focusGoalCard(cardId: string): boolean {
  return focusElement(`goal-card-${cardId}`);
}

function focusElement(id: string): boolean {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) return false;
  element.scrollIntoView?.({ block: 'center' });
  element.focus();
  return true;
}

export interface AttentionWalkEntry<TItem> {
  /** Loaded item id when the row names one, otherwise the row's own id. */
  key: string;
  rowId: string;
  itemId?: string;
  item: TItem | null;
}

/**
 * The bar count and the decision walk are this list.
 * A row stays when its item is outside the loaded window. No id is invented.
 */
export function attentionWalk<TItem extends { id: string }>(
  rows: readonly { id: string; itemId?: string }[],
  items: readonly TItem[]
): AttentionWalkEntry<TItem>[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return rows.map((row) => ({
    key: row.itemId ?? row.id,
    rowId: row.id,
    itemId: row.itemId,
    item: row.itemId ? (byId.get(row.itemId) ?? null) : null,
  }));
}

/** Map one Action Center row. Age and blocking are copied, not derived. */
export function toNeedsYouRow(
  row: Pick<
    HumanAttentionRow,
    'id' | 'title' | 'blocking' | 'ageSeconds' | 'createdAt' | 'threadId' | 'turnId' | 'itemId'
  > & { summary?: string | null },
  surfaceHref: string | null,
  taskLabel?: string,
  question?: string | null
): NeedsYouRow {
  return {
    id: row.id,
    title: attentionDisplayTitle(row.title, row.summary, question),
    blocking: row.blocking === true,
    ageSeconds: row.ageSeconds,
    createdAt: row.createdAt,
    threadId: row.threadId,
    turnId: row.turnId,
    itemId: row.itemId,
    taskLabel,
    surfaceHref,
  };
}
