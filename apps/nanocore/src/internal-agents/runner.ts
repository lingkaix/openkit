import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type {
  LLMProviderConfigStore,
  LLMProviderDefaultSelection,
  ResolvedLLMProviderConfig,
} from '../llm/provider-config.js';
import {
  createInternalAgentHookDispatcher,
  type InternalAgentHook,
  type InternalAgentHookDispatcher,
  type InternalAgentHookFailureDiagnostic,
} from './hooks.js';
import { type InternalAgentLoopStreamDelta, internalAgentLoop } from './loop.js';
import { redactInternalAgentDiagnosticValue, redactInternalAgentText } from './redaction.js';
import { createDefaultInternalAgentRegistry, type InternalAgentRegistry } from './registry.js';
import type {
  InternalAgentAgentEndEvent,
  InternalAgentDefaultProviderUse,
  InternalAgentDefinition,
  InternalAgentDefinitionDiagnostic,
  InternalAgentDiagnosticsSnapshot,
  InternalAgentFailureDiagnostic,
  InternalAgentLLMClient,
  InternalAgentProviderDiagnostic,
  InternalAgentRunInput,
  InternalAgentRunResult,
  InternalAgentStopReason,
  InternalAgentStreamEvent,
} from './types.js';

const MAX_FAILURES = 10;
const MAX_HOOK_FAILURES = 20;

type InternalAgentProviderCompletion = Awaited<
  ReturnType<InternalAgentLLMClient['createChatCompletion']>
>;

/**
 * Provider resolver used by the internal agent runner.
 */
export type InternalAgentProviderResolver = (providerId: string) => ResolvedLLMProviderConfig;

/**
 * Default provider/model resolver used by the internal agent runner.
 */
export type InternalAgentDefaultSelectionResolver = (
  defaultUse: InternalAgentDefaultProviderUse
) => LLMProviderDefaultSelection;

/**
 * Construction options for the internal agent runner.
 */
export interface InternalAgentRunnerOptions {
  /** LLM client or dispatcher used by internal agents. */
  readonly llmClient: InternalAgentLLMClient;
  /** Provider config store used for provider resolution. */
  readonly providerConfigStore: LLMProviderConfigStore;
  /** Optional registry override for tests or future composition. */
  readonly registry?: InternalAgentRegistry;
  /** Optional provider resolver for runtime-config-backed app callers. */
  readonly providerResolver?: InternalAgentProviderResolver;
  /** Optional default resolver for runtime-config-backed app callers. */
  readonly defaultSelectionResolver?: InternalAgentDefaultSelectionResolver;
  /** Optional app-local hooks that observe internal-agent loop events. */
  readonly hooks?: readonly InternalAgentHook[];
  /** Optional clock for deterministic diagnostics tests. */
  readonly now?: () => Date;
}

/**
 * Configuration error raised before an internal agent can call a provider.
 */
export class InternalAgentConfigurationError extends Error {
  /** Stable app-local error code. */
  public readonly code: string;

  /**
   * Creates one internal agent configuration error.
   *
   * @param code Stable app-local error code.
   * @param message Human-readable error message.
   */
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'InternalAgentConfigurationError';
    this.code = code;
  }
}

/**
 * Output validation error raised when provider text does not match an agent schema.
 */
export class InternalAgentOutputValidationError extends Error {
  /** Stable app-local error code. */
  public readonly code = 'internal_agent_output_invalid';

  /**
   * Creates one internal agent output validation error.
   *
   * @param message Human-readable validation message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'InternalAgentOutputValidationError';
  }
}

/**
 * Timeout error raised when an internal agent provider call exceeds its limit.
 */
export class InternalAgentTimeoutError extends Error {
  /** Stable app-local error code. */
  public readonly code = 'internal_agent_timeout';

