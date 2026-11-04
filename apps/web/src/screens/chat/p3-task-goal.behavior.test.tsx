import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';

const PERSISTENT_NAV_QUERY = '(min-width: 800px)';
const WORKSPACE_ID = 'ws_019a0000-0000-7000-8000-000000000101';
const ASSISTANT_THREAD_ID = 'th_019a0000-0000-7000-8000-000000000103';
const DRAFT_THREAD_ID = 'th_019a0000-0000-7000-8000-000000000104';
const RECEIVING_THREAD_ID = 'th_019a0000-0000-7000-8000-000000000105';
const GOAL_THREAD_ID = 'th_019a0000-0000-7000-8000-000000000106';
const SHARED_SOURCE_THREAD_ID = 'th_019a0000-0000-7000-8000-000000000107';
const USER_ID = 'usr_019a0000-0000-7000-8000-000000000108';
const OTHER_WORKSPACE_ID = 'ws_019a0000-0000-7000-8000-000000000102';
const SHARED_STORAGE_REF = 'wst_019a0000-0000-7000-8000-000000000301';
const TIMESTAMP = '2026-11-05T00:00:00.000Z';

const ASSISTANT_TARGET = {
  targetRef: 'internal-role:assistant',
  kind: 'assistant' as const,
  label: 'Assistant',
  description: 'Workspace assistant',
  availability: 'available' as const,
  unavailableReason: null,
  threadId: null,
  profileId: null,
  logicalModels: [
    {
      id: 'default',
      label: 'Default',
      capabilities: ['chat', 'reasoning'],
      reasoningEffortLevels: ['low', 'high'],
    },
  ],
  defaultLogicalModelId: 'default',
};

const NEW_TASK_TARGET = {
  targetRef: 'new-task-worker',
  kind: 'new-task-worker' as const,
  label: 'New task worker',
  description: 'Start a task worker',
  availability: 'available' as const,
  unavailableReason: null,
  threadId: null,
  profileId: null,
  logicalModels: [
    {
      id: 'default',
      label: 'Default',
      capabilities: ['chat', 'reasoning'],
      reasoningEffortLevels: ['low', 'high'],
    },
  ],
  defaultLogicalModelId: 'default',
};

let viewportWidth = 1024;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
const originalMatchMedia = window.matchMedia;

type User = ReturnType<typeof userEvent.setup>;

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

/** Builds the catalog shared by the Assistant composer and the New Task dialog. */
function targetCatalog() {
  return {
    workspaceId: WORKSPACE_ID,
    threadId: null,
    defaultTargetRef: ASSISTANT_TARGET.targetRef,
    targets: [ASSISTANT_TARGET, NEW_TASK_TARGET],
  };
}

/** Builds one structured conversation response that names a distinct receiving thread. */
function chatResponse(originatingThreadId: string, receivingThreadId: string, targetRef: string) {
  const turnId = 'tu_019a0000-0000-7000-8000-000000000201';
  const itemId = 'it_019a0000-0000-7000-8000-000000000202';
  return {
    outcome: 'accepted' as const,
    explanation: 'Accepted.',
    turn: {
      id: turnId,
      owner: { kind: 'workspace' as const, workspaceId: WORKSPACE_ID },
      threadId: receivingThreadId,
      triggerActor: { kind: 'user' as const, id: USER_ID },
      items: [],
      error: null,
      configVersion: null,
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      durationMs: 0,
      status: 'completed' as const,
    },
    item: {
      id: itemId,
      owner: { kind: 'workspace' as const, workspaceId: WORKSPACE_ID },
      threadId: receivingThreadId,
      turnId,
      type: 'assistant-message' as const,
      status: 'completed' as const,
      text: 'Accepted.',
      createdAt: TIMESTAMP,
      completedAt: TIMESTAMP,
    },
    handoff: null,
    originatingWorkspaceId: WORKSPACE_ID,
    originatingThreadId,
    receivingWorkspaceId: WORKSPACE_ID,
    receivingThreadId,
    targetRef,
    logicalModelId: 'default',
  };
}

