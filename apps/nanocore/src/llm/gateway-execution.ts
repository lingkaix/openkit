import type { ResolvedLogicalModel, ResolvedLogicalModelRoute } from './logical-models.js';
import type { PiAiFailure, PiAiFailureKind } from './pi-ai-failure.js';

/** Engineer-fixed same-member waits; one initial attempt plus these three retries. */
export const GATEWAY_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
/** Engineer-fixed maximum Provider-requested wait; longer delays are never shortened. */
export const GATEWAY_RETRY_AFTER_CEILING_MS = 10_000;
/** Maximum private lifecycle bytes before a live attempt commits. */
export const GATEWAY_PRECOMMIT_BUFFER_BYTES = 32 * 1024;
/**
 * Absolute pre-commit budget, never a transport timeout. Codex 0.153.4 and the
 * DeepSeek client's default stream idle limits are 300s; OpenCode's transport uses
 * 30 minutes and pi-ai's SSE paths impose no shorter default idle fuse. 120s leaves
 * room for the fixed 1/2/4s waits and 10s Retry-After while committing before those
 * idle limits. The worker heartbeat introduced in 0d754628 keeps committed idle
 * inference streams live; it must not expose private attempts to achieve that.
 */
export const GATEWAY_PRECOMMIT_DEADLINE_MS = 120_000;

/** Injectable request clock; production uses the same absolute wall clock for Retry-After dates. */
export interface GatewayClock {
  now(): number;
  setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}
