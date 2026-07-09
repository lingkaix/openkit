import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleChatMessage,
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';

/**
 * Error thrown when a gateway bridge cannot preserve requested semantics.
 */
export class GatewayUnsupportedFeatureError extends Error {
  /** OpenAI-compatible error code returned by gateway routes. */
  public readonly code = 'unsupported_gateway_feature';
  /** HTTP status for unsupported gateway features. */
  public readonly status = 400;
  /** Feature name that cannot be bridged. */
  public readonly feature: string;

  /**
   * Creates one unsupported-feature error.
   *
   * @param feature Feature name or short bridge context.
   */
  public constructor(feature: string) {
    super(`Gateway bridge does not support this feature: ${feature}`);
    this.name = 'GatewayUnsupportedFeatureError';
    this.feature = feature;
  }
}

/**
 * Converts Chat Completions requests to Responses requests.
 *
 * @param request Chat Completions-shaped request.
 * @returns Responses-shaped request.
 */
export function convertChatCompletionToResponsesRequest(
  request: OpenAICompatibleChatCompletionRequest
): OpenAICompatibleResponsesRequest {
  const instructions = request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => textFromChatContent(message.content, message.role))
    .filter((content) => content.length > 0)
    .join('\n\n');
  const input = request.messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .map((message) => chatMessageToResponsesInput(message));
  const output: Record<string, unknown> = {
    ...copySelectedFields(request, [
      'metadata',
      'parallel_tool_calls',
      'prompt_cache_key',
      'prompt_cache_retention',
      'temperature',
      'tool_choice',
      'top_p',
    ]),
    model: request.model,
    input,
    stream: request.stream ?? false,
  };
  const maxOutputTokens = request.max_output_tokens ?? request.max_tokens;

  if (instructions) {
    output.instructions = instructions;
  }
  if (typeof maxOutputTokens === 'number') {
    output.max_output_tokens = maxOutputTokens;
  }
  if (typeof request.reasoning === 'object' && request.reasoning !== null) {
    output.reasoning = request.reasoning;
  } else if (typeof request.reasoning_effort === 'string') {
    output.reasoning = { effort: request.reasoning_effort };
  }
  if (Array.isArray(request.tools)) {
    output.tools = convertChatToolsToResponsesTools(request.tools);
  }

  return output as OpenAICompatibleResponsesRequest;
}

/**
 * Converts Responses requests to Chat Completions requests.
 *
 * @param request Responses-shaped request.
 * @returns Chat Completions-shaped request.
 */
export function convertResponsesRequestToChatCompletionRequest(
  request: OpenAICompatibleResponsesRequest
): OpenAICompatibleChatCompletionRequest {
  const messages: OpenAICompatibleChatMessage[] = [];

  if (typeof request.instructions === 'string' && request.instructions.trim()) {
    messages.push({ role: 'system', content: request.instructions });
  }

  messages.push(...responsesInputToChatMessages(request.input));

  const output: Record<string, unknown> = {
    ...copySelectedFields(request, [
      'metadata',
      'prompt_cache_key',
      'prompt_cache_retention',
      'temperature',
      'tool_choice',
      'top_p',
    ]),
    model: request.model,
    messages,
    stream: request.stream ?? false,
  };

  if (typeof request.max_output_tokens === 'number') {
    output.max_tokens = request.max_output_tokens;
  }
  if (typeof request.reasoning === 'object' && request.reasoning !== null) {
    const reasoning = request.reasoning as Record<string, unknown>;
    if (typeof reasoning.effort === 'string') {
      output.reasoning_effort = reasoning.effort;
    }
  }
  if (Array.isArray(request.tools)) {
    output.tools = convertResponsesToolsToChatTools(request.tools);
  }

  return output as OpenAICompatibleChatCompletionRequest;
}

/**
 * Converts a Chat Completions response to a minimal Responses response.
 *
 * @param response Chat Completions response.
 * @returns Responses API response.
 */
export function convertChatCompletionResponseToResponsesResponse(
  response: OpenAICompatibleChatCompletionResponse
): OpenAICompatibleResponsesResponse {
  const content = response.choices[0]?.message.content ?? '';

  return {
    id: response.id,
    object: 'response',
    created_at: response.created,
    status: response.choices[0]?.finish_reason === 'length' ? 'incomplete' : 'completed',
    model: response.model,
    output: [
      {
        id: `${response.id}_message_0`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: content }],
      },
    ],
    ...(response.usage ? { usage: normalizeChatUsageForResponses(response.usage) } : {}),
  };
}

