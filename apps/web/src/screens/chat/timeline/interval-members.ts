import type { TimelineItem } from '@openkit/app-api-schemas';
import { isStepItem } from './present';

/** One proved step inside a finished plan interval, in first-publication order. */
export interface IntervalMember {
  id: string;
  sequence: number;
  item: TimelineItem;
}

/**
 * Membership of one finished interval.
 * `partial` means some proved rows are visible and the list is not complete.
 * `unavailable` means no row can be proved. An exact empty interval is neither.
 */
export interface FinishedIntervalView {
  members: IntervalMember[];
  partial: boolean;
  unavailable: boolean;
  extendsEarlier: boolean;
  extendsLater: boolean;
}

interface AdmittedItem {
  item: TimelineItem;
  /** Positive sequence, explicit unknown, or omitted by every source. */
  sequence: number | null | undefined;
  step: boolean;
}

function publicationSequence(item: TimelineItem): number | null | undefined {
  if (!Object.hasOwn(item, 'firstPublicationSequence')) return undefined;
  const value = item.firstPublicationSequence;
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** A present sequence wins over omission. Disagreement, including null versus a number, is unknown. */
function mergeSequence(
  current: number | null | undefined,
  next: number | null | undefined
): number | null | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  if (current === next) return current;
  return null;
}

function canShow(item: TimelineItem): boolean {
  if (item.detail.kind === 'preview') return item.detail.text.length > 0;
  return item.detail.value != null;
}

function admit(items: readonly TimelineItem[]): Map<string, AdmittedItem> {
  const admitted = new Map<string, AdmittedItem>();
  for (const item of items) {
    const existing = admitted.get(item.id);
    admitted.set(item.id, {
      item,
      sequence: mergeSequence(existing?.sequence, publicationSequence(item)),
      step: (existing?.step ?? false) || isStepItem(item),
    });
  }
  return admitted;
}

/**
 * Finished-interval members from the current admitted items only.
 * Containment is `start <= firstPublicationSequence < end` in the plan-boundary
 * position space. A null or omitted position is never placed. Cursors mean the
 * bounded page continues; a covered span with no cursor is not an edge.
 */
export function finishedIntervalView(
  segment: { startSequence: number; endSequence: number; steps: number },
  items: readonly TimelineItem[],
  edges: { earlier: boolean; later: boolean; settled: boolean }
): FinishedIntervalView {
  const admitted = admit(items);
  let min: number | null = null;
  let max: number | null = null;
  let unplacedStep = false;
  for (const row of admitted.values()) {
    if (typeof row.sequence === 'number') {
      min = min == null || row.sequence < min ? row.sequence : min;
      max = max == null || row.sequence > max ? row.sequence : max;
    }
    if (!row.step) continue;
    const inRange =
      typeof row.sequence === 'number' &&
      row.sequence >= segment.startSequence &&
      row.sequence < segment.endSequence;
    // A known position outside this interval is not one of its members.
    // An unknown position, or a row in range with no body, cannot be completed.
    if (typeof row.sequence !== 'number' || (inRange && !canShow(row.item))) unplacedStep = true;
  }
  const extendsEarlier = Boolean(edges.earlier && min != null && segment.startSequence < min);
  const extendsLater = Boolean(edges.later && max != null && segment.endSequence > max + 1);
  const members = [...admitted.values()]
    .filter(
      (row): row is AdmittedItem & { sequence: number } =>
        row.step &&
        typeof row.sequence === 'number' &&
        canShow(row.item) &&
        row.sequence >= segment.startSequence &&
        row.sequence < segment.endSequence
    )
    .sort(
      (left, right) => left.sequence - right.sequence || (left.item.id < right.item.id ? -1 : 1)
    )
    .map((row) => ({ id: row.item.id, sequence: row.sequence, item: row.item }));
  const exact =
    edges.settled &&
    !unplacedStep &&
    !extendsEarlier &&
    !extendsLater &&
    members.length === segment.steps;
  return {
    members,
    partial: members.length > 0 && !exact && edges.settled,
    unavailable: members.length === 0 && !exact,
    extendsEarlier,
    extendsLater,
  };
}
