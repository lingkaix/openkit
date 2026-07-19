import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { CodexResponsesClient } from './codex-responses-client.js';
import {
  convertChatCompletionResponseToResponsesResponse,
  convertChatCompletionStreamToResponsesStream,
  convertChatCompletionToResponsesRequest,
  convertResponsesRequestToChatCompletionRequest,
  convertResponsesResponseToChatCompletionResponse,
  convertResponsesStreamToChatCompletionStream,
  GatewayUnsupportedFeatureError,
} from './gateway-converters.js';
import {
  type GatewayUsageEndpoint,
  type GatewayUsageRecordInput,
  GatewayUsageTracker,
} from './gateway-usage.js';
import {
  type OpenAICompatibleChatCompletionRequest,
  type OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleProviderError,
  type OpenAICompatibleResponsesRequest,
  type OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { PromptCacheKeyResolver, type PromptCacheKeyScope } from './prompt-cache-key.js';

/**
 * Construction options for the gateway provider dispatcher.
 */
export interface LLMGatewayProviderDispatcherOptions {
  /** ChatGPT Codex Responses-only adapter. */
  readonly codexResponsesClient: CodexResponsesClient;
  /** pi-ai-backed provider adapter for non-native provider families. */
  readonly piAiClient?: PiAiGatewayClient;
  /** Prompt cache key resolver used before native Responses wire calls. */
  readonly promptCacheKeyResolver?: PromptCacheKeyResolver;
  /** Process-local usage tracker used for diagnostics. */
  readonly usageTracker?: GatewayUsageTracker;
}

/**
 * Provider transport state shared across one gateway dispatch.
 */
export interface LLMGatewayTransportContext {
  /** Optional caller signal used to abort provider work. */
  readonly signal?: AbortSignal;
  /** Opaque Codex turn state replayed to the next provider request. */
  readonly codexTurnState?: string;
  /** Observer for accepted terminal Codex turn state. */
  readonly onCodexTurnState?: (turnState: string) => void;
}

/**
 * Optional per-call context for Gateway dispatch.
 */
export interface LLMGatewayDispatchContext {
  /** Usage endpoint family to record for diagnostics. */
  readonly usageEndpoint?: GatewayUsageEndpoint;
  /** Stable OpenKit scope used to derive prompt cache keys. */
  readonly promptCacheScope?: PromptCacheKeyScope;
  /** Optional side-effect observer for adapter-reported usage payloads. */
  readonly onUsage?: GatewayUsageRecordInput['onUsage'];
  /** Optional provider transport state for cancellation and Codex continuity. */
  readonly transport?: LLMGatewayTransportContext;
}

/**
 * Capability-aware dispatcher for agent-facing LLM Gateway requests.
 */
export class LLMGatewayProviderDispatcher {
  private readonly codexResponsesClient: CodexResponsesClient;
  private readonly piAiClient: PiAiGatewayClient;
  private readonly promptCacheKeyResolver: PromptCacheKeyResolver;
  private readonly usageTracker: GatewayUsageTracker;

  /**
   * Creates one dispatcher.
   *
   * @param options Provider clients used for native and bridged calls.
   */
  public constructor(options: LLMGatewayProviderDispatcherOptions) {
    this.codexResponsesClient = options.codexResponsesClient;
    this.piAiClient = options.piAiClient ?? new PiAiGatewayClient();
    this.promptCacheKeyResolver = options.promptCacheKeyResolver ?? new PromptCacheKeyResolver();
    this.usageTracker = options.usageTracker ?? new GatewayUsageTracker();
  }

  /**
   * Creates a non-streaming Chat Completions response.
   *
   * @param provider Resolved provider config.
   * @param request Chat Completions request.
   * @returns Chat Completions response.
   */
  public async createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    this.assertConfiguredModel(provider, request.model);
    const capability = provider.gatewayCapabilities.chatCompletions;
    const endpoint = context.usageEndpoint ?? 'chat_completions';

    if (provider.backend === 'codex-oauth') {
      if (capability === 'bridged' && provider.gatewayCapabilities.responses === 'native') {
        const responsesRequest = this.promptCacheKeyResolver.withPromptCacheKey(
          provider,
          convertChatCompletionToResponsesRequest(request),
          context.promptCacheScope
        );
        const response = await this.codexResponsesClient.createResponses(
          provider,
          responsesRequest,
          context.transport
        );
        this.recordUsage(provider, request.model, endpoint, response.usage, context.onUsage);

        return convertResponsesResponseToChatCompletionResponse(response, request.model);
      }

      throw new GatewayUnsupportedFeatureError('chat completions');
    }

    if (capability === 'native') {
      const keyedRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        request,
        context.promptCacheScope
      );
      const response = await this.piAiClient.createChatCompletion(
        provider,
        keyedRequest,
        (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
        context.transport
      );

      return response;
    }
    if (capability === 'bridged' && provider.gatewayCapabilities.responses === 'native') {
      const responsesRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        convertChatCompletionToResponsesRequest(request),
        context.promptCacheScope
      );
      const response = await this.piAiClient.createResponses(
        provider,
        responsesRequest,
        (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
        context.transport
      );

      return convertResponsesResponseToChatCompletionResponse(response, request.model);
    }

    throw new GatewayUnsupportedFeatureError('chat completions');
  }

  /**
   * Creates a streaming Chat Completions response.
   *
   * @param provider Resolved provider config.
   * @param request Chat Completions request.
   * @returns Chat Completions SSE stream.
   */
  public async createChatCompletionStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertConfiguredModel(provider, request.model);
    const capability = provider.gatewayCapabilities.chatCompletions;
    const endpoint = context.usageEndpoint ?? 'chat_completions';

    if (provider.backend === 'codex-oauth') {
      if (capability === 'bridged' && provider.gatewayCapabilities.responses === 'native') {
        const responsesRequest = this.promptCacheKeyResolver.withPromptCacheKey(
          provider,
          convertChatCompletionToResponsesRequest({
            ...request,
            stream: true,
          }),
          context.promptCacheScope
        );
        const stream = await this.codexResponsesClient.createResponsesStream(
          provider,
          responsesRequest,
          context.transport
        );

        return convertResponsesStreamToChatCompletionStream(
          this.observeUsage(stream, provider, request.model, endpoint, context.onUsage),
          request.model
        );
      }

      throw new GatewayUnsupportedFeatureError('chat completions stream');
    }

    if (capability === 'native') {
      const keyedRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        request,
        context.promptCacheScope
      );
      return this.piAiClient.createChatCompletionStream(
        provider,
        keyedRequest,
        (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
        context.transport
      );
    }
    if (capability === 'bridged' && provider.gatewayCapabilities.responses === 'native') {
      const responsesRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        convertChatCompletionToResponsesRequest({
          ...request,
          stream: true,
        }),
        context.promptCacheScope
      );
      return convertResponsesStreamToChatCompletionStream(
        await this.piAiClient.createResponsesStream(
          provider,
          responsesRequest,
          (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
          context.transport
        ),
        request.model
      );
    }

    throw new GatewayUnsupportedFeatureError('chat completions stream');
  }

  /**
   * Creates a non-streaming Responses response.
   *
   * @param provider Resolved provider config.
   * @param request Responses request.
   * @returns Responses response.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<OpenAICompatibleResponsesResponse> {
    this.assertConfiguredModel(provider, request.model);
    const capability = provider.gatewayCapabilities.responses;
    const endpoint = context.usageEndpoint ?? 'responses';

    if (provider.backend === 'codex-oauth') {
      if (capability === 'native') {
        const keyedRequest = this.promptCacheKeyResolver.withPromptCacheKey(
          provider,
          request,
          context.promptCacheScope
        );
        const response = await this.codexResponsesClient.createResponses(
          provider,
          keyedRequest,
          context.transport
        );
        this.recordUsage(provider, request.model, endpoint, response.usage, context.onUsage);

        return response;
      }

      throw new GatewayUnsupportedFeatureError('responses');
    }

    if (capability === 'native') {
      const keyedRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        request,
        context.promptCacheScope
      );
      const response = await this.piAiClient.createResponses(
        provider,
        keyedRequest,
        (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
        context.transport
      );

      return response;
    }
    if (capability === 'bridged' && provider.gatewayCapabilities.chatCompletions === 'native') {
      const chatRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        convertResponsesRequestToChatCompletionRequest(request),
        context.promptCacheScope
      );
      const response = await this.piAiClient.createChatCompletion(
        provider,
        chatRequest,
        (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
        context.transport
      );

      return convertChatCompletionResponseToResponsesResponse(response);
    }

    throw new GatewayUnsupportedFeatureError('responses');
  }

  /**
   * Creates a streaming Responses response.
   *
   * @param provider Resolved provider config.
   * @param request Responses request.
   * @returns Responses SSE stream.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertConfiguredModel(provider, request.model);
    const capability = provider.gatewayCapabilities.responses;
    const endpoint = context.usageEndpoint ?? 'responses';

    if (provider.backend === 'codex-oauth') {
      if (capability === 'native') {
        const keyedRequest = this.promptCacheKeyResolver.withPromptCacheKey(
          provider,
          request,
          context.promptCacheScope
        );
        const stream = await this.codexResponsesClient.createResponsesStream(
          provider,
          keyedRequest,
          context.transport
        );

        return this.observeUsage(stream, provider, request.model, endpoint, context.onUsage);
      }

      throw new GatewayUnsupportedFeatureError('responses stream');
    }

    if (capability === 'native') {
      const keyedRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        request,
        context.promptCacheScope
      );
      return this.piAiClient.createResponsesStream(
        provider,
        keyedRequest,
        (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
        context.transport
      );
    }
    if (capability === 'bridged' && provider.gatewayCapabilities.chatCompletions === 'native') {
      const chatRequest = this.promptCacheKeyResolver.withPromptCacheKey(
        provider,
        convertResponsesRequestToChatCompletionRequest({
          ...request,
          stream: true,
        }),
        context.promptCacheScope
      );
      return convertChatCompletionStreamToResponsesStream(
        await this.piAiClient.createChatCompletionStream(
          provider,
          chatRequest,
          (usage) => this.recordUsage(provider, request.model, endpoint, usage, context.onUsage),
          context.transport
        )
      );
    }

    throw new GatewayUnsupportedFeatureError('responses stream');
  }

  /**
   * Requires the request model to be explicitly authorized by the provider profile.
   *
   * @param provider Resolved provider config.
   * @param model Requested model id.
   * @throws OpenAICompatibleProviderError when the model is not configured.
   */
  private assertConfiguredModel(provider: ResolvedLLMProviderConfig, model: string): void {
    if (!provider.models.includes(model)) {
      throw new OpenAICompatibleProviderError({
        code: 'model_not_configured',
        message: 'Requested model is not configured for this provider.',
        status: 400,
        type: 'invalid_request_error',
      });
    }
  }

  private observeUsage(
    stream: ReadableStream<Uint8Array>,
    provider: ResolvedLLMProviderConfig,
    model: string,
    endpoint: GatewayUsageEndpoint,
    onUsage?: GatewayUsageRecordInput['onUsage']
  ): ReadableStream<Uint8Array> {
    return this.usageTracker.observeSseUsage(stream, {
      endpoint,
      model,
      ...(onUsage ? { onUsage } : {}),
      provider,
    });
  }

  private recordUsage(
    provider: ResolvedLLMProviderConfig,
    model: string,
    endpoint: GatewayUsageEndpoint,
    usage: unknown,
    onUsage?: GatewayUsageRecordInput['onUsage']
  ): void {
    this.usageTracker.recordUsage({
      endpoint,
      model,
      ...(onUsage ? { onUsage } : {}),
      provider,
      usage,
    });
  }
}
