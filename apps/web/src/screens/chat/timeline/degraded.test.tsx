import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectionFailureKind,
  CoreClientProvider,
  useConnection,
  useConnectionFailure,
} from '../../../app/core-client';
import { DisconnectedBanner } from '../../../app/DisconnectedBanner';
import { ToastProvider, toastQueue } from '../../../primitives';
import { advanceAccountGeneration } from '../../account/generation';
import { useSendTurn, useThreadItems } from '../data';
import { ItemView } from '../ItemView';
import { ThreadStream } from '../ThreadStream';
import { classifyRunError, freshnessCopy } from './degraded';
import { SendFailure, SendPending } from './SendState';

const APPROVAL = ItemSchema.parse({
  id: 'it_00000000-0000-7570-9913-dd37f2bda2fe',
  owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0' },
  threadId: 'th_00000000-0000-70a0-9cde-4561f64881c6',
  type: 'approval-request',
  turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
  status: 'completed',
  approvalRequestId: 'ap1',
  title: 'Approve $5 spend',
  description: 'To pull competitor pricing.',
  kind: 'permission',
  createdAt: '2026-07-21T00:00:02.000Z',
  completedAt: '2026-07-21T00:00:02.000Z',
});

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  setOnline(true);
  act(() => {
    toastQueue.clear();
  });
});

function client(meta: () => Promise<unknown> = async () => ({})): CoreClient {
  return { core: { meta }, operations: {} } as unknown as CoreClient;
}

function ConnectionProbe({ kind }: { kind?: ConnectionFailureKind }) {
  const { report } = useConnectionFailure();
  const connection = useConnection();
  useEffect(() => {
    if (!kind) return;
    report({}, () => {}, kind, kind === 'busy' ? 9 : null);
  }, [kind, report]);
  return <p>{connection.failed ? 'paused' : 'working'}</p>;
}

