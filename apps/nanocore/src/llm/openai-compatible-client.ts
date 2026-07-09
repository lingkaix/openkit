import type { ResolvedLLMProviderConfig } from './provider-config.js';

/**
 * OpenAI-compatible chat message.
 */
export interface OpenAICompatibleChatMessage {
  /** Message role. */
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  /** Message content as text or provider-compatible structured content. */
  readonly content: string | unknown[] | null;
  /** Optional tool-call identifier for tool result messages. */
  readonly tool_call_id?: string;
}

/**
 * OpenAI-compatible chat completion request.
 */
export interface OpenAICompatibleChatCompletionRequest {
  /** Model name passed to the upstream provider. */
  readonly model: string;
  /** Ordered chat messages. */
  readonly messages: readonly OpenAICompatibleChatMessage[];
  /** Whether the upstream provider should stream SSE chunks. */
  readonly stream?: boolean;
  /** Additional OpenAI-compatible request fields. */
  readonly [key: string]: unknown;
}

/**
 * OpenAI-compatible chat completion response.
 */
export interface OpenAICompatibleChatCompletionResponse {
  /** Provider response ID. */
  readonly id: string;
  /** Provider response object type. */
  readonly object: string;
  /** Unix timestamp from the provider. */
  readonly created: number;
  /** Model name returned by the provider. */
  readonly model: string;
  /** Completion choices returned by the provider. */
  readonly choices: readonly {
    readonly index: number;
    readonly message: {
      readonly role: string;
      readonly content: string | null;
      readonly [key: string]: unknown;
    };
    readonly finish_reason: string | null;
  }[];
  /** Optional provider usage payload. */
  readonly usage?: unknown;
}

/**
 * OpenAI-compatible model list response.
 */
export interface OpenAICompatibleModelListResponse {
  /** Provider model objects. */
  readonly data: readonly Record<string, unknown>[];
  /** Response object type. */
  readonly object?: string;
}

/**
 * OpenAI-compatible Responses request.
 */
export interface OpenAICompatibleResponsesRequest {
  /** Model name passed to the upstream provider. */
  readonly model: string;
  /** Responses input text or item array. */
  readonly input: string | readonly unknown[];
  /** Whether the upstream provider should stream SSE chunks. */
  readonly stream?: boolean;
  /** Additional OpenAI-compatible Responses request fields. */
  readonly [key: string]: unknown;
}

/**
 * OpenAI-compatible Responses API response.
 */
export interface OpenAICompatibleResponsesResponse {
  /** Provider response ID. */
  readonly id: string;
  /** Provider response object type. */
  readonly object: string;
  /** Response lifecycle status when provided by the provider. */
  readonly status?: string;
  /** Model name returned by the provider. */
  readonly model?: string;
  /** Unix timestamp from the provider. */
  readonly created_at?: number;
  /** Responses output items. */
  readonly output?: readonly Record<string, unknown>[];
  /** Optional provider usage payload. */
  readonly usage?: unknown;
  /** Additional provider response fields. */
  readonly [key: string]: unknown;
}

/**
 * Error thrown when an upstream OpenAI-compatible provider fails.
 */
export class OpenAICompatibleProviderError extends Error {
  /** Upstream HTTP status code. */
  public readonly status: number;
  /** Provider error code when available. */
  public readonly code: string;
  /** Provider error type when available. */
  public readonly type: string | null;

  /**
   * Create a provider error from normalized upstream details.
   *
   * @param input Error details extracted from the upstream response.
   */
  public constructor(input: {
    message: string;
    status: number;
    code?: string;
    type?: string | null;
  }) {
    super(input.message);
    this.name = 'OpenAICompatibleProviderError';
    this.status = input.status;
    this.code = input.code ?? 'provider_error';
    this.type = input.type ?? null;
  }
}

/**
 * Construction options for the OpenAI-compatible client.
 */
export interface OpenAICompatibleChatClientOptions {
  /** Fetch implementation used for HTTP calls. */
  readonly fetch?: typeof fetch;
}

/**
 * Small OpenAI-compatible HTTP client shared by providers, quick chat, and gateway routes.
 */
export class OpenAICompatibleChatClient {
  private readonly fetchImpl: typeof fetch;

