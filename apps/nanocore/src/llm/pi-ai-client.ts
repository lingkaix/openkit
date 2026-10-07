import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  calculateCost,
  createModels,
  createProvider,
  type JsonObject,
  lazyStream,
  type Model,
  type Models,
  ModelsError,
  type MutableModels,
  modelsAreEqual,
  normalizeContext,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
  type StreamOptions,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai';
import type { ProviderProfile } from '@openkit/config-schema';
import { ReasoningEffortSchema } from '@openkit/protocol';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { mergeAdapterCostRates, resolveEffectiveModelMetadata } from './logical-models.js';
import { admittedModelEvent, type ModelSemanticEvent } from './model-semantic-content.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleChatMessage,
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { attachPiAiFailure, type PiAiFailure } from './pi-ai-failure.js';
import type { LLMGatewayTransportContext } from './provider-dispatcher.js';
import {
  type SubscriptionInferenceAuth,
  subscriptionInferenceHandle,
} from './provider-subscription-accounts.js';
import {
  gatewayReasoningAttribution,
  type ReasoningAttribution,
  type ReasoningMember,
} from './reasoning-attribution.js';
import {
  isWorkerAdditionalToolsItem,
  isWorkerInferenceToolList,
  WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
} from './worker-inference-tool-policy.js';

/**
 * Error thrown when a Gateway admission cannot preserve requested semantics.
 */
export class GatewayUnsupportedFeatureError extends Error {
  /** OpenAI-compatible error code returned by gateway routes. */
  public readonly code = 'unsupported_gateway_feature';
  /** HTTP status for unsupported gateway features. */
  public readonly status = 400;
  /** Feature name that cannot be represented. */
  public readonly feature: string;

  /**
   * Creates one unsupported-feature error.
   *
   * @param feature Feature name or short admission context.
   */
  public constructor(feature: string) {
    super(`Gateway does not support this feature: ${feature}`);
    this.name = 'GatewayUnsupportedFeatureError';
    this.feature = feature;
  }
}

/** Validates admitted Chat fields before capture, credentials or stock mapping. */
export function assertChatRequestAdmission(
  request: OpenAICompatibleChatCompletionRequest,
  allowStream: boolean
): void {
  const fields = new Set([
    'model',
    'messages',
    'stream',
    'metadata',
    'parallel_tool_calls',
    'prompt_cache_key',
    'prompt_cache_retention',
    'temperature',
    'tool_choice',
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
    'reasoning_effort',
    'tools',
    'store',
    'stream_options',
  ]);
  for (const [field, value] of Object.entries(request))
    if (value !== undefined && !fields.has(field))
      throw new GatewayUnsupportedFeatureError(`pi-ai chat ${field}`);
  if (request.stream === true && !allowStream)
    throw new GatewayUnsupportedFeatureError('pi-ai chat completions stream');
  if (request.store !== undefined && request.store !== false)
    throw new GatewayUnsupportedFeatureError('pi-ai Chat store');
  if (request.prompt_cache_key !== undefined && typeof request.prompt_cache_key !== 'string')
    throw new GatewayUnsupportedFeatureError('pi-ai prompt_cache_key');
  if (request.metadata !== undefined && !readRecord(request.metadata))
    throw new GatewayUnsupportedFeatureError('pi-ai metadata');
  if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== 'boolean')
    throw new GatewayUnsupportedFeatureError('pi-ai parallel_tool_calls');
  if (request.stream_options !== undefined) {
    const options = readRecord(request.stream_options);
    if (
      !options ||
      Object.keys(options).some((key) => key !== 'include_usage') ||
      typeof options.include_usage !== 'boolean'
    )
      throw new GatewayUnsupportedFeatureError('pi-ai Chat stream_options');
  }
  if (
    request.tools !== undefined &&
    (!isWorkerInferenceToolList(request.tools) ||
      request.tools.some((tool) => tool.type !== 'function'))
  )
    throw new GatewayUnsupportedFeatureError('pi-ai chat tools');
  for (const message of request.messages) {
    const record = message as unknown as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) =>
          !['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content'].includes(key)
      ) ||
      (message.role !== 'assistant' &&
        (record.tool_calls !== undefined || record.reasoning_content !== undefined)) ||
      (message.role !== 'tool' && message.tool_call_id !== undefined)
    )
      throw new GatewayUnsupportedFeatureError('pi-ai Chat message fields');
  }
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const PI_AI_PROVIDER_ALIASES: Record<string, readonly string[]> = {
  moonshot: ['moonshotai'],
  zhipu: ['zai'],
};

/**
 * Races provider work against one AbortSignal while preserving the signal's exact reason.
 *
 * @param operation Lazy provider operation started after the abort listener is installed.
 * @param signal Optional caller or combined provider signal.
 * @param observedFailure Failure already observed before terminal callbacks, which wins a later abort.
 * @returns Provider result when it settles before cancellation.
 */
async function raceProviderWithSignal<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  observedFailure?: () => Error | undefined
): Promise<T> {
  if (!signal) {
    return operation().catch((error) => {
      throw attachPiAiFailure(error);
    });
  }

  if (signal.aborted) throw attachPiAiFailure(signal.reason, { stopReason: 'aborted' });
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      const failure = observedFailure?.();
      if (failure) {
        reject(failure);
        return;
      }
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
    }
  });

  try {
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    throw attachPiAiFailure(
      error,
      signal.aborted && error === signal.reason ? { stopReason: 'aborted' } : error
    );
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

/** Publishes only admitted fields; private reasoning events never reach retention. */
function observeModelEvent(
  event: AssistantMessageEvent,
  observer?: (event: ModelSemanticEvent) => void
): void {
  if (!observer) return;
  const admitted = admittedModelEvent(event);
  if (admitted) observer(admitted);
}

/** Captures a terminal Provider failure without assigning error semantics to normal protocol finishes. */
function terminalPiAiFailure(message: AssistantMessage): Error | undefined {
  if (message.stopReason !== 'error' && message.stopReason !== 'aborted') return undefined;
  return attachPiAiFailure(
    new Error(message.errorMessage ?? 'pi-ai provider failed'),
    message
  ) as Error;
}

/**
 * Resolves subscription auth once inside the stock setup-error boundary and consumes its classified outcome.
 * Optional material attribution never changes the already-resolved request inputs.
 * @param models Selected runtime, which may be an ordinary non-subscription runtime.
 * @param model Selected request-local model.
 * @param options Existing provider options.
 * @param signal Owning request cancellation.
 * @param absoluteDeadline Original absolute Gateway deadline, shared across attempts and proofs.
 * @param onProviderHandoff Optional private observer at stock entry after OpenKit admission/options.
 * @returns Stock model stream creation and an advisory terminal observer.
 */
function prepareSubscriptionInference(
  models: Models,
  model: Model<string>,
  options: StreamOptions & Record<string, unknown>,
  signal?: AbortSignal,
  absoluteDeadline?: number,
  onProviderHandoff?: () => void
) {
  const handle = subscriptionInferenceHandle(models);
  let presented: SubscriptionInferenceAuth | undefined;
  return {
    /** Uses stock lazy setup and transcript normalization, passing resolved auth directly to the selected Provider. */
    stream(context: Context, streamOptions = options) {
      const simple = usesSimpleEffort(model, streamOptions);
      const { model: entryModel, options: entryOptions } = stockEffortRequest(model, streamOptions);
      if (!handle) {
        onProviderHandoff?.();
        return simple
          ? models.streamSimple(entryModel, context, entryOptions)
          : models.stream(entryModel, context, entryOptions);
      }
      const transcript = normalizeContext(context);
      onProviderHandoff?.();
      return lazyStream(entryModel, async () => {
        const resolved = await handle.resolveInferenceAuth(streamOptions.signal);
        if (!resolved)
          throw new ModelsError('auth', `Provider is not configured: ${model.provider}`);
        presented = resolved.presented;
        const auth = resolved.auth;
        // Preserve stock per-field precedence and case-insensitive header replacement.
        let headers: ProviderHeaders | undefined;
        for (const source of [auth.headers, model.headers, streamOptions.headers]) {
          if (!source) continue;
          headers ??= {};
          for (const [name, value] of Object.entries(source)) {
            for (const existing of Object.keys(headers))
              if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
            headers[name] = value;
          }
        }
        const { transformHeaders, ...providerOptions } = entryOptions;
        if (typeof transformHeaders === 'function') headers = await transformHeaders(headers ?? {});
        const provider = models.getProvider(model.provider);
        if (!provider) throw new ModelsError('provider', `Unknown provider: ${model.provider}`);
        const apiKey = streamOptions.apiKey ?? auth.apiKey;
        const requestOptions = {
          ...providerOptions,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(headers === undefined ? {} : { headers }),
          ...(resolved.env || streamOptions.env
            ? { env: { ...resolved.env, ...streamOptions.env } }
            : {}),
        };
        return provider[simple ? 'streamSimple' : 'stream'](
          auth.baseUrl ? { ...entryModel, baseUrl: auth.baseUrl } : entryModel,
          transcript,
          requestOptions
        );
      });
    },
    /** Consumes the existing adapter classification at the account owner without changing routing policy. */
    async observe(failure?: Error): Promise<void> {
      if (handle && presented)
        await handle.observeInference(
          presented,
          (failure as (Error & { failure?: PiAiFailure }) | undefined)?.failure,
          absoluteDeadline,
          signal
        );
    },
    /** Retains original thrown evidence and observes it without changing error identity. */
    iterator(iterator: AsyncIterator<AssistantMessageEvent>): AsyncIterator<AssistantMessageEvent> {
      return {
        async next() {
          try {
            return await iterator.next();
          } catch (error) {
            const failure = attachPiAiFailure(error) as Error;
            if (handle && presented)
              await handle.observeInference(
                presented,
                (failure as Error & { failure?: PiAiFailure }).failure,
                absoluteDeadline,
                signal
              );
            throw failure;
          }
        },
        ...(iterator.return ? { return: iterator.return.bind(iterator) } : {}),
      };
    },
  };
}

/**
 * Uses canonical-level mapping only when the selected API lacks a proven native effort serializer.
 * Native OpenAI entries preserve caller caps without the simple entry's context reserve or cap default.
 * @param model Selected stock model whose API owns option serialization.
 * @param options Constructed options; omitted effort keeps the existing native entry.
 * @returns Whether this attempt needs stock simple mapping to deliver effort.
 */
function usesSimpleEffort(
  model: Model<string>,
  options: StreamOptions & Record<string, unknown>
): boolean {
  return (
    options.reasoningEffort !== undefined &&
    !['openai-completions', 'openai-responses', 'openai-codex-responses'].includes(model.api)
  );
}

/**
 * Constructs the attempt's stock model/options before handoff using stock's disabled representation.
 * Native Completions omits disabled effort and lets stock read `thinkingLevelMap.off`; only an undefined
 * mapping gains the canonical wire default on an attempt-local copy. String/null mappings remain stock-owned.
 * Canonical attempt facts remain `none`; registered models and shared catalogs are never mutated.
 * @param model Selected stock model whose API owns option serialization.
 * @param options Existing options, preserved unchanged when no conversion is needed.
 * @returns Attempt model/options with native off mapping or existing simple canonical reasoning.
 */
function stockEffortRequest(
  model: Model<string>,
  options: StreamOptions & Record<string, unknown>
): { model: Model<string>; options: StreamOptions & Record<string, unknown> } {
  const { reasoningEffort, ...rest } = options;
  if (usesSimpleEffort(model, options)) {
    return {
      model,
      options: { ...rest, reasoning: reasoningEffort === 'none' ? undefined : reasoningEffort },
    };
  }
  if (model.api === 'openai-completions' && reasoningEffort === 'none') {
    return {
      model:
        model.thinkingLevelMap?.off === undefined
          ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: 'none' } }
          : model,
      options: rest,
    };
  }
  return { model, options };
}

/**
 * Consumes one model stream incrementally even when the caller requested a final response.
 * Classifies terminal failure before forwarding usage or invoking terminal observers.
 */
async function completeObservedModel(
  models: Models,
  model: Model<string>,
  context: Context,
  options: StreamOptions & Record<string, unknown>,
  transport: LLMGatewayTransportContext,
  onTerminal: (message: AssistantMessage, failure: Error | undefined) => void
): Promise<AssistantMessage> {
  const inference = prepareSubscriptionInference(
    models,
    model,
    options,
    transport.signal,
    transport.deadline,
    transport.onProviderHandoff
  );
  if (!transport.onModelEvent) {
    let response: AssistantMessage;
    try {
      if (subscriptionInferenceHandle(models)) {
        response = await inference.stream(context).result();
      } else {
        const simple = usesSimpleEffort(model, options);
        const { model: entryModel, options: entryOptions } = stockEffortRequest(model, options);
        transport.onProviderHandoff?.();
        response = simple
          ? await models.completeSimple(entryModel, context, entryOptions)
          : await models.complete(entryModel, context, entryOptions);
      }
    } catch (error) {
      const failure = attachPiAiFailure(error) as Error;
      await inference.observe(failure);
      throw failure;
    }
    const failure = terminalPiAiFailure(response);
    onTerminal(response, failure);
    await inference.observe(failure);
    return response;
  }
  const localAbort = new AbortController();
  const signal = transport.signal
    ? AbortSignal.any([transport.signal, localAbort.signal])
    : localAbort.signal;
  const events = inference.stream(context, { ...options, signal });
  const iterator = inference.iterator(events[Symbol.asyncIterator]());
  try {
    while (true) {
      const result = await raceProviderWithSignal(() => iterator.next(), signal);
      if (result.done) {
        transport.onModelEvent({ type: 'truncated' });
        throw piAiStreamFailure('Provider stream failed.', 'provider_stream_truncated');
      }
      const terminalMessage =
        result.value.type === 'done'
          ? result.value.message
          : result.value.type === 'error'
            ? result.value.error
            : undefined;
      const terminalFailure = terminalMessage ? terminalPiAiFailure(terminalMessage) : undefined;
      if (terminalMessage) onTerminal(terminalMessage, terminalFailure);
      observeModelEvent(result.value, transport.onModelEvent);
      if (result.value.type === 'done') {
        await inference.observe(terminalFailure);
        return result.value.message;
      }
      if (result.value.type === 'error') {
        await inference.observe(terminalFailure);
        return result.value.error;
      }
    }
  } catch (error) {
    localAbort.abort(error);
    transport.onModelEvent({ type: transport.signal?.aborted ? 'interrupted' : 'failed' });
    throw error;
  } finally {
    await iterator.return?.();
  }
}

/**
 * Error thrown when a pi-ai-routed provider is not safely configured.
 */
export class PiAiGatewayConfigurationError extends Error {
  /** Stable internal gateway error code. */
  public readonly code = 'gateway_provider_configuration_error';
  /** HTTP status suitable for gateway error envelopes. */
  public readonly status = 400;

  /**
   * Creates one configuration error.
   *
   * @param message Product-safe diagnostic message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'PiAiGatewayConfigurationError';
  }
}

/**
 * Construction options for the pi-ai gateway client.
 */
export interface PiAiGatewayClientOptions {
  /** pi-ai model collection used for model lookup and calls. */
  readonly models?: MutableModels;
  /** Process-local attribution owner; injectable to prove restart and eviction behavior. */
  readonly reasoningAttribution?: ReasoningAttribution;
}

/**
 * Creates the default pi-ai model collection used by NanoCore provider routing.
 *
 * @returns pi-ai model collection with supported provider families registered.
 */
export function createDefaultPiAiGatewayModels(): MutableModels {
  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(deepseekProvider());
  models.setProvider(googleProvider());
  models.setProvider(groqProvider());
  models.setProvider(moonshotaiProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  models.setProvider(xaiProvider());
  models.setProvider(zaiProvider());
  return models;
}

/**
 * Internal adapter from NanoCore's gateway request shape to pi-ai.
 */
export class PiAiGatewayClient {
  private readonly adapterProviders: ReadonlyMap<string, Provider>;
  private readonly models: MutableModels;
  private readonly reasoningAttribution: ReasoningAttribution;

  /**
   * Creates one pi-ai gateway adapter.
   *
   * @param options Optional injected pi-ai model collection.
   */
  public constructor(options: PiAiGatewayClientOptions = {}) {
    this.reasoningAttribution = options.reasoningAttribution ?? gatewayReasoningAttribution;
    this.models = options.models ?? createDefaultPiAiGatewayModels();
    this.adapterProviders = new Map(
      this.models.getProviders().map((provider) => [provider.id, provider])
    );
  }

  /**
   * Creates a non-streaming OpenAI-compatible Chat Completions response through pi-ai.
   * Terminal failure is recorded before callbacks so a later caller abort cannot replace it.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Chat Completions request.
   * @param onUsage Optional observer for the provider-native terminal usage payload.
   * @param transport Optional gateway transport state; pi-ai consumes only cancellation.
   * @param models Per-call model collection, normally the exact subscription pair runtime.
   * @returns OpenAI-compatible Chat Completions response.
   */
  public async createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {},
    models: Models = this.models
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    this.assertExplicitCredential(provider);
    assertChatRequestAdmission(request, false);

    const { knownCost, model } = this.resolveModel(provider, request.model, models);
    let observedFailure: Error | undefined;
    const response = await raceProviderWithSignal(
      () =>
        completeObservedModel(
          models,
          model,
          this.toContext(request, model),
          this.toStreamOptions(provider, request, transport, model),
          transport,
          (message, failure) => {
            observedFailure = failure;
            publishObservedUsage(onUsage, message.usage, model, knownCost);
          }
        ),
      transport.signal,
      () => observedFailure
    );

    if (observedFailure) throw observedFailure;

    return this.toChatCompletionResponse(response, request.model);
  }

  /**
   * Creates a streaming OpenAI-compatible Chat Completions response through pi-ai.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Chat Completions request.
   * @param onUsage Optional observer for the provider-native terminal usage payload.
   * @param transport Optional gateway transport state; pi-ai consumes only cancellation.
   * @param models Per-call model collection, normally the exact subscription pair runtime.
   * @returns OpenAI-compatible Chat Completions SSE stream.
   */
  public async createChatCompletionStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {},
    models: Models = this.models
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertExplicitCredential(provider);
    assertChatRequestAdmission(request, true);

    const { knownCost, model } = this.resolveModel(provider, request.model, models);
    const localAbortController = new AbortController();
    const signal = transport.signal
      ? AbortSignal.any([transport.signal, localAbortController.signal])
      : localAbortController.signal;
    const inference = prepareSubscriptionInference(
      models,
      model,
      this.toStreamOptions(provider, request, { ...transport, signal }, model),
      signal,
      transport.deadline,
      transport.onProviderHandoff
    );
    const events = inference.stream(this.toContext(request, model));
    const iterator = inference.iterator(events[Symbol.asyncIterator]());

    return this.toChatCompletionSseStream(
      iterator,
      request.model,
      (usage) => publishObservedUsage(onUsage, usage, model, knownCost),
      signal,
      (reason) => {
        localAbortController.abort(reason);
      },
      transport.onModelEvent,
      (_message, failure) => inference.observe(failure)
    );
  }

