import {
  ListHumanAttentionResponseSchema,
  type ThreadTimelineInput,
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { allocateEntityId, type Item, ItemSchema } from '@openkit/protocol';

/** Schema-checked read fixtures, not durable records. Each test owns its API boundary. */
export function timelineFixture(
  workspaceId = allocateEntityId('ws'),
  threadId = allocateEntityId('th')
) {
  const userId = allocateEntityId('usr');
  const at = new Date(Date.now() - 20_000).toISOString();
  function item(turnId: string, fields: Record<string, unknown>): Item {
    return ItemSchema.parse({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId,
      turnId,
      status: 'completed',
      createdAt: at,
      completedAt: at,
      ...fields,
    });
  }
  function message(turnId: string, text: string) {
    return item(turnId, { type: 'user-message', actor: { kind: 'user', id: userId }, text });
  }
  function command(turnId: string, text: string) {
    return item(turnId, {
      type: 'command-execution',
      command: text,
      cwd: '.',
      durationMs: 1000,
      output: 'Recorded output',
      exitCode: 0,
    });
  }
  function detail(value: Item): TimelineItem {
    return {
      id: value.id,
      turnId: value.turnId,
      type: value.type,
      placement: ['command-execution', 'tool-call', 'file-change', 'reasoning'].includes(value.type)
        ? 'step'
        : 'narrative',
      status: value.status,
      createdAt: value.createdAt,
      completedAt: value.completedAt ?? null,
      actor: 'actor' in value ? (value.actor ?? null) : null,
      detail: { kind: 'complete', value },
      steer: null,
    };
  }
  function run(
    order: number,
    turnId: string,
    narrative: TimelineItem[],
    steps = 0,
    extra: Partial<TimelineRunEntry> = {}
  ): TimelineRunEntry {
    return {
      id: turnId,
      admissionOrder: order,
      status: 'completed',
      triggerActor: { kind: 'user', id: userId },
      agentId: null,
      triggerSource: null,
      startedAt: at,
      completedAt: at,
      durationMs: 1000,
      error: null,
      long: false,
      narrative,
      plan: null,
      noteItemIds: [],
      finalItemId: null,
      narrativeCursor: null,
      statistics: {
        steps,
        failedStepCount: 0,
        failedCommandCount: 0,
        filesChanged: 0,
        messages: narrative.length,
        itemCounts: {},
        coverage: 'complete',
      },
      interruptedBy: { visibility: 'available', actor: null },
      restrictedReferences: false,
      ...extra,
    };
  }
  function page(runs: TimelineRunEntry[], extra: Record<string, unknown> = {}) {
    return ThreadTimelineResponseSchema.parse({
      workspaceId,
      threadId,
      view: 'runs',
      runs,
      items: [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: null,
      catchUpAnchor: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
      ...extra,
    });
  }
  function dashboard(runs: TimelineRunEntry[]) {
    const latest = runs.at(-1);
    return {
      viewerUserId: null,
      participants: [],
      artifacts: [],
      taskInputs: [],
      pendingRequests: [],
      thread: {
        id: threadId,
        owner: { kind: 'workspace', workspaceId },
        name: 'Independent timeline regression',
        preview: '',
        status: 'active',
        entryPath: 'conversation',
        visibility: 'workspace',
        createdAt: at,
        updatedAt: at,
      },
      turns: latest
        ? [
            {
              id: latest.id,
              owner: { kind: 'workspace', workspaceId },
              threadId,
              status: latest.status,
              triggerActor: latest.triggerActor,
              agentId: null,
              configVersion: null,
              startedAt: at,
              completedAt: latest.completedAt,
              durationMs: latest.durationMs,
              error: null,
              items: [],
            },
          ]
        : [],
      workStatus: null,
      composer: { disabled: false, defaultAgentId: null },
      itemLog: { href: '/items' },
    };
  }
  function question(turnId: string, text: string) {
    return item(turnId, {
      type: 'user-input-request',
      userInputRequestId: `question-${allocateEntityId('it')}`,
      responsibleUserId: userId,
      prompt: text,
      questions: [
        {
          id: 'answer',
          header: 'Answer',
          question: text,
          options: null,
          isOther: false,
          isSecret: false,
        },
      ],
    });
  }
  function attention(questions: Item[]) {
    return ListHumanAttentionResponseSchema.parse({
      items: questions.map((q, index) => ({
        id: `question:${q.id}`,
        kind: 'question',
        workspaceId,
        threadId,
        turnId: q.turnId,
        itemId: q.id,
        title: `Choose option ${index + 1}`,
        summary: 'Answer the question on its pending request.',
        createdAt: new Date(Date.parse(at) + index * 1000).toISOString(),
        ageSeconds: 20,
        blocking: true,
        severity: 'needs_input',
        source: {
          type: 'protocol_item',
          itemType: 'user-input-request',
          workspaceId,
          threadId,
          turnId: q.turnId,
          itemId: q.id,
        },
        actions: [],
      })),
    });
  }
  return {
    workspaceId,
    threadId,
    userId,
    at,
    item,
    message,
    command,
    detail,
    run,
    page,
    dashboard,
    question,
    attention,
  };
}

/** In-process transport double. The real live-event consumer folds these events. */
export function eventPipe() {
  const queue: unknown[] = [];
  let waiter: ((result: IteratorResult<unknown>) => void) | null = null;
  let closed = false;
  return {
    push(value: unknown) {
      if (waiter) {
        const next = waiter;
        waiter = null;
        next({ value, done: false });
      } else queue.push(value);
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        return() {
          closed = true;
          waiter?.({ value: undefined, done: true });
          waiter = null;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

export type TimelineRead = (
  input: ThreadTimelineInput
) => ReturnType<ReturnType<typeof timelineFixture>['page']>;
