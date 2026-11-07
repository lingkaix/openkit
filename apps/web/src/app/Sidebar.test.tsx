import type { ConversationNavigationResponse } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { workspaceIdForOwner } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    threadId: 'th_00000000-0000-70a0-9cde-4561f64881c6',
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
  it('opens the returned Assistant history without a message and retries the same request before reaching Settings', async () => {
    const user = userEvent.setup();
    const thread = {
      id: 'th_019a0000-0000-7000-8000-000000000103',
      owner: { kind: 'workspace', workspaceId: 'ws_019a0000-0000-7000-8000-000000000101' },
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
    const assistant = await screen.findByRole('button', { name: 'Personal Assistant' });
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible();
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
        `/chat/${workspaceIdForOwner(thread.owner)}/${thread.id}`
      )
    );
    expect(create).toHaveBeenCalledTimes(2);
    const first = create.mock.calls[0]![0];
    expect(first).toEqual({
      workspaceId: workspaceIdForOwner(thread.owner),
      name: 'Assistant',
      requestId: expect.any(String),
    });
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.mock.calls[1]![0]).toEqual(first);
    expect(thread).toMatchObject({ status: 'archived', name: 'Retained Assistant name' });
    expect(client.operations['conversation.submit']).not.toHaveBeenCalled();
    expect(client.operations['turn.start']).not.toHaveBeenCalled();
    expect(client.operations['thread.update']).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/account');
    queryClient.clear();
  });

  it('drops a departed Workspace opening result and omits the Members shortcut for the personal Workspace', async () => {
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
    await user.click(await screen.findByRole('button', { name: 'Personal Assistant' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Project alpha' }));
    await user.click(screen.getByRole('menuitem', { name: 'Personal notes' }));
    expect(screen.queryByRole('button', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Personal Assistant' })).toBeEnabled();
    await act(async () => {
      finishOpening({
        id: 'th_019a0000-0000-7000-8000-000000000103',
        owner: { kind: 'workspace', workspaceId: 'ws_019a0000-0000-7000-8000-000000000101' },
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

  it('groups Goal, Task, Personal Assistant, and unknown rows while reaching the matching work surface', async () => {
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
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0' },
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
        'thread.update': async (input: { threadId: string; name?: string; status?: 'active' }) => {
          const target = rows.find((row) => row.thread.id === input.threadId);
          if (!target) throw new Error('unknown thread');
          target.thread = {
            ...target.thread,
            ...(input.name ? { name: input.name } : {}),
            ...(input.status ? { status: input.status } : {}),
          };
          return target.thread;
        },
        'thread.archive': async (input: { threadId: string }) => {
          const target = rows.find((row) => row.thread.id === input.threadId);
          if (!target) throw new Error('unknown thread');
          target.thread = { ...target.thread, status: 'archived' };
          return target.thread;
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
            isOwner: true,
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
    const navigation = await screen.findByRole('navigation', {
      name: 'Primary workspace navigation',
    });
    const goalRow = await within(navigation).findByRole('button', { name: 'Conversation 0' });
    const taskRow = within(navigation).getByRole('button', { name: 'Conversation 1' });
    const assistantRow = within(navigation).getByRole('button', { name: 'Personal Assistant' });
    const unknownRow = within(navigation).getByRole('button', { name: 'Conversation 3' });
    expect(goalRow).toHaveAccessibleDescription('Goal · Needs you');
    expect(taskRow).toHaveAccessibleDescription('Task · Working');
    expect(assistantRow).toHaveAccessibleDescription(/Idle · 2 unread replies/);
    expect(assistantRow).not.toHaveAccessibleDescription(/Assistant chat/);
    expect(within(assistantRow).getByText('2')).toBeVisible();
    expect(unknownRow).toHaveAccessibleDescription('Activity type unknown · Idle');
    expect(within(navigation).queryByText(/Assistant chat/)).not.toBeInTheDocument();
    expect(within(navigation).queryByText(/Worker task/)).not.toBeInTheDocument();
    const tasksLabel = within(navigation).getAllByText('Tasks', { exact: true })[0];
    const goalsLabel = within(navigation).getAllByText('Goals', { exact: true })[0];
    expect(tasksLabel).toBeTruthy();
    expect(goalsLabel).toBeTruthy();
    expect(
      tasksLabel!.compareDocumentPosition(taskRow) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      goalsLabel!.compareDocumentPosition(goalRow) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(goalRow);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/goals/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-70ad-bcb6-3098e81b33d6'
    );
    expect(goalRow).toHaveAttribute('aria-current', 'page');
    await user.click(taskRow);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/tasks/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-70a0-9cde-4561f64881c6'
    );
    await user.click(assistantRow);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/chat/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-7c00-b9fc-382312fdf476'
    );
    await user.click(unknownRow);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      '/chat/ws_00000000-0000-7b10-9af8-12fd37a880e0/th_00000000-0000-7b52-ab1a-ac5e81206bc1'
    );
    expect(unknownRow).toHaveAttribute('aria-current', 'page');

    list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.threads('ws_00000000-0000-7b10-9af8-12fd37a880e0'),
      });
    });
    expect(await screen.findByText(/Conversation status unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conversation 1' })).toHaveAccessibleDescription(
      'Task · Status unavailable'
    );
    expect(
      within(screen.getByRole('button', { name: 'Personal Assistant' })).queryByText('2')
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry conversations' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Conversation 1' })).toHaveAccessibleDescription(
        'Task · Working'
      )
    );
    await user.click(screen.getByRole('button', { name: 'Send pending request' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal Assistant' })
      ).toHaveAccessibleDescription(/Waiting for response/)
    );
    await act(async () => {
      finishRequest({
        receivingWorkspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
        receivingThreadId: 'th_00000000-0000-7c00-b9fc-382312fdf476',
      });
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal Assistant' })
      ).toHaveAccessibleDescription(/Idle · 2 unread replies/)
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
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/general');
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
            isOwner: true,
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
            isOwner: true,
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
              isOwner: true,
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
                kind: 'personal',
              },
              isOwner: true,
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
                kind: 'personal',
              },
              isOwner: false,
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
              isOwner: false,
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
              isOwner: false,
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

function register_ConversationGoalGroups_test_tsx_0() {
  const workspaceId = 'ws_019a0000-0000-7000-8000-000000000001';

  const coordinatorId = 'th_019a0000-0000-7000-8000-000000000002';

  const taskId = 'th_019a0000-0000-7000-8000-000000000003';

  const archivedId = 'th_019a0000-0000-7000-8000-000000000004';

  const unrelatedId = 'th_019a0000-0000-7000-8000-000000000005';

  describe('Goal navigation groups', () => {
    afterEach(() => useWorkspaceStore.setState({ currentWorkspaceId: null }));

    it('uses real card links, retains attempts and archived history, and hides cached child facts after a failed read', async () => {
      const at = '2026-10-16T00:00:00.000Z';
      const thread = (id: string, name: string, status: 'active' | 'archived' = 'active') => ({
        id,
        name,
        owner: { kind: 'workspace', workspaceId: workspaceId },
        preview: name,
        status,
        visibility: 'workspace',
        entryPath: 'conversation',
        createdAt: at,
        updatedAt: at,
      });
      const threads = [
        thread(coordinatorId, 'Goal work'),
        thread(taskId, 'Linked Task'),
        thread(archivedId, 'Archived Task', 'archived'),
        thread(unrelatedId, 'Independent work'),
      ];
      const listThreads = vi.fn(async () => ({ items: threads }));
      const goal = vi.fn(async () => ({
        goal: { goalId: 'goal-visible', threadId: coordinatorId, workspaceId },
        cards: [{ cardId: 'card-parser', description: 'Ship parser', revision: 2 }],
        versions: [],
        requests: [],
        tasks: [
          {
            goalId: 'goal-visible',
            cardId: 'card-parser',
            threadId: taskId,
            planVersionId: 'plan-approved',
            cardRevision: 1,
            missing: false,
            admittedAt: at,
            turns: [
              { turnId: 'first-attempt', status: 'completed', completedAt: at },
              { turnId: 'second-attempt', status: 'failed', completedAt: at },
            ],
          },
          {
            goalId: 'goal-visible',
            cardId: 'card-parser',
            threadId: archivedId,
            planVersionId: 'plan-approved',
            cardRevision: 1,
            missing: false,
            admittedAt: at,
            turns: [{ turnId: 'archived-attempt', status: 'cancelled', completedAt: at }],
          },
          {
            goalId: 'goal-visible',
            cardId: 'card-parser',
            threadId: 'th_019a0000-0000-7000-8000-000000000006',
            planVersionId: 'plan-approved',
            cardRevision: 1,
            missing: true,
            admittedAt: null,
            turns: [],
          },
        ],
      }));
      const markRead = vi.fn();
      const client = {
        core: {},
        app: {},
        operations: {
          'workspace.list': async () => ({
            items: [
              {
                workspace: { id: workspaceId, name: 'Workspace', kind: 'general' },
                effectiveRole: 'owner',
                membershipStatus: 'active',
                accessCause: 'membership',
                ownerUserId: 'viewer',
                membershipRevision: 1,
                registryRevision: 1,
              },
            ],
          }),
          'conversation.navigation': async () => ({
            items: threads
              .filter((item) => item.status === 'active')
              .map((item) => ({
                thread: item,
                activity: item.id === coordinatorId ? 'goal' : 'task',
                state: 'idle',
                lastActivityAt: at,
                unreadCount: 0,
              })),
          }),
          'thread.list': listThreads,
          'goal.read': goal,
          'thread.mark-read': markRead,
        },
      } as unknown as CoreClient;
      const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      useWorkspaceStore.setState({ currentWorkspaceId: workspaceId });
      render(
        <QueryClientProvider client={cache}>
          <CoreClientProvider client={client}>
            <MemoryRouter>
              <Sidebar />
            </MemoryRouter>
          </CoreClientProvider>
        </QueryClientProvider>
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Show tasks for Goal work' }));
      await screen.findByText('Ship parser');
      expect(screen.getAllByRole('button', { name: 'Linked Task' })).toHaveLength(1);
      const attempts = screen.getByRole('list', { name: 'Attempts for Linked Task' });
      expect(
        within(attempts)
          .getAllByRole('listitem')
          .map((item) => item.textContent)
      ).toEqual(['Attempt 1 · completed', 'Attempt 2 · failed']);
      expect(screen.getByRole('button', { name: 'Archived Task' })).toHaveAccessibleDescription(
        'Archived Task'
      );
      expect(screen.getByText('Attempt 1 · cancelled')).toBeVisible();
      expect(screen.getByText('Task unavailable')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Independent work' })).toBeVisible();
      expect(markRead).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Hide tasks for Goal work' }));
      expect(
        screen.queryByRole('list', { name: 'Attempts for Linked Task' })
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Show tasks for Goal work' }));
      await screen.findByRole('list', { name: 'Attempts for Linked Task' });
      listThreads.mockRejectedValueOnce(new Error('Access unavailable'));
      await act(async () => {
        await cache.invalidateQueries({ queryKey: chatKeys.threads(workspaceId), exact: true });
      });
      await screen.findByText('Goal tasks are unavailable.');
      expect(screen.queryByText('Ship parser')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('list', { name: 'Attempts for Linked Task' })
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() =>
        expect(screen.getByRole('list', { name: 'Attempts for Linked Task' })).toBeVisible()
      );
      expect(markRead).not.toHaveBeenCalled();
      cache.clear();
    });
  });
}
register_ConversationGoalGroups_test_tsx_0();

it('returns focus to Search when Escape closes the search overlay', async () => {
  const user = userEvent.setup();
  renderAssistantNavigation(vi.fn());
  const trigger = await screen.findByRole('button', { name: 'Search' });
  await user.click(trigger);
  const field = screen.getByRole('searchbox', { name: 'Search' });
  field.focus();
  expect(screen.getByRole('region', { name: 'Search' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('region', { name: 'Search' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
