import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  createModels,
  createProvider,
  type Model,
  type MutableModels,
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
  OpenAICompatibleModelListResponse,
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { OpenAICompatibleProviderError } from './openai-compatible-client.js';
import type { ResolvedLLMProviderConfig } from './provider-config.js';

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
 * Provider failure surfaced by a pi-ai-routed call with optional reported usage.
 */
export class PiAiGatewayProviderError extends OpenAICompatibleProviderError {
  /** Usage reported by pi-ai before the provider failure, when available. */
  public readonly usage?: unknown;

  /**
   * Creates one pi-ai provider failure.
   *
   * @param input Product-safe provider failure details.
   */
  public constructor(input: { readonly message: string; readonly usage?: unknown }) {
    super({ code: 'provider_error', message: input.message, status: 502, type: 'provider_error' });
    this.name = 'PiAiGatewayProviderError';
    this.usage = input.usage;
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
  private readonly models: MutableModels;

  /**
   * Creates one pi-ai gateway adapter.
   *
   * @param options Optional injected pi-ai model collection.
   */
  public constructor(options: PiAiGatewayClientOptions = {}) {
    this.models = options.models ?? createDefaultPiAiGatewayModels();
  }

  /**
   * Creates a non-streaming OpenAI-compatible Chat Completions response through pi-ai.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Chat Completions request.
   * @returns OpenAI-compatible Chat Completions response.
   */
  public async createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    this.assertExplicitCredential(provider);
    this.assertSupportedRequest(request, { allowStream: false });

    const model = this.resolveModel(provider, request.model);
    const response = await this.models.complete(
      model,
      this.toContext(request, model),
      this.toStreamOptions(provider, request)
    );

    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new PiAiGatewayProviderError({
        message: response.errorMessage ?? 'pi-ai provider failed',
        usage: toChatUsage(response.usage),
      });
    }