  /**
   * Creates a non-streaming OpenAI-compatible Responses payload through pi-ai.
   * Native and bridged terminal failures retain their classification across callback-triggered aborts.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Responses request.
   * @param onUsage Optional observer for the provider-native terminal usage payload.
   * @param transport Optional gateway transport state; pi-ai consumes only cancellation.
   * @param models Per-call model collection, normally the exact subscription pair runtime.
   * @returns OpenAI-compatible Responses response.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {},
    models: Models = this.models
  ): Promise<OpenAICompatibleResponsesResponse> {
    assertResponsesRequestAdmission(request, false);
    const { knownCost, model } = this.resolveModel(provider, request.model, models);
    const native = isResponsesApi(model.api) && provider.gatewayCapabilities.responses === 'native';
    const { additionalTools, bridgedFunctionTools, bridgeNames, nativeInput } =
      admitPiResponsesNativeRequest(request, false, !native);
    this.assertExplicitCredential(provider);
    const member = { providerId: provider.id, modelId: model.id };
    const envelope: ResponsesNativeEnvelope = {
      ...(nativeInput
        ? {
            input: handoffResponsesInput(nativeInput, member, this.reasoningAttribution),
            tools: additionalTools?.providerTools,
          }
        : {}),
      fields: {},
      output: [],
      outputIndexes: new Map(),
    };

    let observedFailure: Error | undefined;
    const response = await raceProviderWithSignal(
      () =>
        completeObservedModel(
          models,
          model,
          toPiResponsesContext(
            request,
            model,
            additionalTools,
            member,
            this.reasoningAttribution,
            bridgedFunctionTools,
            bridgeNames,
            envelope.input,
            native
          ),
          this.toResponsesOptions(
            provider,
            request,
            model,
            transport,
            additionalTools,
            native,
            envelope
          ),
          transport,
          (message, failure) => {
            observedFailure = failure;
            publishObservedUsage(onUsage, message.usage, model, knownCost);
          }
        ),
      transport.signal,
      () => observedFailure
    );
    if (observedFailure) throw observedFailure;
    const result = toResponsesResponse(
      response,
      request.model,
      additionalTools,
      bridgeNames,
      undefined,
      envelope,
      native
    );
    const nativeReasoningIds = new Set(
      response.content.flatMap((block) =>
        block.type === 'thinking'
          ? [readNativeResponsesReasoningItem(block.thinkingSignature)?.id]
          : []
      )
    );
    for (const item of result.output ?? []) {
      if (
        native &&
        (nativeReasoningIds.has(item.id) ||
          envelope.output.some((entry) => entry.item.id === item.id))
      )
        recordReturnedReasoning(item, member, this.reasoningAttribution);
    }
    return result;
  }

  /**
   * Creates a streaming OpenAI-compatible Responses payload through pi-ai.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Responses request.
   * @param onUsage Optional observer for the provider-native terminal usage payload.
   * @param transport Optional gateway transport state; pi-ai consumes only cancellation.
   * @param models Per-call model collection, normally the exact subscription pair runtime.
   * @returns OpenAI-compatible Responses SSE stream.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {},
    models: Models = this.models
  ): Promise<ReadableStream<Uint8Array>> {
    assertResponsesRequestAdmission(request, true);
    const { knownCost, model } = this.resolveModel(provider, request.model, models);
    const native = isResponsesApi(model.api) && provider.gatewayCapabilities.responses === 'native';
    const { additionalTools, bridgedFunctionTools, bridgeNames, nativeInput } =
      admitPiResponsesNativeRequest(request, true, !native);
    this.assertExplicitCredential(provider);
    const member = { providerId: provider.id, modelId: model.id };
    const envelope: ResponsesNativeEnvelope = {
      ...(nativeInput
        ? {
            input: handoffResponsesInput(nativeInput, member, this.reasoningAttribution),
            tools: additionalTools?.providerTools,
          }
        : {}),
      fields: {},
      output: [],
      outputIndexes: new Map(),
    };

    const localAbortController = new AbortController();
    const signal = transport.signal
      ? AbortSignal.any([transport.signal, localAbortController.signal])
      : localAbortController.signal;
    const inference = prepareSubscriptionInference(
      models,
      model,
      this.toResponsesOptions(
        provider,
        request,
        model,
        { ...transport, signal },
        additionalTools,
        native,
        envelope
      ),
      signal,
      transport.deadline,
      transport.onProviderHandoff
    );
    const events = inference.stream(
      toPiResponsesContext(
        request,
        model,
        additionalTools,
        member,
        this.reasoningAttribution,
        bridgedFunctionTools,
        bridgeNames,
        envelope.input,
        native
      )
    );
    const iterator = inference.iterator(events[Symbol.asyncIterator]());
    let first: IteratorResult<AssistantMessageEvent>;
    try {
      first = await raceProviderWithSignal(() => iterator.next(), signal);
    } catch (error) {
      const interrupted = signal.aborted;
      localAbortController.abort(error);
      try {
        transport.onModelEvent?.({ type: interrupted ? 'interrupted' : 'failed' });
      } finally {
        await iterator.return?.();
      }
      throw error;
    }

    return toResponsesSseStream(
      iterator,
      first,
      request.model,
      additionalTools,
      Array.isArray(request.include) && request.include.includes('reasoning.encrypted_content'),
      native,
      (usage) => publishObservedUsage(onUsage, usage, model, knownCost),
      signal,
      (reason) => localAbortController.abort(reason),
      bridgeNames,
      transport.onModelEvent,
      (item) => recordReturnedReasoning(item, member, this.reasoningAttribution),
      (_message, failure) => inference.observe(failure),
      envelope
    );
  }

  /**
   * Resolves the pi-ai model selected by an OpenKit provider.
   *
   * @param provider Resolved OpenKit provider config.
   * @param modelId Requested model id.
   * @param models Per-call model collection.
   * @returns Request-local model and whether four adapter rates are known financial facts.
   */
  private resolveModel(
    provider: ResolvedLLMProviderConfig,
    modelId: string,
    models: Models
  ): ResolvedAdapterModel {
    if (models !== this.models) {
      const providerId = provider.subscriptionProviderId;
      const exact = providerId ? models.getModel(providerId, modelId) : undefined;
      const prefix = providerId ? `${providerId}/` : '';
      const stripped =
        !exact && prefix && modelId.startsWith(prefix)
          ? models.getModel(providerId!, modelId.slice(prefix.length))
          : undefined;
      const pairModel = exact ?? stripped;

      if (
        !pairModel &&
        (providerId === 'openai-codex' || providerId === 'xai') &&
        provider.models.includes(modelId)
      ) {
        const pairProvider = models.getProvider(providerId);
        const effective = resolveEffectiveModelMetadata(metadataProfile(provider), modelId);
        if (pairProvider?.baseUrl && effective.limit?.context) {
          // Auth and transport stay on the selected pair; the inventory is not an ID allowlist.
          const nativeId = modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
          return this.applyEffectiveModel(
            provider,
            modelId,
            {
              api: providerId === 'openai-codex' ? 'openai-codex-responses' : 'openai-completions',
              baseUrl: pairProvider.baseUrl,
              contextWindow: effective.limit.context,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              id: nativeId,
              input: ['text'],
              maxTokens: 32000,
              name: nativeId,
              provider: providerId,
              reasoning: false,
            },
            false
          );
        }
      }
      if (!pairModel) {
        throw new PiAiGatewayConfigurationError(
          `Provider ${provider.id} does not expose model ${modelId}.`
        );
      }
      return this.applyEffectiveModel(provider, modelId, pairModel);
    }

    const registered = this.registerConfiguredProviderModel(
      provider,
      modelId,
      this.lookupAdapterModel(provider, modelId)
    );

    if (!registered) {
      throw new PiAiGatewayConfigurationError(
        `Provider ${provider.id} does not expose model ${modelId}.`
      );
    }

    return registered;
  }

  /**
   * Registers a configured provider instance around catalog behavior or a conservative custom model.
   *
   * @param provider Resolved OpenKit provider config.
   * @param modelId Requested model id.
   * @param template Optional catalog model and adapter implementation to preserve.
   * @returns Registered instance model and known-cost fact, or null when the backend cannot resolve the model safely.
   */
  private registerConfiguredProviderModel(
    provider: ResolvedLLMProviderConfig,
    modelId: string,
    template: { readonly model: Model<string>; readonly provider: Provider } | null
  ): ResolvedAdapterModel | null {
    let applied: ResolvedAdapterModel;
    let api: ProviderStreams;

    if (template) {
      applied = this.applyEffectiveModel(provider, modelId, {
        ...template.model,
        baseUrl: provider.baseUrl ?? template.model.baseUrl,
        provider: provider.id,
      });
      api = template.provider;
    } else {
      if (!provider.baseUrl) {
        return null;
      }

      const apiName =
        provider.gatewayCapabilities.responses === 'native'
          ? 'openai-responses'
          : 'openai-completions';
      const effective = resolveEffectiveModelMetadata(metadataProfile(provider), modelId);
      const context = effective.limit?.context;
      if (typeof context !== 'number') {
        return null;
      }
      applied = this.applyEffectiveModel(
        provider,
        modelId,
        {
          api: apiName,
          baseUrl: provider.baseUrl,
          contextWindow: context,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          id: modelId,
          input: ['text'],
          maxTokens: 32000,
          name: modelId,
          provider: provider.id,
          reasoning: false,
        },
        false
      );
      api = apiName === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi();
    }

    this.models.setProvider(
      createProvider({
        id: provider.id,
        name: provider.displayName,
        baseUrl: applied.model.baseUrl,
        auth: {
          apiKey: {
            name: `${provider.displayName} API key`,
            resolve: async () => ({
              auth: { apiKey: provider.apiKey ?? 'openkit-keyless' },
            }),
          },
        },
        models: [applied.model],
        api,
      })
    );

    return applied;
  }

  /**
   * Finds a catalog model and its original adapter implementation.
   *
   * @param provider Resolved provider instance.
   * @param modelId Requested model id.
   * @returns Adapter model and provider, or null when the catalog has no match.
   */
  private lookupAdapterModel(
    provider: ResolvedLLMProviderConfig,
    modelId: string
  ): { readonly model: Model<string>; readonly provider: Provider } | null {
    for (const providerId of this.lookupProviderIds(provider)) {
      const adapterProvider = this.adapterProviders.get(providerId);

      if (!adapterProvider) {
        continue;
      }

      const model = adapterProvider.getModels().find((candidate) => candidate.id === modelId);

      if (model) {
        return { model, provider: adapterProvider };
      }
    }

    return null;
  }

  /**
   * Lists pi-ai provider ids that can satisfy one OpenKit provider config.
   *
   * @param provider Resolved OpenKit provider config.
   * @returns Candidate pi-ai provider ids.
   */
  private lookupProviderIds(provider: ResolvedLLMProviderConfig): string[] {
    return [
      provider.adapterId,
      ...(PI_AI_PROVIDER_ALIASES[provider.adapterId] ?? []),
      provider.id,
      ...(PI_AI_PROVIDER_ALIASES[provider.id] ?? []),
    ].filter((value, index, values) => values.indexOf(value) === index);
  }

  /**
   * Applies effective Provider metadata onto a request-local model clone. Explicitly authored cost leaves replace that rate on cloned stock tiers; catalog flats do not; omitted leaves and thresholds stay stock.
   *
   * @param provider Resolved OpenKit provider config.
   * @param modelId Requested native model id.
   * @param base Adapter or pair model to clone.
   * @param inheritStockCost When true, real stock or pair rates fill omitted authored leaves.
   * @returns Cloned model and whether four adapter rates are known financial facts.
   */
  private applyEffectiveModel(
    provider: ResolvedLLMProviderConfig,
    modelId: string,
    base: Model<string>,
    inheritStockCost = true
  ): ResolvedAdapterModel {
    const effective = resolveEffectiveModelMetadata(metadataProfile(provider), modelId);
    const context = effective.limit?.context;
    const output = effective.limit?.output;
    const merged = mergeAdapterCostRates(
      inheritStockCost ? adapterCostRates(base.cost) : undefined,
      effective
    );
    const overlayInput = effective.modalities?.input;
    const clonedCost = cloneAdapterCost(base.cost);
    const cost = {
      ...clonedCost,
      cacheRead: merged.rates.cacheRead ?? 0,
      cacheWrite: merged.rates.cacheWrite ?? 0,
      input: merged.rates.input ?? 0,
      output: merged.rates.output ?? 0,
      ...(clonedCost.tiers
        ? {
            tiers: overlayAuthoredCostLeavesOnTiers(
              clonedCost.tiers,
              provider.modelMetadata?.[modelId]?.cost
            ),
          }
        : {}),
    };
    return {
      knownCost: merged.complete,
      model: {
        ...base,
        cost,
        input: [
          ...(overlayInput !== undefined ? overlayInput : base.input),
        ] as Model<string>['input'],
        ...(typeof context === 'number' ? { contextWindow: context } : {}),
        ...(typeof output === 'number' ? { maxTokens: output } : {}),
        ...(effective.reasoning !== undefined ? { reasoning: effective.reasoning } : {}),
      },
    };
  }

  /**
   * Converts shared Chat Completions options into pi-ai stream options.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Chat Completions request.
   * @param transport Gateway cancellation and caller-held Codex transport continuity.
   * @param model Selected stock model whose API owns option shapes.
   * @returns pi-ai stream options with explicit credential isolation.
   */
  private toStreamOptions(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    transport: LLMGatewayTransportContext,
    model: Model<string>
  ): StreamOptions & Record<string, unknown> {
    const options: StreamOptions & Record<string, unknown> = { env: {} };
    const cacheRetention = this.cacheRetention(request.prompt_cache_retention);
    const maxTokens = this.maxTokens(request);
    const metadata = readRecord(request.metadata);
    const temperature = readNumber(request.temperature);

    if (provider.apiKey) {
      options.apiKey = provider.apiKey;
    }
    if (cacheRetention) {
      options.cacheRetention = cacheRetention;
    }
    if (maxTokens !== undefined) {
      options.maxTokens = maxTokens;
    }
    if (metadata && !isResponsesApi(model.api)) {
      options.metadata = metadata;
    }
    if (request.reasoning_effort !== undefined) {
      options.reasoningEffort = request.reasoning_effort;
    }
    if (typeof request.prompt_cache_key === 'string') {
      options.sessionId = request.prompt_cache_key;
    }
    if (temperature !== undefined) {
      options.temperature = temperature;
    }
    if (transport.signal) {
      options.signal = transport.signal;
    }
    const toolChoice = toPiToolChoice(request.tool_choice, model.api);
    if (toolChoice !== undefined) {
      options.toolChoice = toolChoice;
    }

    if (request.parallel_tool_calls !== undefined)
      options.samplingParams = { parallel_tool_calls: request.parallel_tool_calls };
    this.applyRequestPayloadOverlay(options, model, maxTokens, request.parallel_tool_calls);
    applyCodexTransport(options, model, transport);
    return options;
  }

