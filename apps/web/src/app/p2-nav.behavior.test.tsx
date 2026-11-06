import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_NAVIGATION_PAGE_LIMIT } from '../screens/chat/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { CoreClientProvider } from './core-client';
import { AppRoutes } from './routes';

const PERSISTENT_NAV_QUERY = '(min-width: 800px)';
const WORKSPACE_ID = 'ws_019a0000-0000-7000-8000-000000000101';
const TIMESTAMP = '2026-11-05T00:00:00.000Z';

let viewportWidth = 1024;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
const originalMatchMedia = window.matchMedia;

/**
 * Reports the current route so redirects are observable without reading component internals.
 */
function Location() {
  const location = useLocation();
  return <output aria-label="Location">{`${location.pathname}${location.search}`}</output>;
}

/**
 * Sets the next `(min-width: 800px)` result and notifies installed listeners.
 *
 * @param width Viewport width in pixels.
 */
function setViewportWidth(width: number) {
  viewportWidth = width;
  const event = { matches: viewportWidth >= 800 } as MediaQueryListEvent;
  for (const listener of mediaListeners) listener(event);
}

/**
 * Installs the shell's 800px breakpoint as a controllable media query.
 */
function installMatchMedia() {
  window.matchMedia = (query: string) =>
    ({
      get matches() {
        return query === PERSISTENT_NAV_QUERY ? viewportWidth >= 800 : true;
      },
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: EventListener) => {
        if (type === 'change') mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
      },
      removeEventListener: (_type: string, listener: EventListener) => {
        mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }) as MediaQueryList;
}