    return this.toChatCompletionResponse(response, request.model);
  }

  /**
   * Creates a streaming OpenAI-compatible Chat Completions response through pi-ai.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Chat Completions request.
   * @returns OpenAI-compatible Chat Completions SSE stream.
   */
  public async createChatCompletionStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertExplicitCredential(provider);
    this.assertSupportedRequest(request, { allowStream: true });

    const model = this.resolveModel(provider, request.model);
    const events = this.models.stream(
      model,
      this.toContext(request, model),
      this.toStreamOptions(provider, request)
    );

    return this.toChatCompletionSseStream(events, request.model);
  }

  /**
   * Lists known models for a resolved provider without calling NanoCore's legacy HTTP client.
   *
   * @param provider Resolved OpenKit provider config.
   * @returns OpenAI-compatible model list payload.
   */
  public async listModels(
    provider: ResolvedLLMProviderConfig
  ): Promise<OpenAICompatibleModelListResponse> {
    const configuredModel = provider.model ? this.resolveModel(provider, provider.model) : null;
    const models = this.lookupProviderModels(provider);
    const data = models.length > 0 ? models : configuredModel ? [configuredModel] : [];

    return {
      object: 'list',
      data: data.map((model) => ({
        id: model.id,
        object: 'model',
        owned_by: model.provider,
      })),
    };
  }

  /**
   * Creates a non-streaming OpenAI-compatible Responses payload through pi-ai.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Responses request.
   * @returns OpenAI-compatible Responses response.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest
  ): Promise<OpenAICompatibleResponsesResponse> {
    return convertChatCompletionResponseToResponsesResponse(
      await this.createChatCompletion(
        provider,
        convertResponsesRequestToChatCompletionRequest(request)
      )
    );
  }

  /**
   * Creates a streaming OpenAI-compatible Responses payload through pi-ai.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Responses request.
   * @returns OpenAI-compatible Responses SSE stream.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest
  ): Promise<ReadableStream<Uint8Array>> {
    return convertChatCompletionStreamToResponsesStream(
      await this.createChatCompletionStream(
        provider,
        convertResponsesRequestToChatCompletionRequest({ ...request, stream: true })
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
    const model = this.lookupProviderIds(provider)
      .map((providerId) => this.models.getModel(providerId, modelId))
      .find((candidate): candidate is Model<string> => Boolean(candidate));

    if (model) {
      return model;
    }

    const customModel = this.registerCustomOpenAICompatibleModel(provider, modelId);

    if (!customModel) {
      throw new PiAiGatewayConfigurationError(
        `Provider ${provider.id} does not expose model ${modelId}.`
      );
    }

    return customModel;
  }

  /**
   * Registers a runtime OpenAI-compatible endpoint as a pi-ai custom provider when no catalog entry exists.
   *
   * @param provider Resolved OpenKit provider config.
   * @param modelId Requested model id.
   * @returns Registered pi-ai model, or null when the provider is not a custom endpoint.
   */
  private registerCustomOpenAICompatibleModel(
    provider: ResolvedLLMProviderConfig,
    modelId: string
  ): Model<string> | null {
    if (
      !provider.baseUrl ||
      provider.spec.backend !== 'pi-ai' ||
      (provider.gatewayCapabilities.responses === 'native' && provider.specId !== provider.id)
    ) {
      return null;
    }

    const api =
      provider.gatewayCapabilities.responses === 'native'
        ? 'openai-responses'
        : 'openai-completions';
    const model: Model<'openai-completions' | 'openai-responses'> = {
      api,
      baseUrl: provider.baseUrl,
      contextWindow: 128000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      id: modelId,
      input: ['text'],
      maxTokens: 32000,
      name: modelId,
      provider: provider.id,
      reasoning: provider.spec.supportsReasoning,
    };

    this.models.setProvider(
      createProvider({
        id: provider.id,
        name: provider.displayName,
        baseUrl: provider.baseUrl,
        auth: {
          apiKey: {
            name: `${provider.displayName} API key`,
            resolve: async () =>
              provider.apiKey ? { auth: { apiKey: provider.apiKey } } : undefined,
          },
        },
        models: [model],
        api:
          api === 'openai-responses'
            ? { 'openai-responses': openAIResponsesApi() }
            : { 'openai-completions': openAICompletionsApi() },
      })
    );

    return model;
  }

  /**
   * Lists pi-ai provider ids that can satisfy one OpenKit provider config.
   *
   * @param provider Resolved OpenKit provider config.
   * @returns Candidate pi-ai provider ids.
   */
  private lookupProviderIds(provider: ResolvedLLMProviderConfig): string[] {
    return [
      provider.id,
      provider.specId,
      ...(PI_AI_PROVIDER_ALIASES[provider.specId] ?? []),
      ...(PI_AI_PROVIDER_ALIASES[provider.id] ?? []),
    ].filter((value, index, values) => values.indexOf(value) === index);
  }

  /**
   * Lists known pi-ai models for one OpenKit provider config.
   *
   * @param provider Resolved OpenKit provider config.
   * @returns Known pi-ai model records.
   */
  private lookupProviderModels(provider: ResolvedLLMProviderConfig): readonly Model<string>[] {
    return this.lookupProviderIds(provider).flatMap((providerId) =>
      this.models.getModels(providerId)
    );
  }

  /**
   * Converts shared Chat Completions options into pi-ai stream options.
   *
   * @param provider Resolved OpenKit provider config.
   * @param request Chat Completions request.
   * @returns pi-ai stream options with explicit credential isolation.
   */
  private toStreamOptions(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest
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
    if (provider.spec.requiresApiKey && !provider.apiKey) {
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
   * @param stream pi-ai assistant event stream.
   * @param requestModel Model requested by the caller.
   * @returns Public Chat Completions SSE stream.
   */
  private toChatCompletionSseStream(
    stream: AsyncIterable<AssistantMessageEvent>,
    requestModel: string
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let id = `chatcmpl_pi_${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    let model = requestModel;
    const toolIndexes = new Map<number, number>();

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for await (const event of stream) {
            if (event.type === 'start') {
              id = `chatcmpl_${event.partial.responseId ?? `pi_${event.partial.timestamp}`}`;
              created = Math.floor(event.partial.timestamp / 1000);
              model = event.partial.responseModel ?? event.partial.model ?? requestModel;
              controller.enqueue(
                encoder.encode(
                  chatStreamEvent({ id, created, model, delta: { role: 'assistant' } })
                )
              );
              continue;
            }

            if (event.type === 'text_delta') {
              controller.enqueue(
                encoder.encode(
                  chatStreamEvent({ id, created, model, delta: { content: event.delta } })
                )
              );
              continue;
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
              continue;
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
              continue;
            }

            if (event.type === 'toolcall_end') {
              continue;
            }

            if (event.type === 'error') {
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
              throw new Error(event.error.errorMessage ?? 'pi-ai stream failed');
            }

            if (event.type === 'done') {
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
            }
          }

          controller.close();
        } catch (error) {
          controller.error(error);
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
