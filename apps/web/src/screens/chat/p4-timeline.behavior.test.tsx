import type { CoreClient } from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';

const PERSISTENT_NAV_QUERY = '(min-width: 800px)';
const WORKSPACE_ID = 'ws_019a0000-0000-7000-8000-000000000101';
const THREAD_ID = 'th_019a0000-0000-7000-8000-000000000103';
const USER_ID = 'usr_019a0000-0000-7000-8000-000000000108';
const TURN_ID = 'tu_019a0000-0000-7000-8000-000000000201';
const USER_ITEM_ID = 'it_019a0000-0000-7000-8000-000000000210';
const ASSISTANT_ITEM_ID = 'it_019a0000-0000-7000-8000-000000000211';
const TOOL_ITEM_ID = 'it_019a0000-0000-7000-8000-000000000212';
const NEXT_TOOL_ITEM_ID = 'it_019a0000-0000-7000-8000-000000000213';
const APPROVAL_ITEM_ID = 'it_019a0000-0000-7000-8000-000000000214';
const EARLIER_ITEM_ID = 'it_019a0000-0000-7000-8000-000000000215';
const APPROVAL_REQUEST_ID = 'ap_019a0000-0000-7000-8000-000000000220';
const CURSOR = 'cur_019a0000-0000-7000-8000-000000000301';
const TIMESTAMP = '2026-11-05T00:00:00.000Z';
const COMPLETED_AT = '2026-11-05T00:00:02.000Z';
const THREAD_PATH = `/chat/${WORKSPACE_ID}/${THREAD_ID}`;
const APPROVAL_TITLE = 'Publish the summary?';
const TOOL_TITLE = 'Read the export log';
const NEXT_TOOL_TITLE = 'Write the summary';
const USER_TEXT = 'Ship the release notes.';
const EARLIER_TEXT = 'Earlier context from the export.';

let viewportWidth = 1024;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
const originalMatchMedia = window.matchMedia;

/** Reports the current route so navigation is observable without reading component internals. */
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

/** Installs the shell's 800px breakpoint as a controllable media query. */
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

/** Builds one retained Thread record used by conversation navigation and the routed shell. */
function threadRecord(id = THREAD_ID, name = 'Ship the notes') {
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

/** Builds one open decision that the Action Center counts while the approval is live. */
function approvalAttentionRow() {
  return {
    id: `approval:${APPROVAL_REQUEST_ID}`,
    kind: 'approval',
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: APPROVAL_ITEM_ID,
    title: APPROVAL_TITLE,
    summary: 'The export is ready to publish.',
    severity: 'needs_input',
    createdAt: TIMESTAMP,
    recommendedAction: 'Approve or deny the publish.',
    source: {
      type: 'approval',
      approvalRequestId: APPROVAL_REQUEST_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: APPROVAL_ITEM_ID,
    },
    actions: [
      {
        kind: 'grant_approval',
        label: 'Approve',
        method: 'POST',
        href: `/api/workspaces/${WORKSPACE_ID}/threads/${THREAD_ID}/approvals/${APPROVAL_REQUEST_ID}`,
      },
      {
        kind: 'deny_approval',
        label: 'Deny',
        method: 'POST',
        href: `/api/workspaces/${WORKSPACE_ID}/threads/${THREAD_ID}/approvals/${APPROVAL_REQUEST_ID}`,
      },
      {
        kind: 'open_thread',
        label: 'Open thread',
        method: 'GET',
        href: THREAD_PATH,
      },
    ],
  };
}

/** Builds one protocol Turn-stream envelope for the live timeline subscription. */
function turnStreamEvent(sequence: number, event: string, data: unknown) {
  return {
    protocolVersion: '0.4.0',
    event,
    sequence,
    requestId: null,
    timestamp: TIMESTAMP,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    data,
  };
}

/** A subscription that never emits, for timelines without a live Turn. */
function neverStream() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => {}) };
    },
  };
}

/** Shared owner and Turn fields for one protocol item. */
function itemBase(id: string, type: string, createdAt = TIMESTAMP) {
  return {
    id,
    owner: { kind: 'workspace' as const, workspaceId: WORKSPACE_ID },
    threadId: THREAD_ID,
    turnId: TURN_ID,
    type,
    status: 'completed' as const,
    createdAt,
    completedAt: createdAt,
  };
}