/** Builds one Goal view as returned by goal.create and goal.read. */
function goalView(intent: string) {
  return {
    goal: {
      goalId: 'gl_019a0000-0000-7000-8000-000000000401',
      workspaceId: WORKSPACE_ID,
      threadId: GOAL_THREAD_ID,
      responsibleUserId: USER_ID,
      intent,
      intentRevision: 1,
      responsibleActorContext: { userId: USER_ID, kind: 'local' as const },
      intentHistory: [],
      proposedPlanVersionId: null,
      activePlanVersionId: null,
      disposition: null,
      changeRevision: 1,
      consideredRevision: 1,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    cards: [],
    versions: [],
    tasks: [],
    requests: [],
  };
}

/** Builds one catalog-listed Workspace-shared Sandbox with no host path or credential detail. */
function sharedEnvironment() {
  return {
    attachmentGeneration: 0,
    contributors: [
      {
        attachmentGeneration: 1,
        createdAt: TIMESTAMP,
        goalId: null,
        purpose: 'work' as const,
        responsibleUserId: USER_ID,
        taskId: null,
        threadId: SHARED_SOURCE_THREAD_ID,
      },
    ],
    createdAt: TIMESTAMP,
    layout: {
      family: null,
      version: null,
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'arm64', os: 'linux' },
      targets: [{ target: '/workspace' }],
    },
    layoutDigest: `sha256:${'a'.repeat(64)}`,
    revision: 4,
    state: 'idle' as const,
    storageRef: SHARED_STORAGE_REF,
    updatedAt: TIMESTAMP,
    workspaceId: WORKSPACE_ID,
  };
}

interface ClientOptions {
  navigation?: ReturnType<typeof navigationRow>[];
  navigationOperation?: ReturnType<typeof vi.fn>;
  targets?: object;
  threads?: ReturnType<typeof threadRecord>[];
  createThread?: ReturnType<typeof vi.fn>;
  submitConversation?: ReturnType<typeof vi.fn>;
  goalCreate?: ReturnType<typeof vi.fn>;
  goal?: ReturnType<typeof goalView>;
  workerEnvironments?: ReturnType<typeof sharedEnvironment>[];
}

/** Builds the minimal Core Client used by the routed shell, lists, dialogs, and timelines. */
function makeClient(options: ClientOptions = {}): CoreClient {
  const goal = options.goal ?? goalView('Plan the launch');
  const createThread =
    options.createThread ?? vi.fn().mockResolvedValue(threadRecord(DRAFT_THREAD_ID, 'Task draft'));
  const submitConversation =
    options.submitConversation ??
    vi
      .fn()
      .mockResolvedValue(
        chatResponse(ASSISTANT_THREAD_ID, ASSISTANT_THREAD_ID, ASSISTANT_TARGET.targetRef)
      );
  const readThread = (threadId: string) =>
    threadRecord(
      threadId,
      threadId === ASSISTANT_THREAD_ID
        ? 'Assistant'
        : threadId === GOAL_THREAD_ID
          ? 'Plan the launch'
          : 'Task draft'
    );

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
            ownerUserId: USER_ID,
            membershipRevision: 1,
            registryRevision: 1,
          },
        ],
      }),
      'workspace.resources': vi
        .fn()
        .mockResolvedValue({ knowledge: [], skills: [], agents: [], models: [] }),
      'conversation.navigation':
        options.navigationOperation ??
        vi.fn().mockResolvedValue({ items: options.navigation ?? [] }),
      'attention.list': vi.fn().mockResolvedValue({ items: [] }),
      'thread.list': vi.fn().mockResolvedValue({ items: options.threads ?? [] }),
      'thread.create': createThread,
      'conversation.submit': submitConversation,
      'conversation.targets': vi
        .fn()
        .mockResolvedValue(
          (options.targets ?? targetCatalog()) as ReturnType<typeof targetCatalog>
        ),
      'task.start': vi.fn(),
      'worker-environment.list': vi
        .fn()
        .mockResolvedValue({ items: options.workerEnvironments ?? [], nextCursor: null }),
      'worker-environment.select': vi.fn().mockImplementation(async ({ storageRef }) => ({
        selected:
          (options.workerEnvironments ?? []).find(
            (environment) => environment.storageRef === storageRef
          ) ?? null,
      })),
      'thread.read': vi.fn().mockImplementation(async ({ threadId }) => readThread(threadId)),
      'thread.dashboard': vi.fn().mockImplementation(async ({ threadId }) => ({
        turns: [],
        pendingRequests: [],
        artifacts: [],
        taskInputs: [],
        participants: [],
        thread: readThread(threadId),
        viewerUserId: null,
        workStatus: null,
        composer: { disabled: false, defaultAgentId: null },
        itemLog: { href: '' },
      })),
      'thread.items': vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      'artifact.list': vi.fn().mockResolvedValue({ items: [] }),
      'goal.create': options.goalCreate ?? vi.fn().mockResolvedValue(goal),
      'goal.read': vi.fn().mockResolvedValue(goal),
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

