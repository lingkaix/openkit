import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { SURFACES } from '../../app/surfaces';
import { STATUS_CLASS } from '../../primitives';
import { useWorkspaceStore } from '../workspace-store';
import { useSaveWorkspaceMaterialRevision } from './data';

const WORKSPACE_ID = 'ws_materials';
const THREAD_ID = 'thread_materials';
const MATERIAL_ID = 'material_release_notes';
const TIMESTAMP = '2026-08-03T00:00:00.000Z';
const MATERIAL_ACTION_NAME =
  /new material|create material|save|bind material|unbind|exclude|restore|send.*(?:now|current revision)|follow.?up|cancel/i;

it('requires an exact Thread id for every Material revision save', () => {
  expectTypeOf(useSaveWorkspaceMaterialRevision).parameter(2).toEqualTypeOf<string>();
});

const MATERIAL = {
  workspaceId: WORKSPACE_ID,
  materialId: MATERIAL_ID,
  title: 'Release notes',
  kind: 'markdown' as const,
  currentRevisionId: 'revision_2',
  sensitivity: 'internal' as const,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const REVISION_1 = {
  workspaceId: WORKSPACE_ID,
  materialId: MATERIAL_ID,
  revisionId: 'revision_1',
  parentRevisionId: null,
  mediaType: 'text/markdown' as const,
  contentDigest: 'sha256:96dedef0f21abaa9874b529b84fa425c3c30af02596ac0962e2bbbb53abadf74',
  authorId: 'user_editor',
  createdAt: '2026-08-03T00:00:00.000Z',
  content: '# Release notes\nFirst draft.\n',
};

const REVISION_2 = {
  workspaceId: WORKSPACE_ID,
  materialId: MATERIAL_ID,
  revisionId: 'revision_2',
  parentRevisionId: REVISION_1.revisionId,
  mediaType: 'text/markdown' as const,
  contentDigest: 'sha256:67dd813bbaa3012d8dffe3a0555859cd323550f99d709830981dad5ba218b70f',
  authorId: 'user_editor',
  createdAt: '2026-08-03T00:01:00.000Z',
  content: '# Release notes\n',
};

const REVISION_2_SUMMARY = {
  workspaceId: WORKSPACE_ID,
  materialId: MATERIAL_ID,
  revisionId: REVISION_2.revisionId,
  parentRevisionId: REVISION_2.parentRevisionId,
  mediaType: REVISION_2.mediaType,
  contentDigest: REVISION_2.contentDigest,
  authorId: REVISION_2.authorId,
  createdAt: REVISION_2.createdAt,
};

const THREAD_QUEUED_REVISION_ID = 'revision_queued';
const THREAD_RESTORED_QUEUE_ID = 'revision_restored';
const DELIVERY_PENDING_TURN_ID = 'pending_material_delivery';
const DELIVERY_REQUEST_ID = 'request_material_delivery';

const QUEUED_DELIVERY = {
  state: 'queued' as const,
  pendingTurnId: DELIVERY_PENDING_TURN_ID,
  requestId: DELIVERY_REQUEST_ID,
  contentItemId: 'item_material_delivery',
  goalId: 'goal_material_delivery',
  activeTurnId: 'turn_material_delivery',
  materialId: MATERIAL_ID,
  revisionId: REVISION_2.revisionId,
  contentDigest: REVISION_2.contentDigest,
};

const THREAD_MATERIAL = {
  workspaceId: WORKSPACE_ID,
  threadId: THREAD_ID,
  resource: MATERIAL,
  currentRevision: REVISION_2_SUMMARY,
  inclusionState: 'included' as const,
  latestQueuedRevisionId: THREAD_QUEUED_REVISION_ID,
  lastWorkerSeenRevisionId: 'revision_worker_seen',
  currentTurnRevisionId: 'revision_current_turn',
  activeDelivery: null,
};

const NULL_THREAD_MATERIAL = {
  ...THREAD_MATERIAL,
  currentRevision: null,
  latestQueuedRevisionId: null,
  lastWorkerSeenRevisionId: null,
  currentTurnRevisionId: null,
};

type MethodOverrides = Partial<Record<string, unknown>>;

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

/** Build a fake Core Client whose Material operations remain individually observable. */
function makeClient(overrides: { core?: MethodOverrides; app?: MethodOverrides } = {}): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({
        items: [{ id: WORKSPACE_ID, name: 'Product workspace' }],
      }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      getThread: vi.fn().mockResolvedValue({
        id: THREAD_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Release',
        status: 'active',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      }),
      startTurn: vi.fn(),
      ...overrides.core,
    },
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
      listWorkspaceMaterials: vi.fn().mockResolvedValue({ materials: [MATERIAL] }),
      createWorkspaceMaterial: vi.fn().mockResolvedValue({ materialId: 'material_new' }),
      getWorkspaceMaterial: vi.fn().mockResolvedValue({ material: MATERIAL }),
      listWorkspaceMaterialRevisions: vi.fn().mockResolvedValue({
        revisions: [REVISION_1, REVISION_2].map(({ content: _content, ...revision }) => revision),
      }),
      getWorkspaceMaterialRevision: vi
        .fn()
        .mockImplementation(async (_workspaceId, _materialId, revisionId) => {
          if (revisionId === REVISION_1.revisionId) {
            return { revision: REVISION_1 };
          }
          if (revisionId === REVISION_2.revisionId) {
            return { revision: REVISION_2 };
          }
          throw new Error(`Unknown revision id: ${revisionId}`);
        }),
      saveWorkspaceMaterialRevision: vi.fn().mockResolvedValue({
        materialId: MATERIAL_ID,
        revisionId: 'revision_3',
      }),
      getThreadMaterial: vi.fn().mockResolvedValue({ material: null }),
      bindThreadMaterial: vi.fn().mockResolvedValue({
        materialId: MATERIAL_ID,
        threadId: THREAD_ID,
        outcome: 'bound',
      }),
      unbindThreadMaterial: vi.fn().mockResolvedValue({
        materialId: MATERIAL_ID,
        threadId: THREAD_ID,
        outcome: 'unbound',
      }),
      excludeThreadMaterial: vi.fn().mockResolvedValue({
        materialId: MATERIAL_ID,
        threadId: THREAD_ID,
        outcome: 'excluded',
      }),
      restoreThreadMaterial: vi.fn().mockResolvedValue({
        materialId: MATERIAL_ID,
        threadId: THREAD_ID,
        outcome: 'included',
      }),
      submitThreadGoalSteering: vi.fn().mockResolvedValue({
        state: 'queued',
        pendingTurnId: DELIVERY_PENDING_TURN_ID,
        requestId: DELIVERY_REQUEST_ID,
        contentItemId: QUEUED_DELIVERY.contentItemId,
        goalId: QUEUED_DELIVERY.goalId,
        activeTurnId: QUEUED_DELIVERY.activeTurnId,
      }),
      convertGoalSteeringToFollowUp: vi.fn().mockResolvedValue({
        state: 'follow-up',
        pendingTurnId: DELIVERY_PENDING_TURN_ID,
        requestId: 'request_material_follow_up',
        sourceRequestId: DELIVERY_REQUEST_ID,
        contentItemId: QUEUED_DELIVERY.contentItemId,
        goalId: QUEUED_DELIVERY.goalId,
        activeTurnId: QUEUED_DELIVERY.activeTurnId,
        followUpTurnId: 'turn_material_follow_up',
        followUpItemId: 'item_material_follow_up',
      }),
      cancelGoalSteering: vi.fn().mockResolvedValue({
        state: 'cancelled',
        pendingTurnId: DELIVERY_PENDING_TURN_ID,
        requestId: 'request_material_cancel',
        sourceRequestId: DELIVERY_REQUEST_ID,
        contentItemId: QUEUED_DELIVERY.contentItemId,
        goalId: QUEUED_DELIVERY.goalId,
        activeTurnId: QUEUED_DELIVERY.activeTurnId,
      }),
      startChatMode: vi.fn(),
      startTaskMode: vi.fn(),
      ...overrides.app,
    },
  } as unknown as CoreClient;
}

