import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
} from '../llm/openai-compatible-client.js';
import { type InternalAgentLoopEffects, internalAgentLoop } from './loop.js';
import { QUICK_CHAT_AGENT_DEFINITION, QUICK_CHAT_AGENT_ID } from './quick-chat.js';
import type { InternalAgentDefinition } from './types.js';

const STRUCTURED_AGENT_DEFINITION: InternalAgentDefinition<{ decision: 'continue' }> = {
  id: 'structured-loop-test',
  displayName: 'StructuredLoopTestAgent',
  purpose: 'Exercise loop schema validation in tests.',
  category: 'evaluation',
  supportedModes: ['review'],
  defaultProviderUse: 'internalTasks',
  systemPrompt: 'Return a structured decision.',
  allowedTools: [],
  limits: {
    maxInputMessages: 4,
    timeoutMs: 30_000,
  },
  outputSchema: z.object({
    decision: z.literal('continue'),
  }),
};

const TIMEOUT_AGENT_DEFINITION: InternalAgentDefinition<{ content: string }> = {
  ...QUICK_CHAT_AGENT_DEFINITION,
  id: 'timeout-loop-test',
  displayName: 'TimeoutLoopTestAgent',
  limits: {
    ...QUICK_CHAT_AGENT_DEFINITION.limits,
    timeoutMs: 1,
  },
};

/**
 * Collects all events from an async iterable.
 *
 * @param iterable Async iterable to drain.
 * @returns Events yielded by the iterable in order.
 */
async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterable) {
    items.push(item);
  }

  return items;
}

/**
 * Creates a deterministic clock that advances one millisecond per call.
 *
 * @returns Clock dependency for loop tests.
 */
function createTestClock(): () => Date {
  const baseMs = Date.parse('2026-05-31T00:00:00.000Z');
  let calls = 0;

  return () => {
    const value = new Date(baseMs + calls);

    calls += 1;
    return value;
  };
}

/**
 * Creates reusable deterministic loop effects for terminal-path tests.
 *
 * @param callProvider Provider effect override for the test case.
 * @returns Loop effects with stable ids and clock values.
 */
function createLoopEffects(
  callProvider: InternalAgentLoopEffects['callProvider']
): InternalAgentLoopEffects {
  return {
    callProvider,
    createMessageId: () => 'message_loop_1',
    createRunId: () => 'run_loop_1',
    createTurnId: () => 'turn_loop_1',
    now: createTestClock(),
  };
}

/**
 * Creates a minimal successful OpenAI-compatible completion.
 *
 * @param request Provider request supplied to the fake provider.
 * @param content Assistant text content returned by the fake provider.
 * @returns OpenAI-compatible completion response.
 */
function createCompletion(
  request: OpenAICompatibleChatCompletionRequest,
  content: string
): OpenAICompatibleChatCompletionResponse {
  return {
    id: 'chatcmpl_loop_test',
    object: 'chat.completion',
    created: 1,
    model: request.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  };
}