/** Production clock has no routing or durable lifecycle. */
export const gatewayClock: GatewayClock = {
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

/** Request-local selection fact for the later private lineage consumer. */
export interface GatewaySelection {
  readonly route: ResolvedLogicalModelRoute;
  readonly selected: boolean;
  readonly reason: string;
}

/**
 * Plans authored members against the pinned request without Provider effects.
 * @param model Current resolved tier and routing switch.
 * @param requiredCapabilities Requirements admitted for this request/run.
 * @param eligible Current capability predicate; unavailable and dormant members are not inspected.
 * @returns Ordered selection facts, including exclusions without invented attempts.
 */
export function planLogicalModel(
  model: ResolvedLogicalModel,
  requiredCapabilities: readonly string[],
  eligible: (route: ResolvedLogicalModelRoute, required: readonly string[]) => boolean
): readonly GatewaySelection[] {
  return model.routes.map((route, index) => {
    const reason =
      !model.autoFailover && index > 0
        ? 'failover_disabled'
        : !route.available
          ? (route.unavailableReason ?? 'provider_unavailable')
          : !eligible(route, requiredCapabilities)
            ? 'pinned_capability_unavailable'
            : index === 0
              ? 'primary'
              : 'backup';
    return { route, selected: reason === 'primary' || reason === 'backup', reason };
  });
}

/** One failure projection; the original exception stays private and never supplies classification. */
export class GatewayAttemptFailure extends Error {
  /** Boundary-produced or owner-assigned failure evidence. */
  public readonly failure: PiAiFailure;
  /** Local member checks may advance but are never retried as reached Provider attempts. */
  public readonly beforeDispatch: boolean;
  /** Creates a typed private failure without inventing upstream status. */
  public constructor(failure: PiAiFailure, original?: unknown, beforeDispatch = false) {
    super('Provider attempt failed.', { cause: original });
    this.failure = failure;
    this.beforeDispatch = beforeDispatch;
  }
}

/** Stable tier exhaustion with only the terminating closed kind as its optional cause. */
export class LogicalModelRoutesExhaustedError extends Error {
  public readonly code = 'gateway_logical_model_unavailable';
  public readonly status = 503;
  public readonly type = 'provider_error';
  declare readonly cause?: PiAiFailureKind;
  /** Selection without an attempt has no cause. */
  public constructor(cause?: PiAiFailureKind) {
    super('Logical model is temporarily unavailable.');
    this.name = 'LogicalModelRoutesExhaustedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Sole projection from the accepted failure table to retry and advancement decisions. */
export function gatewayFailureDecision(
  kind: PiAiFailureKind,
  autoFailover: boolean
): {
  retry: boolean;
  advance: boolean;
} {
  return {
    retry: kind === 'rate_limited' || kind === 'provider_unavailable',
    advance:
      autoFailover &&
      ['auth_rejected', 'quota_exhausted', 'rate_limited', 'provider_unavailable'].includes(kind),
  };
}

/** Private attempt facts and the one-way commit operation shared by every consumer. */
export interface GatewayAttemptContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly attemptOrder: number;
  readonly retryIndex: number;
  readonly selectionReason: string;
  /** Records optional effort facts at stock-adapter handoff after OpenKit admission, independently of output or commit. */
  readonly onProviderHandoff?: () => void;
  /** True only after outward model content or a validated non-stream result is released. */
  readonly outputBegan: boolean;
  /** True once stream preparation succeeded; its terminal result arrives during consumption. */
  readonly streamPrepared: boolean;
  /** Releases a validated non-stream result. Deadline/cap commits do not imply output. */
  commit(): void;
  /** Reads privately before releasing the public Response/heartbeat. */
  prepareStream(
    stream: ReadableStream<Uint8Array>,
    observe?: (state: GatewayStreamState, error?: unknown) => void
  ): Promise<ReadableStream<Uint8Array>>;
  /** Associates existing retained measurements with this descriptive attempt. */
  addUsageRecordIds(ids: readonly string[]): void;
}

/**
 * Executes one ephemeral plan under the closed failure table and a shared absolute deadline.
 * @param input Plan, caller cancellation, owned attempt callback and optional test clock.
 * @returns First validated successful result; no committed or uncertain effect is repeated.
 */
export async function executeGatewayPlan<T>(input: {
  selections: readonly GatewaySelection[];
  autoFailover: boolean;
  signal: AbortSignal;
  attempt(selection: GatewaySelection, context: GatewayAttemptContext): Promise<T>;
  clock?: GatewayClock;
}): Promise<T> {
  const clock = input.clock ?? gatewayClock;
  const deadline = clock.now() + GATEWAY_PRECOMMIT_DEADLINE_MS;
  let committed = false;
  let expired = false;
  let order = 0;
  let lastFailure: PiAiFailure | undefined;
  const timer = clock.setTimer(() => {
    expired = true;
    committed = active;
  }, GATEWAY_PRECOMMIT_DEADLINE_MS);
  let active = false;
  try {
    for (const selection of input.selections) {
      if (!selection.selected) continue;
      for (let retryIndex = 0; ; retryIndex++) {
        input.signal.throwIfAborted();
        if (expired || clock.now() >= deadline) break;
        let outputBegan = false;
        let streamPrepared = false;
        const context: GatewayAttemptContext = {
          get outputBegan() {
            return outputBegan;
          },
          get streamPrepared() {
            return streamPrepared;
          },
          addUsageRecordIds: () => {},
          signal: input.signal,
          deadline,
          retryIndex,
          attemptOrder: order++,
          selectionReason: selection.reason,
          commit: () => {
            committed = true;
            if (!streamPrepared) outputBegan = true;
          },
          prepareStream: async (stream, observe) => {
            const prepared = await prepareGatewayStream(
              stream,
              input.signal,
              deadline,
              clock,
              (state, error) => {
                if (state === 'output') outputBegan = true;
                observe?.(state, error);
              }
            );
            streamPrepared = true;
            committed = true;
            return prepared;
          },
        };
        active = true;
        try {
          // The adapter owns active-attempt cancellation. Await its observed outcome so a late
          // disconnect cannot replace an independently settled Provider failure.
          const result = await input.attempt(selection, context);
          context.commit();
          return result;
        } catch (error) {
          if (input.signal.aborted && error === input.signal.reason) throw error;
          const failure = (error as { failure?: PiAiFailure } | null)?.failure;
          if (!failure) throw error; // Authority, persistence and output validation retain their owning errors.
          lastFailure = failure;
          const decision = gatewayFailureDecision(failure.kind, input.autoFailover);
          if (
            input.signal.aborted ||
            committed ||
            !failure.settled ||
            (!decision.retry && !decision.advance)
          )
            throw new GatewayAttemptFailure(failure, error);
          if (expired || clock.now() >= deadline) throw new GatewayAttemptFailure(failure, error);
          if (
            decision.retry &&
            !(error instanceof GatewayAttemptFailure && error.beforeDispatch) &&
            retryIndex < GATEWAY_RETRY_DELAYS_MS.length
          ) {
            const delay = retryDelay(failure, retryIndex, clock.now());
            if (delay !== undefined && delay < deadline - clock.now()) {
              active = false;
              await waitGatewayDelay(delay, input.signal, clock);
              continue;
            }
          }
          if (!decision.advance) throw new GatewayAttemptFailure(failure, error);
          break;
        } finally {
          active = false;
        }
      }
      if (expired || clock.now() >= deadline) break;
    }
    if (!input.autoFailover && lastFailure) throw new GatewayAttemptFailure(lastFailure);
    throw new LogicalModelRoutesExhaustedError(lastFailure?.kind);
  } catch (error) {
    if (input.signal.aborted && error === input.signal.reason)
      throw new GatewayAttemptFailure({ kind: 'cancelled', settled: false }, error);
    throw error;
  } finally {
    clock.clearTimer(timer);
  }
}

/** Provider delay overrides exponential backoff only when its full value is permitted. */
function retryDelay(failure: PiAiFailure, retryIndex: number, now: number): number | undefined {
  if (failure.retryAfter === undefined) return GATEWAY_RETRY_DELAYS_MS[retryIndex];
  const numeric = /^\s*\d+(?:\.\d+)?\s*$/.test(failure.retryAfter)
    ? Number(failure.retryAfter) * 1000
    : NaN;
  const date = Date.parse(failure.retryAfter);
  const delay = Number.isFinite(numeric)
    ? numeric
    : Number.isFinite(date)
      ? Math.max(0, date - now)
      : GATEWAY_RETRY_DELAYS_MS[retryIndex];
  return delay !== undefined && delay <= GATEWAY_RETRY_AFTER_CEILING_MS ? delay : undefined;
}

/** Waits abortably and always disposes the listener/timer. */
async function waitGatewayDelay(
  delay: number,
  signal: AbortSignal,
  clock: GatewayClock
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await withGatewayCancellation(
      () =>
        new Promise<void>((resolve) => {
          timer = clock.setTimer(resolve, delay);
        }),
      signal
    );
  } finally {
    if (timer !== undefined) clock.clearTimer(timer);
  }
}

/** Cancellation wins pending work without claiming an uncertain effect never started. */
async function withGatewayCancellation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Released stream facts; unknown EOF is never successful terminal evidence. */
export type GatewayStreamState =
  | 'output'
  | 'failed'
  | 'completed'
  | 'incomplete'
  | 'interrupted'
  | 'unknown'
  | 'lifecycle';

/** Reads only event structure, never upstream text, to recognize released output or terminal failure. */
function streamEventState(frame: string): GatewayStreamState {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data === '[DONE]') return 'completed';
  try {
    const event = JSON.parse(data);
    if (event.error || event.type === 'response.failed' || event.response?.status === 'failed')
      return 'failed';
    if (event.type === 'response.incomplete') return 'incomplete';
    if (event.type === 'response.completed') return 'completed';
    if (
      typeof event.type === 'string' &&
      /^response\.(?:output_text|reasoning(?:_text|_summary_text)?|function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(
        event.type
      ) &&
      (event.delta || event.text || event.arguments || event.input)
    )
      return 'output';
    if (
      (event.type === 'response.content_part.added' ||
        event.type === 'response.content_part.done') &&
      (event.part?.text || event.part?.refusal)
    )
      return 'output';
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (
        ['function_call', 'custom_tool_call'].includes(event.item?.type) &&
        (event.item.name || event.item.call_id)
      )
        return 'output';
      if (
        event.item?.type === 'reasoning' &&
        (event.item.encrypted_content ||
          event.item.summary?.some((part: { text?: string }) => part.text))
      )
        return 'output';
      if (
        event.item?.content?.some(
          (part: { type: string; text?: string; refusal?: string }) =>
            (part.type === 'output_text' && part.text) || part.refusal
        )
      )
        return 'output';
    }
    if (
      event.choices?.some(
        (choice: {
          delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] };
          finish_reason?: string;
        }) =>
          choice.delta?.content ||
          choice.delta?.reasoning_content ||
          choice.delta?.tool_calls?.length
      )
    )
      return 'output';
  } catch {
    /* Fragmented/lifecycle bytes remain private until bounded commit or a completed frame. */
  }
  return 'lifecycle';
}

