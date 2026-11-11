import type { CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCoreClient } from '../../../app/core-client';
import type { ThreadItem } from '../data';
import {
  absorbEdge,
  absorbItemEdge,
  absorbPoll,
  cursorInput,
  type HeldItems,
  type HeldTimeline,
  holdFromResponse,
  holdItems,
  level2Input,
  openingInput,
  TEXT_RENDER_INTERVAL_MS,
  type TimelineAnchorRequest,
  windowPollMs,
} from './window';

/** The real client exposes the window read. Test doubles that omit it keep today's item path. */
export function timelineReadAvailable(client: CoreClient): boolean {
  return typeof client.operations['thread.timeline'] === 'function';
}

function timelineKey(workspaceId: string, threadId: string, anchor: TimelineAnchorRequest) {
  return ['thread-timeline', workspaceId, threadId, anchor] as const;
}

/**
 * Level-1 window for one thread.
 * Idle polls every 15s, a running or waiting run every 5s, and a hidden tab not at all.
 * `thread.items` stays the live-run fold (TW0); this read is the history window.
 */
export function useTimelineWindow(options: {
  workspaceId: string | null;
  threadId: string;
  anchor: TimelineAnchorRequest;
  enabled: boolean;
  running: boolean;
  pending: boolean;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const workspaceId = options.workspaceId ?? '';
  const { threadId, anchor, enabled, running, pending } = options;
  const key = timelineKey(workspaceId, threadId, anchor);
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  const hiddenOnce = useRef(false);
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  useEffect(() => {
    if (!visible) {
      hiddenOnce.current = true;
      return;
    }
    if (!hiddenOnce.current || !enabled) return;
    hiddenOnce.current = false;
    void queryClient.invalidateQueries({ queryKey: key });
  }, [enabled, key, queryClient, visible]);
  const query = useQuery({
    queryKey: key,
    enabled: enabled && Boolean(options.workspaceId),
    queryFn: async () => {
      const fresh = await client.operations['thread.timeline'](
        openingInput(workspaceId, threadId, anchor)
      );
      const previous = queryClient.getQueryData<HeldTimeline>(key);
      return previous ? absorbPoll(previous, fresh) : holdFromResponse(fresh);
    },
    refetchInterval: () => windowPollMs({ hidden: !visible, running, pending }),
    refetchIntervalInBackground: false,
  });

  const page = useMutation({
    mutationFn: async (edge: 'before' | 'after') => {
      const held = queryClient.getQueryData<HeldTimeline>(key);
      const cursor = edge === 'before' ? held?.beforeCursor : held?.afterCursor;
      if (!cursor) return null;
      const response = await client.operations['thread.timeline'](
        cursorInput(workspaceId, threadId, cursor)
      );
      return { edge, response };
    },
    onSuccess: (result) => {
      if (!result) return;
      queryClient.setQueryData<HeldTimeline>(key, (held) =>
        held ? absorbEdge(held, result.response, result.edge) : holdFromResponse(result.response)
      );
    },
  });

  const pageEarlier = useCallback(() => page.mutate('before'), [page.mutate]);
  const pageLater = useCallback(() => page.mutate('after'), [page.mutate]);
  return { ...query, pageEarlier, pageLater, paging: page.isPending };
}

function itemsKey(workspaceId: string, threadId: string, turnId: string) {
  return ['thread-timeline-items', workspaceId, threadId, turnId] as const;
}

/** Level-2 step pages for one open run. */
export function useRunItemWindow(options: {
  workspaceId: string | null;
  threadId: string;
  turnId: string | null;
  enabled: boolean;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const workspaceId = options.workspaceId ?? '';
  const { threadId, turnId, enabled } = options;
  const key = itemsKey(workspaceId, threadId, turnId ?? '');
  const query = useQuery({
    queryKey: key,
    enabled: enabled && Boolean(options.workspaceId && turnId),
    queryFn: async () => {
      const page = await client.operations['thread.timeline'](
        level2Input(workspaceId, threadId, turnId as string, 'step')
      );
      return holdItems(page.items, page.beforeCursor, page.afterCursor);
    },
  });
  const page = useMutation({
    mutationFn: async (edge: 'before' | 'after') => {
      const held = queryClient.getQueryData<HeldItems>(key);
      const cursor = edge === 'before' ? held?.beforeCursor : held?.afterCursor;
      if (!cursor) return null;
      const response = await client.operations['thread.timeline'](
        cursorInput(workspaceId, threadId, cursor)
      );
      return { edge, response };
    },
    onSuccess: (result) => {
      if (!result) return;
      queryClient.setQueryData<HeldItems>(key, (held) =>
        held
          ? absorbItemEdge(held, result.response, result.edge)
          : holdItems(
              result.response.items,
              result.response.beforeCursor,
              result.response.afterCursor
            )
      );
    },
  });
  const completeItems: ThreadItem[] = (query.data?.items ?? []).flatMap((item) =>
    item.detail.kind === 'complete' ? [item.detail.value as ThreadItem] : []
  );
  const pageEarlier = useCallback(() => page.mutate('before'), [page.mutate]);
  const pageLater = useCallback(() => page.mutate('after'), [page.mutate]);
  return { ...query, completeItems, pageEarlier, pageLater, paging: page.isPending };
}

/**
 * Live item snapshots at most ten times a second.
 * The stream may emit faster; the timeline paints on this clock.
 */
export function useCoalescedItems(items: readonly ThreadItem[] | undefined): readonly ThreadItem[] {
  const latest = useRef<readonly ThreadItem[]>(items ?? []);
  latest.current = items ?? [];
  const [shown, setShown] = useState<readonly ThreadItem[]>(items ?? []);
  useEffect(() => {
    const handle = window.setInterval(() => {
      setShown((current) => (current === latest.current ? current : latest.current));
    }, TEXT_RENDER_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, []);
  return shown;
}
