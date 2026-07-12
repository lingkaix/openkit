import type { z } from 'zod';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleChatMessage,
} from '../llm/openai-compatible-client.js';
import type { LLMGatewayDispatchContext } from '../llm/provider-dispatcher.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { InternalAgentHookFailureDiagnostic } from './hooks.js';

/**
 * Stable identifier for a NanoCore internal lightweight agent.
 */
export type InternalAgentId = string;

/**
 * User-facing product mode served by one or more internal agents.
 */
export type InternalAgentMode =
  | 'chat'
  | 'automation'
  | 'plan'
  | 'review'
  | 'organize'
  | 'delegation';

/**
 * Internal coordination category for an internal agent definition.
 */
export type InternalAgentCategory =
  | 'conversation'
  | 'routing'
  | 'context'
  | 'evaluation'
  | 'knowledge';

/**
 * Existing provider default slot used by an internal agent.
 */
export type InternalAgentDefaultProviderUse = 'quickChat' | 'internalTasks';

/**
 * Fixed Core-owned tool identifier that may be allowlisted for internal agents.
 */
export type InternalCoreToolId =
  | 'readWorkspaceSummary'
  | 'readThreadSummary'
  | 'readAgentReadiness'
  | 'searchWorkspaceItems'
  | 'searchKnowledge'
  | 'webSearch'
  | 'fetchPageText'
  | 'draftWorkerDelegation'
  | 'proposeKnowledgeEntry'
  | 'summarizeArtifacts';

/**
 * Streamable lifecycle and message event names produced by the internal agent loop.
 */
export const INTERNAL_AGENT_STREAM_EVENT_TYPES = [
  'agent_start',
  'turn_start',
  'message_start',
  'message_update',
  'message_end',
  'turn_end',
  'agent_end',
] as const;

/**
 * Reserved tool execution event names kept app-local until the public protocol needs them.
 */
export const INTERNAL_AGENT_RESERVED_TOOL_EXECUTION_EVENT_TYPES = [
  'tool_execution_start',
  'tool_execution_end',
  'tool_execution_error',
] as const;

/**
 * Complete app-local internal agent event name list, including reserved tool events.
 */
export const INTERNAL_AGENT_EVENT_TYPES = [
  ...INTERNAL_AGENT_STREAM_EVENT_TYPES,
  ...INTERNAL_AGENT_RESERVED_TOOL_EXECUTION_EVENT_TYPES,
] as const;

/**
 * Event names that a future internal agent loop may stream into app-local adapters.
 */
export type InternalAgentStreamEventType = (typeof INTERNAL_AGENT_STREAM_EVENT_TYPES)[number];

/**
 * Reserved app-local event names for internal tool execution diagnostics.
 */
export type InternalAgentReservedToolExecutionEventType =
  (typeof INTERNAL_AGENT_RESERVED_TOOL_EXECUTION_EVENT_TYPES)[number];

/**
 * Complete app-local event name union for internal agent loop events.
 */
export type InternalAgentEventType =
  | InternalAgentStreamEventType
  | InternalAgentReservedToolExecutionEventType;

/**
 * Terminal status for bounded internal agent events.
 */
export type InternalAgentEventStatus = 'completed' | 'error' | 'aborted';

/**
 * Stable stop reason recorded on terminal internal agent events.
 */
export type InternalAgentStopReason =
  | 'completed'
  | 'error'
  | 'aborted'
  | 'length'
  | 'ask_user'
  | 'budget_exhausted';

/**
 * Message role used by internal agent message events.
 */
export type InternalAgentEventMessageRole = 'assistant' | 'tool';

/**
 * Shared fields present on every internal agent event.
 */
export interface InternalAgentEventBase<TType extends InternalAgentEventType> {
  /** Monotonic sequence within one internal agent run. */
  readonly sequence: number;
  /** Exact snake_case event name. */
  readonly eventType: TType;
  /** Stable internal agent id that emitted the event. */
  readonly agentId: InternalAgentId;
  /** App-local run id for one internal agent invocation. */
  readonly runId: string;
  /** ISO timestamp for when the event was emitted. */
  readonly timestamp: string;
}

