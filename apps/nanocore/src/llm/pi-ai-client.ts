import { isDeepStrictEqual } from 'node:util';
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  createModels,
  createProvider,
  type Model,
  type Models,
  type MutableModels,
  modelsAreEqual,
  type Provider,
  type ProviderStreams,
  type StreamOptions,
  type ToolCall,
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
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import {
  convertChatCompletionResponseToResponsesResponse,
  convertChatCompletionStreamToResponsesStream,
  convertResponsesRequestToChatCompletionRequest,
  GatewayUnsupportedFeatureError,
} from './gateway-converters.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleChatMessage,
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { OpenAICompatibleProviderError } from './openai-compatible-client.js';
import type { LLMGatewayTransportContext } from './provider-dispatcher.js';
import {
  isWorkerAdditionalToolsItem,
  WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
} from './worker-inference-tool-policy.js';

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
 * @returns Provider result when it settles before cancellation.
 */
async function raceProviderWithSignal<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return operation();
  }

  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
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
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
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

  /**
   * Creates one pi-ai gateway adapter.
   *
   * @param options Optional injected pi-ai model collection.
   */
  public constructor(options: PiAiGatewayClientOptions = {}) {
    this.models = options.models ?? createDefaultPiAiGatewayModels();
    this.adapterProviders = new Map(
      this.models.getProviders().map((provider) => [provider.id, provider])
    );
  }

  /**
   * Creates a non-streaming OpenAI-compatible Chat Completions response through pi-ai.
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
    this.assertSupportedRequest(request, { allowStream: false });

    const model = this.resolveModel(provider, request.model, models);
    const response = await raceProviderWithSignal(
      () =>
        models.complete(
          model,
          this.toContext(request, model),
          this.toStreamOptions(provider, request, transport)
        ),
      transport.signal
    );
    onUsage?.(response.usage);

    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new OpenAICompatibleProviderError({
        code: 'provider_error',
        message: response.errorMessage ?? 'pi-ai provider failed',
        status: 502,
        type: 'provider_error',
      });
    }

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
    this.assertSupportedRequest(request, { allowStream: true });

    const model = this.resolveModel(provider, request.model, models);
    const localAbortController = new AbortController();
    const signal = transport.signal
      ? AbortSignal.any([transport.signal, localAbortController.signal])
      : localAbortController.signal;
    const events = models.stream(
      model,
      this.toContext(request, model),
      this.toStreamOptions(provider, request, { ...transport, signal })
    );
    const iterator = events[Symbol.asyncIterator]();

    return this.toChatCompletionSseStream(iterator, request.model, onUsage, signal, (reason) => {
      localAbortController.abort(reason);
    });
  }

  /**
   * Creates a non-streaming OpenAI-compatible Responses payload through pi-ai.
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
    if (provider.subscriptionProviderId === 'openai-codex') {
      const additionalTools = assertCodexResponsesRequestAdmission(request, false);
      this.assertExplicitCredential(provider);
      const model = this.resolveModel(provider, request.model, models);
      const response = await raceProviderWithSignal(
        () =>
          models.complete(
            model,
            toPiResponsesContext(request, model, additionalTools),
            this.toCodexResponsesOptions(request, model, transport, additionalTools)
          ),
        transport.signal
      );
      onUsage?.(response.usage);
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new OpenAICompatibleProviderError({
          code: 'provider_error',
          message: response.errorMessage ?? 'pi-ai provider failed',
          status: 502,
          type: 'provider_error',
        });
      }
      return toResponsesResponse(response, request.model, additionalTools);
    }

    const response = await this.createChatCompletion(
      provider,
      convertResponsesRequestToChatCompletionRequest(request),
      onUsage,
      transport,
      models
    );
    return convertChatCompletionResponseToResponsesResponse(response);
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
    const codexProvider = provider.subscriptionProviderId === 'openai-codex';
    const additionalTools = codexProvider
      ? assertCodexResponsesRequestAdmission(request, true)
      : readResponsesAdditionalTools(request.input);
    if (codexProvider || additionalTools) {
      if (!codexProvider) {
        assertCodexResponsesRequestAdmission(request, true);
      }
      this.assertExplicitCredential(provider);
      const model = this.resolveModel(provider, request.model, models);
      const localAbortController = new AbortController();
      const signal = transport.signal
        ? AbortSignal.any([transport.signal, localAbortController.signal])
        : localAbortController.signal;
      const events = models.stream(
        model,
        toPiResponsesContext(request, model, additionalTools),
        codexProvider
          ? this.toCodexResponsesOptions(request, model, { ...transport, signal }, additionalTools)
          : this.toBridgedResponsesOptions(provider, request, { ...transport, signal })
      );
      const iterator = events[Symbol.asyncIterator]();
      let first: IteratorResult<AssistantMessageEvent>;
      try {
        first = await raceProviderWithSignal(() => iterator.next(), signal);
      } catch (error) {
        localAbortController.abort(error);
        await iterator.return?.();
        throw error;
      }

      return toResponsesSseStream(
        iterator,
        first,
        request.model,
        additionalTools,
        Array.isArray(request.include) && request.include.includes('reasoning.encrypted_content'),
        onUsage,
        signal,
        (reason) => localAbortController.abort(reason)
      );
    }

    return convertChatCompletionStreamToResponsesStream(
      await this.createChatCompletionStream(
        provider,
        convertResponsesRequestToChatCompletionRequest({ ...request, stream: true }),
        onUsage,
        transport,
        models
      )
    );
  }

  /**
   * Maps admitted Responses Lite options onto a Chat Completions transport.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Admitted Responses Lite request.
   * @param transport Gateway cancellation state.
   * @returns pi-ai Chat Completions options without native Responses fields.
   */
  private toBridgedResponsesOptions(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    transport: LLMGatewayTransportContext
  ): StreamOptions & Record<string, unknown> {
    const maxOutputTokens = request.max_output_tokens;
    const parallelToolCalls = request.parallel_tool_calls;
    if (
      maxOutputTokens !== undefined &&
      (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) <= 0)
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai max_output_tokens');
    }
    if (parallelToolCalls !== undefined && typeof parallelToolCalls !== 'boolean') {
      throw new GatewayUnsupportedFeatureError('pi-ai parallel_tool_calls');
    }

    const options = this.toStreamOptions(
      provider,
      {
        messages: [],
        model: request.model,
        max_tokens: maxOutputTokens,
        prompt_cache_key: request.prompt_cache_key,
        prompt_cache_retention: request.prompt_cache_retention,
        tool_choice: request.tool_choice,
      },
      transport
    );
    const reasoning = readRecord(request.reasoning);
    if (typeof reasoning?.effort === 'string') {
      options.reasoningEffort = reasoning.effort;
    }
    if (parallelToolCalls !== undefined) {
      options.onPayload = (payload) => {
        const record = readRecord(payload);
        if (!record) {
          throw new GatewayUnsupportedFeatureError('pi-ai Responses payload');
        }
        return { ...record, parallel_tool_calls: parallelToolCalls };
      };
    }
    return options;
  }

  /**
   * Resolves the pi-ai model selected by an OpenKit provider.
   *
   * @param provider Resolved OpenKit provider config.
   * @param modelId Requested model id.
   * @param models Per-call model collection.
   * @returns pi-ai model record.
   */
  private resolveModel(
    provider: ResolvedLLMProviderConfig,
    modelId: string,
    models: Models
  ): Model<string> {
    if (models !== this.models) {
      const providerId = provider.subscriptionProviderId;
      const exact = providerId ? models.getModel(providerId, modelId) : undefined;
      const prefix = providerId ? `${providerId}/` : '';
      const stripped =
        !exact && prefix && modelId.startsWith(prefix)
          ? models.getModel(providerId!, modelId.slice(prefix.length))
          : undefined;
      const pairModel = exact ?? stripped;

      if (!pairModel) {
        throw new PiAiGatewayConfigurationError(
          `Provider ${provider.id} does not expose model ${modelId}.`
        );
      }
      return pairModel;
    }

    const model = this.registerConfiguredProviderModel(
      provider,
      modelId,
      this.lookupAdapterModel(provider, modelId)
    );

    if (!model) {
      throw new PiAiGatewayConfigurationError(
        `Provider ${provider.id} does not expose model ${modelId}.`
      );
    }

    return model;
  }

  /**
   * Registers a configured provider instance around catalog behavior or a conservative custom model.
   *
   * @param provider Resolved OpenKit provider config.
   * @param modelId Requested model id.
   * @param template Optional catalog model and adapter implementation to preserve.
   * @returns Registered instance model, or null when the backend cannot resolve the model safely.
   */
  private registerConfiguredProviderModel(
    provider: ResolvedLLMProviderConfig,
    modelId: string,
    template: { readonly model: Model<string>; readonly provider: Provider } | null
  ): Model<string> | null {
    let model: Model<string>;
    let api: ProviderStreams;

    if (template) {
      model = {
        ...template.model,
        baseUrl: provider.baseUrl ?? template.model.baseUrl,
        provider: provider.id,
      };
      api = template.provider;
    } else {
      if (!provider.baseUrl) {
        return null;
      }

      const apiName =
        provider.gatewayCapabilities.responses === 'native'
          ? 'openai-responses'
          : 'openai-completions';
      model = {
        api: apiName,
        baseUrl: provider.baseUrl,
        contextWindow: 128000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        id: modelId,
        input: ['text'],
        maxTokens: 32000,
        name: modelId,
        provider: provider.id,
        reasoning: false,
      };
      api = apiName === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi();
    }

    this.models.setProvider(
      createProvider({
        id: provider.id,
        name: provider.displayName,
        baseUrl: model.baseUrl,
        auth: {
          apiKey: {
            name: `${provider.displayName} API key`,
            resolve: async () => ({
              auth: { apiKey: provider.apiKey ?? 'openkit-keyless' },
            }),
          },
        },
        models: [model],
        api,
      })
    );

    return model;
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
   * Converts shared Chat Completions options into pi-ai stream options.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Chat Completions request.
   * @param transport Gateway transport state; only its cancellation signal is mapped.
   * @returns pi-ai stream options with explicit credential isolation.
   */
  private toStreamOptions(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    transport: LLMGatewayTransportContext
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
    if (metadata) {
      options.metadata = metadata;
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
    const toolChoice = toPiToolChoice(request.tool_choice);
    if (toolChoice !== undefined) {
      options.toolChoice = toolChoice;
    }

    return options;
  }

  /**
   * Converts native Responses inputs into the bounded Codex pi-ai options.
   *
   * @param request OpenAI-compatible Responses request.
   * @param selectedModel Exact pair model selected for dispatch.
   * @param transport Gateway cancellation and turn-state transport.
   * @returns pi-ai options with SSE, continuity, and validated payload overlays.
   */
  private toCodexResponsesOptions(
    request: OpenAICompatibleResponsesRequest,
    selectedModel: Model<string>,
    transport: LLMGatewayTransportContext,
    additionalTools: ResponsesAdditionalTools | undefined
  ): StreamOptions & Record<string, unknown> {
    const options: StreamOptions & Record<string, unknown> = {
      env: {},
      transport: 'sse',
    };
    const cacheRetention = this.cacheRetention(request.prompt_cache_retention);
    const reasoning = readRecord(request.reasoning);
    const text = readRecord(request.text);
    const maxOutputTokens = request.max_output_tokens;
    const parallelToolCalls = request.parallel_tool_calls;

    if (
      additionalTools !== undefined &&
      request.tools !== undefined &&
      (!Array.isArray(request.tools) || request.tools.length > 0)
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools conflict');
    }

    if (
      maxOutputTokens !== undefined &&
      (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) <= 0)
    ) {
      throw new GatewayUnsupportedFeatureError('pi-ai max_output_tokens');
    }
    if (parallelToolCalls !== undefined && typeof parallelToolCalls !== 'boolean') {
      throw new GatewayUnsupportedFeatureError('pi-ai parallel_tool_calls');
    }
    if (cacheRetention) {
      options.cacheRetention = cacheRetention;
    }
    if (typeof request.prompt_cache_key === 'string') {
      options.sessionId = request.prompt_cache_key;
    }
    if (transport.signal) {
      options.signal = transport.signal;
    }
    if (transport.codexTurnState) {
      options.headers = { 'x-codex-turn-state': transport.codexTurnState };
    }
    if (reasoning) {
      if (typeof reasoning.effort === 'string') {
        options.reasoningEffort = reasoning.effort;
      }
      if (typeof reasoning.summary === 'string' || reasoning.summary === null) {
        options.reasoningSummary = reasoning.summary;
      }
    }
    if (text) {
      options.textVerbosity = text.verbosity;
    }
    if (
      request.tool_choice === 'auto' ||
      request.tool_choice === 'none' ||
      request.tool_choice === 'required'
    ) {
      options.toolChoice = request.tool_choice;
    } else if (request.tool_choice !== undefined) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses tool_choice');
    }

    options.onPayload = (payload) => {
      if (
        maxOutputTokens === undefined &&
        parallelToolCalls === undefined &&
        additionalTools === undefined &&
        reasoning?.context === undefined
      ) {
        return undefined;
      }
      const record = readRecord(payload);
      if (!record) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses payload');
      }
      if (additionalTools && !Array.isArray(record.input)) {
        throw new GatewayUnsupportedFeatureError('pi-ai Responses payload input');
      }
      return {
        ...record,
        ...(additionalTools ? { input: additionalTools.providerInput } : {}),
        ...(additionalTools ? { tools: additionalTools.providerTools } : {}),
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
        ...(parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
        ...(reasoning?.context === 'all_turns'
          ? {
              reasoning: {
                ...(readRecord(record.reasoning) ?? {}),
                context: 'all_turns',
              },
            }
          : {}),
      };
    };
    options.onResponse = (response, responseModel) => {
      if (
        response.status >= 200 &&
        response.status < 300 &&
        modelsAreEqual(selectedModel, responseModel)
      ) {
        const turnState = response.headers['x-codex-turn-state'];
        if (turnState) {
          transport.onCodexTurnState?.(turnState);
        }
      }
    };

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
   * Rejects request fields that this adapter slice cannot map without semantic loss.
   *
   * @param request Chat Completions request.
   */
  private assertSupportedRequest(
    request: OpenAICompatibleChatCompletionRequest,
    options: { readonly allowStream: boolean }
  ): void {
    const unsupportedFields = [
      'functions',
      'function_call',
      'logit_bias',
      'logprobs',
      'response_format',
      'top_logprobs',
      'top_p',
    ];

    if (request.stream === true && !options.allowStream) {
      throw new GatewayUnsupportedFeatureError('pi-ai chat completions stream');
    }
    if (request.prompt_cache_key !== undefined && typeof request.prompt_cache_key !== 'string') {
      throw new GatewayUnsupportedFeatureError('pi-ai prompt_cache_key');
    }
    if (request.metadata !== undefined && !readRecord(request.metadata)) {
      throw new GatewayUnsupportedFeatureError('pi-ai metadata');
    }

    for (const field of unsupportedFields) {
      if (request[field] !== undefined) {
        throw new GatewayUnsupportedFeatureError(`pi-ai chat ${field}`);
      }
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
    const messages = request.messages
      .filter((message) => message.role !== 'system' && message.role !== 'developer')
      .map((message, index) => toPiMessage(message, model, index));
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
   *
   * @param iterator pi-ai assistant event iterator.
   * @param requestModel Model requested by the caller.
   * @param onUsage Optional observer for the provider-native terminal usage payload.
   * @param signal Combined caller and downstream cancellation signal.
   * @param abortUpstream Cancels provider work when the downstream stream stops early.
   * @returns Public Chat Completions SSE stream.
   */
  private toChatCompletionSseStream(
    iterator: AsyncIterator<AssistantMessageEvent>,
    requestModel: string,
    onUsage: ((usage: unknown) => void) | undefined,
    signal: AbortSignal,
    abortUpstream: (reason?: unknown) => void
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let id = `chatcmpl_pi_${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    let model = requestModel;
    let usageObserved = false;
    let cancelled = false;
    let terminal = false;
    const toolIndexes = new Map<number, number>();

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (cancelled || terminal) {
          return;
        }

        try {
          while (!cancelled && !terminal) {
            const result = await raceProviderWithSignal(() => iterator.next(), signal);

            if (cancelled) {
              return;
            }
            if (result.done) {
              terminal = true;
              controller.close();
              return;
            }

            const event = result.value;

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

            if (event.type === 'text_delta') {
              controller.enqueue(
                encoder.encode(
                  chatStreamEvent({ id, created, model, delta: { content: event.delta } })
                )
              );
              return;
            }

            if (event.type === 'toolcall_start') {
              const toolIndex = toolIndexes.size;
              toolIndexes.set(event.contentIndex, toolIndex);
              const toolCall = readStreamToolCall(event.partial, event.contentIndex);
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
                          id: toolCall.id,
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
              const toolIndex = toolIndexes.get(event.contentIndex);
              if (toolIndex === undefined) {
                throw new GatewayUnsupportedFeatureError('pi-ai chat tool call stream');
              }
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
              continue;
            }

            if (event.type === 'error') {
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
              terminal = true;
              controller.error(new Error(event.error.errorMessage ?? 'pi-ai stream failed'));
              await iterator.return?.();
              return;
            }

            if (event.type === 'done') {
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

          terminal = true;
          abortUpstream(error);
          controller.error(error);
          await iterator.return?.();
        }
      },
      cancel: async (reason) => {
        if (cancelled || terminal) {
          return;
        }

        cancelled = true;
        abortUpstream(reason);
        await iterator.return?.();
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
    return readNumber(request.max_completion_tokens) ?? readNumber(request.max_tokens);
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

type ResponsesToolKind = 'custom' | 'function';

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
  /** Validated native history lowered only where stock pi-ai lacks a parser shape. */
  readonly providerInput?: readonly unknown[];
  /** Exact provider-facing tools, including the reserved search lowering. */
  readonly providerTools: readonly Record<string, unknown>[];
}

const CODEX_RESPONSES_REQUEST_FIELDS = new Set([
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
  'tool_choice',
  'tools',
]);

/**
 * Rejects native Codex request fields that stock pi-ai cannot preserve.
 *
 * @param request Responses request admitted for Codex dispatch.
 * @param allowStream Whether this call owns a streaming response.
 * @returns Validated message-anchored local tool declarations when present.
 */
export function assertCodexResponsesRequestAdmission(
  request: OpenAICompatibleResponsesRequest,
  allowStream: boolean
): ResponsesAdditionalTools | undefined {
  for (const key of Object.keys(request)) {
    if (!CODEX_RESPONSES_REQUEST_FIELDS.has(key)) {
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
      request.include.length !== 1 ||
      request.include[0] !== 'reasoning.encrypted_content')
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
  const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const summaries = new Set(['auto', 'concise', 'detailed', 'off', 'on']);
  if (
    request.reasoning !== undefined &&
    (!reasoning ||
      Object.keys(reasoning).some(
        (key) => key !== 'context' && key !== 'effort' && key !== 'summary'
      ) ||
      (reasoning.context !== undefined && reasoning.context !== 'all_turns') ||
      (reasoning.effort !== undefined && !efforts.has(reasoning.effort as string)) ||
      (reasoning.summary !== undefined &&
        reasoning.summary !== null &&
        !summaries.has(reasoning.summary as string)))
  ) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses reasoning');
  }
  const additionalTools = readResponsesAdditionalTools(request.input);
  if (!additionalTools) {
    assertResponsesToolHistoryDeclarations(request.input, undefined);
    return undefined;
  }
  return {
    ...additionalTools,
    providerInput: lowerCodexResponsesInput(request.input, additionalTools),
  };
}

/** Rejects undeclared or type-conflicting tool history before credential or provider access. */
function assertResponsesToolHistoryDeclarations(
  input: OpenAICompatibleResponsesRequest['input'],
  additionalTools: ResponsesAdditionalTools | undefined
): void {
  if (!Array.isArray(input)) {
    return;
  }
  const calls = new Map<string, ResponsesToolKind[]>();
  const carriers = new Set<string>();
  for (const value of input) {
    const item = readRecord(value);
    if (item?.type === 'additional_tools') {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses additional tools position');
    }
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const kind = item.type === 'custom_tool_call' ? 'custom' : 'function';
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
      queue.push(kind);
      calls.set(item.call_id, queue);
      continue;
    }
    if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      const kind = item.type === 'custom_tool_call_output' ? 'custom' : 'function';
      const queue = typeof item.call_id === 'string' ? calls.get(item.call_id) : undefined;
      if (!item.call_id || queue?.shift() !== kind) {
        throw new GatewayUnsupportedFeatureError(`pi-ai Responses ${item.type} lineage`);
      }
      readResponsesTextContent(item.output);
    }
  }
  if ([...calls.values()].some((queue) => queue.length > 0)) {
    throw new GatewayUnsupportedFeatureError('pi-ai Responses tool call lineage');
  }
}

/**
 * Converts a native Responses request into the pi-ai context consumed by Codex.
 *
 * @param request OpenAI-compatible Responses request.
 * @param model Exact pi-ai model selected for assistant history.
 * @returns Text, function history, instructions, and tools without a Chat conversion.
 */
function toPiResponsesContext(
  request: OpenAICompatibleResponsesRequest,
  model: AssistantModel,
  additionalTools: ResponsesAdditionalTools | undefined
): Context {
  const messages: Context['messages'] = [];
  const instructions = typeof request.instructions === 'string' ? [request.instructions] : [];
  const toolCalls = new Map<
    string,
    Array<{ readonly carrierId: string; readonly kind: ResponsesToolKind; readonly name: string }>
  >();
  const input =
    additionalTools?.providerInput ??
    (typeof request.input === 'string'
      ? [{ role: 'user', content: request.input }]
      : request.input);

  for (const [index, item] of input.entries()) {
    const record = readRecord(item);
    if (!record) {
      throw new GatewayUnsupportedFeatureError('pi-ai Responses input');
    }
    const timestamp = index + 1;

    if (record.type === 'additional_tools') {
      if (additionalTools?.providerInput || (index === 0 && additionalTools)) {
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
      const calls = toolCalls.get(record.call_id) ?? [];
      calls.push({ carrierId, kind, name: record.name });
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
            name: record.name,
            arguments: argumentsValue,
            ...(typeof record.namespace === 'string' ? { namespace: record.namespace } : {}),
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
      if (!additionalTools) {
        instructions.push(readResponsesTextContent(record.content));
      }
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
        content: [{ type: 'text', text: readResponsesTextContent(record.content) }],
        stopReason: 'stop',
        timestamp,
        usage: ZERO_USAGE,
      });
      continue;
    }

    throw new GatewayUnsupportedFeatureError('pi-ai Responses input role');
  }

  const tools = additionalTools ? [] : toPiTools(request.tools);
  return {
    messages,
    ...(instructions.filter(Boolean).length > 0
      ? { systemPrompt: instructions.filter(Boolean).join('\n\n') }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
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
function lowerCodexResponsesInput(
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
function assertExactPreservedResponsesItem(item: Record<string, unknown>): void {
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
    readExactResponsesTextContent(item.content);
    return;
  }
  throw new GatewayUnsupportedFeatureError('pi-ai Responses input role');
}

/** Reads exact text-only content without admitting unowned nested fields. */
function readExactResponsesTextContent(value: unknown): string {
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
      Object.keys(part).some((key) => key !== 'text' && key !== 'type') ||
      (part.type !== 'input_text' && part.type !== 'output_text') ||
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
 * @returns OpenAI-compatible Responses payload.
 */
function toResponsesResponse(
  message: AssistantMessage,
  requestModel: string,
  additionalTools?: ResponsesAdditionalTools
): OpenAICompatibleResponsesResponse {
  return {
    id: message.responseId ?? `resp_pi_${message.timestamp}`,
    object: 'response',
    status: 'completed',
    model: requestModel,
    created_at: Math.floor(message.timestamp / 1000),
    output: message.content.map((block, index): Record<string, unknown> => {
      if (block.type === 'thinking') {
        return responsesReasoningItem(block, `reasoning_${index}`);
      }
      if (block.type === 'toolCall') {
        return responsesToolCallItem(block, additionalTools, 'completed');
      }
      return {
        id: `message_${index}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: block.text }],
      };
    }),
    usage: toResponsesUsage(message.usage),
  };
}