  /** Shares concrete missing-control overlays across both public mappings; other stock serializer behavior remains external. */
  private applyRequestPayloadOverlay(
    options: StreamOptions & Record<string, unknown>,
    model: Model<string>,
    maxTokens: number | undefined,
    parallel: unknown,
    envelope?: ResponsesNativeEnvelope
  ): void {
    const fields: Record<string, unknown> = {
      ...envelope?.fields,
      ...(model.api === 'openai-codex-responses' && maxTokens !== undefined
        ? { max_output_tokens: maxTokens }
        : {}),
      ...(isResponsesApi(model.api) && parallel !== undefined
        ? { parallel_tool_calls: parallel }
        : {}),
    };
    const anthropicParallel = model.api === 'anthropic-messages' && parallel !== undefined;
    if (!envelope?.input && Object.keys(fields).length === 0 && !anthropicParallel) return;
    options.onPayload = (payload) => {
      const record = readRecord(payload);
      if (!record) throw new GatewayUnsupportedFeatureError('pi-ai request payload');
      const { reasoning: nativeReasoning, ...controls } = fields;
      const choice = readRecord(record.tool_choice) ?? { type: 'auto' };
      return {
        ...record,
        ...controls,
        ...(envelope?.input ? { input: envelope.input } : {}),
        ...(envelope?.tools ? { tools: envelope.tools } : {}),
        ...(nativeReasoning
          ? { reasoning: { ...readRecord(record.reasoning), ...readRecord(nativeReasoning) } }
          : {}),
        // Stock Anthropic ignores samplingParams; its explicit choice retains the caller's selection.
        ...(anthropicParallel && choice.type !== 'none'
          ? { tool_choice: { ...choice, disable_parallel_tool_use: !parallel } }
          : {}),
      };
    };
  }

  /** Maps Responses options directly and installs one attempt-local native envelope after stock assembly. */
  private toResponsesOptions(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    selectedModel: Model<string>,
    transport: LLMGatewayTransportContext,
    additionalTools: ResponsesAdditionalTools | undefined,
    native: boolean,
    envelope: ResponsesNativeEnvelope
  ): StreamOptions & Record<string, unknown> {
    const options: StreamOptions & Record<string, unknown> = { env: {} };
    const cacheRetention = this.cacheRetention(request.prompt_cache_retention);
    const reasoning = readRecord(request.reasoning);
    const text = readRecord(request.text);
    const maxTokens = request.max_output_tokens;
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0))
      throw new GatewayUnsupportedFeatureError('pi-ai max_output_tokens');
    if (
      request.parallel_tool_calls !== undefined &&
      typeof request.parallel_tool_calls !== 'boolean'
    )
      throw new GatewayUnsupportedFeatureError('pi-ai parallel_tool_calls');
    if (provider.apiKey) options.apiKey = provider.apiKey;
    if (cacheRetention) options.cacheRetention = cacheRetention;
    if (typeof request.prompt_cache_key === 'string') options.sessionId = request.prompt_cache_key;
    if (transport.signal) options.signal = transport.signal;
    if (maxTokens !== undefined) options.maxTokens = maxTokens as number;
    if (typeof request.temperature === 'number') options.temperature = request.temperature;
    if (reasoning?.effort !== undefined) options.reasoningEffort = reasoning.effort;
    if (reasoning?.summary !== undefined) options.reasoningSummary = reasoning.summary;
    if (text?.verbosity !== undefined) options.textVerbosity = text.verbosity;
    const toolChoice = toPiToolChoice(request.tool_choice, selectedModel.api);
    if (toolChoice !== undefined) options.toolChoice = toolChoice;
    // Native features have one carrier; it never changes stock auth, cache, model or transport fields.
    envelope.fields = {
      ...(native && text ? { text } : {}),
      ...(native && reasoning?.context === 'all_turns'
        ? { reasoning: { context: 'all_turns' } }
        : {}),
    };
    if (!native && request.parallel_tool_calls !== undefined)
      options.samplingParams = { parallel_tool_calls: request.parallel_tool_calls };
    this.applyRequestPayloadOverlay(
      options,
      selectedModel,
      maxTokens as number | undefined,
      request.parallel_tool_calls,
      envelope
    );
    const representedReasoning = new Set<string>();
    /** Records only native identity/position metadata that stock content blocks omit. */
    const recordNativePosition = (item: Record<string, unknown>, index: unknown) => {
      if (
        !['reasoning', 'message', 'function_call', 'custom_tool_call', 'tool_search_call'].includes(
          item.type as string
        )
      )
        throw new GatewayUnsupportedFeatureError('pi-ai Responses native output');
      if (typeof item.id !== 'string') return;
      if (!Number.isInteger(index) || (index as number) < 0)
        throw new GatewayUnsupportedFeatureError('pi-ai Responses native output index');
      const previous = envelope.outputIndexes.get(item.id);
      if (previous !== undefined && previous !== index)
        throw new GatewayUnsupportedFeatureError('pi-ai Responses native output position conflict');
      envelope.outputIndexes.set(item.id, index as number);
    };
    if (native)
      options.onProviderStreamEvent = (data) => {
        const event = readRecord(data);
        const item = readRecord(event?.item);
        if (event?.type === 'response.output_item.added' && item)
          recordNativePosition(item, event.output_index);
        if (
          event?.type === 'response.output_item.done' &&
          item?.type === 'reasoning' &&
          typeof item.id === 'string'
        ) {
          representedReasoning.add(item.id);
          return;
        }
        const response = readRecord(event?.response);
        const output =
          event?.type === 'response.output_item.done' && item?.type === 'tool_search_call'
            ? [{ item, index: event.output_index }]
            : (event?.type === 'response.completed' || event?.type === 'response.incomplete') &&
                Array.isArray(response?.output)
              ? response.output.map((item, index) => ({ item, index }))
              : [];
        for (const { item: value, index } of output) {
          if (!Number.isInteger(index) || (index as number) < 0)
            throw new GatewayUnsupportedFeatureError('pi-ai Responses native output index');
          const item = readRecord(value);
          if (!item) throw new GatewayUnsupportedFeatureError('pi-ai Responses native output');
          recordNativePosition(item, index);
          if (item.type === 'reasoning') {
            if (typeof item.id === 'string' && representedReasoning.has(item.id)) continue;
            assertExactPreservedResponsesItem(item);
          } else if (item.type === 'tool_search_call') {
            if (
              additionalTools?.hasToolSearch !== true ||
              item.execution !== 'client' ||
              typeof item.id !== 'string' ||
              typeof item.call_id !== 'string' ||
              !readRecord(item.arguments)
            )
              throw new GatewayUnsupportedFeatureError('pi-ai Responses tool search output');
          } else continue;
          const existing = envelope.output.find(
            (entry) => entry.item.id === item.id || entry.index === index
          );
          if (existing && (existing.index !== index || !isDeepStrictEqual(existing.item, item)))
            throw new GatewayUnsupportedFeatureError('pi-ai Responses native output conflict');
          if (!existing) envelope.output = [...envelope.output, { index: index as number, item }];
        }
        envelope.output = envelope.output.toSorted((left, right) => left.index - right.index);
      };
    applyCodexTransport(options, selectedModel, transport);
    return options;
  }

  /**
   * Ensures pi-ai cannot satisfy hosted provider auth from ambient environment variables.
   *
   * @param provider Resolved provider config.
   */
  private assertExplicitCredential(provider: ResolvedLLMProviderConfig): void {
    if (provider.requiresApiKey && !provider.apiKey) {
      throw new PiAiGatewayConfigurationError(
        `Provider ${provider.id} requires an explicit API key.`
      );
    }
  }

  /**
   * Converts one Chat Completions request into a pi-ai context.
   *
   * @param request Chat Completions request.
   * @param model pi-ai model identity.
   * @returns pi-ai context.
   */
  private toContext(
    request: OpenAICompatibleChatCompletionRequest,
    model: AssistantModel
  ): Context {
    const systemPrompt = request.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => readTextContent(message))
      .filter(Boolean)
      .join('\n\n');
    const pendingCalls = new Map<string, string>();
    const callIds = new Set<string>();
    const messages: Context['messages'] = [];
    for (const [index, message] of request.messages.entries()) {
      if (message.role === 'system' || message.role === 'developer') continue;
      const toolName = message.tool_call_id ? pendingCalls.get(message.tool_call_id) : undefined;
      if (message.role === 'tool' && !toolName)
        throw new GatewayUnsupportedFeatureError('pi-ai Chat tool result lineage');
      const mapped = toPiMessage(message, model, index, toolName);
      if (mapped.role === 'assistant') {
        for (const block of mapped.content) {
          if (block.type !== 'toolCall') continue;
          if (callIds.has(block.id))
            throw new GatewayUnsupportedFeatureError('pi-ai Chat duplicate tool identity');
          callIds.add(block.id);
          pendingCalls.set(block.id, block.name);
        }
      }
      if (message.role === 'tool') pendingCalls.delete(message.tool_call_id as string);
      messages.push(mapped);
    }
    const tools = toPiTools(request.tools);

    return {
      messages,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    };
  }

  /**
   * Converts a final pi-ai assistant message into the public chat completion shape.
   *
   * @param message pi-ai assistant message.
   * @param requestModel Model requested by the caller.
   * @returns OpenAI-compatible Chat Completions response.
   */
  private toChatCompletionResponse(
    message: AssistantMessage,
    requestModel: string
  ): OpenAICompatibleChatCompletionResponse {
    const usage = toChatUsage(message.usage);
    const content = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const reasoning = message.content
      .flatMap((block) => (block.type === 'thinking' && !block.redacted ? [block.thinking] : []))
      .join('');
    const toolCalls = toOpenAIChatToolCalls(message.content);

    return {
      id: `chatcmpl_${message.responseId ?? `pi_${message.timestamp}`}`,
      object: 'chat.completion',
      created: Math.floor(message.timestamp / 1000),
      model: message.responseModel ?? message.model ?? requestModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content || (toolCalls.length > 0 ? null : ''),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: mapStopReason(message.stopReason),
        },
      ],
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * Converts pi-ai stream events into OpenAI-compatible Chat Completions SSE.
   * Failure classification precedes terminal usage and semantic observers.
   * Terminal usage is drained before the read rejection, including when private commit
   * buffering introduces backpressure. Bare iterator exhaustion is uncertain failure.
   *
   * @param iterator pi-ai assistant event iterator.
   * @param requestModel Model requested by the caller.
   * @param onUsage Optional observer for the provider-native terminal usage payload.
   * @param signal Combined caller and downstream cancellation signal.
   * @param abortUpstream Cancels provider work when the downstream stream stops early.
   * @param onModelEvent Private admitted-content observer, independent of public SSE delivery.
   * @param onInferenceTerminal Advisory account observation after cancellation-capable terminal observers.
   * @returns Public Chat Completions SSE stream.
   */
  private toChatCompletionSseStream(
    iterator: AsyncIterator<AssistantMessageEvent>,
    requestModel: string,
    onUsage: ((usage: unknown) => void) | undefined,
    signal: AbortSignal,
    abortUpstream: (reason?: unknown) => void,
    onModelEvent?: (event: ModelSemanticEvent) => void,
    onInferenceTerminal?: (message: AssistantMessage, failure?: Error) => Promise<void>
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let id = `chatcmpl_pi_${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    let model = requestModel;
    let usageObserved = false;
    let cancelled = false;
    let terminal = false;
    let terminalFailure: unknown;
    const toolIndexes = new Map<
      number,
      { readonly index: number; readonly id: string; readonly name: string }
    >();
    const thinkingSent = new Map<number, { text: string; published: number }>();
    const textSent = new Map<number, string>();
    const toolArguments = new Map<number, string>();
    const toolIds = new Set<string>();
    /** Publishes observed suffixes before later content, retaining the same-index completion hold. */
    const drainThinking = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      exceptIndex?: number
    ) => {
      let drained = false;
      for (const [index, sent] of thinkingSent) {
        if (index === exceptIndex) continue;
        const remaining = sent.text.slice(sent.published);
        if (!remaining) continue;
        sent.published = sent.text.length;
        controller.enqueue(
          encoder.encode(
            chatStreamEvent({ id, created, model, delta: { reasoning_content: remaining } })
          )
        );
        drained = true;
      }
      return drained;
    };
    const enqueueThinking = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      index: number,
      block: AssistantMessage['content'][number],
      text: string,
      delta = false
    ) => {
      const drained = drainThinking(controller, index);
      if (block.type !== 'thinking' || block.redacted) return drained;
      const sent = thinkingSent.get(index) ?? { text: '', published: 0 };
      const accumulated = delta ? sent.text + text : text;
      // Stock summary-part completion appends a provisional separator that thinking_end removes.
      // Hold within this index; content boundaries drain observed bytes to preserve stream order.
      // A resumed whitespace-only delta cannot retract a suffix already drained at a boundary.
      const publishable = delta
        ? accumulated.slice(0, Math.max(sent.published, accumulated.trimEnd().length))
        : accumulated;
      if (!publishable.startsWith(sent.text.slice(0, sent.published)))
        throw new GatewayUnsupportedFeatureError('pi-ai Chat conflicting reasoning completion');
      const remaining = publishable.slice(sent.published);
      thinkingSent.set(index, { text: accumulated, published: publishable.length });
      if (!remaining) return drained;
      controller.enqueue(
        encoder.encode(
          chatStreamEvent({ id, created, model, delta: { reasoning_content: remaining } })
        )
      );
      return true;
    };

    const enqueueText = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      index: number,
      text: string,
      delta = false
    ) => {
      const sent = textSent.get(index) ?? '';
      if (!delta && !text.startsWith(sent))
        throw new GatewayUnsupportedFeatureError('pi-ai Chat conflicting text completion');
      const remaining = delta ? text : text.slice(sent.length);
      textSent.set(index, sent + remaining);
      if (!remaining) return false;
      drainThinking(controller);
      controller.enqueue(
        encoder.encode(chatStreamEvent({ id, created, model, delta: { content: remaining } }))
      );
      return true;
    };
    const enqueueToolCompletion = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      index: number,
      toolCall: ToolCall
    ) => {
      if (!isDefaultResponsesNamespace(toolCall.namespace))
        throw new GatewayUnsupportedFeatureError('pi-ai Chat tool namespace');
      const sent = toolArguments.get(index) ?? '';
      const completed = JSON.stringify(toolCall.arguments ?? {});
      let equivalent = false;
      if (sent) {
        try {
          equivalent = isDeepStrictEqual(JSON.parse(sent), toolCall.arguments);
        } catch {
          // A valid streamed prefix is completed below; only a conflicting prefix fails.
        }
      }
      const published = toolIndexes.get(index);
      const [callId] = splitResponsesToolCallId(toolCall.id);
      if (published && (published.id !== callId || published.name !== toolCall.name))
        throw new GatewayUnsupportedFeatureError('pi-ai Chat conflicting tool identity');
      if (equivalent) return false;
      if (!completed.startsWith(sent))
        throw new GatewayUnsupportedFeatureError('pi-ai Chat conflicting tool arguments');
      const suffix = completed.slice(sent.length);
      let toolIndex = published?.index;
      const missingStart = toolIndex === undefined;
      if (missingStart) {
        if (toolIds.has(callId))
          throw new GatewayUnsupportedFeatureError('pi-ai Chat duplicate tool identity');
        toolIds.add(callId);
        toolIndex = toolIndexes.size;
        toolIndexes.set(index, { index: toolIndex, id: callId, name: toolCall.name });
      }
      toolArguments.set(index, completed);
      if (!suffix && !missingStart) return false;
      drainThinking(controller);
      controller.enqueue(
        encoder.encode(
          chatStreamEvent({
            id,
            created,
            model,
            delta: {
              tool_calls: [
                {
                  index: toolIndex,
                  ...(missingStart ? { id: callId, type: 'function' } : {}),
                  function: { ...(missingStart ? { name: toolCall.name } : {}), arguments: suffix },
                },
              ],
            },
          })
        )
      );
      return true;
    };

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (cancelled || terminal) {
          return;
        }

        try {
          if (terminalFailure) {
            terminal = true;
            controller.error(terminalFailure);
            return;
          }
          while (!cancelled && !terminal) {
            const result = await raceProviderWithSignal(() => iterator.next(), signal);

            if (cancelled) {
              return;
            }
            if (result.done) {
              onModelEvent?.({ type: 'truncated' });
              terminalFailure = piAiStreamFailure(
                'Provider stream ended before terminal result',
                'provider_stream_truncated'
              );
              // controller.error discards queued bytes; reject on the next pull after draining.
              if (drainThinking(controller)) return;
              terminal = true;
              controller.error(terminalFailure);
              return;
            }

            const event = result.value;
            if (event.type === 'error')
              terminalFailure = attachPiAiFailure(
                new Error(event.error.errorMessage ?? 'pi-ai stream failed'),
                event
              );
            if (!usageObserved && (event.type === 'done' || event.type === 'error')) {
              usageObserved = true;
              onUsage?.(event.type === 'done' ? event.message.usage : event.error.usage);
            }
            observeModelEvent(event, onModelEvent);
            if (event.type === 'done' || event.type === 'error')
              await onInferenceTerminal?.(
                event.type === 'done' ? event.message : event.error,
                terminalFailure as Error | undefined
              );

            if (event.type === 'start') {
              id = `chatcmpl_${event.partial.responseId ?? `pi_${event.partial.timestamp}`}`;
              created = Math.floor(event.partial.timestamp / 1000);
              model = event.partial.responseModel ?? event.partial.model ?? requestModel;
              controller.enqueue(
                encoder.encode(
                  chatStreamEvent({ id, created, model, delta: { role: 'assistant' } })
                )
              );
              return;
            }

            if (event.type === 'text_delta' || event.type === 'text_end') {
              if (
                enqueueText(
                  controller,
                  event.contentIndex,
                  event.type === 'text_delta' ? event.delta : event.content,
                  event.type === 'text_delta'
                )
              )
                return;
              continue;
            }

            if (event.type === 'thinking_start') {
              if (drainThinking(controller, event.contentIndex)) return;
              continue;
            }

            if (event.type === 'thinking_delta' || event.type === 'thinking_end') {
              const block = event.partial.content[event.contentIndex];
              if (!block || block.type !== 'thinking')
                throw new GatewayUnsupportedFeatureError('pi-ai Chat reasoning stream');
              if (
                enqueueThinking(
                  controller,
                  event.contentIndex,
                  block,
                  event.type === 'thinking_delta' ? event.delta : event.content,
                  event.type === 'thinking_delta'
                )
              )
                return;
              continue;
            }

            if (event.type === 'toolcall_start') {
              const toolIndex = toolIndexes.size;
              const toolCall = readStreamToolCall(event.partial, event.contentIndex);
              if (!isDefaultResponsesNamespace(toolCall.namespace))
                throw new GatewayUnsupportedFeatureError('pi-ai Chat tool namespace');
              const [callId] = splitResponsesToolCallId(toolCall.id);
              if (toolIds.has(callId))
                throw new GatewayUnsupportedFeatureError('pi-ai Chat duplicate tool identity');
              toolIds.add(callId);
              toolIndexes.set(event.contentIndex, {
                index: toolIndex,
                id: callId,
                name: toolCall.name,
              });
              toolArguments.set(event.contentIndex, '');
              drainThinking(controller);
              controller.enqueue(
                encoder.encode(
                  chatStreamEvent({
                    id,
                    created,
                    model,
                    delta: {
                      tool_calls: [
                        {
                          index: toolIndex,
                          id: callId,
                          type: 'function',
                          function: { name: toolCall.name, arguments: '' },
                        },
                      ],
                    },
                  })
                )
              );
              return;
            }

            if (event.type === 'toolcall_delta') {
              toolArguments.set(
                event.contentIndex,
                (toolArguments.get(event.contentIndex) ?? '') + event.delta
              );
              const toolIndex = toolIndexes.get(event.contentIndex)?.index;
              if (toolIndex === undefined) {
                throw new GatewayUnsupportedFeatureError('pi-ai chat tool call stream');
              }
              drainThinking(controller);
              controller.enqueue(
                encoder.encode(
                  chatStreamEvent({
                    id,
                    created,
                    model,
                    delta: {
                      tool_calls: [
                        {
                          index: toolIndex,
                          function: { arguments: event.delta },
                        },
                      ],
                    },
                  })
                )
              );
              return;
            }

            if (event.type === 'toolcall_end') {
              if (enqueueToolCompletion(controller, event.contentIndex, event.toolCall)) return;
              continue;
            }

            if (event.type === 'error') {
              const drained = drainThinking(controller);
              if (!usageObserved) {
                usageObserved = true;
                onUsage?.(event.error.usage);
              }
              const usage = toChatUsage(event.error.usage);
              if (usage) {
                controller.enqueue(
                  encoder.encode(
                    chatStreamEvent({
                      id,
                      created,
                      model: event.error.responseModel ?? event.error.model ?? model,
                      delta: {},
                      usage,
                    })
                  )
                );
              }
              if (!usage && !drained) {
                terminal = true;
                controller.error(terminalFailure);
              }
              // Cleanup must neither block the next pull nor replace the queued terminal failure.
              void Promise.resolve()
                .then(() => iterator.return?.())
                .catch(() => {});
              return;
            }

            if (event.type === 'done') {
              event.message.content.forEach((block, index) => {
                if (block.type === 'thinking')
                  enqueueThinking(controller, index, block, block.thinking);
                else if (block.type === 'text') enqueueText(controller, index, block.text);
                else enqueueToolCompletion(controller, index, block);
              });
              if (!usageObserved) {
                usageObserved = true;
                onUsage?.(event.message.usage);
              }
              const usage = toChatUsage(event.message.usage);
              controller.enqueue(
                encoder.encode(
                  chatStreamEvent({
                    id,
                    created,
                    model: event.message.responseModel ?? event.message.model ?? model,
                    delta: {},
                    finishReason: mapStopReason(event.reason),
                    ...(usage ? { usage } : {}),
                  })
                )
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              terminal = true;
              controller.close();
              await iterator.return?.();
              return;
            }
          }
        } catch (error) {
          if (cancelled || terminal) {
            return;
          }

          const interrupted = signal.aborted;
          abortUpstream(error);
          try {
            onModelEvent?.({ type: interrupted ? 'interrupted' : 'failed' });
            terminalFailure = attachPiAiFailure(error);
          } catch (captureError) {
            terminalFailure = captureError;
          } finally {
            // A conflicting completion may fail after this pull already queued a drained suffix.
            if (!drainThinking(controller) && (controller.desiredSize ?? 0) > 0) {
              terminal = true;
              controller.error(terminalFailure);
            }
            // Stock return waits for an outstanding next; deliver failure independently of cleanup.
            void Promise.resolve()
              .then(() => iterator.return?.())
              .catch(() => {});
          }
        }
      },
      cancel: async (reason) => {
        if (cancelled || terminal) {
          return;
        }

        cancelled = true;
        abortUpstream(reason);
        try {
          onModelEvent?.({ type: 'interrupted' });
        } finally {
          await iterator.return?.();
        }
      },
    });
  }

  /**
   * Reads the effective completion token limit from OpenAI-compatible aliases.
   *
   * @param request Chat Completions request.
   * @returns Token limit when present.
   */
  private maxTokens(request: OpenAICompatibleChatCompletionRequest): number | undefined {
    return (
      readNumber(request.max_completion_tokens) ??
      readNumber(request.max_output_tokens) ??
      readNumber(request.max_tokens)
    );
  }

  /**
   * Converts prompt-cache retention to pi-ai's supported retention enum.
   *
   * @param value Request retention value.
   * @returns pi-ai retention value when present.
   */
  private cacheRetention(value: unknown): 'none' | 'short' | 'long' | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === 'none' || value === 'short' || value === 'long') {
      return value;
    }
    throw new GatewayUnsupportedFeatureError('pi-ai prompt_cache_retention');
  }
}

/** Applies the stock native Codex transport and caller-held header continuity to either public format. */
function applyCodexTransport(
  options: StreamOptions,
  selectedModel: Model<string>,
  transport: LLMGatewayTransportContext
): void {
  if (selectedModel.api === 'openai-codex-responses') {
    options.transport = 'sse';
    if (transport.codexTurnState)
      options.headers = { 'x-codex-turn-state': transport.codexTurnState };
    options.onResponse = (response, responseModel) => {
      if (
        response.status >= 200 &&
        response.status < 300 &&
        modelsAreEqual(selectedModel, responseModel)
      ) {
        const turnState = response.headers['x-codex-turn-state'];
        if (turnState) transport.onCodexTurnState?.(turnState);
      }
    };
  }
}

/** Exact stock API families that can carry admitted Responses native semantics. */
function isResponsesApi(api: string): boolean {
  return (
    api === 'openai-responses' ||
    api === 'azure-openai-responses' ||
    api === 'openai-codex-responses'
  );
}

type ResponsesToolKind = 'custom' | 'function';

/** Request-local inverse of provider-private function names; native identity remains authoritative. */
type ResponsesBridgeNames = ReadonlyMap<
  string,
  { readonly name: string; readonly namespace?: string }
>;

/** Produces a bounded provider name without truncating native callable identity. */
function bridgedResponsesToolName(name: string, namespace?: string): string {
  return isDefaultResponsesNamespace(namespace)
    ? name
    : `ns_${createHash('sha256').update(responsesToolKey(name, namespace)).digest('hex').slice(0, 60)}`;
}

/** One attempt-local carrier for admitted native semantics absent from stock Context, options or blocks. */
interface ResponsesNativeEnvelope {
  readonly input?: readonly unknown[];
  readonly tools?: readonly Record<string, unknown>[] | undefined;
  fields: Record<string, unknown>;
  /** Native wire indices are absent from stock blocks and stay within this attempt. */
  readonly outputIndexes: Map<string, number>;
  output: readonly { readonly index: number; readonly item: Record<string, unknown> }[];
}

interface ResponsesAdditionalTools {
  /** Exact message-anchored item replayed through pi-ai's payload hook. */
  readonly item: {
    readonly id?: string;
    readonly role: 'developer';
    readonly tools: readonly Record<string, unknown>[];
    readonly type: 'additional_tools';
  };
  /** Definitions keyed by exact namespace and callable name for conflict checks. */
  readonly definitions: Map<string, Readonly<Record<string, unknown>>>;
  /** Whether this request declares the exact client-executed search tool. */
  readonly hasToolSearch: boolean;
  /** Tool kind keyed by namespace and name for public response reconstruction. */
  readonly kinds: Map<string, ResponsesToolKind>;
  /** Exact provider-facing tools, including the reserved search lowering. */
  readonly providerTools: readonly Record<string, unknown>[];
}

const RESPONSES_REQUEST_FIELDS = new Set([
  'include',
  'input',
  'instructions',
  'max_output_tokens',
  'model',
  'parallel_tool_calls',
  'prompt_cache_key',
  'prompt_cache_retention',
  'reasoning',
  'store',
  'stream',
  'text',
  'temperature',
  'tool_choice',
  'tools',
]);

/**
 * Validates Gateway-only metadata, excluding it from native field admission, then rejects fields stock pi-ai cannot preserve.
 *
 * @param request Responses request admitted for direct stock mapping.
 * @param allowStream Whether this call owns a streaming response.
 * @returns Validated message-anchored local tool declarations when present.
 */
export function assertResponsesRequestAdmission(
  request: OpenAICompatibleResponsesRequest,
  allowStream: boolean
): ResponsesAdditionalTools | undefined {
  // Both dispatcher preflight and client admission use this boundary; native options never forward metadata.
  const { metadata, ...nativeRequest } = request;
  if (metadata !== undefined && !readRecord(metadata)) {
    throw new GatewayUnsupportedFeatureError('pi-ai metadata');
  }
  for (const key of Object.keys(nativeRequest)) {
    if (!RESPONSES_REQUEST_FIELDS.has(key)) {
      throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${key}`);
    }
  }
  if (request.stream === true && !allowStream) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses stream');
  }
  if (request.store !== undefined && request.store !== false) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses store');
  }
  if (request.instructions !== undefined && typeof request.instructions !== 'string') {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses instructions');
  }
  if (request.prompt_cache_key !== undefined && typeof request.prompt_cache_key !== 'string') {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses prompt_cache_key');
  }
  if (
    request.include !== undefined &&
    (!Array.isArray(request.include) ||
      request.include.length > 1 ||
      (request.include.length === 1 && request.include[0] !== 'reasoning.encrypted_content'))
  ) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses include');
  }
  const text = readRecord(request.text);
  if (
    request.text !== undefined &&
    (!text ||
      Object.keys(text).some((key) => key !== 'verbosity') ||
      (text.verbosity !== 'low' && text.verbosity !== 'medium' && text.verbosity !== 'high'))
  ) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses text');
  }
  const reasoning = readRecord(request.reasoning);
  const summaries = new Set(['auto', 'concise', 'detailed', 'off', 'on']);
  if (
    request.reasoning !== undefined &&
    request.reasoning !== null &&
    (!reasoning ||
      Object.keys(reasoning).some(
        (key) => key !== 'context' && key !== 'effort' && key !== 'summary'
      ) ||
      (reasoning.context !== undefined && reasoning.context !== 'all_turns') ||
      (reasoning.effort !== undefined &&
        !ReasoningEffortSchema.safeParse(reasoning.effort).success) ||
      (reasoning.summary !== undefined &&
        reasoning.summary !== null &&
        !summaries.has(reasoning.summary as string)))
  ) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning');
  }
  const additionalTools = readResponsesAdditionalTools(request.input);
  if (!additionalTools) {
    if (request.tools !== undefined && !Array.isArray(request.tools))
      throw new GatewayUnsupportedFeatureError('pi-ai Responses tools');
    const declarations =
      Array.isArray(request.tools) && request.tools.length > 0
        ? readResponsesAdditionalTools([
            { role: 'developer', type: 'additional_tools', tools: request.tools },
          ])
        : undefined;
    if (declarations?.hasToolSearch) lowerResponsesNativeInput(request.input, declarations);
    else assertResponsesToolHistoryDeclarations(request.input, declarations);
    return undefined;
  }
  lowerResponsesNativeInput(request.input, additionalTools);
  return additionalTools;
}