/**
 * Holds lifecycle events under a fixed byte cap and deadline; a known failure is never flushed.
 * @param stream Adapter SSE before terminal normalization or heartbeat insertion.
 * @param signal Caller cancellation; deadline expiry commits instead of killing a live Provider.
 * @param deadline Absolute request deadline shared across attempts and waits.
 * @param clock Optional injected clock.
 * @returns Stream replaying held bytes once, followed by the original locked reader.
 */
export async function prepareGatewayStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  deadline: number,
  clock: GatewayClock = gatewayClock,
  observe?: (state: GatewayStreamState, error?: unknown) => void
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  const held: Uint8Array[] = [];
  let bytes = 0;
  let frames = '';
  const decoder = new TextDecoder();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = clock.setTimer(() => resolve(null), Math.max(0, deadline - clock.now()));
  });
  try {
    while (true) {
      pending ??= reader.read();
      const result = await withGatewayCancellation(() => Promise.race([pending!, expired]), signal);
      if (result === null) break;
      pending = undefined;
      if (result.done) throw new GatewayAttemptFailure({ kind: 'unknown', settled: false });
      held.push(result.value);
      bytes += result.value.byteLength;
      frames += decoder.decode(result.value, { stream: true });
      let output = false;
      let boundary = /\r?\n\r?\n/.exec(frames);
      while (boundary?.index !== undefined) {
        const state = streamEventState(frames.slice(0, boundary.index));
        if (state === 'failed') throw new GatewayAttemptFailure({ kind: 'unknown', settled: true });
        output ||= state === 'output' || state === 'completed' || state === 'incomplete';
        frames = frames.slice(boundary.index + boundary[0].length);
        boundary = /\r?\n\r?\n/.exec(frames);
      }
      if (output || bytes >= GATEWAY_PRECOMMIT_BUFFER_BYTES) break;
    }
  } catch (error) {
    void reader
      .cancel(error)
      .catch(() => undefined)
      .finally(() => reader.releaseLock());
    throw error;
  } finally {
    if (timer !== undefined) clock.clearTimer(timer);
  }
  let releasedFrames = '';
  const releasedDecoder = new TextDecoder();
  let terminalObserved = false;
  const release = (chunk: Uint8Array) => {
    releasedFrames += releasedDecoder.decode(chunk, { stream: true });
    let boundary = /\r?\n\r?\n/.exec(releasedFrames);
    while (boundary?.index !== undefined) {
      const state = streamEventState(releasedFrames.slice(0, boundary.index));
      if (['failed', 'completed', 'incomplete'].includes(state)) terminalObserved = true;
      observe?.(state);
      releasedFrames = releasedFrames.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/.exec(releasedFrames);
    }
  };
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (index < held.length) {
          const chunk = held[index++]!;
          release(chunk);
          controller.enqueue(chunk);
          return;
        }
        try {
          const result = await (pending ?? reader.read());
          pending = undefined;
          if (result.done) {
            reader.releaseLock();
            if (!terminalObserved) {
              observe?.('unknown');
              controller.error(
                Object.assign(new Error('Provider stream ended without terminal evidence.'), {
                  code: 'provider_stream_truncated',
                })
              );
            } else controller.close();
          } else {
            release(result.value);
            controller.enqueue(result.value);
          }
        } catch (error) {
          observe?.('failed', error);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          observe?.('interrupted');
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 }
  );
}