/** Resolve the route registered for the live Material surface without prescribing its path shape. */
function materialPath(materialId: string | null = MATERIAL_ID): string {
  const path = SURFACES.find(
    (surface) => surface.wp === 'WP-5' && /material/i.test(surface.title)
  )?.path;
  return (path ?? '/__missing-material-surface')
    .replace(/:workspaceId\??/, WORKSPACE_ID)
    .replace(/:threadId\??/, THREAD_ID)
    .replace(/:materialId\??/, materialId ?? '');
}

/** Render the registered Material route with isolated server state and client transport. */
function renderMaterial(client: CoreClient, materialId: string | null = MATERIAL_ID): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[materialPath(materialId)]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
});

describe('S19-F Material Workspace discovery barrier', () => {
  it.each([
    {
      settlement: 'empty',
      workspaces: [] as { id: string; name: string }[],
    },
    {
      settlement: 'authorized',
      workspaces: [{ id: WORKSPACE_ID, name: 'Product workspace' }],
    },
  ])('waits for discovery before projecting the $settlement settlement', async ({
    settlement,
    workspaces,
  }) => {
    const discovery = createDeferred<{ items: { id: string; name: string }[] }>();
    const client = makeClient({
      core: { listWorkspaces: vi.fn().mockReturnValue(discovery.promise) },
    });
    const materialOperations = [
      client.app.listWorkspaceMaterials,
      client.app.createWorkspaceMaterial,
      client.app.getWorkspaceMaterial,
      client.app.listWorkspaceMaterialRevisions,
      client.app.getWorkspaceMaterialRevision,
      client.app.saveWorkspaceMaterialRevision,
      client.app.getThreadMaterial,
      client.app.bindThreadMaterial,
      client.app.unbindThreadMaterial,
      client.app.excludeThreadMaterial,
      client.app.restoreThreadMaterial,
      client.app.submitThreadGoalSteering,
      client.app.convertGoalSteeringToFollowUp,
      client.app.cancelGoalSteering,
    ];
    renderMaterial(client);

    await screen.findByRole('main', { name: 'Workspace' });
    expect.soft(screen.queryAllByRole('status', { name: /loading/i }).length).toBeGreaterThan(0);
    expect
      .soft(screen.queryByText(/choose a workspace first|create your first material/i))
      .not.toBeInTheDocument();
    expect
      .soft(
        screen.queryByText(/couldn't load (?:workspace materials|this material|thread material)/i)
      )
      .not.toBeInTheDocument();
    expect
      .soft(
        screen
          .queryAllByRole('button')
          .filter((button) => MATERIAL_ACTION_NAME.test(button.textContent ?? ''))
      )
      .toHaveLength(0);
    for (const operation of materialOperations) expect.soft(operation).not.toHaveBeenCalled();

    await act(async () => {
      discovery.resolve({ items: workspaces });
      await discovery.promise;
    });

    if (settlement === 'empty') {
      expect(await screen.findByText(/choose a workspace first/i)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(
        screen
          .queryAllByRole('button')
          .filter((button) => MATERIAL_ACTION_NAME.test(button.textContent ?? ''))
      ).toHaveLength(0);
      for (const operation of materialOperations) expect(operation).not.toHaveBeenCalled();
      return;
    }

    expect(await screen.findByRole('textbox', { name: 'Release notes' })).toHaveValue(
      REVISION_2.content
    );
    await waitFor(() => {
      expect(client.app.listWorkspaceMaterials).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(client.app.getWorkspaceMaterial).toHaveBeenCalledWith(WORKSPACE_ID, MATERIAL_ID);
      expect(client.app.listWorkspaceMaterialRevisions).toHaveBeenCalledWith(
        WORKSPACE_ID,
        MATERIAL_ID
      );
      expect(client.app.getThreadMaterial).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID);
    });
  });

  it('keeps Workspace discovery failure retryable without projecting Material or Thread Material failure', async () => {
    const user = userEvent.setup();
    const retry = createDeferred<{ items: { id: string; name: string }[] }>();
    const listWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace discovery unavailable'))
      .mockReturnValueOnce(retry.promise);
    const client = makeClient({ core: { listWorkspaces } });
    const materialOperations = [
      client.app.listWorkspaceMaterials,
      client.app.createWorkspaceMaterial,
      client.app.getWorkspaceMaterial,
      client.app.listWorkspaceMaterialRevisions,
      client.app.getWorkspaceMaterialRevision,
      client.app.saveWorkspaceMaterialRevision,
      client.app.getThreadMaterial,
      client.app.bindThreadMaterial,
      client.app.unbindThreadMaterial,
      client.app.excludeThreadMaterial,
      client.app.restoreThreadMaterial,
      client.app.submitThreadGoalSteering,
      client.app.convertGoalSteeringToFollowUp,
      client.app.cancelGoalSteering,
    ];

    renderMaterial(client);

    expect(await screen.findByText("Couldn't load workspaces")).toBeInTheDocument();
    expect(
      screen.queryByText(/couldn't load (?:workspace materials|this material|thread material)/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/choose a workspace first|create your first material/i)
    ).not.toBeInTheDocument();
    expect(
      screen
        .queryAllByRole('button')
        .filter((button) => MATERIAL_ACTION_NAME.test(button.textContent ?? ''))
    ).toHaveLength(0);
    for (const operation of materialOperations) expect(operation).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('status', { name: /loading/i }).length).toBeGreaterThan(0);
    for (const operation of materialOperations) expect(operation).not.toHaveBeenCalled();
  });
});

describe('Workspace Material Plane 1 S11', () => {
  it('registers one live route and creates a Markdown Material through Core Client', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const surface = SURFACES.find(
      (candidate) => candidate.wp === 'WP-5' && /material/i.test(candidate.title)
    );

    expect(surface).toMatchObject({ tier: 'A', nav: 'route-only', wp: 'WP-5' });
    renderMaterial(client);

    await user.click(await screen.findByRole('button', { name: /new material/i }));
    await user.type(screen.getByRole('textbox', { name: /title/i }), 'Launch brief');
    await user.click(screen.getByLabelText(/markdown/i));
    await user.click(screen.getByLabelText(/internal/i));
    await user.click(screen.getByRole('button', { name: /create material/i }));

    await waitFor(() =>
      expect(client.app.createWorkspaceMaterial).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({
          title: 'Launch brief',
          kind: 'markdown',
          sensitivity: 'internal',
        })
      )
    );
    expect(client.core.startTurn).not.toHaveBeenCalled();
    expect(client.app.startChatMode).not.toHaveBeenCalled();
    expect(client.app.startTaskMode).not.toHaveBeenCalled();
  });

  it('keeps a failed Material list retryable before settling on an authoritative empty list', async () => {
    const user = userEvent.setup();
    const listWorkspaceMaterials = vi
      .fn()
      .mockRejectedValueOnce(new Error('list unavailable'))
      .mockResolvedValueOnce({ materials: [] });
    const client = makeClient({ app: { listWorkspaceMaterials } });
    renderMaterial(client, null);

    expect(screen.queryByText(/create your first material/i)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /try again/i }));

    await waitFor(() => expect(listWorkspaceMaterials).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/create your first material/i)).toBeInTheDocument();
    expect(
      (await screen.findAllByRole('button', { name: /new material/i })).length
    ).toBeGreaterThan(0);
  });

  it('preserves failed Material creation input for an explicit retry without starting work', async () => {
    const user = userEvent.setup();
    const createWorkspaceMaterial = vi
      .fn()
      .mockRejectedValueOnce(new Error('create unavailable'))
      .mockResolvedValueOnce({ materialId: 'material_new' });
    const client = makeClient({ app: { createWorkspaceMaterial } });
    renderMaterial(client);

    await user.click(await screen.findByRole('button', { name: /new material/i }));
    await user.type(screen.getByRole('textbox', { name: /title/i }), 'Launch brief');
    await user.click(screen.getByLabelText(/plain text/i));
    await user.click(screen.getByLabelText(/restricted/i));
    await user.click(screen.getByRole('button', { name: /create material/i }));

    await screen.findByRole('button', { name: /try again/i });
    expect(screen.getByRole('textbox', { name: /title/i })).toHaveValue('Launch brief');
    expect(screen.getByLabelText(/plain text/i)).toBeChecked();
    expect(screen.getByLabelText(/restricted/i)).toBeChecked();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(createWorkspaceMaterial).toHaveBeenCalledTimes(2));
    expect(createWorkspaceMaterial).toHaveBeenNthCalledWith(
      1,
      WORKSPACE_ID,
      expect.objectContaining({
        title: 'Launch brief',
        kind: 'text',
        sensitivity: 'restricted',
      })
    );
    expect(createWorkspaceMaterial).toHaveBeenNthCalledWith(
      2,
      WORKSPACE_ID,
      expect.objectContaining({
        title: 'Launch brief',
        kind: 'text',
        sensitivity: 'restricted',
      })
    );
    expect(client.core.startTurn).not.toHaveBeenCalled();
    expect(client.app.startChatMode).not.toHaveBeenCalled();
    expect(client.app.startTaskMode).not.toHaveBeenCalled();
  });

  it('creates and saves the first exact revision from a null-current Material', async () => {
    const user = userEvent.setup();
    const materialWithoutRevision = { ...MATERIAL, currentRevisionId: null };
    const saveWorkspaceMaterialRevision = vi.fn().mockResolvedValue({
      materialId: MATERIAL_ID,
      revisionId: 'revision_1',
    });
    const client = makeClient({
      app: {
        listWorkspaceMaterials: vi.fn().mockResolvedValue({ materials: [materialWithoutRevision] }),
        getWorkspaceMaterial: vi.fn().mockResolvedValue({ material: materialWithoutRevision }),
        listWorkspaceMaterialRevisions: vi.fn().mockResolvedValue({ revisions: [] }),
        saveWorkspaceMaterialRevision,
      },
    });
    renderMaterial(client);

    await waitFor(() => {
      const editor = screen.getByRole('textbox', { name: 'Release notes' });
      expect(editor).toHaveValue('');
      expect(editor).toBeEnabled();
    });
    await user.type(screen.getByRole('textbox', { name: 'Release notes' }), '# First draft.\n');
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(saveWorkspaceMaterialRevision).toHaveBeenCalledWith(
        WORKSPACE_ID,
        MATERIAL_ID,
        expect.objectContaining({
          expectedRevisionId: null,
          contentDigest: 'sha256:ec1119548ae594f4eabe554616b81c5ae0050d615c0f9934679b0d6a5dc44645',
          content: '# First draft.\n',
        })
      )
    );
    expect(saveWorkspaceMaterialRevision).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit Material route independent while the catalog read reports a retryable failure', async () => {
    const listWorkspaceMaterials = vi.fn().mockRejectedValue(new Error('list unavailable'));
    const client = makeClient({ app: { listWorkspaceMaterials } });
    renderMaterial(client, MATERIAL_ID);

    const editor = await screen.findByRole('textbox', { name: 'Release notes' });
    expect(editor).toHaveValue(REVISION_2.content);
    expect(listWorkspaceMaterials).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(client.app.getWorkspaceMaterial).toHaveBeenCalledWith(WORKSPACE_ID, MATERIAL_ID);
    expect(client.app.getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MATERIAL_ID,
      REVISION_2.revisionId
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('keeps edits local until one stable revision save with the exact expected base', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderMaterial(client);

    const editor = await screen.findByRole('textbox', { name: 'Release notes' });
    expect(editor).toHaveValue(REVISION_2.content);
    expect(client.app.getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MATERIAL_ID,
      REVISION_2.revisionId
    );
    await user.type(editor, 'Ship exactly.\n');

    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
    expect(client.app.saveWorkspaceMaterialRevision).not.toHaveBeenCalled();
    expect(client.core.startTurn).not.toHaveBeenCalled();
    expect(client.app.startChatMode).not.toHaveBeenCalled();
    expect(client.app.startTaskMode).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(client.app.saveWorkspaceMaterialRevision).toHaveBeenCalledWith(
        WORKSPACE_ID,
        MATERIAL_ID,
        expect.objectContaining({
          expectedRevisionId: REVISION_2.revisionId,
          contentDigest: 'sha256:9f93be420182b7f4885bc2dc66ab9eadc62e89cc39845bb5dec4e4cbe65833bd',
          content: '# Release notes\nShip exactly.\n',
        })
      )
    );
    expect(client.app.saveWorkspaceMaterialRevision).toHaveBeenCalledOnce();
  });

  it('surfaces a typed stale-precondition conflict while preserving the unsaved draft', async () => {
    const user = userEvent.setup();
    const saveWorkspaceMaterialRevision = vi.fn().mockRejectedValue(
      new ApiCallError(409, 'Mutation rejected.', {
        code: 'conflict',
      })
    );
    const client = makeClient({ app: { saveWorkspaceMaterialRevision } });
    renderMaterial(client);

    const editor = await screen.findByRole('textbox', { name: 'Release notes' });
    await user.type(editor, 'Keep this local draft.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/conflict|newer saved revision|changed since/i)
    ).toBeInTheDocument();
    expect(editor).toHaveValue('# Release notes\nKeep this local draft.');
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
    expect(screen.getByText(REVISION_2.revisionId)).toBeInTheDocument();
    expect(screen.queryByText('revision_3')).not.toBeInTheDocument();
    expect(saveWorkspaceMaterialRevision).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MATERIAL_ID,
      expect.objectContaining({ expectedRevisionId: REVISION_2.revisionId })
    );
  });

  it('opens immutable revisions and compares their exact bytes as non-authoritative client state', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderMaterial(client);

    await waitFor(() => {
      expect(screen.getByText(REVISION_1.revisionId)).toBeInTheDocument();
      expect(screen.getByText(REVISION_2.revisionId)).toBeInTheDocument();
    });
    expect(client.app.getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MATERIAL_ID,
      REVISION_2.revisionId
    );
    await user.click(screen.getByText(REVISION_1.revisionId));

    const openedRevision = await screen.findByLabelText(new RegExp(REVISION_1.revisionId));
    expect(openedRevision.textContent).toBe(REVISION_1.content);
    expect(client.app.getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      WORKSPACE_ID,
      MATERIAL_ID,
      REVISION_1.revisionId
    );

    await user.click(screen.getByRole('button', { name: /compare revisions/i }));
    const before = await screen.findByLabelText(new RegExp(REVISION_1.revisionId));
    const after = await screen.findByLabelText(new RegExp(REVISION_2.revisionId));
    expect(before).not.toBe(after);
    expect(before.textContent).toBe(REVISION_1.content);
    expect(after.textContent).toBe(REVISION_2.content);
    expect(screen.queryByRole('button', { name: /apply|accept/i })).not.toBeInTheDocument();
    expect(client.app.createWorkspaceMaterial).not.toHaveBeenCalled();
    expect(client.app.saveWorkspaceMaterialRevision).not.toHaveBeenCalled();
  });

  it('compares the earlier immutable revision before the current revision by default', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderMaterial(client);

    await waitFor(() => {
      expect(screen.getByText(REVISION_1.revisionId)).toBeInTheDocument();
      expect(screen.getByText(REVISION_2.revisionId)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /compare revisions/i }));

    const panes = (await screen.findAllByRole('region')).filter((region) =>
      [REVISION_1.content, REVISION_2.content].includes(region.textContent ?? '')
    );
    expect(panes).toHaveLength(2);
    expect(panes[0]?.textContent).toBe(REVISION_1.content);
    expect(panes[1]?.textContent).toBe(REVISION_2.content);
    expect(screen.queryByRole('button', { name: /apply|accept/i })).not.toBeInTheDocument();
  });
});

