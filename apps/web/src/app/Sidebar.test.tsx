import type { ConversationNavigationResponse } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  chatKeys,
  useArchiveThread,
  useRenameThread,
  useRestoreThread,
  useSendTurn,
} from '../screens/chat/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { AssistantRoute } from './AssistantRoute';
import { CoreClientProvider } from './core-client';
import { Sidebar } from './Sidebar';
import { SearchPaletteProvider } from './search/SearchPalette';

const OWNER = 'usr_00000000-0000-7000-8000-000000000001';
const WS = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';
const OPS = 'ws_00000000-0000-7ec6-8e33-a3b1d758efc6';
const PERSONAL = 'ws_00000000-0000-706d-b903-72e27d4276af';
const GOAL = 'th_00000000-0000-70ad-bcb6-3098e81b33d6';
const TASK = 'th_00000000-0000-70a0-9cde-4561f64881c6';
const CHAT = 'th_00000000-0000-7c00-b9fc-382312fdf476';
const UNKNOWN = 'th_00000000-0000-7b52-ab1a-ac5e81206bc1';

type Row = ConversationNavigationResponse['items'][number];

/** Exposes navigation as rendered state without substituting router behavior. */
function Location() {
  const location = useLocation();
  return <output aria-label="Location">{`${location.pathname}${location.search}`}</output>;
}

function threadRow(
  id: string,
  name: string,
  activity: Row['activity'],
  extra: Partial<Row> & { parentThreadId?: string } = {}
): Row {
  const { parentThreadId, ...rest } = extra;
  return {
    thread: {
      id,
      owner: { kind: 'workspace', workspaceId: WS },
      ...(parentThreadId ? { parentThreadId } : {}),
      name,
      preview: name,
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    },
    activity,
    state: 'idle',
    lastActivityAt: '2026-09-16T00:00:00.000Z',
    unreadCount: 0,
    ...rest,
  } as Row;
}

function admission(id: string, name: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    membershipStatus: 'active' as const,
    accessCause: 'membership' as const,
    workspace: { id, name, kind },
    isOwner: true,
    membershipRevision: 1,
    ownerUserId: OWNER,
    registryRevision: 1,
    ...extra,
  };
}

const DEFAULT_WORKSPACES = [
  admission(WS, 'Market research', 'general'),
  admission(OPS, 'Ops', 'general'),
  admission(PERSONAL, 'Personal', 'personal'),
];

/** Renders the production Sidebar over a fake Core Client; returns the client and its spies. */
function renderSidebar({
  rows = {},
  navigation,
  workspaces = DEFAULT_WORKSPACES,
  path = '/needs-you',
  palette = false,
  operations = {},
  extra = null,
}: {
  rows?: Record<string, Row[]>;
  navigation?: CoreClient['operations']['conversation.navigation'];
  workspaces?: unknown[];
  path?: string;
  palette?: boolean;
  operations?: Record<string, unknown>;
  extra?: React.ReactNode;
} = {}) {
  const list = (navigation ??
    vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      items: structuredClone((rows[workspaceId] ?? []).filter((r) => r.thread.status === 'active')),
    }))) as unknown as Mock<(input: { workspaceId: string }) => Promise<unknown>>;
  const goalRead = vi.fn();
  const getSession = vi.fn(async () => null);
  const client = {
    core: {},
    app: {},
    auth: { email: { getSession, signOut: vi.fn() } },
    operations: {
      'workspace.list': async () => ({ items: workspaces }),
      'conversation.navigation': list,
      'goal.read': goalRead,
      'attention.list': async () => ({ items: [] }),
      'thread.create': vi.fn(),
      'conversation.submit': vi.fn(),
      'turn.start': vi.fn(),
      ...operations,
    },
  } as unknown as CoreClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const sidebar = palette ? (
    <SearchPaletteProvider>
      <Sidebar />
    </SearchPaletteProvider>
  ) : (
    <Sidebar />
  );
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          {sidebar}
          <Routes>
            <Route path="/assistant" element={<AssistantRoute />} />
            <Route path="*" element={null} />
          </Routes>
          {extra}
          <Location />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { client, queryClient, list, goalRead, getSession };
}

async function primaryNavigation() {
  return await screen.findByRole('navigation', { name: 'Primary workspace navigation' });
}

/** The link that opens a Thread row. */
async function threadLink(name: string) {
  return await within(await primaryNavigation()).findByRole('link', { name });
}

/** The tree row that holds a Thread link. */
function rowOf(link: HTMLElement) {
  const row = link.closest('[role="row"]');
  if (!(row instanceof HTMLElement)) throw new Error('no row');
  return row;
}

