import type { ConversationNavigationResponse } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatKeys,
  useArchiveThread,
  useRenameThread,
  useRestoreThread,
  useSendTurn,
} from '../screens/chat/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { CoreClientProvider } from './core-client';
import { Sidebar } from './Sidebar';

/** Exposes navigation as rendered state without substituting router behavior. */
function Location() {
  const location = useLocation();
  return <output aria-label="Location">{`${location.pathname}${location.search}`}</output>;
}

/** Keeps Assistant entry tests on the production Sidebar and current selected-Workspace admission. */
function renderAssistantNavigation(createThread: CoreClient['operations']['thread.create']) {
  const projectId = 'ws_019a0000-0000-7000-8000-000000000101';
  useWorkspaceStore.setState({ currentWorkspaceId: projectId });
  const client = {
    core: {},
    operations: {
      'workspace.list': async () => ({
        items: [
          { id: projectId, name: 'Project alpha', kind: 'general' },
          {
            id: 'ws_019a0000-0000-7000-8000-000000000102',
            name: 'Personal notes',
            kind: 'quick-chat',
          },
        ].map((workspace) => ({
          workspace,
          membershipStatus: 'active',
          accessCause: 'membership',
          effectiveRole: 'owner',
          ownerUserId: 'usr_019a0000-0000-7000-8000-000000000104',
          membershipRevision: 1,
          registryRevision: 1,
        })),
      }),
      'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),
      'thread.create': createThread,
      'thread.update': vi.fn(),
      'conversation.submit': vi.fn(),
      'turn.start': vi.fn(),
    },
  } as unknown as CoreClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <Sidebar />
          <Location />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { client, queryClient };
}

/** Uses the real submission hook so pending progress is scoped to the originating conversation. */
function Submit() {
  const send = useSendTurn();
  return (
    <button
      type="button"
      onClick={() =>
        send.mutate({
          workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
          threadId: 'th_00000000-0000-7c00-b9fc-382312fdf476',
          draft: {
            requestId: 'nav-request',
            input: 'Hello',
            targetRef: 'internal-role:assistant',
            artifactRefs: [],
          },
        })
      }
    >
      Send pending request
    </button>
  );
}

/** Drives lifecycle mutations against the rendered navigation projection. */
function Lifecycle() {
  const rename = useRenameThread();
  const archive = useArchiveThread();
  const restore = useRestoreThread();
  const owner = {
    workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
    threadId: 'th_00000000-0000-7c00-b9fc-382312fdf476',
  };
  return (
    <>
      <button
        type="button"
        onClick={() => rename.mutate({ ...owner, name: 'Updated conversation' })}
      >
        Rename conversation
      </button>
      <button type="button" onClick={() => archive.mutate(owner)}>
        Archive conversation
      </button>
      <button type="button" onClick={() => restore.mutate(owner)}>
        Restore conversation
      </button>
    </>
  );
}

beforeEach(() => useWorkspaceStore.setState({ currentWorkspaceId: null }));

