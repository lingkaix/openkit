import {
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ItemSchema, ProductTurnSchema, ThreadSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ThreadStream } from '../ThreadStream';

const WS = 'ws_00000000-0000-7000-8000-0000000000a1';
const THREAD = 'th_00000000-0000-7000-8000-0000000000a1';
const TURN = 'tu_00000000-0000-7000-8000-0000000000a1';
const SAM = 'usr_00000000-0000-7000-8000-0000000000a2';
const VIEWER = 'usr_00000000-0000-7000-8000-0000000000a1';
const AT = '2026-11-13T03:00:00.000Z';
const owner = { kind: 'workspace' as const, workspaceId: WS };

function item(id: string, extra: Record<string, unknown>) {
  return ItemSchema.parse({
    id,
    owner,
    threadId: THREAD,
    turnId: TURN,
    status: 'completed',
    createdAt: AT,
    completedAt: AT,
    ...extra,
  });
}

const executedRequest = item('it_00000000-0000-7000-8000-0000000000b1', {
  type: 'approval-request',
  approvalRequestId: 'ap-executed',
  title: 'Publish the weekly summary',
  description: 'Post the notes once.',
  kind: 'permission',
});
const executedDecision = item('it_00000000-0000-7000-8000-0000000000b2', {
  type: 'approval-decision',
  actor: { kind: 'user', id: SAM },
  causationId: 'cause-executed',
  approvalRequestId: 'ap-executed',
  decision: 'granted',
  decidedAt: AT,
});
const waitingGrant = item('it_00000000-0000-7000-8000-0000000000b3', {
  type: 'approval-request',
  approvalRequestId: 'ap-waiting',
  title: 'Keep this grant open',
  description: 'The effect is not consumed.',
  kind: 'permission',
});
const waitingDecision = item('it_00000000-0000-7000-8000-0000000000b4', {
  type: 'approval-decision',
  actor: { kind: 'user', id: SAM },
  causationId: 'cause-waiting',
  approvalRequestId: 'ap-waiting',
  decision: 'granted',
  decidedAt: AT,
});
const failedGrant = item('it_00000000-0000-7000-8000-0000000000b5', {
  type: 'approval-request',
  approvalRequestId: 'ap-failed',
  title: 'Show the failed effect',
  description: 'The effect failed.',
  kind: 'permission',
});
const failedDecision = item('it_00000000-0000-7000-8000-0000000000b6', {
  type: 'approval-decision',
  actor: { kind: 'user', id: SAM },
  causationId: 'cause-failed',
  approvalRequestId: 'ap-failed',
  decision: 'granted',
  decidedAt: AT,
});
const deniedRequest = item('it_00000000-0000-7000-8000-0000000000b7', {
  type: 'approval-request',
  approvalRequestId: 'ap-denied',
  title: 'Stop the export',
  description: 'Do not run the call.',
  kind: 'permission',
});
const deniedDecision = item('it_00000000-0000-7000-8000-0000000000b8', {
  type: 'approval-decision',
  actor: { kind: 'user', id: SAM },
  causationId: 'cause-denied',
  approvalRequestId: 'ap-denied',
  decision: 'denied',
  decidedAt: AT,
});
const answeredRequest = item('it_00000000-0000-7000-8000-0000000000c1', {
  type: 'user-input-request',
  responsibleUserId: VIEWER,
  userInputRequestId: 'q-answered',
  prompt: 'Which date format?',
  questions: [
    {
      id: 'format',
      header: 'Format',
      question: 'Which date format?',
      options: null,
      isOther: false,
      isSecret: false,
    },
  ],
});
const answeredResponse = item('it_00000000-0000-7000-8000-0000000000c2', {
  type: 'user-input-response',
  actor: { kind: 'user', id: SAM },
  causationId: 'cause-answer',
  userInputRequestId: 'q-answered',
  answers: { format: ['UTC'] },
  answeredAt: AT,
});
const openQuestion = item('it_00000000-0000-7000-8000-0000000000c3', {
  type: 'user-input-request',
  responsibleUserId: VIEWER,
  userInputRequestId: 'q-open',
  prompt: 'What should we do?',
  questions: [
    {
      id: 'next',
      header: 'Next',
      question: 'What should we do?',
      options: null,
      isOther: false,
      isSecret: false,
    },
  ],
});