/** Opens New Task from the desktop Tasks list. */
async function openDesktopNewTask(user: User) {
  const navigation = await screen.findByRole('navigation', {
    name: 'Primary workspace navigation',
  });
  await user.click(await within(navigation).findByRole('button', { name: 'New Task' }));
  return await screen.findByRole('dialog', { name: 'New Task' });
}

/** Opens New Goal from the desktop Goals list. */
async function openDesktopNewGoal(user: User) {
  const navigation = await screen.findByRole('navigation', {
    name: 'Primary workspace navigation',
  });
  await user.click(await within(navigation).findByRole('button', { name: 'New Goal' }));
  return await screen.findByRole('dialog', { name: 'New Goal' });
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

describe('P3 Assistant composer', () => {
  it('sends a starter message on the existing Assistant thread without calling thread.create', async () => {
    const user = userEvent.setup();
    const createThread = vi.fn().mockResolvedValue(threadRecord(DRAFT_THREAD_ID, 'Task draft'));
    const submitConversation = vi
      .fn()
      .mockResolvedValue(
        chatResponse(ASSISTANT_THREAD_ID, ASSISTANT_THREAD_ID, ASSISTANT_TARGET.targetRef)
      );
    const client = makeClient({
      navigation: [navigationRow(ASSISTANT_THREAD_ID, 'Assistant', 'chat')],
      createThread,
      submitConversation,
    });
    renderAt('/chat', client);

    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Hello Assistant');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(createThread).not.toHaveBeenCalled();
    expect(submitConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        threadId: ASSISTANT_THREAD_ID,
        input: 'Hello Assistant',
        targetRef: ASSISTANT_TARGET.targetRef,
      })
    );
  });

  it('offers no Conversation agent control on the Assistant composer', async () => {
    renderAt(
      `/chat/${WORKSPACE_ID}/${ASSISTANT_THREAD_ID}`,
      makeClient({ navigation: [navigationRow(ASSISTANT_THREAD_ID, 'Assistant', 'chat')] })
    );

    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(await screen.findByRole('button', { name: /Logical model/ })).toBeVisible();
    expect(await screen.findByRole('button', { name: /effort/i })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add artifact or upload attachment' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeVisible();

    expect(screen.queryByRole('button', { name: /Conversation agent/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Conversation agent/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sandbox/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Sandbox/ })).not.toBeInTheDocument();
  });
});