/** Builds one retained Thread record for conversation navigation. */
function threadRecord(id: string, name: string) {
  return {
    id,
    owner: { kind: 'workspace' as const, workspaceId: WORKSPACE_ID },
    name,
    preview: '',
    status: 'active' as const,
    visibility: 'workspace' as const,
    entryPath: 'conversation' as const,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

/** Builds one server-classified activity row. */
function navigationRow(
  id: string,
  name: string,
  activity: 'chat' | 'task' | 'goal' | 'unknown',
  state: 'idle' | 'working' | 'needs-you' = 'idle'
) {
  return {
    thread: threadRecord(id, name),
    activity,
    state,
    lastActivityAt: TIMESTAMP,
    unreadCount: 0,
  };
}

/** Builds one open decision that Action Center shows without an approval dashboard read. */
function attentionRow(id: string, title: string, threadId: string) {
  return {
    id: `question:${id}`,
    kind: 'question',
    workspaceId: WORKSPACE_ID,
    threadId,
    turnId: 'tu_019a0000-0000-7000-8000-000000000201',
    itemId: 'it_019a0000-0000-7000-8000-000000000202',
    title,
    summary: 'The Worker is waiting for an answer.',
    severity: 'needs_input',
    createdAt: TIMESTAMP,
    recommendedAction: 'Answer the question.',
    source: {
      type: 'protocol_item',
      itemType: 'user-input-request',
      workspaceId: WORKSPACE_ID,
      threadId,
      turnId: 'tu_019a0000-0000-7000-8000-000000000201',
      itemId: 'it_019a0000-0000-7000-8000-000000000202',
    },
    actions: [
      {
        kind: 'open_thread',
        label: 'Open',
        method: 'GET',
        href: `/api/workspaces/${WORKSPACE_ID}/threads/${threadId}`,
      },
    ],
  };
}

interface ClientOptions {
  navigation?: ReturnType<typeof navigationRow>[];
  attention?: ReturnType<typeof attentionRow>[];
  threads?: ReturnType<typeof threadRecord>[];
  readThread?: ReturnType<typeof threadRecord>;
  createThread?: ReturnType<typeof vi.fn>;
}

/** Builds the minimal Core Client used by the routed shell, lists, and Action Center. */
function makeClient(options: ClientOptions = {}): CoreClient {
  const readThread =
    options.readThread ?? threadRecord('th_019a0000-0000-7000-8000-000000000103', 'Assistant');
  return {
    core: { meta: vi.fn().mockResolvedValue({}) },
    operations: {
      'workspace.list': vi.fn().mockResolvedValue({
        items: [
          {
            workspace: { id: WORKSPACE_ID, name: 'Alpha', kind: 'general' },
            membershipStatus: 'active',
            accessCause: 'membership',
            effectiveRole: 'owner',
            isOwner: true,
            ownerUserId: 'usr_019a0000-0000-7000-8000-000000000104',
            membershipRevision: 1,
            registryRevision: 1,
          },
        ],
      }),
      'workspace.resources': vi
        .fn()
        .mockResolvedValue({ knowledge: [], skills: [], agents: [], models: [] }),
      'conversation.navigation': vi.fn().mockResolvedValue({ items: options.navigation ?? [] }),
      'attention.list': vi.fn().mockResolvedValue({ items: options.attention ?? [] }),
      'thread.list': vi.fn().mockResolvedValue({ items: options.threads ?? [] }),
      'thread.create': options.createThread ?? vi.fn().mockResolvedValue(readThread),
      'conversation.submit': vi.fn(),
      'thread.read': vi.fn().mockResolvedValue(readThread),
      'thread.dashboard': vi.fn().mockResolvedValue({
        turns: [],
        pendingRequests: [],
        artifacts: [],
        taskInputs: [],
        participants: [],
        thread: readThread,
        viewerUserId: null,
        workStatus: null,
        composer: { disabled: false, defaultAgentId: null },
        itemLog: { href: '' },
      }),
      'thread.items': vi.fn().mockResolvedValue({ items: [] }),
      'conversation.targets': vi.fn().mockResolvedValue({
        targets: [],
        defaultTargetRef: null,
      }),
      'worker-environment.list': vi.fn().mockResolvedValue({ items: [] }),
      'artifact.list': vi.fn().mockResolvedValue({ items: [] }),
      'goal.read': vi.fn().mockRejectedValue(new Error('No Goal projection.')),
    },
  } as unknown as CoreClient;
}

/**
 * Renders the live route tree with one isolated server state.
 *
 * @param path Initial route.
 * @param client Core Client fake.
 */
function renderAt(path: string, client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <Location />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

/**
 * Asserts that one node precedes another in document order.
 *
 * @param first Node that must come first.
 * @param second Node that must come later.
 */
function expectBefore(first: Node, second: Node) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

beforeEach(() => {
  mediaListeners.clear();
  viewportWidth = 1024;
  installMatchMedia();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('P2 desktop navigation and lists', () => {
  it('shows Personal Assistant, Tasks, and Goals without a Conversations bucket or Agents row', async () => {
    const client = makeClient({
      navigation: [
        navigationRow(
          'th_019a0000-0000-7000-8000-000000000110',
          'Launch notes',
          'goal',
          'needs-you'
        ),
        navigationRow('th_019a0000-0000-7000-8000-000000000111', 'Fix the export', 'task'),
        navigationRow('th_019a0000-0000-7000-8000-000000000112', 'Conversation 2', 'chat', 'idle'),
        navigationRow('th_019a0000-0000-7000-8000-000000000113', 'Conversation 3', 'unknown'),
      ],
    });
    renderAt('/attention', client);

    const navigation = await screen.findByRole('navigation', {
      name: 'Primary workspace navigation',
    });

    const assistantRows = within(navigation).getAllByRole('button', { name: 'Personal Assistant' });
    expect(assistantRows).toHaveLength(1);
    expect(within(navigation).queryByText('Conversations')).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();

    expect(within(navigation).getByRole('button', { name: 'Knowledge' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Artifacts' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Action Center' })).toBeVisible();

    const taskRow = await within(navigation).findByRole('button', { name: 'Fix the export' });
    expect(taskRow).toHaveAccessibleDescription(/^Task(?: ·|$)/);
    expect(taskRow).not.toHaveAccessibleDescription(/Worker task/);
    const goalRow = await within(navigation).findByRole('button', { name: 'Launch notes' });
    expect(goalRow).toHaveAccessibleDescription(/^Goal(?: ·|$)/);
    expect(
      await within(navigation).findByRole('button', { name: 'Conversation 3' })
    ).toHaveAccessibleDescription(/^Activity type unknown(?: ·|$)/);

    const tasksLabel = within(navigation).getAllByText('Tasks', { exact: true })[0];
    const goalsLabel = within(navigation).getAllByText('Goals', { exact: true })[0];
    expect(tasksLabel, 'Tasks must label the Task list').toBeTruthy();
    expect(goalsLabel, 'Goals must label the Goal list').toBeTruthy();
    expectBefore(tasksLabel!, taskRow);
    expectBefore(goalsLabel!, goalRow);
    expectBefore(tasksLabel!, goalsLabel!);

    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Work' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('makes Action Center the decisions screen at /attention and keeps the decisions Overview shows today', async () => {
    const client = makeClient({
      attention: [
        attentionRow('q1', 'Answer required', 'th_019a0000-0000-7000-8000-000000000120'),
        attentionRow('q2', 'Pick the export scope', 'th_019a0000-0000-7000-8000-000000000121'),
      ],
    });
    renderAt('/attention', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Action Center' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
    const decision = await screen.findByRole('heading', { name: 'Answer required' });
    expect(decision).toBeVisible();
    const decisionRow = decision.closest('.border-b');
    expect(decisionRow).toBeTruthy();
    expect(
      within(decisionRow as HTMLElement).getByRole('link', { name: 'Open thread' })
    ).toHaveAttribute('href', `/chat/${WORKSPACE_ID}/th_019a0000-0000-7000-8000-000000000120`);

    const actionCenter = await screen.findByRole('button', { name: /^Action Center/ });
    expect(await within(actionCenter).findByText('2')).toBeInTheDocument();
  });

  it('opens Action Center at / when the selected Workspace has no Assistant timeline', async () => {
    const createThread = vi.fn().mockResolvedValue(threadRecord('th_assistant', 'Assistant'));
    const client = makeClient({
      createThread,
      navigation: [
        navigationRow('th_019a0000-0000-7000-8000-000000000130', 'Fix the export', 'task'),
      ],
    });
    renderAt('/', client);

    await waitFor(() => expect(screen.getByLabelText('Location')).toHaveTextContent('/attention'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Action Center' })
    ).toBeInTheDocument();
    expect(createThread).not.toHaveBeenCalled();
  });

  it('opens the existing Assistant timeline at / when a chat-classified thread exists', async () => {
    const user = userEvent.setup();
    const chat = threadRecord('th_019a0000-0000-7000-8000-000000000140', 'Ship the notes');
    const createThread = vi.fn();
    const client = makeClient({
      readThread: chat,
      createThread,
      navigation: [
        navigationRow(chat.id, 'Ship the notes', 'chat'),
        navigationRow('th_019a0000-0000-7000-8000-000000000141', 'Fix the export', 'task'),
      ],
    });
    renderAt('/', client);

    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/chat/${WORKSPACE_ID}/${chat.id}`
      )
    );
    expect(createThread).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ship the notes' })
    ).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Personal Assistant' }));
    expect(createThread).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Location')).toHaveTextContent(`/chat/${WORKSPACE_ID}/${chat.id}`);
  });

  it('creates a missing Assistant timeline with thread.create and never submits a conversation', async () => {
    const user = userEvent.setup();
    const created = threadRecord('th_019a0000-0000-7000-8000-000000000150', 'Assistant');
    const createThread = vi.fn().mockResolvedValue(created);
    const client = makeClient({ createThread });
    renderAt('/attention', client);

    await user.click(await screen.findByRole('button', { name: 'Personal Assistant' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/chat/${WORKSPACE_ID}/${created.id}`
      )
    );
    expect(createThread).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      name: 'Assistant',
      requestId: expect.any(String),
    });
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(client.operations['conversation.submit']).not.toHaveBeenCalled();
  });
});

describe('P2 phone navigation', () => {
  it('creates the missing Assistant timeline from the phone home without submitting', async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    const created = threadRecord('th_019a0000-0000-7000-8000-000000000190', 'Assistant');
    const createThread = vi.fn().mockResolvedValue(created);
    const client = makeClient({ createThread });
    renderAt('/', client);

    await waitFor(() => expect(screen.getByLabelText('Location')).toHaveTextContent('/attention'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Action Center' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Primary workspace navigation' })
    ).not.toBeInTheDocument();
    expect(createThread).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Personal Assistant' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/chat/${WORKSPACE_ID}/${created.id}`
      )
    );
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      name: 'Assistant',
      requestId: expect.any(String),
    });
    expect(client.operations['conversation.submit']).not.toHaveBeenCalled();
  });

  it('shows exactly Assistant, Work, Knowledge, Artifacts, and More below 800px', async () => {
    const user = userEvent.setup();
    setViewportWidth(360);
    const client = makeClient({
      attention: [attentionRow('q1', 'Answer required', 'th_019a0000-0000-7000-8000-000000000160')],
    });
    renderAt('/attention', client);

    const navigation = await screen.findByRole('navigation', { name: 'Sections' });
    const buttons = within(navigation).getAllByRole('button');
    expect(buttons).toHaveLength(5);
    expect(buttons[0]).toHaveAccessibleName('Assistant');
    expect(buttons[1]).toHaveAccessibleName('Work');
    expect(buttons[2]).toHaveAccessibleName('Knowledge');
    expect(buttons[3]).toHaveAccessibleName('Artifacts');
    expect(buttons[4]).toHaveAccessibleName('More');

    expect(
      within(navigation).queryByRole('button', { name: /^Needs you/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();

    await user.click(buttons[4]!);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('button', { name: /^Action Center/ })).toBeVisible();
    expect(within(drawer).queryByRole('button', { name: 'Artifacts' })).not.toBeInTheDocument();
  });

  it('shows the attention count on the Tasks segment when a decision is waiting', async () => {
    setViewportWidth(360);
    const client = makeClient({
      attention: [
        attentionRow('q1', 'Answer required', 'th_019a0000-0000-7000-8000-000000000170'),
        attentionRow('q2', 'Pick the export scope', 'th_019a0000-0000-7000-8000-000000000171'),
      ],
    });
    renderAt('/work', client);

    const tasks = await screen.findByRole('tab', { name: /^Tasks/ });
    expect(await within(tasks).findByText('2')).toBeInTheDocument();
  });

  it('keeps the desktop sidebar destinations and drops the bottom row at 800px', async () => {
    setViewportWidth(800);
    const client = makeClient({
      navigation: [
        navigationRow('th_019a0000-0000-7000-8000-000000000180', 'Fix the export', 'task'),
      ],
    });
    renderAt('/attention', client);

    const navigation = await screen.findByRole('navigation', {
      name: 'Primary workspace navigation',
    });
    expect(within(navigation).getByRole('button', { name: 'Personal Assistant' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Knowledge' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Artifacts' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Action Center' })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: 'Needs you' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('loads the next conversation page only when the server returns a cursor', async () => {
    const user = userEvent.setup();
    const first = navigationRow(
      'th_019a0000-0000-7000-8000-000000000181',
      'Fix the export',
      'task'
    );
    const second = navigationRow('th_019a0000-0000-7000-8000-000000000182', 'Weekly notes', 'task');
    const list = vi.fn(async (input: { cursor?: string }) =>
      input.cursor === 'cursor-2'
        ? { items: [second], nextCursor: null }
        : { items: [first], nextCursor: 'cursor-2' }
    );
    const client = makeClient();
    (
      client.operations as unknown as {
        'conversation.navigation': typeof list;
      }
    )['conversation.navigation'] = list;
    renderAt('/attention', client);

    const navigation = await screen.findByRole('navigation', {
      name: 'Primary workspace navigation',
    });
    expect(await within(navigation).findByRole('button', { name: 'Fix the export' })).toBeVisible();
    expect(
      within(navigation).queryByRole('button', { name: 'Weekly notes' })
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        limit: CONVERSATION_NAVIGATION_PAGE_LIMIT,
      })
    );
    await user.click(within(navigation).getByRole('button', { name: 'Load more' }));
    expect(await within(navigation).findByRole('button', { name: 'Weekly notes' })).toBeVisible();
    expect(list).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      limit: CONVERSATION_NAVIGATION_PAGE_LIMIT,
      cursor: 'cursor-2',
    });
    expect(within(navigation).queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
