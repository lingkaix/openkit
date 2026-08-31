import type { CoreClient } from '@openkit/core-client';
import { ItemSchema, TurnSchema, WorkspaceRecordSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';
import { chatKeys } from './data';

const THREAD = {
  id: 'th1',
  workspaceId: 'ws1',
  name: 'Competitive teardown',
  preview: 'Competitive teardown',
  status: 'active',
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

const CONVERSATION_TARGET = {
  workspaceId: 'ws1',
  threadId: null,
  defaultTargetRef: 'internal-role:assistant',
  targets: [
    {
      targetRef: 'internal-role:assistant',
      kind: 'assistant' as const,
      label: 'Assistant',
      description: 'Workspace assistant',
      availability: 'available' as const,
      unavailableReason: null,
      threadId: null,
      profileId: null,
      logicalModels: [{ id: 'default', label: 'Default', capabilities: ['chat'] }],
      defaultLogicalModelId: 'default',
    },
    {
      targetRef: 'warm-worker:agent_codex_host:default',
      kind: 'warm-worker' as const,
      label: 'Codex Agent',
      description: 'Reuse the configured Worker',
      availability: 'available' as const,
      unavailableReason: null,
      threadId: null,
      profileId: 'default',
      logicalModels: [{ id: 'default', label: 'Default', capabilities: ['chat'] }],
      defaultLogicalModelId: 'default',
    },
    {
      targetRef: 'new-task-worker',
      kind: 'new-task-worker' as const,
      label: 'New task worker',
      description: 'Start a task worker',
      availability: 'available' as const,
      unavailableReason: null,
      threadId: null,
      profileId: null,
      logicalModels: [{ id: 'default', label: 'Default', capabilities: ['chat'] }],
      defaultLogicalModelId: 'default',
    },
  ],
};

const ITEMS = ItemSchema.array().parse([
  {
    id: 'i1',
    workspaceId: 'ws1',
    threadId: 'th1',
    turnId: 't1',
    type: 'user-message',
    status: 'completed',
    actor: { kind: 'user', id: 'user_editor' },
    text: 'Draft a competitive teardown.',
    createdAt: '2026-07-21T00:00:00.000Z',
    completedAt: '2026-07-21T00:00:00.000Z',
  },
  {
    id: 'i2',
    workspaceId: 'ws1',
    threadId: 'th1',
    turnId: 't1',
    type: 'assistant-message',
    status: 'completed',
    text: 'On it — gathering the details.',
    createdAt: '2026-07-21T00:00:01.000Z',
    completedAt: '2026-07-21T00:00:01.000Z',
  },
  {
    id: 'i3',
    workspaceId: 'ws1',
    threadId: 'th1',
    type: 'approval-request',
    turnId: 't1',
    status: 'completed',
    approvalRequestId: 'ap1',
    title: 'Approve $5 spend',
    description: 'To pull competitor pricing.',
    kind: 'permission',
    createdAt: '2026-07-21T00:00:02.000Z',
    completedAt: '2026-07-21T00:00:02.000Z',
  },
]);

const USER_INPUT_ITEMS = ItemSchema.array().parse([
  {
    id: 'i-user-input',
    workspaceId: 'ws1',
    threadId: 'th1',
    turnId: 't1',
    type: 'user-input-request',
    status: 'completed',
    responsibleUserId: 'user_editor',
    userInputRequestId: 'uir1',
    prompt: 'Confirm the release shape.',
    questions: [
      {
        id: 'audience',
        header: 'Audience',
        question: 'Who should receive the release?',
        options: null,
        isOther: false,
        isSecret: false,
      },
      {
        id: 'tone',
        header: 'Tone',
        question: 'Which tone should the release use?',
        options: [
          { label: 'Concise', description: 'Keep the release brief.' },
          { label: 'Detailed', description: 'Include supporting detail.' },
        ],
        isOther: false,
        isSecret: false,
      },
    ],
    createdAt: '2026-07-21T00:00:02.000Z',
    completedAt: '2026-07-21T00:00:02.000Z',
  },
]);

type CoreOverrides = Partial<Record<string, unknown>>;
type AppOverrides = Partial<Record<string, unknown>>;

/** Creates a caller-controlled promise for proving pre-settlement UI state. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(core: CoreOverrides = {}, app: AppOverrides = {}): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({
        items: [
          { id: 'ws1', name: 'Market research' },
          { id: 'ws2', name: 'Second workspace' },
        ],
      }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      getThread: vi.fn().mockResolvedValue(THREAD),
      listThreadItems: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      startTurn: vi.fn().mockResolvedValue({ id: 'turn1' }),
      createThread: vi.fn().mockResolvedValue({ ...THREAD, id: 'th-new' }),
      respondApproval: vi.fn().mockResolvedValue({}),
      ...core,
    },
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
      getThreadDashboard: vi.fn().mockResolvedValue({ turns: [] }),
      getConversationTargets: vi.fn().mockImplementation((workspaceId: string, threadId?: string) =>
        Promise.resolve({
          ...CONVERSATION_TARGET,
          workspaceId,
          threadId: threadId ?? null,
        })
      ),
      ...app,
    },
  } as unknown as CoreClient;
}

/** Build one protocol-shaped turn-stream envelope for UI subscription tests. */
function turnStreamEvent(sequence: number, event: string, data: unknown) {
  return {
    protocolVersion: '0.4.0',
    event,
    sequence,
    requestId: null,
    timestamp: '2026-07-21T00:00:00.000Z',
    workspaceId: 'ws1',
    threadId: 'th1',
    turnId: 't1',
    data,
  };
}

const ACTIVE_TURN = TurnSchema.parse({
  id: 't1',
  workspaceId: 'ws1',
  threadId: 'th1',
  triggerActor: { kind: 'user', id: 'user_operator' },
  items: [],
  error: null,
  configVersion: null,
  startedAt: '2026-07-21T00:00:00.000Z',
  completedAt: null,
  durationMs: null,
  status: 'running',
  humanGate: null,
});

const COMPLETED_TURN = TurnSchema.parse({
  ...ACTIVE_TURN,
  status: 'completed',
  completedAt: '2026-07-21T00:00:02.000Z',
  durationMs: 2_000,
});

const CHAT_MODE_RESPONSE = {
  outcome: 'answered' as const,
  explanation: 'Answered in Chat Mode.',
  turn: COMPLETED_TURN,
  item: ITEMS[1],
  handoff: null,
  originatingWorkspaceId: 'ws1',
  originatingThreadId: 'th1',
  receivingWorkspaceId: 'ws1',
  receivingThreadId: 'th1',
  targetRef: 'internal-role:assistant',
  logicalModelId: 'default',
};

const STARTER_CHAT_MODE_RESPONSE = {
  ...CHAT_MODE_RESPONSE,
  originatingThreadId: 'th-new',
  receivingThreadId: 'th-new',
  turn: TurnSchema.parse({
    ...COMPLETED_TURN,
    id: 't-new',
    threadId: 'th-new',
  }),
  item: ItemSchema.parse({
    ...ITEMS[1],
    id: 'i-new',
    threadId: 'th-new',
    turnId: 't-new',
  }),
};

const TASK_MODE_RESPONSE = {
  turn: ACTIVE_TURN,
  state: 'running' as const,
  completion: null,
  evidence: { itemIds: [], artifactIds: [], reviewIds: [] },
  escalation: null,
};

const QUICK_CHAT_WORKSPACE = WorkspaceRecordSchema.parse({
  id: 'ws_quick_chat',
  name: 'Quick Chat',
  kind: 'quick-chat',
  status: 'active',
  counts: {
    threadCount: 1,
    artifactCount: 0,
    knowledgeEntryCount: 0,
  },
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
});

const QUICK_CHAT_MODE_RESPONSE = {
  ...CHAT_MODE_RESPONSE,
  originatingWorkspaceId: QUICK_CHAT_WORKSPACE.id,
  receivingWorkspaceId: QUICK_CHAT_WORKSPACE.id,
  turn: TurnSchema.parse({
    ...COMPLETED_TURN,
    workspaceId: QUICK_CHAT_WORKSPACE.id,
  }),
  item: ItemSchema.parse({
    ...ITEMS[1],
    workspaceId: QUICK_CHAT_WORKSPACE.id,
  }),
};

const SECOND_ASSISTANT_ITEM = ItemSchema.parse({
  ...ITEMS[1],
  id: 'i4',
  text: 'Here is the completed pricing comparison.',
  createdAt: '2026-07-21T00:00:02.000Z',
  completedAt: '2026-07-21T00:00:02.000Z',
});

const STREAMING_ITEM = {
  id: 'i-stream',
  workspaceId: 'ws1',
  threadId: 'th1',
  turnId: 't1',
  type: 'assistant-message',
  status: 'in_progress',
  text: '',
  createdAt: '2026-07-21T00:00:01.000Z',
  completedAt: null,
};

/**
 * Render one route with an isolated query cache and expose that public cache seam.
 *
 * @param path Initial application route.
 * @param client Core Client fake used by the rendered application.
 * @param prepareQueryClient Optional cache setup applied before the route mounts.
 * @returns The isolated TanStack Query client used by the render.
 */
function renderApp(
  path: string,
  client: CoreClient,
  prepareQueryClient?: (queryClient: QueryClient) => void
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  prepareQueryClient?.(queryClient);
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return queryClient;
}

/** Returns the persistent selected-Workspace switcher after discovery settles. */
function workspaceSelectTrigger(name = 'Market research'): Promise<HTMLElement> {
  return screen.findByRole('button', { name });
}

/** Switches the persistent Workspace context and opens one Thread from the starter list. */
async function switchToThread(
  user: ReturnType<typeof userEvent.setup>,
  currentWorkspaceName: string,
  nextWorkspaceName: string,
  threadName: string
) {
  await user.click(await workspaceSelectTrigger(currentWorkspaceName));
  await user.click(await screen.findByRole('menuitem', { name: nextWorkspaceName }));
  await user.click(
    await within(screen.getByRole('main', { name: 'Workspace' })).findByRole('button', {
      name: threadName,
    })
  );
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('chat starter (board 01)', () => {
  it('uses Quick Chat when no Workspace is selected', async () => {
    const listThreads = vi.fn().mockResolvedValue({ items: [] });
    const client = makeClient({
      listWorkspaces: vi.fn().mockResolvedValue({
        items: [
          { id: 'ws_project', name: 'Project Workspace', kind: 'general' },
          { id: 'ws_quick_chat', name: 'Quick Chat', kind: 'quick-chat' },
        ],
      }),
      listThreads,
    });

    renderApp('/chat', client);

    await waitFor(() => expect(listThreads).toHaveBeenCalledWith('ws_quick_chat'));
    expect(listThreads).not.toHaveBeenCalledWith('ws_project');
  });

  it('falls back from an unavailable selected Workspace before loading threads', async () => {
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_unavailable' });
    const workspaces = createDeferred<{
      items: { id: string; name: string; kind: 'general' | 'quick-chat' }[];
    }>();
    const listThreads = vi.fn().mockResolvedValue({ items: [] });
    const client = makeClient({
      listWorkspaces: vi.fn().mockReturnValue(workspaces.promise),
      listThreads,
    });

    renderApp('/chat', client);

    expect(listThreads).not.toHaveBeenCalled();
    await act(async () => {
      workspaces.resolve({
        items: [
          { id: 'ws_authorized', name: 'Authorized Workspace', kind: 'general' },
          { id: 'ws_quick_chat', name: 'Quick Chat', kind: 'quick-chat' },
        ],
      });
      await workspaces.promise;
    });
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith('ws_quick_chat'));
    expect(listThreads.mock.calls.every(([id]) => id === 'ws_quick_chat')).toBe(true);
    expect(listThreads).not.toHaveBeenCalledWith('ws_unavailable');
    expect(listThreads).not.toHaveBeenCalledWith('ws_authorized');
  });

  it('shows the empty state when there are no recent chats', async () => {
    renderApp('/chat', makeClient());
    expect(await screen.findByText('Start a chat')).toBeInTheDocument();
  });

  it('switches the active Workspace from Chat', async () => {
    const user = userEvent.setup();
    const listThreads = vi.fn().mockResolvedValue({ items: [] });
    renderApp('/chat', makeClient({ listThreads }));

    await screen.findByRole('heading', { name: 'What can we get done?' });
    await user.click(await workspaceSelectTrigger());
    await user.click(await screen.findByRole('menuitem', { name: 'Second workspace' }));

    await waitFor(() => expect(listThreads).toHaveBeenCalledWith('ws2'));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe('ws2');
  });

  it('lists recent chats when present', async () => {
    const client = makeClient({
      listThreads: vi.fn().mockResolvedValue({
        items: [THREAD, { ...THREAD, id: 'th_archived', name: 'Old chat', status: 'archived' }],
      }),
    });
    renderApp('/chat', client);
    expect(await screen.findByText('Competitive teardown')).toBeInTheDocument();
    expect(screen.queryByText('Old chat')).not.toBeInTheDocument();
  });

  it('creates a thread and opens it from the composer', async () => {
    const user = userEvent.setup();
    const createThread = vi.fn().mockResolvedValue({ ...THREAD, id: 'th-new' });
    const getThread = vi.fn().mockResolvedValue({ ...THREAD, id: 'th-new' });
    const startTurn = vi.fn();
    const submitConversation = vi.fn().mockResolvedValue(STARTER_CHAT_MODE_RESPONSE);
    const quickChat = vi.fn();
    const client = makeClient(
      { createThread, getThread, startTurn },
      { quickChat, submitConversation }
    );
    renderApp('/chat', client);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(input, 'Plan a launch');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        name: 'Plan a launch',
        requestId: expect.any(String),
      })
    );
    await waitFor(() =>
      expect(submitConversation).toHaveBeenCalledWith(
        'ws1',
        'th-new',
        expect.objectContaining({
          artifactRefs: [],
          input: 'Plan a launch',
          logicalModelId: 'default',
          requestId: expect.any(String),
          targetRef: 'internal-role:assistant',
        })
      )
    );
    expect(createThread.mock.invocationCallOrder[0]).toBeLessThan(
      submitConversation.mock.invocationCallOrder[0] ?? 0
    );
    expect(startTurn).not.toHaveBeenCalled();
    expect(quickChat).not.toHaveBeenCalled();
    // Navigated into the thread screen (its index toggle is present).
    expect(await screen.findByRole('button', { name: /Side panel/i })).toBeInTheDocument();
    expect(getThread).toHaveBeenCalledWith('ws1', 'th-new');
    getThread.mockClear();
    await act(async () => useWorkspaceStore.setState({ currentWorkspaceId: 'ws2' }));
    expect(getThread).not.toHaveBeenCalled();
  });

  it('opens a fresh Chat when the Workspace changes from a thread', async () => {
    const user = userEvent.setup();
    const listThreads = vi.fn().mockResolvedValue({ items: [] });
    renderApp('/chat/ws1/th1', makeClient({ listThreads }));

    await screen.findByRole('heading', { name: 'Competitive teardown' });
    await user.click(await workspaceSelectTrigger());
    await user.click(await screen.findByRole('menuitem', { name: 'Second workspace' }));

    expect(
      await screen.findByRole('heading', { name: 'What can we get done?' })
    ).toBeInTheDocument();
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith('ws2'));
  });

  it('fails closed when a canonical Thread route names an unavailable Workspace', async () => {
    const getThread = vi.fn();
    renderApp('/chat/ws_unavailable/th1', makeClient({ getThread }));

    expect(await screen.findByText('Workspace unavailable')).toBeInTheDocument();
    expect(getThread).not.toHaveBeenCalled();
  });

  it('syncs the primary switcher to the canonical Thread route Workspace', async () => {
    const workspaceBThread = {
      ...THREAD,
      workspaceId: 'ws2',
      name: 'Workspace B thread',
      preview: 'Workspace B thread',
    };
    renderApp(
      '/chat/ws2/th1',
      makeClient({
        getThread: vi.fn().mockResolvedValue(workspaceBThread),
        listThreads: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve({ items: [workspaceId === 'ws2' ? workspaceBThread : THREAD] })
          ),
      })
    );

    expect(await screen.findByRole('heading', { name: 'Workspace B thread' })).toBeInTheDocument();
    await waitFor(() => expect(useWorkspaceStore.getState().currentWorkspaceId).toBe('ws2'));
    expect(screen.getByRole('button', { name: 'Second workspace' })).toBeInTheDocument();
  });

  it('keeps Chat starter on the persistent sidebar switcher', async () => {
    renderApp('/chat', makeClient());
    expect(await workspaceSelectTrigger()).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Market research' })).toHaveLength(1);
  });

  it('keeps Thread on the persistent sidebar switcher', async () => {
    renderApp('/chat/ws1/th1', makeClient());
    expect(
      await screen.findByRole('heading', { name: 'Competitive teardown' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Market research' })).toHaveLength(1);
  });

  it('does not preserve a compatibility Chat Thread route without a Workspace segment', async () => {
    renderApp('/chat/th1', makeClient());
    expect(await screen.findByText(/doesn't exist/i)).toBeInTheDocument();
  });

  it('keeps the starter draft when the first conversation cannot start', async () => {
    const user = userEvent.setup();
    const createThread = vi.fn().mockResolvedValue({ ...THREAD, id: 'th-new' });
    const startTurn = vi.fn();
    const submitConversation = vi.fn().mockRejectedValue(new Error('chat_mode_unavailable'));
    const quickChat = vi.fn();
    const client = makeClient({ createThread, startTurn }, { quickChat, submitConversation });
    renderApp('/chat', client);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(input, 'Story thread');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText("Couldn't start that chat. Try again.")).toBeInTheDocument();
    await waitFor(() =>
      expect(submitConversation).toHaveBeenCalledWith(
        'ws1',
        'th-new',
        expect.objectContaining({
          input: 'Story thread',
          targetRef: 'internal-role:assistant',
        })
      )
    );
    expect(input).toHaveValue('Story thread');
    expect(startTurn).not.toHaveBeenCalled();
    expect(quickChat).not.toHaveBeenCalled();
  });

  it('does not open a workspace A starter result after the current workspace switches to B', async () => {
    const user = userEvent.setup();
    const started = createDeferred<typeof STARTER_CHAT_MODE_RESPONSE>();
    const createThread = vi.fn().mockResolvedValue({ ...THREAD, id: 'th-new' });
    const getThread = vi.fn();
    const submitConversation = vi.fn().mockReturnValue(started.promise);
    const client = makeClient({ createThread, getThread }, { submitConversation });
    const queryClient = renderApp('/chat', client);
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Plan for A');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(submitConversation).toHaveBeenCalledWith(
        'ws1',
        'th-new',
        expect.objectContaining({ input: 'Plan for A', targetRef: 'internal-role:assistant' })
      )
    );

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: 'ws2' }));
    await act(async () => {
      started.resolve(STARTER_CHAT_MODE_RESPONSE);
      await started.promise;
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: chatKeys.threads('ws1') })
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: chatKeys.threads('ws2') });
    expect(screen.getByRole('heading', { name: 'What can we get done?' })).toBeInTheDocument();
    expect(getThread).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(chatKeys.thread('ws2', 'th-new'))).toBeUndefined();
  });

  it('disables the composer with a reason when the runtime is unreachable', async () => {
    const client = makeClient({ meta: vi.fn().mockRejectedValue(new Error('down')) });
    renderApp('/chat', client);
    // useConnection retries once, so disconnection settles after ~1s.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled(), {
      timeout: 3000,
    });
  });
});

