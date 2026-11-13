import {
  OPERATION_REGISTRY,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ItemSchema, ProductTurnSchema, ThreadSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ThreadStream } from '../ThreadStream';
import { useTimelineWindow } from './use-timeline-window';

function id(kind: string, number: number) {
  return `${kind}_00000000-0000-7000-8000-${number.toString(16).padStart(12, '0')}`;
}
const WS = id('ws', 20);
const THREAD = id('th', 20);
const TURN = id('tu', 20);
const VIEWER = id('usr', 20);
const AT = '2026-11-13T03:00:00.000Z';
const END = '2026-11-13T03:01:00.000Z';
const CURRENT_TEXT = 'Current admitted response';
const OLD_BODY = 'Older dashboard-only activity body';
const UNAVAILABLE = 'Activity coverage is unavailable.';
const owner = { kind: 'workspace' as const, workspaceId: WS };
const thread = ThreadSchema.parse({
  id: THREAD,
  owner,
  name: 'Reported activity oracle',
  preview: 'Reported activity oracle',
  status: 'active',
  entryPath: 'conversation',
  visibility: 'workspace',
  createdAt: AT,
  updatedAt: END,
});
const request = ItemSchema.parse({
  id: id('it', 20),
  owner,
  threadId: THREAD,
  turnId: TURN,
  type: 'user-message',
  actor: { kind: 'user', id: VIEWER },
  text: 'Review the reported activity',
  status: 'completed',
  createdAt: AT,
  completedAt: AT,
});
const answer = ItemSchema.parse({
  id: id('it', 21),
  owner,
  threadId: THREAD,
  turnId: TURN,
  type: 'assistant-message',
  text: CURRENT_TEXT,
  status: 'completed',
  createdAt: END,
  completedAt: END,
});
function dto(value: typeof request | typeof answer) {
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
    argumentDigest: null,
  };
}
const oldActivity = {
  reportedBy: 'worker' as const,
  contentCapture: 'off' as const,
  coverage: 'partial' as const,
  omittedEntryCount: 2,
  entries: [{ sequence: 1, observedAt: AT, kind: 'result' as const, label: 'Child 1' }],
};

function timeline(state: 'old-positive' | 'current-null' | 'current-omitted') {
  const old = state === 'old-positive';
  const run = {
    id: TURN,
    admissionOrder: 1,
    status: old ? 'running' : 'completed',
    triggerActor: { kind: 'user', id: VIEWER },
    agentId: null,
    triggerSource: null,
    startedAt: AT,
    completedAt: old ? null : END,
    durationMs: old ? null : 60_000,
    error: null,
    long: old,
    narrative: (old ? [request] : [request, answer]).map(dto),
    plan: null,
    noteItemIds: [],
    finalItemId: old ? null : answer.id,
    narrativeCursor: null,
    statistics: {
      steps: 0,
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: old ? 1 : 2,
      itemCounts: {},
      coverage: 'complete',
    },
    interruptedBy: { visibility: 'available', actor: null },
    restrictedReferences: false,
    ...(state === 'old-positive'
      ? { reportedActivity: oldActivity }
      : state === 'current-null'
        ? { reportedActivity: null }
        : {}),
  };
  return ThreadTimelineResponseSchema.parse({
    workspaceId: WS,
    threadId: THREAD,
    view: 'runs',
    runs: [run],
    items: [],
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: old ? { turnId: TURN } : null,
    catchUpAnchor: null,
    earlierUnread: null,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  });
}
function emptyItems() {
  return ThreadTimelineResponseSchema.parse({
    ...timeline('current-omitted'),
    view: 'items',
    runs: [],
    items: [],
  });
}
function dashboard(legacy: boolean) {
  return ThreadDashboardResponseSchema.parse({
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
    ...(legacy
      ? {
          runtimeActivity: [
            {
              turnId: TURN,
              contentCapture: 'on',
              coverage: 'partial',
              omittedEntryCount: 0,
              entries: [
                {
                  sequence: 1,
                  observedAt: AT,
                  kind: 'progress',
                  label: 'Older provided report',
                  text: OLD_BODY,
                  textTruncated: false,
                },
              ],
            },
          ],
        }
      : {
          coverage: {
            turns: 'current-run',
            participants: 'current-run',
            artifacts: 'referenced-window',
            taskInputs: 'unavailable',
            runtimeActivity: 'unavailable',
          },
        }),
  });
}

type Operation =
  | 'thread.read'
  | 'thread.read-state'
  | 'thread.mark-read'
  | 'attention.list'
  | 'thread.dashboard'
  | 'thread.items'
  | 'thread.timeline';
