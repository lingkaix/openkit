import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { ToastProvider, toastQueue } from '../../primitives';
import { useSendTurn } from './data';

const WORKSPACE = 'ws_00000000-0000-7000-8000-000000000001';
const THREAD = 'th_00000000-0000-7000-8000-000000000001';
const OTHER = 'th_00000000-0000-7000-8000-000000000002';

function LocationProbe() {
  const location = useLocation();
  return <p>{location.pathname}</p>;
}

function Sender() {
  const send = useSendTurn();
  return (
    <button
      type="button"
      onClick={() =>
        void send.mutate({
          workspaceId: WORKSPACE,
          threadId: THREAD,
          draft: {
            input: 'Hello',
            targetRef: 'target',
            artifactRefs: [],
            requestId: 'req_00000000-0000-7000-8000-000000000001',
          },
        })
      }
    >
      Send
    </button>
  );
}

function renderSender(submit: ReturnType<typeof vi.fn>) {
  const client = {
    operations: { 'conversation.submit': submit },
  } as unknown as CoreClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <ToastProvider />
          <Routes>
            <Route path="/" element={<Sender />} />
            <Route path="/tasks/:workspaceId/:threadId" element={<LocationProbe />} />
            <Route path="/goals/:workspaceId/:threadId" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return view;
}

describe('admission toast', () => {
  afterEach(() => {
    toastQueue.clear();
  });

  it('queues no toast when the send stays on the same thread', async () => {
    const user = userEvent.setup();
    for (const outcome of ['answered', 'task-handoff', 'goal-handoff']) {
      const submit = vi.fn().mockResolvedValue({
        outcome,
        receivingWorkspaceId: WORKSPACE,
        receivingThreadId: THREAD,
      });
      const view = renderSender(submit);
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(submit).toHaveBeenCalled());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('queues a View toast when a handoff opens another thread', async () => {
    const user = userEvent.setup();
    const cases: Array<{ outcome: string; message: string; path: string }> = [
      {
        outcome: 'task-handoff',
        message: 'Sent to a task',
        path: `/tasks/${WORKSPACE}/${OTHER}`,
      },
      {
        outcome: 'goal-handoff',
        message: 'Sent to a goal',
        path: `/goals/${WORKSPACE}/${OTHER}`,
      },
    ];
    for (const handoff of cases) {
      toastQueue.clear();
      const submit = vi.fn().mockResolvedValue({
        outcome: handoff.outcome,
        receivingWorkspaceId: WORKSPACE,
        receivingThreadId: OTHER,
      });
      const view = renderSender(submit);
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const action = await screen.findByRole('button', { name: 'View' });
      expect(action).toHaveClass('min-h-11', 'min-w-11');
      expect(screen.getByRole('alertdialog')).toHaveAccessibleName(handoff.message);
      await user.click(action);
      expect(await screen.findByText(handoff.path)).toBeInTheDocument();
      view.unmount();
    }
  });
});
