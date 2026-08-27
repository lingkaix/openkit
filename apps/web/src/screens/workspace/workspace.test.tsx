import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';

const TIMESTAMP_OLD = '2026-07-21T10:00:00.000Z';
const TIMESTAMP_NEW = '2026-07-21T11:00:00.000Z';

const REPOSITORY_RESOURCE = {
  workspaceId: 'ws1',
  resourceId: 'repo_default',
  type: 'git_repository',
  displayName: 'Market research repository',
  diagnosticsStatus: 'ready',
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_NEW,
  pathSummary: 'git repository ending in market-research',
  git: {
    authorEmail: null,
    authorName: null,
    allowedPushTargets: ['main'],
    commitOnApply: false,
    protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
    requireReviewLinkage: true,
    stagingStrategy: 'staging-root',
    vaultGrantRef: null,
  },
  validation: {
    ok: true,
    resourceKind: 'git_repository',
    status: 'ready',
    summary: 'Repository is ready.',
    pathSummary: 'git repository ending in market-research',
  },
} as const;

const REPOSITORY_DIAGNOSTIC = {
  workspaceId: 'ws1',
  resourceId: REPOSITORY_RESOURCE.resourceId,
  type: 'git_repository',
  displayName: REPOSITORY_RESOURCE.displayName,
  diagnosticsStatus: 'ready',
  ready: true,
  summary: 'Repository is ready for governed push.',
  pathSummary: REPOSITORY_RESOURCE.pathSummary,
  updatedAt: TIMESTAMP_NEW,
} as const;

const PUSH_TARGET = {
  threadId: 'th_push',
  turnId: 'tu_push',
  sourceRef: 'HEAD',
  targetBranch: 'main',
  commitIds: ['abc123', 'def456'],
} as const;

const PUSH_APPROVAL = {
  approval: {
    id: 'ap_push',
    workspaceId: 'ws1',
    threadId: PUSH_TARGET.threadId,
    turnId: PUSH_TARGET.turnId,
    kind: 'permission',
    status: 'granted',
    title: 'Approve Git push to main',
    description: 'Publish abc123 and def456 from HEAD to main.',
    createdAt: TIMESTAMP_OLD,
    resolvedAt: TIMESTAMP_NEW,
  },
  approvalItemId: 'it_push_approval',
  policyDecisionId: 'pd_push',
} as const;

const PENDING_PUSH_APPROVAL = {
  ...PUSH_APPROVAL,
  approval: {
    ...PUSH_APPROVAL.approval,
    status: 'pending',
    resolvedAt: null,
  },
} as const;

const PUSH_RECORD = {
  id: 'gpr_push',
  workspaceId: 'ws1',
  repositoryResourceId: REPOSITORY_RESOURCE.resourceId,
  approvalRowId: PUSH_APPROVAL.approvalItemId,
  policyDecisionId: PUSH_APPROVAL.policyDecisionId,
  actorId: 'user_1',
  remoteSummary: 'GitHub repository market-research on origin',
  sourceRef: PUSH_TARGET.sourceRef,
  targetBranch: PUSH_TARGET.targetBranch,
  commitIds: [...PUSH_TARGET.commitIds],
  reviewIds: ['review_1'],
  remoteHeadBefore: 'def456',
  remoteHeadAfter: PUSH_TARGET.commitIds[0],
  outcome: 'pushed',
  errorSummary: null,
  createdAt: TIMESTAMP_NEW,
  updatedAt: TIMESTAMP_NEW,
} as const;

const APPROVAL_ROW = {
  id: 'approval:ap1',
  kind: 'approval',
  workspaceId: 'ws1',
  threadId: 'th1',
  turnId: 't1',
  itemId: 'i1',
  title: 'Scout asks to sign in to the vendor portal',
  summary: 'To pull competitor pricing.',
  severity: 'needs_input',
  createdAt: TIMESTAMP_OLD,
  recommendedAction: 'Review and respond to the approval request.',
  source: {
    type: 'approval',
    approvalRequestId: 'ap1',
    workspaceId: 'ws1',
    threadId: 'th1',
    turnId: 't1',
    itemId: 'i1',
  },
  actions: [
    {
      kind: 'grant_approval',
      label: 'Approve',
      method: 'POST',
      href: '/api/approvals/ap1/respond',
    },
    { kind: 'deny_approval', label: 'Skip', method: 'POST', href: '/api/approvals/ap1/respond' },
    { kind: 'open_thread', label: 'Open', method: 'GET', href: '/api/workspaces/ws1/threads/th1' },
  ],
};

const OPEN_ONLY_ROW = {
  id: 'question:q1',
  kind: 'question',
  workspaceId: 'ws1',
  threadId: 'th2',
  turnId: 't2',
  itemId: 'i2',
  title: 'Answer required',
  summary: 'Which market segment should we prioritize?',
  severity: 'needs_input',
  createdAt: TIMESTAMP_NEW,
  recommendedAction: 'Answer the question before the worker can continue.',
  source: {
    type: 'protocol_item',
    itemType: 'user-input-request',
    workspaceId: 'ws1',
    threadId: 'th2',
    turnId: 't2',
    itemId: 'i2',
  },
  actions: [
    { kind: 'answer_question', label: 'Answer', method: 'POST', href: '/api/turns' },
    { kind: 'open_thread', label: 'Open', method: 'GET', href: '/api/workspaces/ws1/threads/th2' },
  ],
};

const AGENT_READY = {
  id: 'agent_ledger',
  name: 'Ledger',
  kind: 'researcher',
  status: 'enabled',
  modelId: 'gpt-test',
  skillIds: [],
  profiles: [],
  defaultProfileId: null,
  capabilities: [{ id: 'tables', label: 'Tables', description: 'Organize numbers' }],
  sandboxSummary: null,
  health: { status: 'ready', message: 'Healthy', checkedAt: TIMESTAMP_NEW },
};

const AGENT_WORKING = {
  id: 'agent_scout',
  name: 'Scout',
  kind: 'researcher',
  status: 'enabled',
  modelId: null,
  skillIds: [],
  profiles: [],
  defaultProfileId: null,
  capabilities: [],
  sandboxSummary: { access: 'read-only', workspaceRootRefs: [], summary: 'Read-only sandbox' },
  health: { status: 'running', message: 'Summarizing interviews', checkedAt: TIMESTAMP_NEW },
};

const KNOWLEDGE_ENTRY = {
  id: 'mem1',
  kind: 'preference',
  title: 'Write in English; keep answers concise',
  content: 'Prefer short replies.',
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_OLD,
};

const UPDATED_KNOWLEDGE_ENTRY = {
  ...KNOWLEDGE_ENTRY,
  title: 'Server-confirmed concise writing',
  content: 'Use the canonical server wording.',
  updatedAt: TIMESTAMP_NEW,
};