describe('P3 New Task dialog', () => {
  it('opens the receiving Task thread rather than the created Task draft', async () => {
    const user = userEvent.setup();
    const created = threadRecord(DRAFT_THREAD_ID, 'Task draft');
    const receiving = threadRecord(RECEIVING_THREAD_ID, 'Fix the export');
    const createThread = vi.fn().mockResolvedValue(created);
    const submitConversation = vi
      .fn()
      .mockResolvedValue(chatResponse(created.id, receiving.id, NEW_TASK_TARGET.targetRef));
    const client = makeClient({
      navigation: [navigationRow(receiving.id, 'Fix the export', 'task')],
      createThread,
      submitConversation,
    });
    renderAt('/attention', client);

    const dialog = await openDesktopNewTask(user);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Brief' }),
      'Fix the export\nShow the failing jobs'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Start Task' }));

    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        name: 'Fix the export',
      })
    );
    expect(createThread).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Artifact task' })
    );
    expect(submitConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        threadId: created.id,
        input: 'Fix the export\nShow the failing jobs',
        targetRef: NEW_TASK_TARGET.targetRef,
      })
    );
    expect(client.operations['task.start']).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/tasks/${WORKSPACE_ID}/${receiving.id}`
      )
    );
    expect(screen.getByLabelText('Location')).not.toHaveTextContent(created.id);
  });

  it('names the Sandbox control, defaults to Fresh, and omits workerStorageChoice', async () => {
    const user = userEvent.setup();
    const submitConversation = vi
      .fn()
      .mockResolvedValue(
        chatResponse(DRAFT_THREAD_ID, RECEIVING_THREAD_ID, NEW_TASK_TARGET.targetRef)
      );
    renderAt(
      '/attention',
      makeClient({
        navigation: [navigationRow(RECEIVING_THREAD_ID, 'Fresh task', 'task')],
        submitConversation,
      })
    );

    const dialog = await openDesktopNewTask(user);
    const sandbox = within(dialog).getByRole('button', { name: /Sandbox/ });
    expect(sandbox).toHaveTextContent('Fresh');

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Brief' }),
      'Start a fresh Sandbox'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Start Task' }));

    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(submitConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Start a fresh Sandbox',
        targetRef: NEW_TASK_TARGET.targetRef,
      })
    );
    expect(submitConversation.mock.calls[0]?.[0]).not.toHaveProperty('workerStorageChoice');
  });

  it('shows the shared-Sandbox consequence and submits its storage choice', async () => {
    const user = userEvent.setup();
    const shared = sharedEnvironment();
    const submitConversation = vi
      .fn()
      .mockResolvedValue(
        chatResponse(DRAFT_THREAD_ID, RECEIVING_THREAD_ID, NEW_TASK_TARGET.targetRef)
      );
    renderAt(
      '/attention',
      makeClient({
        navigation: [navigationRow(RECEIVING_THREAD_ID, 'Shared task', 'task')],
        submitConversation,
        threads: [threadRecord(SHARED_SOURCE_THREAD_ID, 'Shared export work')],
        workerEnvironments: [shared],
      })
    );

    const dialog = await openDesktopNewTask(user);
    const sandbox = within(dialog).getByRole('button', { name: /Sandbox/ });
    expect(sandbox).toHaveTextContent('Fresh');

    await user.click(sandbox);
    const options = await screen.findAllByRole('option');
    const sharedOption = options.find(
      (option) => !/^Fresh\b/.test(option.textContent?.trim() ?? '')
    );
    expect(sharedOption).toBeDefined();
    await user.click(sharedOption!);

    const consequence = within(dialog).getByText(
      /keeps its files for later work in this Workspace/i
    );
    expect(consequence).toBeVisible();
    expect(consequence).toHaveTextContent(/working files/i);
    expect(consequence).toHaveTextContent(/native session data/i);
    expect(consequence).toHaveTextContent(/secrets placed in the Sandbox/i);
    const start = within(dialog).getByRole('button', { name: 'Start Task' });
    expectBefore(consequence, start);

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Brief' }),
      'Reuse the shared Sandbox'
    );
    await user.click(start);

    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(submitConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Reuse the shared Sandbox',
        workerStorageChoice: expect.objectContaining({
          kind: 'selected',
          storageRef: SHARED_STORAGE_REF,
        }),
      })
    );
  });

  it('keeps the New Task brief after a failed submit', async () => {
    const user = userEvent.setup();
    const submitConversation = vi.fn().mockRejectedValue(new Error('Submit failed'));
    renderAt(
      '/attention',
      makeClient({
        navigation: [navigationRow(RECEIVING_THREAD_ID, 'Failed task', 'task')],
        submitConversation,
      })
    );

    const dialog = await openDesktopNewTask(user);
    const brief = within(dialog).getByRole('textbox', { name: 'Brief' });
    await user.type(brief, 'Keep this brief');
    await user.click(within(dialog).getByRole('button', { name: 'Start Task' }));

    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole('textbox', { name: 'Brief' })).toHaveValue('Keep this brief');
    expect(dialog).toBeVisible();
  });

  it('shows no Shard, host path, credential, or AgentSession', async () => {
    const user = userEvent.setup();
    renderAt('/attention', makeClient());

    const dialog = await openDesktopNewTask(user);
    expect(dialog).not.toHaveTextContent(/shard/i);
    expect(dialog).not.toHaveTextContent(/agent\s*session/i);
    expect(dialog).not.toHaveTextContent(/credential/i);
    expect(dialog).not.toHaveTextContent(/\/(?:home|Users|var|tmp)\//);

    expect(within(dialog).queryByRole('textbox', { name: /shard/i })).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('textbox', { name: /agent\s*session/i })
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: /credential/i })).not.toBeInTheDocument();
  });

  it('opens New Task from the phone Work Tasks list', async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    renderAt('/work', makeClient());

    await user.click(await screen.findByRole('tab', { name: 'Tasks' }));
    await user.click(await screen.findByRole('button', { name: 'New Task' }));

    const dialog = await screen.findByRole('dialog', { name: 'New Task' });
    expect(within(dialog).getByRole('button', { name: 'Start Task' })).toBeVisible();
  });
});

describe('P3 New Goal dialog', () => {
  it('creates a Goal from the Goals list and opens the new Goal', async () => {
    const user = userEvent.setup();
    const created = goalView('Plan the launch');
    const goalCreate = vi.fn().mockResolvedValue(created);
    renderAt('/attention', makeClient({ goalCreate, goal: created }));

    const dialog = await openDesktopNewGoal(user);
    const intent = within(dialog).getByRole('textbox', { name: 'Goal intent' });
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(
      within(dialog).queryByRole('button', { name: /Logical model/i })
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /effort/i })).not.toBeInTheDocument();

    await user.type(intent, 'Plan the launch');
    await user.click(within(dialog).getByRole('button', { name: /Create Goal|Start Goal/ }));

    await waitFor(() => expect(goalCreate).toHaveBeenCalledTimes(1));
    expect(goalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        requestId: expect.any(String),
        intent: 'Plan the launch',
      })
    );
    expect(goalCreate.mock.calls[0]?.[0]).not.toHaveProperty('originThreadId');

    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/goals/${WORKSPACE_ID}/${GOAL_THREAD_ID}`
      )
    );
  });
});

