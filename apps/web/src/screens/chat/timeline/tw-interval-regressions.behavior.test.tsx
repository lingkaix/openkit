import {
  OPERATION_REGISTRY,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ItemSchema, ProductTurnSchema, ThreadSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
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
      steps: segments.reduce((total, row) => total + row.steps, 0),
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: 1,
      itemCounts: {
        'tool-call': segments.reduce((total, row) => total + row.steps, 0),
        'user-message': 1,
      },
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

type Page = ReturnType<typeof page>;

/** Schema-checked operation doubles; results enter only through the real query hooks. */
function transport(runs: Page, steps: Page, earlierSteps?: Page, earlierRuns?: Page) {
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
        checked('thread.read-state', input, {
          scope: 'window',
          readItemIds: [],
          unreadItemIds: [],
        }),
      'thread.mark-read': async (input: unknown) =>
        checked('thread.mark-read', input, { scope: 'window', acknowledgedItemIds: [] }),
      'attention.list': async (input: unknown) => checked('attention.list', input, { items: [] }),
      'thread.dashboard': async (input: unknown) => checked('thread.dashboard', input, dashboard),
      'thread.items': async (input: unknown) =>
        checked('thread.items', input, { items: [request], nextCursor: null }),
      'thread.timeline': async (input: unknown) => {
        OPERATION_REGISTRY['thread.timeline'].inputSchema.parse(input);
        const read = input as Record<string, unknown>;
        reads.push(read);
        const result =
          read.cursor === 'earlier-steps'
            ? earlierSteps
            : read.cursor === 'earlier-runs'
              ? earlierRuns
              : read.view === 'items'
                ? steps
                : runs;
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

/** Let admitted effects replace transient DOM before exercising a live keyboard disclosure. */
async function settleStream(container: HTMLElement, interval: string) {
  await within(container).findByText('Current admitted request');
  await within(container).findByRole('button', { name: interval });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

async function openInterval(container: HTMLElement, interval: string) {
  const button = within(container).getByRole('button', { name: interval });
  button.focus();
  fireEvent.keyDown(button, { key: 'Enter', code: 'Enter', charCode: 13, keyCode: 13 });
  fireEvent.keyUp(button, { key: 'Enter', code: 'Enter', charCode: 13, keyCode: 13 });
  await waitFor(() =>
    expect(within(container).getByRole('button', { name: interval })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  );
}

function memberIds(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-plan-member]')].map((node) =>
    node.getAttribute('data-plan-member')
  );
}

function planSection(container: HTMLElement) {
  const section = container.querySelector<HTMLElement>('[data-plan-coverage]');
  if (!section) throw new Error('The admitted plan progress section is missing.');
  return section;
}

/** A full newest step page whose interval member exists only on its earlier continuation. */
function olderIntervalFixture(frameCursor: boolean, positionedNarrative: boolean) {
  const base = run(
    [segment(frameCursor ? 'frame-edge' : 'narrative-edge', 'Earlier interval', 2, 7, 1)],
    'complete'
  );
  const current = {
    ...base,
    admissionOrder: frameCursor ? 31 : 1,
    narrative: base.narrative.map((item) => ({
      ...item,
      ...(positionedNarrative ? { firstPublicationSequence: 1 } : {}),
    })),
    statistics: {
      ...base.statistics,
      steps: 51,
      itemCounts: { 'tool-call': 51, 'user-message': 1 },
    },
  };
  const older = frameCursor
    ? Array.from({ length: 30 }, (_, index) => {
        const empty = run([], 'complete');
        return {
          ...empty,
          id: id('tu', 1000 + index),
          admissionOrder: index + 1,
          narrative: [],
          statistics: { ...empty.statistics, messages: 0, itemCounts: {} },
        };
      })
    : [];
  const runs = page([...older, current], [], 'runs', {
    before: frameCursor ? 'earlier-runs' : null,
  });
  const later = Array.from({ length: 50 }, (_, index) =>
    step(200 + index, `Later step ${index}`, 100 + index)
  );
  const earlier = step(2, 'Earlier canonical member', 3);
  return {
    ...transport(
      runs,
      page([], later, 'items', { before: 'earlier-steps' }),
      page([], [earlier], 'items', { after: 'later-steps' }),
      page(older)
    ),
    earlier,
  };
}

/** The interval's continuation is not interchangeable with the outer run-header control. */
async function loadEarlierMember(
  container: HTMLElement,
  fixture: ReturnType<typeof olderIntervalFixture>
) {
  await settleStream(container, 'Earlier interval · 1 steps');
  await openInterval(container, 'Earlier interval · 1 steps');
  await waitFor(() => expect(fixture.reads.some((read) => read.view === 'items')).toBe(true));
  const earlier = await within(planSection(container)).findByRole('button', {
    name: 'Load earlier',
  });
  const before = fixture.reads.length;
  fireEvent.click(earlier, { detail: 0, button: 0 });
  await waitFor(() => expect(fixture.reads.length).toBeGreaterThan(before));
  const continuation = fixture.reads.slice(before).find((read) => read.cursor != null);
  expect(continuation).toMatchObject({
    workspaceId: WS,
    threadId: THREAD,
    cursor: 'earlier-steps',
  });
  expect(continuation?.view).toBeUndefined();
  await waitFor(() => expect(memberIds(container)).toEqual([fixture.earlier.id]));
  expect(within(planSection(container)).getByText('Earlier canonical member')).toBeVisible();
}

describe('TW-INTERVAL independent ownership and cursor regressions', () => {
  it('W1: separates two stream owners, preserves the first member and starts a remount closed', async () => {
    const interval = 'Independent interval · 1 steps';
    const member = step(2, 'Shared canonical member', 3);
    const make = () =>
      transport(
        page([run([segment('independent', 'Independent interval', 2, 7, 1)], 'complete')]),
        page([], [member], 'items')
      );
    const first = renderStream(make().client);
    await settleStream(first.container, interval);
    await openInterval(first.container, interval);
    await waitFor(() => expect(memberIds(first.container)).toEqual([member.id]));

    const secondFixture = make();
    const second = renderStream(secondFixture.client);
    await settleStream(second.container, interval);
    const duringSecond = {
      secondExpanded: within(second.container)
        .getByRole('button', { name: interval })
        .getAttribute('aria-expanded'),
      secondStepReads: secondFixture.reads.filter((read) => read.view === 'items').length,
      firstMembers: memberIds(first.container),
    };
    first.unmount();
    second.unmount();

    const remountFixture = make();
    const remount = renderStream(remountFixture.client);
    await settleStream(remount.container, interval);
    const observed = {
      ...duringSecond,
      remountExpanded: within(remount.container)
        .getByRole('button', { name: interval })
        .getAttribute('aria-expanded'),
      remountStepReads: remountFixture.reads.filter((read) => read.view === 'items').length,
    };
    expect(observed).toEqual({
      secondExpanded: 'false',
      secondStepReads: 0,
      firstMembers: [member.id],
      remountExpanded: 'false',
      remountStepReads: 0,
    });
  });

  it('W2: a positioned earlier narrative does not mask the step-page continuation', async () => {
    const fixture = olderIntervalFixture(false, true);
    const rendered = renderStream(fixture.client);
    await loadEarlierMember(rendered.container, fixture);
  });

  it('W3: a run-frame cursor does not replace the local step-page continuation', async () => {
    const fixture = olderIntervalFixture(true, false);
    const rendered = renderStream(fixture.client);
    await loadEarlierMember(rendered.container, fixture);
  });
});