const KNOWLEDGE_SOURCE = {
  id: 'ks_source',
  workspaceId: 'ws1',
  kind: 'transcript',
  title: 'Customer interview Q3',
  uri: null,
  contentDigest: `sha256:${'a'.repeat(64)}`,
  originatingThreadId: 'th1',
  originatingTurnId: 't1',
  originatingFileId: 'file1',
  capturedAt: TIMESTAMP_OLD,
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_OLD,
};

const KNOWLEDGE_OBSERVATION = {
  id: 'ko_observation',
  workspaceId: 'ws1',
  kind: 'user-feedback',
  summary: 'Customers repeatedly ask for shorter weekly updates.',
  sourceReferences: [],
  scope: 'workspace',
  producer: 'user:test',
  confidence: 0.8,
  freshness: 'current',
  status: 'retained',
  observedAt: TIMESTAMP_OLD,
  createdAt: TIMESTAMP_OLD,
};

const KNOWLEDGE_CLAIM = {
  id: 'kc_claim',
  workspaceId: 'ws1',
  statement: 'Weekly updates should fit on one screen.',
  sourceReferences: [],
  scope: 'workspace',
  producer: 'user:test',
  confidence: 0.7,
  freshness: 'current',
  reviewState: 'needs-review',
  conflictStatus: 'weak_evidence',
  createdAt: TIMESTAMP_OLD,
  updatedAt: TIMESTAMP_OLD,
};

const KNOWLEDGE_PROPOSAL_ROW = {
  id: 'non-authoritative-wrapper-id',
  kind: 'knowledge_review',
  workspaceId: 'non-authoritative-wrapper-workspace',
  title: 'Review knowledge proposal for writing/weekly-updates',
  summary: 'Keep weekly updates concise and source-linked.',
  severity: 'needs_input',
  createdAt: TIMESTAMP_OLD,
  recommendedAction: 'Accept, reject, or defer the knowledge proposal.',
  source: {
    type: 'knowledge',
    knowledgeProposalId: 'kp_exact',
    workspaceId: 'ws1',
    status: 'pending',
  },
  actions: [
    { kind: 'accept_knowledge', label: 'Accept', method: 'POST' },
    { kind: 'reject_knowledge', label: 'Reject', method: 'POST' },
    { kind: 'defer', label: 'Defer', method: 'POST' },
  ],
};

const NON_KNOWLEDGE_PROPOSAL_DECOY = {
  ...KNOWLEDGE_PROPOSAL_ROW,
  id: 'non-knowledge-decoy',
  title: 'Non-knowledge proposal decoy',
  source: APPROVAL_ROW.source,
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

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(
  overrides: {
    core?: MethodOverrides;
    app?: MethodOverrides;
    agents?: MethodOverrides;
    actionCenter?: MethodOverrides;
    repositories?: MethodOverrides;
  } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [{ id: 'ws1', name: 'Market research' }] }),
      listKnowledge: vi.fn().mockResolvedValue({ items: [] }),
      createKnowledge: vi.fn().mockResolvedValue(KNOWLEDGE_ENTRY),
      updateKnowledge: vi.fn().mockResolvedValue(UPDATED_KNOWLEDGE_ENTRY),
      deleteKnowledge: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({
        id: 'ws-new',
        name: 'New workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: TIMESTAMP_NEW,
        updatedAt: TIMESTAMP_NEW,
      }),
      respondApproval: vi.fn().mockResolvedValue({}),
      ...overrides.core,
    },
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
      getWorkspaceDashboard: vi.fn().mockResolvedValue({
        workspace: { id: 'ws1', name: 'Market research' },
        counts: {
          threadCount: 2,
          artifactCount: 0,
          knowledgeEntryCount: 0,
          providerCount: 1,
        },
        defaultContext: { modelId: null, agentId: null, skillIds: [] },
        agentHealth: [],
        recentThreads: [],
        activeWork: [
          {
            threadId: 'th1',
            title: 'Competitive pricing report',
            status: 'running',
            mode: 'goal',
            agentId: 'agent_scout',
            summary: '4 of 6 steps moving',
            updatedAt: TIMESTAMP_NEW,
          },
        ],
        recentCompletions: [],
        attentionNeeded: [],
      }),
      submitArtifactReviewDecision: vi.fn().mockResolvedValue({}),
      listKnowledgeSources: vi.fn().mockResolvedValue({ items: [] }),
      listKnowledgeObservations: vi.fn().mockResolvedValue({ items: [] }),
      listKnowledgeClaims: vi.fn().mockResolvedValue({ items: [] }),
      submitKnowledgeProposalDecision: vi.fn().mockResolvedValue({}),
      ...overrides.app,
    },
    agents: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      get: vi.fn().mockResolvedValue(AGENT_READY),
      refreshHealth: vi.fn().mockResolvedValue({ items: [], sessions: [] }),
      ...overrides.agents,
    },
    actionCenter: {
      listHumanAttention: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.actionCenter,
    },
    repositories: {
      list: vi.fn().mockResolvedValue({
        items: [REPOSITORY_RESOURCE],
        defaultResourceId: REPOSITORY_RESOURCE.resourceId,
        defaultResource: REPOSITORY_RESOURCE,
      }),
      diagnostics: vi.fn().mockResolvedValue({
        workspaceId: 'ws1',
        defaultResourceId: REPOSITORY_RESOURCE.resourceId,
        defaultResource: REPOSITORY_DIAGNOSTIC,
        resources: [REPOSITORY_DIAGNOSTIC],
      }),
      listGitPushRecords: vi.fn().mockResolvedValue({ items: [PUSH_RECORD] }),
      getGitPushRecord: vi.fn().mockResolvedValue(PUSH_RECORD),
      requestGitPushApproval: vi.fn().mockResolvedValue(PUSH_APPROVAL),
      executeGitPush: vi.fn().mockResolvedValue(PUSH_RECORD),
      setDefault: vi.fn(),
      ...overrides.repositories,
    },
  } as unknown as CoreClient;
}

