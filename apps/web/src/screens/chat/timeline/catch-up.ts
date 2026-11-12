import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import type { CatchUpItemRef } from './window';

/**
 * Item-anchor reads used to place unread ids outside the loaded window.
 * A larger set has no bulk placement on `thread.read-state` or `thread.timeline`.
 */
export const EARLIER_UNREAD_LOCATE_LIMIT = 8;

/** Narrative items plus the addressed item window, so B can sit outside the bounded narrative. */
export function catchUpItemRefs(
  runs: readonly {
    id: string;
    narrative: readonly { id: string; type: string }[];
  }[],
  itemWindow: { items: readonly { id: string; turnId: string; type: string }[] } | null
): CatchUpItemRef[] {
  const refs: CatchUpItemRef[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    run.narrative.forEach((item, index) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      refs.push({ id: item.id, turnId: run.id, index, type: item.type });
    });
  }
  for (const [index, item] of (itemWindow?.items ?? []).entries()) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    refs.push({ id: item.id, turnId: item.turnId, index, type: item.type });
  }
  return refs;
}

export interface LocatedUnreadRef extends CatchUpItemRef {
  admissionOrder: number;
}

export function unplacedUnreadIds(
  items: readonly { id: string }[],
  unreadIds: ReadonlySet<string>
): string[] {
  const placed = new Set(items.map((item) => item.id));
  const missing: string[] = [];
  for (const id of unreadIds) if (!placed.has(id)) missing.push(id);
  return missing;
}

/** Placement of one item from an item-anchor timeline read. Null when that read does not contain it. */
export function itemRefFromTimeline(
  page: Pick<ThreadTimelineResponse, 'runs' | 'itemWindow'>,
  itemId: string
): LocatedUnreadRef | null {
  for (const run of page.runs) {
    const index = run.narrative.findIndex((item) => item.id === itemId);
    if (index < 0) continue;
    const item = run.narrative[index];
    if (!item) return null;
    return {
      id: item.id,
      turnId: run.id,
      index,
      type: item.type,
      admissionOrder: run.admissionOrder,
    };
  }
  const nested = page.itemWindow?.items ?? [];
  const index = nested.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  const item = nested[index];
  const run = page.runs.find((entry) => entry.id === item?.turnId);
  if (!item || !run) return null;
  return {
    id: item.id,
    turnId: item.turnId,
    index,
    type: item.type,
    admissionOrder: run.admissionOrder,
  };
}
