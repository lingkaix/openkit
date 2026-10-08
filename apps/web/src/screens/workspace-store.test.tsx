import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../app/core-client';
import { chatKeys, useCurrentWorkspaceId } from './chat/data';
import { useWorkspaceStore, WORKSPACE_SELECTION_STORAGE_KEY } from './workspace-store';

const USER_A_QUICK_CHAT = {
  id: 'ws_quick_a',
  name: 'Quick Chat',
  kind: 'quick-chat',
} as const;
const USER_B_QUICK_CHAT = {
  id: 'ws_quick_b',
  name: 'Quick Chat',
  kind: 'quick-chat',
} as const;
const PROJECT_WORKSPACE = {
  id: 'ws_project',
  name: 'Project Workspace',
  kind: 'general',
} as const;
const OTHER_WORKSPACE = {
  id: 'ws_other',
  name: 'Other Workspace',
  kind: 'general',
} as const;

/** Reads the resolved switcher Workspace from the live hook. */
function CurrentWorkspaceProbe({ preferred }: { preferred?: string } = {}) {
  const workspaceId = useCurrentWorkspaceId(preferred);
  const storedId = useWorkspaceStore((state) => state.currentWorkspaceId);
  return (
    <>
      <output aria-label="Current workspace">{workspaceId ?? ''}</output>
      <output aria-label="Stored workspace">{storedId ?? ''}</output>
    </>
  );
}

function renderCurrentWorkspace(
  items: Array<{ id: string; name: string; kind: string }>,
  preferred?: string
) {
  const client = {
    core: {},

    operations: {
      'workspace.list': async () => ({
        items: items.map((workspace) => ({
          workspace,
          effectiveRole: 'owner',
          membershipRevision: 1,
          ownerUserId: 'user_local',
          registryRevision: 1,
        })),
      }),
    },
  } as unknown as CoreClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <CurrentWorkspaceProbe preferred={preferred} />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

/** Simulates a hard reload from the current persisted switcher record. */
async function rehydratePersistedSelection() {
  const snapshot = localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY);
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
  if (snapshot) localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, snapshot);
  await useWorkspaceStore.persist.rehydrate();
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

