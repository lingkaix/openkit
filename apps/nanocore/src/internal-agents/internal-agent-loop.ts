import { Ajv2020 } from 'ajv/dist/2020.js';

import { redactInternalAgentText } from './redaction.js';

/** JSON Schema supplied to a model-visible internal Tool. */
export type JsonSchema = Record<string, unknown>;

/** Text or image content admitted to the internal Agent transcript. */
export type AgentContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** One correlated model-requested Tool call. */
export interface AgentToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** Assistant response retained by the bounded internal Agent run. */
export interface AgentAssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly (
    | { readonly type: 'text'; readonly text: string }
    | ({ readonly type: 'toolCall' } & AgentToolCall)
  )[];
  readonly truncated: boolean;
}

/** Private message union used only inside NanoCore internal Agent runs. */
export type AgentMessage =
  | { readonly role: 'user'; readonly content: readonly AgentContent[] }
  | AgentAssistantMessage
  | {
      readonly role: 'tool';
      readonly callId: string;
      readonly content: readonly AgentContent[];
      readonly isError: boolean;
    };

/** Server-side execution context for one admitted Tool call. */
export interface ToolExecutionContext {
  readonly callId: string;
  readonly signal: AbortSignal;
}

/** Server-side result from one internal Agent Tool closure. */
export interface AgentToolResult {
  readonly content: readonly AgentContent[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** Fixed model-visible Tool definition bound to one server-side closure. */
export interface AgentTool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  execute(input: TInput, context: ToolExecutionContext): Promise<AgentToolResult>;
}

/** Logical-model identity and effective capabilities pinned for one run. */
export interface InternalAgentLogicalModel {
  readonly logicalModelId: string;
  readonly capabilities: readonly string[];
  readonly modelFamilyId: string | null;
}

/** OpenKit-owned context policy pinned for one internal Agent run. */
export interface InternalAgentContextManagement {
  readonly type: 'compaction';
  readonly compactThreshold: number;
  readonly authority: 'openkit';
}

/** Complete trusted input to one bounded internal Agent run. */
export interface InternalAgentLoopInput {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentTool[];
  readonly model: InternalAgentLogicalModel;
  readonly contextManagement: InternalAgentContextManagement;
  readonly limits: {
    readonly maxModelTurns: number;
    readonly maxToolCalls: number;
    readonly deadlineMs: number;
  };
  readonly signal: AbortSignal;
  readonly onTextIncrement?: (text: string) => void;
}

/** Complete provider-facing definition without a server execution closure. */
export interface InternalAgentProviderTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** Gateway request for one provider round trip in a bounded internal Agent run. */
export interface InternalAgentProviderRequest {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly InternalAgentProviderTool[];
  readonly model: InternalAgentLogicalModel;
  readonly contextManagement: InternalAgentContextManagement;
  readonly signal: AbortSignal;
  readonly onTextIncrement?: (text: string) => void;
}

/** Gateway response after provider conversion and optional admitted compaction. */
export interface InternalAgentProviderResponse {
  readonly message: AgentAssistantMessage;
  readonly compactedMessages?: readonly AgentMessage[];
}

/** Injected Gateway projection used by the product-agnostic loop. */
export type InternalAgentProviderCall = (
  request: InternalAgentProviderRequest
) => Promise<InternalAgentProviderResponse>;

/** Product-safe typed failure returned by an admitted provider projection. */
export class InternalAgentProviderError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'InternalAgentProviderError';
  }
}

/** Closed terminal outcome of one bounded internal Agent run. */
export type InternalAgentLoopExit =
  | { readonly kind: 'quiescent'; readonly messages: readonly AgentMessage[] }
  | {
      readonly kind: 'limit_reached';
      readonly messages: readonly AgentMessage[];
      readonly limit: 'model_turns' | 'tool_calls' | 'deadline';
    }
  | { readonly kind: 'aborted'; readonly messages: readonly AgentMessage[] }
  | { readonly kind: 'failed'; readonly messages: readonly AgentMessage[]; readonly code: string };