/** Enters one exact versioned Git push target in the live Repositories form. */
async function enterPushTarget(user: ReturnType<typeof userEvent.setup>) {
  for (const [name, value] of [
    ['Thread ID', PUSH_TARGET.threadId],
    ['Turn ID', PUSH_TARGET.turnId],
    ['Source ref', PUSH_TARGET.sourceRef],
    ['Target branch', PUSH_TARGET.targetBranch],
    ['Commit IDs', PUSH_TARGET.commitIds.join(' ')],
  ] as const) {
    const input = screen.getByRole('textbox', { name });
    await user.clear(input);
    await user.type(input, value);
  }
}

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
  return client;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Overview / Action Center (board 07)', () => {
  it('shows a loading skeleton while Needs-you rows load', async () => {
    const client = makeClient({
      actionCenter: {
        listHumanAttention: vi.fn().mockReturnValue(new Promise(() => {})),
      },
    });
    renderApp('/', client);
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows the empty "caught up" state when nothing needs you', async () => {
    renderApp('/', makeClient());
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it('renders Needs-you rows longest-waiting first and decides approvals inline', async () => {
    const user = userEvent.setup();
    const respondApproval = vi.fn().mockResolvedValue({});
    const listHumanAttention = vi.fn().mockResolvedValue({
      items: [OPEN_ONLY_ROW, APPROVAL_ROW],
    });
    const client = makeClient({
      core: { respondApproval },
      actionCenter: { listHumanAttention },
    });
    renderApp('/', client);

    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    expect(screen.getByText('Answer required')).toBeInTheDocument();

    const titles = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    expect(titles[0]).toBe('Scout asks to sign in to the vendor portal');
    expect(titles[1]).toBe('Answer required');

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(respondApproval).toHaveBeenCalledWith('ap1', {
        workspaceId: 'ws1',
        threadId: 'th1',
        turnId: 't1',
        decision: 'granted',
      })
    );
  });

  it('shows an Open link when a row cannot be decided inline', async () => {
    const client = makeClient({
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({ items: [OPEN_ONLY_ROW] }),
      },
    });
    renderApp('/', client);
    expect(await screen.findByText('Answer required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open thread' })).toHaveAttribute('href', '/chat/th2');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows an error banner with retry when the queue fails', async () => {
    const user = userEvent.setup();
    const listHumanAttention = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ items: [] });
    const client = makeClient({ actionCenter: { listHumanAttention } });
    renderApp('/', client);
    expect(await screen.findByText(/Couldn't load what needs you/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(2));
  });

  it('disables inline actions and marks counts stale when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({ items: [APPROVAL_ROW] }),
      },
    });
    renderApp('/', client);
    expect(
      await screen.findByText('Scout asks to sign in to the vendor portal')
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
      },
      { timeout: 3000 }
    );
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });
});

describe('Agents (board 08)', () => {
  it('lists agents with plain-language readiness', async () => {
    const client = makeClient({
      agents: {
        list: vi.fn().mockResolvedValue({ items: [AGENT_READY, AGENT_WORKING] }),
      },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('reveals diagnostics behind View details', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      agents: { list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    const details = screen.getByText('View details').closest('details');
    expect(details).toBeTruthy();
    expect(details).not.toHaveAttribute('open');
    await user.click(within(details as HTMLElement).getByText('View details'));
    expect(details).toHaveAttribute('open');
    expect(within(details as HTMLElement).getByText(/gpt-test/i)).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText(/Healthy/i)).toBeInTheDocument();
  });

  it('shows the empty state when no agents are configured', async () => {
    renderApp('/agents', makeClient());
    expect(await screen.findByText(/No agents yet/i)).toBeInTheDocument();
  });

  it('marks readiness stale when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      agents: { list: vi.fn().mockResolvedValue({ items: [AGENT_READY] }) },
    });
    renderApp('/agents', client);
    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/stale/i)).toBeInTheDocument(), {
      timeout: 3000,
    });
  });
});

