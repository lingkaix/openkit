import { ThreadTimelineResponseSchema, type TimelineItem } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { CoreClientProvider } from '../../../../app/core-client';

// Transport fixtures, not durable records: the Web consumes these admitted read responses.
export const WS = 'ws_00000000-0000-7000-8000-000000000001';
export const THREAD = 'th_00000000-0000-7000-8000-000000000002';
export const TURN = 'tu_00000000-0000-7000-8000-000000000003';
export const ITEM = 'it_00000000-0000-7000-8000-000000000004';
export const USER = 'usr_00000000-0000-7000-8000-000000000005';
export const AT = '2026-11-08T12:00:00.000Z';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function message(text: string) {
  return ItemSchema.parse({
    id: ITEM,
    owner: { kind: 'workspace', workspaceId: WS },
    threadId: THREAD,
    turnId: TURN,
    type: 'assistant-message',
    status: 'completed',
    text,
    createdAt: AT,
    completedAt: AT,
  });
}

export function projected(text: string): TimelineItem {
  const value = message(text);
  return {
    id: value.id,
    turnId: TURN,
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

export function page(text: string, view: 'runs' | 'items' = 'runs') {
  const item = projected(text);
  return ThreadTimelineResponseSchema.parse({
    workspaceId: WS,
    threadId: THREAD,
    view,
    runs:
      view === 'runs'
        ? [
            {
              id: TURN,
              admissionOrder: 1,
              status: 'running',
              triggerActor: { kind: 'user', id: USER },
              agentId: null,
              triggerSource: null,
              startedAt: AT,
              completedAt: null,
              durationMs: null,
              error: null,
              long: false,
              narrative: [item],
              plan: null,
              noteItemIds: [],
              finalItemId: null,
              narrativeCursor: null,
              statistics: {
                steps: 0,
                failedStepCount: 0,
                failedCommandCount: 0,
                filesChanged: 0,
                messages: 1,
                itemCounts: {},
                coverage: 'complete',
              },
              interruptedBy: { visibility: 'available', actor: null },
              restrictedReferences: false,
            },
          ]
        : [],
    items: view === 'items' ? [item] : [],
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: null,
    catchUpAnchor: null,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  });
}

export function question(secret = false) {
  return ItemSchema.parse({
    id: ITEM,
    owner: { kind: 'workspace', workspaceId: WS },
    threadId: THREAD,
    turnId: TURN,
    type: 'user-input-request',
    status: 'completed',
    responsibleUserId: USER,
    userInputRequestId: 'question-one',
    prompt: 'Which value should be used?',
    questions: [
      {
        id: 'value',
        header: 'Value',
        question: 'Which value should be used?',
        options: null,
        isOther: false,
        isSecret: secret,
      },
    ],
    createdAt: AT,
    completedAt: AT,
  });
}

export function approval() {
  return ItemSchema.parse({
    id: ITEM,
    owner: { kind: 'workspace', workspaceId: WS },
    threadId: THREAD,
    turnId: TURN,
    type: 'approval-request',
    status: 'completed',
    approvalRequestId: 'approval-one',
    title: 'Publish the summary',
    description: 'Post the summary once.',
    kind: 'permission',
    createdAt: AT,
    completedAt: AT,
  });
}

export function thread() {
  return {
    id: THREAD,
    owner: { kind: 'workspace', workspaceId: WS },
    name: 'A Task',
    status: 'active',
    visibility: 'workspace',
    entryPath: 'conversation',
    createdAt: AT,
    updatedAt: AT,
  };
}

export function dashboard() {
  return {
    thread: thread(),
    viewerUserId: USER,
    participants: [],
    taskInputs: [],
    turns: [
      {
        id: TURN,
        owner: { kind: 'workspace', workspaceId: WS },
        threadId: THREAD,
        status: 'running',
        items: [],
        agentId: 'agent_codex_host',
        createdAt: AT,
        startedAt: AT,
      },
    ],
    pendingRequests: [],
    artifacts: [],
    runtimeActivity: [],
  };
}

export function client(
  operations: Record<string, unknown> = {},
  core: Record<string, unknown> = {}
): CoreClient {
  return {
    auth: { email: { signIn: async () => undefined, signOut: async () => undefined } },
    core: {
      meta: async () => ({}),
      subscribeTurnEvents: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: async () => ({ done: true }),
        }),
      }),
      ...core,
    },
    operations: {
      'workspace.list': async () => ({ items: [] }),
      'thread.dashboard': async () => dashboard(),
      'thread.read-state': async () => ({ scope: 'window', readItemIds: [], unreadItemIds: [] }),
      'conversation.navigation': async () => ({
        items: [
          {
            thread: { id: THREAD, name: null },
            activity: 'chat',
            state: 'idle',
            lastActivityAt: AT,
            unreadCount: 0,
          },
        ],
        nextCursor: null,
      }),
      'thread.items': async () => ({ items: [], nextCursor: null }),
      'attention.list': async () => ({ items: [] }),
      ...operations,
    },
  } as unknown as CoreClient;
}

export function queryOwner() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function Harness({
  children,
  api,
  cache,
  entry = '/tasks/' + WS + '/' + THREAD,
}: {
  children: ReactNode;
  api: CoreClient;
  cache: QueryClient;
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
