import {
  OPERATION_REGISTRY,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ItemSchema, ProductTurnSchema, ThreadSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ThreadStream } from '../ThreadStream';

function id(kind: string, value: number) {
  return `${kind}_00000000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
}
const WS = id('ws', 1);
const THREAD = id('th', 1);
const TURN = id('tu', 1);
const VIEWER = id('usr', 1);
const AT = '2026-11-13T03:00:00.000Z';
const END = '2026-11-13T03:01:00.000Z';
const owner = { kind: 'workspace' as const, workspaceId: WS };
const thread = ThreadSchema.parse({
  id: THREAD,
  owner,
  name: 'Interval membership',
  preview: 'Interval membership',
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

function tool(number: number, name: string) {
  return record(number, {
    type: 'tool-call',
    tool: name,
    server: null,
    arguments: null,
    result: null,
    error: null,
    durationMs: 1,
  });
}

function step(number: number, name: string, sequence: number | null, preview = false) {
  const value = tool(number, name);
  return {
    id: value.id,
    turnId: value.turnId,
    type: value.type,
    placement: 'step' as const,
    status: value.status,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    actor: null,
    firstPublicationSequence: sequence,
    detail: preview
      ? {
          kind: 'preview' as const,
          text: name,
          field: 'result' as const,
          sizeBytes: name.length,
          side: 'head' as const,
          truncated: true,
        }
      : { kind: 'complete' as const, value },
    steer: null,
  };
}

function segment(stepId: string, title: string, start: number, end: number, steps: number) {
  return {
    planItemId: id('it', 90),
    planRevision: 1,
    stepId,
    title,
    startSequence: start,
    endSequence: end,
    steps,
  };
}

function run(segments: ReturnType<typeof segment>[], coverage: 'complete' | 'partial') {
  return {
    id: TURN,
    admissionOrder: 1,
    status: 'completed' as const,
    triggerActor: { kind: 'user' as const, id: VIEWER },
    agentId: null,
    triggerSource: null,
    startedAt: AT,
    completedAt: END,
    durationMs: 60_000,
    error: null,
    long: false,
    narrative: [
      {
        id: request.id,
        turnId: request.turnId,
        type: request.type,
        placement: 'narrative' as const,
        status: request.status,
        createdAt: request.createdAt,
        completedAt: request.completedAt,
        actor: 'actor' in request ? request.actor : null,
        detail: { kind: 'complete' as const, value: request },
        steer: null,
      },
    ],
    plan: null,
    noteItemIds: [],
    finalItemId: null,
    narrativeCursor: null,
    statistics: {
      steps: 0,
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: 1,
      itemCounts: {},
      coverage: 'complete' as const,
    },
    planSegments: { segments, coverage },
    interruptedBy: { visibility: 'available' as const, actor: null },
    restrictedReferences: false,
  };
}

function page(
  runs: unknown[],
  items: unknown[] = [],
  view: 'runs' | 'items' = 'runs',
  cursors: { before?: string | null; after?: string | null } = {}
) {
  return ThreadTimelineResponseSchema.parse({
    workspaceId: WS,
    threadId: THREAD,
    view,
    runs,
    items,
    beforeCursor: cursors.before ?? null,
    afterCursor: cursors.after ?? null,
    itemWindow: null,
    anchor: null,
    catchUpAnchor: null,
    earlierUnread: null,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  });
}

const dashboard = ThreadDashboardResponseSchema.parse({
  thread,
  viewerUserId: VIEWER,
  participants: [],
  turns: [
    ProductTurnSchema.parse({
      id: TURN,
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

function checked(
  name:
    | 'thread.dashboard'
    | 'thread.timeline'
    | 'thread.items'
    | 'thread.read'
    | 'thread.read-state'
    | 'thread.mark-read'
    | 'attention.list',
  input: unknown,
  output: unknown
) {
  OPERATION_REGISTRY[name].inputSchema.parse(input);
  return OPERATION_REGISTRY[name].outputSchema.parse(output);
}

function transport(
  runs: ReturnType<typeof page>,
  steps: ReturnType<typeof page>,
  later?: ReturnType<typeof page>
) {
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
      'thread.dashboard': async (input: unknown) => checked('thread.dashboard', input, dashboard),
      'thread.items': async (input: unknown) =>
        checked('thread.items', input, { items: [request], nextCursor: null }),
      'thread.timeline': async (input: unknown) => {
        OPERATION_REGISTRY['thread.timeline'].inputSchema.parse(input);
        const read = input as Record<string, unknown>;
        reads.push(read);
        const result = read.cursor === 'later-steps' ? later : read.view === 'items' ? steps : runs;
        if (!result) throw new Error('Unexpected timeline page request.');
        return checked('thread.timeline', input, result);
      },
    },
  } as unknown as CoreClient;
  return { client, reads };
}

const clients: QueryClient[] = [];
function renderStream(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <ThreadStream workspaceId={WS} threadId={THREAD} />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
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

function members(stepId: string) {
  const segment = document.querySelector<HTMLElement>(`[data-plan-segment="${stepId}"]`);
  if (!segment) throw new Error(`Missing interval ${stepId}`);
  return [...segment.querySelectorAll<HTMLElement>('[data-plan-member]')];
}

/** One virtual click on the live button. React Aria treats detail 0 as a single press. */
function activate(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }), { detail: 0, button: 0 });
}

describe('finished plan intervals use firstPublicationSequence', () => {
  it('shows the admitted steps inside the interval and leaves an outside step out', async () => {
    const first = step(2, 'First call', 3);
    const preview = step(3, 'Previewed step', 5, true);
    const outside = step(4, 'Outside call', 12);
    const fixture = transport(
      page([run([segment('collect', 'Collect quotes', 2, 7, 2)], 'complete')]),
      page([], [first, preview, outside], 'items')
    );
    renderStream(fixture.client);
    await screen.findByText('Current admitted request');
    await screen.findByRole('button', { name: 'Collect quotes · 2 steps' });
    activate('Collect quotes · 2 steps');
    await waitFor(() => expect(members('collect')).toHaveLength(2));
    expect(members('collect').map((node) => node.textContent)).toEqual([
      expect.stringContaining('First call'),
      expect.stringContaining('Previewed step'),
    ]);
    expect(screen.queryByText('Outside call')).not.toBeInTheDocument();
    expect(document.querySelector(`[data-plan-member="${outside.id}"]`)).toBeNull();
    expect(screen.queryByText('Interval members are unavailable.')).not.toBeInTheDocument();
    expect(screen.queryByText('These counts are incomplete.')).not.toBeInTheDocument();
  });

  it('keeps a revised item at its first position', async () => {
    const revised = step(2, 'Revised formatter', 4);
    const shipped = step(3, 'Ship the note', 9);
    const fixture = transport(
      page([
        run(
          [
            segment('format', 'Format notes', 2, 7, 1),
            segment('publish', 'Publish notes', 7, 12, 1),
          ],
          'complete'
        ),
      ]),
      page([], [revised, shipped], 'items')
    );
    renderStream(fixture.client);
    await screen.findByText('Current admitted request');
    await screen.findByRole('button', { name: 'Format notes · 1 steps' });
    activate('Format notes · 1 steps');
    await waitFor(() => expect(members('format')).toHaveLength(1));
    await screen.findByRole('button', { name: 'Publish notes · 1 steps' });
    activate('Publish notes · 1 steps');
    await waitFor(() => expect(members('publish')).toHaveLength(1));
    expect(members('format')[0]).toHaveTextContent('Revised formatter');
    expect(members('publish')[0]).toHaveTextContent('Ship the note');
    expect(members('publish')[0]).not.toHaveTextContent('Revised formatter');
    expect(members('format')[0]).not.toHaveTextContent('Ship the note');
    expect(screen.queryByText('These counts are incomplete.')).not.toBeInTheDocument();
    expect(screen.queryByText('Interval members are unavailable.')).not.toBeInTheDocument();
  });

  it('excludes a null position and keeps the server count with the partial note', async () => {
    const placed = step(2, 'Placed call', 4);
    const unplaced = step(3, 'Unplaced call', null);
    const fixture = transport(
      page([run([segment('place', 'Place calls', 2, 7, 2)], 'complete')]),
      page([], [placed, unplaced], 'items')
    );
    renderStream(fixture.client);
    await screen.findByText('Current admitted request');
    await screen.findByRole('button', { name: 'Place calls · 2 steps' });
    activate('Place calls · 2 steps');
    await waitFor(() => expect(members('place')).toHaveLength(1));
    expect(members('place')[0]).toHaveTextContent('Placed call');
    expect(screen.queryByText('Unplaced call')).not.toBeInTheDocument();
    expect(document.querySelector(`[data-plan-member="${unplaced.id}"]`)).toBeNull();
    expect(screen.getByRole('button', { name: 'Place calls · 2 steps' })).toBeVisible();
    expect(screen.getByText('These counts are incomplete.')).toBeVisible();
    expect(screen.queryByText('Interval members are unavailable.')).not.toBeInTheDocument();
  });

  it('says membership is partial when the interval crosses the loaded step page', async () => {
    const visible = step(2, 'Visible step', 5);
    const runs = page([run([segment('walk', 'Walk the log', 2, 20, 1)], 'complete')]);
    const steps = page([], [visible], 'items', { after: 'later-steps' });
    const later = page([], [visible], 'items');
    const fixture = transport(runs, steps, later);
    renderStream(fixture.client);
    await screen.findByText('Current admitted request');
    await screen.findByRole('button', { name: 'Walk the log · 1 steps' });
    activate('Walk the log · 1 steps');
    await waitFor(() => expect(members('walk')).toHaveLength(1));
    expect(members('walk')[0]).toHaveTextContent('Visible step');
    expect(screen.getByText('These counts are incomplete.')).toBeVisible();
    expect(screen.queryByText('Hidden step')).not.toBeInTheDocument();
    const before = fixture.reads.length;
    activate('Load later');
    await waitFor(() => expect(fixture.reads.length).toBeGreaterThan(before));
    const read = fixture.reads.at(-1);
    expect(read?.cursor).toBe('later-steps');
    expect(read?.view).toBeUndefined();
    expect(screen.queryByText('Hidden step')).not.toBeInTheDocument();
    expect(members('walk')).toHaveLength(1);
  });
});