/**
 * Shared fields present on events associated with one internal agent turn.
 */
export interface InternalAgentTurnEventBase<TType extends InternalAgentEventType>
  extends InternalAgentEventBase<TType> {
  /** App-local turn id within the internal agent run. */
  readonly turnId: string;
}

/**
 * Shared fields present on events associated with one internal agent message.
 */
export interface InternalAgentMessageEventBase<TType extends InternalAgentEventType>
  extends InternalAgentTurnEventBase<TType> {
  /** App-local message id within the internal agent turn. */
  readonly messageId: string;
}

/**
 * Event emitted when one internal agent run starts.
 */
export interface InternalAgentAgentStartEvent extends InternalAgentEventBase<'agent_start'> {
  /** Optional product mode that routed into the internal agent. */
  readonly mode?: InternalAgentMode;
  /** Provider id selected for the run when known. */
  readonly providerId?: string;
  /** Model selected for the run when known. */
  readonly model?: string;
}

/**
 * Event emitted when one internal agent turn starts.
 */
export interface InternalAgentTurnStartEvent extends InternalAgentTurnEventBase<'turn_start'> {
  /** Number of caller-visible input messages used to prepare the turn. */
  readonly inputMessageCount: number;
}

/**
 * Event emitted when one internal agent message starts.
 */
export interface InternalAgentMessageStartEvent
  extends InternalAgentMessageEventBase<'message_start'> {
  /** Role of the message being produced. */
  readonly role: InternalAgentEventMessageRole;
}

/**
 * Event emitted for incremental message text from an internal agent.
 */
export interface InternalAgentMessageUpdateEvent
  extends InternalAgentMessageEventBase<'message_update'> {
  /** Text delta appended by this update. */
  readonly delta: string;
}

/**
 * Event emitted when one internal agent message ends.
 */
export interface InternalAgentMessageEndEvent extends InternalAgentMessageEventBase<'message_end'> {
  /** Terminal status for the message. */
  readonly status: InternalAgentEventStatus;
  /** Optional terminal stop reason for the message. */
  readonly stopReason?: InternalAgentStopReason;
  /** Optional final redacted message content snapshot. */
  readonly content?: string;
  /** Optional redacted error message when status is not completed. */
  readonly errorMessage?: string;
}

/**
 * Event emitted when one internal agent turn ends.
 */
export interface InternalAgentTurnEndEvent extends InternalAgentTurnEventBase<'turn_end'> {
  /** Terminal status for the turn. */
  readonly status: InternalAgentEventStatus;
  /** Stable stop reason for the turn. */
  readonly stopReason: InternalAgentStopReason;
  /** Optional elapsed duration for the turn in milliseconds. */
  readonly durationMs?: number;
  /** Optional redacted error message when status is not completed. */
  readonly errorMessage?: string;
}

/**
 * Event emitted when one internal agent run ends.
 */
export interface InternalAgentAgentEndEvent extends InternalAgentEventBase<'agent_end'> {
  /** Terminal status for the run. */
  readonly status: InternalAgentEventStatus;
  /** Stable stop reason for the run. */
  readonly stopReason: InternalAgentStopReason;
  /** Optional elapsed duration for the run in milliseconds. */
  readonly durationMs?: number;
  /** Optional redacted error message when status is not completed. */
  readonly errorMessage?: string;
}

/**
 * Lifecycle events emitted by an internal agent run.
 */
export type InternalAgentLifecycleEvent =
  | InternalAgentAgentStartEvent
  | InternalAgentTurnStartEvent
  | InternalAgentTurnEndEvent
  | InternalAgentAgentEndEvent;

/**
 * Message events emitted by an internal agent run.
 */
export type InternalAgentMessageEvent =
  | InternalAgentMessageStartEvent
  | InternalAgentMessageUpdateEvent
  | InternalAgentMessageEndEvent;

/**
 * Non-tool internal agent event union for future app-local stream adapters.
 */
export type InternalAgentStreamEvent = InternalAgentLifecycleEvent | InternalAgentMessageEvent;

/**
 * Shared fields present on reserved tool execution events.
 */
export interface InternalAgentToolExecutionEventBase<
  TType extends InternalAgentReservedToolExecutionEventType,
