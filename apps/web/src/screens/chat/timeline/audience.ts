import { useQueries } from '@tanstack/react-query';
import { useCoreClient } from '../../../app/core-client';
import { chatKeys, type conversationThreadPath } from '../data';

export type ThreadActivity = Parameters<typeof conversationThreadPath>[2];

/** What the navigation read says about one thread, before any title is shown. */
export type ThreadAudience =
  | { status: 'pending' }
  | { status: 'unknown' }
  | { status: 'denied' }
  | { status: 'open'; name: string | null; activity: ThreadActivity };

/**
 * Reads conversation.navigation without a page limit.
 * A successful response is the audience set. A missing operation does not invent a denial.
 */
export function useThreadAudience(workspaceIds: readonly (string | null | undefined)[]) {
  const client = useCoreClient();
  const ids = [...new Set(workspaceIds.filter((id): id is string => Boolean(id)))].sort();
  const navigable = typeof client.operations['conversation.navigation'] === 'function';
  const queries = useQueries({
    queries: ids.map((workspaceId) => ({
      queryKey: chatKeys.navigation(workspaceId),
      enabled: navigable,
      retry: false,
      queryFn: async () =>
        (await client.operations['conversation.navigation']({ workspaceId })).items,
    })),
  });
  const rows = new Map<string, { activity: ThreadActivity; name: string | null }>();
  for (const query of queries) {
    for (const item of query.data ?? []) {
      rows.set(item.thread.id, {
        activity: item.activity,
        name: item.thread.name ?? null,
      });
    }
  }
  const pending = navigable && ids.length > 0 && queries.some((query) => query.isPending);
  const failed = queries.some((query) => query.isError);
  return {
    pending,
    activityFor(threadId: string | null): ThreadActivity | 'pending' {
      if (!threadId || pending) return pending ? 'pending' : 'unknown';
      return rows.get(threadId)?.activity ?? 'unknown';
    },
    sourceFor(threadId: string | null): ThreadAudience {
      if (!threadId || !navigable || ids.length === 0) return { status: 'unknown' };
      if (pending) return { status: 'pending' };
      const row = rows.get(threadId);
      if (row) return { status: 'open', name: row.name, activity: row.activity };
      // A failed read is not an audience decision. Only a finished list may deny.
      if (failed) return { status: 'unknown' };
      return { status: 'denied' };
    },
  };
}
