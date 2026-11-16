import { isDeepStrictEqual } from 'node:util';
import type { Thread } from '@openkit/protocol';
import type Database from 'better-sqlite3';

/** Operational thresholds are recorded on each newly admitted continuous conversation. */
export const DEFAULT_THREAD_SEGMENTATION: NonNullable<Thread['segmentation']> = {
  maxObservationLines: 10_000,
  maxBytes: 100_000_000,
  boundaryDelayed: true,
};

/** Counts logical observation lines and their published bytes in the current native snapshot. */
export function threadSegmentUsage(
  sqlite: Database.Database,
  threadId: string
): { lines: number; bytes: number } {
  const observations = sqlite
    .prepare(`SELECT count(*) AS lines,
    coalesce(sum(length(cast(o.record_json AS blob)) + 1), 0) AS bytes
    FROM control_work_observations o JOIN control_turns t ON t.id=o.turn_id WHERE t.thread_id=?`)
    .get(threadId) as { lines: number; bytes: number };
  const bodies = sqlite
    .prepare(`SELECT coalesce(sum(json_extract(b.value,'$.bytes')), 0) AS bytes
    FROM control_work_observations o JOIN control_turns t ON t.id=o.turn_id,
    json_each(o.record_json,'$.payload.bodies') b
    WHERE t.thread_id=? AND json_extract(o.record_json,'$.type')='content.published'`)
    .get(threadId) as { bytes: number };
  const entries = sqlite
    .prepare(`SELECT coalesce(sum(json_extract(e.content_json,'$.byteLength')), 0) AS bytes
    FROM control_product_entries e JOIN control_turns t ON t.id=e.turn_id WHERE t.thread_id=?`)
    .get(threadId) as { bytes: number };
  return { lines: observations.lines, bytes: observations.bytes + bodies.bytes + entries.bytes };
}

/** Follows only explicitly recorded segment edges, never a handoff or an inferred historical ordinal. */
export function threadSegmentHead(threads: readonly Thread[], initial: Thread): Thread {
  let current = initial;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current.id)) throw new Error('recovery_required: cyclic Thread segments');
    seen.add(current.id);
    const successors = threads.filter(
      (value) =>
        value.parentThreadId === current.id && value.segment !== undefined && value.segment > 0
    );
    if (!successors.length) return current;
    const next = successors[0]!;
    if (
      successors.length !== 1 ||
      current.segment === undefined ||
      !current.segmentation ||
      next.segment !== current.segment + 1 ||
      next.visibility !== current.visibility ||
      next.privateOwnerUserId !== current.privateOwnerUserId ||
      next.entryPath !== current.entryPath ||
      next.threadSource !== current.threadSource ||
      !isDeepStrictEqual(next.segmentation, current.segmentation)
    )
      throw new Error('recovery_required: contradictory Thread segment');
    current = next;
  }
}

/** Resolves execution ancestry only across recorded segment edges with the same immutable audience. */
export function threadSegmentHistory(read: (id: string) => Thread, initial: Thread): Thread[] {
  const chain = [initial];
  const seen = new Set([initial.id]);
  let current = initial;
  while (current.segment !== undefined && current.segment > 0) {
    if (!current.parentThreadId || seen.has(current.parentThreadId))
      throw new Error('recovery_required: unresolved Thread segment');
    const parent = read(current.parentThreadId);
    if (
      parent.segment === undefined ||
      !parent.segmentation ||
      current.segment !== parent.segment + 1 ||
      !isDeepStrictEqual(parent.owner, current.owner) ||
      parent.visibility !== current.visibility ||
      parent.privateOwnerUserId !== current.privateOwnerUserId ||
      parent.entryPath !== current.entryPath ||
      parent.threadSource !== current.threadSource ||
      !isDeepStrictEqual(parent.segmentation, current.segmentation)
    )
      throw new Error('recovery_required: contradictory Thread segment ancestry');
    chain.unshift(parent);
    seen.add(parent.id);
    current = parent;
  }
  return chain;
}