  /**
   * Creates one internal agent timeout error.
   *
   * @param displayName Human-readable agent name.
   * @param timeoutMs Timeout budget in milliseconds.
   */
  public constructor(displayName: string, timeoutMs: number) {
    super(`${displayName} timed out after ${timeoutMs}ms.`);
    this.name = 'InternalAgentTimeoutError';
  }
}

/**
 * Common runner for bounded NanoCore internal agent provider calls.
 */
export class InternalAgentRunner {
  private readonly defaultSelectionResolver: InternalAgentDefaultSelectionResolver | undefined;
  private readonly failures: InternalAgentFailureDiagnostic[] = [];
  private readonly hookDispatcher: InternalAgentHookDispatcher | null;
  private readonly hookFailures: InternalAgentHookFailureDiagnostic[] = [];
  private readonly llmClient: InternalAgentLLMClient;
  private readonly now: () => Date;
  private readonly providerConfigStore: LLMProviderConfigStore;
  private readonly providerResolver: InternalAgentProviderResolver | undefined;
  private readonly registry: InternalAgentRegistry;

  /**
   * Creates one internal agent runner.
   *
   * @param options Runner dependencies and deterministic test hooks.
   */
  public constructor(options: InternalAgentRunnerOptions) {
    this.defaultSelectionResolver = options.defaultSelectionResolver;
    this.hookDispatcher =
      options.hooks && options.hooks.length > 0
        ? createInternalAgentHookDispatcher(options.hooks)
        : null;
    this.llmClient = options.llmClient;
    this.now = options.now ?? (() => new Date());
    this.providerConfigStore = options.providerConfigStore;
    this.providerResolver = options.providerResolver;
    this.registry = options.registry ?? createDefaultInternalAgentRegistry();
  }

  /**
   * Runs one internal agent invocation through the configured provider dispatcher.
   *
   * @param input Internal agent invocation input.
   * @returns Schema-validated internal agent result.
   * @throws InternalAgentConfigurationError when provider or model selection is incomplete.
   * @throws InternalAgentOutputValidationError when normalized output fails validation.
   */
  public async run<TOutput = unknown>(
    input: InternalAgentRunInput
  ): Promise<InternalAgentRunResult<TOutput>> {
    const definition = this.registry.require(input.agentId);
    const selection = this.resolveSelection(definition, input);

    if (!selection.providerId) {
      throw new InternalAgentConfigurationError(
        'internal_agent_provider_not_configured',
        `${definition.displayName} requires a configured provider.`
      );
    }
    if (!selection.model) {
      throw new InternalAgentConfigurationError(
        'internal_agent_provider_not_configured',
        `${definition.displayName} requires a configured model.`
      );
    }

    this.enforceLimits(definition, input);

    const startedAt = Date.now();
    const provider = this.resolveProvider(selection.providerId);
    let assistantContent = '';
    let loopFailureRecorded = false;
    let terminalEvent: InternalAgentAgentEndEvent | null = null;
    let completion: Awaited<ReturnType<InternalAgentLLMClient['createChatCompletion']>> | null =
      null;

    try {
      for await (const event of internalAgentLoop(
        {
          definition,
          input,
          model: selection.model,
          providerId: provider.id,
        },
        {
          callProvider: async ({ context, request }) => {
            completion = await this.llmClient.createChatCompletion(provider, request, context);
            return completion;
          },
          createMessageId: createInternalAgentEventId,
          createRunId: createInternalAgentEventId,
          createTurnId: createInternalAgentEventId,
          now: this.now,
        }
      )) {
        await this.dispatchLoopEvent(event);

        if (event.eventType === 'message_update') {
          assistantContent += event.delta;
        }
        if (event.eventType === 'agent_end') {
          terminalEvent = event;
        }
      }

      if (!terminalEvent) {
        throw new Error('Internal agent loop ended without a terminal event.');
      }
      if (terminalEvent.status !== 'completed') {
        this.recordLoopFailure(
          definition,
          input,
          provider,
          selection.model,
          terminalEvent,
          completion
        );
        loopFailureRecorded = true;
        throw createRunnerErrorFromLoopTerminal(definition, terminalEvent, completion);
      }
      const completedResponse = completion as InternalAgentProviderCompletion | null;

      if (!completedResponse) {
        throw new Error('Internal agent loop completed without a provider response.');
      }

      const output = parseOutput<TOutput>(definition, assistantContent);

      return {
        id: completedResponse.id,
        agentId: definition.id,
        status: 'completed',
        providerId: provider.id,
        model: selection.model,
        output,
        durationMs: terminalEvent.durationMs ?? Date.now() - startedAt,
        ...(completedResponse.usage === undefined ? {} : { usage: completedResponse.usage }),
      };
    } catch (error) {
      if (!loopFailureRecorded) {
        this.recordFailure(definition, input, provider, selection.model, error);
      }
      throw error;
    }
  }

