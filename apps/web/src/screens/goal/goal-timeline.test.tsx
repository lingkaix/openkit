import type { GoalView, HumanAttentionRow } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { ThreadScreen } from '../chat/ThreadScreen';
import { lintCopyText, timelineCopy } from '../chat/timeline/copy';
import { GoalScreen } from './GoalScreen';

vi.mock('../../app/core-client', async (original) => ({
  ...(await original<typeof import('../../app/core-client')>()),
  useConnection: () => ({ checking: false, failed: false, connected: true }),
}));
vi.mock('../chat/data', async (original) => ({
  ...(await original<typeof import('../chat/data')>()),
  useCurrentWorkspaceId: (id: string) => id,
}));

const at = '2026-10-03T00:00:00.000Z';
const WS = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';
const GOAL_THREAD = 'th_00000000-0000-70a0-9cde-4561f64881c6';
const TASK_A = 'th_00000000-0000-7c8c-8c46-80c1c4a0361b';
const TASK_B = 'th_00000000-0000-7c8c-8c46-80c1c4a0361c';
const ALPHA = 'Alpha task item should stay on the task';
const BETA = 'Beta task item should stay on the task';

function attention(partial: {
  id: string;
  threadId: string;
  title: string;
  createdAt: string;
}): HumanAttentionRow {
  return {
    id: partial.id,
    kind: 'question',
    workspaceId: WS,
    threadId: partial.threadId,
    title: partial.title,
    summary: 'Answer the question on its pending request.',
    severity: 'needs_input',
    createdAt: partial.createdAt,
    blocking: true,
    source: {
      type: 'protocol_item',
      itemType: 'user-input-request',
      workspaceId: WS,
      threadId: partial.threadId,
      turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
      itemId: 'it_00000000-0000-7da3-a7fc-80982f9b215e',
    },
    actions: [],
  } as HumanAttentionRow;
}

