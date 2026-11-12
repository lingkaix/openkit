import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { useSteerController } from '../../../primitives/steer-context';
import { SteerOutcome } from './SteerOutcome';
import { steerCopy } from './steer';
import { SteerProvider } from './steer-context';

vi.mock('../data', async (original) => ({
  ...(await original<typeof import('../data')>()),
  useCurrentWorkspaceId: (id: string) => id,
}));

const WS = 'ws_00000000-0000-7000-8000-0000000000aa';
const THREAD = 'th_00000000-0000-7000-8000-0000000000aa';
const TURN = 'tu_00000000-0000-7000-8000-0000000000aa';
const ITEM = 'it_00000000-0000-7000-8000-0000000000aa';
const NOTE = 'Bring the note into this run.';

function ShownReceipt({ itemId }: { itemId: string }) {
  const controller = useSteerController();
  const receipt = controller?.receipt(itemId) ?? null;
  if (!receipt) return <p>No receipt</p>;
  return <SteerOutcome receipt={receipt} />;
}

it('does not take a steer receipt from a window the current read is not showing', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['thread-timeline', WS, THREAD, { kind: 'catch-up' }], {
    runs: [
      {
        narrative: [
          {
            id: ITEM,
            turnId: TURN,
            steer: { requestId: 'req_kept', state: 'accepted', reason: null },
            detail: { kind: 'complete', value: { type: 'user-message', text: NOTE } },
          },
        ],
        plan: null,
      },
    ],
    itemWindow: null,
  });
  const timeline = vi.fn(async (_input: { anchor?: { kind?: string } | null }) => ({
    workspaceId: WS,
    threadId: THREAD,
    view: 'runs',
    runs: [],
    items: [],
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: null,
    catchUpAnchor: null,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  }));
  const client = {
    core: { meta: vi.fn().mockResolvedValue({}), subscribeTurnEvents: vi.fn() },
    operations: {
      'thread.timeline': timeline,
      'thread.dashboard': vi.fn(async () => ({ turns: [], pendingRequests: [] })),
      'conversation.targets': vi.fn(async () => ({ targets: [], defaultTargetRef: null })),
    },
  } as unknown as CoreClient;
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[`/tasks/${WS}/${THREAD}`]}>
          <Routes>
            <Route
              path="/tasks/:workspaceId/:threadId"
              element={
                <SteerProvider mode="task">
                  <ShownReceipt itemId={ITEM} />
                </SteerProvider>
              }
            />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  expect(await screen.findByText('No receipt')).toBeVisible();
  expect(screen.queryByText(steerCopy.accepted)).toBeNull();
  expect(timeline).toHaveBeenCalled();
  expect(timeline.mock.calls.some((call) => call[0].anchor?.kind === 'catch-up')).toBe(false);
});
