import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadStream } from '../ThreadStream';
import {
  B,
  client,
  EARLY,
  Frame,
  note,
  page,
  queryOwner,
  run,
  THREAD,
  WS,
} from './__fixtures__/tw9verify';

const owners: ReturnType<typeof queryOwner>[] = [];
const releases: Array<() => void> = [];

beforeEach(() => {
  viStubObserver();
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  cleanup();
  for (const cache of owners.splice(0)) cache.clear();
  viUnstub();
});

function viStubObserver() {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
}

function viUnstub() {
  vi.unstubAllGlobals();
}

function ownedCache() {
  const cache = queryOwner();
  owners.push(cache);
  return cache;
}

function renderChat(operations: Record<string, unknown>, cache: ReturnType<typeof ownedCache>) {
  render(
    <Frame api={client(operations)} cache={cache} entry={`/chat/${WS}/${THREAD}`}>
      <ThreadStream workspaceId={WS} threadId={THREAD} mode="chat" anchor={{ kind: 'catch-up' }} />
    </Frame>
  );
}

const dividerName = 'New since you were here';

it('keeps the catch-up divider and the Unread mark after a later read clears unread ids', async () => {
  let unread = [B];
  const cache = ownedCache();
  renderChat(
    {
      'thread.timeline': async () => page([run([note('Boundary note B')])]),
      'thread.read-state': async () => ({ readItemIds: [], unreadItemIds: unread }),
      'thread.mark-read': async () => ({}),
    },
    cache
  );
  await screen.findByText('Boundary note B');
  await screen.findByRole('group', { name: dividerName });
  expect(screen.getByText('Unread')).not.toHaveAttribute('aria-hidden', 'true');
  unread = [];
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['thread-read-state'] });
  });
  await screen.findByText('All replies read');
  expect(screen.getByRole('group', { name: dividerName })).toBeInTheDocument();
  expect(screen.getByText('Unread')).not.toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByText('Unread')).toBeVisible();
});

it('hides Unread marks in place when Mark read is used and keeps the catch-up divider', async () => {
  const cache = ownedCache();
  let unread = [B];
  renderChat(
    {
      'thread.timeline': async () => page([run([note('Boundary note B')])]),
      'thread.read-state': async () => ({ readItemIds: [], unreadItemIds: unread }),
      'thread.mark-read': async () => {
        unread = [];
        return {};
      },
    },
    cache
  );
  await screen.findByRole('group', { name: dividerName });
  await userEvent.click(await screen.findByRole('button', { name: 'Mark read' }));
  const mark = screen.getByText('Unread');
  expect(mark).toHaveAttribute('aria-hidden', 'true');
  expect(mark).toHaveStyle({ visibility: 'hidden' });
  expect(screen.getByRole('group', { name: dividerName })).toBeInTheDocument();
  await screen.findByText('All replies read');
  expect(screen.getByText('Unread')).toHaveStyle({ visibility: 'hidden' });
});

it('keeps the Unread mark and catch-up divider while an earlier page is still resolving its read', async () => {
  const cache = ownedCache();
  let hang = false;
  let release = () => {};
  releases.push(() => release());
  let runs = [run([note('Boundary note B')])];
  renderChat(
    {
      'thread.timeline': async () => page(runs),
      'thread.read-state': () => {
        if (!hang) return Promise.resolve({ readItemIds: [], unreadItemIds: [B] });
        return new Promise((resolve) => {
          release = () => resolve({ readItemIds: [], unreadItemIds: [] });
        });
      },
    },
    cache
  );
  await screen.findByText('Unread');
  await screen.findByRole('group', { name: dividerName });
  hang = true;
  runs = [run([note('Older context', EARLY), note('Boundary note B')])];
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['thread-timeline'] });
  });
  await screen.findByText('Older context');
  expect(screen.getByText('Unread')).not.toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByRole('group', { name: dividerName })).toBeInTheDocument();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(screen.getByText('Unread')).not.toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByRole('group', { name: dividerName })).toBeInTheDocument();
});

it('does not add a catch-up divider after the thread opened without one', async () => {
  const cache = ownedCache();
  let unread: string[] = [];
  renderChat(
    {
      'thread.timeline': async () => page([run([note('Boundary note B')])]),
      'thread.read-state': async () => ({ readItemIds: [], unreadItemIds: unread }),
    },
    cache
  );
  await screen.findByText('Boundary note B');
  await screen.findByText('All replies read');
  expect(screen.queryByRole('group', { name: dividerName })).not.toBeInTheDocument();
  unread = [B];
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['thread-read-state'] });
  });
  await screen.findByRole('button', { name: 'Mark read' });
  expect(screen.queryByRole('group', { name: dividerName })).not.toBeInTheDocument();
});
