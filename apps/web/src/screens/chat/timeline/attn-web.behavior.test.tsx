import { ListHumanAttentionResponseSchema } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ToastProvider, toastQueue } from '../../../primitives';
import { useWorkspaceStore } from '../../workspace-store';
import { BackLink } from './BackLink';
import { DecisionRowSheet } from './decision-sheet';
import { NeedsYouBar } from './NeedsYouBar';
import { toNeedsYouRow } from './needs-you';
import { TimelineToasts } from './TimelineToasts';
import { TimelineNowProvider } from './time';
import { resetToastPolicy } from './toast-policy';

const WORKSPACE = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';
const THREAD = 'th_00000000-0000-70a0-9cde-4561f64881c6';
const TURN = 'tu_00000000-0000-7da3-a7fc-80982f9b215e';
const ITEM = 'it_00000000-0000-700c-9754-b8c00fd380a8';
const USER = 'usr_00000000-0000-7000-8000-000000000001';
const RUN_START = '2026-11-08T10:02:00.000Z';
const OTHER_TIME = '2026-11-08T11:11:00.000Z';

afterEach(() => {
  act(() => {
    resetToastPolicy();
    toastQueue.clear();
  });
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

function origin(viewerStartedRun: boolean | null, viewerCausedHandoff: boolean | null) {
  return {
    startedBy: { kind: 'user' as const, id: USER },
    startedAt: RUN_START,
    viewerStartedRun,
    viewerCausedHandoff,
  };
}

function attentionRow(overrides: Record<string, unknown>) {
  return ListHumanAttentionResponseSchema.parse({
    items: [
      {
        id: 'blocked:run',
        kind: 'blocked_turn',
        workspaceId: WORKSPACE,
        threadId: THREAD,
        turnId: TURN,
        title: 'The run failed',
        summary: 'The run stopped before it finished.',
        severity: 'blocked',
        createdAt: OTHER_TIME,
        ageSeconds: 30,
        blocking: false,
        source: {
          type: 'protocol_item',
          itemType: 'command',
          workspaceId: WORKSPACE,
          threadId: THREAD,
          turnId: TURN,
          itemId: ITEM,
        },
        actions: [{ kind: 'open_thread', label: 'Open', method: 'GET' }],
        ...overrides,
      },
    ],
  }).items[0]!;
}

function questionRow(questionSummary: { text: string; truncated: boolean } | null) {
  return attentionRow({
    id: 'question:unloaded',
    kind: 'question',
    title: 'Answer required',
    summary: 'Answer the question on its pending request.',
    severity: 'needs_input',
    blocking: true,
    questionSummary,
    origin: { ...origin(null, null), startedAt: null },
    source: {
      type: 'protocol_item',
      itemType: 'user-input-request',
      workspaceId: WORKSPACE,
      threadId: THREAD,
      turnId: TURN,
      itemId: ITEM,
    },
    actions: [{ kind: 'answer_question', label: 'Answer', method: 'POST' }],
  });
}

function Harness({ client, children }: { client: CoreClient; children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/artifacts']}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

function toastClient(rows: () => readonly unknown[]) {
  return {
    core: { meta: async () => ({}) },
    operations: {
      'workspace.list': async () => ({
        items: [
          {
            membershipStatus: 'active',
            accessCause: 'membership',
            workspace: { id: WORKSPACE, name: 'Market research', kind: 'code' },
            isOwner: true,
            membershipRevision: 1,
            ownerUserId: USER,
            registryRevision: 1,
          },
        ],
      }),
      'attention.list': async () => ({ items: rows() }),
      'conversation.navigation': async () => ({
        items: [{ activity: 'chat', thread: { id: THREAD, name: 'Launch notes' } }],
      }),
    },
  } as unknown as CoreClient;
}

async function primeToasts(rows: () => readonly unknown[]) {
  document.hasFocus = () => true;
  useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE, selectionUserKey: null });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={toastClient(rows)}>
        <MemoryRouter initialEntries={['/artifacts']}>
          <ToastProvider />
          <TimelineToasts />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  await waitFor(() => {
    expect(queryClient.getQueryState(['attention', WORKSPACE])?.status).toBe('success');
  });
  return queryClient;
}

describe('attention origin toasts', () => {
  it('toasts a failure only when the viewer started that run', async () => {
    let items: ReturnType<typeof attentionRow>[] = [];
    const queryClient = await primeToasts(() => items);
    items = [attentionRow({ origin: origin(true, false) })];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['attention', WORKSPACE] });
    });
    expect((await screen.findAllByText(/The run failed · Launch notes/)).length).toBeGreaterThan(0);
  });

  it('stays quiet when the viewer did not start the failed run', async () => {
    for (const viewerStartedRun of [false, null] as const) {
      act(() => {
        resetToastPolicy();
        toastQueue.clear();
      });
      let items: ReturnType<typeof attentionRow>[] = [];
      const queryClient = await primeToasts(() => items);
      items = [
        attentionRow({
          title: 'Ada started this run',
          origin: origin(viewerStartedRun, false),
        }),
      ];
      const before = queryClient.getQueryState(['attention', WORKSPACE])?.dataUpdatedAt ?? 0;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['attention', WORKSPACE] });
      });
      await waitFor(() => {
        expect(
          queryClient.getQueryState(['attention', WORKSPACE])?.dataUpdatedAt ?? 0
        ).toBeGreaterThan(before);
      });
      expect(screen.queryByText(/Ada started this run/)).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('stays quiet when a failed run has no origin', async () => {
    for (const originField of [null, undefined] as const) {
      act(() => {
        resetToastPolicy();
        toastQueue.clear();
      });
      let items: ReturnType<typeof attentionRow>[] = [];
      const queryClient = await primeToasts(() => items);
      items = [attentionRow(originField === undefined ? {} : { origin: null })];
      const before = queryClient.getQueryState(['attention', WORKSPACE])?.dataUpdatedAt ?? 0;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['attention', WORKSPACE] });
      });
      await waitFor(() => {
        expect(
          queryClient.getQueryState(['attention', WORKSPACE])?.dataUpdatedAt ?? 0
        ).toBeGreaterThan(before);
      });
      expect(screen.queryByText(/The run failed/)).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('toasts a handoff only when the viewer caused it', async () => {
    let items: ReturnType<typeof attentionRow>[] = [];
    const queryClient = await primeToasts(() => items);
    items = [
      attentionRow({
        id: 'handoff:1',
        kind: 'budget',
        title: 'Handed off the task',
        summary: 'Another worker continues this task.',
        severity: 'info',
        source: {
          type: 'protocol_item',
          itemType: 'agent-handoff',
          workspaceId: WORKSPACE,
          threadId: THREAD,
          turnId: TURN,
          itemId: ITEM,
        },
        origin: origin(false, true),
      }),
    ];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['attention', WORKSPACE] });
    });
    expect(
      (await screen.findAllByText(/Handed off the task · Launch notes/)).length
    ).toBeGreaterThan(0);
  });

  it('stays quiet when the viewer did not cause the handoff', async () => {
    for (const viewerCausedHandoff of [false, null] as const) {
      act(() => {
        resetToastPolicy();
        toastQueue.clear();
      });
      let items: ReturnType<typeof attentionRow>[] = [];
      const queryClient = await primeToasts(() => items);
      items = [
        attentionRow({
          id: 'handoff:quiet',
          kind: 'budget',
          title: 'Handed off the task',
          summary: 'Another worker continues this task.',
          severity: 'info',
          source: {
            type: 'protocol_item',
            itemType: 'agent-handoff',
            workspaceId: WORKSPACE,
            threadId: THREAD,
            turnId: TURN,
            itemId: ITEM,
          },
          origin: origin(false, viewerCausedHandoff),
        }),
      ];
      const before = queryClient.getQueryState(['attention', WORKSPACE])?.dataUpdatedAt ?? 0;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['attention', WORKSPACE] });
      });
      await waitFor(() => {
        expect(
          queryClient.getQueryState(['attention', WORKSPACE])?.dataUpdatedAt ?? 0
        ).toBeGreaterThan(before);
      });
      expect(screen.queryByText(/Handed off the task/)).not.toBeInTheDocument();
      cleanup();
    }
  });
});