  /**
   * Create a reusable OpenAI-compatible chat client.
   *
   * @param options Optional fetch override for tests or custom transports.
   */
  public constructor(options: OpenAICompatibleChatClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * List models from a configured provider.
   *
   * @param provider Secret-bearing provider config.
   * @returns OpenAI-compatible model list response.
   */
  public async listModels(
    provider: ResolvedLLMProviderConfig
  ): Promise<OpenAICompatibleModelListResponse> {
    const response = await this.fetchImpl(this.createRequest(provider, 'models'));
    return this.readJsonResponse<OpenAICompatibleModelListResponse>(response);
  }

  /**
   * Create a non-streaming chat completion through a configured provider.
   *
   * @param provider Secret-bearing provider config.
   * @param request OpenAI-compatible chat completion request.
   * @returns OpenAI-compatible chat completion response.
   */
  public async createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    const body = {
      ...provider.extraBody,
      ...request,
      stream: false,
    };
    const response = await this.fetchImpl(this.createRequest(provider, 'chat/completions', body));
    return this.readJsonResponse<OpenAICompatibleChatCompletionResponse>(response);
  }

  /**
   * Create a streaming chat completion through a configured provider.
   *
   * @param provider Secret-bearing provider config.
   * @param request OpenAI-compatible chat completion request.
   * @returns Upstream SSE response body stream.
   */
  public async createChatCompletionStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest
  ): Promise<ReadableStream<Uint8Array>> {
    const body = {
      ...provider.extraBody,
      ...request,
      stream: true,
    };
    const response = await this.fetchImpl(this.createRequest(provider, 'chat/completions', body));

    if (!response.ok) {
      await this.readJsonResponse(response);
    }

    if (!response.body) {
      throw new Error('OpenAI-compatible provider returned an empty stream.');
    }

    return response.body;
  }

  /**
   * Create a non-streaming Responses API request through a configured provider.
   *
   * @param provider Secret-bearing provider config.
   * @param request OpenAI-compatible Responses request.
   * @returns OpenAI-compatible Responses response.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest
  ): Promise<OpenAICompatibleResponsesResponse> {
    const body = {
      ...provider.extraBody,
      ...request,
      stream: false,
    };
    const response = await this.fetchImpl(this.createRequest(provider, 'responses', body));
    return this.readJsonResponse<OpenAICompatibleResponsesResponse>(response);
  }

  /**
   * Create a streaming Responses API request through a configured provider.
   *
   * @param provider Secret-bearing provider config.
   * @param request OpenAI-compatible Responses request.
   * @returns Upstream SSE response body stream.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest
  ): Promise<ReadableStream<Uint8Array>> {
    const body = {
      ...provider.extraBody,
      ...request,
      stream: true,
    };
    const response = await this.fetchImpl(this.createRequest(provider, 'responses', body));

    if (!response.ok) {
      await this.readJsonResponse(response);
    }

    if (!response.body) {
      throw new Error('OpenAI-compatible provider returned an empty stream.');
    }

    return response.body;
  }

  private createRequest(
    provider: ResolvedLLMProviderConfig,
    path: string,
    body?: Record<string, unknown>
  ): Request {
    if (!provider.baseUrl) {
      throw new Error(`LLM provider has no base URL: ${provider.id}`);
    }

    const headers = new Headers({
      accept: 'application/json',
      ...provider.extraHeaders,
    });

    if (body) {
      headers.set('content-type', 'application/json');
    }

    if (provider.apiKey) {
      headers.set('authorization', `Bearer ${provider.apiKey}`);
    }

    const init: RequestInit = {
      method: body ? 'POST' : 'GET',
      headers,
    };

    if (body) {
      init.body = JSON.stringify(body);
    }

    return new Request(this.joinUrl(provider.baseUrl, path), init);
  }

  private joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private async readJsonResponse<T>(response: Response): Promise<T> {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      throw this.toProviderError(response, payload);
    }

    return payload as T;
  }

  private toProviderError(
    response: Response,
    payload: Record<string, unknown>
  ): OpenAICompatibleProviderError {
    const error = typeof payload.error === 'object' && payload.error ? payload.error : {};
    const detail = error as Record<string, unknown>;
    const message =
      typeof detail.message === 'string'
        ? detail.message
        : `OpenAI-compatible provider request failed with status ${response.status}.`;

    const input: { message: string; status: number; code?: string; type?: string | null } = {
      message,
      status: response.status,
      type: typeof detail.type === 'string' ? detail.type : null,
    };

    if (typeof detail.code === 'string') {
      input.code = detail.code;
    }

    return new OpenAICompatibleProviderError(input);
  }
}
