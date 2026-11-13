import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaces } from '../chat/data';
import { useWorkspaceStore } from '../workspace-store';
import { AccountBoundary } from './SignInScreen';
import { useAccountAdmission, useAccountMutation } from './session';

function collection(name: string) {
  return {
    items: [
      {
        isOwner: true,
        membershipRevision: 1,
        membershipStatus: 'active' as const,
        accessCause: 'membership' as const,
        ownerUserId: 'usr_00000000-0000-7108-840f-833c46c69722',
        registryRevision: 1,
        workspace: {
          counts: { artifactCount: 0, knowledgeEntryCount: 0, threadCount: 0 },
          createdAt: '2026-08-04T00:00:00.000Z',
          id:
            name === 'First account'
              ? 'ws_00000000-0000-7b10-9af8-12fd37a880e0'
              : 'ws_00000000-0000-7ec6-8e33-a3b1d758efc6',
          kind: 'general' as const,
          name,
          status: 'active' as const,
          updatedAt: '2026-08-04T00:00:00.000Z',
        },
      },
    ],
  };
}

function WorkspaceProbe() {
  const workspaces = useWorkspaces();
  return (
    <section aria-label="Admitted workspaces">
      {workspaces.isSuccess && !workspaces.isFetching ? (
        <output aria-label="Settled workspaces">
          {workspaces.data.map((workspace) => workspace.name).join(', ')}
        </output>
      ) : null}
    </section>
  );
}

function TransitionProbe() {
  const mutation = useAccountMutation();
  useAccountAdmission({ enabled: false });
  return (
    <>
      <button
        type="button"
        onClick={() =>
          mutation.mutate({
            operation: 'signOut',
            email: '',
            name: '',
            password: '',
          })
        }
      >
        Switch account
      </button>
      <output aria-label="Transition state">{mutation.status}</output>
    </>
  );
}

const queryClients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
});

function mount(list: ReturnType<typeof vi.fn>, signOut = vi.fn().mockResolvedValue(undefined)) {
  const client = {
    auth: { email: { signOut } },
    operations: { 'workspace.list': list },
  } as unknown as CoreClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <TransitionProbe />
          <AccountBoundary>
            <WorkspaceProbe />
          </AccountBoundary>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return queryClient;
}

async function settle(queryClient: QueryClient) {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(queryClient.isFetching()).toBe(0);
}

describe('workspace discovery at account admission', () => {
  it('lists exactly once on a settled cold open', async () => {
    const list = vi.fn().mockResolvedValue(collection('First account'));
    const queryClient = mount(list);
    await screen.findByText('First account', { selector: 'output' });
    await settle(queryClient);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('lists exactly once again for the next account after the production reset', async () => {
    let current = collection('First account');
    const list = vi.fn().mockImplementation(async () => current);
    const signOut = vi.fn().mockImplementation(async () => {
      current = collection('Second account');
    });
    const queryClient = mount(list, signOut);
    await screen.findByText('First account', { selector: 'output' });
    await settle(queryClient);
    const beforeSwitch = list.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Transition state')).toHaveTextContent('success');
    });
    await screen.findByText('Second account', { selector: 'output' });
    await settle(queryClient);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('First account', { selector: 'output' })).toBeNull();
    expect(list.mock.calls.length - beforeSwitch).toBe(1);
  });

  it('does not admit children or retry discovery after a protected read refusal', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(403, 'Workspace access refused.'))
      .mockResolvedValue(collection('First account'));
    const queryClient = mount(list);
    await screen.findByText("Couldn't check account access.");
    await settle(queryClient);
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Admitted workspaces' })).toBeNull();
    expect(screen.queryByLabelText('Settled workspaces')).toBeNull();
  });
});
