import {
  ListHumanAttentionResponseSchema,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ProductTurnSchema, ThreadSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ThreadStream } from '../ThreadStream';
import { clearDashboardClockSamples } from './clock-offset';

const WS = 'ws_00000000-0000-7000-8000-0000000000c1';
const THREAD = 'th_00000000-0000-7000-8000-0000000000c1';
const TURN = 'tu_00000000-0000-7000-8000-0000000000c1';
const ITEM = 'it_00000000-0000-7000-8000-0000000000c1';
const VIEWER = 'usr_00000000-0000-7000-8000-0000000000c1';
const SERVER = Date.parse('2026-11-13T03:00:00.000Z');
const MINUTE = 60 * 1000;
const owner = { kind: 'workspace' as const, workspaceId: WS };

const timeline = ThreadTimelineResponseSchema.parse({
  workspaceId: WS,
  threadId: THREAD,
  view: 'runs',
  runs: [],
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

function dashboard(serverTime: string | null) {
  const started = new Date(SERVER - 40 * MINUTE).toISOString();
  return ThreadDashboardResponseSchema.parse({
    ...(serverTime ? { serverTime } : {}),
    viewerUserId: VIEWER,
    participants: [],
    thread: ThreadSchema.parse({
      id: THREAD,
      owner,
      name: 'Clock',
      preview: 'Clock',
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: started,
      updatedAt: started,
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
        startedAt: started,
        completedAt: null,
        durationMs: null,
        status: 'running',
      }),
    ],
    now: {
      turnId: TURN,
      status: 'running',
      step: {
        itemId: ITEM,
        kind: 'command-execution',
        title: null,
        startedAt: started,
      },
      lastEventAt: started,
      queuePosition: null,
      stepsReportedLive: true,
    },
    artifacts: [],
    workStatus: {
      selectedAgentId: null,
      activeTurnStatus: 'running',
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

function attention() {
  return ListHumanAttentionResponseSchema.parse({
    items: [
      {
        id: 'note-ready',
        kind: 'budget',
        workspaceId: WS,
        threadId: THREAD,
        title: 'Review the weekly notes',
        summary: 'The notes are ready to review',
        severity: 'info',
        createdAt: new Date(SERVER - 10 * MINUTE).toISOString(),
        source: {
          type: 'protocol_item',
          itemType: 'status',
          workspaceId: WS,
          threadId: THREAD,
          turnId: TURN,
          itemId: ITEM,
        },
        actions: [],
      },
    ],
  });
}

function client(samples: readonly (string | null)[]): CoreClient {
  let call = 0;
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
      'thread.dashboard': async () => {
        const sample = samples[Math.min(call, samples.length - 1)] ?? null;
        call += 1;
        return dashboard(sample);
      },
      'thread.timeline': async () => timeline,
      'thread.items': async () => ({ items: [], nextCursor: null }),
      'attention.list': async () => attention(),
      'conversation.targets': async () => ({ targets: [], defaultTargetRef: null }),
    },
  } as unknown as CoreClient;
}

function renderStream(samples: readonly (string | null)[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client(samples)}>
        <MemoryRouter>
          <ThreadStream workspaceId={WS} threadId={THREAD} />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { queryClient, ...render(node) };
}

beforeEach(() => {
  clearDashboardClockSamples();
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
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 800'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  cleanup();
  clearDashboardClockSamples();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('server clock correction', () => {
  it('keeps a 40-minute command and a 10-minute age when the client clock is ahead', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER + 5 * MINUTE);
    renderStream([new Date(SERVER).toISOString()]);

    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    const age = screen.getByText('10 min ago');
    expect(age.closest('time')).toHaveAttribute(
      'datetime',
      new Date(SERVER - 10 * MINUTE).toISOString()
    );
    expect(screen.queryByText(/45 min/)).not.toBeInTheDocument();
    expect(screen.queryByText(/server clock|corrected|synchronized/i)).not.toBeInTheDocument();
  });

  it('keeps a 40-minute command and a 10-minute age when the client clock is behind', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER - 5 * MINUTE);
    renderStream([new Date(SERVER).toISOString()]);

    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    expect(screen.getByText('10 min ago')).toBeInTheDocument();
    expect(screen.queryByText(/35 min/)).not.toBeInTheDocument();
    expect(screen.queryByText(/5 min ago/)).not.toBeInTheDocument();
  });

  it('keeps the client clock when the dashboard has no server time sample', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER + 5 * MINUTE);
    renderStream([null]);

    expect(await screen.findByText('Running a command · 45 min')).toBeInTheDocument();
    expect(screen.getByText('15 min ago')).toBeInTheDocument();
    expect(screen.queryByText('Running a command · 40 min')).not.toBeInTheDocument();
    expect(screen.queryByText(/server clock|corrected|synchronized/i)).not.toBeInTheDocument();
  });

  it('follows the fresh sample when a later admitted read has a different server clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SERVER + 5 * MINUTE);
    const view = renderStream([
      new Date(SERVER).toISOString(),
      new Date(SERVER + 5 * MINUTE).toISOString(),
    ]);

    expect(await screen.findByText('Running a command · 40 min')).toBeInTheDocument();
    await view.queryClient.invalidateQueries({ queryKey: ['thread-dashboard', WS, THREAD] });
    expect(await screen.findByText('Running a command · 45 min')).toBeInTheDocument();
    expect(screen.queryByText('Running a command · 40 min')).not.toBeInTheDocument();
    expect(screen.getByText('15 min ago').closest('time')).toHaveAttribute(
      'datetime',
      new Date(SERVER - 10 * MINUTE).toISOString()
    );
  });
});
