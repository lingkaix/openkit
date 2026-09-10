import { workerEnvironmentActivationConfirmation } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { AdministrationScreen } from './AdministrationScreen';

const TIMESTAMP = '2026-09-10T00:00:00.000Z';
const PROJECT = {
  id: 'ws_project',
  name: 'Project Atlas',
  kind: 'general',
  status: 'active',
  counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const QUICK_CHAT = {
  ...PROJECT,
  id: 'ws_quick_chat',
  name: 'Quick Chat',
  kind: 'quick-chat',
};
const SECOND_PROJECT = { ...PROJECT, id: 'ws_second', name: 'Project Borealis' };
const STORAGE_REF = `wst_${'a'.repeat(32)}`;
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
  id: 'thread_admin',
  workspaceId: QUICK_CHAT.id,
  name: 'Administration',
  preview: 'Administration',
  status: 'active',
  entryPath: 'administration',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const RESOLVED_CANDIDATE = {
  artifactId: 'artifact_resolved',
  artifactVersion: 1 as const,
  contentDigest: `sha256:${'d'.repeat(64)}`,
};
const AUTHORED_CANDIDATE = {
  artifactId: 'artifact_authored',
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
    threadId: 'thread_project',
    workspaceId: PROJECT.id,
  },
  schemaVersion: 1,
  target: { agentId: 'codex', kind: 'agent' },
} as const;
const CANDIDATE_ITEM = {
  id: 'item_candidate',
  workspaceId: QUICK_CHAT.id,
  threadId: ADMIN_THREAD.id,
  turnId: 'turn_prepare',
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
  turnId: 'turn_prepare',
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
    turnId: 'turn_prepare',
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
  id: 'item_authored',
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

function makeClient(
  app: Partial<CoreClient['app']> = {},
  core: Partial<CoreClient['core']> = {},
  runtimeConfig: Partial<CoreClient['runtimeConfig']> = {}
): CoreClient {
  return {
    app: {
      listOpenKitAccessTokens: vi.fn().mockResolvedValue({ items: [] }),
      listWorkerEnvironments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      ...app,
    },
    core: {
      listWorkspaces: vi.fn().mockResolvedValue({ items: [PROJECT, SECOND_PROJECT, QUICK_CHAT] }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      getThread: vi.fn().mockImplementation((workspaceId: string, threadId: string) =>
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
      listThreadItems: vi.fn().mockResolvedValue({ items: [] }),
      getWorkspaceResources: vi.fn().mockResolvedValue({
        knowledge: [],
        skills: [],
        agents: [],
        models: [],
      }),
      meta: vi.fn().mockResolvedValue({}),
      ...core,
    },
    runtimeConfig: {
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
      getFile: vi.fn(),
      ...runtimeConfig,
    },
  } as unknown as CoreClient;
}

function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <AdministrationScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useWorkspaceStore.setState({ currentWorkspaceId: PROJECT.id });
});

describe('Administration', () => {
  it('uses the private administration entry and continues its returned Thread', async () => {
    const user = userEvent.setup();
    const submitAdministrationConversation = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'answered',
        explanation: 'Prepared.',
        turn: { id: 'turn_1' },
        item: { id: 'item_1' },
        handoff: null,
        originatingWorkspaceId: QUICK_CHAT.id,
        originatingThreadId: 'thread_admin',
        receivingWorkspaceId: QUICK_CHAT.id,
        receivingThreadId: 'thread_admin',
        targetRef: 'assistant',
        logicalModelId: null,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        explanation: 'Inspected.',
        turn: { id: 'turn_2' },
        item: { id: 'item_2' },
        handoff: null,
        originatingWorkspaceId: QUICK_CHAT.id,
        originatingThreadId: 'thread_admin',
        receivingWorkspaceId: QUICK_CHAT.id,
        receivingThreadId: 'thread_admin',
        targetRef: 'assistant',
        logicalModelId: null,
      });
    const client = makeClient({ submitAdministrationConversation });
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
      threadId: 'thread_admin',
    });
  });

  it('fails closed when the signed-in session has no usable administrator authority', async () => {
    const client = makeClient({
      listOpenKitAccessTokens: vi
        .fn()
        .mockRejectedValue(
          new ApiCallError(403, 'Server-admin authority is required.', { code: 'forbidden' })
        ),
    });
    renderScreen(client);

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Administration message')).not.toBeInTheDocument();
    expect(client.app.listWorkerEnvironments).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
  });

  it('clears inspected status and reads the newly selected global Workspace', async () => {
    const user = userEvent.setup();
    const listWorkerEnvironments = vi.fn().mockImplementation((workspaceId: string) =>
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
    const client = makeClient({ listWorkerEnvironments, getWorkerEnvironmentStatus });
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Refresh status' }));
    expect(await screen.findByText('No current attachment.')).toBeInTheDocument();

    act(() => useWorkspaceStore.getState().setCurrentWorkspaceId(SECOND_PROJECT.id));

    expect(await screen.findByText('Target Workspace: Project Borealis')).toBeInTheDocument();
    await waitFor(() =>
      expect(listWorkerEnvironments).toHaveBeenCalledWith(SECOND_PROJECT.id, { limit: 100 })
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
      listWorkerEnvironments: vi.fn().mockResolvedValue({ items: [ENVIRONMENT], nextCursor: null }),
      getWorkerEnvironmentStatus,
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
      getWorkerEnvironmentStatus,
      listWorkerEnvironments: vi.fn().mockResolvedValue({ items: [ENVIRONMENT], nextCursor: null }),
      purgeWorkerEnvironment,
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
    expect(purgeWorkerEnvironment).toHaveBeenCalledWith(PROJECT.id, STORAGE_REF, {
      confirmation: `purge-worker-environment:${STORAGE_REF}:2`,
      expectedRevision: 2,
      requestId: expect.any(String),
      storageRef: STORAGE_REF,
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

  it('discovers the structured candidate Artifact and submits one exact human-reviewed activation', async () => {
    const user = userEvent.setup();
    const getWorkerEnvironmentStatus = vi.fn();
    const activateWorkerEnvironment = vi.fn().mockImplementation((input: { requestId: string }) =>
      Promise.resolve({
        affected: [
          {
            ...CANDIDATE_PAYLOAD.affectedStorage[0],
            disposition: 'unknown',
          },
        ],
        configuration: null,
        replaceNow: CANDIDATE_PAYLOAD.replaceNow,
        requestId: input.requestId,
        resolvedCandidate: RESOLVED_CANDIDATE,
        target: CANDIDATE_PAYLOAD.target,
      })
    );
    const client = makeClient(
      {
        activateWorkerEnvironment,
        getWorkerEnvironmentStatus,
        listWorkerEnvironments: vi
          .fn()
          .mockResolvedValue({ items: [ENVIRONMENT], nextCursor: null }),
      },
      {
        getArtifact: vi
          .fn()
          .mockImplementation((_workspaceId, artifactId) =>
            Promise.resolve(
              artifactId === AUTHORED_CANDIDATE.artifactId ? AUTHORED_ARTIFACT : CANDIDATE_ARTIFACT
            )
          ),
        listThreadItems: vi.fn().mockResolvedValue({ items: [AUTHORED_ITEM, CANDIDATE_ITEM] }),
        listThreads: vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
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
    expect(activateWorkerEnvironment).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Activate candidate' }));
    await waitFor(() => expect(activateWorkerEnvironment).toHaveBeenCalledTimes(1));
    const binding = {
      affectedStorage: CANDIDATE_PAYLOAD.affectedStorage,
      configuration: CANDIDATE_PAYLOAD.configuration,
      replaceNow: CANDIDATE_PAYLOAD.replaceNow,
      resolvedCandidate: RESOLVED_CANDIDATE,
      target: CANDIDATE_PAYLOAD.target,
    };
    expect(activateWorkerEnvironment).toHaveBeenCalledWith({
      ...binding,
      confirmation: workerEnvironmentActivationConfirmation(binding),
      requestId: expect.any(String),
    });
    expect(
      await screen.findByText(
        'Activation is incomplete or includes an unknown host result. Inspect the exact configuration and environment status, then prepare a fresh candidate.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review activation' })).toBeDisabled();
    expect(getWorkerEnvironmentStatus).not.toHaveBeenCalled();
    expect(activateWorkerEnvironment).toHaveBeenCalledTimes(1);

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
      { prepareWorkerEnvironment },
      {
        listThreads: vi.fn().mockImplementation((workspaceId) =>
          Promise.resolve({
            items:
              workspaceId === QUICK_CHAT.id
                ? [ADMIN_THREAD]
                : [
                    {
                      ...ADMIN_THREAD,
                      entryPath: 'conversation',
                      id: 'thread_project',
                      name: 'Project implementation',
                      workspaceId: PROJECT.id,
                    },
                  ],
          })
        ),
      },
      {
        getFile: vi.fn().mockResolvedValue({
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
        listFiles: vi.fn().mockResolvedValue({
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
      mode: 'prepare',
      replaceNow: {
        prompt: 'Continue from the retained files with the prepared environment.',
        threadId: 'thread_project',
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
      { prepareWorkerEnvironment },
      {
        getArtifact: vi.fn().mockResolvedValue(AUTHORED_ARTIFACT),
        listThreadItems: vi.fn().mockResolvedValue({ items: [AUTHORED_ITEM] }),
        listThreads: vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    expect(await screen.findByText('Authored candidate needs recovery')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recover result' }));

    await waitFor(() => expect(prepareWorkerEnvironment).toHaveBeenCalledTimes(1));
    expect(prepareWorkerEnvironment).toHaveBeenCalledWith({
      administrationThreadId: ADMIN_THREAD.id,
      mode: 'recover',
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
        getArtifact,
        listThreadItems: vi.fn().mockResolvedValue({ items: [CANDIDATE_ITEM] }),
        listThreads: vi.fn().mockResolvedValue({ items: [ADMIN_THREAD] }),
      }
    );
    renderScreen(client);

    await waitFor(() => expect(getArtifact).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No environment candidate')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review activation' })).not.toBeInTheDocument();
    expect(getArtifact).toHaveBeenCalledWith(QUICK_CHAT.id, RESOLVED_CANDIDATE.artifactId);
  });
});
