import { allocateEntityId, PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type EventSourceLike, subscribeTurnEvents } from './index.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const userId = allocateEntityId('usr');
const requestId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-10-17T00:00:00.000Z';

function buildTurnEvent(sequence: number, terminal = false) {
  if (terminal) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      sequence,
      requestId,
      timestamp,
      workspaceId,
      threadId,
      turnId,
      event: 'turn.completed' as const,
      data: {
        type: 'turn-completed' as const,
        stopReason: 'completed' as const,
        turn: {
          id: turnId,
          owner: { kind: 'workspace' as const, workspaceId },
          threadId,
          triggerActor: { kind: 'user' as const, id: userId },
          items: [],
          error: null,
          status: 'completed' as const,
          configVersion: null,
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 10,
        },
      },
    };
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    sequence,
    requestId,
    timestamp,
    workspaceId,
    threadId,
    turnId,
    event: 'turn.started' as const,
    data: {
      type: 'turn-started' as const,
      turnId,
      status: 'running' as const,
    },
  };
}

describe('subscribeTurnEvents edge cases', () => {
  it('throws when subscribeTurnEvents is called without fetch or EventSource', () => {
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, 'fetch', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(() =>
        subscribeTurnEvents({
          baseUrl: 'https://core.test',
          workspaceId,
          threadId,
          turnId,
        })
      ).toThrow('fetch or EventSource is required to subscribe to turn events');
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        value: originalFetch,
        configurable: true,
        writable: true,
      });
    }
  });

  it('aborts the active fetch request and stops without reconnecting when the iterator is closed early', async () => {
    let activeSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      activeSignal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(buildTurnEvent(1))}\n\n`)
          );
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const iterator = subscribeTurnEvents({
      baseUrl: '',
      fetch: fetcher,
      workspaceId,
      threadId,
      turnId,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, event: 'turn.started' },
    });
    expect(activeSignal?.aborted).toBe(false);

    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    expect(activeSignal?.aborted).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('parses CRLF frames, ignores comments and non-data fields, joins multi-line data frames, and reconnects after a bodyless response', async () => {
    const firstJson = JSON.stringify(buildTurnEvent(1), null, 2);
    const firstDataLines = firstJson
      .split('\n')
      .map((line, index) => (index === 0 ? `data:${line}\r\n` : `data: ${line}\r\n`))
      .join('');
    const secondFrameBytes = new TextEncoder().encode(
      `: keep-alive comment\r\nevent: message\r\nid: 2\r\nfield-without-colon\r\ndata:${JSON.stringify(buildTurnEvent(2, true))}\r\n\r\n`
    );

    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${firstDataLines}\r\n`));
          controller.enqueue(secondFrameBytes.subarray(0, 25));
          controller.enqueue(secondFrameBytes.subarray(25));
          controller.enqueue(new Uint8Array([0xe2, 0x82]));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const iterator = subscribeTurnEvents({
      baseUrl: 'https://core.test/',
      fetch: fetcher,
      workspaceId,
      threadId,
      turnId,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, event: 'turn.started' },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 2, event: 'turn.completed' },
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(calls).toBe(2);
  });

  it('does not reopen EventSource when an error event fires after a canonical terminal event', async () => {
    const instances: Array<{
      closed: boolean;
      emit: (type: string, data?: string) => void;
    }> = [];

    class FakeEventSource implements EventSourceLike {
      closed = false;
      private readonly listeners = new Map<
        string,
        Array<(event: MessageEvent<string> | Event) => void>
      >();

      constructor(_url: string) {
        instances.push({
          closed: false,
          emit: (type, data) => {
            for (const listener of this.listeners.get(type) ?? []) {
              listener(data === undefined ? new Event(type) : ({ data } as MessageEvent<string>));
            }
          },
        });
      }

      addEventListener(
        type: string,
        listener: (event: MessageEvent<string> | Event) => void
      ): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      close(): void {
        this.closed = true;
        const record = instances.at(-1);
        if (record) record.closed = true;
      }
    }

    const iterator = subscribeTurnEvents({
      baseUrl: 'https://core.test',
      eventSource: FakeEventSource,
      workspaceId,
      threadId,
      turnId,
    })[Symbol.asyncIterator]();

    const source = instances[0]!;
    const firstEventPromise = iterator.next();
    source.emit('message', JSON.stringify(buildTurnEvent(1, true)));
    await expect(firstEventPromise).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, event: 'turn.completed' },
    });

    source.emit('error');
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(instances).toHaveLength(1);
    expect(source.closed).toBe(true);
  });
});

it('preserves the server-authored Turn error class and exact owner action on terminal SSE', async () => {
  const original = buildTurnEvent(1, true);
  if (original.data.type !== 'turn-completed') throw new Error('Expected terminal fixture.');
  const presentation = {
    class: 'unknown-outcome',
    summary: 'Inspect recorded effects before starting new work.',
    actions: [
      {
        kind: 'inspect',
        owner: 'turn',
        operation: 'turn.read',
        input: { workspaceId, threadId, turnId },
      },
    ],
  };
  const frame = {
    ...original,
    data: {
      ...original.data,
      stopReason: 'error',
      turn: {
        ...original.data.turn,
        status: 'failed',
        error: { code: 'delivery_unknown', message: 'Delivery could not be proved.', presentation },
      },
    },
  };
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(`data: ${JSON.stringify(frame)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
  );
  const events = subscribeTurnEvents({
    baseUrl: 'https://core.test',
    workspaceId,
    threadId,
    turnId,
    fetch: fetcher,
  })[Symbol.asyncIterator]();
  const received = await events.next();
  expect(received.done).toBe(false);
  expect(received.value?.data).toMatchObject({
    type: 'turn-completed',
    turn: { error: { presentation } },
  });
  expect(await events.next()).toEqual({ done: true, value: undefined });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
