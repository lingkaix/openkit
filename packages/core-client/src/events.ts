import {
  ForwardCompatibleSseEventEnvelopeSchema,
  ProductSseEventEnvelopeSchema,
  ProductTurnSchema,
} from '@openkit/protocol';
import { z } from 'zod';

import { ProtocolValidationError } from './errors.js';
import { parseJsonResponse } from './http.js';
import type { EventSourceConstructor, EventSourceLike } from './sse.js';

type FetchLike = typeof globalThis.fetch;

/**
 * Validated SSE event envelope delivered by the core event stream.
 */
export type SseEventEnvelope = z.infer<typeof ProductSseEventEnvelopeSchema>;

interface DecodedSseFrame {
  readonly envelope: SseEventEnvelope | null;
  readonly sequence: number;
}

/**
 * Parses one ordinary SSE frame while tolerating a leaked internal AgentSession event.
 *
 * @param data JSON SSE frame data.
 * @returns Product envelope or a withheld internal sequence.
 */
function decodeSseFrame(data: string): DecodedSseFrame {
  let payload: unknown;

  try {
    payload = JSON.parse(data) as unknown;
  } catch (error) {
    throw new ProtocolValidationError(
      {
        path: [],
        code: 'invalid_payload',
        message: 'SSE event failed protocol validation.',
      },
      { cause: error }
    );
  }

  const product = ProductSseEventEnvelopeSchema.safeParse(payload);

  if (product.success) {
    return { envelope: product.data, sequence: product.data.sequence };
  }

  const internal = ForwardCompatibleSseEventEnvelopeSchema.safeParse(payload);

  if (
    internal.success &&
    (internal.data.event === 'agent.session.updated' ||
      internal.data.data.type === 'agent-session-updated')
  ) {
    return { envelope: null, sequence: internal.data.sequence };
  }

  throw new ProtocolValidationError(
    product.error.issues[0] ?? {
      path: [],
      code: 'invalid_payload',
      message: 'SSE event failed protocol validation.',
    },
    { cause: product.error }
  );
}

/**
 * Options for subscribing to one turn's event stream.
 */
export interface SubscribeTurnEventsOptions {
  /** Static headers applied to fetch-based SSE requests. */
  headers?: HeadersInit | undefined;
  workspaceId: string;
  threadId: string;
  turnId: string;
  since?: number;
  baseUrl: string;
  fetch?: FetchLike;
  eventSource?: EventSourceConstructor;
}

interface QueueState {
  readonly values: SseEventEnvelope[];
  readonly errors: unknown[];
  readonly resolvers: Array<() => void>;
}

/**
 * Classifies delivery for an envelope affiliated with the subscribed Turn's terminal event.
 *
 * @param envelope Validated forward-compatible stream envelope.
 * @param options Subscription owner identifiers.
 * @returns Whether to deliver an ordinary event, withhold a noncanonical terminal-affiliated envelope, or deliver the canonical terminal event and stop.
 */
function classifyTurnEventDelivery(
  envelope: SseEventEnvelope,
  options: SubscribeTurnEventsOptions
): 'deliver' | 'withhold' | 'terminal' {
  const terminalAffiliated =
    envelope.event === 'turn.completed' || envelope.data.type === 'turn-completed';

  if (!terminalAffiliated) {
    return 'deliver';
  }

  if (envelope.event !== 'turn.completed' || envelope.data.type !== 'turn-completed') {
    return 'withhold';
  }

  const turn = ProductTurnSchema.parse(envelope.data.turn);
  const terminal =
    turn.status === 'completed' ||
    turn.status === 'interrupted' ||
    turn.status === 'cancelled' ||
    turn.status === 'failed';

  return terminal &&
    envelope.workspaceId === options.workspaceId &&
    envelope.threadId === options.threadId &&
    envelope.turnId === options.turnId &&
    turn.workspaceId === options.workspaceId &&
    turn.threadId === options.threadId &&
    turn.id === options.turnId
    ? 'terminal'
    : 'withhold';
}

/**
 * Subscribes to validated turn events with sequence-aware reconnects.
 */
