import { z } from 'zod';

import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleChatMessage,
} from '../llm/openai-compatible-client.js';
import type { LLMGatewayDispatchContext } from '../llm/provider-dispatcher.js';
import { redactInternalAgentText } from './redaction.js';
import type {
  InternalAgentDefinition,
  InternalAgentRunInput,
  InternalAgentStopReason,
  InternalAgentStreamEvent,
} from './types.js';

/**
 * Input required to execute one pure internal-agent loop turn.
 */
export interface InternalAgentLoopInput {
  /** Internal agent definition that owns prompts, limits, and schema policy. */
  readonly definition: InternalAgentDefinition;
  /** Caller-provided run input for the internal agent. */
  readonly input: InternalAgentRunInput;
  /** Provider id selected by the outer runner. */
  readonly providerId: string;
  /** Model selected by the outer runner. */
  readonly model: string;
  /** Whether the loop should prefer the streaming provider effect when available. */
  readonly stream?: boolean;
  /** Optional abort signal used to stop the bounded loop before provider completion. */
  readonly signal?: AbortSignal;
}

/**
 * Provider call prepared by the internal-agent loop.
 */
export interface InternalAgentLoopProviderCallInput {
  /** Provider id selected by the outer runner. */
  readonly providerId: string;
  /** OpenAI-compatible chat completion request. */
  readonly request: OpenAICompatibleChatCompletionRequest;
  /** Optional gateway dispatch context carried from the caller. */
  readonly context?: LLMGatewayDispatchContext;
  /** Optional abort signal supplied by the loop caller. */
  readonly signal?: AbortSignal;
}

/**
 * Normalized streaming text delta emitted by a provider effect.
 */
export interface InternalAgentLoopStreamDelta {
  /** Text delta appended to the assistant message. */
  readonly delta: string;
}

/**
 * Normalized assistant output used for message events.
 */
export interface InternalAgentLoopNormalizedOutput {
  /** Final assistant text emitted by the provider. */
  readonly content: string;
}

/**
 * Effect dependencies required by the internal-agent loop.
 */
export interface InternalAgentLoopEffects {
  /**
   * Calls the selected provider without the loop reading global provider state.
   *
   * @param input Provider call prepared by the loop.
   * @returns Non-streaming OpenAI-compatible chat completion response.
   */
  readonly callProvider: (
    input: InternalAgentLoopProviderCallInput
  ) => Promise<OpenAICompatibleChatCompletionResponse>;
  /**
   * Calls the selected provider in streaming mode when the caller asks for streaming events.
   *
   * @param input Provider stream call prepared by the loop.
   * @returns Async iterable of normalized text deltas.
   */
  readonly callProviderStream?: (
    input: InternalAgentLoopProviderCallInput
  ) =>
    | AsyncIterable<InternalAgentLoopStreamDelta>
    | Promise<AsyncIterable<InternalAgentLoopStreamDelta>>;
  /**
   * Creates a stable app-local run id.
   *
   * @returns Run id for all events in this invocation.
   */
  readonly createRunId: () => string;
  /**
   * Creates a stable app-local turn id.
   *
   * @returns Turn id for all turn-scoped events in this invocation.
   */
  readonly createTurnId: () => string;
  /**
   * Creates a stable app-local assistant message id.
   *
   * @returns Message id for all message-scoped events in this invocation.
   */
  readonly createMessageId: () => string;
  /**
   * Reads the current time for deterministic event timestamps.
   *
   * @returns Current time.
   */
  readonly now: () => Date;
  /**
   * Normalizes a provider response into the assistant text emitted by message events.
   *
   * @param completion Provider completion response.
   * @returns Normalized assistant output.
   */
  readonly normalizeCompletion?: (
    completion: OpenAICompatibleChatCompletionResponse
  ) => InternalAgentLoopNormalizedOutput;
}

/**
 * Output validation error raised when a loop response fails the agent schema.
 */
