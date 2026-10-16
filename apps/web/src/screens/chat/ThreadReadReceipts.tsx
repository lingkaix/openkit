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
import { chatKeys, type ThreadItem } from './data';

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
  const completedIds = items
    .filter(
      (item) =>
        item.status === 'completed' &&
        (item.type === 'assistant-message' || item.type === 'user-message')
    )
    .map((item) => item.id);
  const state = useQuery({
    queryKey: [...queryPrefix, completedIds],
    queryFn: () => client.operations['thread.read-state']({ workspaceId: workspaceId!, threadId }),
    enabled: Boolean(workspaceId && viewerUserId && !disabled),
  });
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
    mutationFn: (input: { itemIds?: string[] }) =>
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
        <div className="flex flex-col gap-2">
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
          {state.isSuccess ? (
            unreadIds.size > 0 ? (
              <Button
                variant="quiet"
                size="sm"
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
            ) : (
              <p className="text-xs text-fg-muted">All replies read</p>
            )
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