/**
 * Runs one transient, role-agnostic internal Agent loop.
 *
 * @param input Fully assembled trusted role input and emergency fuses.
 * @param callProvider Existing Gateway projection for the pinned logical model.
 * @returns One typed terminal outcome without product-success interpretation.
 */
export async function runInternalAgentLoop(
  input: InternalAgentLoopInput,
  callProvider: InternalAgentProviderCall
): Promise<InternalAgentLoopExit> {
  let messages = Array.isArray(input.messages) ? [...input.messages] : [];
  const schemaValidator = new Ajv2020({ allErrors: false, strict: false });
  let validators: ReadonlyMap<string, ReturnType<typeof schemaValidator.compile>>;
  try {
    assertInput(input);
    validators = new Map(
      input.tools.map((tool) => [tool.name, schemaValidator.compile(tool.inputSchema)])
    );
  } catch {
    return { kind: 'failed', messages, code: 'internal_agent_input_invalid' };
  }

  const deadlineSignal = AbortSignal.timeout(input.limits.deadlineMs);
  const signal = AbortSignal.any([input.signal, deadlineSignal]);
  const providerTools = input.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const callIds = new Set<string>();
  let modelTurns = 0;
  let toolCalls = 0;

  const exitForCancellation = (): InternalAgentLoopExit | null => {
    if (input.signal.aborted) return { kind: 'aborted', messages };
    if (deadlineSignal.aborted) {
      return { kind: 'limit_reached', messages, limit: 'deadline' };
    }
    return null;
  };

  while (true) {
    const cancelled = exitForCancellation();
    if (cancelled) return cancelled;
    if (modelTurns >= input.limits.maxModelTurns) {
      return { kind: 'limit_reached', messages, limit: 'model_turns' };
    }

    let response: InternalAgentProviderResponse;
    try {
      response = await raceWithSignal(
        callProvider({
          systemPrompt: input.systemPrompt,
          messages: [...messages],
          tools: providerTools,
          model: input.model,
          contextManagement: input.contextManagement,
          signal,
          ...(input.onTextIncrement
            ? {
                onTextIncrement: (text: string) => {
                  if (signal.aborted) return;
                  try {
                    input.onTextIncrement?.(text);
                  } catch {
                    // Transport observation cannot affect runtime semantics.
                  }
                },
              }
            : {}),
        }),
        signal
      );
      modelTurns += 1;
    } catch (error) {
      const providerCancelled = exitForCancellation();
      return (
        providerCancelled ?? {
          kind: 'failed',
          messages,
          code: error instanceof InternalAgentProviderError ? error.code : 'provider_call_failed',
        }
      );
    }

    if (!isAssistantMessage(response.message)) {
      return { kind: 'failed', messages, code: 'provider_response_invalid' };
    }
    if (response.compactedMessages) {
      if (!response.compactedMessages.every(isAgentMessage)) {
        return { kind: 'failed', messages, code: 'provider_response_invalid' };
      }
      messages = [...response.compactedMessages];
    }
    messages.push(response.message);

    const requestedCalls = response.message.content.filter(
      (content): content is { readonly type: 'toolCall' } & AgentToolCall =>
        content.type === 'toolCall'
    );
    if (
      requestedCalls.some(
        (call) => !call.callId.trim() || callIds.has(call.callId) || !call.name.trim()
      ) ||
      new Set(requestedCalls.map((call) => call.callId)).size !== requestedCalls.length
    ) {
      return { kind: 'failed', messages, code: 'provider_response_invalid' };
    }
    for (const call of requestedCalls) callIds.add(call.callId);

    if (requestedCalls.length === 0) {
      return { kind: 'quiescent', messages };
    }
    if (response.message.truncated) {
      messages.push(
        ...requestedCalls.map((call) =>
          toolError(call.callId, 'The incomplete Tool call was not executed.')
        )
      );
      continue;
    }

    for (const call of requestedCalls) {
      const cancelledBeforeTool = exitForCancellation();
      if (cancelledBeforeTool) return cancelledBeforeTool;
      const tool = tools.get(call.name);
      const validate = validators.get(call.name);
      if (!tool || !validate) {
        messages.push(toolError(call.callId, 'The requested Tool is unavailable.'));
        continue;
      }
      if (!validate(call.arguments)) {
        messages.push(
          toolError(call.callId, 'The Tool arguments do not match the required schema.')
        );
        continue;
      }
      if (toolCalls >= input.limits.maxToolCalls) {
        return { kind: 'limit_reached', messages, limit: 'tool_calls' };
      }

      toolCalls += 1;
      try {
        const result = await raceWithSignal(
          tool.execute(call.arguments, { callId: call.callId, signal }),
          signal
        );
        const content = sanitizeToolContent(result.content);
        if (!content) {
          return { kind: 'failed', messages, code: 'tool_result_invalid' };
        }
        messages.push({
          role: 'tool',
          callId: call.callId,
          content,
          isError: result.isError === true,
        });
      } catch {
        const toolCancelled = exitForCancellation();
        if (toolCancelled) return toolCancelled;
        messages.push(toolError(call.callId, 'The Tool failed without a safe result.'));
      }
    }
  }
}