describe('Workspace Material Plane 1 S12', () => {
  it('disables Material create and save controls until the initial connection probe settles', async () => {
    const user = userEvent.setup();
    let resolveProbe: ((value: unknown) => void) | undefined;
    const meta = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        })
    );
    const client = makeClient({ core: { meta } });
    renderMaterial(client);

    const editor = await screen.findByRole('textbox', { name: 'Release notes' });
    const newMaterial = await screen.findByRole('button', { name: /new material/i });
    const save = await screen.findByRole('button', { name: /^save$/i });
    expect(newMaterial).toBeDisabled();
    expect(save).toBeDisabled();
    expect(client.app.createWorkspaceMaterial).not.toHaveBeenCalled();
    expect(client.app.saveWorkspaceMaterialRevision).not.toHaveBeenCalled();

    resolveProbe?.({});
    await waitFor(() => expect(newMaterial).toBeEnabled());
    expect(save).toBeDisabled();
    await user.type(editor, 'Pending connection.');
    expect(save).toBeEnabled();
  });

  it('projects Thread Material facts from the authoritative read and disables S12 writes while disconnected', async () => {
    const getThreadMaterial = vi.fn().mockResolvedValue({ material: NULL_THREAD_MATERIAL });
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('offline')) },
      app: { getThreadMaterial },
    });
    renderMaterial(client);

    const panel = await screen.findByRole('region', { name: /thread material/i });
    expect(panel).toHaveTextContent(/bound/i);
    expect(panel).toHaveTextContent(/included/i);
    expect(panel).toHaveTextContent(/current revision.*(unknown|none|not available)/i);
    expect(panel).toHaveTextContent(/queued revision.*(unknown|none|not available)/i);
    expect(panel).toHaveTextContent(/worker-seen revision.*(unknown|none|not available)/i);
    expect(panel).toHaveTextContent(/current-turn revision.*(unknown|none|not available)/i);
    expect(screen.getByRole('button', { name: /unbind/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /exclude/i })).toBeDisabled();
    expect(getThreadMaterial).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID);
  });

  it('refetches the authoritative Thread Material projection after a successful bind without local advancement', async () => {
    const user = userEvent.setup();
    let resolveAuthoritativeRead:
      | ((response: { material: null | typeof THREAD_MATERIAL }) => void)
      | undefined;
    const getThreadMaterial = vi
      .fn()
      .mockResolvedValueOnce({ material: null })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAuthoritativeRead = resolve;
          })
      );
    let resolveBindMutation:
      | ((response: { materialId: string; threadId: string; outcome: 'bound' }) => void)
      | undefined;
    const bindThreadMaterial = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBindMutation = resolve;
        })
    );
    const client = makeClient({ app: { getThreadMaterial, bindThreadMaterial } });
    renderMaterial(client);

    await user.click(await screen.findByRole('button', { name: /^bind material$/i }));

    await waitFor(() =>
      expect(bindThreadMaterial).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID, MATERIAL_ID, {
        expectedBindingState: 'not_bound',
      })
    );
    expect(getThreadMaterial).toHaveBeenCalledOnce();
    resolveBindMutation?.({ materialId: MATERIAL_ID, threadId: THREAD_ID, outcome: 'bound' });
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /^bind material$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unbind/i })).not.toBeInTheDocument();
    resolveAuthoritativeRead?.({ material: THREAD_MATERIAL });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /unbind/i })).toBeInTheDocument()
    );
    expect(getThreadMaterial.mock.invocationCallOrder[1]).toBeGreaterThan(
      bindThreadMaterial.mock.invocationCallOrder[0]
    );
  });

  it('re-reads the Thread Material projection after a bound save and displays the advanced queue', async () => {
    const user = userEvent.setup();
    const advancedQueuedRevisionId = 'revision_3';
    const getThreadMaterial = vi
      .fn()
      .mockResolvedValueOnce({ material: THREAD_MATERIAL })
      .mockResolvedValueOnce({
        material: {
          ...THREAD_MATERIAL,
          latestQueuedRevisionId: advancedQueuedRevisionId,
        },
      });
    const saveWorkspaceMaterialRevision = vi.fn().mockResolvedValue({
      materialId: MATERIAL_ID,
      revisionId: advancedQueuedRevisionId,
    });
    const client = makeClient({
      app: { getThreadMaterial, saveWorkspaceMaterialRevision },
    });
    renderMaterial(client);

    const editor = await screen.findByRole('textbox', { name: 'Release notes' });
    await user.type(editor, 'Queue this revision.');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(saveWorkspaceMaterialRevision).toHaveBeenCalledOnce());
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(2));
    const panel = await screen.findByRole('region', { name: /thread material/i });
    expect(panel).toHaveTextContent(advancedQueuedRevisionId);
    expect(panel).not.toHaveTextContent(THREAD_QUEUED_REVISION_ID);
    expect(getThreadMaterial.mock.invocationCallOrder[1]).toBeGreaterThan(
      saveWorkspaceMaterialRevision.mock.invocationCallOrder[0]
    );
  });

  it('sends every S12 expected-state precondition and exact identifier while re-reading restore queue state', async () => {
    const user = userEvent.setup();
    const getThreadMaterial = vi
      .fn()
      .mockResolvedValueOnce({ material: null })
      .mockResolvedValueOnce({ material: THREAD_MATERIAL })
      .mockResolvedValueOnce({ material: { ...THREAD_MATERIAL, inclusionState: 'excluded' } })
      .mockResolvedValueOnce({
        material: { ...THREAD_MATERIAL, latestQueuedRevisionId: THREAD_RESTORED_QUEUE_ID },
      })
      .mockResolvedValueOnce({ material: null });
    const bindThreadMaterial = vi.fn().mockResolvedValue({
      materialId: MATERIAL_ID,
      threadId: THREAD_ID,
      outcome: 'bound',
    });
    const excludeThreadMaterial = vi.fn().mockResolvedValue({
      materialId: MATERIAL_ID,
      threadId: THREAD_ID,
      outcome: 'excluded',
    });
    const restoreThreadMaterial = vi.fn().mockResolvedValue({
      materialId: MATERIAL_ID,
      threadId: THREAD_ID,
      outcome: 'included',
    });
    const unbindThreadMaterial = vi.fn().mockResolvedValue({
      materialId: MATERIAL_ID,
      threadId: THREAD_ID,
      outcome: 'unbound',
    });
    const client = makeClient({
      app: {
        getThreadMaterial,
        bindThreadMaterial,
        excludeThreadMaterial,
        restoreThreadMaterial,
        unbindThreadMaterial,
      },
    });
    renderMaterial(client);

    await user.click(await screen.findByRole('button', { name: /^bind material$/i }));
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(2));
    expect(bindThreadMaterial).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID, MATERIAL_ID, {
      expectedBindingState: 'not_bound',
    });
    let panel = await screen.findByRole('region', { name: /thread material/i });
    expect(panel).toHaveTextContent(/current revision.*revision_2/i);
    expect(panel).toHaveTextContent(
      new RegExp(`queued revision.*${THREAD_QUEUED_REVISION_ID}`, 'i')
    );
    expect(panel).toHaveTextContent(
      new RegExp(`worker-seen revision.*${THREAD_MATERIAL.lastWorkerSeenRevisionId}`, 'i')
    );
    expect(panel).toHaveTextContent(
      new RegExp(`current-turn revision.*${THREAD_MATERIAL.currentTurnRevisionId}`, 'i')
    );
    expect(getThreadMaterial.mock.invocationCallOrder[1]).toBeGreaterThan(
      bindThreadMaterial.mock.invocationCallOrder[0]
    );

    await user.click(await screen.findByRole('button', { name: /exclude/i }));
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(3));
    expect(excludeThreadMaterial).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID, MATERIAL_ID, {
      expectedBindingState: 'bound',
      expectedInclusionState: 'included',
      expectedQueuedRevisionId: THREAD_QUEUED_REVISION_ID,
    });
    expect(getThreadMaterial.mock.invocationCallOrder[2]).toBeGreaterThan(
      excludeThreadMaterial.mock.invocationCallOrder[0]
    );

    await user.click(await screen.findByRole('button', { name: /restore/i }));
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(4));
    expect(restoreThreadMaterial).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID, MATERIAL_ID, {
      expectedBindingState: 'bound',
      expectedInclusionState: 'excluded',
    });
    expect(getThreadMaterial.mock.invocationCallOrder[3]).toBeGreaterThan(
      restoreThreadMaterial.mock.invocationCallOrder[0]
    );
    panel = await screen.findByRole('region', { name: /thread material/i });
    expect(panel).toHaveTextContent(THREAD_RESTORED_QUEUE_ID);
    expect(panel).not.toHaveTextContent(THREAD_QUEUED_REVISION_ID);

    await user.click(await screen.findByRole('button', { name: /unbind/i }));
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(5));
    expect(unbindThreadMaterial).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID, MATERIAL_ID, {
      expectedBindingState: 'bound',
    });
    expect(getThreadMaterial.mock.invocationCallOrder[4]).toBeGreaterThan(
      unbindThreadMaterial.mock.invocationCallOrder[0]
    );
  });

  it('preserves the last authoritative projection on a typed conflict and offers retry without a second mutation', async () => {
    const user = userEvent.setup();
    const getThreadMaterial = vi.fn().mockResolvedValue({ material: THREAD_MATERIAL });
    const excludeThreadMaterial = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'Mutation rejected.', { code: 'conflict' }));
    const client = makeClient({ app: { getThreadMaterial, excludeThreadMaterial } });
    renderMaterial(client);

    const panel = await screen.findByRole('region', { name: /thread material/i });
    await user.click(screen.getByRole('button', { name: /exclude/i }));

    const conflictAlert = await screen.findByRole('alert');
    expect(conflictAlert).toHaveTextContent(/conflict|changed since/i);
    expect(conflictAlert).toHaveTextContent(/try again/i);
    expect(panel).toHaveTextContent(/included/i);
    expect(panel).toHaveTextContent(THREAD_QUEUED_REVISION_ID);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(excludeThreadMaterial).toHaveBeenCalledOnce();
    expect(getThreadMaterial).toHaveBeenCalledOnce();
  });
});