describe('unloaded attention question summary', () => {
  const asked = 'Which date format should exports use?';

  function barFor(summary: { text: string; truncated: boolean } | null, question?: string) {
    const row = toNeedsYouRow(questionRow(summary), '/chat/ws/th', undefined, question);
    const onOpen = vi.fn();
    render(<NeedsYouBar rows={[row]} emphasize={false} reducedMotion onOpen={onOpen} />);
    return { row, onOpen };
  }

  it('shows the recorded question when the request is not loaded', async () => {
    const user = userEvent.setup();
    const { onOpen } = barFor({ text: asked, truncated: false });
    const button = screen.getByRole('button', { name: new RegExp(asked) });
    expect(button).not.toHaveTextContent('…');
    expect(button).not.toHaveTextContent('Answer required');
    await user.click(button);
    expect(onOpen).toHaveBeenCalledWith(expect.stringContaining('/chat/ws/th'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
  });

  it('shows a visible truncation mark when the recorded question was cut', () => {
    barFor({ text: asked, truncated: true });
    expect(
      screen.getByRole('button', { name: /Which date format should exports use\?…/ })
    ).toBeInTheDocument();
  });

  it('keeps the generic summary when no question text was recorded', () => {
    barFor(null);
    expect(screen.getByRole('button', { name: /Answer required/ })).toBeInTheDocument();
    expect(screen.queryByText(asked)).not.toBeInTheDocument();
  });

  it('keeps the loaded request question ahead of the summary', () => {
    barFor({ text: 'Summary that must stay hidden', truncated: false }, 'Loaded question text');
    expect(screen.getByRole('button', { name: /Loaded question text/ })).toBeInTheDocument();
    expect(screen.queryByText(/Summary that must stay hidden/)).not.toBeInTheDocument();
  });

  it('shows the summary on the title-only sheet and does not submit from it', () => {
    const row = toNeedsYouRow(questionRow({ text: asked, truncated: true }), '/chat/ws/th');
    render(
      <TimelineNowProvider now={Date.parse('2026-11-08T12:00:00.000Z')}>
        <DecisionRowSheet
          title={row.title}
          createdAt={row.createdAt}
          startedAt={null}
          blocking={row.blocking}
          more={0}
          onClose={() => {}}
        />
      </TimelineNowProvider>
    );
    expect(screen.getByText(`${asked}…`)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/run at/)).not.toBeInTheDocument();
  });
});

describe('recorded run start', () => {
  it('shows the attention-row clock only for a recorded start', () => {
    const present = toNeedsYouRow(
      attentionRow({ origin: { ...origin(null, null), startedAt: RUN_START } }),
      null
    );
    const missing = toNeedsYouRow(
      attentionRow({ origin: { ...origin(null, null), startedAt: null } }),
      null
    );
    const { rerender } = render(<NeedsYouBar rows={[present]} emphasize={false} reducedMotion />);
    expect(screen.getByRole('button')).toHaveTextContent('run at 10:02');
    expect(screen.getByRole('button')).not.toHaveTextContent('11:11');
    rerender(
      <TimelineNowProvider now={Date.parse('2026-11-08T12:00:00.000Z')}>
        <DecisionRowSheet
          title={present.title}
          createdAt={present.createdAt}
          blocking={false}
          more={0}
          onClose={() => {}}
        />
      </TimelineNowProvider>
    );
    expect(screen.getByText('The run failed · run at 10:02')).toBeInTheDocument();
    expect(screen.queryByText(/run at 11:11/)).not.toBeInTheDocument();
    rerender(<NeedsYouBar rows={[missing]} emphasize={false} reducedMotion />);
    expect(screen.getByRole('button')).not.toHaveTextContent('run at');
  });

  it('shows the same clock on the title-only sheet', () => {
    render(
      <TimelineNowProvider now={Date.parse('2026-11-08T12:00:00.000Z')}>
        <DecisionRowSheet
          title="The run failed"
          createdAt={OTHER_TIME}
          startedAt={RUN_START}
          blocking={false}
          more={0}
          onClose={() => {}}
        />
      </TimelineNowProvider>
    );
    expect(screen.getByText('run at 10:02')).toBeInTheDocument();
    expect(screen.queryByText(/run at 11:11/)).not.toBeInTheDocument();
  });

  it('uses turn.read startedAt on the back-link and ignores an artifact time', async () => {
    const read = vi.fn(async () => ({ startedAt: RUN_START }));
    const client = {
      operations: { 'turn.read': read },
    } as unknown as CoreClient;
    render(
      <Harness client={client}>
        <BackLink
          workspaceId={WORKSPACE}
          threadId={THREAD}
          turnId={TURN}
          recordedAt={OTHER_TIME}
          audience={{ status: 'open', name: 'Launch notes', activity: 'chat' }}
        />
      </Harness>
    );
    const link = await screen.findByRole('link', { name: /run at 10:02/ });
    expect(link).not.toHaveTextContent('11:11');
    expect(read).toHaveBeenCalled();
  });

  it('shows no back-link clock when the recorded start is null', async () => {
    const read = vi.fn(async () => ({ startedAt: null }));
    const client = {
      operations: { 'turn.read': read },
    } as unknown as CoreClient;
    render(
      <Harness client={client}>
        <BackLink
          workspaceId={WORKSPACE}
          threadId={THREAD}
          turnId={TURN}
          recordedAt={RUN_START}
          audience={{ status: 'open', name: 'Launch notes', activity: 'chat' }}
        />
      </Harness>
    );
    const link = await screen.findByRole('link');
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(link).toHaveTextContent('From: Launch notes');
    expect(link).not.toHaveTextContent('run at');
  });
});
