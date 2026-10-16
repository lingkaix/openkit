import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
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
      readItemIds: [...readIds],
      unreadItemIds: ['first', 'second'].filter((id) => !readIds.has(id)),
    });
    const read = vi.fn(async () => state());
    const mark = vi.fn(async (input: { itemIds?: string[] }) => {
      for (const id of input.itemIds ?? ['first', 'second']) readIds.add(id);
      return state();
    });
    const client = {
      core: { meta: async () => ({}) },
      operations: {
        'thread.items': async () => ({
          items: ['first', 'second'].map((id) => ({
            id,
            workspaceId: 'workspace',
            threadId: 'thread',
            turnId: 'turn',
            type: 'assistant-message',
            status: 'completed',
            text: `${id} reply`,
          })),
          nextCursor: null,
        }),
        'thread.dashboard': async () => ({ viewerUserId: 'viewer', turns: [], participants: [] }),
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
    const emitFirst = (intersecting: boolean) =>
      act(() => {
        for (const observer of observers) {
          const target = [...observer.targets].find(
            (element) => element.textContent === 'first reply'
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark read' })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() =>
      expect(mark).toHaveBeenCalledWith({ workspaceId: 'workspace', threadId: 'thread' })
    );
    await screen.findByText('All replies read');
    queryClient.clear();
  });
});