> extends InternalAgentTurnEventBase<TType> {
  /** App-local tool call id within the internal agent turn. */
  readonly toolCallId: string;
  /** Fixed Core-owned tool id, or a future app-local tool name. */
  readonly toolName: InternalCoreToolId | (string & {});
}

/**
 * Reserved event emitted before one internal tool call starts.
 */
export interface InternalAgentToolExecutionStartEvent
  extends InternalAgentToolExecutionEventBase<'tool_execution_start'> {
  /** Optional redacted tool input snapshot for diagnostics. */
  readonly input?: unknown;
}

/**
 * Reserved event emitted after one internal tool call completes.
 */
export interface InternalAgentToolExecutionEndEvent
  extends InternalAgentToolExecutionEventBase<'tool_execution_end'> {
  /** Terminal status for the tool call. */
  readonly status: 'completed';
  /** Optional elapsed duration for the tool call in milliseconds. */
  readonly durationMs?: number;
  /** Optional redacted tool output snapshot for diagnostics. */
  readonly output?: unknown;
}

/**
 * Reserved event emitted after one internal tool call fails or is aborted.
 */
export interface InternalAgentToolExecutionErrorEvent
  extends InternalAgentToolExecutionEventBase<'tool_execution_error'> {
  /** Terminal status for the failed tool call. */
  readonly status: 'error' | 'aborted';
  /** Optional elapsed duration for the tool call in milliseconds. */
  readonly durationMs?: number;
  /** Redacted tool error message. */
  readonly errorMessage: string;
}

/**
 * Reserved app-local event union for internal tool execution diagnostics.
 */
export type InternalAgentReservedToolExecutionEvent =
  | InternalAgentToolExecutionStartEvent
  | InternalAgentToolExecutionEndEvent
  | InternalAgentToolExecutionErrorEvent;

/**
 * Complete app-local internal agent event union.
 */
export type InternalAgentEvent = InternalAgentStreamEvent | InternalAgentReservedToolExecutionEvent;

/**
 * Runtime limits attached to one internal agent definition.
 */
export interface InternalAgentLimits {
  /** Maximum caller-provided messages accepted by the runner. */
  readonly maxInputMessages: number;
  /** Soft timeout budget in milliseconds for future bounded provider and tool calls. */
  readonly timeoutMs: number;
}

/**
 * Metadata and validation contract for one NanoCore internal agent.
 */
export interface InternalAgentDefinition<TOutput = unknown> {
  /** Stable agent id used by app-local callers. */
  readonly id: InternalAgentId;
  /** Human-readable agent name for diagnostics and UI read models. */
  readonly displayName: string;
  /** Short purpose statement that can be reused in diagnostics. */
  readonly purpose: string;
  /** Internal coordination category. */
  readonly category: InternalAgentCategory;
  /** Product modes that may route through this agent. */
  readonly supportedModes: readonly InternalAgentMode[];
  /** Existing provider default slot used when the caller does not override provider/model. */
  readonly defaultProviderUse: InternalAgentDefaultProviderUse;
  /** System instruction prepended by the common runner. */
  readonly systemPrompt: string;
  /** Fixed Core-owned tools this agent may call. */
  readonly allowedTools: readonly InternalCoreToolId[];
  /** Runtime guardrails for this agent. */
  readonly limits: InternalAgentLimits;
  /** Output schema used to validate normalized provider output. */
  readonly outputSchema: z.ZodType<TOutput>;
}

/**
 * Chat message accepted by the internal agent runner.
 */
export type InternalAgentMessage = OpenAICompatibleChatMessage;

/**
 * Input passed to a common internal agent runner invocation.
 */
export interface InternalAgentRunInput {
  /** Agent id to invoke. */
  readonly agentId: InternalAgentId;
  /** Caller-provided messages, excluding the definition-owned system prompt. */
  readonly messages: readonly InternalAgentMessage[];
  /** Optional provider override from app API request overrides. */
  readonly providerId?: string | null;
  /** Optional model override from app API request overrides. */
  readonly model?: string | null;
  /** Optional OpenAI-compatible metadata forwarded to the provider dispatcher. */
  readonly metadata?: Record<string, unknown>;
  /** Optional dispatcher context such as usage endpoint or prompt-cache scope. */
  readonly dispatchContext?: LLMGatewayDispatchContext;
}