  /**
   * Streams one internal agent invocation as app-local loop events.
   *
   * @param input Internal agent invocation input.
   * @yields Internal agent stream events from the evented loop.
   * @throws InternalAgentConfigurationError when provider or model selection is incomplete.
   */
  public async *stream(
    input: InternalAgentRunInput
  ): AsyncGenerator<InternalAgentStreamEvent, void, void> {
    const definition = this.registry.require(input.agentId);
    const selection = this.resolveSelection(definition, input);

    if (!selection.providerId) {
      throw new InternalAgentConfigurationError(
        'internal_agent_provider_not_configured',
        `${definition.displayName} requires a configured provider.`
      );
    }
    if (!selection.model) {
      throw new InternalAgentConfigurationError(
        'internal_agent_provider_not_configured',
        `${definition.displayName} requires a configured model.`
      );
    }

    this.enforceLimits(definition, input);

    const provider = this.resolveProvider(selection.providerId);
    const createChatCompletionStream = this.llmClient.createChatCompletionStream?.bind(
      this.llmClient
    );

    for await (const event of internalAgentLoop(
      {
        definition,
        input,
        model: selection.model,
        providerId: provider.id,
        stream: Boolean(createChatCompletionStream),
      },
      {
        callProvider: ({ context, request }) =>
          this.llmClient.createChatCompletion(provider, request, context),
        ...(createChatCompletionStream
          ? {
              callProviderStream: async ({ context, request }) =>
                readOpenAIChatCompletionStreamDeltas(
                  await createChatCompletionStream(provider, request, context)
                ),
            }
          : {}),
        createMessageId: createInternalAgentEventId,
        createRunId: createInternalAgentEventId,
        createTurnId: createInternalAgentEventId,
        now: this.now,
      }
    )) {
      await this.dispatchLoopEvent(event);
      yield event;
    }
  }

  /**
   * Returns a redacted diagnostics snapshot for internal agents.
   *
   * @returns Internal agent diagnostics without prompts or secret material.
   */
  public getDiagnostics(): InternalAgentDiagnosticsSnapshot {
    return {
      agents: this.registry.list().map((definition) => this.createDefinitionDiagnostic(definition)),
      recentFailures: [...this.failures],
      recentHookFailures: [...this.hookFailures],
    };
  }

  /**
   * Clears process-local recent failure diagnostics.
   */
  public clearDiagnostics(): void {
    this.failures.length = 0;
    this.hookFailures.length = 0;
  }

  private resolveSelection(
    definition: InternalAgentDefinition,
    input: InternalAgentRunInput
  ): LLMProviderDefaultSelection {
    const defaults = this.defaultSelectionResolver?.(definition.defaultProviderUse) ?? {
      ...this.providerConfigStore.getDefaults()[definition.defaultProviderUse],
    };
    const { providerId: defaultProviderId, model: defaultModel } = defaults;

    return {
      providerId: input.providerId ?? defaultProviderId,
      model: input.model ?? defaultModel,
    };
  }

  private resolveProvider(providerId: string): ResolvedLLMProviderConfig {
    return (
      this.providerResolver?.(providerId) ?? this.providerConfigStore.resolveProvider(providerId)
    );
  }

  private enforceLimits(definition: InternalAgentDefinition, input: InternalAgentRunInput): void {
    if (input.messages.length > definition.limits.maxInputMessages) {
      throw new InternalAgentConfigurationError(
        'internal_agent_input_limit_exceeded',
        `${definition.displayName} received too many messages.`
      );
    }
  }

  private createDefinitionDiagnostic(
    definition: InternalAgentDefinition
  ): InternalAgentDefinitionDiagnostic {
    return {
      id: definition.id,
      displayName: definition.displayName,
      supportedModes: [...definition.supportedModes],
      defaultProviderUse: definition.defaultProviderUse,
      allowedTools: [...definition.allowedTools],
      provider: this.createProviderDiagnostic(definition),
    };
  }

