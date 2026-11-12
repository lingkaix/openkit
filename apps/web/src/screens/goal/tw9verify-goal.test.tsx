import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  B,
  client,
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
  WS,
} from '../chat/timeline/__fixtures__/tw9verify';
import { GoalScreen } from './GoalScreen';

vi.mock('../chat/data', async (load) => ({
  ...(await load<typeof import('../chat/data')>()),
  useCurrentWorkspaceId: (id: string) => id,
}));
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
  for (const owner of owners.splice(0)) owner.clear();
  vi.unstubAllGlobals();
});
function Location() {
  return <output aria-label="Current address">{useLocation().search}</output>;
}

// Goal profile: its shared narrative must consume the anchor, not only rewrite
// the address. An addressed window exposes a neighbor outside the opening window.
describe('TW9VERIFY Goal narrative links', () => {
  it.each(['earlier unread', 'digest'] as const)(
    'moves the Goal narrative through the %s link',
    async (kind) => {
      const owner = queryOwner();
      owners.push(owner);
      const initial = page([run([note('Earlier unread note', EARLY), note('Boundary note B')])]);
      initial.runs[0]!.statistics.messages = 4;
      initial.afterCursor = 'a-later-run-window';
      initial.digest = {
        lines: [{ kind: 'new-messages', count: 3, anchor: { kind: 'item', itemId: RECENT } }],
        coverage: 'complete',
      };
      if (kind === 'earlier unread') {
        initial.earlierUnread = {
          count: 1,
          capped: false,
          oldest: { turnId: TURN, itemId: EARLY },
        };
      }
      const expectedId = kind === 'earlier unread' ? EARLY : RECENT;
      const destinationText = `Only the ${kind} addressed window contains this note`;
      const read = vi.fn(async (input: { anchor?: { kind: string; itemId?: string } }) => {
        if (input.anchor?.kind !== 'item') return initial;
        const addressed = page(initial.runs);
        addressed.anchor = { turnId: TURN, itemId: input.anchor.itemId! };
        addressed.itemWindow = {
          turnId: TURN,
          items: [
            note(destinationText, kind === 'earlier unread' ? OUTSIDE : RECENT),
            ...(kind === 'earlier unread' ? [note('Earlier unread note', EARLY)] : []),
          ],
          beforeCursor: null,
          afterCursor: null,
        };
        return addressed;
      });
      const api = client({
        'thread.timeline': read,
        'thread.read-state': async () => ({ readItemIds: [B, OUTSIDE], unreadItemIds: [EARLY] }),
      });
      render(
        <Frame api={api} cache={owner} entry={`/goals/${WS}/${THREAD}`}>
          <Routes>
            <Route
              path="/goals/:workspaceId/:threadId"
              element={
                <>
                  <Location />
                  <GoalScreen />
                </>
              }
            />
          </Routes>
        </Frame>
      );
      await screen.findByText('Boundary note B');
      await screen.findByRole('button', { name: 'Mark read' });
      const link = await screen.findByRole('button', {
        name: kind === 'earlier unread' ? '1 earlier unread ›' : '3 new messages',
      });
      await userEvent.click(link);
      await waitFor(() =>
        expect(screen.getByLabelText('Current address')).toHaveTextContent(`item=${expectedId}`)
      );
      await screen.findByText(destinationText);
    }
  );
});