function view(): GoalView {
  return {
    goal: {
      goalId: 'g1',
      workspaceId: WS,
      threadId: GOAL_THREAD,
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      responsibleActorContext: {
        kind: 'local',
        userId: 'usr_00000000-0000-7000-8000-000000000001',
      },
      intent: 'Ship release',
      intentRevision: 0,
      intentHistory: [],
      activePlanVersionId: null,
      proposedPlanVersionId: 'p1',
      disposition: null,
      changeRevision: 1,
      consideredRevision: 1,
      createdAt: at,
      updatedAt: at,
    },
    cards: [
      {
        cardId: 'c1',
        goalId: 'g1',
        description: 'Verify release',
        priority: 0,
        revision: 2,
        cancelled: false,
        cancellationReason: null,
        createdAt: at,
        updatedAt: at,
      },
      {
        cardId: 'c2',
        goalId: 'g1',
        description: 'Write the notes',
        priority: 1,
        revision: 1,
        cancelled: false,
        cancellationReason: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
    versions: [
      {
        planVersionId: 'p1',
        goalId: 'g1',
        sequence: 1,
        bytes: 'Exact commitment',
        digest: `sha256:${'a'.repeat(64)}`,
        pendingRequestId: 'ap1',
        createdAt: at,
        commitment: {
          intentBasis: { intent: 'Ship release', revision: 0 },
          cards: [],
          permittedAdjustments: 'Reorder',
          completionEvidence: ['Report'],
          boundaries: 'No publication',
        },
      },
    ],
    tasks: [
      {
        goalId: 'g1',
        cardId: 'c1',
        threadId: TASK_A,
        planVersionId: 'p1',
        cardRevision: 1,
        admittedAt: at,
        missing: false,
        turns: [
          {
            turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
            status: 'completed',
            completedAt: at,
          },
        ],
      },
      {
        goalId: 'g1',
        cardId: 'c2',
        threadId: TASK_B,
        planVersionId: 'p1',
        cardRevision: 1,
        admittedAt: at,
        missing: false,
        turns: [
          {
            turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215f',
            status: 'running',
            completedAt: null,
          },
        ],
      },
    ],
    requests: [
      {
        requestId: 'ap1',
        operation: 'goal.plan.approve',
        state: 'pending',
        resolution: null,
        reason: null,
        decidingActorId: null,
        claim: 'unclaimed',
        disposition: null,
        exactIntent: { bytes: 'Exact commitment' },
      },
    ],
  };
}

function threadRecord(threadId: string) {
  return {
    id: threadId,
    owner: { kind: 'workspace' as const, workspaceId: WS },
    name: threadId === TASK_A ? 'Verify release' : 'Ship release',
    preview: 'Ship release',
    status: 'active' as const,
    visibility: 'workspace' as const,
    entryPath: 'conversation' as const,
    parentThreadId: threadId === TASK_A || threadId === TASK_B ? GOAL_THREAD : undefined,
    createdAt: at,
    updatedAt: at,
  };
}

function mount(
  data = view(),
  entry = `/goals/${WS}/${GOAL_THREAD}`,
  timeline?: (input: { anchor?: { kind?: string; itemId?: string } }) => unknown
) {
  const threadItems = vi.fn(async ({ threadId }: { threadId: string }) => {
    const text = threadId === TASK_A ? ALPHA : threadId === TASK_B ? BETA : '';
    if (!text) return { items: [], nextCursor: null };
    return {
      items: [
        {
          id: `it_${threadId}`,
          type: 'assistant-message',
          text,
          status: 'completed',
          createdAt: at,
          turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
        },
      ],
      nextCursor: null,
    };
  });
  const operations = {
    'goal.read': vi.fn().mockResolvedValue(data),
    'goal.card.edit': vi.fn().mockResolvedValue(data),
    'goal.card.create': vi.fn().mockResolvedValue(data),
    'goal.intent.revise': vi.fn().mockResolvedValue(data),
    'goal.plan.approve': vi.fn().mockResolvedValue(data),
    'goal.completion.accept': vi.fn().mockResolvedValue(data),
    'goal.cancel': vi.fn().mockResolvedValue(data),
    'goal.create': vi.fn().mockResolvedValue(data),
    'thread.items': threadItems,
    'thread.read': vi.fn(async ({ threadId }: { threadId: string }) => threadRecord(threadId)),
    'thread.dashboard': vi.fn(async ({ threadId }: { threadId: string }) => ({
      turns: [],
      pendingRequests: [],
      artifacts: [],
      taskInputs: [],
      participants: [],
      thread: threadRecord(threadId),
      viewerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workStatus: null,
      composer: { disabled: true, defaultAgentId: null },
      itemLog: { href: '/' },
    })),
    'thread.list': vi.fn().mockResolvedValue({ items: [] }),
    'attention.list': vi.fn().mockResolvedValue({
      items: [
        attention({
          id: 'goal-row',
          threadId: GOAL_THREAD,
          title: 'Approve the release plan',
          createdAt: '2026-10-03T00:00:02.000Z',
        }),
        attention({
          id: 'task-a',
          threadId: TASK_A,
          title: 'Choose a date format',
          createdAt: '2026-10-03T00:00:01.000Z',
        }),
        attention({
          id: 'task-b',
          threadId: TASK_B,
          title: 'Pick a reviewer',
          createdAt: '2026-10-03T00:00:00.000Z',
        }),
      ],
    }),
    'workspace.list': vi.fn().mockResolvedValue({
      items: [
        {
          workspace: { id: WS, name: 'Release', kind: 'general' },
          membershipStatus: 'active',
          accessCause: 'membership',
          isOwner: true,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          membershipRevision: 1,
          registryRevision: 1,
        },
      ],
    }),
    'conversation.targets': vi.fn().mockResolvedValue({ targets: [], defaultTargetRef: null }),
    'artifact.list': vi.fn().mockResolvedValue({ items: [] }),
    'worker-environment.list': vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...(timeline
      ? {
          'thread.timeline': vi.fn(timeline),
          'thread.read-state': vi.fn(async () => ({
            scope: 'window',
            readItemIds: [],
            unreadItemIds: [],
          })),
        }
      : {}),
  };
  const client = {
    core: { meta: vi.fn().mockResolvedValue({}), subscribeTurnEvents: vi.fn() },
    operations,
  } as unknown as CoreClient;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/goals/:workspaceId/:threadId" element={<GoalScreen />} />
            <Route path="/tasks/:workspaceId/:threadId" element={<ThreadScreen mode="task" />} />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { operations, threadItems };
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('openkit.timeline.lens');
  vi.unstubAllGlobals();
});

it('keeps identifiers and banned words out of the Goal screen in Work', async () => {
  mount();
  expect(await screen.findByRole('heading', { name: 'Cards' })).toBeVisible();
  await waitFor(() => expect(document.querySelector('[data-timeline-lens="work"]')).not.toBeNull());
  expect(lintCopyText(document.body.textContent ?? '')).toEqual([]);
  expect(document.body.textContent).not.toMatch(/usr_|th_|tu_|sha256:/);
});

it('does not render linked Task items in the Goal timeline', async () => {
  const { threadItems } = mount();
  expect(await screen.findByRole('heading', { name: 'Cards' })).toBeVisible();
  await waitFor(() => expect(threadItems).toHaveBeenCalled());
  expect(threadItems.mock.calls.map((call) => call[0].threadId)).toEqual([GOAL_THREAD]);
  expect(document.body.textContent).not.toContain(ALPHA);
  expect(document.body.textContent).not.toContain(BETA);
});

it('merges the Goal and Task Needs you rows and labels each Task', async () => {
  mount();
  const user = userEvent.setup();
  const board = await screen.findByRole('heading', { name: 'Cards' });
  const summary = await screen.findByRole('button', { name: /3 need you/ });
  const lens = await screen.findByRole('group', { name: 'Work | Full' });
  expect(board.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(summary.compareDocumentPosition(lens) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(summary);
  const needs = screen.getByRole('region', { name: timelineCopy.needsYouRegion });
  expect(within(needs).getByRole('button', { name: /Approve the release plan/ })).toBeVisible();
  expect(within(needs).getByRole('button', { name: /Choose a date format/ })).toHaveTextContent(
    'Verify release'
  );
  expect(within(needs).getByRole('button', { name: /Pick a reviewer/ })).toHaveTextContent(
    'Write the notes'
  );
});

it('scrolls a Task Needs you row to that card', async () => {
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /3 need you/ }));
  await user.click(screen.getByRole('button', { name: /Choose a date format/ }));
  await waitFor(() => expect(document.getElementById('goal-card-c1')).toHaveFocus());
});