describe('workspace switcher persistence', () => {
  it('does not repopulate ownership discovery from a cancelled account read', async () => {
    let finishDiscovery!: (value: unknown) => void;
    const listWorkspaces = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        finishDiscovery = resolve;
      })
    );
    const client = {
      operations: { 'workspace.list': listWorkspaces },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <CurrentWorkspaceProbe />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(1));
    await act(async () => {
      await queryClient.cancelQueries({ queryKey: chatKeys.workspaces });
      queryClient.removeQueries({ queryKey: chatKeys.workspaceSummaries, exact: true });
      finishDiscovery({
        items: [{ workspace: USER_A_QUICK_CHAT, ownerUserId: 'user_a', effectiveRole: 'owner' }],
      });
    });
    expect(queryClient.getQueryData(chatKeys.workspaceSummaries)).toBeUndefined();
    expect(useWorkspaceStore.getState().selectionUserKey).toBeNull();
  });

  it('restores an explicit authorized selection after hard reload', async () => {
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    expect(localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY)).toContain(PROJECT_WORKSPACE.id);

    await rehydratePersistedSelection();
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(PROJECT_WORKSPACE.id);
    expect(useWorkspaceStore.getState().selectionUserKey).toBe(USER_A_QUICK_CHAT.id);

    renderCurrentWorkspace([PROJECT_WORKSPACE, USER_A_QUICK_CHAT]);
    await waitFor(() => {
      expect(screen.getByLabelText('Current workspace')).toHaveTextContent(PROJECT_WORKSPACE.id);
    });
  });

  it('falls back to Quick Chat when a persisted selection is unauthorized', async () => {
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    await rehydratePersistedSelection();

    renderCurrentWorkspace([OTHER_WORKSPACE, USER_A_QUICK_CHAT]);
    await waitFor(() => {
      expect(screen.getByLabelText('Current workspace')).toHaveTextContent(USER_A_QUICK_CHAT.id);
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().currentWorkspaceId).toBeNull();
    });
  });

  it('does not inherit a previous identity selection for a different signed-in user', async () => {
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    await rehydratePersistedSelection();

    renderCurrentWorkspace([PROJECT_WORKSPACE, USER_B_QUICK_CHAT]);
    await waitFor(() => {
      expect(screen.getByLabelText('Current workspace')).toHaveTextContent(USER_B_QUICK_CHAT.id);
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().currentWorkspaceId).toBeNull();
      expect(useWorkspaceStore.getState().selectionUserKey).toBe(USER_B_QUICK_CHAT.id);
    });
  });

  it('re-syncs a still-authorized route Workspace after a same-route identity change', async () => {
    let items: Array<{ id: string; name: string; kind: string }> = [
      PROJECT_WORKSPACE,
      USER_A_QUICK_CHAT,
    ];
    const client = {
      core: {},

      operations: {
        'workspace.list': async () => ({
          items: items.map((workspace) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'user_local',
            registryRevision: 1,
          })),
        }),
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <CurrentWorkspaceProbe preferred={PROJECT_WORKSPACE.id} />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Current workspace')).toHaveTextContent(PROJECT_WORKSPACE.id);
      expect(screen.getByLabelText('Stored workspace')).toHaveTextContent(PROJECT_WORKSPACE.id);
    });

    items = [PROJECT_WORKSPACE, USER_B_QUICK_CHAT];
    await queryClient.invalidateQueries({ exact: true, queryKey: chatKeys.workspaces });
    await waitFor(() => {
      expect(screen.getByLabelText('Current workspace')).toHaveTextContent(PROJECT_WORKSPACE.id);
      expect(screen.getByLabelText('Stored workspace')).toHaveTextContent(PROJECT_WORKSPACE.id);
      expect(useWorkspaceStore.getState().selectionUserKey).toBe(USER_B_QUICK_CHAT.id);
    });
  });

  it('defaults to the signed-in Quick Chat when administrator eligibility lists other owners', async () => {
    let resolveSession!: (session: { user: { id: string } }) => void;
    const session = new Promise<{ user: { id: string } }>((resolve) => {
      resolveSession = resolve;
    });
    const getSession = vi.fn().mockReturnValue(session);
    const client = {
      core: {},
      auth: {
        email: {
          getSession,
        },
      },
      operations: {
        'workspace.list': async () => ({
          items: [
            {
              workspace: USER_A_QUICK_CHAT,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_a',
              registryRevision: 1,
            },
            {
              workspace: USER_B_QUICK_CHAT,
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_b',
              registryRevision: 1,
            },
          ],
        }),
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <CurrentWorkspaceProbe />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Current workspace')).toBeEmptyDOMElement();
    expect(useWorkspaceStore.getState().selectionUserKey).toBeNull();
    await act(async () => resolveSession({ user: { id: 'user_b' } }));
    await waitFor(() => {
      expect(screen.getByLabelText('Current workspace')).toHaveTextContent(USER_B_QUICK_CHAT.id);
    });
    expect(useWorkspaceStore.getState().selectionUserKey).toBe(USER_B_QUICK_CHAT.id);
  });

  it.each([
    'resolved',
    'failed',
  ] as const)('does not restore another identity selection while ambiguous session discovery is pending or %s', async (outcome) => {
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(USER_A_QUICK_CHAT.id);
    await rehydratePersistedSelection();

    let resolveSession!: (session: { user: { id: string } }) => void;
    let rejectSession!: (error: Error) => void;
    const getSession = vi.fn().mockReturnValue(
      new Promise<{ user: { id: string } }>((resolve, reject) => {
        resolveSession = resolve;
        rejectSession = reject;
      })
    );
    const client = {
      auth: { email: { getSession } },
      operations: {
        'workspace.list': async () => ({
          items: [USER_A_QUICK_CHAT, USER_B_QUICK_CHAT].map((workspace, index) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: index === 0 ? 'user_a' : 'user_b',
            registryRevision: 1,
          })),
        }),
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <CurrentWorkspaceProbe />
        </CoreClientProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryState(chatKeys.workspaces)?.status).toBe('success');
    expect(queryClient.getQueryState(chatKeys.sessionUser)?.status).toBe('pending');
    expect(screen.getByLabelText('Current workspace')).toBeEmptyDOMElement();

    await act(async () => {
      if (outcome === 'resolved') resolveSession({ user: { id: 'user_b' } });
      else rejectSession(new Error('Session discovery failed.'));
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(chatKeys.sessionUser)?.status).toBe(
        outcome === 'resolved' ? 'success' : 'error'
      );
      if (outcome === 'resolved') {
        expect(screen.getByLabelText('Current workspace')).toHaveTextContent(USER_B_QUICK_CHAT.id);
        expect(useWorkspaceStore.getState().currentWorkspaceId).toBeNull();
      } else {
        expect(screen.getByLabelText('Current workspace')).toBeEmptyDOMElement();
      }
    });
  });

  it('keeps the Quick Chat default when no explicit selection is persisted', async () => {
    renderCurrentWorkspace([PROJECT_WORKSPACE, USER_A_QUICK_CHAT]);
    await waitFor(() => {
      expect(screen.getByLabelText('Current workspace')).toHaveTextContent(USER_A_QUICK_CHAT.id);
    });
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBeNull();
  });

  it('clears persisted selection on logout', async () => {
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(null);
    await rehydratePersistedSelection();
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBeNull();
    expect(useWorkspaceStore.getState().selectionUserKey).toBeNull();
  });
});