class InternalAgentLoopOutputValidationError extends Error {
  /**
   * Creates one loop output validation error.
   *
   * @param message Human-readable validation message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'InternalAgentLoopOutputValidationError';
  }
}

/**
 * Timeout error raised when a provider call exceeds the internal agent budget.
 */
class InternalAgentLoopTimeoutError extends Error {
  /**
   * Creates one loop timeout error.
   *
   * @param displayName Human-readable internal agent name.
   * @param timeoutMs Timeout budget in milliseconds.
   */
  public constructor(displayName: string, timeoutMs: number) {
    super(`${displayName} timed out after ${timeoutMs}ms.`);
    this.name = 'InternalAgentLoopTimeoutError';
  }
}

/**
 * Abort error raised when the caller aborts an internal agent loop.
 */
class InternalAgentLoopAbortError extends Error {
  /**
   * Creates one loop abort error.
   */
  public constructor() {
    super('Internal agent loop was aborted.');
    this.name = 'InternalAgentLoopAbortError';
  }
}

/**
 * Normalized terminal failure emitted by the internal-agent loop.
 */
interface InternalAgentLoopTerminalFailure {
  /** Terminal event status. */
  readonly status: 'error' | 'aborted';
  /** Stable stop reason for terminal events. */
  readonly stopReason: InternalAgentStopReason;
  /** Redacted error message safe for diagnostics and app-local streams. */
  readonly errorMessage: string;
}

/**
 * Internal-agent stream event before the loop assigns a run-local sequence.
 */
type InternalAgentUnsequencedStreamEvent = InternalAgentStreamEvent extends infer TEvent
  ? TEvent extends InternalAgentStreamEvent
    ? Omit<TEvent, 'sequence'>
    : never
  : never;

/**
 * Runs one effect-injected internal-agent loop and emits app-local stream events.
 *
 * @param loopInput Provider-selected internal-agent loop input.
 * @param effects Effect dependencies supplied by the caller.
 * @yields Internal agent stream events in lifecycle order.
 */
export async function* internalAgentLoop(
  loopInput: InternalAgentLoopInput,
  effects: InternalAgentLoopEffects
): AsyncGenerator<InternalAgentStreamEvent, void, void> {
  const { definition, input, model, providerId, signal } = loopInput;
  const runId = effects.createRunId();
  const turnId = effects.createTurnId();
  const messageId = effects.createMessageId();
  const runStartedAt = effects.now();
  let sequence = 0;
  const withSequence = (event: InternalAgentUnsequencedStreamEvent) =>
    ({ ...event, sequence: sequence++ }) as InternalAgentStreamEvent;

  yield withSequence({
    eventType: 'agent_start',
    agentId: definition.id,
    runId,
    timestamp: runStartedAt.toISOString(),
    providerId,
    model,
  });

  const turnStartedAt = effects.now();

  yield withSequence({
    eventType: 'turn_start',
    agentId: definition.id,
    runId,
    turnId,
    timestamp: turnStartedAt.toISOString(),
    inputMessageCount: input.messages.length,
  });

  let output: InternalAgentLoopNormalizedOutput;

  if (loopInput.stream) {
    yield* runStreamingLoop(loopInput, effects, {
      messageId,
      runId,
      runStartedAt,
      turnId,
      turnStartedAt,
      withSequence,
    });

    return;
  }

  try {
    assertLoopNotAborted(signal);
    const completion = await callProviderWithLoopBounds(loopInput, effects);

    output = (effects.normalizeCompletion ?? normalizeChatCompletion)(completion);
    validateLoopOutput(definition, output.content);
  } catch (error) {
    const failure = normalizeLoopFailure(error);
    const turnEndedAt = effects.now();

    yield withSequence({
      eventType: 'turn_end',
      agentId: definition.id,
      runId,
      turnId,
      timestamp: turnEndedAt.toISOString(),
      status: failure.status,
      stopReason: failure.stopReason,
      durationMs: turnEndedAt.getTime() - turnStartedAt.getTime(),
      errorMessage: failure.errorMessage,
    });

    const runEndedAt = effects.now();

    yield withSequence({
      eventType: 'agent_end',
      agentId: definition.id,
      runId,
      timestamp: runEndedAt.toISOString(),
      status: failure.status,
      stopReason: failure.stopReason,
      durationMs: runEndedAt.getTime() - runStartedAt.getTime(),
      errorMessage: failure.errorMessage,
    });

    return;
  }

  const messageStartedAt = effects.now();

  yield withSequence({
    eventType: 'message_start',
    agentId: definition.id,
    runId,
    turnId,
    messageId,
    timestamp: messageStartedAt.toISOString(),
    role: 'assistant',
  });

  yield withSequence({
    eventType: 'message_update',
    agentId: definition.id,
    runId,
    turnId,
    messageId,
    timestamp: effects.now().toISOString(),
    delta: output.content,
  });

  yield withSequence({
    eventType: 'message_end',
    agentId: definition.id,
    runId,
    turnId,
    messageId,
    timestamp: effects.now().toISOString(),
    status: 'completed',
    stopReason: 'completed',
    content: output.content,
  });

  const turnEndedAt = effects.now();

  yield withSequence({
    eventType: 'turn_end',
    agentId: definition.id,
    runId,
    turnId,
    timestamp: turnEndedAt.toISOString(),
    status: 'completed',
    stopReason: 'completed',
    durationMs: turnEndedAt.getTime() - turnStartedAt.getTime(),
  });

  const runEndedAt = effects.now();

  yield withSequence({
    eventType: 'agent_end',
    agentId: definition.id,
    runId,
    timestamp: runEndedAt.toISOString(),
    status: 'completed',
    stopReason: 'completed',
    durationMs: runEndedAt.getTime() - runStartedAt.getTime(),
  });
}

/**
 * Creates the non-streaming chat completion request for an internal-agent loop turn.
 *
 * @param definition Internal agent definition that owns the system prompt.
 * @param input Internal agent run input supplied by the caller.
 * @param model Selected provider model.
 * @returns Provider-ready chat completion request.
 */
function createLoopCompletionRequest(
  definition: InternalAgentDefinition,
  input: InternalAgentRunInput,
  model: string,
  stream?: boolean
): OpenAICompatibleChatCompletionRequest {
  return {
    model,
    messages: createLoopPromptMessages(definition, input),
    ...(stream === undefined ? {} : { stream }),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

/**
 * Prepends the agent-owned system prompt to caller-visible messages.
 *
 * @param definition Internal agent definition that owns the system prompt.
 * @param input Internal agent run input supplied by the caller.
 * @returns Provider-ready prompt messages.
 */
function createLoopPromptMessages(
  definition: InternalAgentDefinition,
  input: InternalAgentRunInput
): OpenAICompatibleChatMessage[] {
  return [{ role: 'system', content: definition.systemPrompt }, ...input.messages];
}

/**
 * Downstream provider cancellation and stable loop failure race.
 */
interface InternalAgentProviderBounds {
  /** Aborts downstream provider work without changing the selected loop outcome. */
  readonly abort: () => void;
  /** Stable timeout or caller-abort failure raced against provider work. */
  readonly failure: Promise<never>;
  /** Signal passed only to the downstream provider transport. */
  readonly signal: AbortSignal;
  /** Removes the caller listener and timeout after the provider path settles. */
  readonly dispose: () => void;
}

/**
 * Creates one downstream signal whose first caller-abort or timeout keeps its stable loop error.
 *
 * @param definition Internal agent definition that owns the timeout budget.
 * @param callerSignal Optional caller cancellation signal.
 * @returns Provider signal, stable failure promise, and cleanup callback.
 */
function createProviderBounds(
  definition: InternalAgentDefinition,
  callerSignal: AbortSignal | undefined
): InternalAgentProviderBounds {
  const controller = new AbortController();
  let settled = false;
  let abortListener: (() => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const failure = new Promise<never>((_resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
      controller.abort(error);
    };

    timeout = setTimeout(() => {
      fail(new InternalAgentLoopTimeoutError(definition.displayName, definition.limits.timeoutMs));
    }, definition.limits.timeoutMs);

    if (callerSignal) {
      abortListener = () => fail(new InternalAgentLoopAbortError());
      if (callerSignal.aborted) {
        abortListener();
      } else {
        callerSignal.addEventListener('abort', abortListener, { once: true });
      }
    }
  });

  return {
    abort: () => controller.abort(new InternalAgentLoopAbortError()),
    failure,
    signal: controller.signal,
    dispose: () => {
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (callerSignal && abortListener) {
        callerSignal.removeEventListener('abort', abortListener);
      }
    },
  };
}

/**
 * Calls the provider while enforcing caller abort and internal timeout bounds.
 *
 * @param loopInput Provider-selected internal-agent loop input.
 * @param effects Effect dependencies supplied by the caller.
 * @returns Provider completion response.
 * @throws InternalAgentLoopAbortError when the caller aborts the loop.
 * @throws InternalAgentLoopTimeoutError when the timeout budget is exceeded.
 */
async function callProviderWithLoopBounds(
  loopInput: InternalAgentLoopInput,
  effects: InternalAgentLoopEffects
): Promise<OpenAICompatibleChatCompletionResponse> {
  const { definition, input, model, providerId, signal } = loopInput;
  assertLoopNotAborted(signal);
  const bounds = createProviderBounds(definition, signal);

  try {
    return await Promise.race([
      effects.callProvider({
        providerId,
        request: createLoopCompletionRequest(definition, input, model),
        ...(input.dispatchContext ? { context: input.dispatchContext } : {}),
        signal: bounds.signal,
      }),
      bounds.failure,
    ]);
  } finally {
    bounds.dispose();
  }
}

/**
 * Event identity captured before a streaming provider call begins.
 */
interface InternalAgentStreamingLoopContext {
  /** Message id used for streaming message events. */
  readonly messageId: string;
  /** Run id shared by all loop events. */
  readonly runId: string;
  /** Run start timestamp. */
  readonly runStartedAt: Date;
  /** Turn id shared by turn-scoped events. */
  readonly turnId: string;
  /** Turn start timestamp. */
  readonly turnStartedAt: Date;
  /** Adds the next run-local sequence number to one stream event. */
  readonly withSequence: (event: InternalAgentUnsequencedStreamEvent) => InternalAgentStreamEvent;
}

/**
 * Runs the streaming branch of the internal-agent loop.
 *
 * @param loopInput Provider-selected internal-agent loop input.
 * @param effects Effect dependencies supplied by the caller.
 * @param context Event identity captured by the outer loop.
 * @yields Internal agent stream events for the streaming invocation.
 */
async function* runStreamingLoop(
  loopInput: InternalAgentLoopInput,
  effects: InternalAgentLoopEffects,
  context: InternalAgentStreamingLoopContext
): AsyncGenerator<InternalAgentStreamEvent, void, void> {
  const { definition } = loopInput;
  const messageStartedAt = effects.now();
  let content = '';

  yield context.withSequence({
    eventType: 'message_start',
    agentId: definition.id,
    runId: context.runId,
    turnId: context.turnId,
    messageId: context.messageId,
    timestamp: messageStartedAt.toISOString(),
    role: 'assistant',
  });

  try {
    assertLoopNotAborted(loopInput.signal);

    for await (const event of callProviderStreamWithLoopBounds(loopInput, effects)) {
      content += event.delta;

      yield context.withSequence({
        eventType: 'message_update',
        agentId: definition.id,
        runId: context.runId,
        turnId: context.turnId,
        messageId: context.messageId,
        timestamp: effects.now().toISOString(),
        delta: event.delta,
      });
    }

    validateLoopOutput(definition, content);
  } catch (error) {
    const failure = normalizeLoopFailure(error);

    yield context.withSequence({
      eventType: 'message_end',
      agentId: definition.id,
      runId: context.runId,
      turnId: context.turnId,
      messageId: context.messageId,
      timestamp: effects.now().toISOString(),
      status: failure.status,
      stopReason: failure.stopReason,
      content,
      errorMessage: failure.errorMessage,
    });

    yield* emitTerminalFailure(loopInput, effects, context, failure);
    return;
  }

  yield context.withSequence({
    eventType: 'message_end',
    agentId: definition.id,
    runId: context.runId,
    turnId: context.turnId,
    messageId: context.messageId,
    timestamp: effects.now().toISOString(),
    status: 'completed',
    stopReason: 'completed',
    content,
  });

  const turnEndedAt = effects.now();

  yield context.withSequence({
    eventType: 'turn_end',
    agentId: definition.id,
    runId: context.runId,
    turnId: context.turnId,
    timestamp: turnEndedAt.toISOString(),
    status: 'completed',
    stopReason: 'completed',
    durationMs: turnEndedAt.getTime() - context.turnStartedAt.getTime(),
  });

  const runEndedAt = effects.now();

  yield context.withSequence({
    eventType: 'agent_end',
    agentId: definition.id,
    runId: context.runId,
    timestamp: runEndedAt.toISOString(),
    status: 'completed',
    stopReason: 'completed',
    durationMs: runEndedAt.getTime() - context.runStartedAt.getTime(),
  });
}

/**
 * Emits terminal failure lifecycle events for a streaming loop.
 *
 * @param loopInput Provider-selected internal-agent loop input.
 * @param effects Effect dependencies supplied by the caller.
 * @param context Event identity captured by the outer loop.
 * @param failure Normalized terminal failure.
 * @yields Terminal turn and agent events.
 */
async function* emitTerminalFailure(
  loopInput: InternalAgentLoopInput,
  effects: InternalAgentLoopEffects,
  context: InternalAgentStreamingLoopContext,
  failure: InternalAgentLoopTerminalFailure
): AsyncGenerator<InternalAgentStreamEvent, void, void> {
  const { definition } = loopInput;
  const turnEndedAt = effects.now();

  yield context.withSequence({
    eventType: 'turn_end',
    agentId: definition.id,
    runId: context.runId,
    turnId: context.turnId,
    timestamp: turnEndedAt.toISOString(),
    status: failure.status,
    stopReason: failure.stopReason,
    durationMs: turnEndedAt.getTime() - context.turnStartedAt.getTime(),
    errorMessage: failure.errorMessage,
  });

  const runEndedAt = effects.now();

  yield context.withSequence({
    eventType: 'agent_end',
    agentId: definition.id,
    runId: context.runId,
    timestamp: runEndedAt.toISOString(),
    status: failure.status,
    stopReason: failure.stopReason,
    durationMs: runEndedAt.getTime() - context.runStartedAt.getTime(),
    errorMessage: failure.errorMessage,
  });
}

/**
 * Calls the streaming provider effect while enforcing creation, iteration, timeout, and abort bounds.
 *
 * @param loopInput Provider-selected internal-agent loop input.
 * @param effects Effect dependencies supplied by the caller.
 * @yields Normalized provider text deltas.
 * @throws InternalAgentLoopAbortError when the caller aborts the loop.
 * @throws InternalAgentLoopTimeoutError when the timeout budget is exceeded.
 */
async function* callProviderStreamWithLoopBounds(
  loopInput: InternalAgentLoopInput,
  effects: InternalAgentLoopEffects
): AsyncGenerator<InternalAgentLoopStreamDelta, void, void> {
  const { definition, input, model, providerId, signal } = loopInput;

  if (!effects.callProviderStream) {
    const completion = await callProviderWithLoopBounds(loopInput, effects);
    const normalized = (effects.normalizeCompletion ?? normalizeChatCompletion)(completion);

    yield { delta: normalized.content };
    return;
  }

  assertLoopNotAborted(signal);
  const bounds = createProviderBounds(definition, signal);
  let iterator: AsyncIterator<InternalAgentLoopStreamDelta> | null = null;
  let iteratorDone = false;
  let providerStream: Promise<AsyncIterable<InternalAgentLoopStreamDelta>> | null = null;

  try {
    providerStream = Promise.resolve(
      effects.callProviderStream({
        providerId,
        request: createLoopCompletionRequest(definition, input, model, true),
        ...(input.dispatchContext ? { context: input.dispatchContext } : {}),
        signal: bounds.signal,
      })
    );
    const deltas = await Promise.race([providerStream, bounds.failure]);
    iterator = deltas[Symbol.asyncIterator]();

    while (true) {
      const result = await Promise.race([iterator.next(), bounds.failure]);

      if (result.done) {
        iteratorDone = true;
        break;
      }

      yield result.value;
    }
  } finally {
    bounds.dispose();
    if (!iterator && providerStream) {
      bounds.abort();
      void providerStream
        .then(async (lateStream) => {
          await lateStream[Symbol.asyncIterator]().return?.();
        })
        .catch(() => undefined);
    } else if (iterator && !iteratorDone) {
      bounds.abort();
      try {
        void iterator.return?.().catch(() => undefined);
      } catch {
        // Iterator cleanup is best effort after the stable loop outcome is fixed.
      }
    }
  }
}

/**
 * Throws a stable loop abort error when the caller signal is already aborted.
 *
 * @param signal Optional caller abort signal.
 * @throws InternalAgentLoopAbortError when the signal is already aborted.
 */
function assertLoopNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new InternalAgentLoopAbortError();
  }
}

/**
 * Validates normalized assistant content through the agent output schema.
 *
 * @param definition Internal agent definition that owns the output schema.
 * @param content Normalized assistant text content.
 * @throws InternalAgentLoopOutputValidationError when validation fails.
 */
function validateLoopOutput(definition: InternalAgentDefinition, content: string): void {
  const candidates = createLoopOutputCandidates(content);
  let firstError: z.ZodError | null = null;

  for (const candidate of candidates) {
    const parsed = definition.outputSchema.safeParse(candidate);

    if (parsed.success) {
      return;
    }

    firstError ??= parsed.error;
  }

  throw new InternalAgentLoopOutputValidationError(z.prettifyError(firstError as z.ZodError));
}

/**
 * Creates schema-validation candidates from provider text.
 *
 * @param content Assistant text content.
 * @returns Candidate outputs, preferring structured JSON before prose content.
 */
function createLoopOutputCandidates(content: string): unknown[] {
  const candidates: unknown[] = [];
  const parsedJson = parseLoopJsonObject(content);

  if (parsedJson !== null) {
    candidates.push(parsedJson);
  }

  candidates.push({ content });
  return candidates;
}

/**
 * Parses one JSON object from assistant text when available.
 *
 * @param content Assistant text content.
 * @returns Parsed JSON value, or null when the content is not JSON.
 */
function parseLoopJsonObject(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Normalizes thrown loop failures into terminal event fields.
 *
 * @param error Unknown provider, validation, timeout, or abort error.
 * @returns Redacted terminal failure fields.
 */
function normalizeLoopFailure(error: unknown): InternalAgentLoopTerminalFailure {
  const message = redactInternalAgentText(error instanceof Error ? error.message : String(error));

  if (error instanceof InternalAgentLoopAbortError || isAbortLikeError(error)) {
    return {
      status: 'aborted',
      stopReason: 'aborted',
      errorMessage: message,
    };
  }

  if (error instanceof InternalAgentLoopTimeoutError) {
    return {
      status: 'error',
      stopReason: 'budget_exhausted',
      errorMessage: message,
    };
  }

  return {
    status: 'error',
    stopReason: 'error',
    errorMessage: message,
  };
}

/**
 * Detects platform abort errors without requiring a specific runtime class.
 *
 * @param error Unknown error value.
 * @returns True when the error follows the DOM AbortError shape.
 */
function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Extracts assistant text from a non-streaming chat completion.
 *
 * @param completion Provider completion response.
 * @returns Normalized assistant output for message events.
 */
function normalizeChatCompletion(
  completion: OpenAICompatibleChatCompletionResponse
): InternalAgentLoopNormalizedOutput {
  return {
    content: completion.choices[0]?.message.content ?? '',
  };
}