function renderConnection(meta?: () => Promise<unknown>, kind?: ConnectionFailureKind) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client(meta)}>
        <ConnectionProbe kind={kind} />
        <DisconnectedBanner />
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('connection states', () => {
  it('shows offline with the last load time and pauses sending', async () => {
    setOnline(true);
    renderConnection();
    await waitFor(() => expect(screen.getByText('working')).toBeInTheDocument());
    setOnline(false);
    expect(screen.getByRole('status')).toHaveTextContent(
      /You are seeing what loaded at .+ Sending is paused/
    );
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('shows reconnecting and keeps actions working', async () => {
    setOnline(true);
    renderConnection(async () => ({}), 'reconnecting');
    expect(await screen.findByText('Live updates paused · reconnecting')).toBeInTheDocument();
    expect(screen.getByText('working')).toBeInTheDocument();
  });

  it('shows server busy with a retry countdown', async () => {
    setOnline(true);
    renderConnection(
      () => Promise.reject(new ApiCallError(503, 'busy', { details: { retryAfter: 9 } })),
      'busy'
    );
    expect(await screen.findByText(/OpenKit is busy\. Retrying in \d+ s\./)).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('shows out of date and keeps the draft path readable', async () => {
    setOnline(true);
    renderConnection(async () => ({}), 'out-of-date');
    expect(
      await screen.findByText('This page is out of date. Reload to continue.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });
});

describe('send states', () => {
  it('renders sending without a sent marker', () => {
    render(<SendPending />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Sending');
    expect(status).toHaveAttribute('data-send-state', 'sending');
    expect(status.className).toContain('ok-send-pending');
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
  });

  it('keeps a not-sent draft and retries the same request id', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(new Error('refused'));
    renderSend(submit);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't send that message. Try again."
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[0].requestId).toBe(submit.mock.calls[0]?.[0].requestId);
    expect(screen.queryByText('reported by the worker')).not.toBeInTheDocument();
  });

  it('asks for a check that replays the same request id', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(new Error('Response lost.'));
    renderSend(submit);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm OpenKit received this. Check."
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[0].requestId).toBe('req-original');
  });

  it('keeps the draft when the task is busy', () => {
    render(
      <SendFailure
        error={new ApiCallError(409, 'busy', { code: 'thread_busy' })}
        requestId="req-original"
        onRetry={() => {}}
        onEdit={() => {}}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This Task is busy. Your message stays here. Send it when the run ends, or stop the run first.'
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});

describe('admission and reconnect', () => {
  it('hides a denied read and its queued toast', async () => {
    const secret = {
      id: 'it_secret',
      owner: { kind: 'workspace', workspaceId: 'ws' },
      threadId: 'th',
      turnId: 'tu',
      type: 'assistant-message',
      status: 'completed',
      text: 'Cached private plan',
      createdAt: '2026-07-21T00:00:01.000Z',
      completedAt: '2026-07-21T00:00:01.000Z',
    };
    let denied = false;
    const core = streamClient({
      'thread.items': async () => {
        if (denied) throw new ApiCallError(403, 'denied');
        return { items: [secret], nextCursor: null };
      },
      'thread.dashboard': async () => ({ turns: [], participants: [] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={core}>
          <ToastProvider />
          <ThreadStream workspaceId="ws" threadId="th" />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('Cached private plan')).toBeInTheDocument();
    act(() => {
      toastQueue.add({ message: 'Queued notice' });
    });
    expect(screen.getAllByText('Queued notice').length).toBeGreaterThan(0);
    denied = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['items', 'ws', 'th'] });
    });
    await waitFor(() => expect(screen.queryByText('Cached private plan')).not.toBeInTheDocument());
    expect(screen.queryAllByText('Queued notice')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText("This conversation hasn't started yet.")).not.toBeInTheDocument();
  });

  it('shows a failed read as its own region with retry', async () => {
    const core = streamClient({
      'thread.items': async () => {
        throw new Error('read failed');
      },
      'thread.dashboard': async () => ({ turns: [], participants: [] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={core}>
          <ThreadStream workspaceId="ws" threadId="th" />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText("Couldn't load this thread.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText("This conversation hasn't started yet.")).not.toBeInTheDocument();
  });

  it('discards a late response from an earlier account', async () => {
    let release!: (value: {
      items: { id: string; text: string; type: string }[];
      nextCursor: null;
    }) => void;
    const pending = new Promise<{
      items: { id: string; text: string; type: string }[];
      nextCursor: null;
    }>((resolve) => {
      release = resolve;
    });
    const core = {
      core: { meta: async () => ({}) },
      operations: { 'thread.items': () => pending },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={core}>
          <AccountReader />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(queryClient.isFetching()).toBeGreaterThan(0));
    advanceAccountGeneration();
    await act(async () => {
      release({
        items: [{ id: 'it', text: 'Earlier account secret', type: 'assistant-message' }],
        nextCursor: null,
      });
      await pending;
    });
    await waitFor(() => expect(screen.getByText('none')).toBeInTheDocument());
    expect(screen.queryByText('Earlier account secret')).not.toBeInTheDocument();
  });

  it('recovers a lost update whose item count did not change', async () => {
    const item = {
      id: 'it_1',
      owner: { kind: 'workspace', workspaceId: 'ws' },
      threadId: 'th',
      turnId: 'tu_1',
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'usr_00000000-0000-7609-aed5-db4b5c95e76c' },
      text: 'Old wording',
      createdAt: '2026-07-21T00:00:01.000Z',
      completedAt: '2026-07-21T00:00:01.000Z',
    };
    let text = 'Old wording';
    const list = vi.fn();
    const core = streamClient({
      'thread.items': async () => {
        list();
        return { items: [{ ...item, text }], nextCursor: null };
      },
      'thread.dashboard': async () => ({
        turns: [{ id: 'tu_1', status: 'running', items: [{ ...item, text }] }],
        participants: [],
      }),
      subscribeTurnEvents: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error('stream dropped');
            },
          };
        },
      }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={core}>
          <DisconnectedBanner />
          <ThreadStream workspaceId="ws" threadId="th" lens="full" />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('Old wording')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Live updates paused · reconnecting')).toBeInTheDocument()
    );
    const before = list.mock.calls.length;
    text = 'Recovered wording';
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['thread-dashboard', 'ws', 'th'] });
    });
    expect(await screen.findByText('Recovered wording')).toBeInTheDocument();
    expect(list.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('error class, consequence, and empty state', () => {
  it('uses neutral copy for an unmapped error code', () => {
    const result = classifyRunError('not_a_real_code');
    expect(result.text).toBe('This run ended with an error');
    expect(result.text.toLowerCase()).not.toContain('nothing changed');
    expect(result.text.toLowerCase()).not.toContain('safe');
    expect(freshnessCopy(3, Date.now() - 120_000, Date.now())).toBe('Updated 2 min ago');
  });

  it('shows consequence text as the accessible description and a reason on every disabled control', () => {
    const { rerender } = render(
      <ItemView
        item={APPROVAL}
        approvalEffect={{ status: 'available', summary: 'Spend $5', detail: '{"amount":5}' }}
        onApprovalDecision={() => {}}
        onWithdrawApproval={() => {}}
      />
    );
    expect(screen.getByText('Lets this call run once.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAccessibleDescription(
      'Lets this call run once.'
    );
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveAccessibleDescription(
      'The call does not run.'
    );
    rerender(
      <ItemView
        item={APPROVAL}
        approvalEffect={{ status: 'available', summary: 'Spend $5', detail: '{"amount":5}' }}
        onApprovalDecision={() => {}}
        onWithdrawApproval={() => {}}
        approvalPending
        pendingDecision="granted"
      />
    );
    expect(screen.getAllByText('Approving…').length).toBeGreaterThan(0);
    for (const name of ['Approve', 'Deny', 'Withdraw']) {
      const control = screen.getByRole('button', { name });
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription(/.+/);
    }
  });

  it('teaches an empty task what will appear', async () => {
    const core = streamClient({
      'thread.items': async () => ({ items: [], nextCursor: null }),
      'thread.dashboard': async () => ({ turns: [], participants: [] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={core}>
          <ThreadStream workspaceId="ws" threadId="th" mode="task" />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText("This Task hasn't started yet.")).toBeInTheDocument();
    expect(
      screen.getByText('Its first run will appear here with its plan and progress.')
    ).toBeInTheDocument();
  });
});

describe('hidden page stream', () => {
  it('closes the stream when the page hides and rereads when it returns', async () => {
    const item = {
      id: 'it_1',
      owner: { kind: 'workspace', workspaceId: 'ws' },
      threadId: 'th',
      turnId: 'tu_1',
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'usr_00000000-0000-7609-aed5-db4b5c95e76c' },
      text: 'Still here',
      createdAt: '2026-07-21T00:00:01.000Z',
      completedAt: '2026-07-21T00:00:01.000Z',
    };
    const list = vi.fn(async () => ({ items: [item], nextCursor: null }));
    const returned = vi.fn(async () => undefined);
    let subscribed = 0;
    const core = streamClient({
      'thread.items': () => list(),
      'thread.dashboard': async () => ({
        turns: [{ id: 'tu_1', status: 'running', items: [item] }],
        participants: [],
      }),
      subscribeTurnEvents: () => {
        subscribed += 1;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise(() => {}),
              return: returned,
            };
          },
        };
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={core}>
          <ThreadStream workspaceId="ws" threadId="th" />
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(subscribed).toBeGreaterThan(0));
    const returnsBefore = returned.mock.calls.length;
    const listsBefore = list.mock.calls.length;
    setVisibility('hidden');
    await waitFor(() => expect(returned.mock.calls.length).toBeGreaterThan(returnsBefore));
    setVisibility('visible');
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(listsBefore));
  });
});

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function streamClient(
  operations: Record<string, unknown> & { subscribeTurnEvents?: unknown }
): CoreClient {
  const { subscribeTurnEvents, ...rest } = operations;
  return {
    core: {
      meta: async () => ({}),
      subscribeTurnEvents:
        subscribeTurnEvents ??
        (() => ({
          [Symbol.asyncIterator]() {
            return { next: () => new Promise(() => {}) };
          },
        })),
    },
    operations: {
      'thread.read-state': async () => ({ scope: 'window', readItemIds: [], unreadItemIds: [] }),
      ...rest,
    },
  } as unknown as CoreClient;
}

function SendHarness() {
  const send = useSendTurn();
  const draft = {
    input: 'Hello',
    targetRef: 'target',
    artifactRefs: [],
    requestId: 'req-original',
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void send.mutate({ workspaceId: 'ws', threadId: 'th', draft })}
      >
        Send
      </button>
      {send.isError ? (
        <SendFailure
          error={send.error}
          requestId={draft.requestId}
          onRetry={() => void send.mutate({ workspaceId: 'ws', threadId: 'th', draft })}
          onEdit={() => {}}
        />
      ) : null}
    </>
  );
}

function AccountReader() {
  const items = useThreadItems('ws', 'th');
  const first = items.data?.[0];
  return <p>{first && 'text' in first ? String(first.text) : 'none'}</p>;
}

function renderSend(submit: ReturnType<typeof vi.fn>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const core = {
    core: { meta: async () => ({}) },
    operations: { 'conversation.submit': submit },
  } as unknown as CoreClient;
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={core}>
        <MemoryRouter>
          <SendHarness />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}