/** Builds one completed user message. */
function userMessage() {
  return ItemSchema.parse({
    ...itemBase(USER_ITEM_ID, 'user-message'),
    actor: { kind: 'user', id: USER_ID },
    text: USER_TEXT,
  });
}

/** Builds one completed assistant message. */
function assistantMessage() {
  return ItemSchema.parse({
    ...itemBase(ASSISTANT_ITEM_ID, 'assistant-message'),
    text: 'I am checking the export before publishing.',
  });
}

/** Builds one tool call that the timeline may show only in Details or as a progress line. */
function toolCall(id: string, tool: string, status: 'completed' | 'in_progress' = 'completed') {
  return ItemSchema.parse({
    ...itemBase(id, 'tool-call'),
    status,
    completedAt: status === 'completed' ? TIMESTAMP : null,
    tool,
    server: 'filesystem',
    arguments: null,
    result: status === 'completed' ? 'Read 42 lines.' : null,
    error: null,
    durationMs: status === 'completed' ? 1_000 : null,
  });
}

/** Builds one permission approval that carries its decision on the card. */
function approvalRequest() {
  return ItemSchema.parse({
    ...itemBase(APPROVAL_ITEM_ID, 'approval-request'),
    approvalRequestId: APPROVAL_REQUEST_ID,
    title: APPROVAL_TITLE,
    description: 'The export is ready to publish.',
    kind: 'permission',
  });
}

/** Builds one earlier user message returned by the next server page. */
function earlierMessage() {
  return ItemSchema.parse({
    ...itemBase(EARLIER_ITEM_ID, 'user-message'),
    actor: { kind: 'user', id: USER_ID },
    text: EARLIER_TEXT,
  });
}

/** Builds the authorized participants used for the progress line's "who". */
function participants() {
  return [
    { kind: 'user', id: USER_ID, displayName: 'Simon' },
    { kind: 'agent', id: 'agent_export', displayName: 'Sam' },
  ];
}

/** Builds one running Turn owned by the export worker. */
function runningTurn(startedAt = TIMESTAMP) {
  return {
    id: TURN_ID,
    owner: { kind: 'workspace' as const, workspaceId: WORKSPACE_ID },
    threadId: THREAD_ID,
    triggerActor: { kind: 'user' as const, id: USER_ID },
    items: [],
    error: null,
    configVersion: null,
    startedAt,
    completedAt: null,
    durationMs: null,
    status: 'running' as const,
    agentId: 'agent_export',
  };
}

/** Builds one completed Turn. */
function completedTurn() {
  return {
    ...runningTurn(),
    status: 'completed' as const,
    completedAt: COMPLETED_AT,
    durationMs: 2_000,
  };
}

/** Builds one pending approval request in the authoritative dashboard. */
function pendingApproval() {
  return {
    requestId: APPROVAL_REQUEST_ID,
    canRespond: true,
    approvalEffect: {
      status: 'available' as const,
      summary: 'Publish the summary.',
      detail: '{"action":"publish"}',
    },
    state: 'pending' as const,
    resolution: null,
    ending: null,
    disposition: null,
  };
}

interface DashboardOptions {
  turns?: unknown[];
  pendingRequests?: unknown[];
  participants?: unknown[];
}

/** Builds the authoritative Thread dashboard projection. */
function threadDashboard(options: DashboardOptions = {}) {
  return {
    turns: options.turns ?? [],
    pendingRequests: options.pendingRequests ?? [],
    artifacts: [],
    taskInputs: [],
    participants: options.participants ?? [],
    thread: threadRecord(),
    viewerUserId: USER_ID,
    workStatus: null,
    composer: { disabled: false, defaultAgentId: null },
    itemLog: { href: '' },
  };
}

interface ClientOptions {
  navigation?: ReturnType<typeof navigationRow>[];
  attention?: ReturnType<typeof vi.fn>;
  threadItems?: ReturnType<typeof vi.fn>;
  dashboard?: ReturnType<typeof vi.fn>;
  subscribeTurnEvents?: ReturnType<typeof vi.fn>;
}