describe('conversation navigation sidebar', () => {
  it('opens the returned Assistant history without a message and retries the same request before reaching Members', async () => {
    const user = userEvent.setup();
    const thread = {
      id: 'th_019a0000-0000-7000-8000-000000000103',
      workspaceId: 'ws_019a0000-0000-7000-8000-000000000101',
      name: 'Retained Assistant name',
      preview: 'Retained history',
      status: 'archived',
      visibility: 'private',
      privateOwnerUserId: 'usr_019a0000-0000-7000-8000-000000000104',
      entryPath: 'conversation',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    } as const;
    let rejectOpening!: (reason: Error) => void;
    const pending = new Promise<typeof thread>((_, reject) => {
      rejectOpening = reject;
    });
    const create = vi
      .fn<CoreClient['operations']['thread.create']>()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(thread);
    const { client, queryClient } = renderAssistantNavigation(create);
    const assistant = await screen.findByRole('button', { name: 'Assistant' });
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Members' })).toBeVisible();
    await user.click(assistant);
    expect(await screen.findByText('Opening Assistant…')).toBeVisible();
    expect(assistant).toBeDisabled();
    await act(async () => rejectOpening(new Error('private-opening-error')));
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent("Couldn't open Assistant.");
    expect(error).not.toHaveTextContent('private-opening-error');
    expect(assistant).toBeDisabled();
    await user.click(within(error).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/chat/${thread.workspaceId}/${thread.id}`
      )
    );
    expect(create).toHaveBeenCalledTimes(2);
    const first = create.mock.calls[0]![0];
    expect(first).toEqual({
      workspaceId: thread.workspaceId,
      name: 'Assistant',
      requestId: expect.any(String),
    });
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.mock.calls[1]![0]).toEqual(first);
    expect(thread).toMatchObject({ status: 'archived', name: 'Retained Assistant name' });
    expect(client.operations['conversation.submit']).not.toHaveBeenCalled();
    expect(client.operations['turn.start']).not.toHaveBeenCalled();
    expect(client.operations['thread.update']).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Members' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/account');
    queryClient.clear();
  });

  it('drops a departed Workspace opening result and omits Members for the personal Workspace', async () => {
    const user = userEvent.setup();
    let finishOpening!: (
      thread: Awaited<ReturnType<CoreClient['operations']['thread.create']>>
    ) => void;
    const pending = new Promise<Awaited<ReturnType<CoreClient['operations']['thread.create']>>>(
      (resolve) => {
        finishOpening = resolve;
      }
    );
    const create = vi.fn<CoreClient['operations']['thread.create']>().mockReturnValueOnce(pending);
    const { queryClient } = renderAssistantNavigation(create);
    await user.click(await screen.findByRole('button', { name: 'Assistant' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Project alpha' }));
    await user.click(screen.getByRole('menuitem', { name: 'Personal notes' }));
    expect(screen.queryByRole('button', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assistant' })).toBeEnabled();
    await act(async () => {
      finishOpening({
        id: 'th_019a0000-0000-7000-8000-000000000103',
        workspaceId: 'ws_019a0000-0000-7000-8000-000000000101',
        name: 'Assistant',
        preview: 'History',
        status: 'active',
        visibility: 'private',
        privateOwnerUserId: 'usr_019a0000-0000-7000-8000-000000000104',
        entryPath: 'conversation',
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
      });
      await pending;
    });
    await waitFor(() =>
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success')
    );
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(
      'ws_019a0000-0000-7000-8000-000000000102'
    );
    expect(screen.getByLabelText('Location').textContent).toBe('/');
    queryClient.clear();
  });

  it('preserves authoritative order, describes activity and state, and reaches the matching work surface', async () => {
    const kinds = ['goal', 'task', 'chat', 'unknown'] as const;
    const threadIds = [
      'th_00000000-0000-70ad-bcb6-3098e81b33d6',
      'th_00000000-0000-70a0-9cde-4561f64881c6',
      'th_00000000-0000-7c00-b9fc-382312fdf476',
      'th_00000000-0000-7b52-ab1a-ac5e81206bc1',
    ];
    const rows: ConversationNavigationResponse['items'] = kinds.map((activity, index) => ({
      thread: {
        id: threadIds[index]!,
        workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
        name: `Conversation ${index}`,
        preview: '',
        status: 'active',
        entryPath: 'conversation',
        visibility: 'workspace',
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      },
      activity,
      state: index === 0 ? 'needs-you' : index === 1 ? 'working' : 'idle',
      lastActivityAt: '2026-09-16T00:00:00.000Z',
      unreadCount: index === 2 ? 2 : 0,
    }));
    const list = vi.fn().mockImplementation(async () => ({
      items: structuredClone(rows.filter((row) => row.thread.status === 'active')),
    }));
    let finishRequest!: (value: {
      receivingWorkspaceId: string;
      receivingThreadId: string;
    }) => void;
    const submitConversation = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRequest = resolve;
        })
    );
    const client = {
      core: {},
      app: {},

      operations: {
        'thread.update': async (input: { name?: string; status?: 'active' }) => {
          rows[2]!.thread = {
            ...rows[2]!.thread,
            ...(input.name ? { name: input.name } : {}),
            ...(input.status ? { status: input.status } : {}),
          };
          return rows[2]!.thread;
        },
        'thread.archive': async () => {
          rows[2]!.thread = { ...rows[2]!.thread, status: 'archived' };
          return rows[2]!.thread;
        },
        'conversation.submit': submitConversation,

        'conversation.navigation': list,

        'workspace.list': async () => ({
          items: [
            { id: 'ws_00000000-0000-7b10-9af8-12fd37a880e0', name: 'Workspace', kind: 'general' },
          ].map((workspace) => ({
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          })),
        }),
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter>
            <Sidebar />
            <Submit />
            <Lifecycle />
            <Location />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    const buttons = await screen.findAllByRole('button', { name: /^Conversation \d$/ });
    expect(buttons.map((button) => button.querySelector('.truncate')?.textContent)).toEqual(
      rows.map((row) => row.thread.name)
    );
    expect(buttons[0]).toHaveAccessibleDescription('Goal · Needs your attention');
    expect(buttons[1]).toHaveAccessibleDescription('Worker task · Working');
    expect(buttons[2]).toHaveAccessibleDescription('Assistant chat · Idle · 2 unread replies');
    expect(within(buttons[2]!).getByText('2')).toBeVisible();
    expect(buttons[3]).toHaveAccessibleDescription('Activity type unknown · Idle');
    const user = userEvent.setup();
    await user.click(buttons[0]!);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/goals/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-70ad-bcb6-3098e81b33d6'
    );
    expect(buttons[0]).toHaveAttribute('aria-current', 'page');
    await user.click(buttons[1]!);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/tasks/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-70a0-9cde-4561f64881c6'
    );
    await user.click(buttons[2]!);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/chat/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-7c00-b9fc-382312fdf476'
    );
    await user.click(buttons[3]!);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/chat/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-7b52-ab1a-ac5e81206bc1'
    );
    expect(buttons[3]).toHaveAttribute('aria-current', 'page');

    list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.threads('ws_00000000-0000-7b10-9af8-12fd37a880e0'),
      });
    });
    expect(await screen.findByText(/Conversation status unavailable/)).toBeInTheDocument();
    expect(buttons[1]).toHaveAccessibleDescription('Worker task · Status unavailable');
    expect(within(buttons[2]!).queryByText('2')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry conversations' }));
    await waitFor(() => expect(buttons[1]).toHaveAccessibleDescription('Worker task · Working'));
    await user.click(screen.getByRole('button', { name: 'Send pending request' }));
    await waitFor(() =>
      expect(buttons[2]).toHaveAccessibleDescription(
        'Assistant chat · Waiting for response · 2 unread replies'
      )
    );
    expect(screen.getAllByRole('button', { name: /^Conversation \d$/ })[0]).toBe(buttons[2]);
    await act(async () => {
      finishRequest({
        receivingWorkspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
        receivingThreadId: 'th_00000000-0000-7c00-b9fc-382312fdf476',
      });
    });
    await waitFor(() =>
      expect(buttons[2]).toHaveAccessibleDescription('Assistant chat · Idle · 2 unread replies')
    );
    await user.click(screen.getByRole('button', { name: 'Rename conversation' }));
    expect(await screen.findByRole('button', { name: 'Updated conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive conversation' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Updated conversation' })).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: 'Restore conversation' }));
    expect(await screen.findByRole('button', { name: 'Updated conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/account');
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Workspace settings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/workspace');
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/account');
    expect(screen.getByRole('button', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
    queryClient.clear();
  });

  it.each([
    ['/chat/ws%2F1/th%3F%23%25', 'goal', true, '/goals/ws%2F1/th%3F%23%25'],
    ['/tasks/ws%2F1/th%3F%23%25', 'goal', true, '/goals/ws%2F1/th%3F%23%25'],
    ['/goals/ws%2F1/th%3F%23%25/artifacts/a', 'task', true, '/tasks/ws%2F1/th%3F%23%25'],
    ['/goals/ws%2F1/th%3F%23%25-extra', 'task', false, '/tasks/ws%2F1/th%3F%23%25'],
    ['/chat/other/th%3F%23%25', 'goal', false, '/goals/ws%2F1/th%3F%23%25'],
  ] as const)('matches encoded Thread identity across modes at %s independently of the %s destination', async (path, activity, active, destination) => {
    const user = userEvent.setup();
    const client = {
      core: {},
      app: {},

      operations: {
        'conversation.navigation': async () => ({
          items: [
            {
              thread: { id: 'th?#%', workspaceId: 'ws/1', name: 'Encoded conversation' },
              activity,
              state: 'idle',
            },
          ],
        }),

        'workspace.list': async () => ({
          items: [{ id: 'ws/1', name: 'Encoded workspace', kind: 'general' }].map((workspace) => ({
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          })),
        }),
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <Sidebar />
            <Location />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    const conversation = await screen.findByRole('button', { name: 'Encoded conversation' });
    if (active) expect(conversation).toHaveAttribute('aria-current', 'page');
    else expect(conversation).not.toHaveAttribute('aria-current');
    await user.click(conversation);
    expect(screen.getByLabelText('Location').textContent).toBe(destination);
    expect(conversation).toHaveAttribute('aria-current', 'page');
    queryClient.clear();
  });

  it('clears Artifacts identity query when switching Workspace and keeps the new selection', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0' });
    const client = {
      core: {},
      app: {},

      operations: {
        'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),

        'workspace.list': async () => ({
          items: [
            {
              id: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
              name: 'Market research',
              kind: 'general',
            },
            {
              id: 'ws_00000000-0000-7ec6-8e33-a3b1d758efc6',
              name: 'Ops workspace',
              kind: 'general',
            },
          ].map((workspace) => ({
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          })),
        }),
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter
            initialEntries={[
              '/artifacts?workspaceId=ws_00000000-0000-7b10-9af8-12fd37a880e0&artifact=ar_00000000-0000-70ff-a91b-5bec57f685d9',
            ]}
          >
            <Sidebar />
            <Location />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByRole('button', { name: 'Market research' })).toBeInTheDocument();
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/artifacts?workspaceId=ws_00000000-0000-7b10-9af8-12fd37a880e0&artifact=ar_00000000-0000-70ff-a91b-5bec57f685d9'
    );
    await user.click(screen.getByRole('button', { name: 'Market research' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ops workspace' }));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(
      'ws_00000000-0000-7ec6-8e33-a3b1d758efc6'
    );
    expect(screen.getByLabelText('Location')).toHaveTextContent('/artifacts');
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('workspaceId');
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('artifact=');
    expect(screen.getByRole('button', { name: 'Ops workspace' })).toBeInTheDocument();
    queryClient.clear();
  });

  it('omits workspaces the signed-in user does not belong to and keeps a shared membership', async () => {
    const user = userEvent.setup();
    const client = {
      core: {},
      app: {},
      auth: {
        email: {
          getSession: async () => ({ user: { id: 'usr_00000000-0000-768a-8658-44c33d82c1f5' } }),
        },
      },
      operations: {
        'conversation.navigation': async () => ({ items: [] }),
        'workspace.list': async () => ({
          items: [
            {
              membershipStatus: 'active' as const,
              accessCause: 'membership' as const,
              workspace: {
                id: 'ws_00000000-0000-70b3-a3ac-118462639d82',
                name: 'My notes',
                kind: 'general',
              },
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
              registryRevision: 1,
            },
            {
              membershipStatus: 'active' as const,
              accessCause: 'membership' as const,
              workspace: {
                id: 'ws_00000000-0000-706d-b903-72e27d4276af',
                name: 'My quick chat',
                kind: 'quick-chat',
              },
              effectiveRole: 'owner',
              membershipRevision: 2,
              ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
              registryRevision: 1,
            },
            {
              membershipStatus: null,
              accessCause: 'administrator' as const,
              workspace: {
                id: 'ws_00000000-0000-7934-b833-fdbc51d3c0a2',
                name: 'Someone else',
                kind: 'quick-chat',
              },
              effectiveRole: null,
              membershipRevision: null,
              ownerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
              registryRevision: 1,
            },
            {
              membershipStatus: 'active' as const,
              accessCause: 'membership' as const,
              workspace: {
                id: 'ws_00000000-0000-7f6f-8712-e3b3efe0bcb4',
                name: 'Read together',
                kind: 'general',
              },
              effectiveRole: 'viewer',
              membershipRevision: 1,
              ownerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
              registryRevision: 1,
            },
            {
              membershipStatus: 'active' as const,
              accessCause: 'membership' as const,
              workspace: {
                id: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
                name: 'Shared notes',
                kind: 'general',
              },
              effectiveRole: 'editor',
              membershipRevision: 3,
              ownerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
              registryRevision: 1,
            },
          ],
        }),
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter>
            <Sidebar />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByRole('button', { name: 'My quick chat' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'My quick chat' }));
    expect(screen.getByRole('menuitem', { name: 'My notes' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'My quick chat' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Shared notes' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Read together' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Someone else' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    act(() =>
      useWorkspaceStore.getState().setCurrentWorkspaceId('ws_00000000-0000-7934-b833-fdbc51d3c0a2')
    );
    expect(screen.getByRole('button', { name: 'Someone else' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Someone else' }));
    expect(screen.queryByRole('menuitem', { name: 'Someone else' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'My quick chat' })).toBeInTheDocument();
    queryClient.clear();
  });
});