describe('Knowledge (board 14)', () => {
  it('lists knowledge entries', async () => {
    const client = makeClient({
      core: { listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }) },
    });
    renderApp('/knowledge', client);
    expect(await screen.findByText('Write in English; keep answers concise')).toBeInTheDocument();
  });

  it('shows the empty state when there are no entries', async () => {
    renderApp('/knowledge', makeClient());
    expect(await screen.findByText(/No entries yet/i)).toBeInTheDocument();
  });

  it('creates a knowledge entry from the add form', async () => {
    const user = userEvent.setup();
    const createKnowledge = vi.fn().mockResolvedValue(KNOWLEDGE_ENTRY);
    const client = makeClient({ core: { createKnowledge } });
    renderApp('/knowledge', client);
    await screen.findByText(/No entries yet/i);
    await user.click(screen.getByRole('button', { name: /Add knowledge/i }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Prefer concise memos');
    await user.type(screen.getByRole('textbox', { name: 'Content' }), 'Keep it short.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(createKnowledge).toHaveBeenCalledWith(
        'ws1',
        expect.objectContaining({
          kind: 'preference',
          title: 'Prefer concise memos',
          content: 'Keep it short.',
        })
      )
    );
  });

  it('disables save when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
    });
    renderApp('/knowledge', client);
    await waitFor(
      () => expect(screen.getByRole('button', { name: /Add knowledge/i })).toBeDisabled(),
      {
        timeout: 3000,
      }
    );
  });

  it('edits exact server bytes, submits only changed non-empty fields, and waits for the authoritative refetch', async () => {
    const user = userEvent.setup();
    const authoritativeRead = createDeferred<{ items: (typeof KNOWLEDGE_ENTRY)[] }>();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockReturnValueOnce(authoritativeRead.promise);
    const updateKnowledge = vi.fn().mockResolvedValue({
      ...KNOWLEDGE_ENTRY,
      title: 'Mutation response must not become visible',
    });
    renderApp('/knowledge', makeClient({ core: { listKnowledge, updateKnowledge } }));

    await user.click(await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    const content = screen.getByRole('textbox', { name: 'Content' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(title).toHaveValue(KNOWLEDGE_ENTRY.title);
    expect(content).toHaveValue(KNOWLEDGE_ENTRY.content);
    expect(save).toBeDisabled();

    await user.clear(title);
    await user.type(title, '   ');
    expect(save).toBeDisabled();
    await user.clear(title);
    await user.type(title, 'Prefer concise release notes');
    await user.click(save);

    await waitFor(() =>
      expect(updateKnowledge).toHaveBeenCalledWith('ws1', KNOWLEDGE_ENTRY.id, {
        requestId: expect.any(String),
        title: 'Prefer concise release notes',
      })
    );
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.queryByText('Mutation response must not become visible')).not.toBeInTheDocument();

    authoritativeRead.resolve({ items: [UPDATED_KNOWLEDGE_ENTRY] });
    expect(await screen.findByText(UPDATED_KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(UPDATED_KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
  });

  it('preserves authoritative whitespace and submits only the field the user changed', async () => {
    const user = userEvent.setup();
    const entry = {
      ...KNOWLEDGE_ENTRY,
      title: '  Exact server title  ',
      content: '  Exact server content  ',
    };
    const updateKnowledge = vi.fn().mockResolvedValue(entry);
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          listKnowledge: vi.fn().mockResolvedValue({ items: [entry] }),
          updateKnowledge,
        },
      })
    );

    await user.click(await screen.findByRole('button', { name: /Edit Exact server title/i }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    const content = screen.getByRole('textbox', { name: 'Content' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(title).toHaveValue(entry.title);
    expect(content).toHaveValue(entry.content);
    expect(save).toBeDisabled();

    await user.clear(content);
    await user.type(content, 'Changed server content');
    await user.click(save);
    await waitFor(() =>
      expect(updateKnowledge).toHaveBeenCalledWith('ws1', entry.id, {
        content: 'Changed server content',
        requestId: expect.any(String),
      })
    );
  });

  it('keeps update intent and cached bytes until a failed authoritative refetch is retried', async () => {
    const user = userEvent.setup();
    const mutationResponse = {
      ...KNOWLEDGE_ENTRY,
      title: 'Mutation response is not display authority',
      content: 'Mutation response content',
    };
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockRejectedValueOnce(new Error('authoritative read failed'))
      .mockResolvedValueOnce({ items: [UPDATED_KNOWLEDGE_ENTRY] });
    const updateKnowledge = vi.fn().mockResolvedValue(mutationResponse);
    renderApp('/knowledge', makeClient({ core: { listKnowledge, updateKnowledge } }));

    await user.click(await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const content = screen.getByRole('textbox', { name: 'Content' });
    await user.clear(content);
    await user.type(content, 'Unsaved local content');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load knowledge.");
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(screen.queryByText(mutationResponse.title)).not.toBeInTheDocument();
    expect(screen.queryByText(mutationResponse.content)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Content' })).toHaveValue('Unsaved local content');
    expect(updateKnowledge).toHaveBeenCalledTimes(1);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(3));
    expect(updateKnowledge).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(UPDATED_KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(UPDATED_KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Content' })).not.toBeInTheDocument();
  });

  it('confirms removal and keeps the row until the authoritative refetch removes it', async () => {
    const user = userEvent.setup();
    const authoritativeRead = createDeferred<{ items: (typeof KNOWLEDGE_ENTRY)[] }>();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockReturnValueOnce(authoritativeRead.promise);
    const deleteKnowledge = vi.fn().mockResolvedValue(undefined);
    renderApp('/knowledge', makeClient({ core: { deleteKnowledge, listKnowledge } }));

    await user.click(
      await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove knowledge' });
    expect(deleteKnowledge).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(deleteKnowledge).toHaveBeenCalledWith('ws1', KNOWLEDGE_ENTRY.id, {
        requestId: expect.any(String),
      })
    );
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    authoritativeRead.resolve({ items: [] });
    await waitFor(() => expect(screen.queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument());
  });

  it('keeps a deleted row until a failed authoritative refetch is retried successfully', async () => {
    const user = userEvent.setup();
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_ENTRY] })
      .mockRejectedValueOnce(new Error('authoritative read failed'))
      .mockResolvedValueOnce({ items: [] });
    const deleteKnowledge = vi.fn().mockResolvedValue(undefined);
    renderApp('/knowledge', makeClient({ core: { deleteKnowledge, listKnowledge } }));

    await user.click(
      await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
    );
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole('button', {
        name: 'Remove',
      })
    );
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load knowledge.");
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(3));
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(KNOWLEDGE_ENTRY.title)).not.toBeInTheDocument());
  });

  it.each([
    'update',
    'delete',
  ] as const)('keeps authoritative entry bytes and an explicit retry after a failed %s', async (operation) => {
    const user = userEvent.setup();
    const mutation = vi.fn().mockRejectedValue(new Error(`${operation} failed`));
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          [operation === 'update' ? 'updateKnowledge' : 'deleteKnowledge']: mutation,
        },
      })
    );

    if (operation === 'update') {
      await user.click(
        await screen.findByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` })
      );
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.type(title, 'Unsaved local wording');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
    } else {
      await user.click(
        await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
      );
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't|failed/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.getByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_ENTRY.content)).toBeInTheDocument();
    expect(mutation).toHaveBeenCalledTimes(1);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
  });

  it('blocks a failed mutation retry while a different Knowledge mutation is pending', async () => {
    const user = userEvent.setup();
    const deleteKnowledge = vi.fn().mockRejectedValue(new Error('delete failed'));
    const pendingUpdate = createDeferred<unknown>();
    const updateKnowledge = vi.fn().mockReturnValue(pendingUpdate.promise);
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          deleteKnowledge,
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          updateKnowledge,
        },
      })
    );

    await user.click(
      await screen.findByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` })
    );
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole('button', {
        name: 'Remove',
      })
    );
    const retry = within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    });
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
    const content = screen.getByRole('textbox', { name: 'Content' });
    await user.clear(content);
    await user.type(content, 'Pending content change');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateKnowledge).toHaveBeenCalledTimes(1));

    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(deleteKnowledge).toHaveBeenCalledTimes(1);
  });

  it.each([
    'checking',
    'failed',
  ] as const)('disables every exposed Knowledge write while the connection is %s', async (connection) => {
    const meta =
      connection === 'checking'
        ? vi.fn().mockReturnValue(new Promise(() => {}))
        : vi.fn().mockRejectedValue(new Error('offline'));
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          meta,
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
        },
      })
    );

    await screen.findByText(KNOWLEDGE_ENTRY.title);
    const writes = screen
      .getAllByRole('button')
      .filter((button) => /^(Add knowledge|Edit |Remove )/.test(button.textContent ?? ''));
    expect(writes).toHaveLength(3);
    for (const write of writes) expect(write).toBeDisabled();
  });

  it.each([
    'create',
    'update',
    'delete',
  ] as const)('disables all Knowledge writes while a %s mutation is pending', async (operation) => {
    const user = userEvent.setup();
    const pending = createDeferred<unknown>();
    renderApp(
      '/knowledge',
      makeClient({
        core: {
          listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }),
          [`${operation}Knowledge`]: vi.fn().mockReturnValue(pending.promise),
        },
      })
    );

    await screen.findByText(KNOWLEDGE_ENTRY.title);
    if (operation === 'create') {
      await user.click(screen.getByRole('button', { name: 'Add knowledge' }));
      await user.type(screen.getByRole('textbox', { name: 'Title' }), 'New preference');
      await user.type(screen.getByRole('textbox', { name: 'Content' }), 'New content');
      await user.click(screen.getByRole('button', { name: 'Save' }));
    } else if (operation === 'update') {
      await user.click(screen.getByRole('button', { name: `Edit ${KNOWLEDGE_ENTRY.title}` }));
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.clear(title);
      await user.type(title, 'Changed preference');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
    } else {
      await user.click(screen.getByRole('button', { name: `Remove ${KNOWLEDGE_ENTRY.title}` }));
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Remove knowledge' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }

    const writes = screen
      .getAllByRole('button')
      .filter((button) => /^(Add knowledge|Edit |Remove|Save)/.test(button.textContent ?? ''));
    expect(writes.length).toBeGreaterThan(1);
    for (const write of writes) expect(write).toBeDisabled();
  });

  it('reads and renders the bounded live Source, Observation, and Claim projections', async () => {
    const listKnowledgeSources = vi.fn().mockResolvedValue({ items: [KNOWLEDGE_SOURCE] });
    const listKnowledgeObservations = vi.fn().mockResolvedValue({ items: [KNOWLEDGE_OBSERVATION] });
    const listKnowledgeClaims = vi.fn().mockResolvedValue({ items: [KNOWLEDGE_CLAIM] });
    renderApp(
      '/knowledge',
      makeClient({
        app: { listKnowledgeClaims, listKnowledgeObservations, listKnowledgeSources },
      })
    );

    expect(await screen.findByText(KNOWLEDGE_SOURCE.title)).toBeInTheDocument();
    expect(screen.getByText('Transcript')).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_OBSERVATION.summary)).toBeInTheDocument();
    expect(screen.getByText('Retained')).toBeInTheDocument();
    expect(screen.getByText(KNOWLEDGE_CLAIM.statement)).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toHaveClass('bg-notice-bg', 'text-notice-fg');
    expect(screen.getByText('Weak evidence')).toBeInTheDocument();
    const statusBackgroundClasses = [
      'bg-info-bg',
      'bg-notice-bg',
      'bg-positive-bg',
      'bg-negative-bg',
      'bg-neutral-bg',
    ];
    for (const label of ['Transcript', 'Retained', 'Weak evidence']) {
      const metadata = screen.getByText(label);
      for (const statusClass of statusBackgroundClasses) {
        expect(metadata).not.toHaveClass(statusClass);
      }
    }
    for (const rawValue of ['transcript', 'retained', 'needs-review', 'weak_evidence']) {
      expect(document.body).not.toHaveTextContent(rawValue);
    }
    expect(listKnowledgeSources).toHaveBeenCalledWith('ws1');
    expect(listKnowledgeObservations).toHaveBeenCalledWith('ws1');
    expect(listKnowledgeClaims).toHaveBeenCalledWith('ws1');
  });

  it('keeps a Loading skeleton visible until the attention read settles', async () => {
    const attentionRead = createDeferred<{ items: [] }>();
    renderApp(
      '/knowledge',
      makeClient({
        core: { listKnowledge: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_ENTRY] }) },
        actionCenter: { listHumanAttention: vi.fn().mockReturnValue(attentionRead.promise) },
      })
    );

    expect(await screen.findByText(KNOWLEDGE_ENTRY.title)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();

    attentionRead.resolve({ items: [] });
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument()
    );
  });

  it('leaves a failed bounded Store read retryable', async () => {
    const user = userEvent.setup();
    const listKnowledgeSources = vi
      .fn()
      .mockRejectedValueOnce(new Error('source read failed'))
      .mockResolvedValue({ items: [] });
    renderApp('/knowledge', makeClient({ app: { listKnowledgeSources } }));

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listKnowledgeSources).toHaveBeenCalledTimes(2));
  });

  it('retries only the failed initial attention read', async () => {
    const user = userEvent.setup();
    const listHumanAttention = vi
      .fn()
      .mockRejectedValueOnce(new Error('attention read failed'))
      .mockResolvedValue({ items: [] });
    const listKnowledgeSources = vi.fn().mockResolvedValue({ items: [] });
    const listKnowledgeObservations = vi.fn().mockResolvedValue({ items: [] });
    const listKnowledgeClaims = vi.fn().mockResolvedValue({ items: [] });
    const submitKnowledgeProposalDecision = vi.fn();
    renderApp(
      '/knowledge',
      makeClient({
        actionCenter: { listHumanAttention },
        app: {
          listKnowledgeClaims,
          listKnowledgeObservations,
          listKnowledgeSources,
          submitKnowledgeProposalDecision,
        },
      })
    );

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(2));
    expect(listKnowledgeSources).toHaveBeenCalledTimes(1);
    expect(listKnowledgeObservations).toHaveBeenCalledTimes(1);
    expect(listKnowledgeClaims).toHaveBeenCalledTimes(1);
    expect(submitKnowledgeProposalDecision).not.toHaveBeenCalled();
  });

  it.each([
    ['Accept', 'accept_knowledge', 'accepted'],
    ['Reject', 'reject_knowledge', 'rejected'],
    ['Defer', 'defer', 'deferred'],
  ] as const)('maps only the exact %s action from the Knowledge attention row', async (label, actionKind, decision) => {
    const user = userEvent.setup();
    const submitKnowledgeProposalDecision = vi.fn().mockResolvedValue({});
    const row = {
      ...KNOWLEDGE_PROPOSAL_ROW,
      actions: [{ kind: actionKind, label, method: 'POST' }],
    };
    renderApp(
      '/knowledge',
      makeClient({
        actionCenter: {
          listHumanAttention: vi
            .fn()
            .mockResolvedValue({ items: [NON_KNOWLEDGE_PROPOSAL_DECOY, row] }),
        },
        app: { submitKnowledgeProposalDecision },
      })
    );

    const action = await screen.findByRole('button', { name: label });
    for (const absentLabel of ['Accept', 'Reject', 'Defer'].filter((item) => item !== label)) {
      expect(screen.queryByRole('button', { name: absentLabel })).not.toBeInTheDocument();
    }
    await user.click(action);
    await waitFor(() =>
      expect(submitKnowledgeProposalDecision).toHaveBeenCalledWith('ws1', 'kp_exact', {
        decision,
        requestId: expect.any(String),
      })
    );
    expect(screen.queryByText(NON_KNOWLEDGE_PROPOSAL_DECOY.title)).not.toBeInTheDocument();
  });

  it('omits unsupported proposal actions and exposes the disabled action reason', async () => {
    const user = userEvent.setup();
    const submitKnowledgeProposalDecision = vi.fn();
    const reason = 'The proposal is not ready for acceptance.';
    const row = {
      ...KNOWLEDGE_PROPOSAL_ROW,
      actions: [
        {
          kind: 'accept_knowledge',
          label: 'Accept',
          method: 'POST',
          disabled: true,
          reason,
        },
        { kind: 'open_thread', label: 'Unsupported proposal action', method: 'GET' },
      ],
    };
    renderApp(
      '/knowledge',
      makeClient({
        actionCenter: { listHumanAttention: vi.fn().mockResolvedValue({ items: [row] }) },
        app: { submitKnowledgeProposalDecision },
      })
    );

    const accept = await screen.findByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Unsupported proposal action' })
    ).not.toBeInTheDocument();
    await user.click(accept);
    expect(submitKnowledgeProposalDecision).not.toHaveBeenCalled();
  });

  it('keeps proposal visibility authoritative until attention refetch settles', async () => {
    const user = userEvent.setup();
    const authoritativeRead = createDeferred<{ items: (typeof KNOWLEDGE_PROPOSAL_ROW)[] }>();
    const successfulRead = createDeferred<{ items: (typeof KNOWLEDGE_PROPOSAL_ROW)[] }>();
    const listHumanAttention = vi
      .fn()
      .mockResolvedValueOnce({ items: [KNOWLEDGE_PROPOSAL_ROW] })
      .mockReturnValueOnce(authoritativeRead.promise)
      .mockReturnValueOnce(successfulRead.promise);
    const decisionPost = createDeferred<unknown>();
    const submitKnowledgeProposalDecision = vi.fn().mockReturnValue(decisionPost.promise);
    renderApp(
      '/knowledge',
      makeClient({
        actionCenter: { listHumanAttention },
        app: { submitKnowledgeProposalDecision },
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1));
    for (const label of ['Accept', 'Reject', 'Defer']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);

    decisionPost.resolve({ review: { decision: 'accepted' } });
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(2));
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    for (const label of ['Accept', 'Reject', 'Defer']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }

    authoritativeRead.reject(new Error('authoritative attention refetch failed'));
    const alert = await screen.findByRole('alert');
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledTimes(3));
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();

    successfulRead.resolve({ items: [] });
    await waitFor(() =>
      expect(screen.queryByText(KNOWLEDGE_PROPOSAL_ROW.title)).not.toBeInTheDocument()
    );
  });

  it('preserves a failed proposal row for explicit fresh-request retry without replay', async () => {
    const user = userEvent.setup();
    const submitKnowledgeProposalDecision = vi.fn().mockRejectedValue(new Error('decision failed'));
    renderApp(
      '/knowledge',
      makeClient({
        actionCenter: {
          listHumanAttention: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_PROPOSAL_ROW] }),
        },
        app: { submitKnowledgeProposalDecision },
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const alert = await screen.findByRole('alert');
    expect(screen.getByText(KNOWLEDGE_PROPOSAL_ROW.title)).toBeInTheDocument();
    expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(1);
    const firstRequestId = submitKnowledgeProposalDecision.mock.calls[0]?.[2].requestId;

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(submitKnowledgeProposalDecision).toHaveBeenCalledTimes(2));
    expect(submitKnowledgeProposalDecision.mock.calls[1]?.[2].requestId).not.toBe(firstRequestId);
  });

  it.each([
    'checking',
    'failed',
  ] as const)('disables proposal decisions while the connection is %s', async (connection) => {
    const meta =
      connection === 'checking'
        ? vi.fn().mockReturnValue(new Promise(() => {}))
        : vi.fn().mockRejectedValue(new Error('offline'));
    renderApp(
      '/knowledge',
      makeClient({
        core: { meta },
        actionCenter: {
          listHumanAttention: vi.fn().mockResolvedValue({ items: [KNOWLEDGE_PROPOSAL_ROW] }),
        },
      })
    );

    await screen.findByText(KNOWLEDGE_PROPOSAL_ROW.title);
    await waitFor(() => {
      for (const label of ['Accept', 'Reject', 'Defer']) {
        expect(screen.getByRole('button', { name: label })).toBeDisabled();
      }
    });
  });
});

