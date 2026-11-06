import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { ToastProvider, toastQueue } from '../../primitives';
import { useSendTurn } from './data';

const WORKSPACE = 'ws_00000000-0000-7000-8000-000000000001';
const THREAD = 'th_00000000-0000-7000-8000-000000000001';

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

describe('admission toast', () => {
  afterEach(() => {
    toastQueue.clear();
  });

  it('queues a toast with a View action after a message is admitted', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({
      outcome: 'answered',
      receivingWorkspaceId: WORKSPACE,
      receivingThreadId: THREAD,
    });
    const client = {
      operations: { 'conversation.submit': submit },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter>
            <ToastProvider />
            <Routes>
              <Route path="/" element={<Sender />} />
              <Route path="/chat/:workspaceId/:threadId" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Send' }));
    const action = await screen.findByRole('button', { name: 'View' });
    expect(action).toHaveClass('min-h-11', 'min-w-11');
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Message sent');
    await user.click(action);
    expect(await screen.findByText(`/chat/${WORKSPACE}/${THREAD}`)).toBeInTheDocument();
  });
});