export function subscribeTurnEvents(
  options: SubscribeTurnEventsOptions
): AsyncIterable<SseEventEnvelope> {
  if (options.fetch !== undefined || options.eventSource === undefined) {
    const fetcher = options.fetch ?? globalThis.fetch;

    if (fetcher === undefined) {
      throw new Error('fetch or EventSource is required to subscribe to turn events');
    }

    return subscribeTurnEventsWithFetch(options, fetcher);
  }

  return subscribeTurnEventsWithEventSource(options, options.eventSource);
}

/**
 * Subscribes to turn events through a status-aware fetch SSE stream.
 */
function subscribeTurnEventsWithFetch(
  options: SubscribeTurnEventsOptions,
  fetcher: FetchLike
): AsyncIterable<SseEventEnvelope> {
  const normalizedBaseUrl = options.baseUrl.replace(/\/$/, '');
  const queue: QueueState = { values: [], errors: [], resolvers: [] };
  let activeController: AbortController | null = null;
  let stopped = false;
  let lastSeen = options.since ?? 0;

  const wake = (): void => {
    const resolvers = queue.resolvers.splice(0);

    for (const resolve of resolvers) {
      resolve();
    }
  };

  const buildUrl = (): string => {
    const path = `/api/workspaces/${encodeURIComponent(options.workspaceId)}/threads/${encodeURIComponent(
      options.threadId
    )}/events`;
    const params = new URLSearchParams({
      turnId: options.turnId,
      since: String(lastSeen),
    });

    if (normalizedBaseUrl === '') {
      return `${path}?${params.toString()}`;
    }

    const url = new URL(path, normalizedBaseUrl);
    url.search = params.toString();
    return url.toString();
  };

  const pushError = (error: unknown): void => {
    queue.errors.push(error);
    stopped = true;
    activeController?.abort();
    wake();
  };

  const pushEvent = (data: string): void => {
    try {
      const decoded = decodeSseFrame(data);

      if (decoded.sequence <= lastSeen) {
        return;
      }

      lastSeen = decoded.sequence;

      if (decoded.envelope === null) {
        return;
      }

      const delivery = classifyTurnEventDelivery(decoded.envelope, options);

      if (delivery === 'withhold') {
        return;
      }

      queue.values.push(decoded.envelope);

      if (delivery === 'terminal') {
        stopped = true;
        activeController?.abort();
      }

      wake();
    } catch (error) {
      queue.values.length = 0;
      pushError(error);
    }
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      const controller = new AbortController();
      activeController = controller;

      try {
        const response = await fetcher(buildUrl(), {
          credentials: 'include',
          headers: mergeHeaders(options.headers, { accept: 'text/event-stream' }),
          signal: controller.signal,
        });

        if (response.status === 204) {
          stopped = true;
          wake();
          return;
        }

        if (!response.ok) {
          try {
            await parseJsonResponse(response, z.never());
          } catch (error) {
            pushError(error);
          }
          return;
        }

        await readSseBody(response, pushEvent, () => stopped);
      } catch (error) {
        if (!stopped && !isAbortError(error)) {
          pushError(error);
          return;
        }
      } finally {
        if (activeController === controller) {
          activeController = null;
        }
      }
    }
  };

  void run();

  return createIterator(
    queue,
    () => stopped,
    () => {
      stopped = true;
      activeController?.abort();
      wake();
    }
  );
}

/**
 * Merges static request headers with per-request headers.
 */
function mergeHeaders(base: HeadersInit | undefined, headers: HeadersInit): Headers {
  const merged = new Headers(base);

  new Headers(headers).forEach((value, key) => {
    merged.set(key, value);
  });

  return merged;
}

/**
 * Subscribes to turn events through an EventSource fallback.
 */