function assertInput(input: InternalAgentLoopInput): void {
  if (
    !input.systemPrompt.trim() ||
    !input.model.logicalModelId.trim() ||
    input.contextManagement.type !== 'compaction' ||
    input.contextManagement.authority !== 'openkit' ||
    !positiveInteger(input.contextManagement.compactThreshold) ||
    !positiveInteger(input.limits.maxModelTurns) ||
    !positiveInteger(input.limits.maxToolCalls) ||
    !positiveInteger(input.limits.deadlineMs) ||
    !input.messages.every(isAgentMessage)
  ) {
    throw new Error('Invalid internal Agent input.');
  }
  const names = input.tools.map((tool) => tool.name);
  if (
    input.tools.some(
      (tool) => !tool.name.trim() || !tool.description.trim() || !isRecord(tool.inputSchema)
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error('Invalid internal Agent Tool set.');
  }
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value.role !== 'string') return false;
  if (value.role === 'assistant') return isAssistantMessage(value);
  if (value.role === 'user')
    return Array.isArray(value.content) && value.content.every(isAgentContent);
  return (
    value.role === 'tool' &&
    typeof value.callId === 'string' &&
    value.callId.trim().length > 0 &&
    typeof value.isError === 'boolean' &&
    Array.isArray(value.content) &&
    value.content.every(isAgentContent)
  );
}

function isAssistantMessage(value: unknown): value is AgentAssistantMessage {
  return (
    isRecord(value) &&
    value.role === 'assistant' &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.content) &&
    value.content.every(
      (content) =>
        isRecord(content) &&
        ((content.type === 'text' && typeof content.text === 'string') ||
          (content.type === 'toolCall' &&
            typeof content.callId === 'string' &&
            typeof content.name === 'string' &&
            Object.hasOwn(content, 'arguments')))
    )
  );
}

function isAgentContent(value: unknown): value is AgentContent {
  return (
    isRecord(value) &&
    ((value.type === 'text' && typeof value.text === 'string') ||
      (value.type === 'image' &&
        typeof value.data === 'string' &&
        value.data.length > 0 &&
        typeof value.mimeType === 'string' &&
        value.mimeType.length > 0))
  );
}

function sanitizeToolContent(content: readonly AgentContent[]): readonly AgentContent[] | null {
  if (!Array.isArray(content) || !content.every(isAgentContent)) return null;
  return content.map((part) =>
    part.type === 'text' ? { type: 'text', text: redactInternalAgentText(part.text) } : part
  );
}

function toolError(callId: string, text: string): AgentMessage {
  return { role: 'tool', callId, content: [{ type: 'text', text }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  void promise.catch(() => undefined);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}