/** Builds the minimal Core Client used by the routed shell and the timeline. */
function makeClient(options: ClientOptions = {}): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      subscribeTurnEvents: options.subscribeTurnEvents ?? vi.fn().mockReturnValue(neverStream()),
    },
    operations: {
      'workspace.list': vi.fn().mockResolvedValue({
        items: [
          {
            workspace: { id: WORKSPACE_ID, name: 'Alpha', kind: 'general' },
            membershipStatus: 'active',
            accessCause: 'membership',
            effectiveRole: 'owner',
            isOwner: true,
            ownerUserId: USER_ID,
            membershipRevision: 1,
            registryRevision: 1,
          },
        ],
      }),
      'workspace.resources': vi
        .fn()
        .mockResolvedValue({ knowledge: [], skills: [], agents: [], models: [] }),
      'conversation.navigation': vi.fn().mockResolvedValue({ items: options.navigation ?? [] }),
      'attention.list': options.attention ?? vi.fn().mockResolvedValue({ items: [] }),
      'thread.list': vi.fn().mockResolvedValue({ items: [] }),
      'thread.create': vi.fn(),
      'conversation.submit': vi.fn(),
      'conversation.targets': vi.fn().mockResolvedValue({ targets: [], defaultTargetRef: null }),
      'task.start': vi.fn(),
      'worker-environment.list': vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      'thread.read': vi.fn().mockResolvedValue(threadRecord()),
      'thread.dashboard': options.dashboard ?? vi.fn().mockResolvedValue(threadDashboard()),
      'thread.items':
        options.threadItems ?? vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
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
  // The app provider keeps queries fresh for 5s, so a second items observer does not reread the log.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <Location />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
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

/** Finds the desktop Details panel whether it is exposed as complementary or as a named region. */
function detailsPanel(): HTMLElement | null {
  return (
    screen.queryByRole('complementary', { name: 'Details' }) ??
    screen.queryByRole('region', { name: 'Details' })
  );
}

/** Waits for the Details panel that holds the hidden timeline steps. */
async function findDetailsPanel(): Promise<HTMLElement> {
  return await waitFor(() => {
    const panel = detailsPanel();
    expect(panel).not.toBeNull();
    return panel as HTMLElement;
  });
}

/** Returns every occurrence of a text that is outside the Details panel. */
function textOutside(title: string, panel: HTMLElement | null): HTMLElement[] {
  return screen.queryAllByText(title).filter((element) => !panel?.contains(element));
}

/** Installs a scroll observer so the live-update assertion can accept "scrolled into view". */
function installScrollSpy() {
  const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll,
  });
  return {
    scroll,
    restore() {
      if (prior) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', prior);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    },
  };
}

/** True when the live item was announced in a live region or scrolled into view. */
function announcedOrScrolled(title: string, scroll: ReturnType<typeof vi.fn>): boolean {
  const announced = [
    ...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]'),
  ].some((element) => element.textContent?.includes(title));
  const scrolled = (scroll.mock.contexts as unknown[]).some(
    (context) => context instanceof Element && context.textContent?.includes(title)
  );
  return announced || scrolled;
}

/** Builds a Thread whose running Turn emits one approval after the Thread is already open. */
function makeLiveApprovalClient(): CoreClient {
  let approvalArrived = false;
  let attentionCalls = 0;
  const attention = vi.fn().mockImplementation(async () => {
    attentionCalls += 1;
    return { items: attentionCalls > 1 && approvalArrived ? [approvalAttentionRow()] : [] };
  });
  const subscribeTurnEvents = vi.fn().mockImplementation(() => {
    async function* stream() {
      yield turnStreamEvent(1, 'item.created', {
        type: 'item-created',
        item: approvalRequest(),
      });
      approvalArrived = true;
      await new Promise(() => {});
    }
    return stream();
  });
  return makeClient({
    navigation: [navigationRow(THREAD_ID, 'Ship the notes', 'chat', 'working')],
    attention,
    threadItems: vi.fn().mockResolvedValue({
      items: [userMessage(), assistantMessage(), toolCall(TOOL_ITEM_ID, TOOL_TITLE)],
      nextCursor: null,
    }),
    dashboard: vi
      .fn()
      .mockResolvedValue(threadDashboard({ turns: [runningTurn()], participants: participants() })),
    subscribeTurnEvents,
  });
}