/**
 * Successful normalized internal agent result.
 */
export interface InternalAgentRunResult<TOutput = unknown> {
  /** Provider response id. */
  readonly id: string;
  /** Agent id that produced the output. */
  readonly agentId: InternalAgentId;
  /** Terminal status for this bounded internal run. */
  readonly status: 'completed';
  /** Provider id selected for the invocation. */
  readonly providerId: string;
  /** Model selected for the invocation. */
  readonly model: string;
  /** Schema-validated output for the requested agent. */
  readonly output: TOutput;
  /** Duration in milliseconds measured by the runner. */
  readonly durationMs: number;
  /** Provider-native usage payload when present. */
  readonly usage?: unknown;
}

/**
 * Minimal LLM client interface required by the internal agent runner.
 */
export interface InternalAgentLLMClient {
  /**
   * Creates one non-streaming chat completion for an internal agent.
   *
   * @param provider Secret-bearing provider config selected by the runner.
   * @param request OpenAI-compatible chat completion request.
   * @param context Optional dispatcher context for prompt-cache and usage policy.
   * @returns OpenAI-compatible chat completion response.
   */
  createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    context?: LLMGatewayDispatchContext
  ): Promise<OpenAICompatibleChatCompletionResponse>;
  /**
   * Creates one streaming chat completion for an internal agent when supported.
   *
   * @param provider Secret-bearing provider config selected by the runner.
   * @param request OpenAI-compatible streaming chat completion request.
   * @param context Optional dispatcher context for prompt-cache and usage policy.
   * @returns OpenAI-compatible SSE response body stream.
   */
  createChatCompletionStream?(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    context?: LLMGatewayDispatchContext
  ): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Provider/model selection shown in safe internal-agent diagnostics.
 */
export interface InternalAgentProviderDiagnostic {
  /** Whether a provider and model are currently selected. */
  readonly configured: boolean;
  /** Provider id when selected. */
  readonly providerId?: string;
  /** Model when selected. */
  readonly model?: string;
  /** Reason selection is not usable. */
  readonly reason?: 'provider-missing' | 'model-missing';
}

/**
 * Safe diagnostics summary for one internal agent definition.
 */
export interface InternalAgentDefinitionDiagnostic {
  /** Stable agent id. */
  readonly id: InternalAgentId;
  /** Human-readable agent name. */
  readonly displayName: string;
  /** Product modes supported by this definition. */
  readonly supportedModes: readonly InternalAgentMode[];
  /** Existing provider default slot used by this definition. */
  readonly defaultProviderUse: InternalAgentDefaultProviderUse;
  /** Fixed Core tool allowlist. */
  readonly allowedTools: readonly InternalCoreToolId[];
  /** Provider/model selection without secrets. */
  readonly provider: InternalAgentProviderDiagnostic;
}

/**
 * Redacted failure record retained by the internal agent runner.
 */
export interface InternalAgentFailureDiagnostic {
  /** Stable failure code. */
  readonly code: string;
  /** Terminal status reported by the loop or runner. */
  readonly status: InternalAgentEventStatus;
  /** Stable stop reason reported by the loop or runner. */
  readonly stopReason: InternalAgentStopReason;
  /** Agent id associated with the failure. */
  readonly agentId: InternalAgentId;
  /** Redacted message safe for diagnostics. */
  readonly message: string;
  /** ISO timestamp for the failed invocation. */
  readonly occurredAt: string;
  /** Redacted structured details for troubleshooting. */
  readonly details: unknown;
}

/**
 * Safe diagnostics snapshot for the internal-agent subsystem.
 */
export interface InternalAgentDiagnosticsSnapshot {
  /** Registered internal agents and current provider/model selection. */
  readonly agents: InternalAgentDefinitionDiagnostic[];
  /** Recent redacted internal-agent failures. */
  readonly recentFailures: InternalAgentFailureDiagnostic[];
  /** Recent redacted observational hook failures. */
  readonly recentHookFailures: readonly InternalAgentHookFailureDiagnostic[];
}
