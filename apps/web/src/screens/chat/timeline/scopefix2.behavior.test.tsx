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
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { useWorkspaceStore } from '../../workspace-store';
import { ThreadStream } from '../ThreadStream';
import { useTimelineWindow } from './use-timeline-window';
import type { TimelineAnchorRequest } from './window';

// Conversation Timeline / Degraded Conditions: a cache never authorizes.
// A missing target keeps the actual view only while its Thread remains admitted.
// The real SDK, hooks, QueryClient and renderer run; only HTTP/browser edges are doubled.
const at = '2026-11-08T12:00:00.000Z';
const endedAt = '2026-11-08T12:01:00.000Z';
const currentText = 'The observer latest admitted body';
const historicalText = 'An inactive historical body';
const caches: QueryClient[] = [];
const transportErrors: string[] = [];
type TargetKind = 'request' | 'item';
type Read = { operation: OperationId; input: Record<string, unknown>; status: number };

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media.includes('min-width: 800'),
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  vi.unstubAllGlobals();
  expect(
    transportErrors.splice(0),
    'Every HTTP fixture must satisfy its public operation schema'
  ).toEqual([]);
});

function fixture(kind: TargetKind) {
  const workspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const oldTurnId = allocateEntityId('tu');
  const userId = allocateEntityId('usr');
  const owner = { kind: 'workspace' as const, workspaceId };
  const latest = { kind: 'latest' } as const;
  const historical = { kind: 'turn', turnId: oldTurnId } as const;
  function missingTarget(): TimelineAnchorRequest {
    return kind === 'request'
      ? { kind: 'approval-request', approvalRequestId: crypto.randomUUID() }
      : { kind: 'item', itemId: allocateEntityId('it') };
  }
  const missing = missingTarget();
  const afterRefusal = missingTarget();
  let sourceRefused = false;
  const reads: Read[] = [];
  const thread = {
    id: threadId,
    owner,
    name: 'Recorded source-admission journey',
    preview: 'Previously admitted work',
    status: 'active',
    visibility: 'workspace',
    entryPath: 'conversation',
    createdAt: at,
    updatedAt: at,
  };
  function message(id: string, text: string): TimelineItem {
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
  const currentNote = message(turnId, currentText);
  const historicalNote = message(oldTurnId, historicalText);
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
    if (anchor?.kind === 'approval-request' || anchor?.kind === 'item') return refused();
    const old = anchor?.kind === 'turn' || input.turnId === oldTurnId;
    const item = old ? historicalNote : currentNote;
    const itemView = input.view === 'items' || typeof input.cursor === 'string';
    return ThreadTimelineResponseSchema.parse({
      workspaceId,
      threadId,
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
              durationMs: 60_000,
              error: null,
              long: false,
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
              interruptedBy: { visibility: 'available', actor: null },
              restrictedReferences: false,
            },
          ],
      items: itemView ? [item] : [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: old ? { turnId: oldTurnId } : null,
      catchUpAnchor: null,
      earlierUnread: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
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
            counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
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
    'thread.read': () => thread,
    'thread.items': () => ({ items: [], nextCursor: null }),
    'thread.read-state': () => ({ readItemIds: [], unreadItemIds: [] }),
    'thread.dashboard': () => ({
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
          durationMs: 60_000,
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
    }),
    'attention.list': () => ({ items: [] }),
    'conversation.targets': () => ({ workspaceId, threadId, targets: [], defaultTargetRef: null }),
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
      if (!definition || !handle) throw new Error(`Unexpected HTTP operation: ${url.pathname}`);
      const input = definition.inputSchema.parse(JSON.parse(String(init?.body))) as Record<
        string,
        unknown
      >;
      const output = sourceRefused && input.threadId === threadId ? refused() : handle(input);
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
    latest,
    historical,
    missing,
    afterRefusal,
    reads,
    api: createCoreClient({ baseUrl: 'http://openkit.invalid', fetch }),
    refuseThread: () => {
      sourceRefused = true;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

function Journey({ f }: { f: Fixture }) {
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
      <button type="button" onClick={() => setAnchor(f.historical)}>
        Visit history
      </button>
      <button type="button" onClick={() => setAnchor(f.latest)}>
        Return to latest
      </button>
      <button type="button" onClick={() => setAnchor(f.missing)}>
        Open missing target
      </button>
      <button type="button" onClick={() => setAnchor(f.afterRefusal)}>
        Open target after refusal
      </button>
      <ThreadStream workspaceId={f.workspaceId} threadId={f.threadId} mode="task" anchor={anchor} />
    </>
  );
}
function mount(f: Fixture) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 300_000 }, mutations: { retry: false } },
  });
  caches.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={f.api}>
        <MemoryRouter initialEntries={[`/tasks/${f.workspaceId}/${f.threadId}`]}>
          <Routes>
            <Route path="/tasks/:workspaceId/:threadId" element={<Journey f={f} />} />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return cache;
}
function finishedTarget(f: Fixture, anchor: TimelineAnchorRequest) {
  return f.reads.some(
    (read) =>
      read.operation === 'thread.timeline' &&
      read.status === 404 &&
      Object.entries(anchor).every(
        ([key, value]) =>
          (read.input.anchor as Record<string, unknown> | undefined)?.[key] === value
      )
  );
}

// SCOPE-VERIFY F1: first refusal is the opaque anchor response, not an earlier latest poll.
describe('SCOPEFIX2 direct anchor refusal', () => {
  it.each(['request', 'item'] as const)(
    '%s 404 cannot retain source-refused bytes after a prior admitted view',
    async (kind) => {
      const f = fixture(kind);
      const cache = mount(f);
      const user = userEvent.setup();
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

      // Positive control: missing target, admitted Thread, actual preceding latest view.
      await user.click(screen.getByRole('button', { name: 'Open missing target' }));
      await waitFor(() => {
        expect(finishedTarget(f, f.missing)).toBe(true);
        expect(cache.isFetching()).toBe(0);
        expect(screen.getByText(currentText)).toBeVisible();
        expect(screen.queryByText(historicalText)).not.toBeInTheDocument();
      });
      const beforeReturn = f.reads.length;
      await user.click(screen.getByRole('button', { name: 'Return to latest' }));
      await waitFor(() => {
        expect(
          f.reads
            .slice(beforeReturn)
            .some((read) => read.operation === 'thread.timeline' && read.status === 200)
        ).toBe(true);
        expect(cache.isFetching()).toBe(0);
        expect(screen.getByText(currentText)).toBeVisible();
      });

      f.refuseThread();
      // No latest refresh occurs between refusal and this new target read.
      await user.click(screen.getByRole('button', { name: 'Open target after refusal' }));
      await waitFor(() => {
        expect(finishedTarget(f, f.afterRefusal)).toBe(true);
        expect(cache.isFetching()).toBe(0);
        expect(screen.getByLabelText('Current read state')).not.toHaveTextContent('checking');
      });
      expect(
        screen.queryByText(currentText),
        `${kind}: an opaque anchor 404 cannot authorize the source-refused body`
      ).not.toBeInTheDocument();
    }
  );
});
