import {
  OPERATION_DEFINITIONS,
  type OperationId,
  operationHttpPath,
  ThreadTimelineResponseSchema,
  type TimelineItem,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import {
  ApiErrorSchema,
  allocateEntityId,
  ItemSchema,
  PROTOCOL_VERSION,
  ProductTurnSchema,
} from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { useWorkspaceStore } from '../../workspace-store';
import { ThreadStream } from '../ThreadStream';
import { SteerProvider } from './steer-context';
import { useTimelineWindow } from './use-timeline-window';
import type { TimelineAnchorRequest } from './window';

// Conversation Timeline: source admission, exact earlier-unread values, and
// current-window plan coverage. Only HTTP and browser boundaries are doubled.
const at = '2026-11-08T12:00:00.000Z';
const endedAt = '2026-11-08T12:31:00.000Z';
const latestText = 'Latest admitted timeline body';
const historyText = 'Inactive historical timeline body';
const catchUpText = 'Current catch-up timeline body';
const caches: QueryClient[] = [];
const transportErrors: string[] = [];
const originalMatchMedia = window.matchMedia;
const originalObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  window.matchMedia = (media: string) => ({
    matches: media.includes('min-width: 800'),
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  });
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
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  window.matchMedia = originalMatchMedia;
  if (originalObserver) globalThis.IntersectionObserver = originalObserver;
  else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  expect(
    transportErrors.splice(0),
    'All transport inputs and outputs must be schema-valid'
  ).toEqual([]);
});