/** Adds a second Workspace so a switch is an authorized selection, not a cleared one. */
function allowWorkspaceSwitch(client: CoreClient) {
  (client.operations['workspace.list'] as ReturnType<typeof vi.fn>).mockResolvedValue({
    items: [
      { id: WORKSPACE_ID, name: 'Alpha' },
      { id: OTHER_WORKSPACE_ID, name: 'Beta' },
    ].map((workspace) => ({
      workspace: { ...workspace, kind: 'general' },
      membershipStatus: 'active',
      accessCause: 'membership',
      effectiveRole: 'owner',
      isOwner: true,
      ownerUserId: USER_ID,
      membershipRevision: 1,
      registryRevision: 1,
    })),
  });
}

describe('P3 review: Assistant admission', () => {
  it('does not send the Assistant composer to a Worker when the Assistant is unavailable', async () => {
    const createThread = vi.fn();
    const submitConversation = vi.fn();
    const client = makeClient({
      createThread,
      submitConversation,
      targets: {
        workspaceId: WORKSPACE_ID,
        threadId: null,
        defaultTargetRef: NEW_TASK_TARGET.targetRef,
        targets: [
          { ...ASSISTANT_TARGET, availability: 'unavailable', unavailableReason: 'Not configured' },
          NEW_TASK_TARGET,
        ],
      },
    });
    renderAt('/chat', client);

    expect(await screen.findByText('The Assistant is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Conversation agent/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(createThread).not.toHaveBeenCalled();
    expect(submitConversation).not.toHaveBeenCalled();
  });

  it('waits for navigation before it will create an Assistant thread', async () => {
    const user = userEvent.setup();
    const pending: Array<(value: { items: ReturnType<typeof navigationRow>[] }) => void> = [];
    const createThread = vi.fn();
    const submitConversation = vi
      .fn()
      .mockResolvedValue(
        chatResponse(ASSISTANT_THREAD_ID, ASSISTANT_THREAD_ID, ASSISTANT_TARGET.targetRef)
      );
    const client = makeClient({
      createThread,
      submitConversation,
      navigationOperation: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            pending.push(resolve);
          })
      ),
    });
    renderAt('/chat', client);

    const input = await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.getByText('Checking the Assistant.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.type(input, 'Hello Assistant');
    expect(createThread).not.toHaveBeenCalled();
    expect(submitConversation).not.toHaveBeenCalled();

    await act(async () => {
      for (const resolve of pending) {
        resolve({ items: [navigationRow(ASSISTANT_THREAD_ID, 'Assistant', 'chat')] });
      }
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(createThread).not.toHaveBeenCalled();
    expect(submitConversation).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: ASSISTANT_THREAD_ID, input: 'Hello Assistant' })
    );
  });

  it('retries a failed Assistant navigation read instead of creating a thread', async () => {
    const user = userEvent.setup();
    const createThread = vi.fn();
    const navigation = vi.fn().mockRejectedValue(new Error('Navigation failed'));
    const client = makeClient({ createThread, navigationOperation: navigation });
    renderAt('/chat', client);

    expect(await screen.findByText("Couldn't load the Assistant.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load recent chats.");
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(navigation.mock.calls.length).toBeGreaterThan(1));
    expect(createThread).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('keeps the Assistant brief when classification is missing and retries that read', async () => {
    const user = userEvent.setup();
    const rows = {
      current: [navigationRow(ASSISTANT_THREAD_ID, 'Assistant', 'chat')],
    };
    const navigation = vi.fn().mockImplementation(async () => ({ items: rows.current }));
    const createThread = vi.fn();
    const submitConversation = vi
      .fn()
      .mockResolvedValue(
        chatResponse(ASSISTANT_THREAD_ID, RECEIVING_THREAD_ID, ASSISTANT_TARGET.targetRef)
      );
    const client = makeClient({
      createThread,
      submitConversation,
      navigationOperation: navigation,
    });
    renderAt('/chat', client);

    const input = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(input, 'Hand off this work');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server did not classify that thread.');
    expect(input).toHaveValue('Hand off this work');
    expect(submitConversation).toHaveBeenCalledTimes(1);
    expect(createThread).not.toHaveBeenCalled();
    const requestId = submitConversation.mock.calls[0]?.[0]?.requestId;

    rows.current = [
      navigationRow(ASSISTANT_THREAD_ID, 'Assistant', 'chat'),
      navigationRow(RECEIVING_THREAD_ID, 'Receiving task', 'task'),
    ];
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/tasks/${WORKSPACE_ID}/${RECEIVING_THREAD_ID}`
      )
    );
    expect(submitConversation).toHaveBeenCalledTimes(1);
    expect(submitConversation.mock.calls[0]?.[0]?.requestId).toBe(requestId);
    expect(createThread).not.toHaveBeenCalled();
  });
});

describe('P3 review: New Task admission and Workspace scope', () => {
  it('confirms file handoff before a Worker submission and reuses that consent', async () => {
    const user = userEvent.setup();
    const submitConversation = vi.fn().mockRejectedValue(new Error('Submit failed'));
    const client = makeClient({
      navigation: [navigationRow(RECEIVING_THREAD_ID, 'Task', 'task')],
      submitConversation,
      targets: {
        ...targetCatalog(),
        targets: [
          ASSISTANT_TARGET,
          {
            ...NEW_TASK_TARGET,
            requiresFileHandoffConfirmation: true,
            label: 'New Shard + Worker',
          },
        ],
      },
    });
    renderAt('/attention', client);

    const dialog = await openDesktopNewTask(user);
    const file = new File(['notes'], 'export.txt', { type: 'text/plain' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Brief' }), 'Ship the notes');
    await user.upload(within(dialog).getByLabelText('Task files'), file);
    await user.click(within(dialog).getByRole('button', { name: 'Start Task' }));

    const confirmation = await screen.findByRole('dialog', {
      name: 'Share selected files with Worker',
    });
    expect(within(confirmation).getByText('Alpha', { exact: true })).toBeInTheDocument();
    expect(within(confirmation).getByLabelText('Work brief')).toHaveTextContent('Ship the notes');
    expect(within(confirmation).getByText('export.txt', { exact: true })).toBeInTheDocument();
    expect(submitConversation).not.toHaveBeenCalled();
    expect(confirmation).not.toHaveTextContent(/shard/i);

    await user.click(within(confirmation).getByRole('button', { name: 'Share files and send' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    const first = submitConversation.mock.calls[0]?.[0];
    expect(first).toEqual(
      expect.objectContaining({
        input: 'Ship the notes',
        fileHandoffConfirmed: true,
        requestId: expect.any(String),
      })
    );
    expect(within(dialog).getByRole('textbox', { name: 'Brief' })).toHaveValue('Ship the notes');

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole('dialog', { name: 'Share selected files with Worker' })
    ).not.toBeInTheDocument();
    expect(submitConversation.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        input: 'Ship the notes',
        fileHandoffConfirmed: true,
        requestId: first.requestId,
      })
    );
  });

  it('does not show the catalog Shard label for the default New Task target', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      targets: {
        ...targetCatalog(),
        targets: [
          ASSISTANT_TARGET,
          { ...NEW_TASK_TARGET, label: 'New Shard + Worker' },
          {
            ...NEW_TASK_TARGET,
            targetRef: 'warm-worker:agent_codex_host:default',
            kind: 'warm-worker',
            label: 'Codex Agent',
          },
        ],
      },
    });
    renderAt('/attention', client);

    const dialog = await openDesktopNewTask(user);
    await user.click(within(dialog).getByText('Someone already available'));
    expect(dialog).not.toHaveTextContent(/shard/i);
    expect(within(dialog).getByRole('button', { name: 'New Task worker' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Codex Agent' })).toBeInTheDocument();
  });

  it('drops a failed New Task when the Workspace changes and retries in the new Workspace', async () => {
    const user = userEvent.setup();
    const betaDraftId = 'th_019a0000-0000-7000-8000-000000000109';
    const createThread = vi
      .fn()
      .mockResolvedValueOnce(threadRecord(DRAFT_THREAD_ID, 'Alpha draft'))
      .mockResolvedValueOnce(threadRecord(betaDraftId, 'Beta draft'));
    const submitConversation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Submit failed'))
      .mockResolvedValue(
        chatResponse(DRAFT_THREAD_ID, RECEIVING_THREAD_ID, NEW_TASK_TARGET.targetRef)
      );
    const client = makeClient({
      navigation: [navigationRow(RECEIVING_THREAD_ID, 'Receiving task', 'task')],
      createThread,
      submitConversation,
    });
    allowWorkspaceSwitch(client);
    renderAt('/attention', client);

    const dialog = await openDesktopNewTask(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Brief' }), 'Keep Alpha');
    await user.click(within(dialog).getByRole('button', { name: 'Start Task' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(submitConversation.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_ID);

    await act(async () => {
      useWorkspaceStore.setState({ currentWorkspaceId: OTHER_WORKSPACE_ID });
    });
    expect(screen.queryByDisplayValue('Keep Alpha')).not.toBeInTheDocument();
    const next = await openDesktopNewTask(user);
    expect(within(next).getByRole('textbox', { name: 'Brief' })).toHaveValue('');
    await user.type(within(next).getByRole('textbox', { name: 'Brief' }), 'Beta task');
    await user.click(within(next).getByRole('button', { name: 'Start Task' }));

    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(2));
    expect(submitConversation.mock.calls[1]?.[0]?.workspaceId).toBe(OTHER_WORKSPACE_ID);
    expect(submitConversation.mock.calls[1]?.[0]?.input).toBe('Beta task');
    expect(submitConversation.mock.calls[1]?.[0]?.threadId).toBe(betaDraftId);
    expect(createThread.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_ID);
    expect(createThread.mock.calls[1]?.[0]?.workspaceId).toBe(OTHER_WORKSPACE_ID);
  });

  it('does not open a Task after the Workspace changes during submit', async () => {
    const user = userEvent.setup();
    let release: (value: ReturnType<typeof chatResponse>) => void = () => undefined;
    const submitConversation = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const client = makeClient({
      navigation: [navigationRow(RECEIVING_THREAD_ID, 'Receiving task', 'task')],
      submitConversation,
    });
    allowWorkspaceSwitch(client);
    renderAt('/attention', client);

    const dialog = await openDesktopNewTask(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Brief' }), 'In flight');
    await user.click(within(dialog).getByRole('button', { name: 'Start Task' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));

    await act(async () => {
      useWorkspaceStore.setState({ currentWorkspaceId: OTHER_WORKSPACE_ID });
    });
    await act(async () => {
      release(chatResponse(DRAFT_THREAD_ID, RECEIVING_THREAD_ID, NEW_TASK_TARGET.targetRef));
    });
    await waitFor(() => expect(screen.getByLabelText('Location')).toHaveTextContent('/attention'));
    expect(screen.getByLabelText('Location')).not.toHaveTextContent(RECEIVING_THREAD_ID);
    expect(screen.queryByDisplayValue('In flight')).not.toBeInTheDocument();
  });
});

describe('P3 review: New Goal Workspace scope', () => {
  it('drops a failed Goal intent when the Workspace changes', async () => {
    const user = userEvent.setup();
    const goalCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Create failed'))
      .mockResolvedValue(goalView('Beta goal'));
    const client = makeClient({ goalCreate, goal: goalView('Beta goal') });
    allowWorkspaceSwitch(client);
    renderAt('/attention', client);

    const dialog = await openDesktopNewGoal(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Goal intent' }), 'Keep Alpha');
    await user.click(within(dialog).getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(goalCreate).toHaveBeenCalledTimes(1));
    expect(goalCreate.mock.calls[0]?.[0]?.workspaceId).toBe(WORKSPACE_ID);

    await act(async () => {
      useWorkspaceStore.setState({ currentWorkspaceId: OTHER_WORKSPACE_ID });
    });
    const next = await openDesktopNewGoal(user);
    expect(within(next).getByRole('textbox', { name: 'Goal intent' })).toHaveValue('');
    await user.type(within(next).getByRole('textbox', { name: 'Goal intent' }), 'Beta goal');
    await user.click(within(next).getByRole('button', { name: 'Create Goal' }));

    await waitFor(() => expect(goalCreate).toHaveBeenCalledTimes(2));
    expect(goalCreate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ workspaceId: OTHER_WORKSPACE_ID, intent: 'Beta goal' })
    );
    expect(goalCreate.mock.calls[1]?.[0]?.requestId).not.toBe(
      goalCreate.mock.calls[0]?.[0]?.requestId
    );
  });

  it('does not open a Goal after the Workspace changes during create', async () => {
    const user = userEvent.setup();
    let release: (value: ReturnType<typeof goalView>) => void = () => undefined;
    const goalCreate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const client = makeClient({ goalCreate });
    allowWorkspaceSwitch(client);
    renderAt('/attention', client);

    const dialog = await openDesktopNewGoal(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Goal intent' }), 'In flight');
    await user.click(within(dialog).getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(goalCreate).toHaveBeenCalledTimes(1));

    await act(async () => {
      useWorkspaceStore.setState({ currentWorkspaceId: OTHER_WORKSPACE_ID });
    });
    await act(async () => {
      release(goalView('In flight'));
    });
    await waitFor(() => expect(screen.getByLabelText('Location')).toHaveTextContent('/attention'));
    expect(screen.getByLabelText('Location')).not.toHaveTextContent('/goals/');
    expect(screen.queryByDisplayValue('In flight')).not.toBeInTheDocument();
  });
});
