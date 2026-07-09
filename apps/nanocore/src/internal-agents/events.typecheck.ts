import type {
  InternalAgentEvent,
  InternalAgentMessageUpdateEvent,
  InternalAgentReservedToolExecutionEvent,
  InternalAgentStreamEvent,
} from './types.js';

/**
 * Type-level assertion that a candidate is assignable to InternalAgentEvent.
 */
type AssertInternalAgentEvent<T extends InternalAgentEvent> = T;

/**
 * Type-level assertion that a candidate is assignable to stream-safe events.
 */
type AssertInternalAgentStreamEvent<T extends InternalAgentStreamEvent> = T;

/**
 * Type-level assertion that a candidate is assignable to reserved tool events.
 */
type AssertInternalAgentReservedToolEvent<T extends InternalAgentReservedToolExecutionEvent> = T;

/**
 * Compile-time fixture proving message update events accept all required fields.
 */
type MessageUpdateAccepted = AssertInternalAgentEvent<{
  readonly eventType: 'message_update';
  readonly sequence: 0;
  readonly agentId: 'quick-chat';
  readonly runId: 'run_1';
  readonly turnId: 'turn_1';
  readonly messageId: 'message_1';
  readonly timestamp: '2026-05-31T00:00:00.000Z';
  readonly delta: 'Hello';
}>;

/**
 * Compile-time fixture proving the exported message update interface is in the full union.
 */
type MessageUpdateSubtypeAccepted = AssertInternalAgentEvent<InternalAgentMessageUpdateEvent>;

/**
 * Compile-time fixture proving reserved tool events accept required tool identifiers.
 */
type ToolExecutionAccepted = AssertInternalAgentReservedToolEvent<{
  readonly eventType: 'tool_execution_start';
  readonly sequence: 0;
  readonly agentId: 'worker-coordinator';
  readonly runId: 'run_1';
  readonly turnId: 'turn_1';
  readonly toolCallId: 'tool_1';
  readonly toolName: 'draftWorkerDelegation';
  readonly timestamp: '2026-05-31T00:00:00.000Z';
}>;

/**
 * Compile-time fixture proving message update events reject missing message ids.
 */
// @ts-expect-error message_update events require messageId.
type MessageUpdateMissingMessageId = AssertInternalAgentEvent<{
  readonly eventType: 'message_update';
  readonly sequence: 0;
  readonly agentId: 'quick-chat';
  readonly runId: 'run_1';
  readonly turnId: 'turn_1';
  readonly timestamp: '2026-05-31T00:00:00.000Z';
  readonly delta: 'Hello';
}>;

/**
 * Compile-time fixture proving terminal turn events reject missing stop reasons.
 */
// @ts-expect-error turn_end events require a stable stopReason.
type TurnEndMissingStopReason = AssertInternalAgentEvent<{
  readonly eventType: 'turn_end';
  readonly sequence: 0;
  readonly agentId: 'quick-chat';
  readonly runId: 'run_1';
  readonly turnId: 'turn_1';
  readonly timestamp: '2026-05-31T00:00:00.000Z';
  readonly status: 'completed';
}>;

/**
 * Compile-time fixture proving reserved tool events are excluded from stream-safe events.
 */
// @ts-expect-error reserved tool execution events are not stream-safe events.
type ToolExecutionIsNotStreamEvent = AssertInternalAgentStreamEvent<ToolExecutionAccepted>;

export type {
  MessageUpdateAccepted,
  MessageUpdateMissingMessageId,
  MessageUpdateSubtypeAccepted,
  ToolExecutionAccepted,
  ToolExecutionIsNotStreamEvent,
  TurnEndMissingStopReason,
};
