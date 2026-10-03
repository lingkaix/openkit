import type { ConversationTargetCatalog } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { TurnSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
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
  name: 'Effort conversation',
  preview: 'Effort conversation',
  status: 'active',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const COMPLETED_TURN = TurnSchema.parse({
  id: 't1',
  workspaceId: 'ws1',
  threadId: 'th1',
  triggerActor: { kind: 'user', id: 'user_editor' },
  items: [],
  error: null,
  configVersion: null,
  startedAt: '2026-10-02T00:00:00.000Z',
  completedAt: '2026-10-02T00:00:01.000Z',
  durationMs: 1000,
  status: 'completed',
});

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
  ],
};

type CoreOverrides = Partial<Record<string, unknown>>;
type AppOverrides = Partial<Record<string, unknown>>;

/** Holds command settlement so tests observe the complete pending request. */
function createDeferred<T>() {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((_resolvePromise, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(core: CoreOverrides = {}, app: AppOverrides = {}): CoreClient {
  const client = {
    core: {
      meta: vi.fn().mockResolvedValue({}),

      ...core,
    },
    app: {
      ...app,
    },

    operations: {
      'thread.list': vi.fn().mockResolvedValue({ items: [] }),
      'conversation.targets': vi
        .fn()
        .mockImplementation(
          ({ workspaceId, threadId }: { workspaceId: string; threadId?: string }) =>
            Promise.resolve({
              ...CONVERSATION_TARGET,
              workspaceId,
              threadId: threadId ?? null,
            })
        ),

      'thread.read': vi.fn().mockResolvedValue(THREAD),
      'thread.items': vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      'thread.create': vi.fn().mockResolvedValue({ ...THREAD, id: 'th-new' }),
      'thread.dashboard': vi.fn().mockResolvedValue({ turns: [] }),
      ...core,
      ...app,
      'workspace.list': vi
        .fn()
        .mockResolvedValueOnce({
          items: [
            { id: 'ws1', name: 'Market research' },
            { id: 'ws2', name: 'Second workspace' },
          ].map((workspace) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'user_local',
            registryRevision: 1,
          })),
        })
        .mockImplementation(
          ((core['workspace.list'] ?? app['workspace.list']) as
            | CoreClient['operations']['workspace.list']
            | undefined) ??
            vi.fn().mockResolvedValue({
              items: [
                { id: 'ws1', name: 'Market research' },
                { id: 'ws2', name: 'Second workspace' },
              ].map((workspace) => ({
                workspace,
                effectiveRole: 'owner',
                membershipRevision: 1,
                ownerUserId: 'user_local',
                registryRevision: 1,
              })),
            })
        ),
    },
  } as unknown as CoreClient;
  if (app['conversation.navigation'] == null) {
    (
      client.operations as {
        'conversation.navigation': CoreClient['operations']['conversation.navigation'];
      }
    )['conversation.navigation'] = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      const listed = await client.operations['thread.list']({ workspaceId: workspaceId });
      return {
        items: listed.items
          .filter((thread) => thread.status === 'active')
          .map((thread) => ({
            activity: 'chat' as const,
            lastActivityAt: thread.updatedAt,
            state: 'idle' as const,
            thread: {
              ...thread,
              entryPath: 'conversation' as const,
              visibility: 'workspace' as const,
            },
          })),
      };
    });
  }
  return client;
}

/**
 * Render one route with an isolated query cache and expose that public cache seam.
 *
 * @param path Initial application route.
 * @param client Core Client fake used by the rendered application.
 * @returns The isolated TanStack Query client used by the render.
 */
function renderApp(path: string, client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

/** Advertisements deliberately arrive out of order; the UI must use the Core order. */
const EFFORT_MODELS: ConversationTargetCatalog['targets'][number]['logicalModels'] = [
  {
    id: 'reasoner',
    label: 'Reasoner',
    capabilities: ['chat', 'reasoning'],
    reasoningEffortLevels: ['max', 'high', 'none', 'medium', 'xhigh', 'low', 'minimal'] as const,
  },
  {
    id: 'restricted',
    label: 'Restricted',
    capabilities: ['chat', 'reasoning'],
    reasoningEffortLevels: ['medium', 'low'] as const,
  },
  { id: 'plain', label: 'Plain', capabilities: ['chat'], reasoningEffortLevels: ['high'] as const },
  { id: 'empty', label: 'Empty', capabilities: ['reasoning'], reasoningEffortLevels: [] },
  { id: 'unadvertised', label: 'Unadvertised', capabilities: ['reasoning'] },
];

/** Keeps model metadata at the existing catalog seam, with no provider inference in fixtures. */
function effortCatalog() {
  return {
    ...CONVERSATION_TARGET,
    targets: CONVERSATION_TARGET.targets.map((target) => ({
      ...target,
      logicalModels: EFFORT_MODELS.map((model) => ({
        ...model,
        ...(model.reasoningEffortLevels
          ? { reasoningEffortLevels: [...model.reasoningEffortLevels] }
          : {}),
      })),
      defaultLogicalModelId: 'reasoner',
    })),
  };
}

/** Uses the existing React Aria model picker through its visible controls. */
async function chooseEffortModel(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('button', { name: /Logical model/ }));
  await user.click(await screen.findByRole('option', { name: label }));
}

