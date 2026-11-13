import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { READ_STATE_CHUNK, readThreadWindowState } from './ThreadReadReceipts';
import { ThreadStream } from './ThreadStream';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('displayed conversation receipts', () => {
  it('keeps prefetch and hidden or offscreen bodies unread, then records a visible body or explicit Mark read', async () => {
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
        disconnect() {
          this.state.targets.clear();
        }
        unobserve(target: Element) {
          this.state.targets.delete(target);
        }
      }
    );
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const readIds = new Set<string>();
    const state = () => ({
      scope: 'window',
      readItemIds: [...readIds],
      unreadItemIds: ['first', 'second'].filter((id) => !readIds.has(id)),
    });
    const read = vi.fn(async () => state());
    let rejectSave = true;
    const mark = vi.fn(async (input: { itemIds?: string[] }) => {
      if (rejectSave) {
        rejectSave = false;
        throw new Error('Save unavailable');
      }
      for (const id of input.itemIds ?? ['first', 'second']) readIds.add(id);
      return input.itemIds
        ? { scope: 'window' as const, acknowledgedItemIds: input.itemIds }
        : { scope: 'thread' as const, acknowledgedCount: 2 };
    });
    const client = {
      core: { meta: async () => ({}) },
      operations: {
        'thread.items': async () => ({
          items: ['first', 'second'].map((id) => ({
            id,
            owner: { kind: 'workspace', workspaceId: 'workspace' },
            threadId: 'thread',
            turnId: `turn-${id}`,
            type: 'assistant-message',
            status: 'completed',
            text: `${id} reply`,
          })),
          nextCursor: null,
        }),
        'thread.dashboard': async () => ({ viewerUserId: 'viewer', turns: [], participants: [] }),
        'conversation.navigation': async () => ({
          items: [
            {
              thread: { id: 'thread' },
              activity: 'chat' as const,
              state: 'idle' as const,
              lastActivityAt: '2026-01-01T00:00:00.000Z',
              unreadCount: ['first', 'second'].filter((id) => !readIds.has(id)).length,
            },
          ],
          nextCursor: null,
        }),
        'thread.read-state': read,
        'thread.mark-read': mark,
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <ThreadStream workspaceId="workspace" threadId="thread" />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await screen.findByText('first reply');
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(mark).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        observers.some((observer) =>
          [...observer.targets].some((element) => element.textContent?.trim() === 'first reply')
        )
      ).toBe(true)
    );
    const emitFirst = (intersecting: boolean) =>
      act(() => {
        for (const observer of observers) {
          const target = [...observer.targets].find(
            (element) => element.textContent?.trim() === 'first reply'
          );
          if (target)
            observer.callback(
              [
                {
                  target,
                  isIntersecting: intersecting,
                  intersectionRatio: intersecting ? 1 : 0,
                } as IntersectionObserverEntry,
              ],
              {} as IntersectionObserver
            );
        }
      });
    emitFirst(false);
    visibility = 'hidden';
    emitFirst(true);
    expect(mark).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    emitFirst(true);
    await waitFor(() =>
      expect(mark).toHaveBeenCalledWith({
        workspaceId: 'workspace',
        threadId: 'thread',
        itemIds: ['first'],
      })
    );
    await screen.findByText('Read state was not saved.');
    expect(readIds.size).toBe(0);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mark).toHaveBeenCalledTimes(2));
    expect(mark).toHaveBeenLastCalledWith({
      workspaceId: 'workspace',
      threadId: 'thread',
      itemIds: ['first'],
    });
    await waitFor(() => expect(readIds.has('first')).toBe(true));
    expect(readIds.has('second')).toBe(false);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark read' })).toBeEnabled());
    const markRead = screen.getByRole('button', { name: 'Mark read' });
    const dock = markRead.closest('[data-read-dock="bar"]');
    expect(dock).not.toBeNull();
    expect(dock).toHaveClass('justify-start');
    expect(markRead.className).toContain('self-start');
    await userEvent.setup().click(markRead);
    await waitFor(() =>
      expect(mark).toHaveBeenCalledWith({ workspaceId: 'workspace', threadId: 'thread' })
    );
    await screen.findByText('All replies read');
    queryClient.clear();
  });

  it.each([
    {
      label: 'server-owned dashboard',
      threadOwner: { kind: 'server' as const },
      expectUnavailableBanner: false,
    },
    {
      label: 'workspace-owned dashboard',
      threadOwner: { kind: 'workspace' as const, workspaceId: 'workspace' },
      expectUnavailableBanner: true,
    },
  ])(
    'focus admission for $label with empty turns',
    async ({ threadOwner, expectUnavailableBanner }) => {
      const dashboard = vi.fn(async () => ({
        thread: {
          id: 'thread',
          owner: threadOwner,
          name: null,
          preview: 'Thread preview',
          status: 'active' as const,
          entryPath: 'conversation' as const,
          visibility: threadOwner.kind === 'server' ? ('server' as const) : ('workspace' as const),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        turns: [],
        participants: [],
        viewerUserId: 'viewer',
      }));
      const client = {
        core: { meta: async () => ({}) },
        operations: {
          'thread.items': async () => ({
            items: [
              {
                id: 'first',
                owner: { kind: 'workspace', workspaceId: 'workspace' },
                threadId: 'thread',
                turnId: 'turn',
                type: 'assistant-message',
                status: 'completed',
                text: 'first reply',
              },
            ],
            nextCursor: null,
          }),
          'thread.dashboard': dashboard,
          'conversation.navigation': async () => ({
            items: [
              {
                thread: { id: 'thread' },
                activity: 'chat' as const,
                state: 'idle' as const,
                lastActivityAt: '2026-01-01T00:00:00.000Z',
                unreadCount: 1,
              },
            ],
            nextCursor: null,
          }),
          'thread.read-state': async () => ({
            scope: 'window',
            readItemIds: [],
            unreadItemIds: ['first'],
          }),
          'thread.mark-read': async () => ({ scope: 'window', acknowledgedItemIds: ['first'] }),
        },
      } as unknown as CoreClient;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <CoreClientProvider client={client}>
            <ThreadStream workspaceId="workspace" threadId="thread" focusTurnId="focus-turn" />
          </CoreClientProvider>
        </QueryClientProvider>
      );
      await screen.findByText('first reply');
      await waitFor(() => expect(dashboard).toHaveBeenCalled());
      const unavailableCopy = 'This run is not in this conversation.';
      if (expectUnavailableBanner) {
        expect(await screen.findByText(unavailableCopy)).toBeInTheDocument();
      } else {
        await waitFor(() => expect(screen.queryByText(unavailableCopy)).not.toBeInTheDocument());
      }
      queryClient.clear();
    }
  );
});

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      found.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('windowed thread.read-state', () => {
  it('chunks at 200, unions the windows, and issues no request for zero ids', async () => {
    const calls: string[][] = [];
    const client = {
      operations: {
        'thread.read-state': async (input: { itemIds?: string[] }) => {
          const itemIds = input.itemIds ?? [];
          calls.push(itemIds);
          return { scope: 'window' as const, readItemIds: [], unreadItemIds: itemIds };
        },
      },
    } as unknown as CoreClient;
    const ids = Array.from({ length: READ_STATE_CHUNK + 1 }, (_, index) => `it_${index}`);
    const page = await readThreadWindowState(client, 'workspace', 'thread', ids);
    expect(calls).toEqual([ids.slice(0, READ_STATE_CHUNK), ids.slice(READ_STATE_CHUNK)]);
    expect(page).toEqual({ scope: 'window', readItemIds: [], unreadItemIds: ids });
    const idle = vi.fn();
    const emptyClient = {
      operations: { 'thread.read-state': idle },
    } as unknown as CoreClient;
    await expect(readThreadWindowState(emptyClient, 'workspace', 'thread', [])).resolves.toEqual({
      scope: 'window',
      readItemIds: [],
      unreadItemIds: [],
    });
    expect(idle).not.toHaveBeenCalled();
  });

  it('passes itemIds on every Web thread.read-state call', () => {
    const web = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const calls: string[] = [];
    for (const file of sourceFiles(web)) {
      const source = readFileSync(file, 'utf8');
      const pattern = /operations\[['"]thread\.read-state['"]\]\(/g;
      for (const match of source.matchAll(pattern)) {
        const call = source.slice(match.index ?? 0, source.indexOf(')', match.index ?? 0) + 1);
        calls.push(call);
        expect(call, file).toContain('itemIds');
        expect(call, file).not.toMatch(/itemIds:\s*\[\s*\]/);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});