describe('Workspace Material Plane 1 S13', () => {
  it('submits the exact current revision and reports delivery only after the authoritative re-read', async () => {
    const user = userEvent.setup();
    let resolveAuthoritativeRead:
      | ((response: {
          material: Omit<typeof THREAD_MATERIAL, 'activeDelivery'> & {
            activeDelivery: Omit<typeof QUEUED_DELIVERY, 'state'> & {
              state: 'queued' | 'applied';
            };
          };
        }) => void)
      | undefined;
    const getThreadMaterial = vi
      .fn()
      .mockResolvedValueOnce({ material: THREAD_MATERIAL })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAuthoritativeRead = resolve;
          })
      );
    const submitThreadGoalSteering = vi.fn().mockResolvedValue({
      state: 'queued',
      pendingTurnId: DELIVERY_PENDING_TURN_ID,
      requestId: DELIVERY_REQUEST_ID,
      contentItemId: QUEUED_DELIVERY.contentItemId,
      goalId: QUEUED_DELIVERY.goalId,
      activeTurnId: QUEUED_DELIVERY.activeTurnId,
    });
    const client = makeClient({ app: { getThreadMaterial, submitThreadGoalSteering } });
    renderMaterial(client);

    await user.click(
      await screen.findByRole('button', { name: /send.*now|send.*current revision/i })
    );

    await waitFor(() =>
      expect(submitThreadGoalSteering).toHaveBeenCalledWith(
        WORKSPACE_ID,
        THREAD_ID,
        expect.objectContaining({
          materialId: MATERIAL_ID,
          revisionId: REVISION_2.revisionId,
          contentDigest: REVISION_2.contentDigest,
        })
      )
    );
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^applied$/i)).not.toBeInTheDocument();

    resolveAuthoritativeRead?.({
      material: {
        ...THREAD_MATERIAL,
        activeDelivery: { ...QUEUED_DELIVERY, state: 'applied' },
      },
    });

    expect(await screen.findByText(/^applied$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
    expect(getThreadMaterial.mock.invocationCallOrder[1]).toBeGreaterThan(
      submitThreadGoalSteering.mock.invocationCallOrder[0]
    );
  });

  it.each([
    {
      state: 'follow-up' as const,
      tone: 'positive' as const,
      buttonName: /follow.?up/i,
      method: 'convertGoalSteeringToFollowUp' as const,
      response: {
        state: 'follow-up' as const,
        pendingTurnId: DELIVERY_PENDING_TURN_ID,
        requestId: 'request_material_follow_up',
        sourceRequestId: DELIVERY_REQUEST_ID,
        contentItemId: QUEUED_DELIVERY.contentItemId,
        goalId: QUEUED_DELIVERY.goalId,
        activeTurnId: QUEUED_DELIVERY.activeTurnId,
        followUpTurnId: 'turn_material_follow_up',
        followUpItemId: 'item_material_follow_up',
      },
    },
    {
      state: 'cancelled' as const,
      tone: 'neutral' as const,
      buttonName: /cancel/i,
      method: 'cancelGoalSteering' as const,
      response: {
        state: 'cancelled' as const,
        pendingTurnId: DELIVERY_PENDING_TURN_ID,
        requestId: 'request_material_cancel',
        sourceRequestId: DELIVERY_REQUEST_ID,
        contentItemId: QUEUED_DELIVERY.contentItemId,
        goalId: QUEUED_DELIVERY.goalId,
        activeTurnId: QUEUED_DELIVERY.activeTurnId,
      },
    },
  ])('uses the authoritative pending identity and displays only the exact $state terminal response', async ({
    state,
    tone,
    buttonName,
    method,
    response,
  }) => {
    const user = userEvent.setup();
    const pendingTurnId = 'pending_reloaded_material_delivery';
    const terminalResponse = { ...response, pendingTurnId };
    let resolveTerminal: ((value: typeof response) => void) | undefined;
    const terminal = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTerminal = resolve;
        })
    );
    const getThreadMaterial = vi
      .fn()
      .mockResolvedValueOnce({
        material: {
          ...THREAD_MATERIAL,
          activeDelivery: { ...QUEUED_DELIVERY, pendingTurnId },
        },
      })
      .mockResolvedValueOnce({ material: THREAD_MATERIAL });
    const client = makeClient({
      app: {
        getThreadMaterial,
        [method]: terminal,
      },
    });
    renderMaterial(client);

    const delivery = await screen.findByRole('region', { name: /active-turn delivery/i });
    const queuedStatus = await within(delivery).findByRole('status');
    expect(queuedStatus).toHaveTextContent(/^queued$/i);
    expect(within(queuedStatus).getByText(/^queued$/i)).toHaveClass(
      ...STATUS_CLASS.neutral.split(' ')
    );
    await user.click(await screen.findByRole('button', { name: buttonName }));

    await waitFor(() =>
      expect(terminal).toHaveBeenCalledWith(
        WORKSPACE_ID,
        THREAD_ID,
        pendingTurnId,
        expect.any(Object)
      )
    );
    expect(screen.queryByText(new RegExp(`^${state}$`, 'i'))).not.toBeInTheDocument();
    expect(getThreadMaterial).toHaveBeenCalledOnce();
    expect(client.app.submitThreadGoalSteering).not.toHaveBeenCalled();

    resolveTerminal?.(terminalResponse);

    await waitFor(() => {
      const terminalStatus = within(
        screen.getByRole('region', { name: /active-turn delivery/i })
      ).getByRole('status');
      expect(terminalStatus).toHaveTextContent(new RegExp(`^${state}$`, 'i'));
      expect(within(terminalStatus).getByText(new RegExp(`^${state}$`, 'i'))).toHaveClass(
        ...STATUS_CLASS[tone].split(' ')
      );
    });
    await waitFor(() => expect(getThreadMaterial).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
    expect(getThreadMaterial.mock.invocationCallOrder[1]).toBeGreaterThan(
      terminal.mock.invocationCallOrder[0]
    );
  });

  it('keeps delivery submission disabled while the connection probe is checking', async () => {
    const meta = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const client = makeClient({
      core: { meta },
      app: { getThreadMaterial: vi.fn().mockResolvedValue({ material: THREAD_MATERIAL }) },
    });
    renderMaterial(client);

    expect(
      await screen.findByRole('button', { name: /send.*now|send.*current revision/i })
    ).toBeDisabled();
    expect(client.app.submitThreadGoalSteering).not.toHaveBeenCalled();
  });

  it('keeps terminal delivery writes disabled after the connection probe fails', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('offline')) },
      app: {
        getThreadMaterial: vi.fn().mockResolvedValue({
          material: { ...THREAD_MATERIAL, activeDelivery: QUEUED_DELIVERY },
        }),
      },
    });
    renderMaterial(client);

    expect(await screen.findByRole('button', { name: /follow.?up/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(client.app.convertGoalSteeringToFollowUp).not.toHaveBeenCalled();
    expect(client.app.cancelGoalSteering).not.toHaveBeenCalled();
  });

  it('prohibits restricted Material delivery without invoking the send command', async () => {
    const user = userEvent.setup();
    const restrictedMaterial = {
      ...THREAD_MATERIAL,
      resource: { ...MATERIAL, sensitivity: 'restricted' as const },
    };
    const client = makeClient({
      app: {
        getThreadMaterial: vi.fn().mockResolvedValue({ material: restrictedMaterial }),
      },
    });
    renderMaterial(client);

    const send = await screen.findByRole('button', {
      name: /send.*now|send.*current revision/i,
    });
    expect(send).toBeDisabled();
    expect(screen.getByText(/restricted material cannot be delivered/i)).toBeInTheDocument();
    await user.click(send);
    expect(client.app.submitThreadGoalSteering).not.toHaveBeenCalled();
  });

  it('renders authoritative applied state without terminal delivery actions', async () => {
    const client = makeClient({
      app: {
        getThreadMaterial: vi.fn().mockResolvedValue({
          material: {
            ...THREAD_MATERIAL,
            activeDelivery: { ...QUEUED_DELIVERY, state: 'applied' },
          },
        }),
      },
    });
    renderMaterial(client);

    const delivery = await screen.findByRole('region', { name: /active-turn delivery/i });
    const status = await within(delivery).findByRole('status');
    expect(status).toHaveTextContent(/^applied$/i);
    expect(within(status).getByText(/^applied$/i)).toHaveClass(...STATUS_CLASS.positive.split(' '));
    expect(within(delivery).queryByRole('button', { name: /follow.?up/i })).not.toBeInTheDocument();
    expect(within(delivery).queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it.each([
    {
      command: 'send' as const,
      buttonName: /send.*now|send.*current revision/i,
      activeDelivery: null,
      method: 'submitThreadGoalSteering' as const,
    },
    {
      command: 'follow-up' as const,
      buttonName: /follow.?up/i,
      activeDelivery: QUEUED_DELIVERY,
      method: 'convertGoalSteeringToFollowUp' as const,
    },
    {
      command: 'cancel' as const,
      buttonName: /cancel/i,
      activeDelivery: QUEUED_DELIVERY,
      method: 'cancelGoalSteering' as const,
    },
  ])('disables every rendered delivery write while $command is pending', async ({
    buttonName,
    activeDelivery,
    method,
  }) => {
    const user = userEvent.setup();
    const pendingMutation = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const client = makeClient({
      app: {
        getThreadMaterial: vi.fn().mockResolvedValue({
          material: { ...THREAD_MATERIAL, activeDelivery },
        }),
        [method]: pendingMutation,
      },
    });
    renderMaterial(client);

    const delivery = await screen.findByRole('region', { name: /active-turn delivery/i });
    await user.click(within(delivery).getByRole('button', { name: buttonName }));
    await waitFor(() => expect(pendingMutation).toHaveBeenCalledOnce());

    const controls = within(delivery).getAllByRole('button');
    for (const control of controls) expect(control).toBeDisabled();
    for (const control of controls) await user.click(control);
    expect(client.app.submitThreadGoalSteering).toHaveBeenCalledTimes(
      method === 'submitThreadGoalSteering' ? 1 : 0
    );
    expect(client.app.convertGoalSteeringToFollowUp).toHaveBeenCalledTimes(
      method === 'convertGoalSteeringToFollowUp' ? 1 : 0
    );
    expect(client.app.cancelGoalSteering).toHaveBeenCalledTimes(
      method === 'cancelGoalSteering' ? 1 : 0
    );
  });
});