beforeEach(() => useWorkspaceStore.setState({ currentWorkspaceId: WS }));

describe('B2 sidebar structure (ia.md §1)', () => {
  it('lists New, Search, Needs you, Personal Assistant, Artifacts, Knowledge, Automations in order', async () => {
    renderSidebar();
    const nav = await primaryNavigation();
    await within(nav).findByRole('region', { name: 'Market research' });
    const names = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent?.replace(/[⌃⌘][A-Z]$/, '').trim())
      .filter((name) =>
        [
          'New',
          'Search',
          'Needs you',
          'Personal Assistant',
          'Artifacts',
          'Knowledge',
          'Automations',
        ].includes(name ?? '')
      );
    expect(names).toEqual([
      'New',
      'Search',
      'Needs you',
      'Personal Assistant',
      'Artifacts',
      'Knowledge',
      'Automations',
    ]);
  });

  it('has exactly one creation control and no section partitioned by type', async () => {
    renderSidebar({
      rows: { [WS]: [threadRow(GOAL, 'Plan', 'goal'), threadRow(CHAT, 'Notes', 'chat')] },
    });
    const nav = await primaryNavigation();
    await threadLink('Plan');
    const creation = within(nav)
      .queryAllByRole('button')
      .filter((button) => /^New\b/.test(button.textContent ?? ''))
      .map((button) => button.textContent);
    expect(creation).toEqual([expect.stringMatching(/^New[⌃⌘]N$/), 'New workspace']);
    for (const name of ['New Task', 'New Goal', 'New conversation']) {
      expect(within(nav).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    for (const label of ['Assistant', 'Tasks', 'Goals', 'Needs repair']) {
      expect(within(nav).queryByText(label, { exact: true })).not.toBeInTheDocument();
    }
    expect(within(nav).queryByRole('group', { name: 'Sidebar shortcuts' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('img', { name: 'OpenKit' })).toHaveAttribute(
      'src',
      expect.stringContaining('openkit-mark-small.svg')
    );
  });

  it('orders the selected Workspace first and open, the others closed and alphabetical', async () => {
    useWorkspaceStore.setState({ currentWorkspaceId: OPS });
    const { list } = renderSidebar();
    const nav = await primaryNavigation();
    await within(nav).findByRole('region', { name: 'Ops' });
    const groups = within(nav)
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(groups).toEqual(['Ops', 'Market research', 'Personal']);
    expect(within(nav).getByRole('button', { name: 'Ops' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(within(nav).getByRole('button', { name: 'Market research' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    // G5 fallback: a closed group reads its Threads only when opened.
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls.map(([input]) => input.workspaceId)).toEqual([OPS]);
    await userEvent.setup().click(within(nav).getByRole('button', { name: 'Market research' }));
    await waitFor(() => expect(list.mock.calls.map(([input]) => input.workspaceId)).toContain(WS));
  });

  it('omits Workspaces the caller does not belong to', async () => {
    renderSidebar({
      workspaces: [
        admission(WS, 'My notes', 'general'),
        admission('ws_00000000-0000-7934-b833-fdbc51d3c0a2', 'Someone else', 'personal', {
          membershipStatus: null,
          accessCause: 'administrator',
          isOwner: false,
        }),
        admission('ws_00000000-0000-7978-8378-5b5c5e93f76d', 'Shared notes', 'general', {
          isOwner: false,
        }),
      ],
    });
    const nav = await primaryNavigation();
    await within(nav).findByRole('region', { name: 'My notes' });
    expect(within(nav).getByRole('region', { name: 'Shared notes' })).toBeInTheDocument();
    expect(within(nav).queryByRole('region', { name: 'Someone else' })).not.toBeInTheDocument();
  });
});

/** Sends one pending Chat reply through the shared submit mutation. */
function Submit() {
  const send = useSendTurn();
  return (
    <button
      type="button"
      onClick={() =>
        send.mutate({
          workspaceId: WS,
          threadId: CHAT,
          draft: {
            requestId: 'nav',
            input: 'Hi',
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
/** Renames, archives and restores one Task through the shared lifecycle mutations. */
function Lifecycle() {
  const rename = useRenameThread();
  const archive = useArchiveThread();
  const restore = useRestoreThread();
  const owner = { workspaceId: WS, threadId: TASK };
  return (
    <>
      <button type="button" onClick={() => rename.mutate({ ...owner, name: 'Renamed' })}>
        Rename
      </button>
      <button type="button" onClick={() => archive.mutate(owner)}>
        Archive
      </button>
      <button type="button" onClick={() => restore.mutate(owner)}>
        Restore
      </button>
    </>
  );
}

describe('B2 Thread rows', () => {
  it('nests a Task under its Goal and expands and collapses it with the arrow keys', async () => {
    const { goalRead } = renderSidebar({
      rows: {
        [WS]: [
          threadRow(TASK, 'Draft pricing page', 'task', { parentThreadId: GOAL }),
          threadRow(GOAL, 'Spring newsletter', 'goal'),
          threadRow(CHAT, 'Ideas', 'chat'),
        ],
      },
    });
    const goal = await threadLink('Spring newsletter');
    const goalRow = rowOf(goal);
    expect(goalRow).toHaveAttribute('aria-level', '1');
    expect(goalRow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Draft pricing page' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(goal);
    // Opening the Goal does not open its children; the arrow keys do.
    await user.keyboard('{ArrowRight}');
    const task = await screen.findByRole('link', { name: 'Draft pricing page' });
    expect(goalRow).toHaveAttribute('aria-expanded', 'true');
    expect(rowOf(task)).toHaveAttribute('aria-level', '2');
    expect(
      goalRow.compareDocumentPosition(rowOf(task)) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Draft pricing page' })).not.toBeInTheDocument()
    );
    expect(goalRow).toHaveAttribute('aria-expanded', 'false');
    // G3: nesting comes from conversation.navigation; the sidebar never polls goal.read.
    expect(goalRead).not.toHaveBeenCalled();
  });

  it('opens the parent of the Thread on screen', async () => {
    renderSidebar({
      path: `/w/${WS}/t/${TASK}`,
      rows: {
        [WS]: [
          threadRow(GOAL, 'Spring newsletter', 'goal'),
          threadRow(TASK, 'Draft pricing page', 'task', { parentThreadId: GOAL }),
        ],
      },
    });
    const task = await threadLink('Draft pricing page');
    expect(task).toHaveAttribute('aria-current', 'page');
    expect(rowOf(await threadLink('Spring newsletter'))).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows one trailing indicator by priority and describes the row', async () => {
    renderSidebar({
      rows: {
        [WS]: [
          threadRow(GOAL, 'Goal row', 'goal', { state: 'needs-you', unreadCount: 3 }),
          threadRow(TASK, 'Task row', 'task', { state: 'working' }),
          threadRow(CHAT, 'Chat row', 'chat', { unreadCount: 2 }),
          threadRow(UNKNOWN, 'Unknown row', 'unknown', { unreadCount: null }),
        ],
      },
    });
    const goal = await threadLink('Goal row');
    const indicator = (link: HTMLElement) =>
      [...rowOf(link).querySelectorAll('[data-indicator]')].map((node) =>
        node.getAttribute('data-indicator')
      );
    expect(goal).toHaveAccessibleDescription('Goal · Needs you · 3 unread replies');
    expect(indicator(goal)).toEqual(['needs-you']);
    const task = await threadLink('Task row');
    expect(task).toHaveAccessibleDescription('Task · Working');
    expect(indicator(task)).toEqual(['working']);
    const chat = await threadLink('Chat row');
    expect(chat).toHaveAccessibleDescription('Chat · Idle · 2 unread replies');
    expect(indicator(chat)).toEqual(['unread']);
    expect(within(rowOf(chat)).getByText('2')).toBeVisible();
    const unknown = await threadLink('Unknown row');
    expect(unknown).toHaveAccessibleDescription('Needs repair · Idle');
    expect(indicator(unknown)).toEqual([]);
  });

  it('opens a row with its activity hint, and marks it current', async () => {
    renderSidebar({ rows: { [WS]: [threadRow(GOAL, 'Plan', 'goal')] } });
    const user = userEvent.setup();
    const goal = await threadLink('Plan');
    expect(goal).not.toHaveAttribute('aria-current');
    await user.click(goal);
    expect(screen.getByLabelText('Location')).toHaveTextContent(`/w/${WS}/t/${GOAL}`);
    await waitFor(() => expect(goal).toHaveAttribute('aria-current', 'page'));
  });

  it.each([
    ['/w/ws%2F1/t/th%3F%23%25', true],
    ['/w/ws%2F1/t/th%3F%23%25/artifacts/a', true],
    ['/w/ws%2F1/t/th%3F%23%25-extra', false],
    ['/w/other/t/th%3F%23%25', false],
  ] as const)('matches encoded Thread identity at %s', async (path, current) => {
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws/1' });
    renderSidebar({
      path,
      workspaces: [admission('ws/1', 'Encoded workspace', 'general')],
      navigation: (async () => ({
        items: [
          {
            thread: { id: 'th?#%', name: 'Encoded conversation' },
            activity: 'task',
            state: 'idle',
          },
        ],
      })) as unknown as CoreClient['operations']['conversation.navigation'],
    });
    const link = await threadLink('Encoded conversation');
    if (current) expect(link).toHaveAttribute('aria-current', 'page');
    else expect(link).not.toHaveAttribute('aria-current');
    await userEvent.setup().click(link);
    expect(screen.getByLabelText('Location').textContent).toBe('/w/ws%2F1/t/th%3F%23%25');
  });

  it('keeps the last rows on a failed read, retries, and tracks a pending reply and lifecycle', async () => {
    const rows = [
      threadRow(TASK, 'Task row', 'task', { state: 'working' }),
      threadRow(CHAT, 'Chat row', 'chat', { unreadCount: 2 }),
    ];
    let finish!: (value: { receivingWorkspaceId: string; receivingThreadId: string }) => void;
    const submit = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const update = async (input: { threadId: string; name?: string; status?: 'active' }) => {
      const target = rows.find((row) => row.thread.id === input.threadId)!;
      target.thread = {
        ...target.thread,
        ...(input.name ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
      };
      return target.thread;
    };
    const { list, queryClient } = renderSidebar({
      rows: { [WS]: rows },
      operations: {
        'conversation.submit': submit,
        'thread.update': update,
        'thread.archive': async (input: { threadId: string }) => {
          const target = rows.find((row) => row.thread.id === input.threadId)!;
          target.thread = { ...target.thread, status: 'archived' };
          return target.thread;
        },
      },
      extra: (
        <>
          <Submit />
          <Lifecycle />
        </>
      ),
    });
    const user = userEvent.setup();
    await threadLink('Task row');
    list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.threads(WS) });
    });
    expect(
      (await screen.findByText(/Thread status unavailable/)).closest('[role="status"]')
    ).not.toBeNull();
    expect(await threadLink('Task row')).toHaveAccessibleDescription('Task · Status unavailable');
    expect(within(rowOf(await threadLink('Chat row'))).queryByText('2')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry Threads' }));
    await waitFor(async () =>
      expect(await threadLink('Task row')).toHaveAccessibleDescription('Task · Working')
    );
    await user.click(screen.getByRole('button', { name: 'Send pending request' }));
    await waitFor(async () =>
      expect(await threadLink('Chat row')).toHaveAccessibleDescription(/Waiting for response/)
    );
    await act(async () => finish({ receivingWorkspaceId: WS, receivingThreadId: CHAT }));
    await waitFor(async () =>
      expect(await threadLink('Chat row')).toHaveAccessibleDescription(
        'Chat · Idle · 2 unread replies'
      )
    );
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await threadLink('Renamed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Renamed' })).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await threadLink('Renamed')).toBeInTheDocument();
    queryClient.clear();
  });

  it('shows 15 top-level rows, then "Show N more"', async () => {
    const many = Array.from({ length: 18 }, (_, index) =>
      threadRow(
        `th_00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        `Row ${index}`,
        'chat'
      )
    );
    renderSidebar({ rows: { [WS]: many } });
    await threadLink('Row 14');
    expect(screen.queryByRole('link', { name: 'Row 15' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(await threadLink('Row 17')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).not.toBeInTheDocument();
  });

  it('announces that Threads are loading', async () => {
    let finish!: (value: { items: [] }) => void;
    renderSidebar({
      navigation: (() =>
        new Promise((resolve) => {
          finish = resolve;
        })) as unknown as CoreClient['operations']['conversation.navigation'],
    });
    expect(await screen.findByText('Loading Threads…')).toHaveAttribute('role', 'status');
    finish({ items: [] });
    await waitFor(() => expect(screen.queryByText('Loading Threads…')).not.toBeInTheDocument());
    expect(screen.getByText('No Threads yet.')).toBeInTheDocument();
  });
});

describe('B2 group ⋯ menu', () => {
  it('filters the group by type without sections', async () => {
    renderSidebar({
      rows: {
        [WS]: [
          threadRow(GOAL, 'Plan', 'goal'),
          threadRow(TASK, 'Child task', 'task', { parentThreadId: GOAL }),
          threadRow(CHAT, 'Notes', 'chat'),
        ],
      },
    });
    const user = userEvent.setup();
    await threadLink('Plan');
    await user.click(screen.getByRole('button', { name: 'Market research options' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Tasks' }));
    expect(await threadLink('Child task')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Market research options' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Tasks' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(screen.getByRole('menuitemradio', { name: 'All' }));
    expect(await threadLink('Notes')).toBeInTheDocument();
  });

  it('opens Workspace places for that Workspace and selects it', async () => {
    renderSidebar();
    const user = userEvent.setup();
    const nav = await primaryNavigation();
    await within(nav).findByRole('region', { name: 'Ops' });
    await user.click(screen.getByRole('button', { name: 'Ops options' }));
    const menu = await screen.findByRole('menu', { name: 'Ops options' });
    expect(
      [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent)
    ).toEqual([
      'Workspace settings',
      'Members',
      'Catalog',
      'Workspace changes',
      'Recovery',
      'Archived threads',
      'Vault',
      'Usage & audit',
      'New Thread here',
      'New Task',
      'New Goal',
      'All',
      'Chats',
      'Tasks',
      'Goals',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Vault' }));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(OPS);
    expect(screen.getByLabelText('Location')).toHaveTextContent('/workspace/vault');
  });

  it('omits Members for the personal Workspace', async () => {
    renderSidebar();
    const user = userEvent.setup();
    await within(await primaryNavigation()).findByRole('region', { name: 'Personal' });
    await user.click(screen.getByRole('button', { name: 'Personal options' }));
    const menu = await screen.findByRole('menu', { name: 'Personal options' });
    expect(within(menu).queryByRole('menuitem', { name: 'Members' })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'New Thread here' }));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(PERSONAL);
    expect(screen.getByLabelText('Location')).toHaveTextContent('/new');
  });

  it('starts a Task in that Workspace from the menu', async () => {
    renderSidebar({
      operations: {
        'conversation.targets': async () => ({ targets: [] }),
        'sandbox.environment.list': async () => ({ items: [] }),
      },
    });
    const user = userEvent.setup();
    await within(await primaryNavigation()).findByRole('region', { name: 'Ops' });
    await user.click(screen.getByRole('button', { name: 'Ops options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'New Task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Task' });
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(OPS);
    await user.click(within(dialog).getByRole('button', { name: 'Close New Task' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New Task' })).not.toBeInTheDocument()
    );
  });
});

describe('B2 top block, account and settings', () => {
  it('opens the Personal Assistant without a message', async () => {
    const thread = {
      id: CHAT,
      owner: { kind: 'workspace', workspaceId: PERSONAL },
      name: 'Assistant',
      preview: 'History',
      status: 'active',
      visibility: 'private',
      privateOwnerUserId: OWNER,
      entryPath: 'conversation',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    };
    const create = vi.fn().mockResolvedValue(thread);
    const { client } = renderSidebar({ operations: { 'thread.create': create } });
    const user = userEvent.setup();
    await user.click(
      await within(await primaryNavigation()).findByRole('button', { name: 'Personal Assistant' })
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(`/w/${PERSONAL}/t/${CHAT}`)
    );
    expect(create).toHaveBeenCalledWith({
      workspaceId: PERSONAL,
      name: 'Assistant',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(client.operations['conversation.submit']).not.toHaveBeenCalled();
    expect(client.operations['turn.start']).not.toHaveBeenCalled();
  });

  it('opens New from its row and from ⌃N', async () => {
    renderSidebar({ path: '/knowledge' });
    const user = userEvent.setup();
    await user.click(await within(await primaryNavigation()).findByRole('button', { name: 'New' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/new');
    await user.click(screen.getByRole('button', { name: 'Knowledge' }));
    await user.keyboard('{Control>}n{/Control}');
    expect(screen.getByLabelText('Location')).toHaveTextContent('/new');
  });

  it('opens Profile and Appearance from the account row without a session read', async () => {
    const { getSession } = renderSidebar();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Account' }));
    const menu = await screen.findByRole('menu', { name: 'Account' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Profile', 'Appearance']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Appearance' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/appearance');
    // No caller name read exists yet (R044); local mode has no auth session route.
    expect(getSession).not.toHaveBeenCalled();
  });

  it('opens Settings from the gear and lists the settings sections', async () => {
    renderSidebar();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/account');
    const settings = screen.getByRole('navigation', { name: 'Settings sections' });
    await user.click(within(settings).getByRole('button', { name: 'General' }));
    expect(within(settings).getByRole('button', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await user.click(within(settings).getByRole('button', { name: 'Back to app' }));
    expect(await primaryNavigation()).toBeInTheDocument();
  });

  it('opens the Search palette from its row and returns focus to the row on Escape', async () => {
    const user = userEvent.setup();
    renderSidebar({ palette: true });
    const trigger = await screen.findByRole('button', { name: 'Search' });
    await user.click(trigger);
    const field = await screen.findByRole('searchbox', { name: 'Search' });
    await waitFor(() => expect(field).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument()
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('opens the Search page from its row when no palette is mounted', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(await screen.findByRole('button', { name: 'Search' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/search');
  });
});
