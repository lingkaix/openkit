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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ThreadStream } from '../ThreadStream';

const WS = 'ws_00000000-0000-7000-8000-0000000000b1';
const THREAD = 'th_00000000-0000-7000-8000-0000000000b1';
const TURN = 'tu_00000000-0000-7000-8000-0000000000b1';
const VIEWER = 'usr_00000000-0000-7000-8000-0000000000b1';
const owner = { kind: 'workspace' as const, workspaceId: WS };
const SAME = `sha256:${'a'.repeat(64)}`;
const RETRY = `sha256:${'b'.repeat(64)}`;
const OTHER = `sha256:${'c'.repeat(64)}`;

function at(minute: number): string {
  return `2026-11-13T03:${String(minute).padStart(2, '0')}:00.000Z`;
}

function record(id: string, minute: number, extra: Record<string, unknown>) {
  return ItemSchema.parse({
    id,
    owner,
    threadId: THREAD,
    turnId: TURN,
    status: 'completed',
    createdAt: at(minute),
    completedAt: at(minute),
    ...extra,
  });
}

const note = record('it_00000000-0000-7000-8000-0000000000b1', 0, {
  type: 'user-message',
  actor: { kind: 'user', id: VIEWER },
  text: 'Please check CI',
});
const repeatIds = [
  'it_00000000-0000-7000-8000-0000000000b2',
  'it_00000000-0000-7000-8000-0000000000b3',
  'it_00000000-0000-7000-8000-0000000000b4',
] as const;
const repeats = repeatIds.map((id, index) =>
  record(id, index * 3, {
    type: 'tool-call',
    status: 'failed',
    tool: 'check status',
    server: null,
    arguments: { name: 'ci' },
    result: null,
    error: 'failing',
    durationMs: 10,
  })
);
const unmatched = record('it_00000000-0000-7000-8000-0000000000b5', 7, {
  type: 'tool-call',
  tool: 'check status',
  server: null,
  arguments: null,
  result: 'ok',
  error: null,
  durationMs: 10,
});
const other = record('it_00000000-0000-7000-8000-0000000000b6', 8, {
  type: 'tool-call',
  status: 'failed',
  tool: 'check status',
  server: null,
  arguments: { name: 'other' },
  result: null,
  error: 'different',
  durationMs: 10,
});
const failedCommand = record('it_00000000-0000-7000-8000-0000000000b7', 9, {
  type: 'command-execution',
  status: 'failed',
  command: 'npm test',
  cwd: '/repo',
  output: '',
  exitCode: 1,
  durationMs: 10,
});
const succeededCommand = record('it_00000000-0000-7000-8000-0000000000b8', 10, {
  type: 'command-execution',
  command: 'npm test',
  cwd: '/repo',
  output: '',
  exitCode: 0,
  durationMs: 10,
});
const plainCommand = record('it_00000000-0000-7000-8000-0000000000b9', 11, {
  type: 'command-execution',
  command: 'npm test',
  cwd: '/elsewhere',
  output: '',
  exitCode: 0,
  durationMs: 10,
});

const records = [note, ...repeats, unmatched, other, failedCommand, succeededCommand, plainCommand];
const digests = new Map<string, string | null>([
  [repeats[0]!.id, SAME],
  [repeats[1]!.id, SAME],
  [repeats[2]!.id, SAME],
  [unmatched.id, null],
  [other.id, OTHER],
  [failedCommand.id, RETRY],
  [succeededCommand.id, RETRY],
  [plainCommand.id, null],
]);

function timelineItem(value: (typeof records)[number]) {
  return {
    id: value.id,
    turnId: value.turnId,
    type: value.type,
    placement: value.type === 'user-message' ? ('narrative' as const) : ('step' as const),
    status: value.status,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    actor: 'actor' in value ? value.actor : null,
    detail: { kind: 'complete' as const, value },
    steer: null,
    argumentDigest: digests.get(value.id) ?? null,
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
      startedAt: at(0),
      completedAt: at(11),
      durationMs: 11 * 60_000,
      error: null,
      long: false,
      narrative: records.map(timelineItem),
      plan: null,
      noteItemIds: [],
      finalItemId: null,
      narrativeCursor: null,
      statistics: {
        steps: 20,
        failedStepCount: 4,
        failedCommandCount: 1,
        filesChanged: 0,
        messages: 1,
        itemCounts: {},
        coverage: 'partial',
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
  digest: { lines: [], coverage: 'partial' },
  restrictedReferences: false,
});

const dashboard = ThreadDashboardResponseSchema.parse({
  viewerUserId: VIEWER,
  participants: [],
  thread: ThreadSchema.parse({
    id: THREAD,
    owner,
    name: 'CI',
    preview: 'CI',
    status: 'active',
    entryPath: 'conversation',
    visibility: 'workspace',
    createdAt: at(0),
    updatedAt: at(11),
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
      startedAt: at(0),
      completedAt: at(11),
      durationMs: 11 * 60_000,
      status: 'completed',
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
      'thread.read-state': async () => ({ readItemIds: [], unreadItemIds: [] }),
      'thread.dashboard': async () => dashboard,
      'thread.timeline': async (input: { view?: string }) => {
        if (input.view === 'items') {
          return ThreadTimelineResponseSchema.parse({
            ...timeline,
            view: 'items',
            runs: [],
            items: [],
          });
        }
        return timeline;
      },
      'thread.items': async () => ({ items: records, nextCursor: null }),
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

describe('exact repetition and retry groups', () => {
  it('groups the same recorded digest and leaves a null digest ungrouped', async () => {
    const user = userEvent.setup();
    renderStream(<ThreadStream workspaceId={WS} threadId={THREAD} lens="full" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(screen.getByText('Please check CI')).toBeInTheDocument();
    const repeats = screen.getByRole('button', {
      name: 'check status × 3 · over 6 min · last: failing',
    });
    const retry = screen.getByRole('button', { name: 'Tried 2×, succeeded on the last' });
    expect(screen.queryByRole('button', { name: /check status × 20/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tried 3×/ })).toBeNull();
    expect(repeats).toHaveAttribute('aria-expanded', 'false');

    await user.click(repeats);
    const repeatMembers = repeats
      .closest('[data-step-members]')
      ?.querySelectorAll('[data-step-member]');
    expect(repeatMembers).toHaveLength(3);
    expect([...(repeatMembers ?? [])].map((node) => node.getAttribute('data-step-member'))).toEqual(
      [...repeatIds]
    );
    expect(
      within(repeats.closest('[data-step-members]') as HTMLElement).getAllByText('check status')
    ).toHaveLength(3);

    await user.click(retry);
    const retryMembers = retry
      .closest('[data-step-members]')
      ?.querySelectorAll('[data-step-member]');
    expect(retryMembers).toHaveLength(2);
    expect([...(retryMembers ?? [])].map((node) => node.getAttribute('data-step-member'))).toEqual([
      failedCommand.id,
      succeededCommand.id,
    ]);
    expect(screen.getByText('Please check CI')).toBeInTheDocument();
    expect(screen.getAllByText('npm test').length).toBeGreaterThan(0);
  });
});