function fixture(options: { earlier?: 'scoped' | 'absent'; segments?: boolean } = {}) {
  const workspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  const otherThreadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const oldTurnId = allocateEntityId('tu');
  const otherTurnId = allocateEntityId('tu');
  const userId = allocateEntityId('usr');
  const missingItemId = allocateEntityId('it');
  const owner = { kind: 'workspace' as const, workspaceId };
  const latest = { kind: 'latest' } as const;
  const historical = { kind: 'turn', turnId: oldTurnId } as const;
  const catchUp = { kind: 'catch-up' } as const;
  const missing = { kind: 'item', itemId: missingItemId } as const;
  const deniedThreads = new Set<string>();
  const reads: Array<{ operation: OperationId; input: Record<string, unknown>; status: number }> =
    [];
  const thread = {
    id: threadId,
    owner,
    name: 'Recorded timeline',
    preview: 'Recorded work',
    status: 'active',
    visibility: 'workspace',
    entryPath: 'conversation',
    createdAt: at,
    updatedAt: at,
  };
  function message(thread: string, turn: string, text: string): TimelineItem {
    const value = ItemSchema.parse({
      id: allocateEntityId('it'),
      owner,
      threadId: thread,
      turnId: turn,
      type: 'assistant-message',
      status: 'completed',
      text,
      createdAt: at,
      completedAt: endedAt,
    });
    return {
      id: value.id,
      turnId: turn,
      type: value.type,
      placement: 'narrative',
      status: value.status,
      createdAt: at,
      completedAt: endedAt,
      actor: null,
      detail: { kind: 'complete', value },
      steer: null,
      policy: null,
    };
  }
  const currentMessage = message(threadId, turnId, latestText);
  const oldMessage = message(threadId, oldTurnId, historyText);
  const catchUpMessage = message(threadId, turnId, catchUpText);
  const earlierMessage = message(threadId, turnId, 'Earlier unread message before the boundary');
  const otherMessage = message(otherThreadId, otherTurnId, 'Other Thread admitted body');
  const recordedSegments = {
    segments: [
      {
        planItemId: allocateEntityId('it'),
        planRevision: 1,
        stepId: 'work',
        title: 'Earlier admitted plan',
        startSequence: 1,
        endSequence: null,
        steps: 18,
      },
    ],
    coverage: 'complete',
  };
  function refused() {
    return {
      status: 404,
      body: ApiErrorSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        code: 'not_found',
        message: 'Not found',
      }),
    };
  }
  function timeline(input: Record<string, unknown>) {
    const anchor = input.anchor as TimelineAnchorRequest | undefined;
    if (anchor?.kind === 'item' && anchor.itemId === missingItemId) return refused();
    const other = input.threadId === otherThreadId;
    const old = anchor?.kind === 'turn' || input.turnId === oldTurnId;
    const catchingUp = anchor?.kind === 'catch-up';
    const item = other
      ? otherMessage
      : old
        ? oldMessage
        : catchingUp
          ? catchUpMessage
          : currentMessage;
    const itemView = input.view === 'items' || typeof input.cursor === 'string';
    const narrative = options.earlier === 'absent' ? [earlierMessage, item] : [item];
    const boundary = options.earlier ? { turnId: item.turnId, itemId: item.id } : null;
    return ThreadTimelineResponseSchema.parse({
      workspaceId,
      threadId: other ? otherThreadId : threadId,
      view: itemView ? 'items' : 'runs',
      runs: itemView
        ? []
        : [
            {
              id: item.turnId,
              admissionOrder: old ? 1 : 2,
              status: 'completed',
              triggerActor: { kind: 'user', id: userId },
              agentId: null,
              triggerSource: null,
              startedAt: at,
              completedAt: endedAt,
              durationMs: 1_860_000,
              error: null,
              long: true,
              narrative,
              plan: null,
              noteItemIds: [],
              finalItemId: item.id,
              narrativeCursor: null,
              statistics: {
                steps: 0,
                failedStepCount: 0,
                failedCommandCount: 0,
                filesChanged: 0,
                messages: narrative.length,
                itemCounts: { 'assistant-message': narrative.length },
                coverage: 'complete',
              },
              planSegments: options.segments && !catchingUp ? recordedSegments : undefined,
              interruptedBy: { visibility: 'available', actor: null },
              restrictedReferences: false,
            },
          ],
      items: itemView ? narrative : [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: old ? { turnId: oldTurnId } : null,
      catchUpAnchor: boundary,
      earlierUnread:
        options.earlier === 'absent'
          ? undefined
          : options.earlier === 'scoped'
            ? other || !catchingUp
              ? { count: 7, capped: false, oldest: { turnId: item.turnId, itemId: item.id } }
              : { count: 0, capped: false, oldest: null }
            : null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
  }
  function dashboard() {
    return {
      thread,
      viewerUserId: userId,
      participants: [],
      taskInputs: [],
      turns: [
        ProductTurnSchema.parse({
          id: turnId,
          owner,
          threadId,
          status: 'completed',
          items: [],
          agentId: null,
          triggerActor: { kind: 'user', id: userId },
          error: null,
          configVersion: 1,
          durationMs: 1_860_000,
          createdAt: at,
          startedAt: at,
          completedAt: endedAt,
        }),
      ],
      pendingRequests: [],
      artifacts: [],
      runtimeActivity: [],
      workStatus: {
        selectedAgentId: null,
        activeTurnStatus: 'completed',
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
        latestArtifact: null,
      },
      composer: { disabled: false, defaultAgentId: null },
      itemLog: { href: '/recorded-item-log' },
    };
  }
  const handlers: Partial<Record<OperationId, (input: Record<string, unknown>) => unknown>> = {
    'workspace.list': () => ({
      items: [
        {
          workspace: {
            id: workspaceId,
            name: 'Recorded workspace',
            kind: 'general',
            status: 'active',
            counts: { threadCount: 2, artifactCount: 0, knowledgeEntryCount: 0 },
            createdAt: at,
            updatedAt: at,
          },
          isOwner: true,
          membershipStatus: 'active',
          accessCause: 'membership',
          membershipRevision: 1,
          ownerUserId: userId,
          registryRevision: 1,
        },
      ],
    }),
    'thread.timeline': timeline,
    'thread.dashboard': dashboard,
    'thread.read': () => thread,
    'thread.items': () => ({ items: [], nextCursor: null }),
    'thread.read-state': () => ({
      scope: 'window',
      readItemIds: options.earlier === 'absent' ? [currentMessage.id] : [],
      unreadItemIds: options.earlier === 'absent' ? [earlierMessage.id] : [],
    }),
    'conversation.navigation': () => ({ items: [], nextCursor: null }),
    'attention.list': () => ({ items: [] }),
    'conversation.targets': () => ({
      workspaceId,
      threadId,
      targets: [
        {
          targetRef: 'recorded-worker',
          kind: 'running-worker',
          label: 'Worker',
          description: null,
          availability: 'busy',
          unavailableReason: null,
          threadId,
          profileId: null,
          logicalModels: [],
          defaultLogicalModelId: null,
          activeTurnId: turnId,
          steerAvailability: 'available',
          steerUnavailableReason: null,
        },
      ],
      defaultTargetRef: 'recorded-worker',
    }),
  };
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = new URL(
      typeof resource === 'string' || resource instanceof URL ? String(resource) : resource.url
    );
    if (url.pathname === '/api/meta') {
      return new Response(
        JSON.stringify({ protocolVersion: PROTOCOL_VERSION, capabilities: [], eventFamilies: [] }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    const name = (Object.keys(OPERATION_DEFINITIONS) as OperationId[]).find(
      (operation) => operationHttpPath(operation) === url.pathname
    )!;
    try {
      const definition = OPERATION_DEFINITIONS[name];
      const handle = handlers[name];
      if (!definition || !handle) throw new Error(`Unexpected operation: ${url.pathname}`);
      const input = definition.inputSchema.parse(JSON.parse(String(init?.body))) as Record<
        string,
        unknown
      >;
      const output =
        typeof input.threadId === 'string' && deniedThreads.has(input.threadId)
          ? refused()
          : handle(input);
      if (output && typeof output === 'object' && 'status' in output && 'body' in output) {
        const failure = output as ReturnType<typeof refused>;
        reads.push({ operation: name, input, status: failure.status });
        return new Response(JSON.stringify(ApiErrorSchema.parse(failure.body)), {
          status: failure.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = definition.outputSchema.parse(output);
      reads.push({ operation: name, input, status: 200 });
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      transportErrors.push(`${name}: ${String(error)}`);
      throw error;
    }
  };
  return {
    workspaceId,
    threadId,
    otherThreadId,
    latest,
    historical,
    catchUp,
    missing,
    reads,
    api: createCoreClient({ baseUrl: 'http://openkit.invalid', fetch }),
    refuseThread: (id = threadId) => deniedThreads.add(id),
  };
}
type Fixture = ReturnType<typeof fixture>;

function queryOwner() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 300_000 }, mutations: { retry: false } },
  });
  caches.push(cache);
  return cache;
}
function mount(f: Fixture, children: ReactNode) {
  const cache = queryOwner();
  render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={f.api}>
        <MemoryRouter initialEntries={[`/tasks/${f.workspaceId}/${f.threadId}`]}>
          <Routes>
            <Route path="/tasks/:workspaceId/:threadId" element={children} />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return cache;
}
function Stream({ f, anchor }: { f: Fixture; anchor: TimelineAnchorRequest }) {
  return (
    <ThreadStream
      workspaceId={f.workspaceId}
      threadId={f.threadId}
      mode="task"
      lens="work"
      anchor={anchor}
    />
  );
}
function ForeignJourney({ f }: { f: Fixture }) {
  const [open, setOpen] = useState(false);
  const foreign = useTimelineWindow({
    workspaceId: f.workspaceId,
    threadId: f.otherThreadId,
    anchor: f.latest,
    enabled: true,
    running: false,
    pending: false,
  });
  return (
    <>
      <output aria-label="Other source state">
        {foreign.isFetching ? 'checking' : foreign.isError ? 'unavailable' : 'admitted'}
      </output>
      <button type="button" onClick={() => void foreign.refetch()}>
        Refresh other source
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        Open current catch-up
      </button>
      {open ? <Stream f={f} anchor={f.catchUp} /> : null}
    </>
  );
}
function WindowJourney({ f }: { f: Fixture }) {
  const [anchor, setAnchor] = useState<TimelineAnchorRequest>(f.latest);
  const read = useTimelineWindow({
    workspaceId: f.workspaceId,
    threadId: f.threadId,
    anchor,
    enabled: true,
    running: false,
    pending: false,
  });
  return (
    <>
      <output aria-label="Current read state">
        {read.isFetching ? 'checking' : read.isError ? 'unavailable' : 'settled'}
      </output>
      <button type="button" onClick={() => void read.refetch()}>
        Refresh current source
      </button>
      <button type="button" onClick={() => setAnchor(f.historical)}>
        Visit history
      </button>
      <button type="button" onClick={() => setAnchor(f.latest)}>
        Return to latest
      </button>
      <button type="button" onClick={() => setAnchor(f.missing)}>
        Open missing Item
      </button>
      <Stream f={f} anchor={anchor} />
    </>
  );
}
function itemRefusalFinished(f: Fixture) {
  return f.reads.some(
    (read) =>
      read.operation === 'thread.timeline' &&
      read.status === 404 &&
      (read.input.anchor as TimelineAnchorRequest | undefined)?.kind === 'item'
  );
}

describe('TB-REVIEW-5 independent behavior oracle', () => {
  it('W1 a refused observed Thread cannot lend its cached unread count to another Thread', async () => {
    const f = fixture({ earlier: 'scoped' });
    const user = userEvent.setup();
    const cache = mount(f, <ForeignJourney f={f} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Other source state')).toHaveTextContent('admitted')
    );
    f.refuseThread(f.otherThreadId);
    await user.click(screen.getByRole('button', { name: 'Refresh other source' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Other source state')).toHaveTextContent('unavailable')
    );
    await user.click(screen.getByRole('button', { name: 'Open current catch-up' }));
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(catchUpText)).toBeVisible();
    });
    // Source admission: a count is a disclosure; this current read proves zero.
    expect(
      screen.queryByRole('button', { name: '7 earlier unread ›' }),
      'A refused other Thread must not supply the divider count'
    ).not.toBeInTheDocument();
  });

  it('W2 an opaque Thread refusal cannot revive admitted history through an Item anchor', async () => {
    const f = fixture();
    const user = userEvent.setup();
    const cache = mount(f, <WindowJourney f={f} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(latestText)).toBeVisible();
    });
    f.refuseThread();
    await user.click(screen.getByRole('button', { name: 'Refresh current source' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Current read state')).toHaveTextContent('unavailable');
      expect(screen.queryByText(latestText)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Open missing Item' }));
    await waitFor(() => {
      expect(itemRefusalFinished(f)).toBe(true);
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByLabelText('Current read state')).not.toHaveTextContent('checking');
    });
    expect(
      screen.queryByText(latestText),
      'An Item 404 cannot authorize the source-refused body'
    ).not.toBeInTheDocument();
  });

  it('W3 a missing Item keeps the actual current view rather than inactive history', async () => {
    const f = fixture();
    const user = userEvent.setup();
    const cache = mount(f, <WindowJourney f={f} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(latestText)).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'Visit history' }));
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(historyText)).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'Return to latest' }));
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(latestText)).toBeVisible();
      expect(screen.queryByText(historyText)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Open missing Item' }));
    await waitFor(() => {
      expect(itemRefusalFinished(f)).toBe(true);
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByLabelText('Current read state')).not.toHaveTextContent('checking');
    });
    // Thread admission is still available; rejecting all Item 404s is not enough.
    expect
      .soft(
        screen.queryByText(historyText),
        'A missing Item must not select inactive historical content'
      )
      .not.toBeInTheDocument();
    expect(
      screen.queryByText(latestText),
      'The view before the Item jump must stay visible'
    ).toBeVisible();
  });

  it('W4 omitted current plan segments cannot inherit another active window intervals', async () => {
    const f = fixture({ segments: true });
    const cache = mount(
      f,
      <SteerProvider mode="task">
        <Stream f={f} anchor={f.catchUp} />
      </SteerProvider>
    );
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(catchUpText)).toBeVisible();
    });
    // Current-window ownership: an absent field does not recover recorded facts elsewhere.
    expect(
      screen.queryByText('Earlier admitted plan · 18 steps'),
      'The current omitted segments must not recover a different active window interval'
    ).not.toBeInTheDocument();
  });

  it('W5 absent earlierUnread keeps the honest fallback instead of a loaded-window count', async () => {
    const f = fixture({ earlier: 'absent' });
    const cache = mount(f, <Stream f={f} anchor={f.latest} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(latestText)).toBeVisible();
      expect(screen.getByText('Earlier unread message before the boundary')).toBeVisible();
      expect(screen.getByRole('group', { name: 'New since you were here' })).toBeVisible();
    });
    // Catch-up contract: absence, like null, supplies neither count nor oldest.
    expect
      .soft(
        screen.queryByRole('button', { name: /earlier unread/i }),
        'An absent server result cannot expose a client-count jump'
      )
      .not.toBeInTheDocument();
    expect(
      screen.queryByText('Earlier unread is not in this window.'),
      'An absent result must keep the honest fallback'
    ).toBeVisible();
  });
});
