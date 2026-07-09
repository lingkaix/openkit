import { describe, expect, it } from 'vitest';

import {
  INTERNAL_AGENT_EVENT_TYPES,
  INTERNAL_AGENT_RESERVED_TOOL_EXECUTION_EVENT_TYPES,
  INTERNAL_AGENT_STREAM_EVENT_TYPES,
  type InternalAgentEvent,
  type InternalAgentMessageUpdateEvent,
  type InternalAgentReservedToolExecutionEvent,
} from './types.js';

describe('internal agent event types', () => {
  it('declares lifecycle, message, and reserved tool execution event names', () => {
    expect(INTERNAL_AGENT_STREAM_EVENT_TYPES).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(INTERNAL_AGENT_RESERVED_TOOL_EXECUTION_EVENT_TYPES).toEqual([
      'tool_execution_start',
      'tool_execution_end',
      'tool_execution_error',
    ]);
    expect(INTERNAL_AGENT_EVENT_TYPES).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
      'tool_execution_start',
      'tool_execution_end',
      'tool_execution_error',
    ]);
  });

  it('accepts lifecycle and message events with required identifiers', () => {
    const events: InternalAgentEvent[] = [
      {
        eventType: 'agent_start',
        sequence: 0,
        agentId: 'quick-chat',
        runId: 'run_1',
        timestamp: '2026-05-31T00:00:00.000Z',
        mode: 'chat',
      },
      {
        eventType: 'turn_start',
        sequence: 1,
        agentId: 'quick-chat',
        runId: 'run_1',
        turnId: 'turn_1',
        timestamp: '2026-05-31T00:00:00.001Z',
        inputMessageCount: 1,
      },
      {
        eventType: 'message_start',
        sequence: 2,
        agentId: 'quick-chat',
        runId: 'run_1',
        turnId: 'turn_1',
        messageId: 'message_1',
        timestamp: '2026-05-31T00:00:00.002Z',
        role: 'assistant',
      },
      {
        eventType: 'message_update',
        sequence: 3,
        agentId: 'quick-chat',
        runId: 'run_1',
        turnId: 'turn_1',
        messageId: 'message_1',
        timestamp: '2026-05-31T00:00:00.003Z',
        delta: 'Hello',
      },
      {
        eventType: 'message_end',
        sequence: 4,
        agentId: 'quick-chat',
        runId: 'run_1',
        turnId: 'turn_1',
        messageId: 'message_1',
        timestamp: '2026-05-31T00:00:00.004Z',
        status: 'completed',
        stopReason: 'completed',
      },
      {
        eventType: 'turn_end',
        sequence: 5,
        agentId: 'quick-chat',
        runId: 'run_1',
        turnId: 'turn_1',
        timestamp: '2026-05-31T00:00:00.005Z',
        status: 'completed',
        stopReason: 'completed',
      },
      {
        eventType: 'agent_end',
        sequence: 6,
        agentId: 'quick-chat',
        runId: 'run_1',
        timestamp: '2026-05-31T00:00:00.006Z',
        status: 'completed',
        stopReason: 'completed',
      },
    ];

    const update = events.find(
      (event): event is InternalAgentMessageUpdateEvent => event.eventType === 'message_update'
    );

    expect(events.map((event) => event.eventType)).toEqual(INTERNAL_AGENT_STREAM_EVENT_TYPES);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(update?.delta).toBe('Hello');
  });

  it('keeps tool execution events typed as reserved app-local events', () => {
    const toolEvent: InternalAgentReservedToolExecutionEvent = {
      eventType: 'tool_execution_error',
      sequence: 0,
      agentId: 'worker-coordinator',
      runId: 'run_2',
      turnId: 'turn_2',
      toolCallId: 'tool_1',
      toolName: 'draftWorkerDelegation',
      timestamp: '2026-05-31T00:00:01.000Z',
      status: 'error',
      errorMessage: 'Tool execution failed.',
    };

    expect(INTERNAL_AGENT_RESERVED_TOOL_EXECUTION_EVENT_TYPES).toContain(toolEvent.eventType);
    expect(toolEvent.toolCallId).toBe('tool_1');
  });
});
