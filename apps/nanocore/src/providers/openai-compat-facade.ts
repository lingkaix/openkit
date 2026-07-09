import type { Hono } from 'hono';
import { z } from 'zod';

import type { AuthVariables } from '../auth/middleware.js';
import type { ProviderProfile } from '../config/providers-loader.js';
import {
  type OpenAICompatibleChatCompletionRequest,
  type OpenAICompatibleChatMessage,
  OpenAICompatibleProviderError,
} from '../llm/openai-compatible-client.js';
import type { ResolvedLLMProviderConfig } from '../llm/provider-config.js';
import { resolveProviderProfileToLLMConfig } from './llm-config.js';
import type { ProviderCredentialResolver, ProviderRegistry } from './registry.js';

/**
 * Internal OpenAI-compatible facade settings.
 */
export interface OpenAICompatFacadeOptions {
  /** Whether the internal facade route is enabled. */
  enabled: boolean;
  /** Provider id to use when a request does not select a provider. */
  defaultProviderId?: string;
  /** Model to use when a request omits model. */
  defaultModel?: string;
}

/**
 * Dependencies required to register the internal facade route.
 */
export interface OpenAICompatFacadeRegistration {
  /** Hono app to mutate with the facade route. */
  app: Hono<{ Variables: AuthVariables }>;
  /** Gateway-backed client used to serve the OpenAI-compatible facade. */
  llmClient: OpenAICompatFacadeClient;
  /** Runtime provider registry. */
  providerRegistry: ProviderRegistry | (() => ProviderRegistry);
  /** Facade settings. */
  options: OpenAICompatFacadeOptions | (() => OpenAICompatFacadeOptions);
  /** Resolver used to materialize provider secret references. */
  providerCredentialResolver?: ProviderCredentialResolver;
}

/** Gateway-backed client shape used by the legacy OpenAI-compatible facade. */
export interface OpenAICompatFacadeClient {
  /**
   * Creates a non-streaming Chat Completions response.
   *
   * @param provider Resolved provider config.
   * @param request Chat Completions request.
   * @returns Chat Completions response payload.
   */
  createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest
  ): Promise<unknown>;
  /**
   * Creates a streaming Chat Completions response.
   *
   * @param provider Resolved provider config.
   * @param request Chat Completions request.
   * @returns Chat Completions SSE stream.
   */
  createChatCompletionStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest
  ): Promise<ReadableStream<Uint8Array>>;
}