/**
 * Converts a Responses response to a minimal Chat Completions response.
 *
 * @param response Responses API response.
 * @param model Fallback model name for providers that omit model in the response.
 * @returns Chat Completions response.
 */
export function convertResponsesResponseToChatCompletionResponse(
  response: OpenAICompatibleResponsesResponse,
  model: string
): OpenAICompatibleChatCompletionResponse {
  const content = extractResponsesOutputText(response);

  return {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model: response.model ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: response.status === 'incomplete' ? 'length' : 'stop',
      },
    ],
    ...(response.usage ? { usage: normalizeResponsesUsageForChat(response.usage) } : {}),
  };
}

/**
 * Converts text-only Chat Completions SSE chunks to Responses SSE chunks.
 *
 * @param stream Chat Completions SSE stream.
 * @returns Responses SSE stream.
 */
export function convertChatCompletionStreamToResponsesStream(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  return convertSseStream(stream, (event) => chatSseEventToResponses(event));
}

/**
 * Converts text-only Responses SSE chunks to Chat Completions SSE chunks.
 *
 * @param stream Responses SSE stream.
 * @param model Fallback model name for emitted chat chunks.
 * @returns Chat Completions SSE stream.
 */
export function convertResponsesStreamToChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  return convertSseStream(stream, (event) => responsesSseEventToChat(event, model));
}

function copySelectedFields(
  request: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};

  for (const field of fields) {
    if (request[field] !== undefined) {
      selected[field] = request[field];
    }
  }

  return selected;
}

function chatMessageToResponsesInput(
  message: OpenAICompatibleChatMessage
): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: [{ type: 'input_text', text: textFromChatContent(message.content, 'tool') }],
    };
  }

  const type = message.role === 'assistant' ? 'output_text' : 'input_text';

  return {
    role: message.role,
    content: [{ type, text: textFromChatContent(message.content, message.role) }],
  };
}

function textFromChatContent(
  content: OpenAICompatibleChatMessage['content'],
  role: OpenAICompatibleChatMessage['role']
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === null) {
    return '';
  }

  const textParts = content.map((part) => {
    if (typeof part !== 'object' || part === null) {
      throw new GatewayUnsupportedFeatureError(`${role} non-text content`);
    }

    const item = part as Record<string, unknown>;
    const type = item.type;
    if (
      (type === 'text' || type === 'input_text' || type === 'output_text') &&
      typeof item.text === 'string'
    ) {
      return item.text;
    }

    throw new GatewayUnsupportedFeatureError(`${role} non-text content`);
  });

  return textParts.join('');
}

function responsesInputToChatMessages(input: OpenAICompatibleResponsesRequest['input']) {
  if (typeof input === 'string') {
    return [{ role: 'user' as const, content: input }];
  }

  return input.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new GatewayUnsupportedFeatureError('responses non-object input item');
    }

    const record = item as Record<string, unknown>;
    const role = normalizeChatRole(record.role);

    return {
      role,
      content: textFromResponsesContent(record.content),
    };
  });
}

function normalizeChatRole(role: unknown): OpenAICompatibleChatMessage['role'] {
  if (role === 'system' || role === 'developer' || role === 'user' || role === 'assistant') {
    return role;
  }

  throw new GatewayUnsupportedFeatureError('responses input role');
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new GatewayUnsupportedFeatureError('responses non-text content');
  }

  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) {
        throw new GatewayUnsupportedFeatureError('responses non-text content');
      }

      const item = part as Record<string, unknown>;
      const type = item.type;

      if (
        (type === 'input_text' || type === 'output_text' || type === 'text') &&
        typeof item.text === 'string'
      ) {
        return item.text;
      }

      throw new GatewayUnsupportedFeatureError('responses non-text content');
    })
    .join('');
}

function convertChatToolsToResponsesTools(tools: readonly unknown[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) {
      throw new GatewayUnsupportedFeatureError('chat tool');
    }

    const record = tool as Record<string, unknown>;
    if (record.type !== 'function' || typeof record.function !== 'object' || !record.function) {
      throw new GatewayUnsupportedFeatureError('chat tool');
    }

    const fn = record.function as Record<string, unknown>;
    if (typeof fn.name !== 'string') {
      throw new GatewayUnsupportedFeatureError('chat function tool');
    }

    return {
      type: 'function',
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
    };
  });
}

function convertResponsesToolsToChatTools(tools: readonly unknown[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) {
      throw new GatewayUnsupportedFeatureError('responses tool');
    }

    const record = tool as Record<string, unknown>;
    if (record.type !== 'function') {
      throw new GatewayUnsupportedFeatureError(String(record.type ?? 'responses tool'));
    }
    if (typeof record.name !== 'string') {
      throw new GatewayUnsupportedFeatureError('responses function tool');
    }

    return {
      type: 'function',
      function: {
        name: record.name,
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
        ...(record.parameters !== undefined ? { parameters: record.parameters } : {}),
      },
    };
  });
}

