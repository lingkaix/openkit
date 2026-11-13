import type { TimelineRunEntry } from '@openkit/app-api-schemas';
import type { QueryClient } from '@tanstack/react-query';

type ReportedActivity = NonNullable<TimelineRunEntry['reportedActivity']>;

const ARGUMENT_DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Digest carried on the admitted item object itself. Other windows are not consulted. */
const admittedDigest = new WeakMap<object, string | null>();

export function noteAdmittedArgumentDigest(item: object, digest: string | null | undefined): void {
  admittedDigest.set(
    item,
    typeof digest === 'string' && ARGUMENT_DIGEST.test(digest) ? digest : null
  );
}

export function digestsCarriedWith(items: readonly object[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const item of items) {
    if (!admittedDigest.has(item)) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    map.set(id, admittedDigest.get(item) ?? null);
  }
  return map;
}

export type ReportedActivityRead =
  | { state: 'absent' }
  | { state: 'null' }
  | { state: 'present'; activity: ReportedActivity };

/**
 * The bounded run field from the timeline read.
 * Omission keeps the older dashboard shape. Null is an unproved read, not an empty success.
 */
export function reportedActivityFor(
  queryClient: QueryClient,
  turnId: string,
  scope: { workspaceId: string; threadId: string } | null
): ReportedActivityRead {
  const pages = scope
    ? queryClient.getQueriesData({
        queryKey: ['thread-timeline', scope.workspaceId, scope.threadId],
      })
    : queryClient.getQueriesData({ queryKey: ['thread-timeline'] });
  let sawNull = false;
  let present: ReportedActivity | null = null;
  for (const [, data] of pages) {
    if (!data || typeof data !== 'object') continue;
    const runs = (data as { runs?: readonly TimelineRunEntry[] }).runs;
    const run = runs?.find((candidate) => candidate.id === turnId);
    if (!run || !Object.hasOwn(run, 'reportedActivity')) continue;
    if (run.reportedActivity === undefined) continue;
    if (run.reportedActivity === null) {
      sawNull = true;
      continue;
    }
    present = run.reportedActivity;
  }
  if (present) return { state: 'present', activity: present };
  if (sawNull) return { state: 'null' };
  return { state: 'absent' };
}
