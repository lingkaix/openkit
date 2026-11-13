import type { CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useCoreClient } from '../../app/core-client';
import { Button, ErrorBanner } from '../../primitives';
import { chatKeys, type ThreadItem, useConversationNavigation } from './data';

/** Server window for one thread.read-state call. Larger loaded sets are chunked. */
export const READ_STATE_CHUNK = 200;

type WindowReadState = {
  scope: 'window';
  readItemIds: string[];
  unreadItemIds: string[];
};

type MarkReadResult = Awaited<ReturnType<CoreClient['operations']['thread.mark-read']>>;

/**
 * Read membership for the loaded completed messages.
 * Zero IDs issue no request. Each request carries at most READ_STATE_CHUNK ids.
 * Chunks are unioned in first-seen order. A legacy thread-scoped body is refused.
 */
export async function readThreadWindowState(
  client: CoreClient,
  workspaceId: string,
  threadId: string,
  itemIds: readonly string[]
): Promise<WindowReadState> {
  const readItemIds: string[] = [];
  const unreadItemIds: string[] = [];
  const seenRead = new Set<string>();
  const seenUnread = new Set<string>();
  for (let start = 0; start < itemIds.length; start += READ_STATE_CHUNK) {
    const chunk = itemIds.slice(start, start + READ_STATE_CHUNK);
    const page = await client.operations['thread.read-state']({
      workspaceId,
      threadId,
      itemIds: [...chunk],
    });
    if (page.scope !== 'window') throw new Error('thread.read-state returned a thread scope.');
    for (const id of page.readItemIds) {
      if (seenRead.has(id)) continue;
      seenRead.add(id);
      readItemIds.push(id);
    }
    for (const id of page.unreadItemIds) {
      if (seenUnread.has(id)) continue;
      seenUnread.add(id);
      unreadItemIds.push(id);
    }
  }
  return { scope: 'window', readItemIds, unreadItemIds };
}

/** Eligibility key shared by the receipt banner and the timeline unread marks. */
export function readStateQueryKey(
  workspaceId: string | null,
  threadId: string,
  viewerUserId: string | null | undefined,
  items: readonly ThreadItem[]
) {
  const completedIds = items
    .filter(
      (item) =>
        item.status === 'completed' &&
        (item.type === 'assistant-message' || item.type === 'user-message')
    )
    .map((item) => item.id);
  return ['thread-read-state', workspaceId, threadId, viewerUserId, completedIds] as const;
}

/** One windowed read for the completed IDs already stored on the query key. */
function useWindowReadState(
  workspaceId: string | null,
  threadId: string,
  viewerUserId: string | null | undefined,
  items: readonly ThreadItem[],
  disabled: boolean
) {
  const client = useCoreClient();
  const queryKey = readStateQueryKey(workspaceId, threadId, viewerUserId, items);
  const itemIds = queryKey[4];
  return useQuery({
    queryKey,
    queryFn: () => readThreadWindowState(client, workspaceId!, threadId, itemIds),
    enabled: Boolean(workspaceId && viewerUserId && !disabled && itemIds.length > 0),
  });
}

/** Receipt unread set. Items before the catch-up anchor stay in the set. */
export function useThreadUnreadIds(
  workspaceId: string | null,
  threadId: string,
  viewerUserId: string | null | undefined,
  items: readonly ThreadItem[],
  disabled: boolean
): ReadonlySet<string> {
  const state = useWindowReadState(workspaceId, threadId, viewerUserId, items, disabled);
  return useMemo(
    () => new Set(state.isSuccess && !disabled ? state.data.unreadItemIds : []),
    [disabled, state.data, state.isSuccess]
  );
}

/** Display callbacks exist only beneath the current authenticated Thread receipt read. */
const ReadReceiptContext = createContext<{
  unreadIds: ReadonlySet<string>;
  displayed: (itemId: string) => void;
} | null>(null);