describe('Repositories (board 19)', () => {
  it('validates the selected Workspace before the exact live reads and keeps the default repository command bounded', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws_stale' });
    const listWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace-private failure'))
      .mockResolvedValue({ items: [{ id: 'ws1', name: 'Market research' }] });
    const client = makeClient({ core: { listWorkspaces } });
    renderApp('/repositories', client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load workspaces/i);
    expect(alert).not.toHaveTextContent('workspace-private failure');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Repositories' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    expect(screen.getByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    expect(screen.getByText(REPOSITORY_DIAGNOSTIC.summary)).toBeInTheDocument();
    expect(screen.getByText('Pushed', { exact: true })).toBeInTheDocument();

    const validatedAt = listWorkspaces.mock.invocationCallOrder[1];
    expect({
      resources: {
        calls: vi.mocked(client.repositories.list).mock.calls,
        afterValidation:
          vi.mocked(client.repositories.list).mock.invocationCallOrder[0] > validatedAt,
      },
      diagnostics: {
        calls: vi.mocked(client.repositories.diagnostics).mock.calls,
        afterValidation:
          vi.mocked(client.repositories.diagnostics).mock.invocationCallOrder[0] > validatedAt,
      },
      records: {
        calls: vi.mocked(client.repositories.listGitPushRecords).mock.calls,
        afterValidation:
          vi.mocked(client.repositories.listGitPushRecords).mock.invocationCallOrder[0] >
          validatedAt,
      },
      record: vi.mocked(client.repositories.getGitPushRecord).mock.calls,
    }).toEqual({
      resources: { calls: [['ws1']], afterValidation: true },
      diagnostics: { calls: [['ws1']], afterValidation: true },
      records: { calls: [['ws1']], afterValidation: true },
      record: [],
    });
    expect(client.repositories.setDefault).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: /set default|link repository/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/changes waiting to apply/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|review changes/i })).not.toBeInTheDocument();
  });

  it('shows content-shaped loading while repository resources, diagnostics, and records are pending', async () => {
    const pending = new Promise(() => {});
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          list: vi.fn().mockReturnValue(pending),
          diagnostics: vi.fn().mockReturnValue(pending),
          listGitPushRecords: vi.fn().mockReturnValue(pending),
        },
      })
    );

    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('shows explicit empty states for repository resources, diagnostics, and push records', async () => {
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          list: vi.fn().mockResolvedValue({
            items: [],
            defaultResourceId: null,
            defaultResource: null,
          }),
          diagnostics: vi.fn().mockResolvedValue({
            workspaceId: 'ws1',
            defaultResourceId: null,
            defaultResource: null,
            resources: [],
          }),
          listGitPushRecords: vi.fn().mockResolvedValue({ items: [] }),
        },
      })
    );

    expect(await screen.findByText('No linked repositories', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No repository diagnostics', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('No push records', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request approval' })).not.toBeInTheDocument();
  });

  it('shows one plain error and retries repository reads without invoking a mutation', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('repository-private failure'))
      .mockResolvedValue({
        items: [REPOSITORY_RESOURCE],
        defaultResourceId: REPOSITORY_RESOURCE.resourceId,
        defaultResource: REPOSITORY_RESOURCE,
      });
    const requestGitPushApproval = vi.fn();
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({ repositories: { executeGitPush, list, requestGitPushApproval } })
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load repositories/i);
    expect(alert).not.toHaveTextContent('repository-private failure');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    expect(requestGitPushApproval).not.toHaveBeenCalled();
    expect(executeGitPush).not.toHaveBeenCalled();
  });

  it('replays the exact pending approval request after an external grant and executes only after the authoritative granted response', async () => {
    const user = userEvent.setup();
    const recordRead = createDeferred<typeof PUSH_RECORD>();
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [] });
    const getGitPushRecord = vi.fn().mockReturnValue(recordRead.promise);
    let authoritativeApproval: typeof PENDING_PUSH_APPROVAL | typeof PUSH_APPROVAL =
      PENDING_PUSH_APPROVAL;
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn().mockResolvedValue(PUSH_RECORD);
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(1));
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Awaiting approval', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();

    authoritativeApproval = PUSH_APPROVAL;
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Approved', { exact: true })).toBeInTheDocument();
    const execute = await screen.findByRole('button', { name: 'Execute push' });
    expect(executeGitPush).not.toHaveBeenCalled();
    await user.click(execute);

    await waitFor(() => expect(executeGitPush).toHaveBeenCalledTimes(1));
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    await waitFor(() => expect(getGitPushRecord.mock.calls).toEqual([['ws1', PUSH_RECORD.id]]));
    expect(screen.queryByText('Pushed', { exact: true })).not.toBeInTheDocument();

    recordRead.resolve(PUSH_RECORD);
    expect(await screen.findByText('Pushed', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(4));
  });

  it('replaces a stale same-id list row with the exact authoritative record after execution', async () => {
    const user = userEvent.setup();
    const staleRecord = {
      ...PUSH_RECORD,
      remoteSummary: 'Stale same-id push record',
      sourceRef: 'refs/heads/stale',
      commitIds: ['stale123'],
      outcome: 'auth-failed' as const,
      errorSummary: 'Stale list projection',
    };
    const newerRecord = {
      ...PUSH_RECORD,
      id: 'gpr_newer',
      approvalRowId: 'it_newer_push_approval',
      remoteSummary: 'Concurrent newer push record',
      sourceRef: 'refs/heads/newer',
      commitIds: ['newer123'],
      outcome: 'refused-policy' as const,
      errorSummary: 'Newer refusal',
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z',
    };
    const olderRecord = {
      ...PUSH_RECORD,
      id: 'gpr_older',
      approvalRowId: 'it_older_push_approval',
      remoteSummary: 'Distinct older push record',
      sourceRef: 'refs/heads/older',
      commitIds: ['older123'],
      outcome: 'remote-unreachable' as const,
      errorSummary: 'Older remote failure',
      createdAt: TIMESTAMP_OLD,
      updatedAt: TIMESTAMP_OLD,
    };
    const listGitPushRecords = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [newerRecord, staleRecord, olderRecord] });
    const requestGitPushApproval = vi.fn().mockResolvedValue(PUSH_APPROVAL);
    const executeGitPush = vi.fn().mockResolvedValue(PUSH_RECORD);
    const getGitPushRecord = vi.fn().mockResolvedValue(PUSH_RECORD);
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await user.click(await screen.findByRole('button', { name: 'Execute push' }));

    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.queryAllByText(PUSH_RECORD.remoteSummary, { exact: true })).toHaveLength(1)
    );
    expect(
      screen.getAllByText(
        `${PUSH_TARGET.sourceRef} to ${PUSH_TARGET.targetBranch} · ${PUSH_TARGET.commitIds.join(', ')}`,
        { exact: true }
      )
    ).toHaveLength(1);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    expect(screen.queryByText(staleRecord.remoteSummary, { exact: true })).not.toBeInTheDocument();
    const pushRecords = screen.getByText('Push records', { exact: true }).closest('section');
    expect(pushRecords).not.toBeNull();
    const expectedOrder: string[] = [
      newerRecord.remoteSummary,
      PUSH_RECORD.remoteSummary,
      olderRecord.remoteSummary,
    ];
    expect(
      within(pushRecords as HTMLElement)
        .getAllByText((content) => expectedOrder.includes(content))
        .map((element) => element.textContent)
    ).toEqual(expectedOrder);
    expect(screen.queryByText('Recovery required', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    expect(getGitPushRecord.mock.calls).toEqual([['ws1', PUSH_RECORD.id]]);
    expect(listGitPushRecords.mock.calls).toEqual([['ws1'], ['ws1'], ['ws1']]);
  });

  it('preserves refetched records and requires recovery for a mismatching authoritative record', async () => {
    const user = userEvent.setup();
    const refetchedRecord = {
      ...PUSH_RECORD,
      approvalRowId: 'it_previous_push_approval',
      remoteSummary: 'Preserved refetched push record',
    };
    const mismatchingRecord = {
      ...PUSH_RECORD,
      repositoryResourceId: 'repo_other',
      remoteSummary: 'Mismatching authoritative push record',
    };
    const listGitPushRecords = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [refetchedRecord] });
    const requestGitPushApproval = vi.fn().mockResolvedValue(PUSH_APPROVAL);
    const executeGitPush = vi.fn().mockResolvedValue(PUSH_RECORD);
    const getGitPushRecord = vi.fn().mockResolvedValue(mismatchingRecord);
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await user.click(await screen.findByRole('button', { name: 'Execute push' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Recovery required', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(refetchedRecord.remoteSummary, { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByText(mismatchingRecord.remoteSummary, { exact: true })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    expect(getGitPushRecord.mock.calls).toEqual([['ws1', PUSH_RECORD.id]]);
    expect(listGitPushRecords.mock.calls).toEqual([['ws1'], ['ws1'], ['ws1']]);
  });

  it.each([
    ['matching terminal tuple', PUSH_RECORD, false],
    ['no terminal record', null, true],
    ['workspace mismatch', { ...PUSH_RECORD, workspaceId: 'ws_other' }, true],
    ['repository mismatch', { ...PUSH_RECORD, repositoryResourceId: 'repo_other' }, true],
    ['approval item mismatch', { ...PUSH_RECORD, approvalRowId: 'it_other' }, true],
    ['policy decision mismatch', { ...PUSH_RECORD, policyDecisionId: 'pd_other' }, true],
    ['source ref mismatch', { ...PUSH_RECORD, sourceRef: 'refs/heads/other' }, true],
    ['target branch mismatch', { ...PUSH_RECORD, targetBranch: 'release' }, true],
    [
      'commit cardinality mismatch',
      { ...PUSH_RECORD, commitIds: [PUSH_TARGET.commitIds[0]] },
      true,
    ],
    [
      'ordered commit mismatch',
      { ...PUSH_RECORD, commitIds: [...PUSH_TARGET.commitIds].reverse() },
      true,
    ],
  ] as const)('requires the exact consumed-record tuple for %s', async (_case, terminalRecord, executeVisible) => {
    const user = userEvent.setup();
    const listGitPushRecords = vi
      .fn()
      .mockResolvedValue({ items: terminalRecord ? [terminalRecord] : [] });
    let authoritativeApproval: typeof PENDING_PUSH_APPROVAL | typeof PUSH_APPROVAL =
      PENDING_PUSH_APPROVAL;
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn();
    const getGitPushRecord = vi.fn();
    renderApp(
      '/repositories',
      makeClient({
        repositories: {
          executeGitPush,
          getGitPushRecord,
          listGitPushRecords,
          requestGitPushApproval,
        },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    authoritativeApproval = PUSH_APPROVAL;
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Approved', { exact: true })).toBeInTheDocument();
    if (executeVisible) {
      expect(await screen.findByRole('button', { name: 'Execute push' })).toBeEnabled();
    } else {
      expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    }
    expect(executeGitPush).not.toHaveBeenCalled();
    expect(getGitPushRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', 'Denied'],
    ['expired', 'Expired'],
    ['superseded', 'Superseded'],
    ['withdrawn', 'Withdrawn'],
  ] as const)('shows the fixed %s terminal state without execute', async (status, label) => {
    const user = userEvent.setup();
    let authoritativeApproval: unknown = PENDING_PUSH_APPROVAL;
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [] });
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({
        repositories: { executeGitPush, listGitPushRecords, requestGitPushApproval },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;

    authoritativeApproval = {
      ...PUSH_APPROVAL,
      approval: { ...PUSH_APPROVAL.approval, status },
    };
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls[1]).toEqual([
      'ws1',
      REPOSITORY_RESOURCE.resourceId,
      { requestId: approvalRequestId, ...PUSH_TARGET },
    ]);
    expect(await screen.findByText(label, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();
  });

  it.each([
    { workspaceId: 'ws_other' },
    { threadId: 'th_other' },
    { turnId: 'tu_other' },
  ] as const)('does not expose execute for mismatched granted authority %#', async (mismatch) => {
    const user = userEvent.setup();
    let authoritativeApproval: unknown = PENDING_PUSH_APPROVAL;
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({ repositories: { executeGitPush, requestGitPushApproval } })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    authoritativeApproval = {
      ...PUSH_APPROVAL,
      approval: { ...PUSH_APPROVAL.approval, ...mismatch },
    };
    await user.click(screen.getByRole('button', { name: 'Check approval' }));

    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(2));
    expect(requestGitPushApproval.mock.calls[1]).toEqual([
      'ws1',
      REPOSITORY_RESOURCE.resourceId,
      { requestId: approvalRequestId, ...PUSH_TARGET },
    ]);
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();
  });

  it.each([
    ['idempotency_key_conflict', 'Request conflict'],
    ['recovery_required', 'Recovery required'],
  ] as const)('retains repository state for typed approval %s without replaying the request', async (code, label) => {
    const user = userEvent.setup();
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [PUSH_RECORD] });
    const requestGitPushApproval = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'Approval command rejected.', { code }));
    const executeGitPush = vi.fn();
    renderApp(
      '/repositories',
      makeClient({
        repositories: { executeGitPush, listGitPushRecords, requestGitPushApproval },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(label, { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(requestGitPushApproval).toHaveBeenCalledTimes(1));
    const requestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId, ...PUSH_TARGET }],
    ]);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();
    expect(executeGitPush).not.toHaveBeenCalled();

    const readsBeforeRetry = listGitPushRecords.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(readsBeforeRetry + 1));
    expect(requestGitPushApproval).toHaveBeenCalledTimes(1);
    expect(executeGitPush).not.toHaveBeenCalled();
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
  });

  it.each([
    ['idempotency_key_conflict', 'Request conflict'],
    ['recovery_required', 'Recovery required'],
  ] as const)('retains repository state for typed execute %s without replaying either mutation', async (code, label) => {
    const user = userEvent.setup();
    let authoritativeApproval: typeof PENDING_PUSH_APPROVAL | typeof PUSH_APPROVAL =
      PENDING_PUSH_APPROVAL;
    const priorPushRecord = {
      ...PUSH_RECORD,
      approvalRowId: 'it_previous_push_approval',
    };
    const listGitPushRecords = vi.fn().mockResolvedValue({ items: [priorPushRecord] });
    const requestGitPushApproval = vi
      .fn()
      .mockImplementation(() => Promise.resolve(authoritativeApproval));
    const executeGitPush = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'Push command rejected.', { code }));
    renderApp(
      '/repositories',
      makeClient({
        repositories: { executeGitPush, listGitPushRecords, requestGitPushApproval },
      })
    );

    await screen.findByText(REPOSITORY_RESOURCE.displayName);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    await enterPushTarget(user);
    await user.click(screen.getByRole('button', { name: 'Request approval' }));
    await screen.findByText('Awaiting approval', { exact: true });
    const approvalRequestId = requestGitPushApproval.mock.calls[0]?.[2].requestId;
    expect(approvalRequestId).toEqual(expect.any(String));
    authoritativeApproval = PUSH_APPROVAL;
    await user.click(screen.getByRole('button', { name: 'Check approval' }));
    await user.click(await screen.findByRole('button', { name: 'Execute push' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(label, { exact: true })).toBeInTheDocument();
    expect(requestGitPushApproval.mock.calls).toEqual([
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
      ['ws1', REPOSITORY_RESOURCE.resourceId, { requestId: approvalRequestId, ...PUSH_TARGET }],
    ]);
    await waitFor(() => expect(executeGitPush).toHaveBeenCalledTimes(1));
    const executeRequestId = executeGitPush.mock.calls[0]?.[2].requestId;
    expect(executeRequestId).toEqual(expect.any(String));
    expect(executeRequestId).not.toBe(approvalRequestId);
    expect(executeGitPush.mock.calls).toEqual([
      [
        'ws1',
        REPOSITORY_RESOURCE.resourceId,
        { requestId: executeRequestId, approvalRequestId: PUSH_APPROVAL.approval.id },
      ],
    ]);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Execute push' })).not.toBeInTheDocument();

    const readsBeforeRetry = listGitPushRecords.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listGitPushRecords).toHaveBeenCalledTimes(readsBeforeRetry + 1));
    expect(requestGitPushApproval).toHaveBeenCalledTimes(2);
    expect(executeGitPush).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Pushed', { exact: true })).toHaveLength(1);
  });

  it('keeps repository records visible but disables push mutations while disconnected', async () => {
    const client = makeClient({ core: { meta: vi.fn().mockRejectedValue(new Error('down')) } });
    renderApp('/repositories', client);

    expect(await screen.findByText(REPOSITORY_RESOURCE.displayName)).toBeInTheDocument();
    expect(await screen.findByText('Status may be stale', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request approval' })).toBeDisabled();
    expect(client.repositories.requestGitPushApproval).not.toHaveBeenCalled();
    expect(client.repositories.executeGitPush).not.toHaveBeenCalled();
  });
});

