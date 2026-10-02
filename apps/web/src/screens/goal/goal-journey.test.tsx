import type { GoalView } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { GoalScreen } from './GoalScreen';

vi.mock('../../app/core-client', async (original) => ({
  ...(await original<typeof import('../../app/core-client')>()),
  useConnection: () => ({ checking: false, failed: false }),
}));
vi.mock('../chat/data', () => ({ useCurrentWorkspaceId: (id: string) => id }));
const at = '2026-10-03T00:00:00.000Z';
/** One joined view: editable current intent, exact proposed bytes and retained ordinary Task state. */
function view(): GoalView {
  return {
    goal: {
      goalId: 'g1',
      workspaceId: 'ws1',
      threadId: 'th1',
      responsibleUserId: 'user_local',
      responsibleActorContext: { kind: 'local', userId: 'user_local' },
      intent: 'Ship release',
      intentRevision: 0,
      intentHistory: [],
      activePlanVersionId: null,
      proposedPlanVersionId: 'p1',
      disposition: null,
      changeRevision: 1,
      consideredRevision: 1,
      createdAt: at,
      updatedAt: at,
    },
    cards: [
      {
        cardId: 'c1',
        goalId: 'g1',
        description: 'Verify release',
        priority: 0,
        revision: 2,
        cancelled: false,
        cancellationReason: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
    versions: [
      {
        planVersionId: 'p1',
        goalId: 'g1',
        sequence: 1,
        bytes: 'Exact commitment',
        digest: `sha256:${'a'.repeat(64)}`,
        pendingRequestId: 'ap1',
        createdAt: at,
        commitment: {
          intentBasis: { intent: 'Ship release', revision: 0 },
          cards: [],
          permittedAdjustments: 'Reorder',
          completionEvidence: ['Report'],
          boundaries: 'No publication',
        },
      },
    ],
    tasks: [
      {
        goalId: 'g1',
        cardId: 'c1',
        threadId: 'task1',
        planVersionId: 'p1',
        cardRevision: 1,
        admittedAt: at,
        missing: false,
        turns: [{ turnId: 't1', status: 'completed', completedAt: at }],
      },
    ],
    requests: [
      {
        requestId: 'ap1',
        operation: 'goal.plan.approve',
        state: 'pending',
        resolution: null,
        reason: null,
        decidingActorId: null,
        claim: 'unclaimed',
        disposition: null,
        exactIntent: { bytes: 'Exact commitment' },
      },
    ],
  };
}
function mount(data = view()) {
  const operations = {
    'goal.read': vi.fn().mockResolvedValue(data),
    'goal.card.edit': vi.fn().mockResolvedValue(data),
    'goal.card.create': vi.fn().mockResolvedValue(data),
    'goal.intent.revise': vi.fn().mockResolvedValue(data),
    'goal.plan.approve': vi.fn().mockResolvedValue(data),
    'goal.completion.accept': vi.fn().mockResolvedValue(data),
    'goal.cancel': vi.fn().mockResolvedValue(data),
    'goal.create': vi.fn().mockResolvedValue(data),
  };
  const client = { operations } as unknown as CoreClient;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/goals/ws1/th1']}>
          <Routes>
            <Route path="/goals/:workspaceId/:threadId" element={<GoalScreen />} />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return operations;
}
afterEach(cleanup);
it('shows current cards, exact proposed commitment, and linked Task completion without ending the Goal', async () => {
  mount();
  expect(await screen.findByRole('heading', { name: 'Cards' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Proposed Plan' })).toBeVisible();
  expect(screen.getByText('Exact commitment')).toBeVisible();
  expect(screen.getByRole('link', { name: /task1/ })).toHaveAttribute('href', '/tasks/ws1/task1');
  expect(screen.getByText('Open')).toBeVisible();
});
it('edits a card with its read revision and decides the exact pending proposal', async () => {
  const operations = mount();
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Cards' });
  const description = screen.getByRole('textbox', { name: 'Card description c1' });
  await user.clear(description);
  await user.type(description, 'Verify build');
  await user.click(screen.getByRole('button', { name: 'Save card c1' }));
  await waitFor(() =>
    expect(operations['goal.card.edit']).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 'c1', expectedRevision: 2, description: 'Verify build' })
    )
  );
  await user.click(screen.getByRole('button', { name: 'Approve Plan' }));
  await waitFor(() =>
    expect(operations['goal.plan.approve']).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRequestId: 'ap1', decision: 'granted' })
    )
  );
});
it('accepts only the exact captured completion request and sends revision-bound cancellation', async () => {
  const data = view();
  data.requests[0] = {
    ...data.requests[0]!,
    operation: 'goal.completion.accept',
    exactIntent: {
      candidate: { summary: 'Review release evidence', unresolvedWork: ['Publication remains'] },
    },
  } as (typeof data.requests)[number];
  const operations = mount(data);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Accept completion' }));
  await waitFor(() =>
    expect(operations['goal.completion.accept']).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRequestId: 'ap1', decision: 'granted' })
    )
  );
  await user.type(
    screen.getByRole('textbox', { name: 'Goal cancellation reason' }),
    'Stop this outcome'
  );
  await user.click(screen.getByRole('button', { name: 'Cancel Goal' }));
  await waitFor(() =>
    expect(operations['goal.cancel']).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, reason: 'Stop this outcome' })
    )
  );
});
it('creates one Goal with the origin Thread and retries the same command identity after an uncertain response', async () => {
  const operations = mount({
    ...view(),
    goal: null,
    cards: [],
    versions: [],
    tasks: [],
    requests: [],
  } as unknown as ReturnType<typeof view>);
  operations['goal.create'].mockRejectedValueOnce(new Error('Unknown transport result'));
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Goal intent' }), 'Review a design');
  await user.click(screen.getByRole('button', { name: 'Create Goal' }));
  await waitFor(() => expect(operations['goal.create']).toHaveBeenCalledOnce());
  await user.click(await screen.findByRole('button', { name: /try again/i }));
  await waitFor(() => expect(operations['goal.create']).toHaveBeenCalledTimes(2));
  expect(operations['goal.create'].mock.calls[0]![0]).toEqual(
    operations['goal.create'].mock.calls[1]![0]
  );
  expect(operations['goal.create'].mock.calls[0]![0]).toMatchObject({
    originThreadId: 'th1',
    intent: 'Review a design',
  });
});