const InternalChatCompletionRequestSchema = z
  .object({
    messages: z
      .array(
        z.object({
          content: z.union([z.string(), z.array(z.unknown()), z.null()]),
          role: z.enum(['system', 'user', 'assistant', 'tool']),
          tool_call_id: z.string().optional(),
        })
      )
      .min(1),
    model: z.string().min(1).optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

/**
 * Registers the internal OpenAI-compatible chat-completions facade.
 *
 * @param registration Facade route dependencies.
 */
export function registerOpenAICompatFacade(registration: OpenAICompatFacadeRegistration): void {
  const { app, llmClient, options, providerRegistry } = registration;

  app.post('/internal/v1/chat/completions', async (c) => {
    try {
      const input = InternalChatCompletionRequestSchema.parse(await c.req.json());
      const currentOptions = resolveFacadeOptions(options);
      const profile = selectProvider(
        resolveProviderRegistry(providerRegistry),
        currentOptions.defaultProviderId
      );
      const model = input.model ?? currentOptions.defaultModel ?? profile.defaultModel;

      if (!model) {
        return openAIError('internal_model_not_configured', 'Internal facade requires a model.');
      }

      const request = createUpstreamRequest(input, model);
      const provider = resolveProviderProfileToLLMConfig(
        profile,
        registration.providerCredentialResolver
      );

      if (input.stream) {
        const stream = await llmClient.createChatCompletionStream(provider, request);

        return new Response(stream, {
          headers: {
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8',
          },
        });
      }

      return c.json(await llmClient.createChatCompletion(provider, request));
    } catch (error) {
      return facadeErrorResponse(error);
    }
  });
}

/**
 * Resolves dynamic facade options.
 *
 * @param options Static options or provider function.
 * @returns Current facade options.
 */
function resolveFacadeOptions(
  options: OpenAICompatFacadeOptions | (() => OpenAICompatFacadeOptions)
): OpenAICompatFacadeOptions {
  return typeof options === 'function' ? options() : options;
}

/**
 * Resolves a dynamic provider registry.
 *
 * @param registry Static provider registry or provider function.
 * @returns Current provider registry.
 */
function resolveProviderRegistry(
  registry: ProviderRegistry | (() => ProviderRegistry)
): ProviderRegistry {
  return typeof registry === 'function' ? registry() : registry;
}

/**
 * Creates an upstream request body with normalized model and stream fields.
 *
 * @param input Parsed internal request payload.
 * @param model Resolved model name.
 * @returns OpenAI-compatible upstream request.
 */
function createUpstreamRequest(
  input: z.infer<typeof InternalChatCompletionRequestSchema>,
  model: string
): OpenAICompatibleChatCompletionRequest {
  return {
    ...input,
    messages: input.messages.map((message) => {
      const mapped: OpenAICompatibleChatMessage = {
        content: message.content,
        role: message.role,
      };

      if (message.tool_call_id) {
        return { ...mapped, tool_call_id: message.tool_call_id };
      }

      return mapped;
    }),
    model,
    stream: input.stream ?? false,
  };
}

/**
 * Selects the configured direct or custom provider profile.
 *
 * @param registry Provider registry to search.
 * @param defaultProviderId Optional configured provider id.
 * @returns Selected provider profile.
 * @throws FacadeConfigError when no usable provider is configured.
 */
function selectProvider(registry: ProviderRegistry, defaultProviderId?: string): ProviderProfile {
  const profile = defaultProviderId
    ? registry.get(defaultProviderId)
    : registry.list().find((candidate) => isFacadeProvider(candidate));

  if (!profile || !isFacadeProvider(profile) || !profile.baseUrl) {
    throw new FacadeConfigError(
      'internal_provider_not_configured',
      'Internal facade requires a direct or custom provider with baseUrl.'
    );
  }

  return profile;
}

/**
 * Checks whether a provider profile can back the internal facade.
 *
 * @param profile Provider profile.
 * @returns True when the profile kind is direct or custom.
 */
function isFacadeProvider(profile: ProviderProfile): boolean {
  return profile.kind === 'direct' || profile.kind === 'custom';
}

/**
 * Error used for local facade configuration failures.
 */
class FacadeConfigError extends Error {
  /** OpenAI-compatible error code. */
  public readonly code: string;

  /**
   * Creates a facade config error.
   *
   * @param code Stable OpenAI-compatible error code.
   * @param message Human-readable error message.
   */
  public constructor(code: string, message: string) {
    super(message);
    this.name = 'FacadeConfigError';
    this.code = code;
  }
}

/**
 * Converts facade errors into OpenAI-compatible JSON responses.
 *
 * @param error Unknown route error.
 * @returns OpenAI-compatible error response.
 */
function facadeErrorResponse(error: unknown): Response {
  if (error instanceof OpenAICompatibleProviderError) {
    return openAIError(error.code, error.message, error.status, error.type ?? 'provider_error');
  }

  if (error instanceof FacadeConfigError) {
    return openAIError(error.code, error.message);
  }

  return openAIError('internal_facade_request_failed', (error as Error).message);
}

/**
 * Builds an OpenAI-compatible error response.
 *
 * @param code Stable error code.
 * @param message Human-readable error message.
 * @param status HTTP status code.
 * @param type OpenAI-compatible error type.
 * @returns Error response.
 */
function openAIError(
  code: string,
  message: string,
  status = 400,
  type = 'invalid_request_error'
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        type,
      },
    },
    { status }
  );
}
