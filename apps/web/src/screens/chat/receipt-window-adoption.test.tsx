import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { chatKeys, type ThreadItem, useConversationNavigation } from './data';
import {
  ThreadReadReceipts,
  useDisplayedMessageBody,
  useThreadUnreadIds,
} from './ThreadReadReceipts';

// Independent RECEIPT-SHAPE step2 Task projection. These are admitted transport fixtures,
// not durable records. Both exported read consumers use the real React Query owner.
const WS = 'ws_00000000-0000-7000-8000-000000000001';
const THREAD = 'th_00000000-0000-7000-8000-000000000002';
const OTHER_THREAD = 'th_00000000-0000-7000-8000-000000000003';
const USER = 'usr_00000000-0000-7000-8000-000000000004';
const TURN = 'tu_00000000-0000-7000-8000-000000000005';
const AT = '2026-11-14T00:00:00.000Z';
interface ReceiptInput {
  workspaceId: string;
  threadId: string;
  itemIds?: string[];
}
interface ReadState {
  scope: 'window' | 'thread';
  readItemIds: string[];
  unreadItemIds: string[];
}

function message(index: number, status: 'completed' | 'in_progress' = 'completed'): ThreadItem {
  return {
    id: `it_00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    owner: { kind: 'workspace', workspaceId: WS },
    threadId: THREAD,
    turnId: TURN,
    type: 'assistant-message',
    status,
    text: `Reply ${index}`,
    createdAt: AT,
    completedAt: status === 'completed' ? AT : null,
  };
}
function messages(count: number) {
  return Array.from({ length: count }, (_, index) => message(index + 1));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const queryClients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Observer delivery is explicit. Merely mounting or prefetching a body never displays it. */
function intersections() {
  const observers: Array<{ callback: IntersectionObserverCallback; targets: Set<Element> }> = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private state: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.state = { callback, targets: new Set() };
        observers.push(this.state);
      }
      observe(target: Element) {
        this.state.targets.add(target);
      }
      unobserve(target: Element) {
        this.state.targets.delete(target);
      }
      disconnect() {
        this.state.targets.clear();
      }
    }
  );
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  return {
    ids: () =>
      new Set(
        observers.flatMap((observer) =>
          [...observer.targets].map((target) => target.getAttribute('data-item-id'))
        )
      ),
    emit: (ids: Set<string>) =>
      act(() => {
        for (const observer of observers) {
          const entries = [...observer.targets]
            .filter((target) => ids.has(target.getAttribute('data-item-id')!))
            .map(
              (target) =>
                ({
                  target,
                  isIntersecting: true,
                  intersectionRatio: 1,
                }) as IntersectionObserverEntry
            );
          if (entries.length) observer.callback(entries, {} as IntersectionObserver);
        }
      }),
  };
}
function Body({ id }: { id: string }) {
  const ref = useDisplayedMessageBody(id);
  return <div ref={ref} data-item-id={id} />;
}
function UnreadProbe({ items }: { items: ThreadItem[] }) {
  const ids = useThreadUnreadIds(WS, THREAD, USER, items, false);
  return <output data-testid="unread-ids">{JSON.stringify([...ids].sort())}</output>;
}
function NavigationObserver() {
  const navigation = useConversationNavigation(WS);
  return (
    <output data-testid="navigation-state">
      {navigation.isSuccess ? 'ready' : navigation.isError ? 'unavailable' : 'loading'}
    </output>
  );
}

/** Fake only the external Core client. React Query, receipt code, DOM and observers are real. */
function fixture(
  items: ThreadItem[],
  options: { unread?: string[]; navigationCount?: number | null; omitCurrentRow?: boolean } = {}
) {
  const eligible = items.filter((item) => item.status === 'completed').map((item) => item.id);
  const unread = new Set(options.unread ?? eligible);
  const read = vi.fn(async (input: ReceiptInput): Promise<ReadState> => {
    const selected = input.itemIds ?? eligible;
    return {
      scope: input.itemIds === undefined ? 'thread' : 'window',
      readItemIds: selected.filter((id) => eligible.includes(id) && !unread.has(id)),
      unreadItemIds: selected.filter((id) => eligible.includes(id) && unread.has(id)),
    };
  });
  const mark = vi.fn(async (input: ReceiptInput) =>
    input.itemIds === undefined
      ? { scope: 'thread' as const, acknowledgedCount: eligible.length }
      : { scope: 'window' as const, acknowledgedItemIds: [...new Set(input.itemIds)] }
  );
  const row = (id: string, unreadCount: number) => ({
    thread: {
      id,
      owner: { kind: 'workspace' as const, workspaceId: WS },
      name: 'Conversation',
      status: 'active' as const,
      entryPath: 'conversation' as const,
      visibility: 'workspace' as const,
      createdAt: AT,
      updatedAt: AT,
    },
    activity: 'chat' as const,
    state: 'idle' as const,
    lastActivityAt: AT,
    unreadCount,
  });
  const navigation = vi.fn(async () => {
    if (options.navigationCount === null) throw new Error('Navigation unavailable');
    return {
      items: [
        row(OTHER_THREAD, 999),
        ...(options.omitCurrentRow ? [] : [row(THREAD, options.navigationCount ?? 73)]),
      ],
      nextCursor: null,
    };
  });
  const client = {
    operations: {
      'thread.read-state': read,
      'thread.mark-read': mark,
      'conversation.navigation': navigation,
    },
  } as unknown as CoreClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  function mount(children: ReactNode) {
    return render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <NavigationObserver />
          {children}
        </CoreClientProvider>
      </QueryClientProvider>
    );
  }
  function receipts(children?: ReactNode) {
    return (
      <ThreadReadReceipts
        workspaceId={WS}
        threadId={THREAD}
        viewerUserId={USER}
        items={items}
        disabled={false}
      >
        {children}
      </ThreadReadReceipts>
    );
  }
  return { items, read, mark, navigation, queryClient, mount, receipts, unread };
}
async function settled(queryClient: QueryClient) {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  // Join effects and notification delivery, not a product latency threshold.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
/** Grep-able no-legacy-read guard for every recorded request from both Web query consumers. */
function assertBoundedCalls(read: ReturnType<typeof fixture>['read'], loaded: ThreadItem[]) {
  const allowed = new Set(
    loaded.filter((item) => item.status === 'completed').map((item) => item.id)
  );
  expect(read).toHaveBeenCalled();
  for (const [input] of read.mock.calls) {
    expect(input).toHaveProperty('itemIds');
    expect(input.itemIds!.length).toBeGreaterThan(0);
    expect(input.itemIds!.length).toBeLessThanOrEqual(200);
    expect(input.itemIds!.every((id) => allowed.has(id))).toBe(true);
    expect(input.workspaceId).toBe(WS);
    expect(input.threadId).toBe(THREAD);
  }
}

for (const consumer of ['hook', 'receipt provider'] as const) {
  describe(`${consumer}: bounded loaded receipt windows`, () => {
    it('always selects only loaded completed identities and never calls a legacy full read', async () => {
      const items = [...messages(3), message(4, 'in_progress')];
      const f = fixture(items);
      f.mount(consumer === 'hook' ? <UnreadProbe items={items} /> : f.receipts());
      await settled(f.queryClient);
      assertBoundedCalls(f.read, items);
      expect(new Set(f.read.mock.calls.flatMap(([input]) => input.itemIds!))).toEqual(
        new Set(items.slice(0, 3).map((item) => item.id))
      );
    });

    it.each(['empty', 'streaming-only'] as const)(
      'issues no read request with %s loaded content',
      async (kind) => {
        const items = kind === 'empty' ? [] : [message(1, 'in_progress')];
        const f = fixture(items);
        f.mount(consumer === 'hook' ? <UnreadProbe items={items} /> : f.receipts());
        await screen.findByText('ready');
        await settled(f.queryClient);
        expect(f.read).not.toHaveBeenCalled();
      }
    );

    it('unions all chunks for 451 loaded Items, retaining exact unread membership in every chunk', async () => {
      const items = messages(451);
      const expected = items
        .filter((_, index) => index % 3 !== 0)
        .map((item) => item.id)
        .sort();
      const observed = intersections();
      const f = fixture(items, { unread: expected });
      f.mount(
        consumer === 'hook' ? (
          <UnreadProbe items={items} />
        ) : (
          f.receipts(items.map((item) => <Body key={item.id} id={item.id} />))
        )
      );
      await waitFor(() => {
        if (consumer === 'hook')
          expect(JSON.parse(screen.getByTestId('unread-ids').textContent!)).toEqual(expected);
        else expect([...observed.ids()].sort()).toEqual(expected);
      });
      assertBoundedCalls(f.read, items);
      expect(f.read.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(new Set(f.read.mock.calls.flatMap(([input]) => input.itemIds!))).toEqual(
        new Set(items.map((item) => item.id))
      );
      expect(f.mark).not.toHaveBeenCalled();
    });
  });
}

describe('thread-level banner truth and bounded mutations', () => {
  it('uses this Thread navigation count, not an empty loaded window or a sibling count', async () => {
    const f = fixture(messages(3), { unread: [], navigationCount: 73 });
    f.mount(f.receipts());
    await screen.findByText('ready');
    await settled(f.queryClient);
    expect(screen.queryByText('All replies read')).not.toBeInTheDocument();
    expect(screen.getByText(/\b73\b/)).toBeInTheDocument();
    expect(screen.queryByText(/\b999\b/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark read/i })).toBeEnabled();
  });

  it('keeps the navigation count and bulk action available when no Item is loaded', async () => {
    const f = fixture([], { navigationCount: 73 });
    f.mount(f.receipts());
    await screen.findByText('ready');
    await settled(f.queryClient);
    expect(f.read).not.toHaveBeenCalled();
    expect(screen.queryByText('All replies read')).not.toBeInTheDocument();
    expect(screen.getByText(/\b73\b/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark read/i })).toBeEnabled();
  });

  it('uses navigation zero even when the selected window reports unread Items', async () => {
    const f = fixture(messages(2), { navigationCount: 0 });
    f.mount(f.receipts());
    await screen.findByText('ready');
    await settled(f.queryClient);
    expect(screen.getByText('All replies read')).toBeInTheDocument();
  });

  it('does not announce all-read or a partial-window count while another chunk is pending', async () => {
    const items = messages(201);
    const f = fixture(items, { unread: [], navigationCount: 73 });
    const pending = deferred<ReadState>();
    f.read.mockImplementation(async (input) => {
      const selected = input.itemIds ?? items.map((item) => item.id);
      if (selected.includes(items[200]!.id)) return pending.promise;
      return { scope: 'window', readItemIds: selected, unreadItemIds: [] };
    });
    f.mount(f.receipts());
    await screen.findByText('ready');
    await waitFor(() =>
      expect(
        f.read.mock.calls.some(([input]) => (input.itemIds ?? []).includes(items[200]!.id))
      ).toBe(true)
    );
    expect(screen.queryByText('All replies read')).not.toBeInTheDocument();
    expect(screen.getByText(/\b73\b/)).toBeInTheDocument();
    pending.resolve({ scope: 'window', readItemIds: [items[200]!.id], unreadItemIds: [] });
    await settled(f.queryClient);
    expect(screen.queryByText('All replies read')).not.toBeInTheDocument();
  });

  it.each(['unavailable', 'missing-current-row'] as const)(
    'makes neither thread count nor all-read claim when navigation is %s',
    async (kind) => {
      const f = fixture([], {
        unread: [],
        navigationCount: kind === 'unavailable' ? null : 73,
        omitCurrentRow: kind === 'missing-current-row',
      });
      f.mount(f.receipts());
      await screen.findByText(kind === 'unavailable' ? 'unavailable' : 'ready');
      await settled(f.queryClient);
      expect(screen.queryByText('All replies read')).not.toBeInTheDocument();
      expect(screen.queryByText(/\b(?:0|73|999)\b/)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/\d+\s+(?:unread|replies)|(?:unread|replies)\s*[:(]?\s*\d+/i)
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Mark read/i })).toBeEnabled();
    }
  );

  it('marks only actually displayed IDs in bounded batches and invalidates both existing query prefixes after ACK', async () => {
    const items = messages(205);
    const displayed = new Set(items.slice(0, 202).map((item) => item.id));
    const observed = intersections();
    const f = fixture(items);
    const invalidate = vi.spyOn(f.queryClient, 'invalidateQueries');
    const ack = deferred<{ scope: 'window'; acknowledgedItemIds: string[] }>();
    f.mark.mockImplementationOnce(() => ack.promise);
    f.mount(f.receipts(items.map((item) => <Body key={item.id} id={item.id} />)));
    await waitFor(() => expect(observed.ids().size).toBe(items.length));
    expect(f.mark).not.toHaveBeenCalled();
    observed.emit(displayed);
    await waitFor(() => expect(f.mark).toHaveBeenCalledTimes(1));
    expect(invalidate).not.toHaveBeenCalled();
    expect(observed.ids().has(items[204]!.id)).toBe(true);
    ack.resolve({ scope: 'window', acknowledgedItemIds: f.mark.mock.calls[0]![0].itemIds! });
    await waitFor(() =>
      expect(new Set(f.mark.mock.calls.flatMap(([input]) => input.itemIds ?? []))).toEqual(
        displayed
      )
    );
    await waitFor(() => expect(f.queryClient.isMutating()).toBe(0));
    for (const [input] of f.mark.mock.calls) {
      expect(input.itemIds).toBeDefined();
      expect(input.itemIds!.length).toBeGreaterThan(0);
      expect(input.itemIds!.length).toBeLessThanOrEqual(200);
      expect(input.itemIds!.every((id) => displayed.has(id))).toBe(true);
    }
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['thread-read-state', WS, THREAD, USER] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.navigation(WS) });
    // The transport's next read still says unread. Acknowledgement is not optimistic membership.
    expect(observed.ids().has(items[204]!.id)).toBe(true);
  });

  it('retries only the displayed IDs after a failed display ACK', async () => {
    const items = messages(3);
    const observed = intersections();
    const f = fixture(items);
    f.mark.mockRejectedValueOnce(new Error('Display acknowledgement unavailable'));
    f.mount(f.receipts(items.map((item) => <Body key={item.id} id={item.id} />)));
    await waitFor(() => expect(observed.ids().size).toBe(3));
    observed.emit(new Set([items[1]!.id]));
    await screen.findByText('Read state was not saved.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(f.mark).toHaveBeenCalledTimes(2));
    for (const [input] of f.mark.mock.calls)
      expect(input).toEqual({ workspaceId: WS, threadId: THREAD, itemIds: [items[1]!.id] });
  });

  it('bulk Mark read omits itemIds and still invalidates read-state and navigation after bounded ACK', async () => {
    const f = fixture(messages(3));
    const invalidate = vi.spyOn(f.queryClient, 'invalidateQueries');
    f.mount(f.receipts());
    await screen.findByRole('button', { name: /Mark read/i });
    await userEvent.setup().click(screen.getByRole('button', { name: /Mark read/i }));
    await waitFor(() => expect(f.mark).toHaveBeenCalledTimes(1));
    expect(f.mark.mock.calls[0]![0]).toEqual({ workspaceId: WS, threadId: THREAD });
    expect(f.mark.mock.calls[0]![0]).not.toHaveProperty('itemIds');
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['thread-read-state', WS, THREAD, USER] })
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.navigation(WS) });
  });
});