const records = [
  executedRequest,
  executedDecision,
  waitingGrant,
  waitingDecision,
  failedGrant,
  failedDecision,
  deniedRequest,
  deniedDecision,
  answeredRequest,
  answeredResponse,
  openQuestion,
];

function timelineItem(value: (typeof records)[number]) {
  return {
    id: value.id,
    turnId: value.turnId,
    type: value.type,
    placement: 'narrative' as const,
    status: value.status,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    actor: 'actor' in value ? value.actor : null,
    detail: { kind: 'complete' as const, value },
    steer: null,
  };
}

const timeline = ThreadTimelineResponseSchema.parse({
  workspaceId: WS,
  threadId: THREAD,
  view: 'runs',
  runs: [
    {
      id: TURN,
      admissionOrder: 1,
      status: 'completed',
      triggerActor: { kind: 'user', id: VIEWER },
      agentId: null,
      triggerSource: null,
      startedAt: AT,
      completedAt: AT,
      durationMs: 60_000,
      error: null,
      long: false,
      narrative: records.map(timelineItem),
      plan: null,
      noteItemIds: [],
      finalItemId: null,
      narrativeCursor: null,
      statistics: {
        steps: 0,
        failedStepCount: 0,
        failedCommandCount: 0,
        filesChanged: 0,
        messages: 0,
        itemCounts: {},
        coverage: 'complete',
      },
      planSegments: {
        coverage: 'partial',
        segments: [
          {
            planItemId: 'it_00000000-0000-7000-8000-0000000000d1',
            planRevision: 1,
            stepId: 'fix',
            title: 'Fix formatter',
            startSequence: 1,
            endSequence: null,
            steps: 18,
          },
          {
            planItemId: 'it_00000000-0000-7000-8000-0000000000d1',
            planRevision: 1,
            stepId: 'notes',
            title: 'Write notes',
            startSequence: 19,
            endSequence: 22,
            steps: 4,
          },
        ],
      },
      interruptedBy: { visibility: 'available', actor: null },
      restrictedReferences: false,
    },
  ],
  items: [],
  beforeCursor: null,
  afterCursor: null,
  itemWindow: null,
  anchor: null,
  catchUpAnchor: null,
  earlierUnread: null,
  digest: { lines: [], coverage: 'complete' },
  restrictedReferences: false,
});

const dashboard = ThreadDashboardResponseSchema.parse({
  viewerUserId: VIEWER,
  participants: [{ kind: 'user', id: SAM, displayName: 'Sam' }],
  thread: ThreadSchema.parse({
    id: THREAD,
    owner,
    name: 'Export',
    preview: 'Export',
    status: 'active',
    entryPath: 'conversation',
    visibility: 'workspace',
    createdAt: AT,
    updatedAt: AT,
  }),
  turns: [
    ProductTurnSchema.parse({
      id: TURN,
      owner,
      threadId: THREAD,
      triggerActor: { kind: 'user', id: VIEWER },
      items: [],
      error: null,
      configVersion: null,
      startedAt: AT,
      completedAt: AT,
      durationMs: 60_000,
      status: 'completed',
    }),
  ],
  artifacts: [],
  workStatus: {
    selectedAgentId: null,
    activeTurnStatus: 'completed',
    pendingApprovalCount: 0,
    pendingQuestionCount: 1,
    latestArtifact: null,
  },
  composer: { disabled: false, defaultAgentId: null },
  itemLog: { href: '/api/app/operations/thread.timeline' },
  taskInputs: [],
  pendingRequests: [
    {
      requestId: 'ap-executed',
      state: 'resolved',
      resolution: 'granted',
      ending: null,
      disposition: 'approved-executed',
    },
    {
      requestId: 'ap-waiting',
      state: 'resolved',
      resolution: 'granted',
      ending: null,
      disposition: null,
    },
    {
      requestId: 'ap-failed',
      state: 'resolved',
      resolution: 'granted',
      ending: null,
      disposition: 'execution-error',
    },
    {
      requestId: 'ap-denied',
      state: 'resolved',
      resolution: 'denied',
      ending: null,
      disposition: 'denied-not-executed',
    },
    {
      requestId: 'q-answered',
      state: 'resolved',
      resolution: 'answered',
      ending: null,
      disposition: null,
    },
    {
      requestId: 'q-open',
      state: 'pending',
      resolution: null,
      ending: null,
      disposition: null,
    },
  ],
});

