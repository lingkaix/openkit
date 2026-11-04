import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';

const TIMESTAMP = '2026-07-21T12:00:00.000Z';
const WORKSPACE_ID = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';
const ACTOR_ID = 'usr_019a0000-0000-7000-8000-000000000015';
const THREAD_ID = 'th_019a0000-0000-7000-8000-000000000012';

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: 'Market research',
  kind: 'general',
  status: 'active',
  counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const META = {
  protocolVersion: '0.4.0',
  capabilities: [],
  eventFamilies: [],
};

const DENIED_AUDIT_EVENT = {
  id: 'aud_019a0000-0000-7000-8000-000000000015',
  workspaceId: WORKSPACE_ID,
  threadId: THREAD_ID,
  actor: { kind: 'user', id: ACTOR_ID },
  category: 'command',
  action: 'export.thread',
  resource: 'Launch notes',
  outcome: 'denied',
  severity: 'warning',
  summary: 'Export denied',
  createdAt: TIMESTAMP,
  occurredAt: TIMESTAMP,
};

const TASK_THREAD = {
  id: THREAD_ID,
  owner: { kind: 'workspace', workspaceId: WORKSPACE_ID },
  name: 'Launch notes',
  preview: 'Launch notes',
  status: 'active',
  entryPath: 'conversation',
  threadSource: 'conversation',
  visibility: 'workspace',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function admission() {
  return {
    membershipStatus: 'active' as const,
    accessCause: 'membership' as const,
    workspace: WORKSPACE,
    isOwner: true,
    membershipRevision: 1,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    registryRevision: 1,
  };
}

type OperationOverrides = Record<string, unknown>;

/** Build a fake CoreClient; per-test overrides replace individual operations. */
function makeClient(
  overrides: { operations?: OperationOverrides; core?: Record<string, unknown> } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue(META),
      listKnowledge: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.core,
    },
    app: {},
    auth: { email: { signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), getSession: vi.fn() } },
    capabilities: {
      refresh: vi.fn(),
      snapshot: vi.fn().mockReturnValue(META),
      supports: vi.fn().mockReturnValue(true),
      require: vi.fn(),
    },
    agents: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      get: vi.fn(),
      refreshHealth: vi.fn(),
    },
    repositories: {},
    operations: {
      'workspace.list': vi.fn().mockResolvedValue({ items: [admission()] }),
      'workspace.read': vi.fn().mockResolvedValue(WORKSPACE),
      'workspace.dashboard': vi.fn().mockResolvedValue({
        workspace: WORKSPACE,
        counts: WORKSPACE.counts,
        defaultContext: { agentId: null },
        agentHealth: [],
        recentThreads: [],
        activeWork: [],
        recentCompletions: [],
        attentionNeeded: [],
      }),
      'workspace.resources': vi.fn().mockResolvedValue({
        knowledge: [],
        skills: [],
        agents: [],
        models: [],
      }),
      'attention.list': vi.fn().mockResolvedValue({ items: [] }),
      'thread.list': vi.fn().mockResolvedValue({ items: [] }),
      'conversation.navigation': vi.fn().mockResolvedValue({
        items: [
          {
            thread: TASK_THREAD,
            activity: 'task',
            state: 'idle',
            lastActivityAt: TIMESTAMP,
            unreadCount: 0,
          },
        ],
      }),
      'usage.read': vi.fn().mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        capabilityCalls: [],
        usageRecords: [],
      }),
      'audit.workspace-list': vi.fn().mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        auditEvents: [DENIED_AUDIT_EVENT],
      }),
      'permission.workspace-list': vi.fn().mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        permissionDecisions: [],
      }),
      'audit.server-list': vi.fn(),
      'permission.server-list': vi.fn(),
      ...overrides.operations,
    },
  } as unknown as CoreClient;
}

function renderApp(path: string, client: CoreClient, content: ReactNode = <AppRoutes />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(content));
  return client;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Usage & audit summaries and long lists (P8)', () => {
  it('shows a failed or denied summary by default without the raw actor id', async () => {
    renderApp('/workspace/usage', makeClient());

    await screen.findByRole('heading', { level: 1, name: 'Usage & audit' });
    const main = screen.getByRole('main');
    expect(await within(main).findByText(/Export denied/i)).toBeVisible();
    expect(main).not.toHaveTextContent(ACTOR_ID);
  });

  it('shows the raw actor id only after Records is opened', async () => {
    const user = userEvent.setup();
    renderApp('/workspace/usage', makeClient());

    await screen.findByRole('heading', { level: 1, name: 'Usage & audit' });
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent(ACTOR_ID);

    await user.click(await within(main).findByRole('button', { name: /^Records$/i }));
    expect(await within(main).findByText(ACTOR_ID, { exact: false })).toBeVisible();
  });

  it('uses the task route for a thread whose conversation.navigation activity is task', async () => {
    renderApp('/workspace/usage', makeClient());

    await screen.findByRole('heading', { level: 1, name: 'Usage & audit' });
    const main = screen.getByRole('main');
    const threadLinks = within(main)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.includes(THREAD_ID));

    expect(threadLinks.length).toBeGreaterThan(0);
    for (const link of threadLinks) {
      expect(link).toHaveAttribute('href', `/tasks/${WORKSPACE_ID}/${THREAD_ID}`);
    }
  });

  it('offers no next-page or load-more control and sends no cursor to the uncursored reads', async () => {
    const client = makeClient();
    renderApp('/workspace/usage', client);

    await screen.findByRole('heading', { level: 1, name: 'Usage & audit' });
    const main = screen.getByRole('main');
    for (const role of ['button', 'link'] as const) {
      expect(
        within(main).queryByRole(role, {
          name: /next page|previous page|load more|show more|more records/i,
        })
      ).not.toBeInTheDocument();
    }

    for (const operation of [
      'usage.read',
      'audit.workspace-list',
      'permission.workspace-list',
    ] as const) {
      expect(client.operations[operation]).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE_ID,
      });
    }
  });

  it('says a text filter covers only loaded records', async () => {
    const user = userEvent.setup();
    renderApp('/workspace/usage', makeClient());

    await screen.findByRole('heading', { level: 1, name: 'Usage & audit' });
    const main = screen.getByRole('main');
    const search =
      within(main).queryByRole('searchbox', { name: /search|filter/i }) ??
      within(main).getByRole('textbox', { name: /search|filter/i });

    await user.type(search, 'launch');
    expect(await within(main).findByText(/loaded records/i)).toBeVisible();
  });
});
