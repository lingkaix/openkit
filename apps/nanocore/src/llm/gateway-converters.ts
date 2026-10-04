import { isDeepStrictEqual } from 'node:util';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleChatMessage,
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { attachPiAiFailure } from './pi-ai-failure.js';

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
  assertChatBridgeRequest(request);
  for (const message of request.messages) {
    if (
      (message.role === 'system' || message.role === 'developer') &&
      Object.keys(message).some((key) => key !== 'role' && key !== 'content')
    ) {
      throw new GatewayUnsupportedFeatureError('chat instruction fields');
    }
  }
  const pendingCalls = new Set<string>();
  const instructions = request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => textFromChatContent(message.content, message.role))
    .filter((content) => content.length > 0)
    .join('\n\n');
  const input = request.messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .flatMap((message) => chatMessageToResponsesInput(message, pendingCalls));
  const output: Record<string, unknown> = {
    ...copySelectedFields(request, [
      'metadata',
      'store',
      'parallel_tool_calls',
      'prompt_cache_key',
      'prompt_cache_retention',
      'temperature',
      'top_p',
    ]),
    model: request.model,
    input,
    stream: request.stream ?? false,
  };
  const maxOutputTokens =
    request.max_completion_tokens ?? request.max_output_tokens ?? request.max_tokens;

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
  if (request.tool_choice !== undefined) {
    output.tool_choice = chatToolChoiceToResponses(request.tool_choice);
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
 * Converts bounded Responses text and function output without inventing successful terminals.
 *
 * @param response Responses API response.
 * @param model Fallback model name for providers that omit model in the response.
 * @returns Chat Completions response.
 */
export function convertResponsesResponseToChatCompletionResponse(
  response: OpenAICompatibleResponsesResponse,
  model: string
): OpenAICompatibleChatCompletionResponse {
  assertResponsesTerminal(response);
  const { content, toolCalls } = responsesOutputToChat(response);

  return {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model: response.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || (toolCalls.length ? null : ''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          response.status === 'incomplete' ? 'length' : toolCalls.length ? 'tool_calls' : 'stop',
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
 * Converts Responses text and function SSE events, preserving terminal and usage semantics.
 *
 * @param stream Responses SSE stream.
 * @param model Fallback model name for emitted chat chunks.
 * @returns Chat Completions SSE stream.
 */
export function convertResponsesStreamToChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  return convertSseStream(stream, responsesSseEventToChat(model));
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

/** Rejects semantic fields the bounded native bridge cannot represent before dispatch. */
function assertChatBridgeRequest(request: OpenAICompatibleChatCompletionRequest): void {
  const supported = new Set([
    'model',
    'store',
    'messages',
    'stream',
    'metadata',
    'parallel_tool_calls',
    'prompt_cache_key',
    'prompt_cache_retention',
    'temperature',
    'tool_choice',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
    'reasoning',
    'reasoning_effort',
    'tools',
    'stream_options',
  ]);
  for (const [field, value] of Object.entries(request)) {
    if (value !== undefined && !supported.has(field))
      throw new GatewayUnsupportedFeatureError(`chat ${field}`);
  }
  if (request.stream_options !== undefined) {
    const options = readRecord(request.stream_options);
    if (
      Object.keys(options).some((key) => key !== 'include_usage') ||
      typeof options.include_usage !== 'boolean'
    ) {
      throw new GatewayUnsupportedFeatureError('chat stream_options');
    }
  }
}

/** Projects only the standard simple function choice, never a custom or built-in tool. */
function chatToolChoiceToResponses(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  const record = readRecord(choice);
  const fn = readRecord(record.function);
  if (
    record.type !== 'function' ||
    typeof fn.name !== 'string' ||
    !fn.name ||
    Object.keys(record).some((key) => key !== 'type' && key !== 'function') ||
    Object.keys(fn).some((key) => key !== 'name')
  ) {
    throw new GatewayUnsupportedFeatureError('chat tool_choice');
  }
  return { type: 'function', name: fn.name };
}

/** Expands assistant history in order and consumes each correlated text tool result once. */
function chatMessageToResponsesInput(
  message: OpenAICompatibleChatMessage,
  pendingCalls: Set<string>
): Record<string, unknown>[] {
  const record = message as unknown as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(key)
    )
  ) {
    throw new GatewayUnsupportedFeatureError('chat message fields');
  }
  if (message.role === 'tool') {
    if (
      !message.tool_call_id ||
      !pendingCalls.delete(message.tool_call_id) ||
      record.tool_calls !== undefined
    ) {
      throw new GatewayUnsupportedFeatureError('chat unmatched tool result');
    }
    return [
      {
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textFromChatContent(message.content, 'tool'),
      },
    ];
  }
  if (!['user', 'assistant'].includes(message.role) || message.tool_call_id !== undefined) {
    throw new GatewayUnsupportedFeatureError('chat input role');
  }
  const content = textFromChatContent(message.content, message.role);
  const items: Record<string, unknown>[] = [];
  if (content || record.tool_calls === undefined)
    items.push({
      role: message.role,
      content: [
        { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: content },
      ],
    });
  if (record.tool_calls !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(record.tool_calls))
      throw new GatewayUnsupportedFeatureError('chat tool calls');
    for (const value of record.tool_calls) {
      const call = readRecord(value);
      const fn = readRecord(call.function);
      if (
        call.type !== 'function' ||
        typeof call.id !== 'string' ||
        !call.id ||
        typeof fn.name !== 'string' ||
        !fn.name ||
        typeof fn.arguments !== 'string' ||
        Object.keys(call).some((key) => !['id', 'type', 'function'].includes(key)) ||
        Object.keys(fn).some((key) => !['name', 'arguments'].includes(key)) ||
        pendingCalls.has(call.id)
      ) {
        throw new GatewayUnsupportedFeatureError('chat function call');
      }
      pendingCalls.add(call.id);
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: fn.name,
        arguments: fn.arguments,
      });
    }
  }
  return items;
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

  if (!Array.isArray(content)) throw new GatewayUnsupportedFeatureError(`${role} non-text content`);
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

    if (
      !fn.name ||
      Object.keys(record).some((key) => key !== 'type' && key !== 'function') ||
      Object.keys(fn).some(
        (key) => !['name', 'description', 'parameters', 'strict'].includes(key)
      ) ||
      (fn.strict !== undefined && typeof fn.strict !== 'boolean')
    ) {
      throw new GatewayUnsupportedFeatureError('chat function tool fields');
    }
    return {
      type: 'function',
      name: fn.name,
      ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
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

/** A native unsuccessful terminal is an error, with no upstream body in the public cause. */
function assertResponsesTerminal(response: OpenAICompatibleResponsesResponse): void {
  if (
    response.error ||
    (response.status !== undefined &&
      response.status !== 'completed' &&
      !(
        response.status === 'incomplete' &&
        readRecord(response.incomplete_details).reason === 'max_output_tokens'
      ))
  ) {
    throw attachPiAiFailure(
      new Error('Provider request failed.'),
      response.error ??
        (response.status === 'incomplete'
          ? { code: readRecord(response.incomplete_details).reason }
          : response)
    );
  }
}

/** Preserves complete bounded text/function items and rejects unsupported response semantics. */
function responsesOutputToChat(response: OpenAICompatibleResponsesResponse): {
  content: string;
  toolCalls: Record<string, unknown>[];
} {
  let content = '';
  const toolCalls: Record<string, unknown>[] = [];
  const callIds = new Set<string>();
  for (const item of response.output ?? []) {
    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.arguments !== 'string' ||
        (item.namespace !== undefined && item.namespace !== '' && item.namespace !== 'functions')
      ) {
        throw new GatewayUnsupportedFeatureError('responses function identity');
      }
      if (callIds.has(item.call_id))
        throw new GatewayUnsupportedFeatureError('responses duplicate function call');
      callIds.add(item.call_id);
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === 'message') {
      content += textFromResponsesContent(item.content);
    } else {
      throw new GatewayUnsupportedFeatureError('responses output item');
    }
  }
  return { content, toolCalls };
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

