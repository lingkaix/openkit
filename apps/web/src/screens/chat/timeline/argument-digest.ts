import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import type { QueryClient } from '@tanstack/react-query';

const ARGUMENT_DIGEST = /^sha256:[a-f0-9]{64}$/;

function remember(map: Map<string, string | null>, item: TimelineItem | null | undefined): void {
  if (!item) return;
  const digest = item.argumentDigest;
  if (typeof digest === 'string' && ARGUMENT_DIGEST.test(digest)) {
    map.set(item.id, digest);
    return;
  }
  if (!map.has(item.id)) map.set(item.id, null);
}

function rememberPage(map: Map<string, string | null>, data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const page = data as {
    runs?: readonly TimelineRunEntry[];
    items?: readonly TimelineItem[];
    itemWindow?: { items?: readonly TimelineItem[] } | null;
  };
  for (const run of page.runs ?? []) {
    for (const item of run.narrative) remember(map, item);
    remember(map, run.plan);
  }
  for (const item of page.itemWindow?.items ?? []) remember(map, item);
  for (const item of page.items ?? []) remember(map, item);
}

/**
 * Digests already returned by the timeline read.
 * A missing id is unknown and must not be treated as a match.
 */
export function argumentDigestsFor(
  queryClient: QueryClient,
  workspaceId: string,
  threadId: string
): ReadonlyMap<string, string | null> {
  const map = new Map<string, string | null>();
  for (const prefix of ['thread-timeline', 'thread-timeline-items'] as const) {
    for (const [, data] of queryClient.getQueriesData({
      queryKey: [prefix, workspaceId, threadId],
    })) {
      rememberPage(map, data);
    }
  }
  return map;
}