describe('internalAgentLoop', () => {
  it('emits the non-streaming success event sequence through injected effects', async () => {
    const providerCalls: Array<{
      context: unknown;
      providerId: string;
      request: OpenAICompatibleChatCompletionRequest;
    }> = [];
    const effects: InternalAgentLoopEffects = {
      callProvider: async ({ context, providerId, request }) => {
        providerCalls.push({ context, providerId, request });

        return {
          id: 'chatcmpl_loop_success',
          object: 'chat.completion',
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from the loop.' },
              finish_reason: 'stop',
            },
          ],
        } satisfies OpenAICompatibleChatCompletionResponse;
      },
      createMessageId: () => 'message_loop_1',
      createRunId: () => 'run_loop_1',
      createTurnId: () => 'turn_loop_1',
      now: createTestClock(),
    };

    const events = await collectAsync(
      internalAgentLoop(
        {
          definition: QUICK_CHAT_AGENT_DEFINITION,
          input: {
            agentId: QUICK_CHAT_AGENT_ID,
            dispatchContext: { promptCacheScope: { workspaceId: 'loop-test' } },
            messages: [{ role: 'user', content: 'Say hello.' }],
            metadata: { source: 'loop-test' },
          },
          model: 'llama3.2',
          providerId: 'ollama',
        },
        effects
      )
    );

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      context: { promptCacheScope: { workspaceId: 'loop-test' } },
      providerId: 'ollama',
      request: {
        metadata: { source: 'loop-test' },
        model: 'llama3.2',
      },
    });
    expect(providerCalls[0]?.request.messages).toEqual([
      { role: 'system', content: QUICK_CHAT_AGENT_DEFINITION.systemPrompt },
      { role: 'user', content: 'Say hello.' },
    ]);
    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(events).toEqual([
      {
        eventType: 'agent_start',
        sequence: 0,
        agentId: QUICK_CHAT_AGENT_ID,
        runId: 'run_loop_1',
        timestamp: '2026-05-31T00:00:00.000Z',
        providerId: 'ollama',
        model: 'llama3.2',
      },
      {
        eventType: 'turn_start',
        sequence: 1,
        agentId: QUICK_CHAT_AGENT_ID,
        runId: 'run_loop_1',
        turnId: 'turn_loop_1',
        timestamp: '2026-05-31T00:00:00.001Z',
        inputMessageCount: 1,
      },
      {
        eventType: 'message_start',
        sequence: 2,
        agentId: QUICK_CHAT_AGENT_ID,
        runId: 'run_loop_1',
        turnId: 'turn_loop_1',
        messageId: 'message_loop_1',
        timestamp: '2026-05-31T00:00:00.002Z',
        role: 'assistant',
      },
      {
        eventType: 'message_update',
        sequence: 3,
        agentId: QUICK_CHAT_AGENT_ID,
        runId: 'run_loop_1',
        turnId: 'turn_loop_1',
        messageId: 'message_loop_1',
        timestamp: '2026-05-31T00:00:00.003Z',
        delta: 'Hello from the loop.',
      },
      {
        eventType: 'message_end',
        sequence: 4,
        agentId: QUICK_CHAT_AGENT_ID,
        runId: 'run_loop_1',
        turnId: 'turn_loop_1',
        messageId: 'message_loop_1',
        timestamp: '2026-05-31T00:00:00.004Z',
        status: 'completed',
        stopReason: 'completed',
        content: 'Hello from the loop.',
      },
      {
        eventType: 'turn_end',
        sequence: 5,
        agentId: QUICK_CHAT_AGENT_ID,
        runId: 'run_loop_1',
        turnId: 'turn_loop_1',
        timestamp: '2026-05-31T00:00:00.005Z',
        status: 'completed',
        stopReason: 'completed',
        durationMs: 4,
      },
      {
        eventType: 'agent_end',
        sequence: 6,
        agentId: QUICK_CHAT_AGENT_ID,
        runId: 'run_loop_1',
        timestamp: '2026-05-31T00:00:00.006Z',
        status: 'completed',
        stopReason: 'completed',
        durationMs: 6,
      },
    ]);
    expect(events.filter((event) => event.eventType === 'message_update')).toHaveLength(1);
  });

  it('emits one message update per streaming provider text delta', async () => {
    const providerCalls: Array<{
      providerId: string;
      request: OpenAICompatibleChatCompletionRequest;
    }> = [];
    const effects: InternalAgentLoopEffects = {
      callProvider: async () => {
        throw new Error('non-streaming provider should not be called');
      },
      callProviderStream: async function* ({ providerId, request }) {
        providerCalls.push({ providerId, request });
        yield { delta: 'Hel' };
        yield { delta: 'lo' };
      },
      createMessageId: () => 'message_loop_1',
      createRunId: () => 'run_loop_1',
      createTurnId: () => 'turn_loop_1',
      now: createTestClock(),
    };

    const events = await collectAsync(
      internalAgentLoop(
        {
          definition: QUICK_CHAT_AGENT_DEFINITION,
          input: {
            agentId: QUICK_CHAT_AGENT_ID,
            messages: [{ role: 'user', content: 'Say hello.' }],
          },
          model: 'llama3.2',
          providerId: 'ollama',
          stream: true,
        },
        effects
      )
    );

    expect(providerCalls).toEqual([
      expect.objectContaining({
        providerId: 'ollama',
        request: expect.objectContaining({
          model: 'llama3.2',
          stream: true,
        }),
      }),
    ]);
    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events.filter((event) => event.eventType === 'message_update')).toEqual([
      expect.objectContaining({ delta: 'Hel' }),
      expect.objectContaining({ delta: 'lo' }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: 'message_end',
        status: 'completed',
        stopReason: 'completed',
        content: 'Hello',
      })
    );
  });

  it('emits redacted terminal events for provider errors', async () => {
    const effects = createLoopEffects(async () => {
      throw new Error('provider failed token=tok_secret Authorization: Bearer live_secret');
    });

    const events = await collectAsync(
      internalAgentLoop(
        {
          definition: QUICK_CHAT_AGENT_DEFINITION,
          input: {
            agentId: QUICK_CHAT_AGENT_ID,
            messages: [{ role: 'user', content: 'Say hello.' }],
          },
          model: 'llama3.2',
          providerId: 'ollama',
        },
        effects
      )
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'turn_end',
      'agent_end',
    ]);
    expect(events[2]).toMatchObject({
      eventType: 'turn_end',
      status: 'error',
      stopReason: 'error',
      errorMessage: 'provider failed token=[redacted] Authorization: Bearer [redacted]',
    });
    expect(events[3]).toMatchObject({
      eventType: 'agent_end',
      status: 'error',
      stopReason: 'error',
      errorMessage: 'provider failed token=[redacted] Authorization: Bearer [redacted]',
    });
    expect(JSON.stringify(events)).not.toContain('tok_secret');
    expect(JSON.stringify(events)).not.toContain('live_secret');
  });

  it('emits redacted terminal events for structured output schema errors', async () => {
    const effects = createLoopEffects(async ({ request }) =>
      createCompletion(request, JSON.stringify({ decision: 'stop', token: 'tok_secret' }))
    );

    const events = await collectAsync(
      internalAgentLoop(
        {
          definition: STRUCTURED_AGENT_DEFINITION,
          input: {
            agentId: STRUCTURED_AGENT_DEFINITION.id,
            messages: [{ role: 'user', content: 'Choose next step.' }],
          },
          model: 'gpt-5.1',
          providerId: 'openai',
        },
        effects
      )
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'turn_end',
      'agent_end',
    ]);
    expect(events[2]).toMatchObject({
      eventType: 'turn_end',
      status: 'error',
      stopReason: 'error',
    });
    expect(events[3]).toMatchObject({
      eventType: 'agent_end',
      status: 'error',
      stopReason: 'error',
    });
    expect(JSON.stringify(events)).not.toContain('tok_secret');
  });

  it('emits budget_exhausted terminal events for timeouts', async () => {
    const effects = createLoopEffects(async () => new Promise(() => undefined));

    const events = await collectAsync(
      internalAgentLoop(
        {
          definition: TIMEOUT_AGENT_DEFINITION,
          input: {
            agentId: TIMEOUT_AGENT_DEFINITION.id,
            messages: [{ role: 'user', content: 'Say hello.' }],
          },
          model: 'llama3.2',
          providerId: 'ollama',
        },
        effects
      )
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'turn_end',
      'agent_end',
    ]);
    expect(events[2]).toMatchObject({
      eventType: 'turn_end',
      status: 'error',
      stopReason: 'budget_exhausted',
      errorMessage: 'TimeoutLoopTestAgent timed out after 1ms.',
    });
    expect(events[3]).toMatchObject({
      eventType: 'agent_end',
      status: 'error',
      stopReason: 'budget_exhausted',
      errorMessage: 'TimeoutLoopTestAgent timed out after 1ms.',
    });
  });

  it('emits aborted terminal events for abort signals', async () => {
    const abortController = new AbortController();
    const effects = createLoopEffects(async () => {
      throw new Error('provider should not be called after abort');
    });

    abortController.abort();

    const events = await collectAsync(
      internalAgentLoop(
        {
          definition: QUICK_CHAT_AGENT_DEFINITION,
          input: {
            agentId: QUICK_CHAT_AGENT_ID,
            messages: [{ role: 'user', content: 'Say hello.' }],
          },
          model: 'llama3.2',
          providerId: 'ollama',
          signal: abortController.signal,
        },
        effects
      )
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'turn_end',
      'agent_end',
    ]);
    expect(events[2]).toMatchObject({
      eventType: 'turn_end',
      status: 'aborted',
      stopReason: 'aborted',
      errorMessage: 'Internal agent loop was aborted.',
    });
    expect(events[3]).toMatchObject({
      eventType: 'agent_end',
      status: 'aborted',
      stopReason: 'aborted',
      errorMessage: 'Internal agent loop was aborted.',
    });
  });
});
