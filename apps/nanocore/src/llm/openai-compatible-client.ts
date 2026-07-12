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