describe('chat thread (boards 02/03)', () => {
  it('renders the item stream: messages and an inline approval card', async () => {
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
    });
    renderApp('/chat/ws1/th1', client);
    expect(
      await screen.findByRole('heading', { name: 'Competitive teardown' })
    ).toBeInTheDocument();
    expect(await screen.findByText('Draft a competitive teardown.')).toBeInTheDocument();
    expect(screen.getByText('On it — gathering the details.')).toBeInTheDocument();
    expect(screen.getByText('Approve $5 spend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('responds to an inline approval', async () => {
    const user = userEvent.setup();
    const respondApproval = vi.fn().mockResolvedValue({});
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
      respondApproval,
    });
    renderApp('/chat/ws1/th1', client);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(respondApproval).toHaveBeenCalledWith('ap1', {
      workspaceId: 'ws1',
      threadId: 'th1',
      turnId: 't1',
      decision: 'granted',
    });
  });

  it('renders every non-secret Gate question and submits one complete answer map', async () => {
    const user = userEvent.setup();
    const startTurn = vi.fn().mockResolvedValue(COMPLETED_TURN);
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({ items: USER_INPUT_ITEMS, nextCursor: null }),
      startTurn,
    });
    renderApp('/chat/ws1/th1', client);

    await user.type(await screen.findByRole('textbox', { name: 'Audience' }), 'Operators');
    await user.click(screen.getByRole('radio', { name: 'Concise' }));
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));

    await waitFor(() =>
      expect(startTurn).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        threadId: 'th1',
        turnId: 't1',
        answers: { audience: ['Operators'], tone: ['Concise'] },
      })
    );
  });

  it('keeps option choices and submits one free-form Other answer under the same question id', async () => {
    const userInputItem = USER_INPUT_ITEMS.find((item) => item.type === 'user-input-request');
    if (!userInputItem) {
      throw new Error('The Gate fixture must contain one user-input request.');
    }
    const toneQuestion = userInputItem.questions.find((question) => question.id === 'tone');
    if (!toneQuestion) {
      throw new Error('The Gate fixture must contain the option question.');
    }
    const otherItems = ItemSchema.array().parse([
      {
        ...userInputItem,
        prompt: toneQuestion.question,
        questions: [{ ...toneQuestion, isOther: true }],
      },
    ]);
    const user = userEvent.setup();
    const startTurn = vi.fn().mockResolvedValue(COMPLETED_TURN);
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({ items: otherItems, nextCursor: null }),
      startTurn,
    });
    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByRole('radio', { name: 'Concise' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Detailed' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Other' }), 'Warm and direct');
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));

    await waitFor(() =>
      expect(startTurn).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        threadId: 'th1',
        turnId: 't1',
        answers: { tone: ['Warm and direct'] },
      })
    );
  });

  it('keeps Gate answers pending, exposes failure, and retries the same complete map', async () => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    const startTurn = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(COMPLETED_TURN);
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({ items: USER_INPUT_ITEMS, nextCursor: null }),
      startTurn,
    });
    renderApp('/chat/ws1/th1', client);

    await user.type(await screen.findByRole('textbox', { name: 'Audience' }), 'Operators');
    await user.click(screen.getByRole('radio', { name: 'Concise' }));
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(screen.getByRole('button', { name: 'Submitting answers' })).toBeDisabled();
    pending.reject(new Error('answer rejected'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't submit answers.");
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
    expect(startTurn.mock.calls[1]).toEqual(startTurn.mock.calls[0]);
  });

  it('suppresses answered Gate controls while retaining the matching response projection', async () => {
    const userInputItem = USER_INPUT_ITEMS.find((item) => item.type === 'user-input-request');
    if (!userInputItem) {
      throw new Error('The Gate fixture must contain one user-input request.');
    }
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({
        items: ItemSchema.array().parse([
          userInputItem,
          {
            id: 'i-user-input-response',
            workspaceId: userInputItem.workspaceId,
            threadId: userInputItem.threadId,
            turnId: userInputItem.turnId,
            type: 'user-input-response',
            status: 'completed',
            actor: { kind: 'user', id: 'user_responder' },
            causationId: 'req_user_input_response',
            userInputRequestId: userInputItem.userInputRequestId,
            answers: { audience: ['Operators'], tone: ['Concise'] },
            createdAt: '2026-07-21T00:00:03.000Z',
            completedAt: '2026-07-21T00:00:03.000Z',
          },
        ]),
        nextCursor: null,
      }),
    });
    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText('You answered')).toBeInTheDocument();
    expect(screen.getByText(/user_responder/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Audience' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Concise' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument();
  });

  it.each([
    { disconnected: false, secret: true, posture: 'secret-bearing' },
    { disconnected: true, secret: false, posture: 'disconnected' },
  ])('keeps a $posture Gate visible but read-only', async ({ disconnected, secret }) => {
    const userInputItem = USER_INPUT_ITEMS.find((item) => item.type === 'user-input-request');
    if (!userInputItem) {
      throw new Error('The Gate fixture must contain one user-input request.');
    }
    const secretItems = ItemSchema.array().parse([
      {
        ...userInputItem,
        questions: userInputItem.questions.map((question, index) => ({
          ...question,
          isSecret: secret && index === 0,
        })),
      },
    ]);
    const startTurn = vi.fn();
    const client = makeClient({
      ...(disconnected ? { meta: vi.fn().mockRejectedValue(new Error('down')) } : {}),
      listThreadItems: vi.fn().mockResolvedValue({ items: secretItems, nextCursor: null }),
      startTurn,
    });
    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText('Who should receive the release?')).toBeInTheDocument();
    expect(screen.getByText('Which tone should the release use?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it('sends a follow-up turn', async () => {
    const user = userEvent.setup();
    const startTurn = vi.fn();
    const submitConversation = vi.fn().mockResolvedValue(CHAT_MODE_RESPONSE);
    const quickChat = vi.fn();
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        startTurn,
      },
      { quickChat, submitConversation }
    );
    renderApp('/chat/ws1/th1', client);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(input, 'Add a pricing table');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(submitConversation).toHaveBeenCalledWith(
        'ws1',
        'th1',
        expect.objectContaining({
          input: 'Add a pricing table',
          targetRef: 'internal-role:assistant',
        })
      )
    );
    expect(startTurn).not.toHaveBeenCalled();
    expect(quickChat).not.toHaveBeenCalled();
  });

  it('shows a skeleton while the stream loads', async () => {
    const client = makeClient({ listThreadItems: vi.fn().mockReturnValue(new Promise(() => {})) });
    renderApp('/chat/ws1/th1', client);
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows an inline error when the stream fails', async () => {
    const client = makeClient({ listThreadItems: vi.fn().mockRejectedValue(new Error('boom')) });
    renderApp('/chat/ws1/th1', client);
    expect(await screen.findByText(/Couldn't load this thread\./i)).toBeInTheDocument();
  });

  it('makes approvals read-only and disables the composer when disconnected', async () => {
    const client = makeClient({
      meta: vi.fn().mockRejectedValue(new Error('down')),
      listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
    });
    renderApp('/chat/ws1/th1', client);
    await screen.findByText('Approve $5 spend');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled(), {
      timeout: 3000,
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});

describe('thread lifecycle and attribution (S7)', () => {
  it('keeps the authoritative title through a failed rename and adopts the retry result', async () => {
    const user = userEvent.setup();
    const firstRename = createDeferred<typeof THREAD>();
    const updateThread = vi
      .fn()
      .mockReturnValueOnce(firstRename.promise)
      .mockResolvedValueOnce({ ...THREAD, name: 'Market map' });
    const client = makeClient({ updateThread });

    renderApp('/chat/ws1/th1', client);

    await user.click(await screen.findByRole('button', { name: 'Rename thread' }));
    const name = screen.getByRole('textbox', { name: 'Thread name' });
    await user.clear(name);
    await user.type(name, 'Market map');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateThread).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        threadId: 'th1',
        name: 'Market map',
      })
    );
    expect(screen.getByRole('heading', { name: 'Competitive teardown' })).toBeInTheDocument();

    firstRename.reject(new Error('rename rejected'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Competitive teardown' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Market map' })).toBeInTheDocument();
    expect(updateThread).toHaveBeenCalledTimes(2);
  });

  it('does not project an archive until Core returns the archived thread', async () => {
    const user = userEvent.setup();
    const archiveResult = createDeferred<typeof THREAD>();
    const archiveThread = vi.fn().mockReturnValue(archiveResult.promise);
    const client = makeClient({ archiveThread });

    renderApp('/chat/ws1/th1', client);

    await user.click(await screen.findByRole('button', { name: 'Archive thread' }));
    expect(archiveThread).toHaveBeenCalledWith({ workspaceId: 'ws1', threadId: 'th1' });
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();

    await act(async () => archiveResult.resolve({ ...THREAD, status: 'archived' }));
    expect(await screen.findByText('Archived')).toBeInTheDocument();
  });

  it('does not project interruption until Core returns the interrupted turn', async () => {
    const user = userEvent.setup();
    const interruptResult = createDeferred<Record<string, unknown>>();
    const interruptTurn = vi.fn().mockReturnValue(interruptResult.promise);
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockResolvedValue({ value: undefined, done: true }) };
      },
    });
    const client = makeClient(
      { interruptTurn, subscribeTurnEvents },
      {
        getThreadDashboard: vi.fn().mockResolvedValue({
          turns: [ACTIVE_TURN],
        }),
      }
    );

    renderApp('/chat/ws1/th1', client);

    await user.click(await screen.findByRole('button', { name: 'Stop turn' }));
    expect(interruptTurn).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      threadId: 'th1',
      turnId: 't1',
    });
    expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();

    await act(async () =>
      interruptResult.resolve(
        TurnSchema.parse({
          ...ACTIVE_TURN,
          status: 'interrupted',
          completedAt: '2026-07-21T00:00:03.000Z',
          durationMs: 3_000,
        })
      )
    );
    expect(await screen.findByText('Interrupted')).toBeInTheDocument();
  });

  it.each([
    'rename',
    'archive',
    'interrupt',
  ] as const)('keeps a pending %s command bound to its original workspace owner', async (command) => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    const mutation = vi.fn().mockReturnValue(pending.promise);
    const workspaceBThread = {
      ...THREAD,
      workspaceId: 'ws2',
      name: 'Workspace B teardown',
      preview: 'Workspace B teardown',
    };
    const workspaceBTurn = TurnSchema.parse({
      ...ACTIVE_TURN,
      workspaceId: 'ws2',
      triggerActor: { kind: 'user', id: 'user_workspace_b' },
    });
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockResolvedValue({ value: undefined, done: true }) };
      },
    });
    const method =
      command === 'rename'
        ? 'updateThread'
        : command === 'archive'
          ? 'archiveThread'
          : 'interruptTurn';
    const client = makeClient(
      {
        [method]: mutation,
        getThread: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve(workspaceId === 'ws2' ? workspaceBThread : THREAD)
          ),
        listThreads: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve({ items: [workspaceId === 'ws2' ? workspaceBThread : THREAD] })
          ),
        listThreadItems: vi.fn().mockImplementation((workspaceId: string) =>
          Promise.resolve({
            items: workspaceId === 'ws2' ? [] : ITEMS,
            nextCursor: null,
          })
        ),
        subscribeTurnEvents,
      },
      {
        getThreadDashboard: vi.fn().mockImplementation((workspaceId: string) =>
          Promise.resolve({
            turns: [workspaceId === 'ws2' ? workspaceBTurn : ACTIVE_TURN],
          })
        ),
      }
    );
    const queryClient = renderApp('/chat/ws1/th1', client);

    if (command === 'rename') {
      await user.click(await screen.findByRole('button', { name: 'Rename thread' }));
      const name = screen.getByRole('textbox', { name: 'Thread name' });
      await user.clear(name);
      await user.type(name, 'Workspace A renamed');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else {
      await user.click(
        await screen.findByRole('button', {
          name: command === 'archive' ? 'Archive thread' : 'Stop turn',
        })
      );
    }

    const expectedArgs =
      command === 'rename'
        ? { workspaceId: 'ws1', threadId: 'th1', name: 'Workspace A renamed' }
        : command === 'archive'
          ? { workspaceId: 'ws1', threadId: 'th1' }
          : { workspaceId: 'ws1', threadId: 'th1', turnId: 't1' };
    await waitFor(() => expect(mutation).toHaveBeenCalledWith(expectedArgs));

    await switchToThread(user, 'Market research', 'Second workspace', 'Workspace B teardown');
    expect(
      await screen.findByRole('heading', { name: 'Workspace B teardown' })
    ).toBeInTheDocument();

    const workspaceAResult =
      command === 'rename'
        ? { ...THREAD, name: 'Workspace A renamed' }
        : command === 'archive'
          ? { ...THREAD, status: 'archived' }
          : TurnSchema.parse({
              ...ACTIVE_TURN,
              status: 'interrupted',
              completedAt: '2026-07-21T00:00:03.000Z',
              durationMs: 3_000,
            });
    await act(async () => {
      pending.resolve(workspaceAResult);
      await pending.promise;
    });

    if (command === 'interrupt') {
      expect(
        queryClient.getQueryData<{ turns: (typeof workspaceBTurn)[] }>(
          chatKeys.dashboard('ws2', 'th1')
        )?.turns[0]
      ).toEqual(workspaceBTurn);
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();
    } else {
      expect(queryClient.getQueryData(chatKeys.thread('ws2', 'th1'))).toEqual(workspaceBThread);
      expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Workspace B teardown' })).toBeInTheDocument();
  });

  it.each([
    ['rename', 'before'],
    ['rename', 'after'],
    ['archive', 'before'],
    ['archive', 'after'],
    ['interrupt', 'before'],
    ['interrupt', 'after'],
  ] as const)('keeps concurrent %s failures and retries owner-bound when B settles %s A retry', async (command, workspaceBSettlement) => {
    const user = userEvent.setup();
    const workspaceARequest = createDeferred<unknown>();
    const workspaceBRequest = createDeferred<unknown>();
    const workspaceBThread = {
      ...THREAD,
      workspaceId: 'ws2',
      name: 'Workspace B teardown',
      preview: 'Workspace B teardown',
    };
    const workspaceBTurn = TurnSchema.parse({
      ...ACTIVE_TURN,
      workspaceId: 'ws2',
      triggerActor: { kind: 'user', id: 'user_workspace_b' },
    });
    const workspaceAResult =
      command === 'rename'
        ? { ...THREAD, name: 'Workspace A renamed' }
        : command === 'archive'
          ? { ...THREAD, status: 'archived' }
          : TurnSchema.parse({
              ...ACTIVE_TURN,
              status: 'interrupted',
              completedAt: '2026-07-21T00:00:03.000Z',
              durationMs: 3_000,
            });
    const workspaceBResult =
      command === 'rename'
        ? { ...workspaceBThread, name: 'Workspace B renamed' }
        : command === 'archive'
          ? { ...workspaceBThread, status: 'archived' }
          : TurnSchema.parse({
              ...workspaceBTurn,
              status: 'interrupted',
              completedAt: '2026-07-21T00:00:03.000Z',
              durationMs: 3_000,
            });
    let workspaceACallCount = 0;
    const mutation = vi.fn((input: { workspaceId: string }) => {
      if (input.workspaceId === 'ws2') return workspaceBRequest.promise;
      workspaceACallCount += 1;
      return workspaceACallCount === 1
        ? workspaceARequest.promise
        : Promise.resolve(workspaceAResult);
    });
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockResolvedValue({ value: undefined, done: true }) };
      },
    });
    const method =
      command === 'rename'
        ? 'updateThread'
        : command === 'archive'
          ? 'archiveThread'
          : 'interruptTurn';
    const client = makeClient(
      {
        [method]: mutation,
        getThread: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve(workspaceId === 'ws2' ? workspaceBThread : THREAD)
          ),
        listThreads: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve({ items: [workspaceId === 'ws2' ? workspaceBThread : THREAD] })
          ),
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        subscribeTurnEvents,
      },
      {
        getThreadDashboard: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve({ turns: [workspaceId === 'ws2' ? workspaceBTurn : ACTIVE_TURN] })
          ),
      }
    );

    renderApp('/chat/ws1/th1', client);

    if (command === 'rename') {
      await user.click(await screen.findByRole('button', { name: 'Rename thread' }));
      const name = screen.getByRole('textbox', { name: 'Thread name' });
      await user.clear(name);
      await user.type(name, 'Workspace A renamed');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else {
      await user.click(
        await screen.findByRole('button', {
          name: command === 'archive' ? 'Archive thread' : 'Stop turn',
        })
      );
    }

    const workspaceAArgs =
      command === 'rename'
        ? { workspaceId: 'ws1', threadId: 'th1', name: 'Workspace A renamed' }
        : command === 'archive'
          ? { workspaceId: 'ws1', threadId: 'th1' }
          : { workspaceId: 'ws1', threadId: 'th1', turnId: 't1' };
    await waitFor(() => expect(mutation).toHaveBeenCalledWith(workspaceAArgs));

    await switchToThread(user, 'Market research', 'Second workspace', 'Workspace B teardown');
    expect(
      await screen.findByRole('heading', { name: 'Workspace B teardown' })
    ).toBeInTheDocument();

    if (command === 'rename') {
      await user.click(screen.getByRole('button', { name: 'Rename thread' }));
      const name = screen.getByRole('textbox', { name: 'Thread name' });
      await user.clear(name);
      await user.type(name, 'Workspace B renamed');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else {
      await user.click(
        screen.getByRole('button', {
          name: command === 'archive' ? 'Archive thread' : 'Stop turn',
        })
      );
    }

    const workspaceBArgs =
      command === 'rename'
        ? { workspaceId: 'ws2', threadId: 'th1', name: 'Workspace B renamed' }
        : command === 'archive'
          ? { workspaceId: 'ws2', threadId: 'th1' }
          : { workspaceId: 'ws2', threadId: 'th1', turnId: 't1' };
    await waitFor(() => expect(mutation).toHaveBeenCalledWith(workspaceBArgs));

    await act(async () => {
      workspaceARequest.reject(new Error(`workspace A ${command} rejected`));
      await workspaceARequest.promise.catch(() => undefined);
    });
    if (workspaceBSettlement === 'before') {
      await act(async () => {
        workspaceBRequest.resolve(workspaceBResult);
        await workspaceBRequest.promise;
      });
      if (command === 'rename') {
        expect(await screen.findByRole('heading', { name: 'Workspace B renamed' })).toBeVisible();
      } else if (command === 'archive') {
        expect(await screen.findByText('Archived')).toBeInTheDocument();
      } else {
        expect(await screen.findByText('Interrupted')).toBeInTheDocument();
      }
    }
    await switchToThread(user, 'Second workspace', 'Market research', 'Competitive teardown');
    expect(
      await screen.findByRole('heading', { name: 'Competitive teardown' })
    ).toBeInTheDocument();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      command === 'rename'
        ? "Couldn't rename this thread."
        : command === 'archive'
          ? "Couldn't archive this thread."
          : "Couldn't stop this turn."
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(3));
    expect(mutation).toHaveBeenNthCalledWith(1, workspaceAArgs);
    expect(mutation).toHaveBeenNthCalledWith(2, workspaceBArgs);
    expect(mutation).toHaveBeenNthCalledWith(3, workspaceAArgs);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

    if (command === 'rename') {
      expect(await screen.findByRole('heading', { name: 'Workspace A renamed' })).toBeVisible();
    } else if (command === 'archive') {
      expect(await screen.findByText('Archived')).toBeInTheDocument();
    } else {
      expect(await screen.findByText('Interrupted')).toBeInTheDocument();
    }

    if (workspaceBSettlement === 'after') {
      await switchToThread(user, 'Market research', 'Second workspace', 'Workspace B teardown');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      if (command !== 'rename') {
        expect(
          await screen.findByRole('button', {
            name: command === 'archive' ? 'Archive thread' : 'Stop turn',
          })
        ).toBeDisabled();
      }

      await act(async () => {
        workspaceBRequest.resolve(workspaceBResult);
        await workspaceBRequest.promise;
      });
      if (command === 'rename') {
        expect(await screen.findByRole('heading', { name: 'Workspace B renamed' })).toBeVisible();
      } else if (command === 'archive') {
        expect(await screen.findByText('Archived')).toBeInTheDocument();
      } else {
        expect(await screen.findByText('Interrupted')).toBeInTheDocument();
      }
    }
  });

  it('does not attach a rejected interrupt history to a newer active turn', async () => {
    const user = userEvent.setup();
    const secondInterrupt = createDeferred<unknown>();
    const interruptTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error('t1 interrupt rejected'))
      .mockReturnValueOnce(secondInterrupt.promise);
    const secondActiveTurn = TurnSchema.parse({
      ...ACTIVE_TURN,
      id: 't2',
      startedAt: '2026-07-21T00:00:04.000Z',
    });
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockResolvedValue({ value: undefined, done: true }) };
      },
    });
    const client = makeClient(
      { interruptTurn, subscribeTurnEvents },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );
    const queryClient = renderApp('/chat/ws1/th1', client);

    await user.click(await screen.findByRole('button', { name: 'Stop turn' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't stop this turn.");
    expect(interruptTurn).toHaveBeenNthCalledWith(1, {
      workspaceId: 'ws1',
      threadId: 'th1',
      turnId: 't1',
    });

    act(() =>
      queryClient.setQueryData(chatKeys.dashboard('ws1', 'th1'), {
        turns: [COMPLETED_TURN, secondActiveTurn],
      })
    );

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop turn' }));
    expect(interruptTurn).toHaveBeenNthCalledWith(2, {
      workspaceId: 'ws1',
      threadId: 'th1',
      turnId: 't2',
    });
  });

  it('never submits a rename draft to a newly selected workspace owner', async () => {
    const user = userEvent.setup();
    const updateThread = vi.fn().mockResolvedValue(THREAD);
    const workspaceBThread = {
      ...THREAD,
      workspaceId: 'ws2',
      name: 'Workspace B teardown',
      preview: 'Workspace B teardown',
    };
    const client = makeClient({
      updateThread,
      getThread: vi
        .fn()
        .mockImplementation((workspaceId: string) =>
          Promise.resolve(workspaceId === 'ws2' ? workspaceBThread : THREAD)
        ),
    });

    renderApp('/chat/ws1/th1', client);
    await user.click(await screen.findByRole('button', { name: 'Rename thread' }));
    const name = screen.getByRole('textbox', { name: 'Thread name' });
    await user.clear(name);
    await user.type(name, 'Workspace A draft');

    await user.click(await workspaceSelectTrigger('Market research'));
    await user.click(await screen.findByRole('menuitem', { name: 'Second workspace' }));
    expect(
      await screen.findByRole('heading', { name: 'What can we get done?' })
    ).toBeInTheDocument();

    const save = screen.queryByRole('button', { name: 'Save' });
    if (save) await user.click(save);
    expect(updateThread).not.toHaveBeenCalledWith({
      workspaceId: 'ws2',
      threadId: 'th1',
      name: 'Workspace A draft',
    });
    expect(updateThread).not.toHaveBeenCalled();
  });

  it('keeps the active thread visible and retries the exact rejected archive command', async () => {
    const user = userEvent.setup();
    const archiveThread = vi
      .fn()
      .mockRejectedValueOnce(new Error('archive rejected'))
      .mockResolvedValueOnce({ ...THREAD, status: 'archived' });
    const client = makeClient({ archiveThread });

    renderApp('/chat/ws1/th1', client);
    await user.click(await screen.findByRole('button', { name: 'Archive thread' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't archive this thread.");
    expect(screen.getByRole('heading', { name: 'Competitive teardown' })).toBeInTheDocument();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(archiveThread).toHaveBeenCalledTimes(2));
    expect(archiveThread).toHaveBeenNthCalledWith(1, { workspaceId: 'ws1', threadId: 'th1' });
    expect(archiveThread).toHaveBeenNthCalledWith(2, { workspaceId: 'ws1', threadId: 'th1' });
    expect(await screen.findByText('Archived')).toBeInTheDocument();
  });

  it('keeps the running turn visible and retries the exact rejected interrupt command', async () => {
    const user = userEvent.setup();
    const interruptedTurn = TurnSchema.parse({
      ...ACTIVE_TURN,
      status: 'interrupted',
      completedAt: '2026-07-21T00:00:03.000Z',
      durationMs: 3_000,
    });
    const interruptTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error('interrupt rejected'))
      .mockResolvedValueOnce(interruptedTurn);
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockResolvedValue({ value: undefined, done: true }) };
      },
    });
    const client = makeClient(
      { interruptTurn, subscribeTurnEvents },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );

    renderApp('/chat/ws1/th1', client);
    await user.click(await screen.findByRole('button', { name: 'Stop turn' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't stop this turn.");
    expect(screen.getByRole('button', { name: 'Stop turn' })).toBeInTheDocument();
    expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(interruptTurn).toHaveBeenCalledTimes(2));
    const args = { workspaceId: 'ws1', threadId: 'th1', turnId: 't1' };
    expect(interruptTurn).toHaveBeenNthCalledWith(1, args);
    expect(interruptTurn).toHaveBeenNthCalledWith(2, args);
    expect(await screen.findByText('Interrupted')).toBeInTheDocument();
  });

  it.each([
    ['local', 'user_local'],
    ['server', 'user_server'],
  ])('renders the exact %s user-message actor without deployment-mode probing', async (_, actorId) => {
    const getSetupDiagnostics = vi.fn().mockRejectedValue(new Error('must not be called'));
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({
          items: [{ ...ITEMS[0], actor: { kind: 'user', id: actorId } }],
          nextCursor: null,
        }),
      },
      { getSetupDiagnostics }
    );

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText(new RegExp(actorId))).toBeInTheDocument();
    expect(getSetupDiagnostics).not.toHaveBeenCalled();
  });

  it('renders the exact actors on approval decisions and user-input responses', async () => {
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({
        items: ItemSchema.array().parse([
          {
            id: 'i-decision',
            workspaceId: 'ws1',
            threadId: 'th1',
            type: 'approval-decision',
            turnId: 't1',
            status: 'completed',
            actor: { kind: 'user', id: 'user_approver' },
            causationId: 'req_approval',
            approvalRequestId: 'ap1',
            decision: 'granted',
            createdAt: '2026-07-21T00:00:03.000Z',
            completedAt: '2026-07-21T00:00:03.000Z',
          },
          {
            id: 'i-response',
            workspaceId: 'ws1',
            threadId: 'th1',
            type: 'user-input-response',
            turnId: 't1',
            status: 'completed',
            actor: { kind: 'user', id: 'user_responder' },
            causationId: 'req_response',
            userInputRequestId: 'input1',
            answers: { question1: ['Yes'] },
            createdAt: '2026-07-21T00:00:04.000Z',
            completedAt: '2026-07-21T00:00:04.000Z',
          },
        ]),
        nextCursor: null,
      }),
    });

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText(/user_approver/)).toBeInTheDocument();
    expect(screen.getByText(/user_responder/)).toBeInTheDocument();
  });

  it('renders the exact active-turn trigger actor from the typed dashboard projection', async () => {
    const getSetupDiagnostics = vi.fn().mockRejectedValue(new Error('must not be called'));
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockResolvedValue({ value: undefined, done: true }) };
      },
    });
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        subscribeTurnEvents,
      },
      {
        getThreadDashboard: vi.fn().mockResolvedValue({
          turns: [
            TurnSchema.parse({
              ...ACTIVE_TURN,
              triggerActor: {
                kind: 'automation',
                id: 'automation_release',
                responsibleUserId: 'user_operator',
              },
            }),
          ],
        }),
        getSetupDiagnostics,
      }
    );

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText(/automation_release/)).toBeInTheDocument();
    expect(getSetupDiagnostics).not.toHaveBeenCalled();
  });

  it('leaves an intentionally actorless assistant item without an inferred actor label', async () => {
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({ items: [ITEMS[1]], nextCursor: null }),
    });

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText('On it — gathering the details.')).toBeInTheDocument();
    expect(screen.queryByText(/^by\s/)).not.toBeInTheDocument();
  });
});

