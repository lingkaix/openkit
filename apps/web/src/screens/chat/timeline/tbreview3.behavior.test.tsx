import {
  OPERATION_DEFINITIONS,
  type OperationId,
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema, ProductTurnSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { Composer } from '../../../primitives/Composer';
import { useWorkspaceStore } from '../../workspace-store';
import { useConversationTargets, useThreadDashboard } from '../data';
import { ThreadStream } from '../ThreadStream';
import { SteerProvider } from './steer-context';
import { useTimelineWindow } from './use-timeline-window';
import type { TimelineAnchorRequest } from './window';

// Conversation Timeline G12, TB7 plan coverage, and STEER-WEB: render the currently admitted
// projection, never an older window or a different Turn. Only transport and
// browser boundaries are doubled. No query result, hook, or renderer is mocked.
const caches: QueryClient[] = [];
const transportErrors: Array<{ operation: string; error: string }> = [];
const at = '2026-11-08T12:00:00.000Z';
const endedAt = '2026-11-08T12:31:00.000Z';
const draft = 'Keep this exact draft for the current run.';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '');
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media.includes('min-width: 800'),
    media,
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
    'Every transport fixture must satisfy its operation schema'
  ).toEqual([]);
});

function fixture() {
  const workspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const nextTurnId = allocateEntityId('tu');
  const userId = allocateEntityId('usr');
  const planItemId = allocateEntityId('it');
  const capabilityCallId = allocateEntityId('cap');
  const permissionDecisionId = allocateEntityId('pd');
  const owner = { kind: 'workspace' as const, workspaceId };
  const thread = {
    id: threadId,
    owner,
    name: 'Recorded work',
    preview: 'Recorded work in this Thread.',
    status: 'active',
    visibility: 'workspace',
    entryPath: 'conversation',
    createdAt: at,
    updatedAt: at,
  };
  const workspace = {
    id: workspaceId,
    name: 'Recorded workspace',
    kind: 'general',
    status: 'active',
    counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
    createdAt: at,
    updatedAt: at,
  };
  const itemBase = { owner, threadId, turnId, status: 'completed', createdAt: at, completedAt: at };
  const tool = ItemSchema.parse({
    ...itemBase,
    id: allocateEntityId('it'),
    type: 'tool-call',
    tool: 'format-recorded-work',
    server: 'recorded-server',
    causationId: capabilityCallId,
    arguments: null,
    result: 'The recorded tool result',
    error: null,
    durationMs: 10,
  });
  function message(text: string): TimelineItem {
    const value = ItemSchema.parse({
      ...itemBase,
      id: allocateEntityId('it'),
      type: 'assistant-message',
      text,
    });
    return {
      id: value.id,
      turnId,
      type: value.type,
      placement: 'narrative',
      status: value.status,
      createdAt: at,
      completedAt: at,
      actor: null,
      detail: { kind: 'complete', value },
      steer: null,
      policy: null,
    };
  }
  const oldNote = message('Earlier admitted root window');
  const currentNote = message('Current admitted root window');
  const currentItemNote = message('Current admitted Item window');
  const oldCursor = 'recorded-earlier-item-window';
  const currentCursor = 'recorded-current-item-window';
  const latest = { kind: 'latest' } as const;
  const historical = { kind: 'turn', turnId } as const;
  let current = false;
  let emptySegments = false;
  let runningTurnId: string | null = null;
  let catalogTurnId: string = turnId;

  function segments(steps: number, coverage: 'complete' | 'partial') {
    return {
      coverage,
      segments: emptySegments
        ? []
        : [
            {
              planItemId,
              planRevision: 1,
              stepId: 'work',
              title: 'Recorded work',
              startSequence: 1,
              endSequence: null,
              steps,
            },
          ],
    } satisfies NonNullable<TimelineRunEntry['planSegments']>;
  }
  function projectedTool(policy: TimelineItem['policy']): TimelineItem {
    return {
      id: tool.id,
      turnId,
      type: tool.type,
      placement: 'step',
      status: tool.status,
      createdAt: at,
      completedAt: at,
      actor: null,
      detail: { kind: 'complete', value: tool },
      steer: null,
      policy,
    };
  }
  function timeline(input: Record<string, unknown>) {
    const itemView = input.view === 'items' || typeof input.cursor === 'string';
    const old = itemView ? input.cursor === oldCursor : !current;
    return ThreadTimelineResponseSchema.parse({
      workspaceId,
      threadId,
      view: itemView ? 'items' : 'runs',
      runs: itemView
        ? []
        : [
            {
              id: runningTurnId ?? turnId,
              admissionOrder: 1,
              status: runningTurnId ? 'running' : 'completed',
              triggerActor: { kind: 'user', id: userId },
              agentId: null,
              triggerSource: null,
              startedAt: at,
              completedAt: runningTurnId ? null : endedAt,
              durationMs: runningTurnId ? null : 1_860_000,
              error: null,
              long: true,
              narrative: runningTurnId ? [] : [old ? oldNote : currentNote],
              plan: null,
              noteItemIds: [],
              finalItemId: null,
              narrativeCursor: old ? oldCursor : currentCursor,
              statistics: {
                steps: old ? 18 : 19,
                failedStepCount: 0,
                failedCommandCount: 0,
                filesChanged: 0,
                messages: old ? 1 : 3,
                itemCounts: { 'tool-call': 1 },
                coverage: 'complete',
              },
              planSegments: runningTurnId
                ? { segments: [], coverage: 'complete' }
                : segments(old ? 18 : 19, old ? 'complete' : 'partial'),
              interruptedBy: { visibility: 'available', actor: null },
              restrictedReferences: false,
            },
          ],
      items: itemView
        ? [
            projectedTool(
              old
                ? {
                    outcome: 'allowed',
                    capabilityCallId,
                    permissionDecisionId,
                    connectionRef: null,
                  }
                : null
            ),
            ...(old ? [] : [currentItemNote]),
          ]
        : [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: null,
      catchUpAnchor: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
  }
  function dashboard() {
    const id = runningTurnId ?? turnId;
    return {
      thread,
      viewerUserId: userId,
      participants: [],
      taskInputs: [],
      workStatus: {
        selectedAgentId: null,
        activeTurnStatus: runningTurnId ? 'running' : 'completed',
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
        latestArtifact: null,
      },
      composer: { disabled: false, defaultAgentId: null },
      itemLog: { href: '/recorded-item-log' },
      turns: [
        ProductTurnSchema.parse({
          id,
          owner,
          threadId,
          status: runningTurnId ? 'running' : 'completed',
          items: [],
          agentId: null,
          triggerActor: { kind: 'user', id: userId },
          error: null,
          configVersion: 1,
          durationMs: runningTurnId ? null : 1_860_000,
          createdAt: at,
          startedAt: at,
          completedAt: runningTurnId ? null : endedAt,
        }),
      ],
      pendingRequests: [],
      artifacts: [],
      runtimeActivity: [],
    };
  }
  const responses: Partial<Record<OperationId, (input: Record<string, unknown>) => unknown>> = {
    'workspace.list': () => ({
      items: [
        {
          workspace,
          isOwner: true,
          membershipStatus: 'active',
          accessCause: 'membership',
          membershipRevision: 1,
          ownerUserId: userId,
          registryRevision: 1,
        },
      ],
    }),
    'thread.dashboard': dashboard,
    'thread.timeline': timeline,
    'thread.read-state': () => ({ scope: 'window', readItemIds: [], unreadItemIds: [] }),
    'thread.items': () => ({ items: [], nextCursor: null }),
    'attention.list': () => ({ items: [] }),
    'conversation.targets': () => ({
      workspaceId,
      threadId,
      defaultTargetRef: 'recorded-worker',
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
          activeTurnId: catalogTurnId,
          steerAvailability: 'available',
          steerUnavailableReason: null,
        },
      ],
    }),
  };
  // Validate BOTH directions at the transport boundary, including defaults and
  // all supporting reads. Query and rendering owners remain production code.
  const operations = Object.fromEntries(
    Object.entries(responses).map(([name, respond]) => {
      const definition = OPERATION_DEFINITIONS[name as OperationId];
      return [
        name,
        vi.fn(async (input: unknown) => {
          try {
            return definition.outputSchema.parse(
              respond(definition.inputSchema.parse(input) as Record<string, unknown>)
            );
          } catch (error) {
            transportErrors.push({ operation: name, error: String(error) });
            throw error;
          }
        }),
      ];
    })
  );
  const api = { operations } as unknown as CoreClient;
  return {
    workspaceId,
    threadId,
    turnId,
    nextTurnId,
    latest,
    historical,
    api,
    makeCurrent: () => {
      current = true;
    },
    makeEmptyPartial: () => {
      current = true;
      emptySegments = true;
    },
    run: (id: string) => {
      runningTurnId = id;
    },
    catalog: (id: string) => {
      catalogTurnId = id;
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
function mount(f: Fixture, cache: QueryClient, children: ReactNode) {
  return render(
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
function TimelineRefresh({ f }: { f: Fixture }) {
  const read = useTimelineWindow({
    workspaceId: f.workspaceId,
    threadId: f.threadId,
    anchor: f.latest,
    enabled: true,
    running: false,
    pending: false,
  });
  return (
    <>
      <output aria-label="Current interval count">
        {read.data?.runs[0]?.planSegments?.segments.length}
      </output>
      <button type="button" onClick={() => void read.refetch()}>
        Refresh timeline read
      </button>
    </>
  );
}
function SteerReads({ f }: { f: Fixture }) {
  const dashboard = useThreadDashboard(f.workspaceId, f.threadId, true, false);
  const catalog = useConversationTargets(f.workspaceId, f.threadId);
  return (
    <>
      <output aria-label="Current running Turn">{dashboard.data?.turns[0]?.id}</output>
      <output aria-label="Current catalog Turn">
        {catalog.data?.targets.find((target) => target.kind === 'running-worker')?.activeTurnId}
      </output>
      <button type="button" onClick={() => void dashboard.refetch()}>
        Refresh running Turn
      </button>
      <button type="button" onClick={() => void catalog.refetch()}>
        Refresh available target
      </button>
    </>
  );
}

describe('TB-REVIEW-3 independent behavior regressions', () => {
  it('W1a a fresh null policy cannot inherit an Allowed badge from an older window', async () => {
    const f = fixture();
    const cache = queryOwner();
    const earlier = mount(f, cache, <Stream f={f} anchor={f.historical} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText('Allowed by policy')).toBeVisible();
    });
    earlier.unmount();
    f.makeCurrent();
    mount(f, cache, <Stream f={f} anchor={f.latest} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText('Current admitted Item window')).toBeVisible();
    });
    // G12: null means no currently admitted complete lineage, not old permission.
    expect(
      screen.queryByText('Allowed by policy'),
      'The current null policy must remove the older admitted badge'
    ).not.toBeInTheDocument();
  });

  it('W1b the current 19-step partial interval wins over an older 18-step complete window', async () => {
    const f = fixture();
    const cache = queryOwner();
    const earlier = mount(f, cache, <Stream f={f} anchor={f.historical} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText('Recorded work · 18 steps')).toBeVisible();
    });
    expect(screen.queryByText('These counts are incomplete.')).not.toBeInTheDocument();
    earlier.unmount();
    f.makeCurrent();
    mount(f, cache, <Stream f={f} anchor={f.latest} />);
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByText('Current admitted root window')).toBeVisible();
    });
    // TB7: use recorded interval counts and their coverage, not another read.
    expect
      .soft(
        screen.queryByText('Recorded work · 18 steps'),
        'The older interval must not replace the current projection'
      )
      .not.toBeInTheDocument();
    expect
      .soft(
        screen.queryByText('Recorded work · 19 steps'),
        'The current recorded count is 19, not the older 18'
      )
      .toBeVisible();
    expect(
      screen.queryByText('These counts are incomplete.'),
      'The current partial coverage must remain visible'
    ).toBeVisible();
  });

  it('W2 a successor running Turn does not make the prior cached target steerable', async () => {
    const f = fixture();
    f.run(f.turnId);
    const user = userEvent.setup();
    mount(
      f,
      queryOwner(),
      <SteerProvider mode="task">
        <SteerReads f={f} />
        <Composer
          initialDraft={{
            input: draft,
            targetRef: '',
            requestId: '77777777-7777-4777-8777-777777777777',
          }}
          onSubmit={vi.fn()}
        />
      </SteerProvider>
    );
    expect(await screen.findByRole('button', { name: 'Steer' })).toBeVisible();
    f.run(f.nextTurnId);
    await user.click(screen.getByRole('button', { name: 'Refresh running Turn' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Current running Turn')).toHaveTextContent(f.nextTurnId)
    );
    // STEER-WEB: an ended target cannot be offered because its successor runs.
    expect
      .soft(
        screen.queryByRole('button', { name: 'Steer' }),
        'The old catalog Turn must not be offered for the successor run'
      )
      .not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(draft);
    // Positive control: a matching available target may offer Steer again.
    f.catalog(f.nextTurnId);
    await user.click(screen.getByRole('button', { name: 'Refresh available target' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Current catalog Turn')).toHaveTextContent(f.nextTurnId)
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Steer' })).toBeVisible());
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(draft);
  });

  it('W3 an empty partial interval projection still shows its coverage limitation', async () => {
    const f = fixture();
    f.makeCurrent();
    const user = userEvent.setup();
    const cache = queryOwner();
    mount(
      f,
      cache,
      <>
        <Stream f={f} anchor={f.latest} />
        <TimelineRefresh f={f} />
      </>
    );
    await waitFor(() => expect(screen.getByText('These counts are incomplete.')).toBeVisible());
    f.makeEmptyPartial();
    await user.click(screen.getByRole('button', { name: 'Refresh timeline read' }));
    await waitFor(() => {
      expect(cache.isFetching()).toBe(0);
      expect(screen.getByLabelText('Current interval count')).toHaveTextContent(/^0$/);
      expect(screen.getByText('Current admitted root window')).toBeVisible();
    });
    // TB7: unreadable/clipped observations are not a complete empty history.
    expect(
      screen.queryByText('These counts are incomplete.'),
      'Empty partial intervals must retain the coverage warning'
    ).toBeVisible();
  });
});
