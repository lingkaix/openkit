import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatKeys } from '../screens/chat/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { CoreClientProvider } from './core-client';
import { Sidebar } from './Sidebar';

const workspaceId = 'ws_019a0000-0000-7000-8000-000000000001';
const coordinatorId = 'th_019a0000-0000-7000-8000-000000000002';
const taskId = 'th_019a0000-0000-7000-8000-000000000003';
const archivedId = 'th_019a0000-0000-7000-8000-000000000004';
const unrelatedId = 'th_019a0000-0000-7000-8000-000000000005';

afterEach(() => useWorkspaceStore.setState({ currentWorkspaceId: null }));

describe('Goal navigation groups', () => {
  it('uses real card links, retains attempts and archived history, and hides cached child facts after a failed read', async () => {
    const at = '2026-10-16T00:00:00.000Z';
    const thread = (id: string, name: string, status: 'active' | 'archived' = 'active') => ({
      id,
      name,
      workspaceId,
      preview: name,
      status,
      visibility: 'workspace',
      entryPath: 'conversation',
      createdAt: at,
      updatedAt: at,
    });
    const threads = [
      thread(coordinatorId, 'Goal work'),
      thread(taskId, 'Linked Task'),
      thread(archivedId, 'Archived Task', 'archived'),
      thread(unrelatedId, 'Independent work'),
    ];
    const listThreads = vi.fn(async () => ({ items: threads }));
    const goal = vi.fn(async () => ({
      goal: { goalId: 'goal-visible', threadId: coordinatorId, workspaceId },
      cards: [{ cardId: 'card-parser', description: 'Ship parser', revision: 2 }],
      versions: [],
      requests: [],
      tasks: [
        {
          goalId: 'goal-visible',
          cardId: 'card-parser',
          threadId: taskId,
          planVersionId: 'plan-approved',
          cardRevision: 1,
          missing: false,
          admittedAt: at,
          turns: [
            { turnId: 'first-attempt', status: 'completed', completedAt: at },
            { turnId: 'second-attempt', status: 'failed', completedAt: at },
          ],
        },
        {
          goalId: 'goal-visible',
          cardId: 'card-parser',
          threadId: archivedId,
          planVersionId: 'plan-approved',
          cardRevision: 1,
          missing: false,
          admittedAt: at,
          turns: [{ turnId: 'archived-attempt', status: 'cancelled', completedAt: at }],
        },
        {
          goalId: 'goal-visible',
          cardId: 'card-parser',
          threadId: 'th_019a0000-0000-7000-8000-000000000006',
          planVersionId: 'plan-approved',
          cardRevision: 1,
          missing: true,
          admittedAt: null,
          turns: [],
        },
      ],
    }));
    const markRead = vi.fn();
    const client = {
      core: {},
      app: {},
      operations: {
        'workspace.list': async () => ({
          items: [
            {
              workspace: { id: workspaceId, name: 'Workspace', kind: 'general' },
              effectiveRole: 'owner',
              membershipStatus: 'active',
              accessCause: 'membership',
              ownerUserId: 'viewer',
              membershipRevision: 1,
              registryRevision: 1,
            },
          ],
        }),
        'conversation.navigation': async () => ({
          items: threads
            .filter((item) => item.status === 'active')
            .map((item) => ({
              thread: item,
              activity: item.id === coordinatorId ? 'goal' : 'task',
              state: 'idle',
              lastActivityAt: at,
              unreadCount: 0,
            })),
        }),
        'thread.list': listThreads,
        'goal.read': goal,
        'thread.mark-read': markRead,
      },
    } as unknown as CoreClient;
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useWorkspaceStore.setState({ currentWorkspaceId: workspaceId });
    render(
      <QueryClientProvider client={cache}>
        <CoreClientProvider client={client}>
          <MemoryRouter>
            <Sidebar />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show tasks for Goal work' }));
    await screen.findByText('Ship parser');
    expect(screen.getAllByRole('button', { name: 'Linked Task', exact: true })).toHaveLength(1);
    const attempts = screen.getByRole('list', { name: 'Attempts for Linked Task' });
    expect(
      within(attempts)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Attempt 1 · completed', 'Attempt 2 · failed']);
    expect(
      screen.getByRole('button', { name: 'Archived Task', exact: true })
    ).toHaveAccessibleDescription('Archived Task');
    expect(screen.getByText('Attempt 1 · cancelled')).toBeVisible();
    expect(screen.getByText('Task unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Independent work', exact: true })).toBeVisible();
    expect(markRead).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Hide tasks for Goal work' }));
    expect(
      screen.queryByRole('list', { name: 'Attempts for Linked Task' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show tasks for Goal work' }));
    await screen.findByRole('list', { name: 'Attempts for Linked Task' });
    listThreads.mockRejectedValueOnce(new Error('Access unavailable'));
    await act(async () => {
      await cache.invalidateQueries({ queryKey: chatKeys.threads(workspaceId), exact: true });
    });
    await screen.findByText('Goal tasks are unavailable.');
    expect(screen.queryByText('Ship parser')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Attempts for Linked Task' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Attempts for Linked Task' })).toBeVisible()
    );
    expect(markRead).not.toHaveBeenCalled();
    cache.clear();
  });
});
