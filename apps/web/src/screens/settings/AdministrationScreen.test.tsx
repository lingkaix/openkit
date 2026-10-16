import {
  ApplyAdministrationConfigurationRequestSchema,
  workerEnvironmentActivationConfirmation,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { AdministrationScreen } from './AdministrationScreen';

const TIMESTAMP = '2026-09-10T00:00:00.000Z';
const PROJECT = {
  id: 'ws_00000000-0000-7d15-8bb9-5d57f3c7a053',
  name: 'Project Atlas',
  kind: 'general',
  status: 'active',
  counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const QUICK_CHAT = {
  ...PROJECT,
  id: 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
  name: 'Quick Chat',
  kind: 'quick-chat',
};
const SECOND_PROJECT = {
  ...PROJECT,
  id: 'ws_00000000-0000-768f-80f6-8bbf108cc9a9',
  name: 'Project Borealis',
};
const STORAGE_REF = 'wst_00000000-0000-7000-8000-000000000001';
const CONFIG_REVISION = `sha256:${'c'.repeat(64)}`;
const ENVIRONMENT = {
  attachmentGeneration: 1,
  contributors: [],
  createdAt: TIMESTAMP,
  layout: {
    family: 'openkit-worker',
    version: '1',
    uid: 1000,
    gid: 1000,
    workingDirectory: '/tmp/openkit-bootstrap',
    platform: { architecture: 'arm64', os: 'linux' },
    targets: [{ target: '/workspace' }, { target: '/sandbox' }],
  },
  layoutDigest: `sha256:${'b'.repeat(64)}`,
  revision: 2,
  state: 'idle' as const,
  storageRef: STORAGE_REF,
  updatedAt: TIMESTAMP,
  workspaceId: PROJECT.id,
};
const ADMIN_THREAD = {
  id: 'th_00000000-0000-79b7-9009-e76cfeceddee',
  workspaceId: QUICK_CHAT.id,
  name: 'Administration',
  preview: 'Administration',
  status: 'active',
  entryPath: 'administration',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const RESOLVED_CANDIDATE = {
  artifactId: 'ar_00000000-0000-7fd1-9bc1-cf5509dbe80c',
  artifactVersion: 1 as const,
  contentDigest: `sha256:${'d'.repeat(64)}`,
};
const AUTHORED_CANDIDATE = {
  artifactId: 'ar_00000000-0000-765f-9e4b-f410cda62de6',
  artifactVersion: 1 as const,
  contentDigest: `sha256:${'e'.repeat(64)}`,
};
const CANDIDATE_PAYLOAD = {
  affectedStorage: [{ storageRef: STORAGE_REF, expectedRevision: 2 }],
  authoredCandidate: AUTHORED_CANDIDATE,
  configuration: {
    expectedRevision: CONFIG_REVISION,
    fileId: 'agents/codex.agent.jsonc',
  },
  image: {
    digest: `sha256:${'f'.repeat(64)}`,
    environmentDefaults: {
      classification: 'unadmitted',
      defaultsDigest: `sha256:${'e'.repeat(64)}`,
      names: ['LANG', 'PUBLIC_SETTING'],
    },
    platform: { architecture: 'arm64', os: 'linux' },
    storageLayout: {
      family: 'openkit-worker',
      version: '1',
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      targets: [{ target: '/workspace' }, { target: '/sandbox' }],
    },
  },
  kind: 'worker-environment-resolved-candidate',
  replaceNow: {
    prompt: 'Continue the implementation with the prepared environment.',
    threadId: 'th_00000000-0000-7661-815f-0101e9c6c0d8',
    workspaceId: PROJECT.id,
  },
  schemaVersion: 1,
  target: { agentId: 'codex', kind: 'agent' },
} as const;
const CANDIDATE_ITEM = {
  id: 'it_00000000-0000-7689-b82f-01221681dc60',
  workspaceId: QUICK_CHAT.id,
  threadId: ADMIN_THREAD.id,
  turnId: 'tu_00000000-0000-72c5-a55e-00fc996645c0',
  status: 'completed',
  type: 'artifact-reference',
  artifactId: RESOLVED_CANDIDATE.artifactId,
  artifactVersion: RESOLVED_CANDIDATE.artifactVersion,
  lastMutationRequestId: 'req_prepare',
  title: 'Resolved Worker environment candidate',
  summary: 'Prepared.',
  createdAt: TIMESTAMP,
  completedAt: TIMESTAMP,
} as const;
const CANDIDATE_ARTIFACT = {
  id: RESOLVED_CANDIDATE.artifactId,
  workspaceId: QUICK_CHAT.id,
  threadId: ADMIN_THREAD.id,
  turnId: 'tu_00000000-0000-72c5-a55e-00fc996645c0',
  kind: 'report',
  title: CANDIDATE_ITEM.title,
  status: 'ready',
  summary: 'Prepared.',
  version: RESOLVED_CANDIDATE.artifactVersion,
  content: { format: 'json', body: JSON.stringify(CANDIDATE_PAYLOAD) },
  contentDigest: RESOLVED_CANDIDATE.contentDigest,
  lastMutationRequestId: CANDIDATE_ITEM.lastMutationRequestId,
  origin: {
    kind: 'turn-output',
    threadId: ADMIN_THREAD.id,
    turnId: 'tu_00000000-0000-72c5-a55e-00fc996645c0',
    requestId: CANDIDATE_ITEM.lastMutationRequestId,
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
} as const;
const AUTHORED_PAYLOAD = {
  affectedStorage: CANDIDATE_PAYLOAD.affectedStorage,
  configuration: CANDIDATE_PAYLOAD.configuration,
  declaration: {
    kind: 'reference',
    pullPolicy: 'never',
    ref: `sha256:${'f'.repeat(64)}`,
  },
  kind: 'worker-environment-authored-candidate',
  replaceNow: CANDIDATE_PAYLOAD.replaceNow,
  schemaVersion: 1,
  target: CANDIDATE_PAYLOAD.target,
} as const;
const AUTHORED_ITEM = {
  ...CANDIDATE_ITEM,
  id: 'it_00000000-0000-78aa-951f-75d06afdf490',
  artifactId: AUTHORED_CANDIDATE.artifactId,
  artifactVersion: AUTHORED_CANDIDATE.artifactVersion,
  title: 'Authored Worker environment candidate',
} as const;
const AUTHORED_ARTIFACT = {
  ...CANDIDATE_ARTIFACT,
  id: AUTHORED_CANDIDATE.artifactId,
  title: AUTHORED_ITEM.title,
  version: AUTHORED_CANDIDATE.artifactVersion,
  content: { format: 'json', body: JSON.stringify(AUTHORED_PAYLOAD) },
  contentDigest: AUTHORED_CANDIDATE.contentDigest,
} as const;
const CONFIG_CANDIDATE = {
  artifactId: 'ar_00000000-0000-7d2f-9722-dc8c6c8b7d8d',
  artifactVersion: 1 as const,
  contentDigest: `sha256:${'9'.repeat(64)}`,
};
const CONFIG_PAYLOAD = {
  after: { displayName: 'OpenAI production', models: ['gpt-4'] },
  before: { displayName: 'OpenAI', models: ['gpt-4'] },
  changes: { displayName: 'OpenAI production' },
  command: 'administration.configuration.apply',
  expectedRevision: CONFIG_REVISION,
  kind: 'administration-configuration-candidate',
  operation: 'update',
  restartRequired: true,
  targetFamily: 'provider',
  targetId: 'openai',
} as const;
const CONFIG_ITEM = {
  ...CANDIDATE_ITEM,
  id: 'it_00000000-0000-7307-b89c-75e106cc2198',
  artifactId: CONFIG_CANDIDATE.artifactId,
  artifactVersion: CONFIG_CANDIDATE.artifactVersion,
  title: 'Administration configuration candidate',
} as const;
const CONFIG_ARTIFACT = {
  ...CANDIDATE_ARTIFACT,
  id: CONFIG_CANDIDATE.artifactId,
  title: CONFIG_ITEM.title,
  version: CONFIG_CANDIDATE.artifactVersion,
  content: { format: 'json', body: JSON.stringify(CONFIG_PAYLOAD) },
  contentDigest: CONFIG_CANDIDATE.contentDigest,
} as const;
const CONFIG_CANDIDATE_B = {
  artifactId: 'ar_00000000-0000-7a84-81f2-ce90862c4c99',
  artifactVersion: 1 as const,
  contentDigest: `sha256:${'6'.repeat(64)}`,
};
const CONFIG_ITEM_B = {
  ...CONFIG_ITEM,
  id: 'it_00000000-0000-77d6-9a59-1bea0423d91c',
  artifactId: CONFIG_CANDIDATE_B.artifactId,
  artifactVersion: CONFIG_CANDIDATE_B.artifactVersion,
} as const;
const CONFIG_ARTIFACT_B = {
  ...CONFIG_ARTIFACT,
  id: CONFIG_CANDIDATE_B.artifactId,
  content: {
    format: 'json',
    body: JSON.stringify({
      ...CONFIG_PAYLOAD,
      after: { displayName: 'OpenAI staging', models: ['gpt-4'] },
      changes: { displayName: 'OpenAI staging' },
    }),
  },
  contentDigest: CONFIG_CANDIDATE_B.contentDigest,
} as const;
const CONFIG_OUTCOME = {
  candidate: CONFIG_CANDIDATE,
  persisted: true,
  reload: 'failed' as const,
  restartRequired: true,
  revision: `sha256:${'8'.repeat(64)}`,
};
const CONFIG_OUTCOME_ITEM = {
  ...CONFIG_ITEM,
  id: 'it_00000000-0000-7d8d-a2f5-aebe8ce41dea',
  artifactId: 'ar_00000000-0000-7ccf-84a5-55f6c4fa16ff',
  title: 'Administration configuration result',
} as const;
const CONFIG_OUTCOME_ARTIFACT = {
  ...CONFIG_ARTIFACT,
  id: CONFIG_OUTCOME_ITEM.artifactId,
  title: CONFIG_OUTCOME_ITEM.title,
  content: { format: 'json', body: JSON.stringify(CONFIG_OUTCOME) },
  contentDigest: `sha256:${'7'.repeat(64)}`,
} as const;

function makeClient(
  app: Partial<CoreClient['app'] & CoreClient['operations']> = {},
  core: Partial<CoreClient['core'] & CoreClient['operations']> = {},
  operations: Partial<CoreClient['operations']> = {}
): CoreClient {
  return {
    app: { ...app },
    auth: {
      email: {
        getSession: vi
          .fn()
          .mockResolvedValue({ user: { id: 'usr_00000000-0000-7000-8000-000000000001' } }),
      },
    },
    core: {
      meta: vi.fn().mockResolvedValue({}),
      ...core,
    },
    operations: {
      'token.list': vi.fn().mockResolvedValue({ items: [] }),
      ...app,
      'runtime.file-list': vi.fn().mockResolvedValue({ files: [] }),
      'runtime.file-read': vi.fn(),
      ...operations,
      'thread.list': vi.fn().mockResolvedValue({ items: [] }),
      'thread.read': vi
        .fn()
        .mockImplementation(
          ({ workspaceId, threadId }: { workspaceId: string; threadId?: string }) =>
            Promise.resolve({
              id: threadId,
              workspaceId,
              name: 'Administration',
              preview: 'Administration',
              status: 'active',
              entryPath: 'administration',
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })
        ),
      'thread.items': vi.fn().mockResolvedValue({ items: [] }),
      'workspace.resources': vi.fn().mockResolvedValue({
        knowledge: [],
        skills: [],
        agents: [],
        models: [],
      }),
      ...core,
      ...app,
      'workspace.list': vi
        .fn()
        .mockResolvedValueOnce({
          items: [PROJECT, SECOND_PROJECT, QUICK_CHAT].map((workspace) => ({
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          })),
        })
        .mockImplementation(
          core['workspace.list'] ??
            app['workspace.list'] ??
            vi.fn().mockResolvedValue({
              items: [PROJECT, SECOND_PROJECT, QUICK_CHAT].map((workspace) => ({
                membershipStatus: 'active' as const,
                accessCause: 'membership' as const,
                workspace,
                effectiveRole: 'owner',
                membershipRevision: 1,
                ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
                registryRevision: 1,
              })),
            })
        ),
      'administration.configuration-apply': app['administration.configuration-apply'] ?? vi.fn(),
      'worker-environment.list':
        app['worker-environment.list'] ??
        vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    },
  } as unknown as CoreClient;
}

/** Observes the destination of the Administration Open action. */
function LocationProbe() {
  return <output aria-label="Current path">{useLocation().pathname}</output>;
}

function renderScreen(
  client: CoreClient,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <LocationProbe />
          <AdministrationScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { queryClient, ...view };
}

beforeEach(() => {
  useWorkspaceStore.setState({ currentWorkspaceId: PROJECT.id, selectionUserKey: null });
});

describe('Administration', () => {
  it('lists other owners separately and opens their Workspace into the selected state', async () => {
    const user = userEvent.setup();
    const foreignQuickChat = {
      ...QUICK_CHAT,
      id: 'ws_00000000-0000-7f9c-aa14-53566c621405',
      name: 'Other Quick Chat',
    };
    const client = makeClient();
    vi.mocked(client.operations['workspace.list'])
      .mockReset()
      .mockResolvedValue({
        items: [foreignQuickChat, PROJECT, QUICK_CHAT].map((workspace) => ({
          membershipStatus: workspace.id === foreignQuickChat.id ? null : 'active',
          accessCause: 'administrator',
          workspace,
          ownerUserId:
            workspace.id === foreignQuickChat.id
              ? 'usr_00000000-0000-73d4-904a-d4c4b905df7c'
              : 'usr_00000000-0000-7000-8000-000000000001',
          effectiveRole: workspace.id === foreignQuickChat.id ? null : 'owner',
          registryRevision: 1,
          membershipRevision: workspace.id === foreignQuickChat.id ? null : 1,
        })),
      } as Awaited<ReturnType<CoreClient['operations']['workspace.list']>>);
    renderScreen(client);

    const others = await screen.findByRole('region', { name: 'Other workspaces' });
    expect(within(others).getByText(foreignQuickChat.name)).toBeInTheDocument();
    expect(within(others).queryByText(PROJECT.name)).not.toBeInTheDocument();
    expect(within(others).queryByText(QUICK_CHAT.name, { exact: true })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(client.operations['thread.list']).toHaveBeenCalledWith({ workspaceId: QUICK_CHAT.id })
    );
    expect(client.operations['thread.list']).not.toHaveBeenCalledWith({
      workspaceId: foreignQuickChat.id,
    });
    await user.click(within(others).getByRole('button', { name: /Open Other Quick Chat/ }));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(foreignQuickChat.id);
    expect(screen.getByLabelText('Current path')).toHaveTextContent('/chat');
  });

  it('waits for ownership discovery before reading the private Quick Chat', async () => {
    const client = makeClient();
    const foreignQuickChat = {
      ...QUICK_CHAT,
      id: 'ws_00000000-0000-7f9c-aa14-53566c621405',
      name: 'Other Quick Chat',
    };
    const result = {
      items: [foreignQuickChat, QUICK_CHAT].map((workspace) => ({
        membershipStatus: workspace.id === foreignQuickChat.id ? null : 'active',
        accessCause: 'administrator',
        workspace,
        ownerUserId:
          workspace.id === foreignQuickChat.id
            ? 'usr_00000000-0000-73d4-904a-d4c4b905df7c'
            : 'usr_00000000-0000-7000-8000-000000000001',
        effectiveRole: workspace.id === foreignQuickChat.id ? null : 'owner',
        registryRevision: 1,
        membershipRevision: workspace.id === foreignQuickChat.id ? null : 1,
      })),
    } as Awaited<ReturnType<CoreClient['operations']['workspace.list']>>;
    let resolveSummaries!: (value: typeof result) => void;
    const pendingSummaries = new Promise<typeof result>((resolve) => {
      resolveSummaries = resolve;
    });
    vi.mocked(client.operations['workspace.list'])
      .mockReset()
      .mockReturnValueOnce(pendingSummaries)
      .mockResolvedValue(result);
    renderScreen(client);
    await waitFor(() => expect(client.operations['workspace.list']).toHaveBeenCalledTimes(1));
    expect(client.operations['thread.list']).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().selectionUserKey).toBeNull();
    await act(async () => resolveSummaries(result));
    await waitFor(() =>
      expect(client.operations['thread.list']).toHaveBeenCalledWith({ workspaceId: QUICK_CHAT.id })
    );
    expect(client.operations['thread.list']).not.toHaveBeenCalledWith({
      workspaceId: foreignQuickChat.id,
    });
    expect(useWorkspaceStore.getState().selectionUserKey).toBe(QUICK_CHAT.id);
  });

  it('polls observation-only runtime activity in the private Administration Thread without new Items', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const activity = {
        turnId: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c',
        contentCapture: 'on',
        coverage: 'collecting',
        omittedEntryCount: 0,
        entries: [],
      };
      const dashboard = {
        turns: [{ id: 'tu_00000000-0000-7e13-bcb6-acb21b36a45c', status: 'completed', items: [] }],
        runtimeActivity: [activity],
      };
      const getThreadDashboard = vi.fn().mockResolvedValue(dashboard);
      const listThreadItems = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
      renderScreen(
        makeClient(
          { 'thread.dashboard': getThreadDashboard },
          {
            'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
            'thread.items': listThreadItems,
          }
        )
      );
      expect(await screen.findByText('Activity collection is ongoing.')).toBeInTheDocument();
      const baselineReads = getThreadDashboard.mock.calls.length;
      const itemReads = listThreadItems.mock.calls.length;
      getThreadDashboard.mockResolvedValue({
        ...dashboard,
        runtimeActivity: [
          {
            ...activity,
            coverage: 'partial',
            entries: [
              {
                sequence: 2,
                observedAt: TIMESTAMP,
                kind: 'result',
                label: 'Child 1: result reported',
                text: 'Administration observation arrived without an Item.',
                textTruncated: false,
              },
            ],
          },
        ],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(
        await screen.findByText('Administration observation arrived without an Item.')
      ).toBeInTheDocument();
      expect(getThreadDashboard.mock.calls.length).toBeGreaterThan(baselineReads);
      expect(
        getThreadDashboard.mock.calls.every(
          ([{ workspaceId, threadId }]) =>
            workspaceId === QUICK_CHAT.id && threadId === ADMIN_THREAD.id
        )
      ).toBe(true);
      expect(listThreadItems.mock.calls.length).toBe(itemReads);
      expect(screen.queryByText('Activity collection is ongoing.')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the private administration entry and continues its returned Thread', async () => {
    const user = userEvent.setup();
    const submitAdministrationConversation = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'answered',
        explanation: 'Prepared.',
        turn: { id: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575' },
        item: { id: 'it_00000000-0000-729d-88c1-c54b390585b6' },
        handoff: null,
        originatingWorkspaceId: QUICK_CHAT.id,
        originatingThreadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
        receivingWorkspaceId: QUICK_CHAT.id,
        receivingThreadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
        targetRef: 'assistant',
        logicalModelId: null,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        explanation: 'Inspected.',
        turn: { id: 'tu_00000000-0000-70b8-9470-71bee14fa908' },
        item: { id: 'it_00000000-0000-7a7b-bd48-f59a99f30f6f' },
        handoff: null,
        originatingWorkspaceId: QUICK_CHAT.id,
        originatingThreadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
        receivingWorkspaceId: QUICK_CHAT.id,
        receivingThreadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
        targetRef: 'assistant',
        logicalModelId: null,
      });
    const client = makeClient({
      'administration.conversation-submit': submitAdministrationConversation,
    });
    renderScreen(client);

    expect(await screen.findByText('Target Workspace: Project Atlas')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Administration message'), 'Prepare the worker image.');
    await user.click(screen.getByRole('button', { name: 'Send to administration' }));
    await waitFor(() => expect(submitAdministrationConversation).toHaveBeenCalledTimes(1));
    expect(submitAdministrationConversation.mock.calls[0]?.[0]).not.toHaveProperty('threadId');

    await user.type(screen.getByLabelText('Administration message'), 'Check its status.');
    await user.click(screen.getByRole('button', { name: 'Send to administration' }));
    await waitFor(() => expect(submitAdministrationConversation).toHaveBeenCalledTimes(2));
    expect(submitAdministrationConversation.mock.calls[1]?.[0]).toMatchObject({
      input: 'Check its status.',
      threadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
    });
  });

  it('fails closed when the signed-in session has no usable administrator authority', async () => {
    const client = makeClient({
      'token.list': vi
        .fn()
        .mockRejectedValue(
          new ApiCallError(403, 'Server-admin authority is required.', { code: 'forbidden' })
        ),
    });
    renderScreen(client);

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Administration message')).not.toBeInTheDocument();
    expect(client.operations['worker-environment.list']).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
  });

  it('clears inspected status and reads the newly selected global Workspace', async () => {
    const user = userEvent.setup();
    const listWorkerEnvironments = vi
      .fn()
      .mockImplementation(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve({
          items: workspaceId === PROJECT.id ? [ENVIRONMENT] : [],
          nextCursor: null,
        })
      );
    const getWorkerEnvironmentStatus = vi.fn().mockResolvedValue({
      environment: ENVIRONMENT,
      storage: {
        attachment: null,
        capacity: { availableBytes: 4_000, totalBytes: 8_000 },
        layoutDigest: ENVIRONMENT.layoutDigest,
        scopeDigest: `sha256:${'c'.repeat(64)}`,
        state: 'available',
        storageRef: STORAGE_REF,
        targets: ENVIRONMENT.layout.targets.map(({ target }, index) => ({
          initialized: true,
          target,
          volumeRef: `volume_${index}`,
        })),
      },
    });
    const client = makeClient({
      'worker-environment.list': listWorkerEnvironments,
      'worker-environment.status': getWorkerEnvironmentStatus,
    });
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Refresh status' }));
    expect(await screen.findByText('No current attachment.')).toBeInTheDocument();

    act(() => useWorkspaceStore.getState().setCurrentWorkspaceId(SECOND_PROJECT.id));

    expect(await screen.findByText('Target Workspace: Project Borealis')).toBeInTheDocument();
    await waitFor(() =>
      expect(listWorkerEnvironments).toHaveBeenCalledWith({
        workspaceId: SECOND_PROJECT.id,
        ...{ limit: 100 },
      })
    );
    expect(screen.queryByText('No current attachment.')).not.toBeInTheDocument();
  });

  it('states an unknown host result and offers inspection instead of replaying an effect', async () => {
    const user = userEvent.setup();
    const getWorkerEnvironmentStatus = vi.fn().mockResolvedValue({
      environment: { ...ENVIRONMENT, state: 'unknown' },
      storage: {
        attachment: null,
        capacity: { availableBytes: 0, totalBytes: 0 },
        layoutDigest: null,
        scopeDigest: null,
        state: 'unknown',
        storageRef: STORAGE_REF,
        targets: [],
      },
    });
    const client = makeClient({
      'worker-environment.list': vi
        .fn()
        .mockResolvedValue({ items: [ENVIRONMENT], nextCursor: null }),
      'worker-environment.status': getWorkerEnvironmentStatus,
    });
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Refresh status' }));

    expect(
      await screen.findByText(
        'The host result is unknown. Inspect again before requesting another effect.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(getWorkerEnvironmentStatus).toHaveBeenCalledTimes(1);
  });

  it('labels Core association and Host storage separately when they differ', async () => {
    const user = userEvent.setup();
    const listed = { ...ENVIRONMENT, revision: 4, state: 'idle' as const };
    const purgeWorkerEnvironment = vi.fn();
    const activateWorkerEnvironment = vi.fn();
    const getWorkerEnvironmentStatus = vi.fn().mockResolvedValue({
      environment: { ...listed, revision: 5, state: 'attached' },
      storage: {
        attachment: null,
        capacity: { availableBytes: 4_000, totalBytes: 8_000 },
        layoutDigest: ENVIRONMENT.layoutDigest,
        scopeDigest: `sha256:${'c'.repeat(64)}`,
        state: 'available',
        storageRef: STORAGE_REF,
        targets: ENVIRONMENT.layout.targets.map(({ target }, index) => ({
          initialized: true,
          target,
          volumeRef: `volume_${index}`,
        })),
      },
    });
    const client = makeClient({
      'worker-environment.activate': activateWorkerEnvironment,
      'worker-environment.status': getWorkerEnvironmentStatus,
      'worker-environment.list': vi.fn().mockResolvedValue({ items: [listed], nextCursor: null }),
      'worker-environment.purge': purgeWorkerEnvironment,
    });
    renderScreen(client);

    expect(await screen.findByText('idle')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    expect(await screen.findByText('Core association')).toBeInTheDocument();
    expect(screen.getByText('revision 5')).toBeInTheDocument();
    expect(screen.getByText('attached')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
    expect(screen.getByText('Host storage')).toBeInTheDocument();
    expect(screen.getByText('available')).toBeInTheDocument();
    expect(screen.getByText('No current attachment.')).toBeInTheDocument();
    expect(
      screen.getByText('Host availability alone does not authorize reuse.')
    ).toBeInTheDocument();
    expect(getWorkerEnvironmentStatus).toHaveBeenCalledTimes(1);
    expect(getWorkerEnvironmentStatus).toHaveBeenCalledWith({
      workspaceId: PROJECT.id,
      storageRef: STORAGE_REF,
    });
    expect(purgeWorkerEnvironment).not.toHaveBeenCalled();
    expect(activateWorkerEnvironment).not.toHaveBeenCalled();
  });

  it('binds explicit deletion to the displayed revision and fences an unknown result', async () => {
    const user = userEvent.setup();
    const purgeWorkerEnvironment = vi.fn().mockResolvedValue({
      environment: { ...ENVIRONMENT, state: 'unknown' },
      outcome: 'unknown',
      requestId: 'req_purge',
      storageRef: STORAGE_REF,
    });
    const getWorkerEnvironmentStatus = vi.fn().mockResolvedValue({
      environment: ENVIRONMENT,
      storage: {
        attachment: null,
        capacity: { availableBytes: 4_000, totalBytes: 8_000 },
        layoutDigest: ENVIRONMENT.layoutDigest,
        scopeDigest: `sha256:${'c'.repeat(64)}`,
        state: 'available',
        storageRef: STORAGE_REF,
        targets: [],
      },
    });
    const client = makeClient({
      'worker-environment.status': getWorkerEnvironmentStatus,
      'worker-environment.list': vi
        .fn()
        .mockResolvedValue({ items: [ENVIRONMENT], nextCursor: null }),
      'worker-environment.purge': purgeWorkerEnvironment,
    });
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(
      screen.getByRole('dialog', { name: 'Delete retained environment?' })
    ).toBeInTheDocument();
    expect(screen.getByText(`Environment ${STORAGE_REF} at revision 2`)).toBeInTheDocument();
    expect(screen.getByText('Retained targets: /workspace, /sandbox')).toBeInTheDocument();
    expect(purgeWorkerEnvironment).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete environment' }));

    await waitFor(() => expect(purgeWorkerEnvironment).toHaveBeenCalledTimes(1));
    expect(purgeWorkerEnvironment).toHaveBeenCalledWith({
      workspaceId: PROJECT.id,
      ...{
        confirmation: `purge-worker-environment:${STORAGE_REF}:2`,
        expectedRevision: 2,
        requestId: expect.any(String),
        storageRef: STORAGE_REF,
      },
    });
    expect(
      await screen.findByText(
        'Deletion result unknown. Refresh status before requesting another deletion.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(getWorkerEnvironmentStatus).not.toHaveBeenCalled();

    act(() => useWorkspaceStore.getState().setCurrentWorkspaceId(SECOND_PROJECT.id));
    expect(await screen.findByText('Target Workspace: Project Borealis')).toBeInTheDocument();
    act(() => useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT.id));
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
    expect(getWorkerEnvironmentStatus).toHaveBeenCalledTimes(1);
    expect(purgeWorkerEnvironment).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown', false],
    ['unchanged', false],
    ['empty', false],
    ['empty', true],
  ] as const)('shows the activation outcome with %s storage and configuration-established=%s', async (disposition, established) => {
    const candidatePayload =
      disposition === 'empty'
        ? {
            ...CANDIDATE_PAYLOAD,
            affectedStorage: [],
            replaceNow: null,
          }
        : CANDIDATE_PAYLOAD;
    const authoredPayload = {
      ...AUTHORED_PAYLOAD,
      affectedStorage: candidatePayload.affectedStorage,
      replaceNow: candidatePayload.replaceNow,
    };
    const user = userEvent.setup();
    const getWorkerEnvironmentStatus = vi.fn();
    const activateWorkerEnvironment = vi.fn().mockImplementation((input: { requestId: string }) =>
      Promise.resolve({
        affected:
          disposition === 'empty'
            ? []
            : [
                {
                  ...candidatePayload.affectedStorage[0],
                  disposition,
                },
              ],
        configuration: established
          ? { fileId: candidatePayload.configuration.fileId, revision: CONFIG_REVISION }
          : null,
        replaceNow: candidatePayload.replaceNow,
        requestId: input.requestId,
        resolvedCandidate: RESOLVED_CANDIDATE,
        target: CANDIDATE_PAYLOAD.target,
      })
    );
    const client = makeClient(
      {
        'worker-environment.activate': activateWorkerEnvironment,
        'worker-environment.status': getWorkerEnvironmentStatus,
        'worker-environment.list': vi
          .fn()
          .mockResolvedValue({ items: [ENVIRONMENT], nextCursor: null }),
      },
      {
        'artifact.read': vi
          .fn()
          .mockImplementation(
            ({
              workspaceId: _workspaceId,
              artifactId,
            }: Parameters<CoreClient['operations']['artifact.read']>[0]) =>
              Promise.resolve(
                artifactId === AUTHORED_CANDIDATE.artifactId
                  ? {
                      ...AUTHORED_ARTIFACT,
                      content: { format: 'json', body: JSON.stringify(authoredPayload) },
                    }
                  : {
                      ...CANDIDATE_ARTIFACT,
                      content: { format: 'json', body: JSON.stringify(candidatePayload) },
                    }
              )
          ),
        'thread.items': vi.fn().mockResolvedValue({ items: [AUTHORED_ITEM, CANDIDATE_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    expect(await screen.findByText('Prepared environment change')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover result' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review activation' }));
    expect(
      screen.getByRole('dialog', { name: 'Activate prepared candidate?' })
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        `Resolved Artifact ${RESOLVED_CANDIDATE.artifactId} v1 · ${RESOLVED_CANDIDATE.contentDigest}`
      )
    ).not.toHaveLength(0);
    expect(screen.getAllByText('Persistent targets: /workspace, /sandbox')).not.toHaveLength(0);
    expect(
      screen.getAllByText(
        `Environment defaults ${CANDIDATE_PAYLOAD.image.environmentDefaults.defaultsDigest}`
      )
    ).not.toHaveLength(0);
    expect(screen.getAllByText('Default names: LANG, PUBLIC_SETTING')).not.toHaveLength(0);
    expect(
      screen.getAllByText('Default values are admitted only by this activation.')
    ).not.toHaveLength(0);
    expect(activateWorkerEnvironment).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Activate candidate' }));
    await waitFor(() => expect(activateWorkerEnvironment).toHaveBeenCalledTimes(1));
    const binding = {
      affectedStorage: candidatePayload.affectedStorage,
      configuration: candidatePayload.configuration,
      replaceNow: candidatePayload.replaceNow,
      resolvedCandidate: RESOLVED_CANDIDATE,
      image: CANDIDATE_PAYLOAD.image,
      target: CANDIDATE_PAYLOAD.target,
    };
    expect(activateWorkerEnvironment).toHaveBeenCalledWith({
      affectedStorage: binding.affectedStorage,
      configuration: binding.configuration,
      replaceNow: binding.replaceNow,
      resolvedCandidate: binding.resolvedCandidate,
      target: binding.target,
      confirmation: workerEnvironmentActivationConfirmation(binding),
      requestId: expect.any(String),
    });
    await screen.findByText('Activation command result');
    const incompleteMessage =
      'Activation is incomplete or includes an unknown host result. Inspect the exact configuration and environment status, then prepare a fresh candidate.';
    if (established) {
      expect(screen.queryByText(incompleteMessage)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(incompleteMessage)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Review activation' })).toBeDisabled();
    expect(getWorkerEnvironmentStatus).not.toHaveBeenCalled();
    expect(activateWorkerEnvironment).toHaveBeenCalledTimes(1);

    if (disposition === 'empty') return;

    act(() => useWorkspaceStore.getState().setCurrentWorkspaceId(SECOND_PROJECT.id));
    expect(await screen.findByText('Target Workspace: Project Borealis')).toBeInTheDocument();
    expect(
      await screen.findByText('Prepared replacement targets another Workspace')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review activation' })).not.toBeInTheDocument();
    act(() => useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT.id));
    expect(await screen.findByRole('button', { name: 'Review activation' })).toBeDisabled();
    expect(activateWorkerEnvironment).toHaveBeenCalledTimes(1);
  });

  it('prepares from the exact published Agent manifest without a Workspace-scoped target', async () => {
    const user = userEvent.setup();
    const prepareWorkerEnvironment = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        affectedStorage: CANDIDATE_PAYLOAD.affectedStorage,
        activationConfirmation: workerEnvironmentActivationConfirmation({
          affectedStorage: CANDIDATE_PAYLOAD.affectedStorage,
          configuration: input.configuration,
          replaceNow: input.replaceNow,
          resolvedCandidate: RESOLVED_CANDIDATE,
          image: CANDIDATE_PAYLOAD.image,
          target: input.target,
        }),
        authoredCandidate: AUTHORED_CANDIDATE,
        configuration: input.configuration,
        image: CANDIDATE_PAYLOAD.image,
        preparedAt: TIMESTAMP,
        replaceNow: input.replaceNow,
        requestId: input.requestId,
        resolvedCandidate: RESOLVED_CANDIDATE,
        target: input.target,
      })
    );
    const client = makeClient(
      { 'worker-environment.prepare': prepareWorkerEnvironment },
      {
        'thread.list': vi.fn().mockImplementation(({ workspaceId }) =>
          Promise.resolve({
            items:
              workspaceId === QUICK_CHAT.id
                ? [ADMIN_THREAD]
                : [
                    {
                      ...ADMIN_THREAD,
                      entryPath: 'conversation',
                      id: 'th_00000000-0000-7661-815f-0101e9c6c0d8',
                      name: 'Project implementation',
                      workspaceId: PROJECT.id,
                    },
                  ],
          })
        ),
      },
      {
        'runtime.file-read': vi.fn().mockResolvedValue({
          file: {
            exists: true,
            id: 'agents/codex.agent.jsonc',
            kind: 'agent',
            path: 'agents/codex.agent.jsonc',
            revision: CONFIG_REVISION,
            updatedAt: TIMESTAMP,
          },
          content: JSON.stringify({
            id: 'codex',
            runtime: {
              image: {
                kind: 'reference',
                pullPolicy: 'never',
                ref: `sha256:${'f'.repeat(64)}`,
              },
            },
          }),
        }),
        'runtime.file-list': vi.fn().mockResolvedValue({
          files: [
            {
              exists: true,
              id: 'agents/codex.agent.jsonc',
              kind: 'agent',
              path: 'agents/codex.agent.jsonc',
              revision: CONFIG_REVISION,
              updatedAt: TIMESTAMP,
            },
          ],
        }),
      }
    );
    renderScreen(client);

    expect(await screen.findByText('Agent codex')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Activation impact'));
    await user.click(screen.getByRole('option', { name: 'Replace current Thread now' }));
    await user.type(
      screen.getByLabelText('Successor Turn prompt'),
      'Continue from the retained files with the prepared environment.'
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Prepare candidate' })).toBeEnabled()
    );
    await user.click(screen.getByRole('button', { name: 'Prepare candidate' }));

    await waitFor(() => expect(prepareWorkerEnvironment).toHaveBeenCalledTimes(1));
    expect(prepareWorkerEnvironment).toHaveBeenCalledWith({
      administrationThreadId: ADMIN_THREAD.id,
      configuration: {
        expectedRevision: CONFIG_REVISION,
        fileId: 'agents/codex.agent.jsonc',
      },
      declaration: {
        kind: 'reference',
        pullPolicy: 'never',
        ref: `sha256:${'f'.repeat(64)}`,
      },
      replaceNow: {
        prompt: 'Continue from the retained files with the prepared environment.',
        threadId: 'th_00000000-0000-7661-815f-0101e9c6c0d8',
        workspaceId: PROJECT.id,
      },
      requestId: expect.any(String),
      target: { agentId: 'codex', kind: 'agent' },
    });
    expect(await screen.findByText('Prepared environment change')).toBeInTheDocument();
  });

  it('recovers only from the exact authored candidate Artifact in the private Thread', async () => {
    const user = userEvent.setup();
    const prepareWorkerEnvironment = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        affectedStorage: CANDIDATE_PAYLOAD.affectedStorage,
        activationConfirmation: workerEnvironmentActivationConfirmation({
          affectedStorage: CANDIDATE_PAYLOAD.affectedStorage,
          configuration: CANDIDATE_PAYLOAD.configuration,
          replaceNow: CANDIDATE_PAYLOAD.replaceNow,
          resolvedCandidate: RESOLVED_CANDIDATE,
          image: CANDIDATE_PAYLOAD.image,
          target: CANDIDATE_PAYLOAD.target,
        }),
        authoredCandidate: AUTHORED_CANDIDATE,
        configuration: CANDIDATE_PAYLOAD.configuration,
        image: CANDIDATE_PAYLOAD.image,
        preparedAt: TIMESTAMP,
        replaceNow: CANDIDATE_PAYLOAD.replaceNow,
        requestId: input.requestId,
        resolvedCandidate: RESOLVED_CANDIDATE,
        target: CANDIDATE_PAYLOAD.target,
      })
    );
    const client = makeClient(
      { 'worker-environment.recover': prepareWorkerEnvironment },
      {
        'artifact.read': vi.fn().mockResolvedValue(AUTHORED_ARTIFACT),
        'thread.items': vi.fn().mockResolvedValue({ items: [AUTHORED_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    expect(await screen.findByText('Authored candidate needs recovery')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recover result' }));

    await waitFor(() => expect(prepareWorkerEnvironment).toHaveBeenCalledTimes(1));
    expect(prepareWorkerEnvironment).toHaveBeenCalledWith({
      administrationThreadId: ADMIN_THREAD.id,
      recoverFrom: AUTHORED_CANDIDATE,
      requestId: expect.any(String),
    });
    expect(prepareWorkerEnvironment.mock.calls[0]?.[0]).not.toHaveProperty('declaration');
    expect(await screen.findByText('Prepared environment change')).toBeInTheDocument();
  });

  it('rejects a resolved candidate whose Artifact version differs from its reference Item', async () => {
    const getArtifact = vi.fn().mockResolvedValue({ ...CANDIDATE_ARTIFACT, version: 2 });
    const client = makeClient(
      {},
      {
        'artifact.read': getArtifact,
        'thread.items': vi.fn().mockResolvedValue({ items: [CANDIDATE_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No environment candidate')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review activation' })).not.toBeInTheDocument();
    expect(getArtifact).toHaveBeenCalledWith({
      workspaceId: QUICK_CHAT.id,
      artifactId: RESOLVED_CANDIDATE.artifactId,
    });
  });

  it('does not apply a discovered configuration candidate until the administrator confirms it', async () => {
    const applyAdministrationConfiguration = vi.fn();
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': vi.fn().mockResolvedValue(CONFIG_ARTIFACT),
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    expect(await screen.findByText('Prepared configuration change')).toBeInTheDocument();
    expect(screen.getByText('Ready for review')).toBeInTheDocument();
    expect(screen.getAllByText('Provider openai').length).toBeGreaterThan(0);
    expect(screen.getByText(`Base revision ${CONFIG_REVISION}`)).toBeInTheDocument();
    expect(screen.getByText('Restart required')).toBeInTheDocument();
    expect(screen.getByText(/"displayName": "OpenAI",/)).toBeInTheDocument();
    expect(screen.getByText(/"displayName": "OpenAI production"/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply configuration' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/candidate id/i)).not.toBeInTheDocument();
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();
  });

  it('applies the exact private Thread candidate after human review', async () => {
    const user = userEvent.setup();
    const applyAdministrationConfiguration = vi.fn().mockResolvedValue(CONFIG_OUTCOME);
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': vi.fn().mockResolvedValue(CONFIG_ARTIFACT),
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Review configuration' }));
    expect(screen.getByRole('dialog', { name: 'Apply configuration?' })).toBeInTheDocument();
    expect(
      screen.getAllByText(
        `Configuration Artifact ${CONFIG_CANDIDATE.artifactId} v1 · ${CONFIG_CANDIDATE.contentDigest}`
      )
    ).not.toHaveLength(0);
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply configuration' }));
    await waitFor(() => expect(applyAdministrationConfiguration).toHaveBeenCalledTimes(1));
    expect(applyAdministrationConfiguration).toHaveBeenCalledWith({
      candidate: CONFIG_CANDIDATE,
      confirmation: {
        action: 'administration.configuration.apply',
        contentDigest: CONFIG_CANDIDATE.contentDigest,
      },
      requestId: expect.any(String),
    });
    expect(await screen.findByText('Configuration write persisted')).toBeInTheDocument();
    expect(screen.getByText('Reload failed')).toBeInTheDocument();
    expect(screen.getByText('Persisted')).toBeInTheDocument();
    expect(screen.queryByText('Ready for review')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Reload did not confirm a live configuration. Inspect the persisted revision and prepare a fresh candidate; do not retry this Apply.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review configuration' })).toBeDisabled();
    expect(applyAdministrationConfiguration).toHaveBeenCalledTimes(1);

    act(() => useWorkspaceStore.getState().setCurrentWorkspaceId(SECOND_PROJECT.id));
    expect(await screen.findByText('Target Workspace: Project Borealis')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review configuration' })).toBeDisabled();
    expect(applyAdministrationConfiguration).toHaveBeenCalledTimes(1);
  });

  it('fences a failed Apply without a retry control', async () => {
    const user = userEvent.setup();
    const applyAdministrationConfiguration = vi
      .fn()
      .mockRejectedValue(new Error('configuration_candidate_conflict'));
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': vi.fn().mockResolvedValue(CONFIG_ARTIFACT),
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Review configuration' }));
    await user.click(screen.getByRole('button', { name: 'Apply configuration' }));

    expect(
      await screen.findByText(
        'Configuration application could not be confirmed. Inspect persistence and reload, then prepare a fresh candidate.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Apply not confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Ready for review')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review configuration' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(applyAdministrationConfiguration).toHaveBeenCalledTimes(1);
  });

  it('disables configuration review while disconnected without applying', async () => {
    const applyAdministrationConfiguration = vi.fn();
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': vi.fn().mockResolvedValue(CONFIG_ARTIFACT),
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
        meta: vi.fn().mockRejectedValue(new Error('down')),
      }
    );
    renderScreen(client);

    expect(await screen.findByText('Prepared configuration change')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review configuration' })).toBeDisabled()
    );
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();
  });

  it('reuses the exact command after a fresh render without an outcome', async () => {
    const user = userEvent.setup();
    const applyAdministrationConfiguration = vi.fn().mockRejectedValue(new Error('unknown result'));
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': vi.fn().mockResolvedValue(CONFIG_ARTIFACT),
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const view = renderScreen(client);
      await user.click(await screen.findByRole('button', { name: 'Review configuration' }));
      await user.click(screen.getByRole('button', { name: 'Apply configuration' }));
      await waitFor(() =>
        expect(applyAdministrationConfiguration).toHaveBeenCalledTimes(attempt + 1)
      );
      view.unmount();
    }
    expect(applyAdministrationConfiguration.mock.calls[1]?.[0]).toEqual(
      applyAdministrationConfiguration.mock.calls[0]?.[0]
    );
    expect(
      ApplyAdministrationConfigurationRequestSchema.safeParse(
        applyAdministrationConfiguration.mock.calls[0]?.[0]
      ).success
    ).toBe(true);
  });

  it.each([
    'connection',
    'candidate',
  ])('blocks and ignores Apply after %s read failure while the confirmation is open', async (failedRead) => {
    const user = userEvent.setup();
    const applyAdministrationConfiguration = vi.fn();
    let connected = true;
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': vi
          .fn()
          .mockImplementation(() =>
            !connected && failedRead === 'candidate'
              ? Promise.reject(new Error('candidate unavailable'))
              : Promise.resolve(CONFIG_ARTIFACT)
          ),
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
        meta: vi
          .fn()
          .mockImplementation(() =>
            connected || failedRead !== 'connection'
              ? Promise.resolve({})
              : Promise.reject(new Error('down'))
          ),
      }
    );
    const { queryClient } = renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Review configuration' }));
    expect(screen.getByRole('dialog', { name: 'Apply configuration?' })).toBeInTheDocument();
    const confirmation = screen.getByRole('button', { name: 'Apply configuration' });
    connected = false;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    if (failedRead === 'candidate') {
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
      await user.click(confirmation);
    } else {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled()
      );
      await user.click(screen.getByRole('button', { name: 'Apply configuration' }));
    }
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();
  });

  it.each([
    'environment',
    'configuration',
  ] as const)('hides the private %s candidate and its open confirmation after parent denial', async (kind) => {
    const activate = vi.fn();
    const apply = vi.fn();
    const client = makeClient(
      { 'worker-environment.activate': activate, 'administration.configuration-apply': apply },
      {
        'artifact.read': vi
          .fn()
          .mockResolvedValue(kind === 'environment' ? CANDIDATE_ARTIFACT : CONFIG_ARTIFACT),
        'thread.items': vi
          .fn()
          .mockResolvedValue({ items: [kind === 'environment' ? CANDIDATE_ITEM : CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    const { queryClient } = renderScreen(client);
    await userEvent.click(
      await screen.findByRole('button', {
        name: kind === 'environment' ? 'Review activation' : 'Review configuration',
      })
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const candidateFacts =
      kind === 'environment'
        ? new RegExp(`Resolved Artifact ${RESOLVED_CANDIDATE.artifactId}`)
        : /"displayName": "OpenAI production"/;
    if (kind === 'environment') expect(screen.getAllByText(candidateFacts)).not.toHaveLength(0);
    const queryKey = ['settings', 'administration', 'thread', QUICK_CHAT.id, ADMIN_THREAD.id];
    vi.mocked(client.operations['thread.read']).mockRejectedValue(
      new ApiCallError(403, 'private-parent-denied')
    );
    await act(() => queryClient.invalidateQueries({ queryKey, exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryAllByText(candidateFacts)).toHaveLength(0);
    vi.mocked(client.operations['thread.read']).mockReturnValue(new Promise<never>(() => {}));
    await act(async () => {
      void queryClient.refetchQueries({ queryKey, exact: true });
    });
    await waitFor(() => expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe('fetching'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryAllByText(candidateFacts)).toHaveLength(0);
    expect(activate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    await act(() => queryClient.cancelQueries({ queryKey, exact: true }));
  });

  it.each([
    { kind: 'configuration', source: 'access', state: 'pending' },
    { kind: 'environment', source: 'thread', state: 'paused' },
    { kind: 'configuration', source: 'items', state: 'paused' },
    { kind: 'environment', source: 'candidate', state: 'pending' },
  ] as const)('blocks private $kind confirmation while the $source read is $state', async ({
    kind,
    source,
    state,
  }) => {
    const activate = vi.fn();
    const apply = vi.fn();
    const candidate = kind === 'environment' ? RESOLVED_CANDIDATE : CONFIG_CANDIDATE;
    const client = makeClient(
      { 'worker-environment.activate': activate, 'administration.configuration-apply': apply },
      {
        'artifact.read': vi
          .fn()
          .mockResolvedValue(kind === 'environment' ? CANDIDATE_ARTIFACT : CONFIG_ARTIFACT),
        'thread.items': vi
          .fn()
          .mockResolvedValue({ items: [kind === 'environment' ? CANDIDATE_ITEM : CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    const { queryClient } = renderScreen(client);
    await userEvent.click(
      await screen.findByRole('button', {
        name: kind === 'environment' ? 'Review activation' : 'Review configuration',
      })
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: kind === 'environment' ? 'Activate candidate' : 'Apply configuration',
      })
    ).toBeEnabled();
    const keys = {
      access: ['settings', 'administration', 'access'],
      thread: ['settings', 'administration', 'thread', QUICK_CHAT.id, ADMIN_THREAD.id],
      items: ['items', QUICK_CHAT.id, ADMIN_THREAD.id],
      candidate: [
        'settings',
        'administration',
        'prepared-candidate',
        QUICK_CHAT.id,
        ADMIN_THREAD.id,
        `${candidate.artifactId}:1`,
      ],
    };
    const methods = {
      access: 'token.list',
      thread: 'thread.read',
      items: 'thread.items',
      candidate: 'artifact.read',
    } as const;
    const queryKey = keys[source];
    if (state === 'pending') {
      vi.mocked(client.operations[methods[source]]).mockReturnValue(new Promise<never>(() => {}));
    }
    try {
      if (state === 'paused') onlineManager.setOnline(false);
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey, exact: true });
      });
      await waitFor(() =>
        expect(queryClient.getQueryState(queryKey)).toMatchObject({
          fetchStatus: state === 'paused' ? 'paused' : 'fetching',
        })
      );
      await waitFor(() => {
        const currentConfirmation = screen.queryByRole('button', {
          name: kind === 'environment' ? 'Activate candidate' : 'Apply configuration',
        });
        if (currentConfirmation) expect(currentConfirmation).toBeDisabled();
        else expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      const confirmation = screen.queryByRole('button', {
        name: kind === 'environment' ? 'Activate candidate' : 'Apply configuration',
      });
      if (confirmation) {
        expect(confirmation).toBeDisabled();
        await userEvent.click(confirmation);
      }
      expect(activate).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    } finally {
      await act(async () => {
        await queryClient.cancelQueries();
        onlineManager.setOnline(true);
      });
    }
  });

  it('removes an open deletion confirmation when current administrator access is denied', async () => {
    const purge = vi.fn();
    const client = makeClient({
      'worker-environment.list': vi
        .fn()
        .mockResolvedValue({ items: [ENVIRONMENT], nextCursor: null }),
      'worker-environment.purge': purge,
    });
    const { queryClient } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(
      screen.getByRole('dialog', { name: 'Delete retained environment?' })
    ).toBeInTheDocument();
    vi.mocked(client.operations['token.list']).mockRejectedValue(
      new ApiCallError(403, 'administrator-denied')
    );
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: ['settings', 'administration', 'access'],
        exact: true,
      })
    );
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(purge).not.toHaveBeenCalled();
  });

  it('hides private candidate facts after typed denial and a later failed Items retry until success', async () => {
    const client = makeClient(
      {},
      {
        'artifact.read': vi.fn().mockResolvedValue(CONFIG_ARTIFACT),
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    renderScreen(client, queryClient);
    const queryKey = ['items', QUICK_CHAT.id, ADMIN_THREAD.id];
    try {
      await userEvent.click(await screen.findByRole('button', { name: 'Review configuration' }));
      let failRetry!: () => void;
      vi.mocked(client.operations['thread.items'])
        .mockRejectedValueOnce(new ApiCallError(403, 'private-items-denied'))
        .mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              failRetry = () => reject(new ApiCallError(500, 'private-items-unavailable'));
            })
        );
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey, exact: true });
      });
      await waitFor(() => expect(failRetry).toBeDefined());
      expect(queryClient.getQueryState(queryKey)?.error).toBeNull();
      expect(queryClient.getQueryState(queryKey)?.fetchFailureReason).toMatchObject({
        status: 403,
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
      await act(async () => failRetry());
      await waitFor(() =>
        expect(queryClient.getQueryState(queryKey)?.error).toMatchObject({ status: 500 })
      );
      expect(await screen.findByText("Couldn't load this thread.")).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
      let restoreItems!: () => void;
      vi.mocked(client.operations['thread.items']).mockImplementation(
        () =>
          new Promise((resolve) => {
            restoreItems = () => resolve({ items: [CONFIG_ITEM], nextCursor: null });
          })
      );
      await act(async () => {
        void queryClient.refetchQueries({ queryKey, exact: true });
      });
      await waitFor(() => expect(restoreItems).toBeDefined());
      expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
      await act(async () => restoreItems());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Review configuration' })).toBeEnabled()
      );
      expect(client.operations['administration.configuration-apply']).not.toHaveBeenCalled();
    } finally {
      await act(() => queryClient.cancelQueries({ queryKey, exact: true }));
    }
  });

  it('rechecks current administrator and exact parent authority before admitting a fresh cached candidate on remount', async () => {
    const fixture = () =>
      makeClient(
        {},
        {
          'artifact.read': vi.fn().mockResolvedValue(CONFIG_ARTIFACT),
          'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
          'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
        }
      );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const first = renderScreen(fixture(), queryClient);
    expect(await screen.findByRole('button', { name: 'Review configuration' })).toBeEnabled();
    first.unmount();
    const client = fixture();
    let allowAccess!: () => void;
    let allowParent!: () => void;
    vi.mocked(client.operations['token.list']).mockImplementation(
      () =>
        new Promise((resolve) => {
          allowAccess = () => resolve({ items: [] });
        })
    );
    const readParent = vi.mocked(client.operations['thread.read']).getMockImplementation()!;
    vi.mocked(client.operations['thread.read']).mockImplementation(
      (input) =>
        new Promise((resolve) => {
          allowParent = () => {
            void Promise.resolve(readParent(input)).then(resolve);
          };
        })
    );
    renderScreen(client, queryClient);
    await waitFor(() => expect(client.operations['token.list']).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
    expect(client.operations['thread.read']).not.toHaveBeenCalled();
    await act(async () => allowAccess());
    await waitFor(() => expect(client.operations['thread.read']).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
    expect(client.operations['administration.configuration-apply']).not.toHaveBeenCalled();
    await act(async () => allowParent());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review configuration' })).toBeEnabled()
    );
    expect(client.operations['thread.read']).toHaveBeenCalledWith({
      workspaceId: QUICK_CHAT.id,
      threadId: ADMIN_THREAD.id,
    });
    expect(client.operations['artifact.read']).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'environment', authority: 'parent' },
    { kind: 'configuration', authority: 'access' },
  ] as const)('keeps the dispatched $kind outcome through $authority denial and read recovery', async ({
    kind,
    authority,
  }) => {
    let finish!: () => void;
    const activate = vi.fn().mockImplementation(
      (input: { requestId: string }) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              affected: [{ ...CANDIDATE_PAYLOAD.affectedStorage[0], disposition: 'unknown' }],
              configuration: null,
              replaceNow: CANDIDATE_PAYLOAD.replaceNow,
              requestId: input.requestId,
              resolvedCandidate: RESOLVED_CANDIDATE,
              target: CANDIDATE_PAYLOAD.target,
            });
        })
    );
    const apply = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(CONFIG_OUTCOME);
        })
    );
    const client = makeClient(
      { 'worker-environment.activate': activate, 'administration.configuration-apply': apply },
      {
        'artifact.read': vi
          .fn()
          .mockResolvedValue(kind === 'environment' ? CANDIDATE_ARTIFACT : CONFIG_ARTIFACT),
        'thread.items': vi
          .fn()
          .mockResolvedValue({ items: [kind === 'environment' ? CANDIDATE_ITEM : CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    const readAccess = vi.mocked(client.operations['token.list']).getMockImplementation()!;
    const readParent = vi.mocked(client.operations['thread.read']).getMockImplementation()!;
    const { queryClient } = renderScreen(client);
    await userEvent.click(
      await screen.findByRole('button', {
        name: kind === 'environment' ? 'Review activation' : 'Review configuration',
      })
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: kind === 'environment' ? 'Activate candidate' : 'Apply configuration',
      })
    );
    const effect = kind === 'environment' ? activate : apply;
    await waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
    const command = queryClient
      .getMutationCache()
      .getAll()
      .find((mutation) => mutation.state.status === 'pending');
    expect(command).toBeDefined();
    const queryKey =
      authority === 'access'
        ? ['settings', 'administration', 'access']
        : ['settings', 'administration', 'thread', QUICK_CHAT.id, ADMIN_THREAD.id];
    if (authority === 'access')
      vi.mocked(client.operations['token.list']).mockRejectedValue(
        new ApiCallError(403, 'administrator-denied')
      );
    else
      vi.mocked(client.operations['thread.read']).mockRejectedValue(
        new ApiCallError(403, 'private-parent-denied')
      );
    await act(() => queryClient.invalidateQueries({ queryKey, exact: true }));
    if (authority === 'access')
      expect(await screen.findByText('Access denied')).toBeInTheDocument();
    else
      expect(
        await screen.findByText('This private administration Thread is unavailable.')
      ).toBeInTheDocument();
    await act(async () => finish());
    await waitFor(() => expect(command?.state.status).toBe('success'));
    expect(
      screen.queryByText(
        kind === 'environment' ? 'Activation command result' : 'Configuration command result'
      )
    ).not.toBeInTheDocument();
    if (authority === 'access')
      vi.mocked(client.operations['token.list']).mockImplementation(readAccess);
    else vi.mocked(client.operations['thread.read']).mockImplementation(readParent);
    await userEvent.click(
      screen.getByRole('button', { name: authority === 'access' ? 'Retry' : 'Try again' })
    );
    expect(
      await screen.findByText(
        kind === 'environment' ? 'Activation command result' : 'Configuration command result'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: kind === 'environment' ? 'Review activation' : 'Review configuration',
      })
    ).toBeDisabled();
    expect(queryClient.getMutationCache().getAll()).toContain(command);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('unmounts an open confirmation when the discovered candidate identity changes', async () => {
    const user = userEvent.setup();
    const applyAdministrationConfiguration = vi.fn();
    let items: Array<typeof CONFIG_ITEM | typeof CONFIG_ITEM_B> = [CONFIG_ITEM];
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': vi
          .fn()
          .mockImplementation(
            ({
              workspaceId: _workspaceId,
              artifactId,
            }: Parameters<CoreClient['operations']['artifact.read']>[0]) =>
              Promise.resolve(
                artifactId === CONFIG_CANDIDATE_B.artifactId ? CONFIG_ARTIFACT_B : CONFIG_ARTIFACT
              )
          ),
        'thread.items': vi.fn().mockImplementation(() => Promise.resolve({ items })),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    const { queryClient } = renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Review configuration' }));
    expect(screen.getByRole('dialog', { name: 'Apply configuration?' })).toBeInTheDocument();
    expect(
      screen.getAllByText(
        `Configuration Artifact ${CONFIG_CANDIDATE.artifactId} v1 · ${CONFIG_CANDIDATE.contentDigest}`
      )
    ).not.toHaveLength(0);

    items = [CONFIG_ITEM_B];
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Apply configuration?' })).not.toBeInTheDocument()
    );
    expect(await screen.findByText(/"displayName": "OpenAI staging"/)).toBeInTheDocument();
    expect(
      screen.queryByText(
        `Configuration Artifact ${CONFIG_CANDIDATE.artifactId} v1 · ${CONFIG_CANDIDATE.contentDigest}`
      )
    ).not.toBeInTheDocument();
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();
  });

  it('shows a recorded apply outcome for the exact candidate on a fresh render', async () => {
    const applyAdministrationConfiguration = vi.fn();
    const getArtifact = vi
      .fn()
      .mockImplementation(
        ({
          workspaceId: _workspaceId,
          artifactId,
        }: Parameters<CoreClient['operations']['artifact.read']>[0]) =>
          Promise.resolve(
            artifactId === CONFIG_OUTCOME_ITEM.artifactId
              ? CONFIG_OUTCOME_ARTIFACT
              : CONFIG_ARTIFACT
          )
      );
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': getArtifact,
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM, CONFIG_OUTCOME_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    expect(await screen.findByText('Configuration write persisted')).toBeInTheDocument();
    expect(screen.getByText('Reload failed')).toBeInTheDocument();
    expect(screen.getByText('Persisted')).toBeInTheDocument();
    expect(screen.queryByText('Ready for review')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review configuration' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Apply configuration' })).not.toBeInTheDocument();
    expect(getArtifact).toHaveBeenCalledWith({
      workspaceId: QUICK_CHAT.id,
      artifactId: CONFIG_CANDIDATE.artifactId,
    });
    expect(getArtifact).toHaveBeenCalledWith({
      workspaceId: QUICK_CHAT.id,
      artifactId: CONFIG_OUTCOME_ITEM.artifactId,
    });
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();
  });

  it('ignores a catalog Artifact that is not the authorized private Thread identity', async () => {
    const applyAdministrationConfiguration = vi.fn();
    const getArtifact = vi.fn().mockResolvedValue({
      ...CONFIG_ARTIFACT,
      threadId: 'th_00000000-0000-7429-b248-27885d480335',
      origin: { ...CONFIG_ARTIFACT.origin, threadId: 'th_00000000-0000-7429-b248-27885d480335' },
    });
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': getArtifact,
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No environment candidate')).toBeInTheDocument();
    expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review configuration' })).not.toBeInTheDocument();
    expect(getArtifact).toHaveBeenCalledWith({
      workspaceId: QUICK_CHAT.id,
      artifactId: CONFIG_CANDIDATE.artifactId,
    });
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();
  });

  it('rejects a catalog candidate whose Artifact version differs from its reference Item', async () => {
    const applyAdministrationConfiguration = vi.fn();
    const getArtifact = vi.fn().mockResolvedValue({ ...CONFIG_ARTIFACT, version: 2 });
    const client = makeClient(
      { 'administration.configuration-apply': applyAdministrationConfiguration },
      {
        'artifact.read': getArtifact,
        'thread.items': vi.fn().mockResolvedValue({ items: [CONFIG_ITEM] }),
        'thread.list': vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Prepared configuration change')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review configuration' })).not.toBeInTheDocument();
    expect(applyAdministrationConfiguration).not.toHaveBeenCalled();
  });
});
