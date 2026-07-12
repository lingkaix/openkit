import { ApiErrorSchema, SseEventEnvelopeSchema } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import type { FsStore } from './lib/store.js';
import { createDemoStore } from './test-support/demo-store.js';

/**
 * Parses a complete SSE response body into JSON event payloads.
 *
 * @param text Raw SSE body text.
 * @returns Parsed event payloads in stream order.
 * @throws Error when an SSE event chunk does not contain a data line.
 */
function parseSseEvents(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));

      if (!dataLine) {
        throw new Error(`Missing SSE data line: ${chunk}`);
      }

      return JSON.parse(dataLine.slice('data: '.length)) as unknown;
    });
}

/**
 * Creates a completed turn with retained replay events.
 *
 * @param store Store that should receive the replay fixture records.
 * @param workspaceId Workspace that should own the replay fixture.
 * @returns Identifiers needed to open the turn event stream.
 */
function createReplayTurn(
  store: FsStore,
  workspaceId = 'ws_demo'
): {
  workspaceId: string;
  threadId: string;
  turnId: string;
} {
  const thread = store.createThread(workspaceId, 'Replay thread');
  const turn = store.createTurn(workspaceId, thread.id, 'Replay this stream');
  const assistantItem = store.createItem({
    id: `it_assistant_${turn.id}`,
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    type: 'assistant-message',
    status: 'in_progress',
    text: '',
    createdAt: turn.startedAt ?? new Date().toISOString(),
    completedAt: null,
  });

  store.emitTurnEvent(turn.id, {
    event: 'turn.started',
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    data: { type: 'turn-started', turnId: turn.id, status: 'running' },
  });
  store.emitTurnEvent(turn.id, {
    event: 'item.delta',
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    data: {
      type: 'item-delta',
      itemId: assistantItem.id,
      itemType: 'assistant-message',
      deltaKind: 'text-delta',
      delta: 'First replay delta.',
    },
  });
  store.emitTurnEvent(turn.id, {
    event: 'item.delta',
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    data: {
      type: 'item-delta',
      itemId: assistantItem.id,
      itemType: 'assistant-message',
      deltaKind: 'text-delta',
      delta: 'Second replay delta.',
    },
  });
  const completedTurn = store.updateTurn(turn.id, {
    status: 'completed',
    completedAt: turn.startedAt,
  });
  store.emitTurnEvent(turn.id, {
    event: 'turn.completed',
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
  });

  return { workspaceId, threadId: thread.id, turnId: turn.id };
}