/** Reads User-owned receipt state and batches actual displayed bodies without optimistic unread changes. */
export function ThreadReadReceipts({
  workspaceId,
  threadId,
  viewerUserId,
  items,
  disabled,
  children,
}: {
  workspaceId: string | null;
  threadId: string;
  viewerUserId: string | null | undefined;
  items: readonly ThreadItem[];
  disabled: boolean;
  children: ReactNode;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const queryPrefix = useMemo(
    () => ['thread-read-state', workspaceId, threadId, viewerUserId] as const,
    [workspaceId, threadId, viewerUserId]
  );
  // A new completed message requires a fresh eligibility read; streaming token changes do not.
  const state = useWindowReadState(workspaceId, threadId, viewerUserId, items, disabled);
  const navigation = useConversationNavigation(viewerUserId && !disabled ? workspaceId : null);
  const threadUnreadCount = navigation.isSuccess
    ? navigation.data?.find((row) => row.thread.id === threadId)?.unreadCount
    : undefined;
  const exactUnread = typeof threadUnreadCount === 'number' ? threadUnreadCount : null;
  const pending = useRef(new Set<string>());
  const running = useRef(false);
  const failed = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mark = useMutation({
    mutationFn: (input: { itemIds?: string[] }): Promise<MarkReadResult> =>
      client.operations['thread.mark-read']({ workspaceId: workspaceId!, threadId, ...input }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryPrefix }),
        queryClient.invalidateQueries({ queryKey: chatKeys.navigation(workspaceId!) }),
      ]);
    },
  });
  const { mutateAsync } = mark;
  const flush = useCallback(
    async function flushDisplayed() {
      if (!mounted.current || running.current || failed.current || pending.current.size === 0)
        return;
      const itemIds = [...pending.current].slice(0, 200);
      running.current = true;
      try {
        await mutateAsync({ itemIds });
        for (const id of itemIds) pending.current.delete(id);
      } catch {
        // Keep only displayed identities for the visible Retry action; never substitute all unread Items.
        failed.current = true;
      } finally {
        running.current = false;
      }
      if (!failed.current) void flushDisplayed();
    },
    [mutateAsync]
  );
  const displayed = useCallback(
    (id: string) => {
      pending.current.add(id);
      queueMicrotask(() => void flush());
    },
    [flush]
  );
  const unreadIds = useMemo(
    () => new Set(state.isSuccess && !disabled ? state.data.unreadItemIds : []),
    [disabled, state.data, state.isSuccess]
  );
  const context = useMemo(() => ({ unreadIds, displayed }), [unreadIds, displayed]);
  return (
    <ReadReceiptContext.Provider value={context}>
      {viewerUserId && !disabled ? (
        <div className="flex min-h-11 flex-col gap-2">
          {state.isError ? (
            <ErrorBanner
              message="Read state is unavailable."
              onRetry={() => void state.refetch()}
            />
          ) : null}
          {mark.isError ? (
            <ErrorBanner
              message="Read state was not saved."
              onRetry={() => {
                failed.current = false;
                if (pending.current.size > 0) void flush();
                else if (mark.variables) mark.mutate(mark.variables);
              }}
            />
          ) : null}
          {exactUnread != null && exactUnread > 0 ? (
            <p className="text-xs text-fg-muted">
              {exactUnread === 1 ? '1 unread reply' : `${exactUnread} unread replies`}
            </p>
          ) : null}
          {exactUnread === 0 ? <p className="text-xs text-fg-muted">All replies read</p> : null}
          {navigation.isSuccess && exactUnread == null ? (
            <span
              aria-hidden
              data-unread="unknown"
              className="inline-block size-1.5 rounded-full bg-fg-muted"
            />
          ) : null}
          {unreadIds.size > 0 || exactUnread == null || exactUnread > 0 ? (
            <div data-read-dock="bar" className="flex justify-start">
              <Button
                variant="quiet"
                size="sm"
                className="self-start"
                isDisabled={mark.isPending}
                onPress={() =>
                  mark.mutate(
                    {},
                    {
                      onSuccess: () => {
                        pending.current.clear();
                        failed.current = false;
                      },
                    }
                  )
                }
              >
                Mark read
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </ReadReceiptContext.Provider>
  );
}

/** Observes the message body itself; hidden documents and offscreen or merely prefetched content cannot advance a receipt. */
export function useDisplayedMessageBody(itemId: string) {
  const receipt = useContext(ReadReceiptContext);
  const body = useRef<HTMLDivElement>(null);
  const eligible = receipt?.unreadIds.has(itemId) ?? false;
  const displayed = receipt?.displayed;
  useEffect(() => {
    const element = body.current;
    if (!element || !eligible || !displayed || typeof IntersectionObserver === 'undefined') return;
    let observed = false;
    const observer = new IntersectionObserver((entries) => {
      if (observed || document.visibilityState !== 'visible') return;
      if (
        !entries.some(
          (entry) => entry.target === element && entry.isIntersecting && entry.intersectionRatio > 0
        )
      )
        return;
      observed = true;
      observer.disconnect();
      displayed(itemId);
    });
    const refreshVisibleBody = () => {
      if (!observed && document.visibilityState === 'visible') {
        observer.disconnect();
        observer.observe(element);
      }
    };
    observer.observe(element);
    document.addEventListener('visibilitychange', refreshVisibleBody);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', refreshVisibleBody);
    };
  }, [displayed, eligible, itemId]);
  return body;
}