function subscribeTurnEventsWithEventSource(
  options: SubscribeTurnEventsOptions,
  eventSourceFactory: EventSourceConstructor
): AsyncIterable<SseEventEnvelope> {
  const normalizedBaseUrl = options.baseUrl.replace(/\/$/, '');
  const queue: QueueState = { values: [], errors: [], resolvers: [] };
  let source: EventSourceLike | null = null;
  let stopped = false;
  let terminalSeen = false;
  let lastSeen = options.since ?? 0;

  const wake = (): void => {
    const resolvers = queue.resolvers.splice(0);

    for (const resolve of resolvers) {
      resolve();
    }
  };

  const buildUrl = (): string => {
    const path = `/api/workspaces/${encodeURIComponent(options.workspaceId)}/threads/${encodeURIComponent(
      options.threadId
    )}/events`;
    const params = new URLSearchParams({
      turnId: options.turnId,
      since: String(lastSeen),
    });

    if (normalizedBaseUrl === '') {
      return `${path}?${params.toString()}`;
    }

    const url = new URL(path, normalizedBaseUrl);
    url.search = params.toString();
    return url.toString();
  };

  const reopen = (): void => {
    if (stopped) {
      return;
    }

    const previousSource = source;
    source = null;
    previousSource?.close();
    source = new eventSourceFactory(buildUrl());
    const openedSource = source;

    source.addEventListener('message', (event) => {
      if (stopped || source !== openedSource) return;

      try {
        const decoded = decodeSseFrame((event as MessageEvent<string>).data);

        if (decoded.sequence <= lastSeen) {
          return;
        }

        lastSeen = decoded.sequence;

        if (decoded.envelope === null) {
          return;
        }

        const delivery = classifyTurnEventDelivery(decoded.envelope, options);

        if (delivery === 'withhold') {
          return;
        }

        queue.values.push(decoded.envelope);

        if (delivery === 'terminal') {
          terminalSeen = true;
          stopped = true;
          source?.close();
        }

        wake();
      } catch (error) {
        queue.values.length = 0;
        queue.errors.push(error);
        stopped = true;
        source?.close();
        wake();
      }
    });

    source.addEventListener('error', () => {
      if (source !== openedSource) return;

      if (terminalSeen) {
        source?.close();
        wake();
        return;
      }

      try {
        reopen();
      } catch (error) {
        queue.values.length = 0;
        queue.errors.push(error);
        stopped = true;
        wake();
      }
    });
  };

  reopen();

  return createIterator(
    queue,
    () => stopped,
    () => {
      stopped = true;
      source?.close();
      wake();
    }
  );
}

/**
 * Creates an async iterator over a queued stream.
 */
function createIterator(
  queue: QueueState,
  isStopped: () => boolean,
  stop: () => void
): AsyncIterable<SseEventEnvelope> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SseEventEnvelope> {
      return {
        async next(): Promise<IteratorResult<SseEventEnvelope>> {
          while (true) {
            const error = queue.errors.shift();

            if (error !== undefined) {
              throw error;
            }

            const value = queue.values.shift();

            if (value !== undefined) {
              return { value, done: false };
            }

            if (isStopped()) {
              return { value: undefined, done: true };
            }

            await new Promise<void>((resolve) => {
              queue.resolvers.push(resolve);
            });
          }
        },
        async return(): Promise<IteratorResult<SseEventEnvelope>> {
          stop();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * Reads an SSE response body and dispatches complete data frames.
 */
async function readSseBody(
  response: Response,
  onData: (data: string) => void,
  shouldStop: () => boolean
): Promise<void> {
  const reader = response.body?.getReader();

  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let lineBuffer = '';
  let dataLines: string[] = [];

  const processLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      if (dataLines.length > 0) {
        onData(dataLines.join('\n'));
        dataLines = [];
      }
      return;
    }

    if (line.startsWith(':')) {
      return;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);

    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'data') {
      dataLines.push(value);
    }
  };

  const processText = (text: string): void => {
    lineBuffer += text;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      processLine(line);

      if (shouldStop()) {
        return;
      }
    }
  };

  while (!shouldStop()) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    processText(decoder.decode(value, { stream: true }));
  }

  const tail = decoder.decode();

  if (tail && !shouldStop()) {
    processText(tail);
  }
}

/**
 * Checks whether an error came from an intentional abort.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