/** Selects an advertised effort through the same picker behavior as a model. */
async function chooseEffort(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('button', { name: /Reasoning effort/ }));
  await user.click(await screen.findByRole('option', { name: label }));
}

describe.each([
  ['starter', '/chat'],
  ['Thread', '/chat/ws1/th1'],
])('Composer reasoning effort on %s', (surface, path) => {
  it('offers only advertised efforts in canonical order and updates with the model', async () => {
    const user = userEvent.setup();
    renderApp(
      path,
      makeClient({}, { 'conversation.targets': vi.fn().mockResolvedValue(effortCatalog()) })
    );
    const trigger = await screen.findByRole('button', { name: /Reasoning effort/ });
    expect(trigger.closest('form')?.lastElementChild).toContainElement(trigger);
    await user.click(trigger);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'None',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Xhigh',
      'Max',
    ]);
    await user.keyboard('{Escape}');
    await chooseEffortModel(user, 'Restricted');
    await user.click(screen.getByRole('button', { name: /Reasoning effort/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Low',
      'Medium',
    ]);
  });

  it.each(['Plain', 'Empty', 'Unadvertised'])('hides effort for %s', async (model) => {
    const user = userEvent.setup();
    renderApp(
      path,
      makeClient({}, { 'conversation.targets': vi.fn().mockResolvedValue(effortCatalog()) })
    );
    await chooseEffortModel(user, model);
    expect(screen.queryByRole('button', { name: /Reasoning effort/ })).not.toBeInTheDocument();
  });

  it('preselects the last recorded admitted effort only on a Thread and submits it explicitly', async () => {
    const user = userEvent.setup();
    const submitConversation = vi.fn().mockReturnValue(new Promise(() => {}));
    renderApp(
      path,
      makeClient(
        {},
        {
          'conversation.targets': vi.fn().mockResolvedValue(effortCatalog()),
          // The newer Turn has no override; it does not erase the last admitted choice.
          'thread.dashboard': vi.fn().mockResolvedValue({
            turns: [
              { ...COMPLETED_TURN, reasoningEffort: 'high' },
              { ...COMPLETED_TURN, id: 't2' },
            ],
          }),
          'conversation.submit': submitConversation,
        }
      )
    );
    const effort = await screen.findByRole('button', { name: /Reasoning effort/ });
    if (surface === 'Thread') await waitFor(() => expect(effort).toHaveTextContent('High'));
    else {
      expect(effort).toHaveTextContent('Effort');
      await chooseEffort(user, 'High');
    }
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Use the visible effort');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(submitConversation.mock.calls[0]?.[0]).toMatchObject({
      reasoningEffort: 'high',
      logicalModelId: 'reasoner',
    });
  });

  it.each([
    undefined,
    'high',
  ] as const)('has no preselection or submitted effort when the last effort %s is not advertised', async (reasoningEffort) => {
    const user = userEvent.setup();
    const catalog = effortCatalog();
    catalog.targets.forEach((target) => {
      target.defaultLogicalModelId = 'restricted';
    });
    const submitConversation = vi.fn().mockReturnValue(new Promise(() => {}));
    renderApp(
      path,
      makeClient(
        {},
        {
          'conversation.targets': vi.fn().mockResolvedValue(catalog),
          'thread.dashboard': vi
            .fn()
            .mockResolvedValue({ turns: [{ ...COMPLETED_TURN, reasoningEffort }] }),
          'conversation.submit': submitConversation,
        }
      )
    );
    expect(await screen.findByRole('button', { name: /Reasoning effort/ })).toHaveTextContent(
      'Effort'
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'No override');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(submitConversation.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort');
  });

  it('drops an incompatible choice on model change and derives preselection from this Thread', async () => {
    const user = userEvent.setup();
    renderApp(
      path,
      makeClient(
        {},
        {
          'conversation.targets': vi.fn().mockResolvedValue(effortCatalog()),
          'thread.dashboard': vi
            .fn()
            .mockResolvedValue({ turns: [{ ...COMPLETED_TURN, reasoningEffort: 'high' }] }),
        }
      )
    );
    await chooseEffort(user, 'Max');
    await chooseEffortModel(user, 'Restricted');
    expect(screen.getByRole('button', { name: /Reasoning effort/ })).toHaveTextContent('Effort');
    await chooseEffortModel(user, 'Reasoner');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Reasoning effort/ })).toHaveTextContent(
        surface === 'Thread' ? 'High' : 'Effort'
      )
    );
  });

  it('supports keyboard selection with a named control, visible focus tokens and focus restoration', async () => {
    const user = userEvent.setup();
    const submitConversation = vi.fn().mockReturnValue(new Promise(() => {}));
    renderApp(
      path,
      makeClient(
        {},
        {
          'conversation.targets': vi.fn().mockResolvedValue(effortCatalog()),
          'conversation.submit': submitConversation,
        }
      )
    );
    const trigger = await screen.findByRole('button', { name: /Reasoning effort/ });
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-focus');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('listbox', { name: 'Reasoning effort' })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveTextContent('Low');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keyboard effort');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    expect(submitConversation.mock.calls[0]?.[0]).toHaveProperty('reasoningEffort', 'low');
  });

  it.each([
    ['failure', new ApiCallError(409, 'Busy', { code: 'target_busy' })],
    ['uncertainty', new TypeError('Transport closed')],
  ])('retains the entire %s request across a catalog refresh and exact retry', async (_kind, error) => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    const submitConversation = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValue(error);
    let catalog = effortCatalog();
    const getConversationTargets = vi.fn().mockImplementation(() => Promise.resolve(catalog));
    const createThread = vi.fn().mockResolvedValue({ ...THREAD, id: 'th-new' });
    const cache = renderApp(
      path,
      makeClient(
        {
          'thread.create': createThread,
          'thread.read': vi
            .fn()
            .mockResolvedValue({ ...THREAD, id: surface === 'starter' ? 'th-new' : 'th1' }),
          'artifact.list': vi
            .fn()
            .mockResolvedValue({ items: [{ id: 'brief', version: 2, title: 'Brief' }] }),
        },
        {
          'conversation.targets': getConversationTargets,
          'conversation.submit': submitConversation,
        }
      )
    );
    await chooseEffort(user, 'High');
    await user.click(screen.getByRole('button', { name: 'Add artifact or upload attachment' }));
    await user.click(await screen.findByRole('button', { name: 'Brief' }));
    await user.keyboard('{Escape}');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Exact draft  ');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(1));
    const first = submitConversation.mock.calls[0];
    expect(first?.[0]).toEqual({
      workspaceId: 'ws1',
      threadId: path === '/chat' ? 'th-new' : 'th1',
      input: 'Exact draft  ',
      targetRef: 'internal-role:assistant',
      logicalModelId: 'reasoner',
      reasoningEffort: 'high',
      artifactRefs: [{ artifactId: 'brief', artifactVersion: 2 }],
      requestId: expect.any(String),
    });
    expect(await screen.findByRole('button', { name: 'Send message' })).toBeDisabled();
    catalog = effortCatalog();
    catalog.targets.forEach((target) => {
      target.logicalModels = target.logicalModels.map((model) =>
        model.id === 'reasoner' ? { ...model, reasoningEffortLevels: ['low'] } : model
      );
    });
    await act(async () => {
      await cache.invalidateQueries({ queryKey: ['conversation-targets'] });
    });
    await act(async () => pending.reject(error));
    expect(await screen.findByText("Couldn't send that message. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Exact draft  ');
    expect(screen.getByRole('button', { name: 'Remove Brief' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Reasoning effort/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Low']);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(2));
    expect(submitConversation.mock.calls[1]).toEqual(first);
    expect(createThread).toHaveBeenCalledTimes(surface === 'starter' ? 1 : 0);
  });

  it('retains omission on retry even when a later dashboard and catalog advertise an admitted effort', async () => {
    const user = userEvent.setup();
    const submitConversation = vi.fn().mockRejectedValue(new TypeError('Uncertain result'));
    const cache = renderApp(
      path,
      makeClient(
        {},
        {
          'conversation.targets': vi.fn().mockResolvedValue(effortCatalog()),
          'conversation.submit': submitConversation,
        }
      )
    );
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Keep omission');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText("Couldn't send that message. Try again.")).toBeInTheDocument();
    const first = submitConversation.mock.calls[0];
    expect(first?.[0]).not.toHaveProperty('reasoningEffort');
    await act(async () => {
      cache.setQueryData(chatKeys.dashboard('ws1', surface === 'starter' ? 'th-new' : 'th1'), {
        turns: [{ ...COMPLETED_TURN, reasoningEffort: 'high' }],
      });
      await cache.invalidateQueries({ queryKey: ['conversation-targets'] });
    });
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(submitConversation).toHaveBeenCalledTimes(2));
    expect(submitConversation.mock.calls[1]).toEqual(first);
  });
});