function extractResponsesOutputText(response: OpenAICompatibleResponsesResponse): string {
  return (response.output ?? [])
    .flatMap((item) => {
      const content = item.content;

      if (!Array.isArray(content)) {
        return [];
      }

      return content.flatMap((part) => {
        if (typeof part !== 'object' || part === null) {
          return [];
        }

        const record = part as Record<string, unknown>;

        return typeof record.text === 'string' ? [record.text] : [];
      });
    })
    .join('');
}

function normalizeChatUsageForResponses(usage: unknown): unknown {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return usage;
  }

  const record = usage as Record<string, unknown>;
  const inputTokens = readNumber(record.prompt_tokens);
  const outputTokens = readNumber(record.completion_tokens);
  const cachedTokens = readCachedTokens(record);
  const output: Record<string, unknown> = { ...record };

  if (output.input_tokens === undefined && inputTokens !== undefined) {
    output.input_tokens = inputTokens;
  }
  if (output.output_tokens === undefined && outputTokens !== undefined) {
    output.output_tokens = outputTokens;
  }
  if (cachedTokens !== undefined) {
    output.input_tokens_details = {
      ...readRecord(output.input_tokens_details),
      cached_tokens: cachedTokens,
    };
  }

  return output;
}

function normalizeResponsesUsageForChat(usage: unknown): unknown {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return usage;
  }

  const record = usage as Record<string, unknown>;
  const promptTokens = readNumber(record.input_tokens);
  const completionTokens = readNumber(record.output_tokens);
  const cachedTokens = readCachedTokens(record);
  const output: Record<string, unknown> = { ...record };

  if (output.prompt_tokens === undefined && promptTokens !== undefined) {
    output.prompt_tokens = promptTokens;
  }
  if (output.completion_tokens === undefined && completionTokens !== undefined) {
    output.completion_tokens = completionTokens;
  }
  if (cachedTokens !== undefined) {
    output.prompt_tokens_details = {
      ...readRecord(output.prompt_tokens_details),
      cached_tokens: cachedTokens,
    };
  }

  return output;
}

function readCachedTokens(record: Record<string, unknown>): number | undefined {
  const promptDetails = readRecord(record.prompt_tokens_details);
  const inputDetails = readRecord(record.input_tokens_details);

  return (
    readNumber(promptDetails.cached_tokens) ??
    readNumber(inputDetails.cached_tokens) ??
    readNumber(record.cached_tokens)
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function convertSseStream(
  stream: ReadableStream<Uint8Array>,
  convertEvent: (event: string) => string[]
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();

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
            for (const converted of convertEvent(event)) {
              controller.enqueue(encoder.encode(`${converted}\n\n`));
            }
          }
        }

        if (buffer.trim()) {
          for (const converted of convertEvent(buffer)) {
            controller.enqueue(encoder.encode(`${converted}\n\n`));
          }
        }
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

function dataPayloadFromSseEvent(event: string): string | null {
  const line = event
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('data:'));

  return line ? line.slice('data:'.length).trim() : null;
}

function chatSseEventToResponses(event: string): string[] {
  const payload = dataPayloadFromSseEvent(event);

  if (!payload) {
    return [];
  }
  if (payload === '[DONE]') {
    return ['data: {"type":"response.completed"}', 'data: [DONE]'];
  }

  const chunk = JSON.parse(payload) as Record<string, unknown>;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const delta = first?.delta as Record<string, unknown> | undefined;

  if (typeof delta?.content === 'string') {
    return [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: delta.content })}`,
    ];
  }
  if (first?.finish_reason) {
    return ['data: {"type":"response.completed"}'];
  }

  return [];
}

function responsesSseEventToChat(event: string, model: string): string[] {
  const payload = dataPayloadFromSseEvent(event);

  if (!payload) {
    return [];
  }
  if (payload === '[DONE]') {
    return ['data: [DONE]'];
  }

  const chunk = JSON.parse(payload) as Record<string, unknown>;
  if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
    return [
      `data: ${JSON.stringify({
        id: typeof chunk.response_id === 'string' ? chunk.response_id : 'chatcmpl_bridge',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
      })}`,
    ];
  }
  if (chunk.type === 'response.completed') {
    return [
      `data: ${JSON.stringify({
        id: 'chatcmpl_bridge',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}`,
      'data: [DONE]',
    ];
  }

  return [];
}
