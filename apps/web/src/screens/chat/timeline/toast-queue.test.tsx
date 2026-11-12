import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ToastProvider, toastQueue } from '../../../primitives';
import { useWorkspaceStore } from '../../workspace-store';
import { chatKeys } from '../data';
import { TimelineToasts } from './TimelineToasts';
import { resetToastPolicy } from './toast-policy';

const WORKSPACE = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';
const THREAD = 'th_00000000-0000-70a0-9cde-4561f64881c6';

const ROW = {
  id: 'approval:ap_1',
  kind: 'approval',
  blocking: true,
  workspaceId: WORKSPACE,
  threadId: THREAD,
  turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
  title: 'Review the draft',
  ageSeconds: 5,
  createdAt: '2026-11-08T10:00:00.000Z',
  actions: [{ kind: 'grant_approval' }],
  source: {
    type: 'approval',
    approvalRequestId: 'ap_1',
    workspaceId: WORKSPACE,
    threadId: THREAD,
    turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
  },
};

function admission(workspace: { id: string; name: string; kind: 'code' }) {
  return {
    membershipStatus: 'active' as const,
    accessCause: 'membership' as const,
    workspace,
    isOwner: true,
    membershipRevision: 1,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    registryRevision: 1,
  };
}

function ToastHarness({
  client,
  queryClient,
  children,
}: {
  client: CoreClient;
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/artifacts']}>
          <ToastProvider />
          {children}
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  act(() => {
    resetToastPolicy();
    toastQueue.clear();
  });
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

describe('timeline toast queue', () => {
  it('closes a shown toast when that thread navigation becomes denied', async () => {
    // The first successful read is only a baseline. The toast is the next row.
    let rows: (typeof ROW)[] = [];
    let denied = false;
    const client = {
      core: { meta: async () => ({}) },
      operations: {
        'workspace.list': async () => ({
          items: [admission({ id: WORKSPACE, name: 'Market research', kind: 'code' })],
        }),
        'attention.list': async () => ({ items: rows.map((row) => ({ ...row })) }),
        'conversation.navigation': async () => {
          if (denied) throw new ApiCallError(403, 'denied');
          return {
            items: [
              {
                activity: 'chat',
                thread: { id: THREAD, name: 'Launch notes' },
              },
            ],
          };
        },
      },
    } as unknown as CoreClient;
    document.hasFocus = () => true;
    useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE, selectionUserKey: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ToastHarness client={client} queryClient={queryClient}>
        <TimelineToasts />
      </ToastHarness>
    );
    await waitFor(() => {
      expect(queryClient.getQueryState(['attention', WORKSPACE])?.status).toBe('success');
    });
    expect(screen.queryByText(/Review the draft/)).not.toBeInTheDocument();
    rows = [ROW];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['attention', WORKSPACE] });
    });
    expect((await screen.findAllByText(/Review the draft · Launch notes/)).length).toBeGreaterThan(
      0
    );
    denied = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.navigation(WORKSPACE) });
    });
    await waitFor(() =>
      expect(screen.queryAllByText(/Review the draft · Launch notes/)).toHaveLength(0)
    );
  });
});