/**
 * Converts complete SSE events, continuing through filtered or partial chunks until output is ready.
 * Preserves native stream backpressure and cancellation.
 *
 * @param stream Provider SSE byte stream.
 * @param convertEvent Endpoint-specific event converter.
 * @returns Converted SSE byte stream.
 */
function convertSseStream(
  stream: ReadableStream<Uint8Array>,
  convertEvent: (event: string) => string[]
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const reader = stream.getReader();
  let cancelled = false;
  let readerReleased = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!cancelled) {
          const result = await reader.read();

          if (result.done) {
            if (!cancelled && buffer.trim()) {
              for (const converted of convertEvent(buffer)) {
                controller.enqueue(encoder.encode(`${converted}\n\n`));
              }
            }
            if (!readerReleased) {
              readerReleased = true;
              reader.releaseLock();
            }
            if (!cancelled) {
              controller.close();
            }
            return;
          }

          buffer += decoder.decode(result.value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? '';

          let emitted = false;
          for (const event of events) {
            for (const converted of convertEvent(event)) {
              controller.enqueue(encoder.encode(`${converted}\n\n`));
              emitted = true;
            }
          }
          if (emitted) return;
        }
      } catch (error) {
        if (!readerReleased) {
          try {
            await reader.cancel(error);
          } catch {
            // A read failure may already have errored the source; retain the deciding failure.
          } finally {
            readerReleased = true;
            reader.releaseLock();
          }
        }
        if (!cancelled) {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        if (!readerReleased) {
          readerReleased = true;
          reader.releaseLock();
        }
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

/** Builds one request-local stream projection; completed snapshots reconcile rather than repeat deltas. */
function responsesSseEventToChat(model: string): (event: string) => string[] {
  let responseId = 'chatcmpl_bridge';
  let created = Math.floor(Date.now() / 1000);
  let terminal = false;
  let text = '';
  const textParts = new Map<string, string>();
  const calls = new Map<
    number,
    {
      index: number;
      itemId?: string;
      id?: string;
      name?: string;
      arguments: string;
      emitted: string;
      announced: boolean;
    }
  >();

  const emit = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: unknown
  ) =>
    `data: ${JSON.stringify({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage: normalizeResponsesUsageForChat(usage) } : {}),
    })}`;

  const textEvent = (chunk: Record<string, unknown>, snapshot?: unknown): string[] => {
    const key = `${chunk.output_index ?? 0}:${chunk.content_index ?? 0}`;
    const prior = textParts.get(key) ?? '';
    if (snapshot === undefined && typeof chunk.delta !== 'string')
      throw new GatewayUnsupportedFeatureError('responses text content');
    const value = snapshot === undefined ? prior + chunk.delta : snapshot;
    if (typeof value !== 'string' || !value.startsWith(prior))
      throw new GatewayUnsupportedFeatureError('responses text snapshot');
    textParts.set(key, value);
    const delta = value.slice(prior.length);
    text += delta;
    return delta ? [emit({ content: delta })] : [];
  };

  // The existing Gateway publisher owns the public envelope; retain private failure classification.
  const fail = (source: unknown): never => {
    terminal = true;
    throw attachPiAiFailure(new Error('Provider request failed.'), source);
  };

  const callEvent = (chunk: Record<string, unknown>, item?: Record<string, unknown>): string[] => {
    const position = chunk.output_index;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
      throw new GatewayUnsupportedFeatureError('responses function output index');
    }
    let call = calls.get(position);
    if (!call) {
      call = { index: calls.size, arguments: '', emitted: '', announced: false };
      calls.set(position, call);
    }
    const itemId = item?.id ?? chunk.item_id;
    if (typeof itemId === 'string') {
      if (call.itemId && call.itemId !== itemId)
        throw new GatewayUnsupportedFeatureError('responses function item identity');
      call.itemId = itemId;
    }
    if (item) {
      if (item.namespace !== undefined && item.namespace !== '' && item.namespace !== 'functions')
        throw new GatewayUnsupportedFeatureError('responses function namespace');
      for (const [field, value] of [
        ['id', item.call_id],
        ['name', item.name],
      ] as const) {
        if (value !== undefined) {
          if (typeof value !== 'string' || !value || (call[field] && call[field] !== value))
            throw new GatewayUnsupportedFeatureError('responses function identity');
          if (
            field === 'id' &&
            [...calls.values()].some((other) => other !== call && other.id === value)
          ) {
            throw new GatewayUnsupportedFeatureError('responses duplicate function call');
          }
          call[field] = value;
        }
      }
    }
    const snapshot = item?.arguments ?? chunk.arguments;
    if (typeof chunk.delta === 'string') call.arguments += chunk.delta;
    else if (snapshot !== undefined) {
      if (typeof snapshot !== 'string')
        throw new GatewayUnsupportedFeatureError('responses function arguments');
      if (snapshot.startsWith(call.arguments)) call.arguments = snapshot;
      else {
        // pi-ai reserializes completed JSON. Equivalent snapshots keep raw deltas, never replay them.
        let equivalent = false;
        try {
          equivalent = isDeepStrictEqual(JSON.parse(call.arguments), JSON.parse(snapshot));
        } catch {
          // Partial or malformed JSON cannot prove that a differently serialized snapshot agrees.
        }
        if (!equivalent) throw new GatewayUnsupportedFeatureError('responses function arguments');
      }
    }
    if (!call.id || !call.name) return [];
    const delta: Record<string, unknown> = {
      index: call.index,
      function: {
        arguments: call.arguments.slice(call.emitted.length),
        ...(!call.announced ? { name: call.name } : {}),
      },
    };
    if (!call.announced) Object.assign(delta, { id: call.id, type: 'function' });
    if (call.announced && call.emitted === call.arguments) return [];
    call.announced = true;
    call.emitted = call.arguments;
    return [emit({ tool_calls: [delta] })];
  };

  return (event) => {
    const payload = dataPayloadFromSseEvent(event);
    if (!payload || terminal) return [];
    // EOF or a transport sentinel is not native successful terminal evidence.
    if (payload === '[DONE]') return [];
    const chunk = JSON.parse(payload) as Record<string, unknown>;
    const response = readRecord(chunk.response);
    if (typeof response.id === 'string') responseId = response.id;
    else if (typeof chunk.response_id === 'string') responseId = chunk.response_id;
    if (typeof response.created_at === 'number') created = response.created_at;
    if (
      chunk.error ||
      chunk.type === 'error' ||
      chunk.type === 'response.failed' ||
      response.status === 'failed'
    )
      return fail(response.error ?? chunk.error ?? chunk);
    if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
      return textEvent(chunk);
    }
    if (chunk.type === 'response.output_text.done') return textEvent(chunk, chunk.text);
    if (
      chunk.type === 'response.function_call_arguments.delta' ||
      chunk.type === 'response.function_call_arguments.done'
    )
      return callEvent(chunk);
    if (chunk.type === 'response.output_item.added' || chunk.type === 'response.output_item.done') {
      const item = readRecord(chunk.item);
      if (item.type === 'function_call') return callEvent(chunk, item);
      if (item.type !== 'message')
        throw new GatewayUnsupportedFeatureError('responses output item');
      if (item.content !== undefined) textFromResponsesContent(item.content);
      if (chunk.type === 'response.output_item.done' && Array.isArray(item.content)) {
        return item.content.flatMap((part, content_index) =>
          textEvent({ ...chunk, content_index }, readRecord(part).text)
        );
      }
      return [];
    }
    if (
      chunk.type === 'response.content_part.added' ||
      chunk.type === 'response.content_part.done'
    ) {
      textFromResponsesContent([chunk.part]);
      return chunk.type === 'response.content_part.done'
        ? textEvent(chunk, readRecord(chunk.part).text)
        : [];
    }
    if (chunk.type === 'response.completed' || chunk.type === 'response.incomplete') {
      if (
        response.error ||
        (response.status !== undefined &&
          !['completed', 'incomplete'].includes(String(response.status)))
      )
        return fail(response.error ?? response);
      const incomplete = chunk.type === 'response.incomplete' || response.status === 'incomplete';
      if (incomplete && readRecord(response.incomplete_details).reason !== 'max_output_tokens')
        return fail({ code: readRecord(response.incomplete_details).reason });
      const frames: string[] = [];
      if (Array.isArray(response.output)) {
        const complete = responsesOutputToChat(
          response as unknown as OpenAICompatibleResponsesResponse
        );
        if (!complete.content.startsWith(text))
          throw new GatewayUnsupportedFeatureError('responses text snapshot');
        if (complete.content.length > text.length)
          frames.push(emit({ content: complete.content.slice(text.length) }));
        for (const [output_index, value] of response.output.entries()) {
          const item = readRecord(value);
          if (item.type === 'function_call') frames.push(...callEvent({ output_index }, item));
        }
        if (complete.toolCalls.length !== calls.size)
          throw new GatewayUnsupportedFeatureError('responses function snapshot');
      }
      if ([...calls.values()].some((call) => !call.announced))
        throw new GatewayUnsupportedFeatureError('responses incomplete function identity');
      terminal = true;
      frames.push(
        emit({}, incomplete ? 'length' : calls.size ? 'tool_calls' : 'stop', response.usage),
        'data: [DONE]'
      );
      return frames;
    }
    if (
      typeof chunk.type === 'string' &&
      !['response.created', 'response.in_progress', 'response.queued'].includes(chunk.type)
    )
      throw new GatewayUnsupportedFeatureError('responses stream event');
    return [];
  };
}