/** Rejects undeclared or type-conflicting tool history before credential or provider access. */
function assertResponsesToolHistoryDeclarations(
  input: OpenAICompatibleResponsesRequest['input'],
  additionalTools: ResponsesAdditionalTools | undefined
): void {
  if (!Array.isArray(input)) {
    return;
  }
  const calls = new Map<
    string,
    Array<{ readonly kind: ResponsesToolKind; readonly name: string; readonly namespace?: string }>
  >();
  const carriers = new Set<string>();
  for (const value of input) {
    const item = readRecord(value);
    if (item?.type === 'additional_tools') {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools position');
    }
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const kind = item.type === 'custom_tool_call' ? 'custom' : 'function';
      assertExactResponsesKeys(
        item,
        kind === 'custom'
          ? ['call_id', 'id', 'input', 'name', 'namespace', 'status', 'type']
          : ['arguments', 'call_id', 'id', 'name', 'namespace', 'status', 'type'],
        item.type
      );
      const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
      const declaredKind =
        typeof item.name === 'string'
          ? additionalTools?.kinds.get(responsesToolKey(item.name, namespace))
          : undefined;
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        !item.name ||
        (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
        (item.namespace !== undefined && typeof item.namespace !== 'string') ||
        (item.status !== undefined && item.status !== 'completed') ||
        (kind === 'custom'
          ? typeof item.input !== 'string'
          : parseToolArguments(item.arguments) === undefined) ||
        (additionalTools && declaredKind !== kind) ||
        (!additionalTools && kind === 'custom')
      ) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${item.type} declaration`);
      }
      const carrier = typeof item.id === 'string' ? `${item.call_id}|${item.id}` : item.call_id;
      if (carriers.has(carrier)) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${item.type} declaration`);
      }
      carriers.add(carrier);
      const queue = calls.get(item.call_id) ?? [];
      queue.push({ kind, name: item.name, ...(namespace !== undefined ? { namespace } : {}) });
      calls.set(item.call_id, queue);
      continue;
    }
    if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      const kind = item.type === 'custom_tool_call_output' ? 'custom' : 'function';
      assertExactResponsesKeys(
        item,
        kind === 'custom'
          ? ['call_id', 'id', 'name', 'output', 'type']
          : ['call_id', 'id', 'name', 'namespace', 'output', 'type'],
        item.type
      );
      const queue = typeof item.call_id === 'string' ? calls.get(item.call_id) : undefined;
      const call = queue?.shift();
      if (
        !item.call_id ||
        !call ||
        call.kind !== kind ||
        (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
        (item.name !== undefined && item.name !== call.name) ||
        (item.namespace !== undefined &&
          (typeof item.namespace !== 'string' ||
            responsesToolKey(call.name, item.namespace) !==
              responsesToolKey(call.name, call.namespace)))
      ) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${item.type} lineage`);
      }
      readExactResponsesTextContent(item.output, true);
      continue;
    }
    if (!item) throw new GatewayUnsupportedFeatureError('pi-ai Responses input');
    assertExactPreservedResponsesItem(item, false);
  }
  if ([...calls.values()].some((queue) => queue.length > 0)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses tool call lineage');
  }
}

/** Records only identities that have crossed the outward reasoning boundary. */
function recordReturnedReasoning(
  item: Record<string, unknown>,
  member: ReasoningMember,
  attribution: ReasoningAttribution
): void {
  if (item.type === 'reasoning' && typeof item.id === 'string' && item.id)
    attribution.record(item.id, member);
}

/** Removes unattributed capsules and their paired fc_ ids before context or native payload restoration. */
function handoffResponsesInput(
  input: readonly unknown[],
  member: ReasoningMember,
  attribution: ReasoningAttribution,
  sameProtocol = true
): unknown[] {
  let omitPairedId = false;
  return input.flatMap((item): unknown[] => {
    const record = readRecord(item);
    if (!record) return [item];
    if (record.role === 'user') omitPairedId = false;
    if (record.type === 'reasoning') {
      assertExactPreservedResponsesItem(record);
      if (sameProtocol && attribution.matches(record.id, member)) {
        omitPairedId = false;
        return [item];
      }
      omitPairedId = true;
      const text = readResponsesReasoningText(record);
      return text.trim()
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
        : [];
    }
    if (
      omitPairedId &&
      (record.type === 'function_call' || record.type === 'custom_tool_call') &&
      typeof record.id === 'string' &&
      record.id.startsWith('fc_')
    ) {
      const { id: _pairedId, ...call } = record;
      return [call];
    }
    return [item];
  });
}

/**
 * Converts a native Responses request into the pi-ai context consumed by Codex or a chat-native bridge.
 *
 * @param request OpenAI-compatible Responses request.
 * @param model Exact pi-ai model selected for assistant history.
 * @param additionalTools Admitted message-anchored tools, when present.
 * @param bridgedFunctionTools Cross-protocol function declarations with an exact inverse.
 * @param bridgeNames Request-local function identities for bridged history.
 * @param member Provider profile/native model identity permitted to replay attributed capsules.
 * @param attribution Process-local, payload-free producer association.
 * @param nativeInput Validated input overlay when stock blocks cannot preserve the native shape.
 * @param native Whether this member admits native Responses semantics.
 * @returns Text, function history, instructions, and tools without a Chat conversion.
 */
function toPiResponsesContext(
  request: OpenAICompatibleResponsesRequest,
  model: AssistantModel,
  additionalTools: ResponsesAdditionalTools | undefined,
  member: ReasoningMember,
  attribution: ReasoningAttribution,
  bridgedFunctionTools?: NonNullable<Context['tools']>,
  bridgeNames?: ResponsesBridgeNames,
  nativeInput?: readonly unknown[],
  native = false
): Context {
  const messages: Context['messages'] = [];
  const instructions = typeof request.instructions === 'string' ? [request.instructions] : [];
  const toolCalls = new Map<
    string,
    Array<{ readonly carrierId: string; readonly kind: ResponsesToolKind; readonly name: string }>
  >();
  const input =
    nativeInput ??
    (typeof request.input === 'string'
      ? [{ role: 'user', content: request.input }]
      : request.input);

  const handedOffInput = !nativeInput
    ? handoffResponsesInput(input, member, attribution, native)
    : input;
  for (const [index, item] of handedOffInput.entries()) {
    const record = readRecord(item);
    if (!record) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses input');
    }
    const timestamp = index + 1;

    if (record.type === 'additional_tools') {
      if (nativeInput || (index === 0 && additionalTools)) {
        continue;
      }
      throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools position');
    }

    if (record.type === 'function_call' || record.type === 'custom_tool_call') {
      const kind = record.type === 'custom_tool_call' ? 'custom' : 'function';
      if (
        typeof record.call_id !== 'string' ||
        !record.call_id ||
        typeof record.name !== 'string' ||
        !record.name ||
        (record.id !== undefined && (typeof record.id !== 'string' || !record.id)) ||
        (record.namespace !== undefined && typeof record.namespace !== 'string')
      ) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${record.type}`);
      }
      const carrierId =
        typeof record.id === 'string' ? `${record.call_id}|${record.id}` : record.call_id;
      const declaredKind = additionalTools?.kinds.get(
        responsesToolKey(
          record.name,
          typeof record.namespace === 'string' ? record.namespace : undefined
        )
      );
      const reservedSearchCall =
        kind === 'function' &&
        record.name === WORKER_CLIENT_TOOL_SEARCH_FUNCTION &&
        additionalTools?.hasToolSearch === true &&
        isDefaultResponsesNamespace(record.namespace);
      if (
        (!reservedSearchCall && additionalTools && declaredKind !== kind) ||
        (!additionalTools && kind === 'custom')
      ) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${record.type} declaration`);
      }
      const argumentsValue =
        kind === 'custom'
          ? typeof record.input === 'string'
            ? { input: record.input }
            : undefined
          : parseToolArguments(record.arguments);
      if (!argumentsValue) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses custom_tool_call input');
      }
      const providerName = bridgeNames
        ? bridgedResponsesToolName(record.name, record.namespace as string | undefined)
        : record.name;
      const calls = toolCalls.get(record.call_id) ?? [];
      calls.push({ carrierId, kind, name: providerName });
      toolCalls.set(record.call_id, calls);
      messages.push({
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: 'toolCall',
            id: carrierId,
            name: providerName,
            arguments: argumentsValue,
            ...(!bridgeNames && typeof record.namespace === 'string'
              ? { namespace: record.namespace }
              : {}),
          },
        ],
        stopReason: 'toolUse',
        timestamp,
        usage: ZERO_USAGE,
      });
      continue;
    }

    if (record.type === 'function_call_output' || record.type === 'custom_tool_call_output') {
      if (typeof record.call_id !== 'string' || !record.call_id) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${record.type}`);
      }
      const call = toolCalls.get(record.call_id)?.shift();
      const kind = record.type === 'custom_tool_call_output' ? 'custom' : 'function';
      if (!call || call.kind !== kind) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${record.type} lineage`);
      }
      messages.push({
        role: 'toolResult',
        toolCallId: call.carrierId,
        toolName: call.name,
        content: [{ type: 'text', text: readResponsesTextContent(record.output) }],
        isError: false,
        timestamp,
      });
      continue;
    }

    if (record.type === 'reasoning') {
      if (
        (record.id !== undefined && (typeof record.id !== 'string' || !record.id)) ||
        (record.encrypted_content !== undefined &&
          record.encrypted_content !== null &&
          typeof record.encrypted_content !== 'string')
      ) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning item');
      }
      messages.push({
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: 'thinking',
            thinking: readResponsesReasoningText(record),
            thinkingSignature: JSON.stringify(record),
          },
        ],
        stopReason: 'stop',
        timestamp,
        usage: ZERO_USAGE,
      });
      continue;
    }

    if (record.role === 'system' || record.role === 'developer') {
      // Native input preserves the exact instruction position; do not also flatten it into stock instructions.
      if (!nativeInput) instructions.push(readResponsesTextContent(record.content));
      continue;
    }
    if (record.role === 'user') {
      messages.push({
        role: 'user',
        content: responsesUserContent(record.content),
        timestamp,
      });
      continue;
    }
    if (record.role === 'assistant') {
      messages.push({
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: 'text',
            text: readResponsesTextContent(record.content),
            ...(native && typeof record.id === 'string'
              ? {
                  textSignature: JSON.stringify({
                    v: 1,
                    id: record.id,
                    ...(record.phase !== undefined ? { phase: record.phase } : {}),
                  }),
                }
              : {}),
          },
        ],
        stopReason: 'stop',
        timestamp,
        usage: ZERO_USAGE,
      });
      continue;
    }

    throw new GatewayUnsupportedFeatureError('pi-ai Responses input role');
  }

  const tools =
    bridgedFunctionTools ??
    (additionalTools ? toPiNativeTools(additionalTools) : toPiTools(request.tools));
  return {
    messages,
    ...(instructions.filter(Boolean).length > 0
      ? { systemPrompt: instructions.filter(Boolean).join('\n\n') }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** Uses stock tools for representable flat declarations; namespaces and deferred definitions stay in the native envelope. */
function toPiNativeTools(additionalTools: ResponsesAdditionalTools): NonNullable<Context['tools']> {
  return additionalTools.item.tools.flatMap((tool): NonNullable<Context['tools']> => {
    if (tool.type === 'namespace' || tool.type === 'tool_search' || tool.defer_loading === true)
      return [];
    if (tool.type === 'function') return toPiTools([tool]);
    const format = readRecord(tool.format);
    return [
      {
        name: tool.name as string,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        ...(format?.type === 'grammar'
          ? {
              constrainedSampling: {
                type: 'grammar',
                variants: { openai_lark: format.definition as string },
              } as const,
            }
          : {}),
      },
    ];
  });
}

/**
 * Reads the exact Codex Responses Lite tool prefix and its client-executed tool kinds.
 *
 * @param input Responses input candidate.
 * @returns The first additional-tools item when present.
 */
function readResponsesAdditionalTools(
  input: OpenAICompatibleResponsesRequest['input']
): ResponsesAdditionalTools | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }
  const record = readRecord(input[0]);
  if (record?.type !== 'additional_tools') {
    return undefined;
  }
  if (!isWorkerAdditionalToolsItem(record)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools');
  }
  const definitions = new Map<string, Readonly<Record<string, unknown>>>();
  const kinds = new Map<string, ResponsesToolKind>();
  const hasToolSearch = registerResponsesToolDefinitions(record.tools, definitions, kinds, true);
  return {
    definitions,
    hasToolSearch,
    item: record,
    kinds,
    providerTools: lowerResponsesToolDefinitions(record.tools, false),
  };
}

/**
 * Admits Responses features against the selected upstream API capability.
 * Bridged callers restore function-only tools first, then reuse field and history admission. Standard and message-anchored function tools share one namespace projection; custom tools, deferred tools, search and native builtins fail closed.
 *
 * @param request Responses request.
 * @param allowStream Whether this call owns a streaming response.
 * @param bridged Whether the selected provider is a chat-native Responses bridge.
 * @returns Admitted declarations, native envelope input and stock function tools.
 */
function admitPiResponsesNativeRequest(
  request: OpenAICompatibleResponsesRequest,
  allowStream: boolean,
  bridged: boolean
): {
  readonly additionalTools: ResponsesAdditionalTools | undefined;
  readonly nativeInput?: readonly unknown[];
  readonly bridgedFunctionTools?: NonNullable<Context['tools']>;
  readonly bridgeNames?: ResponsesBridgeNames;
} {
  if (!bridged) {
    let additionalTools = assertResponsesRequestAdmission(request, allowStream);
    const anchored = additionalTools !== undefined;
    if (additionalTools && Array.isArray(request.tools) && request.tools.length > 0)
      throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools conflict');
    if (!additionalTools && request.tools !== undefined) {
      if (!Array.isArray(request.tools))
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tools');
      if (request.tools.length > 0)
        additionalTools = readResponsesAdditionalTools([
          { role: 'developer', type: 'additional_tools', tools: request.tools },
        ]);
    }
    const input =
      typeof request.input === 'string'
        ? [{ role: 'user', content: request.input }]
        : request.input;
    return {
      additionalTools,
      ...(additionalTools &&
      (anchored ||
        additionalTools.item.tools.some(
          (tool) => tool.type !== 'function' || tool.defer_loading === true
        ))
        ? { nativeInput: lowerResponsesNativeInput(input, additionalTools) }
        : input.some((value) => {
              const item = readRecord(value);
              return item?.phase !== undefined && item.id === undefined;
            })
          ? { nativeInput: input }
          : {}),
    };
  }
  const reasoning = readRecord(request.reasoning);
  if (
    request.text !== undefined ||
    reasoning?.context !== undefined ||
    reasoning?.summary !== undefined ||
    (Array.isArray(request.input) &&
      request.input.some((item) => readRecord(item)?.phase !== undefined))
  ) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses native controls');
  }
  const additionalTools = readResponsesAdditionalTools(request.input);
  if (!additionalTools) {
    if (!Array.isArray(request.tools) || request.tools.length === 0) {
      assertResponsesRequestAdmission(request, allowStream);
      return { additionalTools: undefined };
    }
    // Reuse declaration validation without adding a transport-only item to the request.
    const declarations = readResponsesAdditionalTools([
      { role: 'developer', type: 'additional_tools', tools: request.tools },
    ]);
    if (!declarations || declarations.hasToolSearch) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses function tools');
    }
    const { bridgedFunctionTools, bridgeNames } =
      bridgedFunctionToolsFromAdditionalTools(declarations);
    assertResponsesRequestAdmission(request, allowStream);
    assertResponsesToolHistoryDeclarations(request.input, declarations);
    return { additionalTools: undefined, bridgedFunctionTools, bridgeNames };
  }
  const { bridgedFunctionTools, bridgeNames } =
    bridgedFunctionToolsFromAdditionalTools(additionalTools);
  return {
    additionalTools: assertResponsesRequestAdmission(request, allowStream),
    bridgedFunctionTools,
    bridgeNames,
  };
}

/**
 * Restores function-only message-anchored tools for a chat-native Responses bridge.
 * Namespace identity is lowered through an exact request-local inverse; non-function, deferred and search tools fail before credentials.
 *
 * @param additionalTools Admitted additional-tools prefix.
 * @returns pi-ai Context tools for the bridged Chat Completions transport.
 */
function bridgedFunctionToolsFromAdditionalTools(additionalTools: ResponsesAdditionalTools): {
  readonly bridgedFunctionTools: NonNullable<Context['tools']>;
  readonly bridgeNames: ResponsesBridgeNames;
} {
  if (additionalTools.hasToolSearch) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools');
  }
  const names = new Map<string, { name: string; namespace?: string }>();
  const tools = additionalTools.item.tools.flatMap((tool) => {
    const namespace = tool.type === 'namespace' ? (tool.name as string) : undefined;
    const children = tool.type === 'namespace' ? (tool.tools as Record<string, unknown>[]) : [tool];
    return children.map((child) => {
      if (child.type !== 'function' || child.defer_loading === true) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses function tools');
      }
      const name = child.name as string;
      const providerName = bridgedResponsesToolName(name, namespace);
      if (names.has(providerName))
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tool mapping collision');
      names.set(providerName, {
        name,
        ...(namespace !== undefined && !isDefaultResponsesNamespace(namespace)
          ? { namespace }
          : {}),
      });
      return {
        ...child,
        name: providerName,
        description: [
          namespace !== undefined && !isDefaultResponsesNamespace(namespace)
            ? `${namespace}.${name}`
            : undefined,
          tool.type === 'namespace' ? tool.description : undefined,
          child.description,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    });
  });
  return { bridgedFunctionTools: toPiTools(tools), bridgeNames: names };
}

/** Registers exact local declarations and rejects request-local definition conflicts. */
function registerResponsesToolDefinitions(
  tools: readonly Record<string, unknown>[],
  definitions: Map<string, Readonly<Record<string, unknown>>>,
  kinds: Map<string, ResponsesToolKind>,
  allowToolSearch: boolean
): boolean {
  let hasToolSearch = false;
  for (const tool of tools) {
    if (tool.type === 'tool_search') {
      if (!allowToolSearch || hasToolSearch) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tool search declaration');
      }
      hasToolSearch = true;
      continue;
    }
    const namespace = tool.type === 'namespace' ? (tool.name as string) : undefined;
    const candidates =
      tool.type === 'namespace'
        ? (tool.tools as readonly Record<string, unknown>[])
        : ([tool] as const);
    for (const candidate of candidates) {
      if (candidate.type !== 'custom' && candidate.type !== 'function') {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools');
      }
      const name = candidate.name as string;
      const key = responsesToolKey(name, namespace);
      const kind = candidate.type;
      const existing = definitions.get(key);
      if (existing && !isDeepStrictEqual(existing, candidate)) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tool definition conflict');
      }
      if (!existing) {
        definitions.set(key, candidate);
        kinds.set(key, kind);
      }
    }
  }
  return hasToolSearch;
}

/** Lowers tool search and optionally activates deferred local declarations. */
function lowerResponsesToolDefinitions(
  tools: readonly Record<string, unknown>[],
  activateDeferred: boolean
): readonly Record<string, unknown>[] {
  return tools.map((tool) => {
    if (tool.type === 'tool_search') {
      return {
        description: tool.description,
        name: WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
        parameters: tool.parameters,
        type: 'function',
      };
    }
    if (tool.type === 'namespace') {
      return {
        ...tool,
        tools: lowerResponsesToolDefinitions(
          tool.tools as readonly Record<string, unknown>[],
          activateDeferred
        ),
      };
    }
    if (!activateDeferred) {
      return tool;
    }
    const { defer_loading: _deferLoading, ...active } = tool;
    return active;
  });
}

/** Builds the exact provider input while lowering only client tool-search lifecycle items. */
function lowerResponsesNativeInput(
  input: OpenAICompatibleResponsesRequest['input'],
  additionalTools: ResponsesAdditionalTools
): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools input');
  }
  const lowered: unknown[] = [];
  const ordinaryCalls = new Map<
    string,
    Array<{ readonly kind: ResponsesToolKind; readonly name: string; readonly namespace?: string }>
  >();
  const searchCalls = new Set<string>();
  const carriers = new Set<string>();

  for (const [index, value] of input.entries()) {
    const item = readRecord(value);
    if (!item) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses input');
    }
    if (index === 0 && item === additionalTools.item) {
      lowered.push({ ...additionalTools.item, tools: additionalTools.providerTools });
      continue;
    }
    if (item.type === 'additional_tools') {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools position');
    }
    if (item.type === 'tool_search_call') {
      assertExactResponsesKeys(
        item,
        ['arguments', 'call_id', 'execution', 'id', 'status', 'type'],
        'tool_search_call'
      );
      const argumentsValue = readRecord(item.arguments);
      if (
        !additionalTools.hasToolSearch ||
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        item.execution !== 'client' ||
        !argumentsValue ||
        (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
        (item.status !== undefined && item.status !== 'completed') ||
        searchCalls.has(item.call_id)
      ) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tool_search_call');
      }
      const carrier = typeof item.id === 'string' ? `${item.call_id}|${item.id}` : item.call_id;
      if (carriers.has(carrier)) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tool_search_call lineage');
      }
      carriers.add(carrier);
      searchCalls.add(item.call_id);
      lowered.push({
        arguments: JSON.stringify(argumentsValue),
        call_id: item.call_id,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        name: WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
        ...(item.status === 'completed' ? { status: 'completed' } : {}),
        type: 'function_call',
      });
      continue;
    }
    if (item.type === 'tool_search_output') {
      assertExactResponsesKeys(
        item,
        ['call_id', 'execution', 'id', 'status', 'tools', 'type'],
        'tool_search_output'
      );
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        item.execution !== 'client' ||
        item.status !== 'completed' ||
        !Array.isArray(item.tools) ||
        (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
        !searchCalls.delete(item.call_id)
      ) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tool_search_output');
      }
      const discoveredItem = {
        role: 'developer',
        tools: item.tools,
        type: 'additional_tools',
      };
      if (
        !isWorkerAdditionalToolsItem(discoveredItem) ||
        item.tools.some((tool) => readRecord(tool)?.type === 'tool_search')
      ) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses tool_search_output tools');
      }
      registerResponsesToolDefinitions(
        discoveredItem.tools,
        additionalTools.definitions,
        additionalTools.kinds,
        false
      );
      lowered.push({
        call_id: item.call_id,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        output: JSON.stringify(item.tools),
        type: 'function_call_output',
      });
      lowered.push({
        role: 'developer',
        tools: lowerResponsesToolDefinitions(discoveredItem.tools, true),
        type: 'additional_tools',
      });
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const kind = item.type === 'custom_tool_call' ? 'custom' : 'function';
      assertExactResponsesKeys(
        item,
        kind === 'custom'
          ? ['call_id', 'id', 'input', 'name', 'namespace', 'status', 'type']
          : ['arguments', 'call_id', 'id', 'name', 'namespace', 'status', 'type'],
        item.type
      );
      const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
      const declaredKind =
        typeof item.name === 'string'
          ? additionalTools.kinds.get(responsesToolKey(item.name, namespace))
          : undefined;
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        !item.name ||
        item.name === WORKER_CLIENT_TOOL_SEARCH_FUNCTION ||
        (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
        (item.namespace !== undefined && typeof item.namespace !== 'string') ||
        (item.status !== undefined && item.status !== 'completed') ||
        (kind === 'custom'
          ? typeof item.input !== 'string'
          : parseToolArguments(item.arguments) === undefined) ||
        declaredKind !== kind
      ) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${item.type} declaration`);
      }
      const carrier = typeof item.id === 'string' ? `${item.call_id}|${item.id}` : item.call_id;
      if (carriers.has(carrier)) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${item.type} declaration`);
      }
      carriers.add(carrier);
      const queue = ordinaryCalls.get(item.call_id) ?? [];
      queue.push({
        kind,
        name: item.name,
        ...(typeof item.namespace === 'string' ? { namespace: item.namespace } : {}),
      });
      ordinaryCalls.set(item.call_id, queue);
      lowered.push(item);
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const kind = item.type === 'custom_tool_call_output' ? 'custom' : 'function';
      assertExactResponsesKeys(
        item,
        kind === 'custom'
          ? ['call_id', 'id', 'name', 'output', 'type']
          : ['call_id', 'id', 'name', 'namespace', 'output', 'type'],
        item.type
      );
      const call =
        typeof item.call_id === 'string' ? ordinaryCalls.get(item.call_id)?.shift() : undefined;
      if (
        !call ||
        call.kind !== kind ||
        (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
        (item.name !== undefined && item.name !== call.name) ||
        (item.namespace !== undefined &&
          (typeof item.namespace !== 'string' ||
            responsesToolKey(call.name, item.namespace) !==
              responsesToolKey(call.name, call.namespace)))
      ) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${item.type} lineage`);
      }
      readExactResponsesTextContent(item.output);
      lowered.push(item);
      continue;
    }
    assertExactPreservedResponsesItem(item);
    lowered.push(item);
  }

  if (searchCalls.size > 0 || [...ordinaryCalls.values()].some((queue) => queue.length > 0)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses tool call lineage');
  }
  return lowered;
}

