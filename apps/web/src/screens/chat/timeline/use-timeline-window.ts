import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
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
  retainWindowWhileAnchorLoads,
  TEXT_RENDER_INTERVAL_MS,
  type TimelineAnchorRequest,
  windowPollMs,
} from './window';

function withDigest(
  held: HeldTimeline,
  page: Pick<ThreadTimelineResponse, 'digest' | 'earlierUnread'>
) {
  return {
    ...held,
    digest: page.digest,
    earlierUnread: page.earlierUnread,
    requestUnavailable: undefined,
  };
}

function keepsCurrentView(anchor: TimelineAnchorRequest): boolean {
  return (
    anchor.kind === 'approval-request' ||
    anchor.kind === 'user-input-request' ||
    anchor.kind === 'item'
  );
}

function admissionKey(workspaceId: string, threadId: string) {
  return ['thread-timeline-admission', workspaceId, threadId] as const;
}

function isThreadRead(anchor: TimelineAnchorRequest): boolean {
  return anchor.kind === 'latest' || anchor.kind === 'catch-up' || anchor.kind === 'turn';
}

function refusesThread(error: unknown): boolean {
  return (
    error instanceof ApiCallError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
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
  const precedingRef = useRef<HeldTimeline | null>(null);
  const scope = `${workspaceId}\0${threadId}`;
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    precedingRef.current = null;
  }
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
      try {
        const fresh = await client.operations['thread.timeline'](
          openingInput(workspaceId, threadId, anchor)
        );
        const previous = queryClient.getQueryData<HeldTimeline>(key);
        const held = withDigest(
          previous?.requestUnavailable
            ? holdFromResponse(fresh)
            : previous
              ? absorbPoll(previous, fresh)
              : holdFromResponse(fresh),
          fresh
        );
        queryClient.setQueryData(admissionKey(workspaceId, threadId), { admitted: true });
        precedingRef.current = held;
        return held;
      } catch (error) {
        if (isThreadRead(anchor) && refusesThread(error)) {
          queryClient.setQueryData(admissionKey(workspaceId, threadId), null);
          precedingRef.current = null;
        } else if (
          keepsCurrentView(anchor) &&
          error instanceof ApiCallError &&
          error.status === 404
        ) {
          const admission = queryClient.getQueryData<{ admitted: true } | null>(
            admissionKey(workspaceId, threadId)
          );
          const preceding = precedingRef.current;
          if (admission?.admitted && preceding) {
            return { ...preceding, requestUnavailable: true };
          }
        }
        throw error;
      }
    },
    placeholderData: (previous, previousQuery) =>
      retainWindowWhileAnchorLoads(workspaceId, threadId, previous, previousQuery?.queryKey),
    refetchInterval: () => windowPollMs({ hidden: !visible, running, pending }),
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (
      !query.isSuccess ||
      query.isPlaceholderData ||
      !query.data ||
      query.data.requestUnavailable
    ) {
      return;
    }
    precedingRef.current = query.data;
  }, [query.data, query.isPlaceholderData, query.isSuccess]);

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
        return withDigest(next, result.response);
      });
    },
  });

  const pageEarlier = useCallback(() => page.mutate('before'), [page.mutate]);
  const pageLater = useCallback(() => page.mutate('after'), [page.mutate]);
  return { ...query, pageEarlier, pageLater, paging: page.isPending };
}

function itemsKey(
  workspaceId: string,
  threadId: string,
  turnId: string,
  placement: 'all' | 'narrative' | 'step',
  cursor: string | null,
  seedKey: string | null
) {
  return [
    'thread-timeline-items',
    workspaceId,
    threadId,
    turnId,
    placement,
    cursor,
    seedKey,
  ] as const;
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
  /** Changes the cache identity when a new Item anchor replaces the seed. */
  seedKey?: string | null;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const workspaceId = options.workspaceId ?? '';
  const { threadId, turnId, enabled } = options;
  const placement = options.placement ?? 'step';
  const cursor = options.cursor ?? null;
  const seed = options.seed ?? null;
  const seedKey = options.seedKey ?? null;
  const key = itemsKey(workspaceId, threadId, turnId ?? '', placement, cursor, seedKey);
  const query = useQuery({
    queryKey: key,
    enabled: enabled && Boolean(options.workspaceId && turnId),
    placeholderData: seed ?? undefined,
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
      const held = queryClient.getQueryData<HeldItems>(key) ?? seed;
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

function sameQueryKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((part, index) => Object.is(part, right[index]));
}

/**
 * One query's data, committed at most ten times a second.
 * The cache may update on every event. This hook is what the timeline renders.
 */
export function useCoalescedQueryItems<T>(
  queryKey: readonly unknown[],
  enabled: boolean
): readonly T[] {
  const queryClient = useQueryClient();
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const identity = queryKey.map((part) => String(part)).join('\u0000');
  const latest = useRef<readonly T[]>([]);
  const [shown, setShown] = useState<readonly T[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity resubscribes when the query key string changes; the effect reads keyRef.
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    let timer = 0;
    let stopped = false;
    let lastFlush = performance.now();
    const flush = () => {
      frame = 0;
      if (stopped) return;
      lastFlush = performance.now();
      const next = latest.current;
      setShown((current) => (current === next ? current : next));
    };
    const schedule = () => {
      if (stopped || frame || timer) return;
      const wait = TEXT_RENDER_INTERVAL_MS - (performance.now() - lastFlush);
      if (wait <= 0) {
        frame = requestAnimationFrame(flush);
        return;
      }
      timer = window.setTimeout(() => {
        timer = 0;
        if (stopped) return;
        frame = requestAnimationFrame(flush);
      }, wait);
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      if (!sameQueryKey(event.query.queryKey, keyRef.current)) return;
      const next = (event.query.state.data as readonly T[] | undefined) ?? [];
      if (next === latest.current) return;
      latest.current = next;
      schedule();
    });
    return () => {
      stopped = true;
      unsubscribe();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [enabled, identity, queryClient]);
  return shown;
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
