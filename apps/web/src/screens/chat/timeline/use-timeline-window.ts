import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCoreClient } from '../../../app/core-client';
import type { ThreadItem } from '../data';
import { publishTimelineDigest } from './digest';
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
  retainWindowWhileAnchorLoads,
  TEXT_RENDER_INTERVAL_MS,
  type TimelineAnchorRequest,
  windowPollMs,
} from './window';

function withDigest(held: HeldTimeline, digest: ThreadTimelineResponse['digest']) {
  return { ...held, digest };
}

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
      const held = previous ? absorbPoll(previous, fresh) : holdFromResponse(fresh);
      return withDigest(held, fresh.digest);
    },
    placeholderData: (previous, previousQuery) =>
      retainWindowWhileAnchorLoads(workspaceId, threadId, previous, previousQuery?.queryKey),
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
      queryClient.setQueryData(key, (held: HeldTimeline | undefined) => {
        const next = held
          ? absorbEdge(held, result.response, result.edge)
          : holdFromResponse(result.response);
        return withDigest(next, result.response.digest);
      });
    },
  });

  const pageEarlier = useCallback(() => page.mutate('before'), [page.mutate]);
  const pageLater = useCallback(() => page.mutate('after'), [page.mutate]);
  useEffect(() => {
    if (!query.isFetched) return;
    publishTimelineDigest(query.data?.digest ?? null);
  }, [query.data, query.isFetched]);
  return { ...query, pageEarlier, pageLater, paging: page.isPending };
}

function itemsKey(
  workspaceId: string,
  threadId: string,
  turnId: string,
  placement: 'all' | 'narrative' | 'step',
  cursor: string | null
) {
  return ['thread-timeline-items', workspaceId, threadId, turnId, placement, cursor] as const;
}

/** Level-2 pages for one open run. A seed keeps the anchored window and its cursors. */
export function useRunItemWindow(options: {
  workspaceId: string | null;
  threadId: string;
  turnId: string | null;
  enabled: boolean;
  placement?: 'all' | 'narrative' | 'step';
  /** First page is this cursor. Narrative continuation uses the run cursor. */
  cursor?: string | null;
  /** Anchored Level-2 window. Paging continues from its cursors. */
  seed?: HeldItems | null;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const workspaceId = options.workspaceId ?? '';
  const { threadId, turnId, enabled } = options;
  const placement = options.placement ?? 'step';
  const cursor = options.cursor ?? null;
  const seed = options.seed ?? null;
  const key = itemsKey(workspaceId, threadId, turnId ?? '', placement, cursor);
  const query = useQuery({
    queryKey: key,
    enabled: enabled && Boolean(options.workspaceId && turnId),
    queryFn: async () => {
      const cached = queryClient.getQueryData<HeldItems>(key);
      if (cached) return cached;
      if (seed) return seed;
      const page = cursor
        ? await client.operations['thread.timeline'](cursorInput(workspaceId, threadId, cursor))
        : await client.operations['thread.timeline'](
            level2Input(workspaceId, threadId, turnId as string, placement)
          );
      return holdItems(page.items, page.beforeCursor, page.afterCursor);
    },
  });
  const page = useMutation({
    mutationFn: async (edge: 'before' | 'after') => {
      const held = queryClient.getQueryData<HeldItems>(key);
      const edgeCursor = edge === 'before' ? held?.beforeCursor : held?.afterCursor;
      if (!edgeCursor) return null;
      const response = await client.operations['thread.timeline'](
        cursorInput(workspaceId, threadId, edgeCursor)
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
  const loaded = query.data?.items ?? [];
  const completeItems: ThreadItem[] = loaded.flatMap((item) =>
    item.detail.kind === 'complete' ? [item.detail.value as ThreadItem] : []
  );
  const previewDetails = loaded.flatMap((item) => (item.detail.kind === 'preview' ? [item] : []));
  const pageEarlier = useCallback(() => page.mutate('before'), [page.mutate]);
  const pageLater = useCallback(() => page.mutate('after'), [page.mutate]);
  return {
    ...query,
    completeItems,
    previewDetails,
    pageEarlier,
    pageLater,
    paging: page.isPending,
  };
}

/**
 * Live item snapshots at most ten times a second.
 * The stream may emit faster; the timeline paints on this clock.
 */
export function useCoalescedItems(items: readonly ThreadItem[] | undefined): readonly ThreadItem[] {
  const latest = useRef<readonly ThreadItem[]>(items ?? []);
  latest.current = items ?? [];
  const [shown, setShown] = useState<readonly ThreadItem[]>(items ?? []);
  const lastFlush = useRef(0);
  useEffect(() => {
    latest.current = items ?? [];
    let frame = 0;
    let timer = 0;
    let stopped = false;
    const flush = () => {
      frame = 0;
      if (stopped) return;
      lastFlush.current = performance.now();
      const next = latest.current;
      setShown((current) => (current === next ? current : next));
    };
    const elapsed = performance.now() - lastFlush.current;
    const wait = TEXT_RENDER_INTERVAL_MS - elapsed;
    if (wait <= 0) frame = requestAnimationFrame(flush);
    else {
      timer = window.setTimeout(() => {
        timer = 0;
        if (!stopped) frame = requestAnimationFrame(flush);
      }, wait);
    }
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [items]);
  return shown;
}
