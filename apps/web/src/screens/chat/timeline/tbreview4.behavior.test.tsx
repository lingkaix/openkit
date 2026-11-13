import {
  OPERATION_DEFINITIONS,
  type OperationId,
  type OperationInput,
  operationHttpPath,
  ThreadTimelineResponseSchema,
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
import { SURFACES } from '../../../app/surfaces';
import { KnowledgeScreen } from '../../workspace/KnowledgeScreen';
import { useWorkspaceStore } from '../../workspace-store';
import { ItemView } from '../ItemView';
import { ThreadStream } from '../ThreadStream';
import { useTimelineWindow } from './use-timeline-window';
import type { TimelineAnchorRequest } from './window';

// Spec-owned UI oracles: G11 source admission; request 404 keeps the active view
// but cannot grant Thread access; G18 revisions retain their owning Workspace.
// The real SDK, hooks, QueryClient, routes and renderers consume HTTP doubles.
const caches: QueryClient[] = [];
const transportErrors: string[] = [];
const at = '2026-11-08T12:00:00.000Z';
const endedAt = '2026-11-08T12:31:00.000Z';
const currentText = 'Currently admitted timeline body';
const historicalText = 'Inactive historical timeline body';
const publishedRevision = 'a'.repeat(40);
const sourceHead = 'b'.repeat(40);
const otherHead = 'c'.repeat(40);

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  installBrowserBoundaries();
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
    'Every transport request and response must satisfy its schema'
  ).toEqual([]);
});
const originalMatchMedia = window.matchMedia;
const originalObserver = globalThis.IntersectionObserver;
function installBrowserBoundaries() {
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
}

