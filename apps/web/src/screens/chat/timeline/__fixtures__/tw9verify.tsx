import {
  GoalViewSchema,
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { CoreClientProvider } from '../../../../app/core-client';

export const WS = 'ws_00000000-0000-7000-8000-000000000001';
export const THREAD = 'th_00000000-0000-7000-8000-000000000002';
export const TURN = 'tu_00000000-0000-7000-8000-000000000003';
export const B = 'it_00000000-0000-7000-8000-000000000004';
export const EARLY = 'it_00000000-0000-7000-8000-000000000005';
export const OUTSIDE = 'it_00000000-0000-7000-8000-000000000006';
export const RECENT = 'it_00000000-0000-7000-8000-000000000007';
export const USER = 'usr_00000000-0000-7000-8000-000000000008';
export const AT = '2026-11-08T12:00:00.000Z';

// These are schema-validated external read projections, not durable record writes.
export function note(text: string, id = B, turnId = TURN): TimelineItem {
  const value = ItemSchema.parse({
    id,
    owner: { kind: 'workspace', workspaceId: WS },
    threadId: THREAD,
    turnId,
    type: 'assistant-message',
    status: 'completed',
    text,
    createdAt: AT,
    completedAt: AT,
  });
  return {
    id,
    turnId,
    type: value.type,
    placement: 'narrative',
    status: value.status,
    createdAt: AT,
    completedAt: AT,
    actor: null,
    detail: { kind: 'complete', value },
    steer: null,
  };
}

export function run(items: TimelineItem[], id = TURN, order = 2): TimelineRunEntry {
  return {
    id,
    admissionOrder: order,
    status: 'completed',
    triggerActor: { kind: 'user', id: USER },
    agentId: null,
    triggerSource: null,
    startedAt: AT,
    completedAt: AT,
    durationMs: 1000,
    error: null,
    long: false,
    narrative: items,
    plan: null,
    noteItemIds: [],
    finalItemId: null,
    narrativeCursor: null,
    statistics: {
      steps: 0,
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: items.length,
      itemCounts: {},
      coverage: 'complete',
    },
    interruptedBy: { visibility: 'available', actor: null },
    restrictedReferences: false,
  };
}

export function page(runs: TimelineRunEntry[] = [run([note('Boundary note B')])]) {
  return ThreadTimelineResponseSchema.parse({
    workspaceId: WS,
    threadId: THREAD,
    view: 'runs',
    runs,
    items: [],
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: { turnId: TURN, itemId: B },
    catchUpAnchor: { turnId: TURN, itemId: B },
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  });
}

export function dashboard() {
  return {
    thread: {
      id: THREAD,
      owner: { kind: 'workspace', workspaceId: WS },
      entryPath: 'conversation',
      visibility: 'workspace',
      name: 'Review Task',
      status: 'active',
      createdAt: AT,
      updatedAt: AT,
    },
    viewerUserId: USER,
    participants: [],
    taskInputs: [],
    turns: [
      {
        id: TURN,
        owner: { kind: 'workspace', workspaceId: WS },
        threadId: THREAD,
        agentId: 'agent_codex_host',
        status: 'running',
        items: [],
        createdAt: AT,
        startedAt: AT,
      },
    ],
    pendingRequests: [],
    runtimeActivity: [],
    artifacts: [],
  };
}

export function goal() {
  return GoalViewSchema.parse({
    goal: {
      goalId: 'goal-one',
      workspaceId: WS,
      threadId: THREAD,
      responsibleUserId: USER,
      responsibleActorContext: { kind: 'local', userId: USER },
      intent: 'Review the Goal narrative',
      intentRevision: 0,
      intentHistory: [],
      activePlanVersionId: null,
      proposedPlanVersionId: null,
      disposition: null,
      changeRevision: 0,
      consideredRevision: 0,
      createdAt: AT,
      updatedAt: AT,
    },
    cards: [],
    versions: [],
    tasks: [],
    requests: [],
  });
}

export function client(operations: Record<string, unknown> = {}): CoreClient {
  return {
    core: {
      meta: async () => ({}),
      subscribeTurnEvents: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: async () => ({ done: true }),
        }),
      }),
    },
    operations: {
      'thread.dashboard': async () => dashboard(),
      'thread.items': async () => ({ items: [], nextCursor: null }),
      'thread.read-state': async () => ({ readItemIds: [], unreadItemIds: [] }),
      'attention.list': async () => ({ items: [] }),
      'goal.read': async () => goal(),
      'conversation.targets': async () => ({
        workspaceId: WS,
        threadId: THREAD,
        targets: [],
        defaultTargetRef: null,
      }),
      ...operations,
    },
  } as unknown as CoreClient;
}

export function queryOwner() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function Frame({
  api,
  cache,
  children,
  entry = `/tasks/${WS}/${THREAD}`,
}: {
  api: CoreClient;
  cache: QueryClient;
  children: ReactNode;
  entry?: string;
}) {
  return (
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={api}>
        <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}