describe('live turn subscription (S6)', () => {
  it.each([
    'send',
    'approval',
  ] as const)('refreshes the dashboard and subscribes once after a successful %s command', async (command) => {
    const user = userEvent.setup();
    const submitConversation = vi.fn().mockResolvedValue(CHAT_MODE_RESPONSE);
    const respondApproval = vi.fn().mockResolvedValue({});
    const getThreadDashboard = vi
      .fn()
      .mockResolvedValueOnce({ turns: [] })
      .mockResolvedValue({ turns: [ACTIVE_TURN] });
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        };
      },
    });
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        respondApproval,
        subscribeTurnEvents,
      },
      { getThreadDashboard, submitConversation }
    );

    renderApp('/chat/ws1/th1', client);
    await waitFor(() => expect(getThreadDashboard).toHaveBeenCalledTimes(1));

    if (command === 'send') {
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Start fresh work');
      await user.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    } else {
      await user.click(await screen.findByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(respondApproval).toHaveBeenCalledTimes(1));
    }

    await waitFor(() => expect(getThreadDashboard).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(subscribeTurnEvents).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        threadId: 'th1',
        turnId: 't1',
      })
    );
    expect(subscribeTurnEvents).toHaveBeenCalledTimes(1);
  });

  it('folds an already-running turn into the thread cache without refetching', async () => {
    let releaseDelta!: () => void;
    let releaseCompletion!: () => void;
    const waitForDelta = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const waitForCompletion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    async function* stream() {
      yield turnStreamEvent(1, 'item.created', {
        type: 'item-created',
        item: STREAMING_ITEM,
      });
      await waitForDelta;
      yield turnStreamEvent(2, 'item.delta', {
        type: 'item-delta',
        itemId: STREAMING_ITEM.id,
        itemType: STREAMING_ITEM.type,
        deltaKind: 'text-delta',
        delta: 'Streaming live',
      });
      await waitForCompletion;
      yield turnStreamEvent(3, 'item.completed', {
        type: 'item-completed',
        itemId: STREAMING_ITEM.id,
        item: {
          ...STREAMING_ITEM,
          status: 'completed',
          text: 'Authoritative final',
          completedAt: '2026-07-21T00:00:02.000Z',
        },
      });
      yield turnStreamEvent(4, 'turn.completed', {
        type: 'turn-completed',
        stopReason: 'completed',
        turn: { ...ACTIVE_TURN, status: 'completed' },
      });
    }

    const listThreadItems = vi.fn().mockResolvedValue({
      items: [ITEMS[0]],
      nextCursor: null,
    });
    const subscribeTurnEvents = vi.fn().mockReturnValue(stream());
    const client = makeClient(
      { listThreadItems, subscribeTurnEvents },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );

    renderApp('/chat/ws1/th1', client);

    await waitFor(() =>
      expect(subscribeTurnEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws1',
          threadId: 'th1',
          turnId: 't1',
        })
      )
    );
    releaseDelta();
    expect(await screen.findByText('Streaming live')).toBeInTheDocument();

    releaseCompletion();
    expect(await screen.findByText('Authoritative final')).toBeInTheDocument();
    expect(screen.queryByText('Streaming live')).not.toBeInTheDocument();
    expect(screen.getAllByText('Authoritative final')).toHaveLength(1);
    expect(listThreadItems).toHaveBeenCalledTimes(1);
  });

  it('projects authoritative turn completion into active controls and feedback', async () => {
    const completion = createDeferred<void>();
    async function* stream() {
      await completion.promise;
      yield turnStreamEvent(1, 'turn.completed', {
        type: 'turn-completed',
        stopReason: 'completed',
        turn: COMPLETED_TURN,
      });
    }

    const subscribeTurnEvents = vi.fn().mockReturnValue(stream());
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        subscribeTurnEvents,
      },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );
    const queryClient = renderApp('/chat/ws1/th1', client);

    expect(await screen.findByRole('button', { name: 'Stop turn' })).toBeInTheDocument();
    await waitFor(() => expect(subscribeTurnEvents).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Good' })).not.toBeInTheDocument();

    await act(async () => completion.resolve());

    await waitFor(() =>
      expect(
        queryClient.getQueryData<{ turns: (typeof ACTIVE_TURN)[] }>(
          chatKeys.dashboard('ws1', 'th1')
        )?.turns
      ).toEqual([COMPLETED_TURN])
    );
    expect(screen.queryByRole('button', { name: 'Stop turn' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Good' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bad' })).toBeInTheDocument();
  });

  it.each([
    ['completed', 'completed'],
    ['interrupted', 'aborted'],
    ['cancelled', 'aborted'],
    ['failed', 'error'],
  ] as const)('projects an authoritative %s Turn without touching the items cache', async (status, stopReason) => {
    const release = createDeferred<void>();
    const processed = createDeferred<void>();
    const terminalTurn = TurnSchema.parse({ ...COMPLETED_TURN, status });
    async function* stream() {
      await release.promise;
      yield turnStreamEvent(1, 'turn.completed', {
        type: 'turn-completed',
        stopReason,
        turn: terminalTurn,
      });
      processed.resolve();
    }

    const subscribeTurnEvents = vi.fn().mockReturnValue(stream());
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        subscribeTurnEvents,
      },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );
    const itemsKey = chatKeys.items('ws1', 'th1');
    const dashboardKey = chatKeys.dashboard('ws1', 'th1');
    const queryClient = renderApp('/chat/ws1/th1', client, (cache) => {
      cache.setQueryDefaults(itemsKey, { staleTime: Number.POSITIVE_INFINITY });
      cache.setQueryData(itemsKey, ITEMS, { updatedAt: 1 });
    });

    expect(await screen.findByRole('button', { name: 'Stop turn' })).toBeInTheDocument();
    await waitFor(() => expect(subscribeTurnEvents).toHaveBeenCalledTimes(1));
    const initialItems = queryClient.getQueryData(itemsKey);
    const initialItemsUpdatedAt = queryClient.getQueryState(itemsKey)?.dataUpdatedAt;
    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries');

    await act(async () => {
      release.resolve();
      await processed.promise;
    });

    expect.soft(queryClient.getQueryData(dashboardKey)).toEqual({ turns: [terminalTurn] });
    expect.soft(cancelQueries).toHaveBeenCalledTimes(1);
    expect.soft(cancelQueries).toHaveBeenCalledWith({ queryKey: dashboardKey, exact: true });
    expect.soft(cancelQueries).not.toHaveBeenCalledWith({ queryKey: itemsKey, exact: true });
    expect.soft(queryClient.getQueryData(itemsKey)).toEqual(initialItems);
    expect.soft(queryClient.getQueryState(itemsKey)?.dataUpdatedAt).toBe(initialItemsUpdatedAt);
  });

  it('streams over a fresh authoritative cache without starting a baseline refetch', async () => {
    let releaseCompletion!: () => void;
    const waitForCompletion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    async function* stream() {
      yield turnStreamEvent(1, 'item.created', {
        type: 'item-created',
        item: STREAMING_ITEM,
      });
      yield turnStreamEvent(2, 'item.delta', {
        type: 'item-delta',
        itemId: STREAMING_ITEM.id,
        itemType: STREAMING_ITEM.type,
        deltaKind: 'text-delta',
        delta: 'Fresh-cache live text',
      });
      await waitForCompletion;
      yield turnStreamEvent(3, 'item.completed', {
        type: 'item-completed',
        itemId: STREAMING_ITEM.id,
        item: {
          ...STREAMING_ITEM,
          status: 'completed',
          text: 'Authoritative fresh-cache result',
          completedAt: '2026-07-21T00:00:02.000Z',
        },
      });
    }

    const listThreadItems = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const subscribeTurnEvents = vi.fn().mockReturnValue(stream());
    const client = makeClient(
      { listThreadItems, subscribeTurnEvents },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );

    renderApp('/chat/ws1/th1', client, (queryClient) => {
      queryClient.setQueryDefaults(chatKeys.items('ws1', 'th1'), { staleTime: 5_000 });
      queryClient.setQueryData(chatKeys.items('ws1', 'th1'), [ITEMS[0]]);
    });

    expect(await screen.findByText('Draft a competitive teardown.')).toBeInTheDocument();
    expect(listThreadItems).not.toHaveBeenCalled();
    await waitFor(() => expect(subscribeTurnEvents).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Fresh-cache live text')).toBeInTheDocument();

    releaseCompletion();
    expect(await screen.findByText('Authoritative fresh-cache result')).toBeInTheDocument();
    expect(screen.queryByText('Fresh-cache live text')).not.toBeInTheDocument();
    expect(listThreadItems).not.toHaveBeenCalled();
    expect(subscribeTurnEvents).toHaveBeenCalledTimes(1);
  });

  it('keeps the fresh-cache stream alive while a command refetch catches up', async () => {
    const user = userEvent.setup();
    let resolveStaleItems!: (value: { items: typeof ITEMS; nextCursor: null }) => void;
    let releaseStream!: () => void;
    const staleItems = new Promise<{ items: typeof ITEMS; nextCursor: null }>((resolve) => {
      resolveStaleItems = resolve;
    });
    const streamReady = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    /** Emit one completed Item only after the command-owned refetch is in flight. */
    async function* streamDuringRefetch() {
      await streamReady;
      yield turnStreamEvent(1, 'item.created', {
        type: 'item-created',
        item: STREAMING_ITEM,
      });
      yield turnStreamEvent(2, 'item.delta', {
        type: 'item-delta',
        itemId: STREAMING_ITEM.id,
        itemType: STREAMING_ITEM.type,
        deltaKind: 'text-delta',
        delta: 'Command-refetch live text',
      });
      yield turnStreamEvent(3, 'item.completed', {
        type: 'item-completed',
        itemId: STREAMING_ITEM.id,
        item: {
          ...STREAMING_ITEM,
          status: 'completed',
          text: 'Authoritative command-refetch result',
          completedAt: '2026-07-21T00:00:02.000Z',
        },
      });
      await new Promise(() => {});
    }

    const iterator = streamDuringRefetch();
    const returnStream = vi.spyOn(iterator, 'return');
    const listThreadItems = vi.fn().mockReturnValue(staleItems);
    const subscribeTurnEvents = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => iterator,
    });
    const submitConversation = vi.fn().mockResolvedValue(CHAT_MODE_RESPONSE);
    const client = makeClient(
      { listThreadItems, subscribeTurnEvents },
      {
        getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }),
        submitConversation,
      }
    );
    const queryClient = renderApp('/chat/ws1/th1', client, (cache) => {
      cache.setQueryDefaults(chatKeys.items('ws1', 'th1'), { staleTime: 5_000 });
      cache.setQueryData(chatKeys.items('ws1', 'th1'), ITEMS);
    });

    expect(await screen.findByText('Draft a competitive teardown.')).toBeInTheDocument();
    expect(listThreadItems).not.toHaveBeenCalled();
    await waitFor(() => expect(subscribeTurnEvents).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Start fresh work');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listThreadItems).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryState(chatKeys.items('ws1', 'th1'))?.fetchStatus).toBe('fetching');
    expect(returnStream).not.toHaveBeenCalled();
    expect(subscribeTurnEvents).toHaveBeenCalledTimes(1);

    releaseStream();
    expect(await screen.findByText('Authoritative command-refetch result')).toBeInTheDocument();
    expect(screen.getAllByText('Authoritative command-refetch result')).toHaveLength(1);

    await act(async () => {
      resolveStaleItems({ items: ITEMS, nextCursor: null });
      await staleItems;
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(screen.getAllByText('Authoritative command-refetch result')).toHaveLength(1);
    expect(
      queryClient
        .getQueryData<{ id: string }[]>(chatKeys.items('ws1', 'th1'))
        ?.filter((item) => item.id === STREAMING_ITEM.id)
    ).toHaveLength(1);
    expect(returnStream).not.toHaveBeenCalled();
    expect(subscribeTurnEvents).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed streamed item when an older command refetch settles after the stream', async () => {
    const user = userEvent.setup();
    let resolveStaleItems!: (value: { items: typeof ITEMS; nextCursor: null }) => void;
    const staleItems = new Promise<{ items: typeof ITEMS; nextCursor: null }>((resolve) => {
      resolveStaleItems = resolve;
    });
    const listThreadItems = vi
      .fn()
      .mockResolvedValueOnce({ items: ITEMS, nextCursor: null })
      .mockReturnValueOnce(staleItems);
    const getThreadDashboard = vi
      .fn()
      .mockResolvedValueOnce({ turns: [] })
      .mockResolvedValue({ turns: [ACTIVE_TURN] });
    async function* streamThenDrop() {
      yield turnStreamEvent(1, 'item.created', {
        type: 'item-created',
        item: STREAMING_ITEM,
      });
      yield turnStreamEvent(2, 'item.delta', {
        type: 'item-delta',
        itemId: STREAMING_ITEM.id,
        itemType: STREAMING_ITEM.type,
        deltaKind: 'text-delta',
        delta: 'Interleaved live text',
      });
      yield turnStreamEvent(3, 'item.completed', {
        type: 'item-completed',
        itemId: STREAMING_ITEM.id,
        item: {
          ...STREAMING_ITEM,
          status: 'completed',
          text: 'Authoritative interleaved result',
          completedAt: '2026-07-21T00:00:02.000Z',
        },
      });
      throw new Error('stream dropped');
    }
    const subscribeTurnEvents = vi.fn().mockReturnValue(streamThenDrop());
    const client = makeClient(
      {
        listThreadItems,
        subscribeTurnEvents,
      },
      { getThreadDashboard, submitConversation: vi.fn().mockResolvedValue(CHAT_MODE_RESPONSE) }
    );

    const queryClient = renderApp('/chat/ws1/th1', client);
    await screen.findByText('Draft a competitive teardown.');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Start interleaved work');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(listThreadItems).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Authoritative interleaved result')).toBeInTheDocument();
    expect(await screen.findByText("Couldn't reach the local runtime.")).toBeInTheDocument();

    await act(async () => {
      resolveStaleItems({ items: ITEMS, nextCursor: null });
      await staleItems;
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(screen.getByText('Draft a competitive teardown.')).toBeInTheDocument();
    expect(screen.getAllByText('Authoritative interleaved result')).toHaveLength(1);
    expect(listThreadItems).toHaveBeenCalledTimes(2);
    expect(subscribeTurnEvents).toHaveBeenCalledTimes(1);
  });

  it('settles the first authoritative remount baseline before starting the stream', async () => {
    const serverOnlyItem = {
      ...STREAMING_ITEM,
      id: 'i-server-only',
      status: 'completed',
      text: 'Authoritative server-only item',
      completedAt: '2026-07-21T00:00:01.500Z',
    };
    let resolveBaseline!: (value: { items: (typeof serverOnlyItem)[]; nextCursor: null }) => void;
    let resolveDashboard!: (value: { turns: (typeof ACTIVE_TURN)[] }) => void;
    let releaseStream!: () => void;
    const baseline = new Promise<{ items: (typeof serverOnlyItem)[]; nextCursor: null }>(
      (resolve) => {
        resolveBaseline = resolve;
      }
    );
    const dashboard = new Promise<{ turns: (typeof ACTIVE_TURN)[] }>((resolve) => {
      resolveDashboard = resolve;
    });
    const streamReady = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    async function* streamDuringBaseline() {
      await streamReady;
      yield turnStreamEvent(1, 'item.created', {
        type: 'item-created',
        item: STREAMING_ITEM,
      });
      yield turnStreamEvent(2, 'item.delta', {
        type: 'item-delta',
        itemId: STREAMING_ITEM.id,
        itemType: STREAMING_ITEM.type,
        deltaKind: 'text-delta',
        delta: 'Remount live text',
      });
      yield turnStreamEvent(3, 'item.completed', {
        type: 'item-completed',
        itemId: STREAMING_ITEM.id,
        item: {
          ...STREAMING_ITEM,
          status: 'completed',
          text: 'Authoritative remount stream item',
          completedAt: '2026-07-21T00:00:02.000Z',
        },
      });
      yield turnStreamEvent(4, 'turn.completed', {
        type: 'turn-completed',
        stopReason: 'completed',
        turn: { ...ACTIVE_TURN, status: 'completed' },
      });
    }

    const listThreadItems = vi.fn().mockReturnValue(baseline);
    const subscribeTurnEvents = vi.fn().mockReturnValue(streamDuringBaseline());
    const client = makeClient(
      { listThreadItems, subscribeTurnEvents },
      { getThreadDashboard: vi.fn().mockReturnValue(dashboard) }
    );
    const queryClient = renderApp('/chat/ws1/th1', client, (cache) => {
      cache.setQueryData(chatKeys.items('ws1', 'th1'), [ITEMS[0]]);
    });

    await waitFor(() => expect(listThreadItems).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveDashboard({ turns: [ACTIVE_TURN] });
      await dashboard;
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(chatKeys.dashboard('ws1', 'th1'))?.status).toBe('success')
    );
    expect(subscribeTurnEvents).not.toHaveBeenCalled();

    await act(async () => {
      resolveBaseline({ items: [serverOnlyItem], nextCursor: null });
      await baseline;
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(await screen.findByText('Authoritative server-only item')).toBeInTheDocument();
    await waitFor(() => expect(subscribeTurnEvents).toHaveBeenCalledTimes(1));

    releaseStream();
    expect(await screen.findByText('Authoritative remount stream item')).toBeInTheDocument();
    expect(screen.getAllByText('Authoritative remount stream item')).toHaveLength(1);
    const finalItems = queryClient.getQueryData<{ id: string }[]>(chatKeys.items('ws1', 'th1'));
    expect(finalItems?.filter((item) => item.id === serverOnlyItem.id)).toHaveLength(1);
    expect(finalItems?.filter((item) => item.id === STREAMING_ITEM.id)).toHaveLength(1);
  });

  it('surfaces a dropped stream and retries only through the existing affordance', async () => {
    const user = userEvent.setup();
    const droppedStream = {
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockRejectedValue(new Error('stream dropped')) };
      },
    };
    async function* reconnectedStream() {
      yield turnStreamEvent(1, 'item.completed', {
        type: 'item-completed',
        itemId: STREAMING_ITEM.id,
        item: {
          ...STREAMING_ITEM,
          status: 'completed',
          text: 'Reconnected result',
          completedAt: '2026-07-21T00:00:02.000Z',
        },
      });
      yield turnStreamEvent(2, 'turn.completed', {
        type: 'turn-completed',
        stopReason: 'completed',
        turn: { ...ACTIVE_TURN, status: 'completed' },
      });
    }

    const subscribeTurnEvents = vi
      .fn()
      .mockReturnValueOnce(droppedStream)
      .mockReturnValueOnce(reconnectedStream());
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        subscribeTurnEvents,
      },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText("Couldn't reach the local runtime.")).toBeInTheDocument();
    expect(subscribeTurnEvents).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Reconnected result')).toBeInTheDocument();
    await waitFor(() => expect(subscribeTurnEvents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't reach the local runtime.")).not.toBeInTheDocument()
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it('clears the disconnected posture when retry receives terminal empty replay', async () => {
    const user = userEvent.setup();
    const droppedStream = {
      [Symbol.asyncIterator]() {
        return { next: vi.fn().mockRejectedValue(new Error('stream dropped')) };
      },
    };
    const terminalEmptyReplay = {
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        };
      },
    };

    const subscribeTurnEvents = vi
      .fn()
      .mockReturnValueOnce(droppedStream)
      .mockReturnValueOnce(terminalEmptyReplay);
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        subscribeTurnEvents,
      },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText("Couldn't reach the local runtime.")).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(subscribeTurnEvents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't reach the local runtime.")).not.toBeInTheDocument()
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('preserves an authoritative completed item across replayed creation and a drop', async () => {
    let releaseReplay!: () => void;
    const waitForReplay = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const completedItem = {
      ...STREAMING_ITEM,
      status: 'completed',
      text: 'Already authoritative',
      completedAt: '2026-07-21T00:00:02.000Z',
    };
    async function* replayThenDrop() {
      await waitForReplay;
      yield turnStreamEvent(1, 'item.created', {
        type: 'item-created',
        item: STREAMING_ITEM,
      });
      throw new Error('stream dropped');
    }

    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: [completedItem], nextCursor: null }),
        subscribeTurnEvents: vi.fn().mockReturnValue(replayThenDrop()),
      },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [ACTIVE_TURN] }) }
    );

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText('Already authoritative')).toBeInTheDocument();
    releaseReplay();
    expect(await screen.findByText("Couldn't reach the local runtime.")).toBeInTheDocument();
    expect(screen.getByText('Already authoritative')).toBeInTheDocument();
  });
});