function checked(name: Operation, input: unknown, value: unknown) {
  OPERATION_REGISTRY[name].inputSchema.parse(input);
  return OPERATION_REGISTRY[name].outputSchema.parse(value);
}
function transport(state: 'current-null' | 'current-omitted', legacy = false) {
  const current = timeline(state);
  const older = timeline('old-positive');
  const board = dashboard(legacy);
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
      'thread.dashboard': async (input: unknown) => checked('thread.dashboard', input, board),
      'thread.items': async (input: unknown) =>
        checked('thread.items', input, { items: [request, answer], nextCursor: null }),
      'thread.timeline': async (input: unknown) => {
        OPERATION_REGISTRY['thread.timeline'].inputSchema.parse(input);
        const read = input as Record<string, unknown>;
        reads.push(read);
        const anchor = read.anchor as { kind?: string } | undefined;
        return checked(
          'thread.timeline',
          input,
          read.view === 'items' ? emptyItems() : anchor?.kind === 'turn' ? older : current
        );
      },
    },
  } as unknown as CoreClient;
  return { client, reads, current, board };
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
function EarlierThenCurrent() {
  const [current, setCurrent] = useState(false);
  const earlier = useTimelineWindow({
    workspaceId: WS,
    threadId: THREAD,
    anchor: { kind: 'turn', turnId: TURN },
    enabled: !current,
    running: false,
    pending: false,
  });
  if (current) return <ThreadStream workspaceId={WS} threadId={THREAD} lens="full" />;
  return (
    <button type="button" disabled={!earlier.isSuccess} onClick={() => setCurrent(true)}>
      Open current activity window
    </button>
  );
}
async function expectUnavailableInBoth(user: ReturnType<typeof userEvent.setup>) {
  const region = await screen.findByRole('region', { name: 'Reported activity' });
  expect(region).toHaveTextContent(UNAVAILABLE);
  expect(region).not.toHaveAttribute('aria-live');
  expect(within(region).queryByText(/Child 1/)).not.toBeInTheDocument();
  expect(screen.queryByText('2 earlier activity entries not shown.')).not.toBeInTheDocument();
  expect(screen.queryByText(OLD_BODY)).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Runtime activity' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Inspect' }));
  const inspector = await screen.findByRole('complementary', { name: 'Inspector' });
  const inspected = within(inspector).getByRole('region', { name: 'Reported activity' });
  expect(inspected).toHaveTextContent(UNAVAILABLE);
  expect(inspected).not.toHaveAttribute('aria-live');
  expect(within(inspector).queryByText(/Child 1/)).not.toBeInTheDocument();
  expect(within(inspector).queryByText(OLD_BODY)).not.toBeInTheDocument();
  expect(
    within(inspector).queryByRole('region', { name: 'Runtime activity' })
  ).not.toBeInTheDocument();
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

describe('TWPB2 current admitted reported-activity oracles', () => {
  it('S1: a current null report cannot revive an older positive window in Full or Inspector', async () => {
    const user = userEvent.setup();
    const fixture = transport('current-null');
    renderSubject(fixture.client, <EarlierThenCurrent />);
    const open = screen.getByRole('button', { name: 'Open current activity window' });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    await screen.findByText(CURRENT_TEXT);
    await expectUnavailableInBoth(user);
  });

  it('S2a: an omitted report cannot fall back to older dashboard-provided activity', async () => {
    const user = userEvent.setup();
    const fixture = transport('current-omitted', true);
    expect(Object.hasOwn(fixture.current.runs[0]!, 'reportedActivity')).toBe(false);
    renderSubject(fixture.client, <ThreadStream workspaceId={WS} threadId={THREAD} lens="full" />);
    await screen.findByText(CURRENT_TEXT);
    // Wait for either the wrong legacy value or the correct explicit unknown state to paint.
    await waitFor(() =>
      expect(screen.queryByText(OLD_BODY) != null || screen.queryByText(UNAVAILABLE) != null).toBe(
        true
      )
    );
    expect(screen.queryByText(OLD_BODY)).not.toBeInTheDocument();
    await expectUnavailableInBoth(user);
  });

  it('S2b: an omitted report with no older provided value is explicitly unavailable in both surfaces', async () => {
    const user = userEvent.setup();
    const fixture = transport('current-omitted');
    expect(Object.hasOwn(fixture.current.runs[0]!, 'reportedActivity')).toBe(false);
    expect(fixture.board.runtimeActivity).toBeUndefined();
    expect(fixture.board.coverage?.runtimeActivity).toBe('unavailable');
    renderSubject(fixture.client, <ThreadStream workspaceId={WS} threadId={THREAD} lens="full" />);
    await screen.findByText(CURRENT_TEXT);
    await expectUnavailableInBoth(user);
  });
});
