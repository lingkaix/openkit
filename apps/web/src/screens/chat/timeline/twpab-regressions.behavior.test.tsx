import {
  OPERATION_REGISTRY,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ItemSchema, ProductTurnSchema, ThreadSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ThreadStream } from '../ThreadStream';
import { useRunItemWindow } from './use-timeline-window';

function id(kind: string, value: number) {
  return `${kind}_00000000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
}
const WS = id('ws', 1);
const THREAD = id('th', 1);
const TURN = id('tu', 1);
const LATER = id('tu', 2);
const VIEWER = id('usr', 1);
const AT = '2026-11-13T03:00:00.000Z';
const END = '2026-11-13T03:01:00.000Z';
const SAME = `sha256:${'a'.repeat(64)}`;
const TOOL = 'Check publication';
const RETRY = 'Tried 2×, succeeded on the last';
const owner = { kind: 'workspace' as const, workspaceId: WS };
const thread = ThreadSchema.parse({
  id: THREAD,
  owner,
  name: 'Timeline oracle',
  preview: 'Timeline oracle',
  status: 'active',
  entryPath: 'conversation',
  visibility: 'workspace',
  createdAt: AT,
  updatedAt: END,
});

function record(number: number, extra: Record<string, unknown>) {
  return ItemSchema.parse({
    id: id('it', number),
    owner,
    threadId: THREAD,
    turnId: TURN,
    status: 'completed',
    createdAt: AT,
    completedAt: END,
    ...extra,
  });
}
const request = record(1, {
  type: 'user-message',
  actor: { kind: 'user', id: VIEWER },
  text: 'Current admitted request',
});
const first = record(2, {
  type: 'tool-call',
  tool: TOOL,
  server: null,
  arguments: null,
  result: null,
  error: 'The first attempt failed.',
  durationMs: 1,
  status: 'failed',
});
const second = record(3, {
  type: 'tool-call',
  tool: TOOL,
  server: null,
  arguments: { publication: 'weekly' },
  result: 'ok',
  error: null,
  durationMs: 1,
});
const olderFirst = ItemSchema.parse({
  ...first,
  arguments: { publication: 'weekly' },
});
const laterAnswer = record(4, {
  type: 'assistant-message',
  turnId: LATER,
  text: 'Later completed answer',
});

type RecordItem = ReturnType<typeof record>;
function dto(value: RecordItem, digest: string | null = null, sequence?: number | null) {
  return {
    id: value.id,
    turnId: value.turnId,
    type: value.type,
    placement:
      value.type === 'tool-call' || value.type === 'command-execution'
        ? ('step' as const)
        : ('narrative' as const),
    status: value.status,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    actor: 'actor' in value ? value.actor : null,
    ...(sequence !== undefined ? { firstPublicationSequence: sequence } : {}),
    detail: { kind: 'complete' as const, value },
    steer: null,
    argumentDigest: digest,
  };
}

function run(turnId = TURN, narrative: RecordItem[] = [request]) {
  return {
    id: turnId,
    admissionOrder: turnId === TURN ? 1 : 2,
    status: 'completed' as const,
    triggerActor: { kind: 'user' as const, id: VIEWER },
    agentId: null,
    triggerSource: null,
    startedAt: AT,
    completedAt: END,
    durationMs: 60_000,
    error: null,
    long: false,
    narrative: narrative.map((value) => dto(value)),
    plan: null,
    noteItemIds: [],
    finalItemId: narrative.at(-1)?.type === 'assistant-message' ? narrative.at(-1)!.id : null,
    narrativeCursor: null,
    statistics: {
      steps: 0,
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: narrative.length,
      itemCounts: {},
      coverage: 'complete' as const,
    },
    interruptedBy: { visibility: 'available' as const, actor: null },
    restrictedReferences: false,
  };
}

function page(runs: unknown[], items: unknown[] = [], view: 'runs' | 'items' = 'runs') {
  return ThreadTimelineResponseSchema.parse({
    workspaceId: WS,
    threadId: THREAD,
    view,
    runs,
    items,
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: null,
    catchUpAnchor: null,
    earlierUnread: null,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  });
}
function dashboard(turnId = TURN) {
  return ThreadDashboardResponseSchema.parse({
    thread,
    viewerUserId: VIEWER,
    participants: [],
    turns: [
      ProductTurnSchema.parse({
        id: turnId,
        owner,
        threadId: THREAD,
        triggerActor: { kind: 'user', id: VIEWER },
        agentId: null,
        configVersion: null,
        items: [],
        status: 'completed',
        startedAt: AT,
        completedAt: END,
        durationMs: 60_000,
        error: null,
      }),
    ],
    artifacts: [],
    workStatus: {
      selectedAgentId: null,
      activeTurnStatus: 'completed',
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      latestArtifact: null,
    },
    composer: { disabled: false, defaultAgentId: null },
    itemLog: { href: '/api/app/operations/thread.timeline' },
    taskInputs: [],
    pendingRequests: [],
  });
}

type TimelinePage = ReturnType<typeof page>;
type CheckedOperation =
  | 'thread.dashboard'
  | 'thread.timeline'
  | 'thread.items'
  | 'thread.read'
  | 'thread.read-state'
  | 'thread.mark-read'
  | 'attention.list';
function checked(name: CheckedOperation, input: unknown, output: unknown) {
  OPERATION_REGISTRY[name].inputSchema.parse(input);
  return OPERATION_REGISTRY[name].outputSchema.parse(output);
}
function transport(options: {
  runs: TimelinePage;
  dashboard?: ReturnType<typeof dashboard>;
  currentItems?: TimelinePage;
  olderItems?: TimelinePage;
}) {
  const reads: Array<Record<string, unknown>> = [];
  const client = {
    core: {
      subscribeTurnEvents: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) };
        },
      }),
    },
    operations: {
      'thread.read': async (input: unknown) => checked('thread.read', input, thread),
      'thread.read-state': async (input: unknown) =>
        checked('thread.read-state', input, { readItemIds: [], unreadItemIds: [] }),
      'thread.mark-read': async (input: unknown) =>
        checked('thread.mark-read', input, { readItemIds: [], unreadItemIds: [] }),
      'attention.list': async (input: unknown) => checked('attention.list', input, { items: [] }),
      'thread.dashboard': async (input: unknown) =>
        checked('thread.dashboard', input, options.dashboard ?? dashboard()),
      'thread.items': async (input: unknown) =>
        checked('thread.items', input, { items: [request], nextCursor: null }),
      'thread.timeline': async (input: unknown) => {
        OPERATION_REGISTRY['thread.timeline'].inputSchema.parse(input);
        const read = input as Record<string, unknown>;
        reads.push(read);
        const result =
          read.cursor === 'older-step-page'
            ? options.olderItems
            : read.view === 'items'
              ? (options.currentItems ?? page([], [], 'items'))
              : options.runs;
        if (!result) throw new Error('Unexpected timeline page request.');
        return checked('thread.timeline', input, result);
      },
    },
  } as unknown as CoreClient;
  return { client, reads };
}

const clients: QueryClient[] = [];
function renderSubject(client: CoreClient, children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

/** Prime an earlier page only through the production step-read hook, then leave it behind. */
function EarlierThenCurrent() {
  const [current, setCurrent] = useState(false);
  const old = useRunItemWindow({
    workspaceId: WS,
    threadId: THREAD,
    turnId: TURN,
    placement: 'step',
    cursor: 'older-step-page',
    enabled: !current,
  });
  if (current) return <ThreadStream workspaceId={WS} threadId={THREAD} lens="full" />;
  return (
    <button type="button" disabled={!old.isSuccess} onClick={() => setCurrent(true)}>
      Open current admitted window
    </button>
  );
}

const originalObserver = globalThis.IntersectionObserver;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
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
  for (const client of clients.splice(0)) client.clear();
  if (originalObserver) globalThis.IntersectionObserver = originalObserver;
  else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
});

describe('TWPAB current-source regression oracles', () => {
  it('S1: current null digest from the real step read cannot inherit an older window retry', async () => {
    const user = userEvent.setup();
    const current = run();
    current.statistics.steps = 2;
    current.statistics.failedStepCount = 1;
    const fixture = transport({
      runs: page([current]),
      olderItems: page([], [dto(olderFirst, SAME)], 'items'),
      currentItems: page([], [dto(first, null), dto(second, SAME)], 'items'),
    });
    renderSubject(fixture.client, <EarlierThenCurrent />);
    const open = screen.getByRole('button', { name: 'Open current admitted window' });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    await screen.findByText('Current admitted request');
    await waitFor(() =>
      expect(fixture.reads.some((read) => read.view === 'items' && read.cursor == null)).toBe(true)
    );
    const entry = document.querySelector<HTMLElement>(`[data-timeline-entry="${TURN}"]`)!;
    // Wait for either the real source rows or the erroneous collapsed retry; do not pass before the read paints.
    await waitFor(() =>
      expect(
        within(entry).queryAllByText(TOOL, { exact: true }).length === 2 ||
          within(entry).queryByRole('button', { name: RETRY }) != null
      ).toBe(true)
    );
    expect(within(entry).queryByRole('button', { name: RETRY })).not.toBeInTheDocument();
    expect(within(entry).getAllByText(TOOL, { exact: true })).toHaveLength(2);
  });

  it('S2a: a proved interval member is shown and an out-of-range item is not fabricated', async () => {
    const reviewed = record(5, {
      type: 'tool-call',
      tool: 'Reviewed entry',
      server: null,
      arguments: null,
      result: null,
      error: null,
      durationMs: 1,
    });
    const laterExport = record(6, {
      type: 'tool-call',
      tool: 'Later export',
      server: null,
      arguments: null,
      result: null,
      error: null,
      durationMs: 1,
    });
    const interval = {
      planItemId: id('it', 10),
      planRevision: 1,
      stepId: 'review',
      title: 'Review entries',
      startSequence: 1,
      endSequence: 4,
      steps: 2,
    };
    const fixture = transport({
      runs: page([{ ...run(), planSegments: { segments: [interval], coverage: 'partial' } }]),
      currentItems: page([], [dto(reviewed, null, 2), dto(laterExport, null, 8)], 'items'),
    });
    renderSubject(fixture.client, <ThreadStream workspaceId={WS} threadId={THREAD} />);
    await screen.findByText('Current admitted request');
    const planList = () => screen.getByRole('list', { name: 'Plan progress' });
    await within(planList()).findByRole('button', { name: 'Review entries · 2 steps' });
    fireEvent.click(within(planList()).getByRole('button', { name: 'Review entries · 2 steps' }), {
      detail: 0,
      button: 0,
    });
    const member = await within(planList()).findByText('Reviewed entry');
    expect(member.closest('[data-plan-member]')).not.toBeNull();
    expect(planList().querySelectorAll('[data-plan-member]')).toHaveLength(1);
    expect(screen.queryByText('Later export')).not.toBeInTheDocument();
    expect(screen.queryByText('Interval members are unavailable.')).not.toBeInTheDocument();
    expect(within(planList()).getAllByText('Review entries · 2 steps')).toHaveLength(1);
    expect(screen.getByText('These counts are incomplete.')).toBeVisible();
  });

  it('S2b: a historical failed run uses its own owner presentation with a latest-only dashboard', async () => {
    const summary = 'The earlier run could not complete its system operation.';
    const earlier = {
      ...run(),
      status: 'failed',
      error: {
        code: 'worker_governance_turn_failed',
        message: 'Retained technical error, not owner copy.',
        presentation: {
          class: 'system',
          summary,
          actions: [
            {
              kind: 'inspect',
              owner: 'turn',
              operation: 'turn.read',
              input: { workspaceId: WS, threadId: THREAD, turnId: TURN },
            },
          ],
        },
      },
    };
    const fixture = transport({
      runs: page([earlier, run(LATER, [laterAnswer])]),
      dashboard: dashboard(LATER),
    });
    renderSubject(fixture.client, <ThreadStream workspaceId={WS} threadId={THREAD} />);
    await screen.findByText('Later completed answer');
    const text = await screen.findByText(summary);
    const entry = text.closest<HTMLElement>(`[data-timeline-entry="${TURN}"]`)!;
    expect(entry).not.toBeNull();
    const inspect = within(entry).getByRole('link', { name: 'Inspect this run' });
    expect(inspect).toHaveAttribute('href', expect.stringContaining(`turn=${TURN}`));
    expect(text.closest('[data-owner-error="system"]')).not.toBeNull();
    expect(
      within(entry).queryByText('Retained technical error, not owner copy.')
    ).not.toBeInTheDocument();
    const latest = document.querySelector<HTMLElement>(`[data-timeline-entry="${LATER}"]`)!;
    expect(within(latest).queryByText(summary)).not.toBeInTheDocument();
  });
});