describe('task thread (board 04)', () => {
  it('frames the thread as a task and shows the inline approval-card pattern', async () => {
    const client = makeClient({
      listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
    });
    renderApp('/tasks/ws1/th1', client);
    expect(await screen.findByText('Task')).toBeInTheDocument();
    expect(screen.getByText('Approve $5 spend')).toBeInTheDocument();
  });

  it('dispatches the task Composer through the reusable warm Worker target', async () => {
    const user = userEvent.setup();
    const startTurn = vi.fn();
    const startTaskMode = vi.fn().mockResolvedValue(TASK_MODE_RESPONSE);
    const submitConversation = vi.fn().mockResolvedValue({
      ...CHAT_MODE_RESPONSE,
      targetRef: 'warm-worker:agent_codex_host:default',
    });
    const quickChat = vi.fn();
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        startTurn,
      },
      { quickChat, submitConversation, startTaskMode }
    );

    renderApp('/tasks/ws1/th1', client);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Ship the fix');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(submitConversation).toHaveBeenCalledWith(
        'ws1',
        'th1',
        expect.objectContaining({
          input: 'Ship the fix',
          targetRef: 'warm-worker:agent_codex_host:default',
        })
      )
    );
    expect(startTaskMode).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(quickChat).not.toHaveBeenCalled();
  });
});