  private createProviderDiagnostic(
    definition: InternalAgentDefinition
  ): InternalAgentProviderDiagnostic {
    const selection =
      this.defaultSelectionResolver?.(definition.defaultProviderUse) ??
      this.providerConfigStore.getDefaults()[definition.defaultProviderUse];

    if (!selection.providerId) {
      return { configured: false, reason: 'provider-missing' };
    }
    if (!selection.model) {
      return {
        configured: false,
        providerId: selection.providerId,
        reason: 'model-missing',
      };
    }

    return {
      configured: true,
      providerId: selection.providerId,
      model: selection.model,
    };
  }

  /**
   * Dispatches one loop event to registered hooks and retains isolated hook diagnostics.
   *
   * @param event Internal-agent loop event to dispatch.
   */
  private async dispatchLoopEvent(event: InternalAgentStreamEvent): Promise<void> {
    if (!this.hookDispatcher) {
      return;
    }

    const diagnostics = await this.hookDispatcher.dispatch(event);

    for (const diagnostic of diagnostics) {
      this.hookFailures.unshift(diagnostic);
    }
    if (this.hookFailures.length > MAX_HOOK_FAILURES) {
      this.hookFailures.length = MAX_HOOK_FAILURES;
    }
  }

  private recordFailure(
    definition: InternalAgentDefinition,
    input: InternalAgentRunInput,
    provider: ResolvedLLMProviderConfig,
    model: string,
    error: unknown
  ): void {
    const rawDetails = {
      metadata: input.metadata,
      model,
      prompt: input.messages,
      provider,
    };
    const diagnostic: InternalAgentFailureDiagnostic = {
      code:
        error instanceof InternalAgentOutputValidationError ||
        error instanceof InternalAgentTimeoutError
          ? error.code
          : 'internal_agent_failed',
      status: 'error',
      stopReason: inferStopReasonFromRunnerError(error),
      agentId: definition.id,
      message: redactInternalAgentText(error instanceof Error ? error.message : String(error)),
      occurredAt: this.now().toISOString(),
      details: redactInternalAgentDiagnosticValue(rawDetails),
    };

    this.failures.unshift(diagnostic);
    if (this.failures.length > MAX_FAILURES) {
      this.failures.length = MAX_FAILURES;
    }
  }