/** Rejects unknown fields before one native input item is forwarded verbatim. */
function assertExactPreservedResponsesItem(item: Record<string, unknown>, native = true): void {
  if (item.type === 'reasoning') {
    assertExactResponsesKeys(
      item,
      ['content', 'encrypted_content', 'id', 'status', 'summary', 'type'],
      'reasoning item'
    );
    if (
      (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
      (item.status !== undefined && item.status !== 'completed') ||
      (item.encrypted_content !== undefined &&
        item.encrypted_content !== null &&
        typeof item.encrypted_content !== 'string')
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning item');
    }
    readExactResponsesReasoningContent(item);
    return;
  }
  if (
    item.role === 'system' ||
    item.role === 'developer' ||
    item.role === 'user' ||
    item.role === 'assistant'
  ) {
    assertExactResponsesKeys(
      item,
      ['content', 'id', 'phase', 'role', 'status', 'type'],
      'message item'
    );
    if (
      (item.type !== undefined && item.type !== 'message') ||
      (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) ||
      (item.phase !== undefined && item.phase !== 'commentary' && item.phase !== 'final_answer') ||
      (item.status !== undefined && item.status !== 'completed')
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses message item');
    }
    readExactResponsesTextContent(item.content, !native);
    return;
  }
  throw new GatewayUnsupportedFeatureError('pi-ai Responses input role');
}

/** Reads text-only history, including the empty output metadata our stream projector emits; populated or unknown metadata remains unsupported. */
function readExactResponsesTextContent(value: unknown, allowPlainText = false): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses text content');
  }
  for (const valuePart of value) {
    const part = readRecord(valuePart);
    if (
      !part ||
      Object.entries(part).some(
        ([key, field]) =>
          key !== 'text' &&
          key !== 'type' &&
          !(
            part.type === 'output_text' &&
            (key === 'annotations' || key === 'logprobs') &&
            Array.isArray(field) &&
            field.length === 0
          )
      ) ||
      (part.type !== 'input_text' &&
        part.type !== 'output_text' &&
        !(allowPlainText && part.type === 'text')) ||
      typeof part.text !== 'string'
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses non-text content');
    }
  }
  return readResponsesTextContent(value);
}

