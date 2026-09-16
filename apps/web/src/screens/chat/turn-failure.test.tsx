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

const HISTORICAL_FAILURE_MESSAGE =
  'Worker reported terminal status: failed. Earlier worker inference stream failed before completion.';

const HISTORICAL_USER_MESSAGE = ItemSchema.parse({
  ...USER_MESSAGE,
  id: 'it_user_tu_81',
  turnId: 'tu_81',
  text: 'Start the earlier worker task.',
  createdAt: '2026-09-16T05:18:00.000Z',
  completedAt: '2026-09-16T05:18:00.000Z',
});

const HISTORICAL_ACCEPTED_STATUS_ITEM = ItemSchema.parse({
  ...ACCEPTED_STATUS_ITEM,
  id: 'it_worker_result_tu_81',
  turnId: 'tu_81',
  createdAt: '2026-09-16T05:18:01.000Z',
  completedAt: '2026-09-16T05:18:01.000Z',
});

const LATER_USER_MESSAGE = ItemSchema.parse({
  ...USER_MESSAGE,
  id: 'it_user_tu_83',
  turnId: 'tu_83',
  text: 'Continue after the failure.',
  createdAt: '2026-09-16T05:22:00.000Z',
  completedAt: '2026-09-16T05:22:00.000Z',
});

const LATER_ASSISTANT_DONE = ItemSchema.parse({
  id: 'it_assistant_tu_83',
  workspaceId: 'ws1',
  threadId: 'th_82',
  turnId: 'tu_83',
  type: 'assistant-message',
  status: 'completed',
  text: 'Done',
  createdAt: '2026-09-16T05:22:01.000Z',
  completedAt: '2026-09-16T05:22:01.000Z',
});

const HISTORICAL_FAILED_TURN = ProductTurnSchema.parse({
  ...FAILED_DASHBOARD_TURN,
  id: 'tu_81',
  items: [HISTORICAL_USER_MESSAGE, HISTORICAL_ACCEPTED_STATUS_ITEM],
  error: {
    code: 'worker_governance_turn_failed',
    message: HISTORICAL_FAILURE_MESSAGE,
  },
  startedAt: '2026-09-16T05:18:00.000Z',
  completedAt: '2026-09-16T05:19:24.892Z',
});

const LATER_COMPLETED_TURN = ProductTurnSchema.parse({
  ...COMPLETED_DASHBOARD_TURN,
  id: 'tu_83',
  items: [LATER_USER_MESSAGE, LATER_ASSISTANT_DONE],
  startedAt: '2026-09-16T05:22:00.000Z',
  completedAt: '2026-09-16T05:22:01.000Z',
});

const MISSING_ERROR_FALLBACK = 'This turn failed. Review the conversation before trying again.';

const EMPTY_FAILED_DASHBOARD_TURN = ProductTurnSchema.parse({
  ...FAILED_DASHBOARD_TURN,
  items: [],
});

const HISTORICAL_EMPTY_FAILED_TURN = ProductTurnSchema.parse({
  ...HISTORICAL_FAILED_TURN,
  items: [],
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

  it('keeps an earlier failed Turn error beside that Turn after a later Turn completes', async () => {
    renderTask(
      makeClient(
        {
          listThreadItems: vi.fn().mockResolvedValue({
            items: [
              HISTORICAL_USER_MESSAGE,
              HISTORICAL_ACCEPTED_STATUS_ITEM,
              LATER_USER_MESSAGE,
              LATER_ASSISTANT_DONE,
            ],
            nextCursor: null,
          }),
        },
        {
          getThreadDashboard: vi.fn().mockResolvedValue({
            turns: [HISTORICAL_FAILED_TURN, LATER_COMPLETED_TURN],
          }),
        }
      )
    );

    const failure = await screen.findByText(HISTORICAL_FAILURE_MESSAGE);
    expect(screen.getByRole('alert')).toHaveTextContent(HISTORICAL_FAILURE_MESSAGE);
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByText('Start the earlier worker task.')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(
      screen.getByText('Start the earlier worker task.').compareDocumentPosition(failure) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      failure.compareDocumentPosition(screen.getByText('Turn 2')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('preserves interleaved Items and shows each historical failure once', async () => {
    renderTask(
      makeClient(
        {
          listThreadItems: vi.fn().mockResolvedValue({
            items: [
              HISTORICAL_USER_MESSAGE,
              USER_MESSAGE,
              {
                ...HISTORICAL_ACCEPTED_STATUS_ITEM,
                createdAt: '2026-09-16T05:20:01.000Z',
                completedAt: '2026-09-16T05:20:01.000Z',
              },
              LATER_USER_MESSAGE,
            ],
            nextCursor: null,
          }),
        },
        {
          getThreadDashboard: vi.fn().mockResolvedValue({
            turns: [
              { ...HISTORICAL_FAILED_TURN, completedAt: '2026-09-16T05:21:30.000Z' },
              FAILED_DASHBOARD_TURN,
              LATER_COMPLETED_TURN,
            ],
          }),
        }
      )
    );
    const first = await screen.findByText('Start the earlier worker task.');
    const second = screen.getByText('Start the worker task.');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      second.compareDocumentPosition(screen.getByText('Worker Turn accepted')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getAllByText(HISTORICAL_FAILURE_MESSAGE)).toHaveLength(1);
    expect(screen.getAllByText(FAILURE_MESSAGE)).toHaveLength(1);
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('still shows the latest failed Turn error when that Turn has no Items', async () => {
    renderTask(
      makeClient(
        { listThreadItems: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
        { getThreadDashboard: vi.fn().mockResolvedValue({ turns: [EMPTY_FAILED_DASHBOARD_TURN] }) }
      )
    );

    expect(await screen.findByText(FAILURE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(FAILURE_MESSAGE);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('keeps a no-Item failed Turn fallback error before a later completed Turn', async () => {
    renderTask(
      makeClient(
        {
          listThreadItems: vi.fn().mockResolvedValue({
            items: [LATER_USER_MESSAGE, LATER_ASSISTANT_DONE],
            nextCursor: null,
          }),
        },
        {
          getThreadDashboard: vi.fn().mockResolvedValue({
            turns: [HISTORICAL_EMPTY_FAILED_TURN, LATER_COMPLETED_TURN],
          }),
        }
      )
    );

    const failure = await screen.findByText(MISSING_ERROR_FALLBACK);
    expect(screen.getByRole('alert')).toHaveTextContent(MISSING_ERROR_FALLBACK);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Done');
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(
      failure.compareDocumentPosition(screen.getByText('Turn 2')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