  private recordLoopFailure(
    definition: InternalAgentDefinition,
    input: InternalAgentRunInput,
    provider: ResolvedLLMProviderConfig,
    model: string,
    terminalEvent: InternalAgentAgentEndEvent,
    completion: Awaited<ReturnType<InternalAgentLLMClient['createChatCompletion']>> | null
  ): void {
    const rawDetails = {
      metadata: input.metadata,
      model,
      prompt: input.messages,
      provider,
      terminalEvent,
    };
    const diagnostic: InternalAgentFailureDiagnostic = {
      code: createDiagnosticCodeFromLoopTerminal(terminalEvent, completion),
      status: terminalEvent.status,
      stopReason: terminalEvent.stopReason,
      agentId: definition.id,
      message: terminalEvent.errorMessage ?? 'Internal agent failed.',
      occurredAt: this.now().toISOString(),
      details: redactInternalAgentDiagnosticValue(rawDetails),
    };

    this.failures.unshift(diagnostic);
    if (this.failures.length > MAX_FAILURES) {
      this.failures.length = MAX_FAILURES;
    }
  }
}

/**
 * Creates a stable app-local id for internal agent loop events.
 *
 * @returns Internal agent event id.
 */
function createInternalAgentEventId(): string {
  return randomUUID();
}

/**
 * Creates the public runner error that preserves the pre-loop aggregate API behavior.
 *
 * @param definition Internal agent definition that owns timeout display text.
 * @param terminalEvent Terminal loop event consumed by the runner.
 * @param completion Provider completion captured by the loop effect when available.
 * @returns Error compatible with existing runner callers.
 */
function createRunnerErrorFromLoopTerminal(
  definition: InternalAgentDefinition,
  terminalEvent: InternalAgentAgentEndEvent,
  completion: Awaited<ReturnType<InternalAgentLLMClient['createChatCompletion']>> | null
): Error {
  if (terminalEvent.stopReason === 'budget_exhausted') {
    return new InternalAgentTimeoutError(definition.displayName, definition.limits.timeoutMs);
  }
  if (terminalEvent.stopReason === 'error' && completion) {
    return new InternalAgentOutputValidationError(
      terminalEvent.errorMessage ?? 'Internal agent output failed validation.'
    );
  }

  const error = new Error(terminalEvent.errorMessage ?? 'Internal agent failed.');

  if (terminalEvent.stopReason === 'aborted') {
    error.name = 'InternalAgentAbortedError';
  }

  return error;
}

/**
 * Creates the diagnostic code attached to one loop terminal failure.
 *
 * @param terminalEvent Terminal loop event consumed by the runner.
 * @returns Stable app-local diagnostic code.
 */
function createDiagnosticCodeFromLoopTerminal(
  terminalEvent: InternalAgentAgentEndEvent,
  completion: Awaited<ReturnType<InternalAgentLLMClient['createChatCompletion']>> | null
): string {
  if (terminalEvent.stopReason === 'budget_exhausted') {
    return 'internal_agent_timeout';
  }
  if (terminalEvent.stopReason === 'error' && completion) {
    return 'internal_agent_output_invalid';
  }

  return 'internal_agent_failed';
}

/**
 * Infers a stable stop reason for non-loop runner failures.
 *
 * @param error Unknown runner error.
 * @returns Stable stop reason for diagnostics.
 */
function inferStopReasonFromRunnerError(error: unknown): InternalAgentStopReason {
  if (error instanceof InternalAgentTimeoutError) {
    return 'budget_exhausted';
  }

  return 'error';
}

/**
 * Validates normalized provider output through the agent schema.
 *
 * @param definition Internal agent definition.
 * @param content Assistant text content.
 * @returns Schema-validated agent output.
 * @throws InternalAgentOutputValidationError when validation fails.
 */
function parseOutput<TOutput>(definition: InternalAgentDefinition, content: string): TOutput {
  const candidates = createOutputCandidates(content);
  let firstError: z.ZodError | null = null;

  for (const candidate of candidates) {
    const parsed = definition.outputSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data as TOutput;
    }

    firstError ??= parsed.error;
  }

  throw new InternalAgentOutputValidationError(z.prettifyError(firstError as z.ZodError));
}

/**
 * Creates schema-validation candidates from provider text.
 *
 * @param content Assistant text content.
 * @returns Candidate outputs, preferring structured JSON before prose content.
 */
function createOutputCandidates(content: string): unknown[] {
  const candidates: unknown[] = [];
  const parsedJson = parseJsonObject(content);

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
function parseJsonObject(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Converts an OpenAI-compatible chat-completion SSE body into normalized text deltas.
 *
 * @param stream Upstream SSE stream body.
 * @yields Internal-agent loop text deltas.
 */
async function* readOpenAIChatCompletionStreamDeltas(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<InternalAgentLoopStreamDelta, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        yield* readOpenAIChatCompletionSseEventDeltas(event);
      }
    }

    if (buffer.trim()) {
      yield* readOpenAIChatCompletionSseEventDeltas(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Extracts text deltas from one OpenAI-compatible SSE event block.
 *
 * @param event Raw SSE event block.
 * @yields Internal-agent loop text deltas.
 */
function* readOpenAIChatCompletionSseEventDeltas(
  event: string
): Generator<InternalAgentLoopStreamDelta, void, void> {
  const payload = openAISseDataPayload(event);

  if (!payload || payload === '[DONE]') {
    return;
  }

  const chunk = JSON.parse(payload) as Record<string, unknown>;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];

  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) {
      continue;
    }

    const delta = (choice as Record<string, unknown>).delta;
    if (typeof delta !== 'object' || delta === null) {
      continue;
    }

    const content = (delta as Record<string, unknown>).content;
    if (typeof content === 'string' && content.length > 0) {
      yield { delta: content };
    }
  }
}

/**
 * Reads the joined data payload from one SSE event block.
 *
 * @param event Raw SSE event block.
 * @returns Joined data payload, or null when the event has no data lines.
 */
function openAISseDataPayload(event: string): string | null {
  const lines = event
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());

  return lines.length > 0 ? lines.join('\n') : null;
}