function client(): CoreClient {
  return {
    core: {
      meta: async () => ({}),
      subscribeTurnEvents: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) };
        },
      }),
    },
    operations: {
      'thread.read-state': async () => ({ scope: 'window', readItemIds: [], unreadItemIds: [] }),
      'thread.dashboard': vi.fn(async () => dashboard),
      'thread.timeline': vi.fn(async (input: { view?: string }) => {
        if (input.view === 'items') {
          return ThreadTimelineResponseSchema.parse({
            ...timeline,
            view: 'items',
            runs: [],
            items: [],
          });
        }
        return timeline;
      }),
      'thread.items': vi.fn(async () => ({ items: records, nextCursor: null })),
    },
  } as unknown as CoreClient;
}

function renderStream(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client()}>
        <MemoryRouter>{node}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

const originalObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = '';
    readonly scrollMargin = '';
    readonly thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});

afterEach(() => {
  if (originalObserver) globalThis.IntersectionObserver = originalObserver;
  else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
});

describe('closed decisions and recorded plan intervals', () => {
  it('folds closed approvals and questions and keeps the unsafe grants open', async () => {
    const user = userEvent.setup();
    renderStream(<ThreadStream workspaceId={WS} threadId={THREAD} />);

    const executed = await screen.findByRole('button', { name: 'Approved by Sam · executed' });
    const denied = screen.getByRole('button', { name: 'Denied by Sam · not executed' });
    const answered = screen.getByRole('button', { name: 'Answered by Sam' });
    expect(answered.textContent).not.toMatch(/delivered/i);
    expect(screen.queryByText('Publish the weekly summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop the export')).not.toBeInTheDocument();
    expect(screen.queryByText('Which date format?')).not.toBeInTheDocument();
    expect(screen.getByText('Keep this grant open')).toBeInTheDocument();
    expect(screen.getByText('Show the failed effect')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Next' })).toBeInTheDocument();

    await user.click(executed);
    const executedFold = executed.closest('[data-decision-fold="closed"]');
    expect(executedFold?.querySelectorAll('[data-decision-member]')).toHaveLength(2);
    expect(
      within(executedFold as HTMLElement).getByText('Publish the weekly summary')
    ).toBeVisible();
    expect(screen.queryByText('delivered')).not.toBeInTheDocument();

    await user.click(denied);
    expect(
      denied.closest('[data-decision-fold="closed"]')?.querySelectorAll('[data-decision-member]')
    ).toHaveLength(2);
    expect(screen.getByText('Stop the export')).toBeVisible();

    await user.click(answered);
    const answerFold = answered.closest('[data-decision-fold="closed"]');
    expect(answerFold?.querySelectorAll('[data-decision-member]')).toHaveLength(2);
    expect(within(answerFold as HTMLElement).getByText('Which date format?')).toBeVisible();
    expect(within(answerFold as HTMLElement).getByText('Answered')).toBeVisible();
  });

  it('collapses a finished plan interval onto that interval alone and keeps partial coverage', async () => {
    const user = userEvent.setup();
    renderStream(<ThreadStream workspaceId={WS} threadId={THREAD} />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const list = screen.getByRole('list', { name: 'Plan progress' });
    expect(within(list).getByText('Fix formatter · 18 steps')).toBeInTheDocument();
    expect(screen.getByText('These counts are incomplete.')).toBeInTheDocument();
    const finished = within(list).getByRole('button', { name: 'Write notes · 4 steps' });
    expect(finished).toHaveAttribute('aria-expanded', 'false');
    expect(list.querySelector('[data-plan-members]')).toBeNull();

    await user.click(finished);
    expect(within(list).getAllByText('Write notes · 4 steps')).toHaveLength(1);
    expect(screen.getByText('Interval members are unavailable.')).toBeVisible();
    expect(list.querySelector('[data-plan-member]')).toBeNull();
    expect(within(list).getByText('Fix formatter · 18 steps')).toBeInTheDocument();
    expect(screen.getByText('These counts are incomplete.')).toBeInTheDocument();
  });
});
