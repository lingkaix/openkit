import type { CoreClient } from '@openkit/core-client';
import { ItemSchema, ProductTurnSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { useWorkspaceStore } from '../workspace-store';

const FAILURE_MESSAGE =
  'Worker reported terminal status: failed. Last worker inference stream failed before completion.';

const THREAD = {
  id: 'th_82',
  workspaceId: 'ws1',
  name: 'Failed worker task',
  preview: 'Failed worker task',
  status: 'active' as const,
  createdAt: '2026-09-16T05:20:00.000Z',
  updatedAt: '2026-09-16T05:21:24.892Z',
};

const USER_MESSAGE = ItemSchema.parse({
  id: 'it_user_tu_82',
  workspaceId: 'ws1',
  threadId: 'th_82',
  turnId: 'tu_82',
  type: 'user-message',
  status: 'completed',
  actor: { kind: 'user', id: 'user_operator' },
  text: 'Start the worker task.',
  createdAt: '2026-09-16T05:20:00.000Z',
  completedAt: '2026-09-16T05:20:00.000Z',
});

const ACCEPTED_STATUS_ITEM = ItemSchema.parse({
  id: 'it_worker_result_tu_82',
  workspaceId: 'ws1',
  threadId: 'th_82',
  turnId: 'tu_82',
  type: 'status',
  status: 'completed',
  level: 'info',
  title: 'Worker Turn accepted',
  summary: 'Conversation continued with agent_codex.',
  createdAt: '2026-09-16T05:20:01.000Z',
  completedAt: '2026-09-16T05:20:01.000Z',
});

const FAILED_DASHBOARD_TURN = ProductTurnSchema.parse({
  id: 'tu_82',
  workspaceId: 'ws1',
  threadId: 'th_82',
  triggerActor: { kind: 'user', id: 'user_operator' },
  items: [USER_MESSAGE, ACCEPTED_STATUS_ITEM],
  error: {
    code: 'worker_governance_turn_failed',
    message: FAILURE_MESSAGE,
  },
  configVersion: null,
  startedAt: '2026-09-16T05:20:00.000Z',
  completedAt: '2026-09-16T05:21:24.892Z',
  durationMs: null,
  status: 'failed',
  humanGate: null,
});

const COMPLETED_DASHBOARD_TURN = ProductTurnSchema.parse({
  ...FAILED_DASHBOARD_TURN,
  status: 'completed',
  error: null,
});

function makeClient(core: Record<string, unknown> = {}, app: Record<string, unknown> = {}) {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({
        items: [{ id: 'ws1', name: 'Market research' }],
      }),
      listThreads: vi.fn().mockResolvedValue({ items: [THREAD] }),
      getThread: vi.fn().mockResolvedValue(THREAD),
      listThreadItems: vi.fn().mockResolvedValue({
        items: [USER_MESSAGE, ACCEPTED_STATUS_ITEM],
        nextCursor: null,
      }),
      startTurn: vi.fn(),
      ...core,
    },
    app: {
      listAuthorizedWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      getThreadDashboard: vi.fn().mockResolvedValue({ turns: [FAILED_DASHBOARD_TURN] }),
      getConversationTargets: vi.fn().mockResolvedValue({
        workspaceId: 'ws1',
        threadId: 'th_82',
        defaultTargetRef: 'internal-role:assistant',
        targets: [],
      }),
      submitConversation: vi.fn(),
      startTaskMode: vi.fn(),
      ...app,
    },
  } as unknown as CoreClient;
}

function renderTask(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/tasks/ws1/th_82']}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return client;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
});

describe('task turn failure (dashboard reload)', () => {
  it('shows the dashboard failed Turn error on a fresh Task route without retrying', async () => {
    const client = renderTask(makeClient());

    expect(await screen.findByText(FAILURE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(FAILURE_MESSAGE);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Worker Turn accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await waitFor(() => expect(client.core.startTurn).not.toHaveBeenCalled());
    expect(client.app.submitConversation).not.toHaveBeenCalled();
    expect(client.app.startTaskMode).not.toHaveBeenCalled();
  });

  it('does not treat a completed dashboard Turn with an accepted status item as failed', async () => {
    renderTask(
      makeClient(
        {},
        { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [COMPLETED_DASHBOARD_TURN] }) }
      )
    );

    expect(await screen.findByText('Worker Turn accepted')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByText(FAILURE_MESSAGE)).not.toBeInTheDocument();
  });
});