/** Validates exact opaque reasoning text fields before forwarding the item. */
function readExactResponsesReasoningContent(item: Record<string, unknown>): void {
  for (const key of ['summary', 'content'] as const) {
    const parts = item[key];
    if (parts === undefined || (key === 'content' && parts === null)) continue;
    if (!Array.isArray(parts)) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning content');
    }
    for (const valuePart of parts) {
      const part = readRecord(valuePart);
      if (
        !part ||
        Object.keys(part).some((field) => field !== 'text' && field !== 'type') ||
        (part.type !== 'summary_text' && part.type !== 'reasoning_text') ||
        typeof part.text !== 'string'
      ) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning content');
      }
    }
  }
}

/** Rejects unknown fields in one native item that will cross the provider boundary. */
function assertExactResponsesKeys(
  item: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  if (Object.keys(item).some((key) => !allowed.includes(key))) {
    throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${label}`);
  }
}

/**
 * Converts Responses user content into pi-ai text blocks without flattening an authored array.
 *
 * @param value Responses message content.
 * @returns A string or text-block array accepted by pi-ai.
 */
function responsesUserContent(value: unknown): string | Array<{ type: 'text'; text: string }> {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses user content');
  }

  return value.map((part) => {
    const record = readRecord(part);
    if (
      !record ||
      (record.type !== 'input_text' && record.type !== 'output_text') ||
      typeof record.text !== 'string'
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses non-text content');
    }
    return { type: 'text', text: record.text };
  });
}

/**
 * Reads text-only Responses content and tool output.
 *
 * @param value Responses content candidate.
 * @returns Concatenated text.
 */
function readResponsesTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses text content');
  }

  return value
    .map((part) => {
      const record = readRecord(part);
      if (
        !record ||
        (record.type !== 'input_text' && record.type !== 'output_text') ||
        typeof record.text !== 'string'
      ) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses non-text content');
      }
      return record.text;
    })
    .join('');
}

/** Reads the display text from one opaque Responses reasoning item. */
function readResponsesReasoningText(record: Record<string, unknown>): string {
  for (const key of ['summary', 'content'] as const) {
    const parts = record[key];
    if (parts === undefined || (key === 'content' && parts === null)) {
      continue;
    }
    if (!Array.isArray(parts)) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning content');
    }
    const text = parts
      .map((part) => {
        const content = readRecord(part);
        if (
          !content ||
          (content.type !== 'summary_text' && content.type !== 'reasoning_text') ||
          typeof content.text !== 'string'
        ) {
          throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning content');
        }
        return content.text;
      })
      .join('\n\n');
    if (text) {
      return text;
    }
  }
  return '';
}

/**
 * Converts a final pi-ai assistant message into a native Responses payload.
 *
 * @param message Final pi-ai assistant message.
 * @param requestModel Model id authored by the caller.
 * @param additionalTools Native tool declarations for output validation.
 * @param bridgeNames Exact inverse of provider-private names.
 * @param itemNamespace Response-local namespace for synthetic output identities.
 * @param envelope Missing native output from the request-local carrier.
 * @param native Whether exact native API capability permits signature projection.
 * @returns OpenAI-compatible Responses payload.
 */
function toResponsesResponse(
  message: AssistantMessage,
  requestModel: string,
  additionalTools?: ResponsesAdditionalTools,
  bridgeNames?: ResponsesBridgeNames,
  itemNamespace: string = randomUUID(),
  envelope?: ResponsesNativeEnvelope,
  native = false
): OpenAICompatibleResponsesResponse {
  const output = message.content.flatMap((block, index): Record<string, unknown>[] => {
    if (block.type === 'thinking') {
      if (block.redacted) return [];
      return [responsesReasoningItem(block, `reasoning_${itemNamespace}_${index}`, native)];
    }
    if (block.type === 'toolCall')
      return [responsesToolCallItem(block, additionalTools, 'completed', false, bridgeNames)];
    return [responsesTextItem(block, `message_${itemNamespace}_${index}`)];
  });
  for (const { index, item } of envelope?.output ?? []) {
    if (!output.some((existing) => existing.id === item.id)) output.splice(index, 0, item);
  }
  return {
    id: message.responseId ?? `resp_pi_${message.timestamp}`,
    object: 'response',
    status: message.stopReason === 'length' ? 'incomplete' : 'completed',
    ...(message.stopReason === 'length'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : {}),
    model: requestModel,
    created_at: Math.floor(message.timestamp / 1000),
    output: output
      .map((item, index) => ({
        item,
        index:
          typeof item.id === 'string' ? (envelope?.outputIndexes.get(item.id) ?? index) : index,
      }))
      .toSorted((left, right) => left.index - right.index)
      .map(({ item }) => item),
    usage: toResponsesUsage(message.usage),
  };
}

/** Restores the pinned pi-ai v1 text signature without exposing its private carrier. */
function responsesTextItem(
  block: Extract<AssistantMessage['content'][number], { type: 'text' }>,
  fallbackId: string
): Record<string, unknown> {
  let signature: Record<string, unknown> | undefined;
  try {
    signature = readRecord(JSON.parse(block.textSignature ?? ''));
  } catch {
    // Chat providers need not supply native Responses identity.
  }
  const native =
    signature?.v === 1 && typeof signature.id === 'string' && signature.id ? signature : undefined;
  return {
    id: native?.id ?? fallbackId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    ...(native?.phase === 'commentary' || native?.phase === 'final_answer'
      ? { phase: native.phase }
      : {}),
    content: [{ type: 'output_text', text: block.text }],
  };
}

/** Restores one pi-ai reasoning block to its opaque native Responses item. */
function responsesReasoningItem(
  block: Extract<AssistantMessage['content'][number], { type: 'thinking' }>,
  fallbackId: string,
  preserveNativeSignature = false
): Record<string, unknown> {
  const native = preserveNativeSignature
    ? readNativeResponsesReasoningItem(block.thinkingSignature)
    : undefined;
  return {
    ...native,
    id: typeof native?.id === 'string' && native.id ? native.id : fallbackId,
    type: 'reasoning',
    status: 'completed',
    summary: Array.isArray(native?.summary)
      ? native.summary
      : !block.redacted && block.thinking
        ? [{ type: 'summary_text', text: block.thinking }]
        : [],
  };
}

/** Reads an exact native Responses reasoning item from pi-ai's opaque signature carrier. */
function readNativeResponsesReasoningItem(
  thinkingSignature: string | undefined
): Record<string, unknown> | undefined {
  try {
    const persisted = readRecord(JSON.parse(thinkingSignature ?? ''));
    return persisted?.type === 'reasoning' ? persisted : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reconstructs one public Responses tool item from pi-ai's semantic tool-call block.
 *
 * @param block pi-ai tool-call block.
 * @param additionalTools Message-anchored tool kinds for custom-call recovery.
 * @param status Public item lifecycle status.
 * @param empty Whether to emit the streaming start shape.
 * @param bridgeNames Request-local function identities to restore.
 * @returns Function or custom Responses output item.
 */
function responsesToolCallItem(
  block: ToolCall,
  additionalTools: ResponsesAdditionalTools | undefined,
  status: 'completed' | 'in_progress',
  empty = false,
  bridgeNames?: ResponsesBridgeNames
): Record<string, unknown> {
  if (bridgeNames) {
    const identity = bridgeNames.get(block.name);
    if (!identity || !isDefaultResponsesNamespace(block.namespace)) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses undeclared provider tool output');
    }
    block = { ...block, ...identity };
  }
  const [callId, itemId] = splitResponsesToolCallId(block.id);
  if (block.name === WORKER_CLIENT_TOOL_SEARCH_FUNCTION) {
    if (
      additionalTools?.hasToolSearch !== true ||
      !isDefaultResponsesNamespace(block.namespace) ||
      !readRecord(block.arguments)
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses tool search output');
    }
    return {
      arguments: empty ? {} : block.arguments,
      call_id: callId,
      execution: 'client',
      id: itemId,
      status,
      type: 'tool_search_call',
    };
  }
  const kind = additionalTools?.kinds.get(responsesToolKey(block.name, block.namespace));
  if (additionalTools && kind === undefined) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses undeclared provider tool output');
  }
  if (kind === 'custom') {
    const input = empty ? '' : block.arguments.input;
    if (typeof input !== 'string') {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses custom tool input');
    }
    return {
      call_id: callId,
      id: itemId,
      input,
      name: block.name,
      ...(block.namespace ? { namespace: block.namespace } : {}),
      status,
      type: 'custom_tool_call',
    };
  }
  return {
    arguments: empty ? '' : JSON.stringify(block.arguments ?? {}),
    call_id: callId,
    id: itemId,
    name: block.name,
    ...(block.namespace ? { namespace: block.namespace } : {}),
    status,
    type: 'function_call',
  };
}

/** Splits pi-ai's lossless `call_id|item_id` carrier while retaining legacy single ids. */
function splitResponsesToolCallId(id: string): readonly [string, string] {
  const separator = id.indexOf('|');
  return separator > 0 && separator < id.length - 1
    ? [id.slice(0, separator), id.slice(separator + 1)]
    : [id, id];
}

/** Builds one collision-free lookup key for an optional namespace and tool name. */
function responsesToolKey(name: string, namespace?: string): string {
  return `${isDefaultResponsesNamespace(namespace) ? 'functions' : namespace}\0${name}`;
}

/** Returns whether one native namespace spelling names the default function namespace. */
function isDefaultResponsesNamespace(namespace: unknown): boolean {
  return namespace === undefined || namespace === '' || namespace === 'functions';
}

/**
 * Normalizes pi-ai usage into the public Responses usage vocabulary.
 *
 * @param usage Provider-native pi-ai usage.
 * @returns OpenAI-compatible terminal usage.
 */
function toResponsesUsage(usage: unknown): Record<string, unknown> {
  const record = readRecord(usage) ?? {};
  const input = readNumber(record.input) ?? 0;
  const output = readNumber(record.output) ?? 0;
  const cacheRead = readNumber(record.cacheRead) ?? readNumber(record.cache_read) ?? 0;

  return {
    input_tokens: input + cacheRead,
    input_tokens_details: { cached_tokens: cacheRead },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: readNumber(record.reasoning) ?? 0 },
    total_tokens: readNumber(record.totalTokens) ?? input + cacheRead + output,
  };
}

/**
 * Creates an internal stream failure with non-secret pi-ai terminal fields.
 *
 * `code` distinguishes bare iterator exhaustion from a package `error` inside this client,
 * and `stopReason` records the package terminal reason when present. The public Gateway
 * projection consumes its attached failure value without parsing diagnostic text. OpenKit
 * also forces Codex transport to SSE, so stock pi-ai's WebSocket-only
 * `provider_transport_failure` diagnostic is not produced on the production Codex path.
 *
 * @param message Failure message that also feeds the classifier's text signal.
 * @param code Stable non-secret failure category.
 * @param stopReason Closed pi-ai terminal stop reason, when pi-ai reported one.
 * @param source Original terminal evidence, before internal diagnostics are attached.
 * @returns Error carrying the internal fields used by downstream normalization.
 */
function piAiStreamFailure(
  message: string,
  code: string,
  stopReason?: string,
  source?: unknown
): Error {
  return attachPiAiFailure(
    Object.assign(new Error(message), {
      code,
      ...(stopReason === undefined ? {} : { stopReason }),
    }),
    source ?? { message, ...(stopReason === undefined ? {} : { stopReason }) }
  ) as Error;
}

/**
 * Converts prefetched pi-ai events into native Responses SSE while preserving cancellation.
 * Terminal failure is classified before usage and semantic observers receive the event.
 *
 * @param iterator Remaining pi-ai event iterator.
 * @param first Prefetched first iterator result, replayed exactly once.
 * @param requestModel Model id authored by the caller.
 * @param additionalTools Message-anchored tool kinds used to recover custom calls.
 * @param requireEncryptedReasoning Whether stateless reasoning replay requires terminal backfill.
 * @param preserveNativeTextIdentity Wait for native text identity and phase at text_end.
 * @param onUsage Optional raw terminal usage observer.
 * @param signal Combined caller and downstream cancellation signal.
 * @param abortUpstream Aborts provider work when the downstream stream stops.
 * @param bridgeNames Request-local function identities to restore on public output.
 * @param onModelEvent Private admitted semantic-event observer.
 * @param onReasoningItem Records reasoning identity only when returned in an outward event.
 * @param onInferenceTerminal Advisory account observation after cancellation-capable terminal observers.
 * @param envelope Missing native blocks, emitted once at their admitted positions.
 * @returns Native Responses SSE stream.
 */
function toResponsesSseStream(
  iterator: AsyncIterator<AssistantMessageEvent>,
  first: IteratorResult<AssistantMessageEvent>,
  requestModel: string,
  additionalTools: ResponsesAdditionalTools | undefined,
  requireEncryptedReasoning: boolean,
  preserveNativeTextIdentity: boolean,
  onUsage: ((usage: unknown) => void) | undefined,
  signal: AbortSignal,
  abortUpstream: (reason?: unknown) => void,
  bridgeNames?: ResponsesBridgeNames,
  onModelEvent?: (event: ModelSemanticEvent) => void,
  onReasoningItem?: (item: Record<string, unknown>) => void,
  onInferenceTerminal?: (message: AssistantMessage, failure?: Error) => Promise<void>,
  envelope?: ResponsesNativeEnvelope
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const itemNamespace = randomUUID();
  let pending: IteratorResult<AssistantMessageEvent> | undefined = first;
  let cancelled = false;
  let sequenceNumber = 0;
  let terminal = false;
  let usageObserved = false;
  const emittedNativeItems = new Set<unknown>();
  const publishedIndexes = new Map<number, number>();
  let currentContent: AssistantMessage['content'] = [];
  /** Inserts only native gaps before a stock content position; stock remains the semantic owner. */
  function outputIndex(contentIndex: number, publish = false): number {
    const block = currentContent[contentIndex];
    const nativeId =
      block?.type === 'thinking'
        ? readNativeResponsesReasoningItem(block.thinkingSignature)?.id
        : block?.type === 'text'
          ? responsesTextItem(block, '').id
          : block?.type === 'toolCall'
            ? splitResponsesToolCallId(block.id)[1]
            : undefined;
    const nativeIndex =
      typeof nativeId === 'string' ? envelope?.outputIndexes.get(nativeId) : undefined;
    let index = nativeIndex ?? contentIndex;
    if (nativeIndex === undefined)
      for (const entry of envelope?.output ?? []) if (entry.index <= index) index++;
    const published = publishedIndexes.get(contentIndex);
    if (published !== undefined && published !== index)
      throw new GatewayUnsupportedFeatureError(
        'pi-ai Responses conflicting native output position'
      );
    if (publish) publishedIndexes.set(contentIndex, index);
    return index;
  }
  /** Publishes missing native blocks once, before the next semantic output at their position. */
  function enqueueNativeItems(
    controller: ReadableStreamDefaultController<Uint8Array>,
    beforeIndex: number
  ): void {
    for (const { index, item } of envelope?.output ?? []) {
      if (index >= beforeIndex || emittedNativeItems.has(item.id)) continue;
      emittedNativeItems.add(item.id);
      controller.enqueue(
        encodeEvent({
          type: 'response.output_item.added',
          output_index: index,
          item: { ...item, status: 'in_progress' },
        })
      );
      controller.enqueue(
        encodeEvent({ type: 'response.output_item.done', output_index: index, item })
      );
    }
  }
  const pendingReasoning = new Set<number>();
  const pendingToolCalls = new Set<number>();
  const nativeReasoningIds = new Set<unknown>();
  const encodeEvent = (event: Record<string, unknown>) => {
    const attribute = (item: Record<string, unknown>) => {
      if (
        nativeReasoningIds.has(item.id) ||
        envelope?.output.some((entry) => entry.item.id === item.id)
      )
        onReasoningItem?.(item);
    };
    const item = readRecord(event.item);
    if (item) attribute(item);
    const response = readRecord(event.response);
    if (Array.isArray(response?.output))
      for (const output of response.output) {
        const returned = readRecord(output);
        if (returned) attribute(returned);
      }
    return encoder.encode(responsesStreamEvent({ ...event, sequence_number: sequenceNumber++ }));
  };

  /** Opens one text item and its content part under the same identity used by completion. */
  function enqueueTextStart(
    controller: ReadableStreamDefaultController<Uint8Array>,
    contentIndex: number,
    item: Record<string, unknown>
  ): void {
    controller.enqueue(
      encodeEvent({
        type: 'response.output_item.added',
        output_index: outputIndex(contentIndex, true),
        item: { type: 'message', role: 'assistant', ...item, status: 'in_progress', content: [] },
      })
    );
    controller.enqueue(
      encodeEvent({
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: outputIndex(contentIndex, true),
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      })
    );
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled || terminal) {
        return;
      }

      try {
        while (!cancelled && !terminal) {
          const result = pending ?? (await raceProviderWithSignal(() => iterator.next(), signal));
          pending = undefined;
          if (result.done) {
            onModelEvent?.({ type: 'truncated' });
            terminal = true;
            controller.error(
              piAiStreamFailure('Provider stream failed.', 'provider_stream_truncated')
            );
            await iterator.return?.();
            return;
          }

          const event = result.value;
          const source =
            event.type === 'done'
              ? event.message
              : event.type === 'error'
                ? event.error
                : event.partial;
          currentContent = source.content;
          if (preserveNativeTextIdentity)
            for (const block of source.content) {
              if (block.type === 'thinking') {
                const nativeItem = readNativeResponsesReasoningItem(block.thinkingSignature);
                if (nativeItem?.id) nativeReasoningIds.add(nativeItem.id);
              }
            }

          const observedFailure =
            event.type === 'error'
              ? piAiStreamFailure(
                  event.error.errorMessage ?? 'pi-ai stream failed',
                  event.error.diagnostics?.[0]?.type ?? 'provider_stream_failed',
                  event.error.stopReason,
                  event
                )
              : undefined;
          if (!usageObserved && (event.type === 'done' || event.type === 'error')) {
            usageObserved = true;
            onUsage?.(event.type === 'done' ? event.message.usage : event.error.usage);
          }
          observeModelEvent(event, onModelEvent);
          if (event.type === 'done' || event.type === 'error')
            await onInferenceTerminal?.(
              event.type === 'done' ? event.message : event.error,
              observedFailure
            );
          if (event.type === 'start') {
            controller.enqueue(
              encodeEvent({
                type: 'response.created',
                response: {
                  ...toResponsesResponse(
                    event.partial,
                    requestModel,
                    additionalTools,
                    bridgeNames,
                    itemNamespace,
                    undefined,
                    preserveNativeTextIdentity
                  ),
                  output: [],
                  status: 'in_progress',
                },
              })
            );
            return;
          }
          if ('contentIndex' in event)
            enqueueNativeItems(controller, outputIndex(event.contentIndex));
          if (event.type === 'text_start') {
            if (preserveNativeTextIdentity) {
              continue;
            }
            enqueueTextStart(controller, event.contentIndex, {
              id: `message_${itemNamespace}_${event.contentIndex}`,
            });
            return;
          }
          if (event.type === 'text_delta') {
            if (preserveNativeTextIdentity) {
              continue;
            }
            controller.enqueue(
              encodeEvent({
                type: 'response.output_text.delta',
                delta: event.delta,
                item_id: `message_${itemNamespace}_${event.contentIndex}`,
                output_index: outputIndex(event.contentIndex, true),
                content_index: 0,
              })
            );
            return;
          }
          if (event.type === 'text_end') {
            const block = event.partial.content[event.contentIndex];
            if (!block || block.type !== 'text') {
              throw new GatewayUnsupportedFeatureError('pi-ai Responses text stream');
            }
            const item = responsesTextItem(block, `message_${itemNamespace}_${event.contentIndex}`);
            const itemId = item.id;
            if (preserveNativeTextIdentity) {
              // The stock parser exposes native id and phase only at text_end.
              enqueueTextStart(controller, event.contentIndex, item);
              controller.enqueue(
                encodeEvent({
                  type: 'response.output_text.delta',
                  delta: event.content,
                  item_id: itemId,
                  output_index: outputIndex(event.contentIndex, true),
                  content_index: 0,
                })
              );
            }
            const part = {
              type: 'output_text',
              text: event.content,
              annotations: [],
              logprobs: [],
            };
            controller.enqueue(
              encodeEvent({
                type: 'response.output_text.done',
                item_id: itemId,
                output_index: outputIndex(event.contentIndex, true),
                content_index: 0,
                text: event.content,
                logprobs: [],
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.content_part.done',
                item_id: itemId,
                output_index: outputIndex(event.contentIndex, true),
                content_index: 0,
                part,
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.done',
                output_index: outputIndex(event.contentIndex, true),
                item: { ...item, content: [part] },
              })
            );
            return;
          }
          if (event.type === 'thinking_start') {
            continue;
          }
          if (event.type === 'thinking_delta') {
            continue;
          }
          if (event.type === 'thinking_end') {
            const block = event.partial.content[event.contentIndex];
            if (!block || block.type !== 'thinking') {
              throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning stream');
            }
            if (block.redacted) continue;
            const item = responsesReasoningItem(
              block,
              `reasoning_${itemNamespace}_${event.contentIndex}`,
              preserveNativeTextIdentity
            );
            const itemId = item.id as string;
            // The stock signature is authoritative for native boundaries; other APIs supply one readable summary.
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.added',
                output_index: outputIndex(event.contentIndex, true),
                item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
              })
            );
            const summaries = Array.isArray(item.summary) ? item.summary : [];
            for (const [summaryIndex, value] of summaries.entries()) {
              const part = readRecord(value);
              if (part?.type !== 'summary_text' || typeof part.text !== 'string')
                throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning summary');
              const identity = {
                item_id: itemId,
                output_index: outputIndex(event.contentIndex, true),
                summary_index: summaryIndex,
              };
              controller.enqueue(
                encodeEvent({
                  ...identity,
                  type: 'response.reasoning_summary_part.added',
                  part: { type: 'summary_text', text: '' },
                })
              );
              controller.enqueue(
                encodeEvent({
                  ...identity,
                  type: 'response.reasoning_summary_text.delta',
                  delta: part.text,
                })
              );
              controller.enqueue(
                encodeEvent({
                  ...identity,
                  type: 'response.reasoning_summary_text.done',
                  text: part.text,
                })
              );
              controller.enqueue(
                encodeEvent({ ...identity, type: 'response.reasoning_summary_part.done', part })
              );
            }
            if (
              requireEncryptedReasoning &&
              readNativeResponsesReasoningItem(block.thinkingSignature) &&
              typeof item.encrypted_content !== 'string'
            ) {
              pendingReasoning.add(event.contentIndex);
              return;
            }
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.done',
                output_index: outputIndex(event.contentIndex, true),
                item,
              })
            );
            return;
          }
          if (event.type === 'toolcall_start') {
            const block = readStreamToolCall(event.partial, event.contentIndex);
            if (bridgeNames || (additionalTools && block.namespace === undefined)) {
              pendingToolCalls.add(event.contentIndex);
              continue;
            }
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.added',
                output_index: outputIndex(event.contentIndex, true),
                item: responsesToolCallItem(
                  block,
                  additionalTools,
                  'in_progress',
                  true,
                  bridgeNames
                ),
              })
            );
            return;
          }
          if (event.type === 'toolcall_delta') {
            if (pendingToolCalls.has(event.contentIndex)) {
              continue;
            }
            const block = readStreamToolCall(event.partial, event.contentIndex);
            const [callId, itemId] = splitResponsesToolCallId(block.id);
            if (block.name === WORKER_CLIENT_TOOL_SEARCH_FUNCTION) {
              continue;
            }
            if (
              additionalTools?.kinds.get(responsesToolKey(block.name, block.namespace)) === 'custom'
            ) {
              continue;
            }
            controller.enqueue(
              encodeEvent({
                type: 'response.function_call_arguments.delta',
                call_id: callId,
                delta: event.delta,
                item_id: itemId,
                output_index: outputIndex(event.contentIndex, true),
              })
            );
            return;
          }
          if (event.type === 'toolcall_end') {
            const item = responsesToolCallItem(
              event.toolCall,
              additionalTools,
              'completed',
              false,
              bridgeNames
            );
            const kind = additionalTools?.kinds.get(
              responsesToolKey(event.toolCall.name, event.toolCall.namespace)
            );
            const [callId, itemId] = splitResponsesToolCallId(event.toolCall.id);
            const deferred = pendingToolCalls.delete(event.contentIndex);
            if (deferred) {
              controller.enqueue(
                encodeEvent({
                  type: 'response.output_item.added',
                  output_index: outputIndex(event.contentIndex, true),
                  item: responsesToolCallItem(
                    event.toolCall,
                    additionalTools,
                    'in_progress',
                    true,
                    bridgeNames
                  ),
                })
              );
            }
            if (event.toolCall.name !== WORKER_CLIENT_TOOL_SEARCH_FUNCTION && kind === 'custom') {
              const input = event.toolCall.arguments.input;
              if (typeof input !== 'string') {
                throw new GatewayUnsupportedFeatureError('pi-ai Responses custom tool input');
              }
              if (input) {
                controller.enqueue(
                  encodeEvent({
                    delta: input,
                    item_id: itemId,
                    output_index: outputIndex(event.contentIndex, true),
                    type: 'response.custom_tool_call_input.delta',
                  })
                );
              }
              controller.enqueue(
                encodeEvent({
                  input,
                  item_id: itemId,
                  output_index: outputIndex(event.contentIndex, true),
                  type: 'response.custom_tool_call_input.done',
                })
              );
            } else if (event.toolCall.name !== WORKER_CLIENT_TOOL_SEARCH_FUNCTION) {
              if (deferred) {
                controller.enqueue(
                  encodeEvent({
                    type: 'response.function_call_arguments.delta',
                    call_id: callId,
                    delta: JSON.stringify(event.toolCall.arguments ?? {}),
                    item_id: itemId,
                    output_index: outputIndex(event.contentIndex, true),
                  })
                );
              }
              controller.enqueue(
                encodeEvent({
                  arguments: JSON.stringify(event.toolCall.arguments ?? {}),
                  item_id: itemId,
                  name: item.name,
                  ...(item.namespace ? { namespace: item.namespace } : {}),
                  output_index: outputIndex(event.contentIndex, true),
                  type: 'response.function_call_arguments.done',
                })
              );
            }
            controller.enqueue(
              encodeEvent({
                item,
                output_index: outputIndex(event.contentIndex, true),
                type: 'response.output_item.done',
              })
            );
            return;
          }
          if (event.type === 'error') {
            if (!usageObserved) {
              usageObserved = true;
              onUsage?.(event.error.usage);
            }
            terminal = true;
            controller.error(observedFailure);
            await iterator.return?.();
            return;
          }
          if (event.type === 'done') {
            if (!usageObserved) {
              usageObserved = true;
              onUsage?.(event.message.usage);
            }
            for (const contentIndex of pendingReasoning) {
              const block = event.message.content[contentIndex];
              if (!block || block.type !== 'thinking') {
                throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning stream');
              }
              const item = responsesReasoningItem(
                block,
                `reasoning_${itemNamespace}_${contentIndex}`,
                preserveNativeTextIdentity
              );
              if (typeof item.encrypted_content !== 'string') {
                throw new GatewayUnsupportedFeatureError(
                  'pi-ai Responses reasoning encrypted content'
                );
              }
              controller.enqueue(
                encodeEvent({
                  item,
                  output_index: outputIndex(contentIndex, true),
                  type: 'response.output_item.done',
                })
              );
            }
            pendingReasoning.clear();
            // A terminal-only gap cannot renumber an item already released to the caller.
            for (const index of publishedIndexes.keys()) outputIndex(index);
            enqueueNativeItems(controller, Number.POSITIVE_INFINITY);
            controller.enqueue(
              encodeEvent({
                type:
                  event.message.stopReason === 'length'
                    ? 'response.incomplete'
                    : 'response.completed',
                response: toResponsesResponse(
                  event.message,
                  requestModel,
                  additionalTools,
                  bridgeNames,
                  itemNamespace,
                  envelope,
                  preserveNativeTextIdentity
                ),
              })
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            terminal = true;
            controller.close();
            await iterator.return?.();
            return;
          }
        }
      } catch (error) {
        if (cancelled || terminal) {
          return;
        }
        terminal = true;
        const interrupted = signal.aborted;
        abortUpstream(error);
        try {
          onModelEvent?.({ type: interrupted ? 'interrupted' : 'failed' });
          controller.error(attachPiAiFailure(error));
        } catch (captureError) {
          controller.error(captureError);
        } finally {
          await iterator.return?.();
        }
      }
    },
    async cancel(reason) {
      if (cancelled || terminal) {
        return;
      }
      cancelled = true;
      abortUpstream(reason);
      try {
        onModelEvent?.({ type: 'interrupted' });
      } finally {
        await iterator.return?.();
      }
    },
  });
}

/**
 * Encodes one Responses event as an SSE data frame.
 *
 * @param event OpenAI-compatible Responses event.
 * @returns Encoded SSE text.
 */
function responsesStreamEvent(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface AssistantModel {
  /** pi-ai API family for assistant-history replay. */
  api: string;
  /** pi-ai model id. */
  id: string;
  /** pi-ai provider id. */
  provider: string;
}

/**
 * Converts one OpenAI-compatible chat message into a pi-ai context message.
 *
 * @param message Chat message.
 * @param model Current model identity for assistant history.
 * @param index Message index used for deterministic timestamps.
 * @param toolName Callable name resolved from preceding assistant history.
 * @returns pi-ai context message.
 */
function toPiMessage(
  message: OpenAICompatibleChatMessage,
  model: AssistantModel,
  index: number,
  toolName?: string
) {
  const text = readTextContent(message);
  const timestamp = index + 1;

  if (message.role === 'user') {
    return { role: 'user' as const, content: text, timestamp };
  }
  if (message.role === 'assistant') {
    const toolCalls = toPiAssistantToolCalls(message);
    const reasoning = (message as unknown as Record<string, unknown>).reasoning_content;
    if (reasoning !== undefined && typeof reasoning !== 'string')
      throw new GatewayUnsupportedFeatureError('pi-ai Chat reasoning_content');
    return {
      role: 'assistant' as const,
      // The source protocol is Chat; stock converts its unsigned thinking to readable text on Responses.
      api:
        typeof reasoning === 'string' && reasoning && isResponsesApi(model.api)
          ? 'openai-completions'
          : model.api,
      provider: model.provider,
      model: model.id,
      content: [
        ...(typeof reasoning === 'string' && reasoning
          ? [
              {
                type: 'thinking' as const,
                thinking: reasoning,
                ...(model.api === 'openai-completions'
                  ? { thinkingSignature: 'reasoning_content' }
                  : {}),
              },
            ]
          : []),
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...toolCalls,
      ],
      stopReason: toolCalls.length > 0 ? ('toolUse' as const) : ('stop' as const),
      timestamp,
      usage: ZERO_USAGE,
    };
  }
  if (message.role === 'tool') {
    if (!message.tool_call_id) {
      throw new GatewayUnsupportedFeatureError('pi-ai chat tool result id');
    }
    return {
      role: 'toolResult' as const,
      toolCallId: message.tool_call_id,
      toolName: toolName as string,
      content: [{ type: 'text' as const, text }],
      isError: false,
      timestamp,
    };
  }

  throw new GatewayUnsupportedFeatureError(`pi-ai chat ${message.role}`);
}

/**
 * Converts OpenAI-compatible function tools to pi-ai tool definitions.
 *
 * @param value Request tools field.
 * @returns pi-ai tools.
 */
function toPiTools(value: unknown): NonNullable<Context['tools']> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new GatewayUnsupportedFeatureError('pi-ai chat tools');
  }

  return value.map((tool) => {
    const record = readRecord(tool);
    const fn = record?.type === 'function' ? (readRecord(record.function) ?? record) : undefined;
    if (record?.type !== 'function' || !fn || typeof fn.name !== 'string' || !fn.name) {
      throw new GatewayUnsupportedFeatureError('pi-ai chat tools');
    }

    return {
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: readRecord(fn.parameters) ?? { type: 'object', properties: {} },
      ...(fn.strict === true
        ? { constrainedSampling: { type: 'json_schema', strict: 'require' } }
        : fn.strict === false
          ? { constrainedSampling: false }
          : {}),
    };
  }) as NonNullable<Context['tools']>;
}

/**
 * Converts OpenAI-compatible tool-choice values into pi-ai options.
 *
 * @param value Request tool_choice field.
 * @param api Selected stock API whose option shape is used.
 * @returns pi-ai tool choice option when present.
 */
function toPiToolChoice(value: unknown, api: string): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'auto' || value === 'none') {
    return value;
  }
  if (value === 'required') {
    return isResponsesApi(api) || api === 'openai-completions' ? 'required' : 'any';
  }

  const record = readRecord(value);
  const fn = readRecord(record?.function);
  const name = fn?.name ?? record?.name;
  if (
    record?.type === 'function' &&
    typeof name === 'string' &&
    name &&
    Object.keys(record).every((key) =>
      (fn ? ['type', 'function'] : ['type', 'name']).includes(key)
    ) &&
    (!fn || Object.keys(fn).every((key) => key === 'name'))
  ) {
    if (isResponsesApi(api)) return { type: 'function', name };
    if (api === 'openai-completions') return { type: 'function', function: { name } };
    return { type: 'tool', name };
  }

  throw new GatewayUnsupportedFeatureError('pi-ai tool_choice');
}

/**
 * Converts assistant history tool calls into pi-ai replay blocks.
 *
 * @param message Assistant chat message.
 * @returns pi-ai tool-call content blocks.
 */
function toPiAssistantToolCalls(message: OpenAICompatibleChatMessage) {
  const value = (message as unknown as Record<string, unknown>).tool_calls;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new GatewayUnsupportedFeatureError('pi-ai chat tool_calls');
  }

  return value.map((toolCall) => {
    const record = readRecord(toolCall);
    const fn = readRecord(record?.function);
    if (
      !record ||
      record.type !== 'function' ||
      typeof record.id !== 'string' ||
      !record.id ||
      !fn ||
      typeof fn.name !== 'string' ||
      !fn.name
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai chat tool_calls');
    }

    return {
      type: 'toolCall' as const,
      id: record.id,
      name: fn.name,
      arguments: parseToolArguments(fn.arguments),
    };
  });
}

/**
 * Converts pi-ai tool-call content into OpenAI-compatible Chat Completions tool calls.
 *
 * @param content pi-ai assistant content blocks.
 * @returns OpenAI-compatible tool calls.
 */
function toOpenAIChatToolCalls(content: AssistantMessage['content']) {
  const ids = new Set<string>();
  return content
    .filter((block) => block.type === 'toolCall')
    .map((block) => {
      if (!isDefaultResponsesNamespace(block.namespace))
        throw new GatewayUnsupportedFeatureError('pi-ai Chat tool namespace');
      const [id] = splitResponsesToolCallId(block.id);
      if (ids.has(id))
        throw new GatewayUnsupportedFeatureError('pi-ai Chat duplicate tool identity');
      ids.add(id);
      return {
        id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      };
    });
}

/**
 * Reads a pi-ai streaming tool-call block from a partial assistant message.
 *
 * @param message Partial assistant message.
 * @param contentIndex pi-ai content block index.
 * @returns Tool-call block.
 */
function readStreamToolCall(message: AssistantMessage, contentIndex: number) {
  const block = message.content[contentIndex];
  if (!block || block.type !== 'toolCall') {
    throw new GatewayUnsupportedFeatureError('pi-ai chat tool call stream');
  }
  return block;
}

/**
 * Parses OpenAI-compatible JSON function arguments.
 *
 * @param value Tool arguments payload.
 * @returns JSON argument object from the admitted request or parsed JSON string.
 */
function parseToolArguments(value: unknown): JsonObject {
  if (value === undefined || value === '') {
    return {};
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      const record = readRecord(parsed);
      if (record) {
        return record as JsonObject;
      }
    } catch {
      throw new GatewayUnsupportedFeatureError('pi-ai chat tool arguments');
    }
  }

  const record = readRecord(value);
  if (record) {
    return record as JsonObject;
  }

  throw new GatewayUnsupportedFeatureError('pi-ai chat tool arguments');
}

/**
 * Reads text-only OpenAI-compatible message content.
 *
 * @param message Chat message.
 * @returns Text content.
 */
function readTextContent(message: OpenAICompatibleChatMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (message.content === null) {
    return '';
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        const record = readRecord(part);
        if (!record) {
          throw new GatewayUnsupportedFeatureError(`pi-ai chat ${message.role} non-text content`);
        }
        if (record.type === 'text' && typeof record.text === 'string') {
          return record.text;
        }
        throw new GatewayUnsupportedFeatureError(`pi-ai chat ${message.role} non-text content`);
      })
      .join('');
  }

  throw new GatewayUnsupportedFeatureError(`pi-ai chat ${message.role} non-text content`);
}

/**
 * Maps pi-ai stop reasons to Chat Completions finish reasons.
 *
 * @param reason pi-ai stop reason.
 * @returns OpenAI-compatible finish reason.
 */
function mapStopReason(reason: AssistantMessage['stopReason']): string | null {
  if (reason === 'toolUse') {
    return 'tool_calls';
  }
  if (reason === 'length') {
    return 'length';
  }
  if (reason === 'stop') {
    return 'stop';
  }
  return null;
}

/**
 * Converts pi-ai usage into the public Chat Completions usage vocabulary.
 *
 * @param usage pi-ai usage payload.
 * @returns OpenAI-compatible usage payload.
 */
function toChatUsage(usage: unknown): Record<string, unknown> | undefined {
  const record = readRecord(usage);

  if (!record) {
    return undefined;
  }

  const input = readNumber(record.input) ?? 0;
  const output = readNumber(record.output) ?? 0;
  const cacheRead = readNumber(record.cacheRead) ?? readNumber(record.cache_read) ?? 0;
  const promptTokens = input + cacheRead;
  const totalTokens = promptTokens + output;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: totalTokens,
    ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
  };
}

/**
 * Encodes one Chat Completions stream event.
 *
 * @param input Stream chunk fields.
 * @returns SSE event text.
 */
function chatStreamEvent(input: {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly delta: Record<string, unknown>;
  readonly finishReason?: string | null;
  readonly usage?: Record<string, unknown>;
}): string {
  return `data: ${JSON.stringify({
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage ? { usage: input.usage } : {}),
  })}\n\n`;
}

/**
 * Reads a finite number from a provider payload.
 *
 * @param value Candidate numeric value.
 * @returns Finite number when present.
 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a plain object from a provider payload.
 *
 * @param value Candidate object value.
 * @returns Plain record when present.
 */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Builds the metadata lookup profile for one resolved LLM provider.
 *
 * @param provider Secret-bearing dispatch config.
 * @returns Provider profile fields required by the shared metadata resolver.
 */
function metadataProfile(provider: ResolvedLLMProviderConfig): ProviderProfile {
  return {
    displayName: provider.displayName,
    id: provider.id,
    kind: provider.subscriptionProviderId ? 'oauth' : 'custom',
    models: [...provider.models],
    ...(provider.modelMetadata ? { modelMetadata: provider.modelMetadata } : {}),
    ...(provider.vendor ? { vendor: provider.vendor } : { vendor: provider.adapterId }),
    ...(provider.subscriptionProviderId && provider.accountSlotId
      ? {
          extensions: {
            openkit: {
              subscriptionAccount: { accountSlotId: provider.accountSlotId },
            },
          },
        }
      : {}),
  };
}

/** Request-local adapter model plus whether four USD rates are known facts. */
interface ResolvedAdapterModel {
  readonly model: Model<string>;
  readonly knownCost: boolean;
}

/**
 * Publishes adapter usage, omitting USD unless four rates are known and calculateCost is finite.
 *
 * @param onUsage Optional observer for the provider-native usage payload.
 * @param usage Provider usage payload.
 * @param model Request-local model whose rates feed calculateCost.
 * @param knownCost Whether authored, catalog, and real stock rates are complete.
 */
function publishObservedUsage(
  onUsage: ((usage: unknown) => void) | undefined,
  usage: unknown,
  model: Model<string>,
  knownCost: boolean
): void {
  if (!onUsage) {
    return;
  }
  const record = readRecord(usage);
  if (!record) {
    onUsage(usage);
    return;
  }
  if (!knownCost) {
    const { cost: _cost, ...rest } = record;
    onUsage(rest);
    return;
  }
  const computed = usageForCost(record);
  if (!computed) {
    const { cost: _cost, ...rest } = record;
    onUsage(rest);
    return;
  }
  calculateCost(model, computed);
  if (!Number.isFinite(computed.cost.total) || computed.cost.total < 0) {
    const { cost: _cost, ...rest } = record;
    onUsage(rest);
    return;
  }
  onUsage({ ...record, cost: computed.cost });
}

/**
 * Reads a pi-ai usage object that calculateCost can price.
 *
 * @param record Provider usage record.
 * @returns Usage with a fresh cost object, or null when token counts are missing.
 */
function usageForCost(record: Record<string, unknown>): Usage | null {
  const input = readNumber(record.input);
  const output = readNumber(record.output);
  if (input === undefined || output === undefined) {
    return null;
  }
  const cacheRead = readNumber(record.cacheRead) ?? readNumber(record.cache_read) ?? 0;
  const cacheWrite = readNumber(record.cacheWrite) ?? readNumber(record.cache_write) ?? 0;
  const cacheWrite1h = readNumber(record.cacheWrite1h);
  return {
    cacheRead,
    cacheWrite,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input,
    output,
    totalTokens: readNumber(record.totalTokens) ?? input + output + cacheRead + cacheWrite,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
  };
}

/**
 * Copies adapter cost including request-wide tiers.
 *
 * @param cost Adapter cost object.
 * @returns A new cost object that does not alias nested tier rows.
 */
function cloneAdapterCost(cost: Model<string>['cost']): Model<string>['cost'] {
  return {
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    input: cost.input,
    output: cost.output,
    ...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
  };
}

/**
 * Replaces explicitly authored cost leaves on cloned stock tiers. Catalog flats stay off the tier rows. Thresholds and omitted leaves remain stock.
 *
 * @param tiers Cloned stock request-wide tiers.
 * @param authored Provider `modelMetadata` cost leaves. Zod optional keys may be omitted or undefined.
 * @returns New tier rows with authored leaves applied length-independently.
 */
function overlayAuthoredCostLeavesOnTiers(
  tiers: NonNullable<Model<string>['cost']['tiers']>,
  authored: NonNullable<ProviderProfile['modelMetadata']>[string]['cost']
): NonNullable<Model<string>['cost']['tiers']> {
  const overlay = readAuthoredAdapterCostLeaves(authored);
  if (!overlay) {
    return tiers;
  }

  return tiers.map((tier) => ({
    cacheRead: overlay.cacheRead ?? tier.cacheRead,
    cacheWrite: overlay.cacheWrite ?? tier.cacheWrite,
    input: overlay.input ?? tier.input,
    inputTokensAbove: tier.inputTokensAbove,
    output: overlay.output ?? tier.output,
  }));
}

/**
 * Reads explicitly authored adapter cost leaves without inheriting catalog flats.
 *
 * @param authored Provider `modelMetadata` cost leaves. Zod optional keys may be omitted or undefined.
 * @returns Known authored leaves, or undefined when none are present.
 */
function readAuthoredAdapterCostLeaves(
  authored: NonNullable<ProviderProfile['modelMetadata']>[string]['cost']
):
  | {
      cacheRead?: number;
      cacheWrite?: number;
      input?: number;
      output?: number;
    }
  | undefined {
  if (!authored) {
    return undefined;
  }

  const rates: {
    cacheRead?: number;
    cacheWrite?: number;
    input?: number;
    output?: number;
  } = {};
  if (
    typeof authored.input === 'number' &&
    Number.isFinite(authored.input) &&
    authored.input >= 0
  ) {
    rates.input = authored.input;
  }
  if (
    typeof authored.output === 'number' &&
    Number.isFinite(authored.output) &&
    authored.output >= 0
  ) {
    rates.output = authored.output;
  }
  if (
    typeof authored.cache_read === 'number' &&
    Number.isFinite(authored.cache_read) &&
    authored.cache_read >= 0
  ) {
    rates.cacheRead = authored.cache_read;
  }
  if (
    typeof authored.cache_write === 'number' &&
    Number.isFinite(authored.cache_write) &&
    authored.cache_write >= 0
  ) {
    rates.cacheWrite = authored.cache_write;
  }

  return rates.input !== undefined ||
    rates.output !== undefined ||
    rates.cacheRead !== undefined ||
    rates.cacheWrite !== undefined
    ? rates
    : undefined;
}

/**
 * Reads known stock or pair adapter rates without treating missing leaves as zero.
 *
 * @param cost Adapter cost object.
 * @returns Known finite nonnegative leaves.
 */
function adapterCostRates(cost: Model<string>['cost']): {
  cacheRead?: number;
  cacheWrite?: number;
  input?: number;
  output?: number;
} {
  const rates: {
    cacheRead?: number;
    cacheWrite?: number;
    input?: number;
    output?: number;
  } = {};
  if (typeof cost.input === 'number' && Number.isFinite(cost.input) && cost.input >= 0) {
    rates.input = cost.input;
  }
  if (typeof cost.output === 'number' && Number.isFinite(cost.output) && cost.output >= 0) {
    rates.output = cost.output;
  }
  if (
    typeof cost.cacheRead === 'number' &&
    Number.isFinite(cost.cacheRead) &&
    cost.cacheRead >= 0
  ) {
    rates.cacheRead = cost.cacheRead;
  }
  if (
    typeof cost.cacheWrite === 'number' &&
    Number.isFinite(cost.cacheWrite) &&
    cost.cacheWrite >= 0
  ) {
    rates.cacheWrite = cost.cacheWrite;
  }
  return rates;
}
