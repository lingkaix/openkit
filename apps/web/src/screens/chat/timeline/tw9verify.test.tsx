import { ItemSchema } from '@openkit/protocol';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadStream } from '../ThreadStream';
import {
  B,
  client,
  dashboard,
  EARLY,
  Frame,
  note,
  OUTSIDE,
  page,
  queryOwner,
  RECENT,
  run,
  THREAD,
  TURN,
  USER,
  WS,
} from './__fixtures__/tw9verify';
import { digestAnchorLocation } from './digest';
import { SteerProvider } from './steer-context';
import { anchorFromSearch } from './window';

const owners: ReturnType<typeof queryOwner>[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  for (const cache of owners.splice(0)) cache.clear();
  vi.unstubAllGlobals();
});
function cache() {
  const value = queryOwner();
  owners.push(value);
  return value;
}

// New Since You Were Here: B is an Item, including inside a bounded running run.
it('TW9VERIFY puts the divider after B when only the addressed Item window contains B', async () => {
  const response = page([run([note('Recent summary', RECENT)])]);
  response.runs[0]!.statistics.messages = 2;
  response.itemWindow = {
    turnId: TURN,
    items: [note('Boundary note B')],
    beforeCursor: null,
    afterCursor: null,
  };
  render(
    <Frame api={client({ 'thread.timeline': async () => response })} cache={cache()}>
      <ThreadStream workspaceId={WS} threadId={THREAD} mode="task" anchor={{ kind: 'catch-up' }} />
    </Frame>
  );
  await screen.findByText('Boundary note B');
  await screen.findByText('All replies read');
  const boundary = screen.getByText('Boundary note B');
  const divider = screen.getByRole('group', { name: 'New since you were here' });
  expect(
    boundary.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
    'The visible divider must follow B, not precede the run'
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

// An incomplete held window cannot establish an exact earlier-unread count or
// the oldest unread. An honest unavailable/partial explanation is permitted.
it('TW9VERIFY never reports a loaded unread subset as the exact count or oldest', async () => {
  const response = page([run([note('Loaded earlier unread', EARLY), note('Boundary note B')])]);
  response.beforeCursor = 'an-older-window';
  const read = vi.fn(async (_input: { anchor?: { kind: string; itemId?: string } }) => response);
  render(
    <Frame
      api={client({
        'thread.timeline': read,
        'thread.read-state': async () => ({ readItemIds: [B], unreadItemIds: [OUTSIDE, EARLY] }),
      })}
      cache={cache()}
    >
      <ThreadStream workspaceId={WS} threadId={THREAD} mode="task" anchor={{ kind: 'catch-up' }} />
    </Frame>
  );
  await screen.findByText('Loaded earlier unread');
  await screen.findByRole('button', { name: 'Mark read' });
  await waitFor(() =>
    expect(
      within(screen.getByRole('group', { name: 'New since you were here' })).queryAllByText(
        /earlier unread/i
      ).length
    ).toBeGreaterThan(0)
  );
  const falseTotal = screen.queryByRole('button', { name: '1 earlier unread ›' });
  expect
    .soft(falseTotal, 'One loaded unread is not the exact earlier-unread total')
    .not.toBeInTheDocument();
  // This assertion does not demand a count when the read cannot place OUTSIDE.
  const jump = screen.queryByRole('button', { name: /earlier unread/i });
  if (jump && !jump.hasAttribute('disabled')) {
    await userEvent.click(jump);
    await act(async () => {
      await Promise.resolve();
    });
    const falselySelected = read.mock.calls.some((call) => {
      const input = call[0] as unknown as { anchor?: { kind: string; itemId?: string } };
      return input?.anchor?.kind === 'item' && input.anchor.itemId === EARLY;
    });
    expect(
      falselySelected,
      'The loaded unread must not be presented as oldest while an older window is unresolved'
    ).toBe(false);
  }
});

// Privacy applies to every committed DOM view, not just its eventual settled
// text. Profiler observes DOM commits without importing the digest's store.
it('TW9VERIFY never publishes the previous viewer digest into the next divider', async () => {
  const previous = page();
  previous.digest = {
    lines: [{ kind: 'new-messages', count: 17, anchor: { kind: 'item', itemId: RECENT } }],
    coverage: 'complete',
  };
  previous.afterCursor = 'later-previous';
  const first = render(
    <Frame api={client({ 'thread.timeline': async () => previous })} cache={cache()}>
      <ThreadStream workspaceId={WS} threadId={THREAD} mode="task" anchor={{ kind: 'catch-up' }} />
    </Frame>
  );
  await screen.findByRole('button', { name: '17 new messages' });
  first.unmount();
  const current = page();
  current.digest = {
    lines: [{ kind: 'new-messages', count: 2, anchor: { kind: 'item', itemId: RECENT } }],
    coverage: 'complete',
  };
  current.afterCursor = 'later-current';
  const published: string[] = [];
  render(
    <Frame
      api={client({
        'thread.timeline': async () => current,
        'thread.dashboard': async () => ({
          ...dashboard(),
          viewerUserId: 'usr_00000000-0000-7000-8000-000000000009',
        }),
      })}
      cache={cache()}
    >
      <Profiler id="next-view" onRender={() => published.push(document.body.textContent ?? '')}>
        <ThreadStream
          workspaceId={WS}
          threadId={THREAD}
          mode="task"
          anchor={{ kind: 'catch-up' }}
        />
      </Profiler>
    </Frame>
  );
  await screen.findByRole('button', { name: '2 new messages' });
  expect(
    published.some((text) => text.includes('17 new messages')),
    'A prior viewer count must never enter the next view DOM'
  ).toBe(false);
});

describe('TW9VERIFY digest target selection', () => {
  it.each([
    {
      search: `?turn=${TURN}&turnId=obsolete`,
      anchor: { kind: 'turn' as const, turnId: 'tu_00000000-0000-7000-8000-000000000010' },
    },
    {
      search: `?row=old-row&attention=obsolete&turn=${TURN}`,
      anchor: { kind: 'attention' as const, rowId: 'new-row' },
    },
  ])('opens the new $anchor.kind target instead of a retained alias', ({ search, anchor }) => {
    const destination = digestAnchorLocation({
      pathname: `/tasks/${WS}/${THREAD}`,
      search,
      anchor,
    });
    // Compose the producer URL with its real consumer; parameter spelling itself is not the oracle.
    expect(anchorFromSearch(destination.search)).toEqual(anchor);
  });
});

it('TW9VERIFY shows the retained outcome of an older steer in the catch-up window', async () => {
  const latestTurn = 'tu_00000000-0000-7000-8000-000000000010';
  const value = ItemSchema.parse({
    id: B,
    owner: { kind: 'workspace', workspaceId: WS },
    threadId: THREAD,
    turnId: TURN,
    type: 'user-message',
    actor: { kind: 'user', id: USER },
    status: 'completed',
    text: 'Earlier accepted steer note',
    createdAt: '2026-11-08T12:00:00.000Z',
    completedAt: '2026-11-08T12:00:00.000Z',
  });
  if (value.type !== 'user-message') throw new Error('The steer fixture must be a user message');
  const old = page([
    run([
      {
        ...note('', B),
        type: 'user-message',
        actor: value.actor,
        detail: { kind: 'complete', value },
        steer: { state: 'accepted', requestId: 'retained-steer-one', reason: null },
      },
    ]),
  ]);
  const latest = page([run([note('Latest run only', RECENT, latestTurn)], latestTurn, 40)]);
  latest.anchor = null;
  latest.catchUpAnchor = old.catchUpAnchor;
  const api = client({
    'thread.timeline': async (input: { anchor?: { kind: string } }) =>
      input.anchor?.kind === 'catch-up' ? old : latest,
    'thread.dashboard': async () => {
      const value = dashboard();
      return { ...value, turns: value.turns.map((t) => ({ ...t, id: latestTurn })) };
    },
  });
  render(
    <Frame api={api} cache={cache()} entry={`/tasks/${WS}/${THREAD}?catchUp=1`}>
      <Routes>
        <Route
          path="/tasks/:workspaceId/:threadId"
          element={
            <SteerProvider mode="task">
              <ThreadStream
                workspaceId={WS}
                threadId={THREAD}
                mode="task"
                anchor={{ kind: 'catch-up' }}
              />
            </SteerProvider>
          }
        />
      </Routes>
    </Frame>
  );
  await screen.findByText('Earlier accepted steer note');
  await screen.findByText('Accepted by the running worker');
});