/** Asserts the live approval is inline, announced or located, and counted for the surface. */
async function expectLiveApproval(surface: 'desktop' | 'phone', scroll: ReturnType<typeof vi.fn>) {
  const title = await screen.findByText(APPROVAL_TITLE);
  const needsYou = screen.getAllByText('Needs you').find((element) => !element.closest('nav'));
  expect(needsYou).toBeDefined();
  expectBefore(needsYou as HTMLElement, title);

  const details = detailsPanel();
  expect(textOutside(APPROVAL_TITLE, details).length).toBeGreaterThan(0);
  expect(textOutside(TOOL_TITLE, details)).toHaveLength(0);
  expect(screen.getAllByRole('button', { name: 'Show steps' }).length).toBeGreaterThan(0);

  await waitFor(() => expect(announcedOrScrolled(APPROVAL_TITLE, scroll)).toBe(true));

  if (surface === 'desktop') {
    const actionCenter = screen.getByRole('button', { name: /^Action Center/ });
    await waitFor(() => expect(within(actionCenter).getByText('1')).toBeInTheDocument(), {
      timeout: 8_000,
    });
    return;
  }

  const navigation = screen.getByRole('navigation', { name: 'Sections' });
  const user = userEvent.setup();
  await user.click(within(navigation).getByRole('button', { name: 'Work' }));
  const tasks = await screen.findByRole('tab', { name: /^Tasks/ });
  await waitFor(() => expect(within(tasks).getByText('1')).toBeInTheDocument(), {
    timeout: 8_000,
  });
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

describe('P4 timeline disclosure', () => {
  it('shows a live approval inline, announces it, and counts it in the Action Center while tool steps stay collapsed', async () => {
    const spy = installScrollSpy();
    try {
      const desktop = makeLiveApprovalClient();
      const desktopView = renderAt(THREAD_PATH, desktop);
      await expectLiveApproval('desktop', spy.scroll);
      desktopView.unmount();

      setViewportWidth(360);
      const phone = makeLiveApprovalClient();
      renderAt(THREAD_PATH, phone);
      await expectLiveApproval('phone', spy.scroll);
    } finally {
      spy.restore();
    }
  });

  it('shows one progress line with elapsed time and the step title and updates it on a new tool call without a tool card', async () => {
    const startedAt = new Date(Date.now() - 12_000).toISOString();
    let release: (() => void) | undefined;
    const subscribeTurnEvents = vi.fn().mockImplementation(() => {
      async function* stream() {
        yield turnStreamEvent(1, 'item.created', {
          type: 'item-created',
          item: toolCall(NEXT_TOOL_ITEM_ID, NEXT_TOOL_TITLE, 'in_progress'),
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return stream();
    });
    const client = makeClient({
      navigation: [navigationRow(THREAD_ID, 'Ship the notes', 'chat', 'working')],
      threadItems: vi.fn().mockResolvedValue({
        items: [
          userMessage(),
          assistantMessage(),
          toolCall(TOOL_ITEM_ID, TOOL_TITLE, 'in_progress'),
        ],
        nextCursor: null,
      }),
      dashboard: vi
        .fn()
        .mockResolvedValue(
          threadDashboard({ turns: [runningTurn(startedAt)], participants: participants() })
        ),
      subscribeTurnEvents,
    });
    renderAt(THREAD_PATH, client);

    const initial = await waitFor(() => {
      const line = screen
        .getAllByRole('status')
        .find((element) => element.textContent?.includes(TOOL_TITLE));
      expect(line).toBeDefined();
      return line as HTMLElement;
    });
    expect(initial).toHaveTextContent('Sam');
    expect(initial).toHaveTextContent(/running/i);
    expect(initial).toHaveTextContent(/\b\d+\s*(?:s|sec|secs|second|seconds)\b/i);
    expect(
      screen.getAllByRole('status').filter((element) => element.textContent?.includes(TOOL_TITLE))
    ).toHaveLength(1);

    const updated = await waitFor(() => {
      const line = screen
        .getAllByRole('status')
        .find((element) => element.textContent?.includes(NEXT_TOOL_TITLE));
      expect(line).toBeDefined();
      return line as HTMLElement;
    });
    expect(updated).toHaveTextContent('Sam');
    expect(updated).toHaveTextContent(/running/i);
    expect(updated).toHaveTextContent(/\b\d+\s*(?:s|sec|secs|second|seconds)\b/i);

    const details = detailsPanel();
    expect(textOutside(TOOL_TITLE, details)).toHaveLength(0);
    const nextOutside = textOutside(NEXT_TOOL_TITLE, details);
    expect(nextOutside.length).toBeGreaterThan(0);
    for (const element of nextOutside) {
      expect(element.closest('[role="status"]')).not.toBeNull();
    }
    release?.();
  });

  it('hides a tool-call item from the transcript and shows it in Details', async () => {
    const client = makeClient({
      navigation: [navigationRow(THREAD_ID, 'Ship the notes', 'chat')],
      threadItems: vi.fn().mockResolvedValue({
        items: [userMessage(), toolCall(TOOL_ITEM_ID, TOOL_TITLE)],
        nextCursor: null,
      }),
      dashboard: vi
        .fn()
        .mockResolvedValue(
          threadDashboard({ turns: [completedTurn()], participants: participants() })
        ),
    });
    renderAt(THREAD_PATH, client);

    await screen.findByText(USER_TEXT);
    const details = await findDetailsPanel();
    expect(within(details).getByText(TOOL_TITLE)).toBeVisible();
    expect(textOutside(TOOL_TITLE, details)).toHaveLength(0);
  });

  it('shows an approval item in the transcript with its decision on the card', async () => {
    const client = makeClient({
      navigation: [navigationRow(THREAD_ID, 'Ship the notes', 'chat')],
      threadItems: vi.fn().mockResolvedValue({
        items: [userMessage(), approvalRequest()],
        nextCursor: null,
      }),
      dashboard: vi.fn().mockResolvedValue(
        threadDashboard({
          turns: [completedTurn()],
          participants: participants(),
          pendingRequests: [pendingApproval()],
        })
      ),
    });
    renderAt(THREAD_PATH, client);

    await screen.findByText(APPROVAL_TITLE);
    const details = await findDetailsPanel();
    expect(textOutside(APPROVAL_TITLE, details).length).toBeGreaterThan(0);

    const needsYou = screen.getAllByText('Needs you').find((element) => !element.closest('nav'));
    expect(needsYou).toBeDefined();
    expectBefore(needsYou as HTMLElement, screen.getByText(APPROVAL_TITLE));

    const approve = screen.getByRole('button', { name: 'Approve' });
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(approve).toBeVisible();
    expect(deny).toBeVisible();
    expect(details.contains(approve)).toBe(false);
    expect(details.contains(deny)).toBe(false);
  });

  it('keeps thread.items unpaged when nextCursor is null and shows no Load earlier control', async () => {
    const threadItems = vi.fn().mockResolvedValue({
      items: [userMessage(), assistantMessage()],
      nextCursor: null,
    });
    const client = makeClient({
      navigation: [navigationRow(THREAD_ID, 'Ship the notes', 'chat')],
      threadItems,
      dashboard: vi
        .fn()
        .mockResolvedValue(
          threadDashboard({ turns: [completedTurn()], participants: participants() })
        ),
    });
    renderAt(THREAD_PATH, client);

    await screen.findByText(USER_TEXT);
    await waitFor(() => expect(threadItems).toHaveBeenCalled());

    for (const call of threadItems.mock.calls) {
      const input = call[0] as Record<string, unknown>;
      expect(input).not.toHaveProperty('limit');
      expect(input).not.toHaveProperty('since');
      expect(input).not.toHaveProperty('cursor');
    }
    expect(screen.queryByRole('button', { name: 'Load earlier' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Load earlier' })).not.toBeInTheDocument();
  });

  it('shows Load earlier only with a non-null nextCursor and sends limit with the cursor', async () => {
    const user = userEvent.setup();
    const threadItems = vi
      .fn()
      .mockResolvedValueOnce({
        items: [userMessage(), assistantMessage()],
        nextCursor: CURSOR,
      })
      .mockResolvedValue({ items: [earlierMessage()], nextCursor: null });
    const client = makeClient({
      navigation: [navigationRow(THREAD_ID, 'Ship the notes', 'chat')],
      threadItems,
      dashboard: vi
        .fn()
        .mockResolvedValue(
          threadDashboard({ turns: [completedTurn()], participants: participants() })
        ),
    });
    renderAt(THREAD_PATH, client);

    await screen.findByText(USER_TEXT);
    const loadEarlier = await screen.findByRole('button', { name: 'Load earlier' });
    expect(loadEarlier).toBeVisible();

    await user.click(loadEarlier);

    await waitFor(() => {
      const calls = threadItems.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(
        calls.some((input) => input.limit !== undefined && Object.values(input).includes(CURSOR))
      ).toBe(true);
    });

    const loadCall = threadItems.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((input) => Object.values(input).includes(CURSOR));
    expect(loadCall).toBeDefined();
    expect(loadCall).toHaveProperty('limit');

    expect(await screen.findByText(EARLIER_TEXT)).toBeVisible();
    expect(screen.getByText(USER_TEXT)).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load earlier' })).not.toBeInTheDocument()
    );
  });
});
