import {
  OPERATION_DEFINITIONS,
  type OperationId,
  operationHttpPath,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { ApiErrorSchema, allocateEntityId, ItemSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { useWorkspaceStore } from '../../workspace-store';
import { chatKeys } from '../data';
import { ThreadStream } from '../ThreadStream';

// Owners: conversation_timeline G11/TW2: only the current admitted source may
// supply facts, and a missing part is explicitly unavailable in Full. This
// projection fixture replaces HTTP only; the SDK, hooks and stream stay real.
type Answer = 'admitted' | 'refused' | 'null' | 'omitted' | 'restricted';
const at = '2026-11-08T12:00:00.000Z';
const endedAt = '2026-11-08T12:31:00.000Z';
const modelName = 'Northwind';
const observationText = 'heartbeat 20 s ago · local';
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
  expect(transportErrors.splice(0), 'Every HTTP exchange must satisfy its schema').toEqual([]);
});

function fixture(empty = false) {
  const workspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  const currentTurnId = allocateEntityId('tu');
  const historicalTurnId = allocateEntityId('tu');
  const userId = allocateEntityId('usr');
  const owner = { kind: 'workspace' as const, workspaceId };
  const latest = { kind: 'latest' } as const;
  const historical = { kind: 'turn', turnId: historicalTurnId } as const;
  let answer: Answer = 'admitted';
  const reads: Array<{ operation: OperationId; status: number }> = [];
  const thread = {
    id: threadId,
    owner,
    name: 'Recorded work',
    preview: 'Recorded public work',
    status: 'active',
    visibility: 'workspace',
    entryPath: 'conversation',
    createdAt: at,
    updatedAt: at,
  };
  const admitted = {
    visibility: 'available',
    observationAvailability: 'available',
    observation: {
      phase: 'heartbeat',
      outcome: 'running',
      placement: 'local',
      observedAt: at,
      ageSeconds: 20,
    },
    model: { id: modelName, source: 'turn-admission' },
  };
  function message(turnId: string) {
    const value = ItemSchema.parse({
      id: allocateEntityId('it'),
      owner,
      threadId,
      turnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'Recorded public result',
      createdAt: at,
      completedAt: endedAt,
    });
    return {
      id: value.id,
      turnId,
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
  const currentMessage = message(currentTurnId);
  const historicalMessage = message(historicalTurnId);
  function timeline(input: Record<string, unknown>) {
    const anchor = input.anchor as { kind: string; turnId?: string } | undefined;
    const old = anchor?.kind === 'turn' || input.turnId === historicalTurnId;
    const turnId = old ? historicalTurnId : currentTurnId;
    const item = old ? historicalMessage : currentMessage;
    const itemView = input.view === 'items' || typeof input.cursor === 'string';
    return ThreadTimelineResponseSchema.parse({
      workspaceId,
      threadId,
      view: itemView ? 'items' : 'runs',
      runs: itemView
        ? []
        : [
            {
              id: turnId,
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
              narrative: empty ? [] : [item],
              plan: null,
              noteItemIds: [],
              finalItemId: empty ? null : item.id,
              narrativeCursor: null,
              statistics: {
                steps: 0,
                failedStepCount: 0,
                failedCommandCount: 0,
                filesChanged: 0,
                messages: empty ? 0 : 1,
                itemCounts: empty ? {} : { 'assistant-message': 1 },
                coverage: 'complete',
              },
              usage: null,
              fallback: null,
              planSegments: { segments: [], coverage: 'complete' },
              interruptedBy: { visibility: 'available', actor: null },
              restrictedReferences: false,
            },
          ],
      items: itemView && !empty ? [item] : [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: old && !itemView ? { turnId: historicalTurnId } : null,
      catchUpAnchor: null,
      earlierUnread: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
  }
  function dashboard() {
    return {
      ...(answer === 'omitted'
        ? {}
        : {
            environment:
              answer === 'null'
                ? {
                    ...admitted,
                    observationAvailability: 'unavailable',
                    observation: null,
                    model: null,
                  }
                : answer === 'restricted'
                  ? {
                      visibility: 'restricted',
                      observationAvailability: 'restricted',
                      observation: null,
                      model: null,
                    }
                  : admitted,
          }),
      thread,
      viewerUserId: userId,
      participants: [],
      taskInputs: [],
      turns: [
        {
          id: currentTurnId,
          owner,
          threadId,
          status: 'completed',
          items: [],
          agentId: null,
          triggerActor: { kind: 'user', id: userId },
          error: null,
          configVersion: 1,
          durationMs: 1_860_000,
          startedAt: at,
          completedAt: endedAt,
        },
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
  const handlers: Partial<Record<OperationId, (input: Record<string, unknown>) => unknown>> = {
    'thread.timeline': timeline,
    'thread.dashboard': dashboard,
    'thread.read': () => thread,
    'thread.read-state': () => ({ readItemIds: [], unreadItemIds: [] }),
    'thread.items': () => ({ items: [], nextCursor: null }),
    'attention.list': () => ({ items: [] }),
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
    );
    try {
      if (!name || !handlers[name]) throw new Error(`Unexpected HTTP operation: ${url.pathname}`);
      const definition = OPERATION_DEFINITIONS[name];
      const input = definition.inputSchema.parse(JSON.parse(String(init?.body))) as Record<
        string,
        unknown
      >;
      if (name === 'thread.dashboard' && answer === 'refused') {
        const body = ApiErrorSchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          code: 'not_found',
          message: 'Not found',
        });
        reads.push({ operation: name, status: 404 });
        return new Response(JSON.stringify(body), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = definition.outputSchema.parse(handlers[name]!(input));
      reads.push({ operation: name, status: 200 });
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
    latest,
    historical,
    reads,
    api: createCoreClient({ baseUrl: 'http://openkit.invalid', fetch }),
    setAnswer: (next: Answer) => {
      answer = next;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
function mount(f: Fixture, historical = false) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  caches.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={f.api}>
        <MemoryRouter>
          <ThreadStream
            workspaceId={f.workspaceId}
            threadId={f.threadId}
            mode="task"
            lens="full"
            anchor={historical ? f.historical : f.latest}
          />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return cache;
}
async function ready(cache: QueryClient, f: Fixture) {
  await screen.findAllByRole('article');
  await waitFor(() => {
    expect(cache.isFetching()).toBe(0);
    expect(
      f.reads.some((read) => read.operation === 'thread.dashboard' && read.status === 200)
    ).toBe(true);
  });
  // Dashboard admission may remount the run. Never retain a detached article.
  return () => {
    const article = screen
      .getAllByRole('article')
      .find((node) => !node.parentElement?.closest('article'));
    if (!article) throw new Error('The admitted run article did not mount.');
    return within(article);
  };
}

// Fault injection is at HTTP: this does not claim a native ACL mutation.
it('C2 S1 a refused current dashboard retracts the previously admitted facts', async () => {
  const f = fixture();
  const cache = mount(f);
  const run = await ready(cache, f);
  await waitFor(() => expect(run().getByText(modelName)).toBeInTheDocument());
  expect(run().getByText(observationText)).toBeInTheDocument();
  f.setAnswer('refused');
  await act(async () => {
    await cache.refetchQueries({
      queryKey: chatKeys.dashboard(f.workspaceId, f.threadId),
      exact: true,
    });
  });
  await waitFor(() => {
    expect(cache.isFetching()).toBe(0);
    expect(
      f.reads.some((read) => read.operation === 'thread.dashboard' && read.status === 404)
    ).toBe(true);
  });
  await waitFor(() => {
    expect(
      run().queryByText(modelName),
      'A refused source cannot authorize the cached model'
    ).not.toBeInTheDocument();
    expect(
      run().queryByText(observationText),
      'A refused source cannot authorize the cached observation'
    ).not.toBeInTheDocument();
    expect(
      run().queryAllByText('unavailable'),
      'Full must state that both current facts are unavailable'
    ).toHaveLength(2);
  });
});

it('C2 S2 an empty matching run shows its admitted observation and model', async () => {
  const f = fixture(true);
  const run = await ready(mount(f), f);
  await waitFor(() => {
    expect(
      run().queryByText(modelName),
      'A run need not contain a transcript Item to own its model'
    ).toBeInTheDocument();
    expect(
      run().queryByText(observationText),
      'A run need not contain a transcript Item to own its observation'
    ).toBeInTheDocument();
  });
});

it('C2 S2 an empty historical run states both facts are unavailable', async () => {
  const f = fixture(true);
  const run = await ready(mount(f, true), f);
  await waitFor(() => {
    expect(
      run().queryByText(modelName),
      'The current run model cannot fill history'
    ).not.toBeInTheDocument();
    expect(
      run().queryByText(observationText),
      'The current run observation cannot fill history'
    ).not.toBeInTheDocument();
    expect(
      run().queryAllByText('unavailable'),
      'Unknown historical facts must be stated, not hidden'
    ).toHaveLength(2);
  });
});

for (const answer of ['null', 'omitted', 'restricted'] as const) {
  it(`C2 control current ${answer} fields retract the old admitted facts`, async () => {
    const f = fixture();
    const cache = mount(f);
    const run = await ready(cache, f);
    await waitFor(() => expect(run().getByText(modelName)).toBeInTheDocument());
    expect(run().getByText(observationText)).toBeInTheDocument();
    f.setAnswer(answer);
    await act(async () => {
      await cache.refetchQueries({
        queryKey: chatKeys.dashboard(f.workspaceId, f.threadId),
        exact: true,
      });
    });
    await waitFor(() => expect(cache.isFetching()).toBe(0));
    await waitFor(() => {
      expect(run().queryByText(modelName)).not.toBeInTheDocument();
      expect(run().queryByText(observationText)).not.toBeInTheDocument();
      expect(run().getAllByText('unavailable')).toHaveLength(2);
    });
  });
}