describe('First run (board 18)', () => {
  it('shows a connect error with retry when the runtime is unreachable', async () => {
    const user = userEvent.setup();
    const meta = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({});
    const client = makeClient({
      core: {
        meta,
        listWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      },
    });
    renderApp('/first-run', client);
    await waitFor(
      () =>
        expect(screen.getAllByText(/Couldn't reach the local runtime/i).length).toBeGreaterThan(0),
      { timeout: 3000 }
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(meta.mock.calls.length).toBeGreaterThan(2));
  });

  it('shows welcome guidance when connected with no workspaces', async () => {
    const client = makeClient({
      core: { listWorkspaces: vi.fn().mockResolvedValue({ items: [] }) },
    });
    renderApp('/first-run', client);
    expect(await screen.findByText(/Your agent team/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create workspace/i })).toHaveAttribute(
      'href',
      '/workspaces/new'
    );
  });

  it('offers a calm ready path when a workspace already exists', async () => {
    renderApp('/first-run', makeClient());
    expect(await screen.findByText(/You're set/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Overview/i })).toHaveAttribute('href', '/');
  });
});

describe('New workspace (board 07)', () => {
  it('creates a workspace from the form', async () => {
    const user = userEvent.setup();
    const createWorkspace = vi.fn().mockResolvedValue({
      id: 'ws-new',
      name: 'Launch prep',
      kind: 'general',
      status: 'active',
      defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: TIMESTAMP_NEW,
      updatedAt: TIMESTAMP_NEW,
    });
    const client = makeClient({ core: { createWorkspace } });
    renderApp('/workspaces/new', client);
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Launch prep');
    await user.click(screen.getByRole('button', { name: /Create workspace/i }));
    await waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: 'Launch prep' }))
    );
  });
});