function fixture(options: { sameTurn?: boolean; recordedEnvironment?: boolean } = {}) {
  const workspaceId = allocateEntityId('ws');
  const otherWorkspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const oldTurnId = options.sameTurn ? turnId : allocateEntityId('tu');
  const userId = allocateEntityId('usr');
  const knowledgeBaseId = allocateEntityId('kb');
  const otherKnowledgeBaseId = allocateEntityId('kb');
  const requestId = crypto.randomUUID();
  const owner = { kind: 'workspace' as const, workspaceId };
  const latest = { kind: 'latest' } as const;
  const historical = { kind: 'turn', turnId: oldTurnId } as const;
  const request = { kind: 'approval-request', approvalRequestId: requestId } as const;
  let environmentUnavailable = false;
  let threadRefused = false;
  const reads: Array<{ operation: OperationId; input: Record<string, unknown>; status: number }> =
    [];
  const historyReads: Array<OperationInput<'knowledge.notebook.history'>> = [];
  const thread = {
    id: threadId,
    owner,
    name: 'Recorded timeline',
    preview: 'Recorded public work',
    status: 'active',
    visibility: 'workspace',
    entryPath: 'conversation',
    createdAt: at,
    updatedAt: at,
  };
  function workspace(id: string) {
    return {
      id,
      name: id === workspaceId ? 'Publication source' : 'Other selected workspace',
      kind: 'general',
      status: 'active',
      counts: { threadCount: id === workspaceId ? 1 : 0, artifactCount: 0, knowledgeEntryCount: 0 },
      createdAt: at,
      updatedAt: at,
    };
  }
  function message(id: string, text: string) {
    const value = ItemSchema.parse({
      id: allocateEntityId('it'),
      owner,
      threadId,
      turnId: id,
      type: 'assistant-message',
      status: 'completed',
      text,
      createdAt: at,
      completedAt: endedAt,
    });
    return {
      id: value.id,
      turnId: id,
      type: value.type,
      placement: 'narrative' as const,
      status: value.status,
      createdAt: at,
      completedAt: endedAt,
      actor: null,
      detail: { kind: 'complete' as const, value },
      steer: null,
      policy: null,
    };
  }
  const oldMessage = message(oldTurnId, historicalText);
  const currentMessage = message(turnId, currentText);
  function timeline(input: Record<string, unknown>) {
    const anchor = input.anchor as TimelineAnchorRequest | undefined;
    if (threadRefused || anchor?.kind === 'approval-request') return refused();
    const itemView = input.view === 'items' || typeof input.cursor === 'string';
    const old = anchor?.kind === 'turn' || (input.turnId === oldTurnId && oldTurnId !== turnId);
    const id = old ? oldTurnId : turnId;
    const item = old ? oldMessage : currentMessage;
    return ThreadTimelineResponseSchema.parse({
      workspaceId,
      threadId,
      view: itemView ? 'items' : 'runs',
      runs: itemView
        ? []
        : [
            {
              id,
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
              narrative: [item],
              plan: null,
              noteItemIds: [],
              finalItemId: item.id,
              narrativeCursor: null,
              statistics: {
                steps: 0,
                failedStepCount: 0,
                failedCommandCount: 0,
                filesChanged: 0,
                messages: 1,
                itemCounts: { 'assistant-message': 1 },
                coverage: 'complete',
              },
              planSegments: { segments: [], coverage: 'complete' },
              usage:
                options.recordedEnvironment && !environmentUnavailable
                  ? {
                      coverage: 'partial',
                      measurements: [
                        {
                          category: 'llm',
                          unit: 'tokens',
                          source: 'llm-gateway-adapter-reported:input',
                          quantity: 7,
                        },
                      ],
                    }
                  : null,
              fallback:
                options.recordedEnvironment && !environmentUnavailable
                  ? { callsWithFallback: 1, coverage: 'complete' }
                  : null,
              interruptedBy: { visibility: 'available', actor: null },
              restrictedReferences: false,
            },
          ],
      items: itemView ? [item] : [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: old && !itemView ? { turnId: oldTurnId } : null,
      catchUpAnchor: null,
      earlierUnread: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
  }
  function dashboard() {
    if (threadRefused) return refused();
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
      itemLog: { href: '/recorded-items' },
    };
  }
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
  const handlers: Partial<Record<OperationId, (input: Record<string, unknown>) => unknown>> = {
    'workspace.list': () => ({
      items: [workspaceId, otherWorkspaceId].map((id) => ({
        workspace: workspace(id),
        isOwner: true,
        membershipStatus: 'active',
        accessCause: 'membership',
        membershipRevision: 1,
        ownerUserId: userId,
        registryRevision: 1,
      })),
    }),
    'thread.timeline': timeline,
    'thread.dashboard': dashboard,
    'thread.read': () => (threadRefused ? refused() : thread),
    'thread.read-state': () =>
      threadRefused ? refused() : { scope: 'window', readItemIds: [], unreadItemIds: [] },
    'conversation.navigation': () => ({ items: [], nextCursor: null }),
    'thread.items': () => (threadRefused ? refused() : { items: [], nextCursor: null }),
    'attention.list': () => ({ items: [] }),
    'knowledge.notebook.list': (input) => ({
      knowledgeBaseId: input.workspaceId === workspaceId ? knowledgeBaseId : otherKnowledgeBaseId,
      notebookRevision: input.workspaceId === workspaceId ? sourceHead : otherHead,
      pages: [],
    }),
    'knowledge.source.list': () => ({ items: [] }),
    'knowledge.indexes': (input) => ({
      linkGraph: { schemaVersion: 1, workspaceId: input.workspaceId, rebuiltAt: at, edges: [] },
      validation: { schemaVersion: 1, workspaceId: input.workspaceId, rebuiltAt: at, records: [] },
      sourceReferences: {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        rebuiltAt: at,
        references: [],
      },
    }),
    'knowledge.notebook.history': (input) => {
      historyReads.push(input as OperationInput<'knowledge.notebook.history'>);
      if (input.workspaceId !== workspaceId) return refused();
      return {
        notebookRevision: sourceHead,
        revisions: [
          {
            revision: publishedRevision,
            parentRevision: null,
            availability: 'available',
            summary: 'The source Notebook publication',
            producer: { kind: 'user', id: userId },
            changedPaths: [],
          },
        ],
        nextRevision: null,
      };
    },
  };
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = new URL(
      typeof resource === 'string' || resource instanceof URL ? String(resource) : resource.url
    );
    if (url.pathname === '/api/meta')
      return new Response(
        JSON.stringify({ protocolVersion: PROTOCOL_VERSION, capabilities: [], eventFamilies: [] }),
        { headers: { 'content-type': 'application/json' } }
      );
    const name = (Object.keys(OPERATION_DEFINITIONS) as OperationId[]).find(
      (operation) => operationHttpPath(operation) === url.pathname
    )!;
    try {
      const definition = OPERATION_DEFINITIONS[name];
      const handle = handlers[name];
      if (!definition || !handle)
        throw new Error(`Unexpected transport operation: ${url.pathname}`);
      const input = definition.inputSchema.parse(JSON.parse(String(init?.body))) as Record<
        string,
        unknown
      >;
      const output = handle(input);
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
  const api = createCoreClient({ baseUrl: 'http://openkit.invalid', fetch });
  function publishedItem() {
    return ItemSchema.parse({
      id: allocateEntityId('it'),
      owner,
      threadId,
      turnId,
      type: 'status',
      status: 'completed',
      level: 'info',
      title: 'Knowledge published',
      summary: 'Published the Notebook',
      createdAt: at,
      completedAt: endedAt,
      knowledgeMaintenanceResult: {
        threadId,
        turnId,
        outcome: 'published',
        notebookRevision: publishedRevision,
        summary: 'Published pages',
      },
    });
  }
  return {
    workspaceId,
    otherWorkspaceId,
    threadId,
    turnId,
    latest,
    historical,
    request,
    api,
    reads,
    historyReads,
    publishedItem,
    withdrawEnvironment: () => {
      environmentUnavailable = true;
    },
    refuseThread: () => {
      threadRefused = true;
    },
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
function mount(
  f: Fixture,
  cache: QueryClient,
  children: ReactNode,
  entry = `/tasks/${f.workspaceId}/${f.threadId}`
) {
  return render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={f.api}>
        <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}
function Stream({ f, anchor }: { f: Fixture; anchor: TimelineAnchorRequest }) {
  return (
    <ThreadStream
      workspaceId={f.workspaceId}
      threadId={f.threadId}
      mode="task"
      lens="full"
      anchor={anchor}
    />
  );
}
function DenialJourney({ f }: { f: Fixture }) {
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
      <button type="button" onClick={() => void read.refetch()}>
        Refresh current authority
      </button>
      <button type="button" onClick={() => setAnchor(f.request)}>
        Open request
      </button>
      <Stream f={f} anchor={anchor} />
    </>
  );
}
function WindowJourney({ f }: { f: Fixture }) {
  const [anchor, setAnchor] = useState<TimelineAnchorRequest>(f.latest);
  return (
    <>
      <button type="button" onClick={() => setAnchor(f.historical)}>
        Visit history
      </button>
      <button type="button" onClick={() => setAnchor(f.latest)}>
        Return to latest
      </button>
      <button type="button" onClick={() => setAnchor(f.request)}>
        Open missing request
      </button>
      <Stream f={f} anchor={anchor} />
    </>
  );
}
function KnowledgeDestination() {
  return (
    <Routes>
      {SURFACES.filter((surface) => surface.id === 'knowledge').map((surface) => (
        <Route key={surface.id} path={surface.path} element={<KnowledgeScreen />} />
      ))}
    </Routes>
  );
}
function requestFinished(f: Fixture) {
  return f.reads.some(
    (read) =>
      read.operation === 'thread.timeline' &&
      read.status === 404 &&
      (read.input.anchor as TimelineAnchorRequest | undefined)?.kind === 'approval-request'
  );
}

describe('TB-REVIEW-4 independent behavioral regressions', () => {
  it('W1 current null usage and fallback cannot recover older cached numbers', async () => {
    const f = fixture({ sameTurn: true, recordedEnvironment: true });
    const cache = queryOwner();
    const old = mount(f, cache, <Stream f={f} anchor={f.historical} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText('at least 7 llm input tokens')).toBeVisible();
      expect(screen.getByText('1 call used a fallback route')).toBeVisible();
    });
    old.unmount();
    f.withdrawEnvironment();
    mount(f, cache, <Stream f={f} anchor={f.latest} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(currentText)).toBeVisible();
    });
    // G11: current null is no admitted number, not permission to reuse history.
    expect
      .soft(
        screen.queryByText('at least 7 llm input tokens'),
        'Current null usage must hide the earlier Audit projection'
      )
      .not.toBeInTheDocument();
    expect(
      screen.queryByText('1 call used a fallback route'),
      'Current null fallback must hide the earlier count'
    ).not.toBeInTheDocument();
  });

  it('W2 an opaque Thread refusal cannot become cached-body success on a request anchor', async () => {
    const f = fixture();
    const cache = queryOwner();
    const user = userEvent.setup();
    mount(f, cache, <DenialJourney f={f} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(currentText)).toBeVisible();
    });
    f.refuseThread();
    await user.click(screen.getByRole('button', { name: 'Refresh current authority' }));
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(
        f.reads.some((read) => read.operation === 'thread.timeline' && read.status === 404)
      ).toBe(true);
      expect(screen.queryByText(currentText)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Open request' }));
    await waitFor(() => {
      expect(requestFinished(f)).toBe(true);
      expect(cache.isFetching()).toBe(0);
    });
    // An opaque 404 may deny the Thread itself. It cannot authorize cached bytes.
    expect(
      screen.queryByText(currentText),
      'A source-refused Thread cannot regain its cached body through a missing-request fallback'
    ).not.toBeInTheDocument();
  });

  it('W3 a missing request preserves the active view, not an inactive cached window', async () => {
    const f = fixture();
    const cache = queryOwner();
    const user = userEvent.setup();
    mount(f, cache, <WindowJourney f={f} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(currentText)).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'Visit history' }));
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(historicalText)).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'Return to latest' }));
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText(currentText)).toBeVisible();
      expect(screen.queryByText(historicalText)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Open missing request' }));
    await waitFor(() => {
      expect(requestFinished(f)).toBe(true);
      expect(cache.isFetching()).toBe(0);
    });
    // Request anchors: 404 keeps the preceding view; it does not select history.
    expect
      .soft(
        screen.queryByText(currentText),
        'The active latest body must remain visible after the missing request'
      )
      .toBeVisible();
    expect(
      screen.queryByText(historicalText),
      'The missing request must not select the inactive historical body'
    ).not.toBeInTheDocument();
  });

  it('W4 a copied publication link reads the Item Workspace after the selection changes', async () => {
    const f = fixture();
    const origin = render(
      <MemoryRouter>
        <ItemView item={f.publishedItem()} />
      </MemoryRouter>
    );
    const href = screen
      .getByRole('link', { name: 'Published notebook revision' })
      .getAttribute('href');
    expect(href).not.toBeNull();
    origin.unmount();
    useWorkspaceStore.getState().setCurrentWorkspaceId(f.workspaceId);
    const controlCache = queryOwner();
    const control = mount(f, controlCache, <KnowledgeDestination />, href!);
    await waitFor(() => {
      expect(controlCache.isFetching()).toBe(0);
      expect(screen.getByText('The source Notebook publication')).toBeVisible();
    });
    control.unmount();
    const earlierReads = f.historyReads.length;
    const cache = queryOwner();
    // Copy a link, switch Workspace, then open the copied destination. Selection
    // is UI state; no server/query data is seeded. The production screen and
    // catalog route choose the addressing scheme, not this oracle.
    useWorkspaceStore.getState().setCurrentWorkspaceId(f.otherWorkspaceId);
    mount(f, cache, <KnowledgeDestination />, href!);
    await waitFor(() => {
      expect(f.historyReads.length).toBeGreaterThan(earlierReads);
      expect(cache.isFetching()).toBe(0);
    });
    const addressed = f.historyReads.at(-1)!;
    // G18: both immutable revision and Workspace identity belong to the Item.
    expect
      .soft(
        addressed.workspaceId,
        'The destination history read must target the Item owner Workspace'
      )
      .toBe(f.workspaceId);
    expect
      .soft(addressed.revision, 'The destination must address the recorded publication revision')
      .toBe(publishedRevision);
    expect(
      screen.queryByText('The source Notebook publication'),
      'The actual Knowledge screen must open the source publication'
    ).toBeVisible();
  });
});