it('describes each Goal action and asks for confirmation only when cancelling', async () => {
  const { operations } = mount();
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Cards' });
  function described(name: string) {
    const button = screen.getAllByRole('button', { name })[0];
    const id = button?.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    return document.getElementById(id!)?.textContent ?? '';
  }
  expect(described('Save intent')).toContain('does not change running Tasks');
  expect(described('Save card')).toContain('does not change running Tasks');
  expect(described('Approve Plan')).toContain('start Tasks inside this plan');
  expect(described('Cancel Goal')).toContain('Stops new work');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Approve Plan' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(operations['goal.plan.approve']).toHaveBeenCalled();
  await user.click(screen.getAllByRole('button', { name: 'Save card' })[0]!);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'Goal cancellation reason' }), 'Stop');
  await user.click(screen.getByRole('button', { name: 'Cancel Goal' }));
  expect(operations['goal.cancel']).not.toHaveBeenCalled();
  expect(await screen.findByRole('dialog')).toHaveTextContent('Stops new work');
  await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));
  await waitFor(() => expect(operations['goal.cancel']).toHaveBeenCalled());
});

it('opens a card Task and comes back to that card', async () => {
  mount();
  const user = userEvent.setup();
  const links = await screen.findAllByRole('link', { name: 'Verify release' });
  await user.click(links[0]!);
  await user.click(await screen.findByRole('link', { name: 'Part of Goal' }));
  await waitFor(() => expect(document.getElementById('goal-card-c1')).toHaveFocus());
});

it('opens the Goal on the card named in the link', async () => {
  mount(view(), `/goals/${WS}/${GOAL_THREAD}?card=c2`);
  await waitFor(() => expect(document.getElementById('goal-card-c2')).toHaveFocus());
});

it('accepts completion without a confirmation dialog', async () => {
  const data = view();
  data.requests[0] = {
    ...data.requests[0]!,
    operation: 'goal.completion.accept',
    exactIntent: {
      candidate: {
        intentRevision: 0,
        intent: 'Review release evidence',
        planVersionId: 'plan-one',
        evidence: [],
        unresolvedWork: ['Publication remains'],
        summary: 'Review release evidence',
      },
    },
  } as (typeof data.requests)[number];
  const { operations } = mount(data);
  const user = userEvent.setup();
  const button = await screen.findByRole('button', { name: 'Accept completion' });
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain(
    'The Goal then closes'
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(button);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(operations['goal.completion.accept']).toHaveBeenCalled());
});

const GOAL_ITEM = 'it_00000000-0000-7da3-a7fc-80982f9b21aa';
const GOAL_TURN = 'tu_00000000-0000-7da3-a7fc-80982f9b21aa';
const GOAL_NOTE = 'Goal narrative follows this note';

it('moves the Goal narrative to the item named in the link', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  const timeline = vi.fn(async (input: { anchor?: { kind?: string; itemId?: string } }) => ({
    workspaceId: WS,
    threadId: GOAL_THREAD,
    view: 'runs',
    runs: [
      {
        id: GOAL_TURN,
        admissionOrder: 1,
        status: 'completed',
        narrative: [
          {
            id: GOAL_ITEM,
            turnId: GOAL_TURN,
            type: 'assistant-message',
            placement: 'narrative',
            status: 'completed',
            createdAt: at,
            completedAt: at,
            actor: null,
            steer: null,
            detail: {
              kind: 'complete',
              value: {
                id: GOAL_ITEM,
                threadId: GOAL_THREAD,
                turnId: GOAL_TURN,
                type: 'assistant-message',
                status: 'completed',
                text: GOAL_NOTE,
                createdAt: at,
              },
            },
          },
        ],
        plan: null,
        noteItemIds: [],
        long: false,
        error: null,
        interruptedBy: { visibility: 'available', actor: null },
        restrictedReferences: false,
        statistics: {
          steps: 0,
          failedStepCount: 0,
          failedCommandCount: 0,
          filesChanged: 0,
          messages: 1,
          itemCounts: {},
          coverage: 'complete',
        },
      },
    ],
    items: [],
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: null,
    catchUpAnchor: null,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
    echoedAnchor: input.anchor ?? null,
  }));
  mount(view(), `/goals/${WS}/${GOAL_THREAD}?item=${GOAL_ITEM}`, timeline);
  await waitFor(() => expect(screen.getByText(GOAL_NOTE)).toBeVisible());
  await waitFor(() => expect(document.activeElement?.id).toBe(`timeline-item-${GOAL_ITEM}`));
  expect(timeline.mock.calls.map((call) => call[0].anchor)).toContainEqual({
    kind: 'item',
    itemId: GOAL_ITEM,
  });
});