/** Restores one pi-ai reasoning block to its opaque native Responses item. */
function responsesReasoningItem(
  block: Extract<AssistantMessage['content'][number], { type: 'thinking' }>,
  fallbackId: string
): Record<string, unknown> {
  let persisted: Record<string, unknown> | undefined;
  try {
    persisted = readRecord(JSON.parse(block.thinkingSignature ?? ''));
  } catch {
    persisted = undefined;
  }
  const native = persisted?.type === 'reasoning' ? persisted : undefined;
  return {
    ...native,
    id: typeof native?.id === 'string' && native.id ? native.id : fallbackId,
    type: 'reasoning',
    status: 'completed',
    summary:
      block.thinking || !Array.isArray(native?.summary)
        ? block.thinking
          ? [{ type: 'summary_text', text: block.thinking }]
          : []
        : native.summary,
  };
}

/**
 * Reconstructs one public Responses tool item from pi-ai's semantic tool-call block.
 *
 * @param block pi-ai tool-call block.
 * @param additionalTools Message-anchored tool kinds for custom-call recovery.
 * @param status Public item lifecycle status.
 * @param empty Whether to emit the streaming start shape.
 * @returns Function or custom Responses output item.
 */
function responsesToolCallItem(
  block: ToolCall,
  additionalTools: ResponsesAdditionalTools | undefined,
  status: 'completed' | 'in_progress',
  empty = false
): Record<string, unknown> {
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
 * classifier has no direct mapping for these internal codes and does not read `stopReason`,
 * so absent a separate message match they normalize to `gateway_stream_failed`. OpenKit
 * also forces Codex transport to SSE, so stock pi-ai's WebSocket-only
 * `provider_transport_failure` diagnostic is not produced on the production Codex path.
 *
 * @param message Failure message that also feeds the classifier's text signal.
 * @param code Stable non-secret failure category.
 * @param stopReason Closed pi-ai terminal stop reason, when pi-ai reported one.
 * @returns Error carrying the internal fields used by downstream normalization.
 */
function piAiStreamFailure(message: string, code: string, stopReason?: string): Error {
  return Object.assign(new Error(message), {
    code,
    ...(stopReason === undefined ? {} : { stopReason }),
  });
}

/**
 * Converts prefetched pi-ai events into native Responses SSE while preserving cancellation.
 *
 * @param iterator Remaining pi-ai event iterator.
 * @param first Prefetched first iterator result, replayed exactly once.
 * @param requestModel Model id authored by the caller.
 * @param additionalTools Message-anchored tool kinds used to recover custom calls.
 * @param requireEncryptedReasoning Whether stateless reasoning replay requires terminal backfill.
 * @param onUsage Optional raw terminal usage observer.
 * @param signal Combined caller and downstream cancellation signal.
 * @param abortUpstream Aborts provider work when the downstream stream stops.
 * @returns Native Responses SSE stream.
 */
function toResponsesSseStream(
  iterator: AsyncIterator<AssistantMessageEvent>,
  first: IteratorResult<AssistantMessageEvent>,
  requestModel: string,
  additionalTools: ResponsesAdditionalTools | undefined,
  requireEncryptedReasoning: boolean,
  onUsage: ((usage: unknown) => void) | undefined,
  signal: AbortSignal,
  abortUpstream: (reason?: unknown) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pending: IteratorResult<AssistantMessageEvent> | undefined = first;
  let cancelled = false;
  let sequenceNumber = 0;
  let terminal = false;
  let usageObserved = false;
  const pendingReasoning = new Set<number>();
  const pendingToolCalls = new Set<number>();
  const encodeEvent = (event: Record<string, unknown>) =>
    encoder.encode(responsesStreamEvent({ ...event, sequence_number: sequenceNumber++ }));

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
            terminal = true;
            controller.error(
              piAiStreamFailure('Provider stream failed.', 'provider_stream_truncated')
            );
            await iterator.return?.();
            return;
          }

          const event = result.value;
          if (event.type === 'start') {
            controller.enqueue(
              encodeEvent({
                type: 'response.created',
                response: {
                  ...toResponsesResponse(event.partial, requestModel, additionalTools),
                  output: [],
                  status: 'in_progress',
                },
              })
            );
            return;
          }
          if (event.type === 'text_start') {
            const itemId = `message_${event.contentIndex}`;
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.added',
                output_index: event.contentIndex,
                item: {
                  id: itemId,
                  type: 'message',
                  role: 'assistant',
                  status: 'in_progress',
                  content: [],
                },
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.content_part.added',
                item_id: itemId,
                output_index: event.contentIndex,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
              })
            );
            return;
          }
          if (event.type === 'text_delta') {
            controller.enqueue(
              encodeEvent({
                type: 'response.output_text.delta',
                delta: event.delta,
                item_id: `message_${event.contentIndex}`,
                output_index: event.contentIndex,
                content_index: 0,
              })
            );
            return;
          }
          if (event.type === 'text_end') {
            const itemId = `message_${event.contentIndex}`;
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
                output_index: event.contentIndex,
                content_index: 0,
                text: event.content,
                logprobs: [],
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.content_part.done',
                item_id: itemId,
                output_index: event.contentIndex,
                content_index: 0,
                part,
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.done',
                output_index: event.contentIndex,
                item: {
                  id: itemId,
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [part],
                },
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
            const item = responsesReasoningItem(block, `reasoning_${event.contentIndex}`);
            const itemId = item.id as string;
            const part = { type: 'summary_text', text: event.content };
            // pi-ai exposes the opaque reasoning id only at thinking_end.
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.added',
                output_index: event.contentIndex,
                item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.reasoning_summary_part.added',
                item_id: itemId,
                output_index: event.contentIndex,
                summary_index: 0,
                part: { type: 'summary_text', text: '' },
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.reasoning_summary_text.delta',
                delta: event.content,
                item_id: itemId,
                output_index: event.contentIndex,
                summary_index: 0,
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.reasoning_summary_text.done',
                item_id: itemId,
                output_index: event.contentIndex,
                summary_index: 0,
                text: event.content,
              })
            );
            controller.enqueue(
              encodeEvent({
                type: 'response.reasoning_summary_part.done',
                item_id: itemId,
                output_index: event.contentIndex,
                summary_index: 0,
                part,
              })
            );
            if (
              requireEncryptedReasoning &&
              block.thinkingSignature &&
              typeof item.encrypted_content !== 'string'
            ) {
              pendingReasoning.add(event.contentIndex);
              return;
            }
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.done',
                output_index: event.contentIndex,
                item,
              })
            );
            return;
          }
          if (event.type === 'toolcall_start') {
            const block = readStreamToolCall(event.partial, event.contentIndex);
            if (additionalTools && block.namespace === undefined) {
              pendingToolCalls.add(event.contentIndex);
              continue;
            }
            controller.enqueue(
              encodeEvent({
                type: 'response.output_item.added',
                output_index: event.contentIndex,
                item: responsesToolCallItem(block, additionalTools, 'in_progress', true),
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
                output_index: event.contentIndex,
              })
            );
            return;
          }
          if (event.type === 'toolcall_end') {
            const item = responsesToolCallItem(event.toolCall, additionalTools, 'completed');
            const kind = additionalTools?.kinds.get(
              responsesToolKey(event.toolCall.name, event.toolCall.namespace)
            );
            const [callId, itemId] = splitResponsesToolCallId(event.toolCall.id);
            const deferred = pendingToolCalls.delete(event.contentIndex);
            if (deferred) {
              controller.enqueue(
                encodeEvent({
                  type: 'response.output_item.added',
                  output_index: event.contentIndex,
                  item: responsesToolCallItem(event.toolCall, additionalTools, 'in_progress', true),
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
                    output_index: event.contentIndex,
                    type: 'response.custom_tool_call_input.delta',
                  })
                );
              }
              controller.enqueue(
                encodeEvent({
                  input,
                  item_id: itemId,
                  output_index: event.contentIndex,
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
                    output_index: event.contentIndex,
                  })
                );
              }
              controller.enqueue(
                encodeEvent({
                  arguments: JSON.stringify(event.toolCall.arguments ?? {}),
                  item_id: itemId,
                  name: event.toolCall.name,
                  output_index: event.contentIndex,
                  type: 'response.function_call_arguments.done',
                })
              );
            }
            controller.enqueue(
              encodeEvent({
                item,
                output_index: event.contentIndex,
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
            controller.error(
              piAiStreamFailure(
                event.error.errorMessage ?? 'pi-ai stream failed',
                event.error.diagnostics?.[0]?.type ?? 'provider_stream_failed',
                event.error.stopReason
              )
            );
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
              const item = responsesReasoningItem(block, `reasoning_${contentIndex}`);
              if (typeof item.encrypted_content !== 'string') {
                throw new GatewayUnsupportedFeatureError(
                  'pi-ai Responses reasoning encrypted content'
                );
              }
              controller.enqueue(
                encodeEvent({
                  item,
                  output_index: contentIndex,
                  type: 'response.output_item.done',
                })
              );
            }
            pendingReasoning.clear();
            controller.enqueue(
              encodeEvent({
                type: 'response.completed',
                response: toResponsesResponse(event.message, requestModel, additionalTools),
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
        abortUpstream(error);
        controller.error(error);
        await iterator.return?.();
      }
    },
    async cancel(reason) {
      if (cancelled || terminal) {
        return;
      }
      cancelled = true;
      abortUpstream(reason);
      await iterator.return?.();
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
 * @returns pi-ai context message.
 */
function toPiMessage(message: OpenAICompatibleChatMessage, model: AssistantModel, index: number) {
  const text = readTextContent(message);
  const timestamp = index + 1;

  if (message.role === 'user') {
    return { role: 'user' as const, content: text, timestamp };
  }
  if (message.role === 'assistant') {
    const toolCalls = toPiAssistantToolCalls(message);
    return {
      role: 'assistant' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls],
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
      toolName: message.tool_call_id,
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
    };
  }) as NonNullable<Context['tools']>;
}

/**
 * Converts OpenAI-compatible tool-choice values into pi-ai options.
 *
 * @param value Request tool_choice field.
 * @returns pi-ai tool choice option when present.
 */
function toPiToolChoice(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'auto' || value === 'none') {
    return value;
  }
  if (value === 'required') {
    return 'any';
  }

  const record = readRecord(value);
  const fn = readRecord(record?.function);
  if (record?.type === 'function' && fn && typeof fn.name === 'string' && fn.name) {
    return { type: 'tool', name: fn.name };
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
  return content
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
      },
    }));
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
 * @returns Plain argument object.
 */
function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === '') {
    return {};
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      const record = readRecord(parsed);
      if (record) {
        return record;
      }
    } catch {
      throw new GatewayUnsupportedFeatureError('pi-ai chat tool arguments');
    }
  }

  const record = readRecord(value);
  if (record) {
    return record;
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