describe('turn event routes', () => {
  it('replays turn events after the since cursor without duplicates', async () => {
    const store = createDemoStore();
    const app = createApp({ store });
    const { workspaceId, threadId, turnId } = createReplayTurn(store);

    const coldRes = await app.request(
      `/api/workspaces/${workspaceId}/threads/${threadId}/events?turnId=${turnId}&since=0`
    );
    const coldEvents = parseSseEvents(await coldRes.text()).map((event) =>
      SseEventEnvelopeSchema.parse(event)
    );
    const lastSeen = coldEvents.at(1)?.sequence;

    expect(coldRes.status).toBe(200);
    expect(coldEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(lastSeen).toBe(2);

    const replayRes = await app.request(
      `/api/workspaces/${workspaceId}/threads/${threadId}/events?turnId=${turnId}&since=${lastSeen}`
    );
    const replayEvents = parseSseEvents(await replayRes.text()).map((event) =>
      SseEventEnvelopeSchema.parse(event)
    );

    expect(replayRes.status).toBe(200);
    expect(replayEvents.map((event) => event.sequence)).toEqual([3, 4]);
  });

  it('returns no content when the since cursor is already terminal', async () => {
    const store = createDemoStore();
    const app = createApp({ store });
    const { workspaceId, threadId, turnId } = createReplayTurn(store);
    const terminalSequence = store
      .getTurnEvents(turnId)
      .find((event) => event.event === 'turn.completed')?.sequence;

    const res = await app.request(
      `/api/workspaces/${workspaceId}/threads/${threadId}/events?turnId=${turnId}&since=${terminalSequence}`
    );
    const text = await res.text();

    expect(res.status).toBe(204);
    expect(text).toBe('');
  });

  it('keeps non-terminal empty replays open instead of returning no content', async () => {
    const store = createDemoStore();
    const unsubscribe = vi.fn();

    vi.spyOn(store, 'addTurnListener').mockReturnValue(unsubscribe);

    const app = createApp({ store });
    const workspaceId = 'ws_demo';
    const thread = store.createThread(workspaceId, 'Open replay thread');
    const turn = store.createTurn(workspaceId, thread.id, 'Keep streaming');

    store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });

    const res = await app.request(
      `/api/workspaces/${workspaceId}/threads/${thread.id}/events?turnId=${turn.id}&since=1`
    );

    expect(res.status).toBe(200);
    await res.body?.cancel();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });

  it('preserves events emitted while retained events are being replayed', async () => {
    const store = createDemoStore();
    const workspaceId = 'ws_demo';
    const thread = store.createThread(workspaceId, 'Replay race thread');
    const turn = store.createTurn(workspaceId, thread.id, 'Preserve replay ordering');

    store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });
    store.emitTurnEvent(turn.id, {
      event: 'item.delta',
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      data: {
        type: 'item-delta',
        itemId: `it_assistant_${turn.id}`,
        itemType: 'assistant-message',
        deltaKind: 'text-delta',
        delta: 'Retained replay delta.',
      },
    });

    const listenerSpy = vi.spyOn(store, 'addTurnListener');
    const app = createApp({ store });
    const res = await app.request(
      `/api/workspaces/${workspaceId}/threads/${thread.id}/events?turnId=${turn.id}&since=0`
    );

    store.emitTurnEvent(turn.id, {
      event: 'item.delta',
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      data: {
        type: 'item-delta',
        itemId: `it_assistant_${turn.id}`,
        itemType: 'assistant-message',
        deltaKind: 'text-delta',
        delta: 'Gap replay delta.',
      },
    });

    const bodyPromise = res.text();

    await vi.waitFor(() => expect(listenerSpy).toHaveBeenCalledTimes(1));

    const completedTurn = store.updateTurn(turn.id, {
      status: 'completed',
      completedAt: turn.startedAt,
    });

    store.emitTurnEvent(turn.id, {
      event: 'turn.completed',
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
    });

    const events = parseSseEvents(await bodyPromise).map((event) =>
      SseEventEnvelopeSchema.parse(event)
    );

    expect(res.status).toBe(200);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('returns cursor_expired when since is older than the retained event window', async () => {
    const store = createDemoStore();
    const app = createApp({ store });
    const { workspaceId, threadId, turnId } = createReplayTurn(store);

    for (let index = 0; index < 105; index += 1) {
      store.emitTurnEvent(turnId, {
        event: 'item.delta',
        workspaceId,
        threadId,
        turnId,
        data: {
          type: 'item-delta',
          itemId: `it_assistant_${turnId}`,
          itemType: 'assistant-message',
          deltaKind: 'text-delta',
          delta: `Overflow ${index}`,
        },
      });
    }

    const res = await app.request(
      `/api/workspaces/${workspaceId}/threads/${threadId}/events?turnId=${turnId}&since=1`
    );
    const error = ApiErrorSchema.parse(await res.json());

    expect(res.status).toBe(410);
    expect(error.code).toBe('core.stream.cursor_expired');
  });

  it('does not replay a turn through a different workspace and thread path', async () => {
    const store = createDemoStore();
    const otherWorkspace = store.createWorkspace('Other event workspace');
    const { turnId } = createReplayTurn(store, otherWorkspace.id);
    const app = createApp({ store });

    const res = await app.request(
      `/api/workspaces/ws_demo/threads/th_demo/events?turnId=${turnId}&since=0`
    );

    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('not_found');
  });
});
