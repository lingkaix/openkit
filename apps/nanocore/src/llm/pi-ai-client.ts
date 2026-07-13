import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  createModels,
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
  type StreamOptions,
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
   * @returns OpenAI-compatible Chat Completions response.
   */
  public async createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {}
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    this.assertExplicitCredential(provider);
    this.assertSupportedRequest(request, { allowStream: false });

    const model = this.resolveModel(provider, request.model);
    const response = await raceProviderWithSignal(
      () =>
        this.models.complete(
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
   * @returns OpenAI-compatible Chat Completions SSE stream.
   */
  public async createChatCompletionStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertExplicitCredential(provider);
    this.assertSupportedRequest(request, { allowStream: true });

    const model = this.resolveModel(provider, request.model);
    const localAbortController = new AbortController();
    const signal = transport.signal
      ? AbortSignal.any([transport.signal, localAbortController.signal])
      : localAbortController.signal;
    const events = this.models.stream(
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
   * @returns OpenAI-compatible Responses response.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {}
  ): Promise<OpenAICompatibleResponsesResponse> {
    return convertChatCompletionResponseToResponsesResponse(
      await this.createChatCompletion(
        provider,
        convertResponsesRequestToChatCompletionRequest(request),
        onUsage,
        transport
      )
    );
  }

  /**
   * Creates a streaming OpenAI-compatible Responses payload through pi-ai.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Responses request.
   * @param onUsage Optional observer for the provider-native terminal usage payload.
   * @param transport Optional gateway transport state; pi-ai consumes only cancellation.
   * @returns OpenAI-compatible Responses SSE stream.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    onUsage?: (usage: unknown) => void,
    transport: LLMGatewayTransportContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    return convertChatCompletionStreamToResponsesStream(
      await this.createChatCompletionStream(
        provider,
        convertResponsesRequestToChatCompletionRequest({ ...request, stream: true }),
        onUsage,
        transport
      )
    );
  }

  /**
   * Resolves the pi-ai model selected by an OpenKit provider.
   *
   * @param provider Resolved OpenKit provider config.
   * @param modelId Requested model id.
   * @returns pi-ai model record.
   */
  private resolveModel(provider: ResolvedLLMProviderConfig, modelId: string): Model<string> {
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
    if (provider.backend !== 'pi-ai') {
      return null;
    }

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
            resolve: async () =>
              provider.apiKey ? { auth: { apiKey: provider.apiKey } } : undefined,
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
    const fn = readRecord(record?.function);
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