describe('mode entry and feedback (S8)', () => {
  it('uses the ordinary Chat Mode path for the built-in Quick Chat workspace', async () => {
    const user = userEvent.setup();
    const startTurn = vi.fn();
    const submitConversation = vi.fn().mockResolvedValue(QUICK_CHAT_MODE_RESPONSE);
    const startTaskMode = vi.fn();
    const quickChat = vi.fn();
    const client = makeClient(
      {
        getThread: vi.fn().mockResolvedValue({ ...THREAD, workspaceId: QUICK_CHAT_WORKSPACE.id }),
        listThreadItems: vi.fn().mockResolvedValue({ items: ITEMS, nextCursor: null }),
        listWorkspaces: vi.fn().mockResolvedValue({ items: [QUICK_CHAT_WORKSPACE] }),
        startTurn,
      },
      { quickChat, submitConversation, startTaskMode }
    );

    renderApp('/chat/ws_quick_chat/th1', client);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Answer directly');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(submitConversation).toHaveBeenCalledWith(
        'ws_quick_chat',
        'th1',
        expect.objectContaining({
          input: 'Answer directly',
          targetRef: 'internal-role:assistant',
        })
      )
    );
    expect(startTaskMode).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(quickChat).not.toHaveBeenCalled();
  });

  it('refreshes only the submitted composer owner after a workspace switch', async () => {
    const user = userEvent.setup();
    const started = createDeferred<typeof CHAT_MODE_RESPONSE>();
    const submitConversation = vi.fn().mockReturnValue(started.promise);
    const workspaceBThread = {
      ...THREAD,
      workspaceId: 'ws2',
      name: 'Workspace B teardown',
      preview: 'Workspace B teardown',
    };
    const workspaceBItem = ItemSchema.parse({
      ...ITEMS[0],
      id: 'i-ws2',
      workspaceId: 'ws2',
      turnId: 't-ws2',
      text: 'Workspace B stays authoritative.',
    });
    const client = makeClient(
      {
        getThread: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve(workspaceId === 'ws2' ? workspaceBThread : THREAD)
          ),
        listThreads: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve({ items: [workspaceId === 'ws2' ? workspaceBThread : THREAD] })
          ),
        listThreadItems: vi.fn().mockImplementation((workspaceId: string) =>
          Promise.resolve({
            items: workspaceId === 'ws2' ? [workspaceBItem] : ITEMS,
            nextCursor: null,
          })
        ),
      },
      { submitConversation }
    );
    const queryClient = renderApp('/chat/ws1/th1', client);
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Continue A');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(submitConversation).toHaveBeenCalledWith(
        'ws1',
        'th1',
        expect.objectContaining({ input: 'Continue A', targetRef: 'internal-role:assistant' })
      )
    );

    await switchToThread(user, 'Market research', 'Second workspace', 'Workspace B teardown');
    expect(await screen.findByText('Workspace B stays authoritative.')).toBeInTheDocument();
    await act(async () => {
      started.resolve(CHAT_MODE_RESPONSE);
      await started.promise;
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: chatKeys.items('ws1', 'th1') });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: chatKeys.dashboard('ws1', 'th1'),
      });
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: chatKeys.items('ws2', 'th1'),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: chatKeys.dashboard('ws2', 'th1'),
    });
    expect(queryClient.getQueryData(chatKeys.items('ws2', 'th1'))).toEqual([workspaceBItem]);
    expect(screen.queryByText("Couldn't send that message. Try again.")).not.toBeInTheDocument();
  });

  it('does not offer feedback for a completed Turn without a completed assistant message', async () => {
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: [ITEMS[0]], nextCursor: null }),
      },
      { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [COMPLETED_TURN] }) }
    );

    renderApp('/chat/ws1/th1', client);

    expect(await screen.findByText('Draft a competitive teardown.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /good/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bad/i })).not.toBeInTheDocument();
  });

  it.each([
    'success',
    'failure',
  ] as const)('keeps a late workspace A feedback %s out of workspace B', async (settlement) => {
    const user = userEvent.setup();
    const priorFeedback = {
      turnId: 't1',
      agentId: 'agent_assistant',
      rating: 'good' as const,
      note: null,
      createdAt: '2026-07-21T00:00:03.000Z',
    };
    const settledFeedback = {
      ...priorFeedback,
      rating: 'bad' as const,
      createdAt: '2026-07-21T00:00:04.000Z',
    };
    const submitted = createDeferred<typeof settledFeedback>();
    const submitTurnFeedback = vi.fn().mockReturnValue(submitted.promise);
    const workspaceBThread = {
      ...THREAD,
      workspaceId: 'ws2',
      name: 'Workspace B teardown',
      preview: 'Workspace B teardown',
    };
    const workspaceBTurn = TurnSchema.parse({
      ...COMPLETED_TURN,
      id: 't-ws2',
      workspaceId: 'ws2',
      triggerActor: { kind: 'user', id: 'user_workspace_b' },
    });
    const workspaceBAssistant = ItemSchema.parse({
      ...ITEMS[1],
      id: 'i-ws2-assistant',
      workspaceId: 'ws2',
      turnId: workspaceBTurn.id,
      text: 'Workspace B answer.',
    });
    const client = makeClient(
      {
        getThread: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve(workspaceId === 'ws2' ? workspaceBThread : THREAD)
          ),
        listThreads: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve({ items: [workspaceId === 'ws2' ? workspaceBThread : THREAD] })
          ),
        listThreadItems: vi.fn().mockImplementation((workspaceId: string) =>
          Promise.resolve({
            items: workspaceId === 'ws2' ? [workspaceBAssistant] : [ITEMS[1]],
            nextCursor: null,
          })
        ),
      },
      {
        getThreadDashboard: vi
          .fn()
          .mockImplementation((workspaceId: string) =>
            Promise.resolve({ turns: [workspaceId === 'ws2' ? workspaceBTurn : COMPLETED_TURN] })
          ),
        submitTurnFeedback,
      }
    );
    const queryClient = renderApp('/chat/ws1/th1', client, (cache) => {
      cache.setQueryData(chatKeys.feedback('ws1', 'th1', 't1'), priorFeedback);
    });

    await user.click(await screen.findByRole('button', { name: /bad/i }));
    await waitFor(() =>
      expect(submitTurnFeedback).toHaveBeenCalledWith('t1', { rating: 'bad', note: null })
    );

    await switchToThread(user, 'Market research', 'Second workspace', 'Workspace B teardown');
    expect(await screen.findByText('Workspace B answer.')).toBeInTheDocument();
    await act(async () => {
      if (settlement === 'success') submitted.resolve(settledFeedback);
      else submitted.reject(new Error('feedback rejected'));
      await submitted.promise.catch(() => undefined);
    });

    await waitFor(() => expect(submitTurnFeedback).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(queryClient.getQueryData(chatKeys.feedback('ws1', 'th1', 't1'))).toEqual(
      settlement === 'success' ? settledFeedback : priorFeedback
    );
    expect(
      queryClient.getQueryData(chatKeys.feedback('ws2', 'th1', workspaceBTurn.id))
    ).toBeUndefined();
    expect(screen.getByRole('button', { name: /good/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /bad/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps one feedback selection per completed Turn and applies only authoritative responses', async () => {
    const user = userEvent.setup();
    const goodResponse = {
      turnId: 't1',
      agentId: 'agent_assistant',
      rating: 'good' as const,
      note: null,
      createdAt: '2026-07-21T00:00:03.000Z',
    };
    const badResponse = {
      ...goodResponse,
      rating: 'bad' as const,
      createdAt: '2026-07-21T00:00:04.000Z',
    };
    const good = createDeferred<typeof goodResponse>();
    const bad = createDeferred<typeof badResponse>();
    const submitTurnFeedback = vi
      .fn()
      .mockReturnValueOnce(good.promise)
      .mockReturnValueOnce(bad.promise);
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({
          items: [ITEMS[1], SECOND_ASSISTANT_ITEM],
          nextCursor: null,
        }),
      },
      {
        getThreadDashboard: vi.fn().mockResolvedValue({ turns: [COMPLETED_TURN] }),
        submitTurnFeedback,
      }
    );

    renderApp('/chat/ws1/th1', client);
    await screen.findByText('Here is the completed pricing comparison.');
    const goodButtons = screen.getAllByRole('button', { name: /good/i });
    const badButtons = screen.getAllByRole('button', { name: /bad/i });
    expect(goodButtons).toHaveLength(1);
    expect(badButtons).toHaveLength(1);
    const goodButton = goodButtons[0]!;
    const badButton = badButtons[0]!;

    await user.click(goodButton);
    expect(submitTurnFeedback).toHaveBeenNthCalledWith(1, 't1', {
      rating: 'good',
      note: null,
    });
    expect(goodButton).toHaveAttribute('aria-pressed', 'false');
    await act(async () => {
      good.resolve(goodResponse);
      await good.promise;
    });
    await waitFor(() => expect(goodButton).toHaveAttribute('aria-pressed', 'true'));

    await user.click(badButton);
    expect(submitTurnFeedback).toHaveBeenNthCalledWith(2, 't1', {
      rating: 'bad',
      note: null,
    });
    expect(goodButton).toHaveAttribute('aria-pressed', 'true');
    expect(badButton).toHaveAttribute('aria-pressed', 'false');
    await act(async () => {
      bad.resolve(badResponse);
      await bad.promise;
    });
    await waitFor(() => expect(badButton).toHaveAttribute('aria-pressed', 'true'));
    expect(goodButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('retains the prior feedback after rejection and retries the exact failed command', async () => {
    const user = userEvent.setup();
    const goodResponse = {
      turnId: 't1',
      agentId: 'agent_assistant',
      rating: 'good' as const,
      note: null,
      createdAt: '2026-07-21T00:00:03.000Z',
    };
    const badResponse = {
      ...goodResponse,
      rating: 'bad' as const,
      createdAt: '2026-07-21T00:00:05.000Z',
    };
    const submitTurnFeedback = vi
      .fn()
      .mockResolvedValueOnce(goodResponse)
      .mockRejectedValueOnce(new Error('feedback_unavailable'))
      .mockResolvedValueOnce(badResponse);
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: [ITEMS[1]], nextCursor: null }),
      },
      {
        getThreadDashboard: vi.fn().mockResolvedValue({ turns: [COMPLETED_TURN] }),
        submitTurnFeedback,
      }
    );

    renderApp('/chat/ws1/th1', client);
    const goodButton = await screen.findByRole('button', { name: /good/i });
    const badButton = screen.getByRole('button', { name: /bad/i });
    await user.click(goodButton);
    await waitFor(() => expect(goodButton).toHaveAttribute('aria-pressed', 'true'));

    await user.click(badButton);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(goodButton).toHaveAttribute('aria-pressed', 'true');
    expect(badButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(submitTurnFeedback).toHaveBeenNthCalledWith(3, 't1', {
        rating: 'bad',
        note: null,
      })
    );
    await waitFor(() => expect(badButton).toHaveAttribute('aria-pressed', 'true'));
    expect(goodButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('rejects feedback responses owned by a different Turn without replacing prior state', async () => {
    const user = userEvent.setup();
    const priorFeedback = {
      turnId: 't1',
      agentId: 'agent_assistant',
      rating: 'good' as const,
      note: null,
      createdAt: '2026-07-21T00:00:03.000Z',
    };
    const mismatchedResponse = {
      ...priorFeedback,
      turnId: 't-other',
      rating: 'bad' as const,
      createdAt: '2026-07-21T00:00:04.000Z',
    };
    const retryResponse = {
      ...priorFeedback,
      rating: 'bad' as const,
      createdAt: '2026-07-21T00:00:05.000Z',
    };
    const submitTurnFeedback = vi
      .fn()
      .mockResolvedValueOnce(mismatchedResponse)
      .mockResolvedValueOnce(retryResponse);
    const client = makeClient(
      {
        listThreadItems: vi.fn().mockResolvedValue({ items: [ITEMS[1]], nextCursor: null }),
      },
      {
        getThreadDashboard: vi.fn().mockResolvedValue({ turns: [COMPLETED_TURN] }),
        submitTurnFeedback,
      }
    );
    const queryClient = renderApp('/chat/ws1/th1', client, (cache) => {
      cache.setQueryData(chatKeys.feedback('ws1', 'th1', 't1'), priorFeedback);
    });

    const goodButton = await screen.findByRole('button', { name: /good/i });
    const badButton = screen.getByRole('button', { name: /bad/i });
    await user.click(badButton);

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save feedback.");
    expect(queryClient.getQueryData(chatKeys.feedback('ws1', 'th1', 't1'))).toEqual(priorFeedback);
    expect(queryClient.getQueryData(chatKeys.feedback('ws1', 'th1', 't-other'))).toBeUndefined();
    expect(goodButton).toHaveAttribute('aria-pressed', 'true');
    expect(badButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(submitTurnFeedback).toHaveBeenNthCalledWith(2, 't1', {
        rating: 'bad',
        note: null,
      })
    );
    await waitFor(() => expect(badButton).toHaveAttribute('aria-pressed', 'true'));
    expect(queryClient.getQueryData(chatKeys.feedback('ws1', 'th1', 't-other'))).toBeUndefined();
  });
});
