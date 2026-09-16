import type { ConversationNavigationResponse } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatKeys,
  useArchiveThread,
  useRenameThread,
  useRestoreThread,
  useSendTurn,
} from '../screens/chat/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { CoreClientProvider } from './core-client';
import { Sidebar } from './Sidebar';

/** Exposes navigation as rendered state without substituting router behavior. */
function Location() {
  return <output aria-label="Location">{useLocation().pathname}</output>;
}

/** Uses the real submission hook so pending progress is scoped to the originating conversation. */
function Submit() {
  const send = useSendTurn();
  return (
    <button
      type="button"
      onClick={() =>
        send.mutate({
          workspaceId: 'ws1',
          threadId: 'th2',
          draft: {
            requestId: 'nav-request',
            input: 'Hello',
            targetRef: 'internal-role:assistant',
            artifactRefs: [],
          },
        })
      }
    >
      Send pending request
    </button>
  );
}

/** Drives lifecycle mutations against the rendered navigation projection. */
function Lifecycle() {
  const rename = useRenameThread();
  const archive = useArchiveThread();
  const restore = useRestoreThread();
  const owner = { workspaceId: 'ws1', threadId: 'th2' };
  return (
    <>
      <button
        type="button"
        onClick={() => rename.mutate({ ...owner, name: 'Updated conversation' })}
      >
        Rename conversation
      </button>
      <button type="button" onClick={() => archive.mutate(owner)}>
        Archive conversation
      </button>
      <button type="button" onClick={() => restore.mutate(owner)}>
        Restore conversation
      </button>
    </>
  );
}

beforeEach(() => useWorkspaceStore.setState({ currentWorkspaceId: null }));

describe('conversation navigation sidebar', () => {
  it('preserves authoritative order, describes activity and state, and reaches the matching work surface', async () => {
    const kinds = ['goal', 'task', 'chat', 'unknown'] as const;
    const rows: ConversationNavigationResponse['items'] = kinds.map((activity, index) => ({
      thread: {
        id: `th${index}`,
        workspaceId: 'ws1',
        name: `Conversation ${index}`,
        preview: '',
        status: 'active',
        entryPath: 'conversation',
        visibility: 'workspace',
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      },
      activity,
      state: index === 0 ? 'needs-you' : index === 1 ? 'working' : 'idle',
      lastActivityAt: '2026-09-16T00:00:00.000Z',
    }));
    const list = vi.fn().mockImplementation(async () => ({
      items: structuredClone(rows.filter((row) => row.thread.status === 'active')),
    }));
    let finishRequest!: (value: {
      receivingWorkspaceId: string;
      receivingThreadId: string;
    }) => void;
    const submitConversation = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRequest = resolve;
        })
    );
    const client = {
      core: {
        updateThread: async (input: { name?: string; status?: 'active' }) => {
          rows[2]!.thread = {
            ...rows[2]!.thread,
            ...(input.name ? { name: input.name } : {}),
            ...(input.status ? { status: input.status } : {}),
          };
          return rows[2]!.thread;
        },
        archiveThread: async () => {
          rows[2]!.thread = { ...rows[2]!.thread, status: 'archived' };
          return rows[2]!.thread;
        },
        listWorkspaces: async () => ({
          items: [{ id: 'ws1', name: 'Workspace', kind: 'general' }],
        }),
      },
      app: { listConversationNavigation: list, submitConversation },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter>
            <Sidebar />
            <Submit />
            <Lifecycle />
            <Location />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    const buttons = await screen.findAllByRole('button', { name: /^Conversation \d$/ });
    expect(buttons.map((button) => button.querySelector('.truncate')?.textContent)).toEqual(
      rows.map((row) => row.thread.name)
    );
    expect(buttons[0]).toHaveAccessibleDescription('Goal · Needs your attention');
    expect(buttons[1]).toHaveAccessibleDescription('Worker task · Working');
    expect(buttons[2]).toHaveAccessibleDescription('Assistant chat · Idle');
    expect(buttons[3]).toHaveAccessibleDescription('Activity type unknown · Idle');
    const user = userEvent.setup();
    await user.click(buttons[0]!);
    expect(screen.getByLabelText('Location')).toHaveTextContent('/goals/ws1/th0');
    expect(buttons[0]).toHaveAttribute('aria-current', 'page');
    await user.click(buttons[1]!);
    expect(screen.getByLabelText('Location')).toHaveTextContent('/tasks/ws1/th1');
    await user.click(buttons[2]!);
    expect(screen.getByLabelText('Location')).toHaveTextContent('/chat/ws1/th2');

    list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.threads('ws1') });
    });
    expect(await screen.findByText(/Conversation status unavailable/)).toBeInTheDocument();
    expect(buttons[1]).toHaveAccessibleDescription('Worker task · Status unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry conversations' }));
    await waitFor(() => expect(buttons[1]).toHaveAccessibleDescription('Worker task · Working'));
    await user.click(screen.getByRole('button', { name: 'Send pending request' }));
    await waitFor(() =>
      expect(buttons[2]).toHaveAccessibleDescription('Assistant chat · Waiting for response')
    );
    expect(screen.getAllByRole('button', { name: /^Conversation \d$/ })[0]).toBe(buttons[2]);
    await act(async () => {
      finishRequest({ receivingWorkspaceId: 'ws1', receivingThreadId: 'th2' });
    });
    await waitFor(() => expect(buttons[2]).toHaveAccessibleDescription('Assistant chat · Idle'));
    await user.click(screen.getByRole('button', { name: 'Rename conversation' }));
    expect(await screen.findByRole('button', { name: 'Updated conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive conversation' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Updated conversation' })).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: 'Restore conversation' }));
    expect(await screen.findByRole('button', { name: 'Updated conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Workspace settings' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/workspace');
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Settings' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings/account');
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
    queryClient.clear();
  });
});
