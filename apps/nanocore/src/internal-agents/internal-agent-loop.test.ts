import { describe, expect, it, vi } from 'vitest';

import {
  type AgentAssistantMessage,
  type AgentMessage,
  type AgentTool,
  type InternalAgentProviderRequest,
  runInternalAgentLoop,
} from './internal-agent-loop.js';

const model = {
  logicalModelId: 'assistant',
  capabilities: ['chat-completions', 'tool-calling'],
  modelFamilyId: 'gpt-5',
};
const contextManagement = {
  type: 'compaction' as const,
  compactThreshold: 8_000,
  authority: 'openkit' as const,
};

function userMessage(text = 'Inspect the environment.'): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(
  content: AgentAssistantMessage['content'],
  truncated = false
): AgentAssistantMessage {
  return { role: 'assistant', content, truncated };
}

function input(tools: readonly AgentTool[] = []) {
  return {
    systemPrompt: 'Act only through the supplied tools.',
    messages: [userMessage()],
    tools,
    model,
    contextManagement,
    limits: { maxModelTurns: 4, maxToolCalls: 3, deadlineMs: 5_000 },
    signal: new AbortController().signal,
  };
}

describe('internal Agent loop', () => {
  it('executes complete tool calls in provider order after strict schema validation', async () => {
    const executionOrder: string[] = [];
    const tools: AgentTool[] = [
      {
        name: 'environment.status',
        description: 'Read one environment status.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        execute: async (value) => {
          executionOrder.push((value as { id: string }).id);
          return { content: [{ type: 'text', text: `ready:${(value as { id: string }).id}` }] };
        },
      },
    ];
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        message: assistantMessage([
          {
            type: 'toolCall',
            callId: 'call_1',
            name: 'environment.status',
            arguments: { id: 'one' },
          },
          {
            type: 'toolCall',
            callId: 'call_2',
            name: 'environment.status',
            arguments: { id: 'two' },
          },
        ]),
      })
      .mockResolvedValueOnce({
        message: assistantMessage([{ type: 'text', text: 'Both ready.' }]),
      });

    const result = await runInternalAgentLoop(input(tools), call);

    expect(result.kind).toBe('quiescent');
    expect(executionOrder).toEqual(['one', 'two']);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]?.[0].tools).toEqual([
      {
        name: 'environment.status',
        description: 'Read one environment status.',
        inputSchema: tools[0]?.inputSchema,
      },
    ]);
    expect(call.mock.calls[1]?.[0].messages.slice(-2)).toEqual([
      {
        role: 'tool',
        callId: 'call_1',
        content: [{ type: 'text', text: 'ready:one' }],
        isError: false,
      },
      {
        role: 'tool',
        callId: 'call_2',
        content: [{ type: 'text', text: 'ready:two' }],
        isError: false,
      },
    ]);
  });

  it('does not execute invalid or truncated calls and bounds correction by model turns', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'unsafe' }] }));
    const tool: AgentTool = {
      name: 'environment.prepare',
      description: 'Prepare one environment candidate.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { image: { type: 'string' } },
        required: ['image'],
      },
      execute,
    };
    const invalid = await runInternalAgentLoop(
      { ...input([tool]), limits: { maxModelTurns: 2, maxToolCalls: 2, deadlineMs: 5_000 } },
      vi
        .fn()
        .mockResolvedValueOnce({
          message: assistantMessage([
            {
              type: 'toolCall',
              callId: 'invalid',
              name: tool.name,
              arguments: { image: 'ok', extra: true },
            },
          ]),
        })
        .mockResolvedValueOnce({
          message: assistantMessage([{ type: 'text', text: 'Cannot prepare.' }]),
        })
    );
    const truncated = await runInternalAgentLoop(
      { ...input([tool]), limits: { maxModelTurns: 1, maxToolCalls: 2, deadlineMs: 5_000 } },
      vi.fn().mockResolvedValue({
        message: assistantMessage(
          [
            {
              type: 'toolCall',
              callId: 'truncated',
              name: tool.name,
              arguments: { image: 'ok' },
            },
          ],
          true
        ),
      })
    );

    expect(invalid.kind).toBe('quiescent');
    expect(truncated).toMatchObject({ kind: 'limit_reached', limit: 'model_turns' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate call ids before executing any closure', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const tool: AgentTool = {
      name: 'environment.status',
      description: 'Read status.',
      inputSchema: { type: 'object' },
      execute,
    };
    const result = await runInternalAgentLoop(
      input([tool]),
      vi.fn().mockResolvedValue({
        message: assistantMessage([
          { type: 'toolCall', callId: 'duplicate', name: tool.name, arguments: {} },
          { type: 'toolCall', callId: 'duplicate', name: tool.name, arguments: {} },
        ]),
      })
    );

    expect(result).toMatchObject({ kind: 'failed', code: 'provider_response_invalid' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops a hanging tool at the deadline and ignores its late result', async () => {
    let resolveTool!: (value: { content: readonly [{ type: 'text'; text: string }] }) => void;
    const toolPromise = new Promise<{ content: readonly [{ type: 'text'; text: string }] }>(
      (resolve) => {
        resolveTool = resolve;
      }
    );
    const onTextIncrement = vi.fn();
    const tool: AgentTool = {
      name: 'environment.status',
      description: 'Read status.',
      inputSchema: { type: 'object' },
      execute: () => toolPromise,
    };
    const result = await runInternalAgentLoop(
      {
        ...input([tool]),
        limits: { maxModelTurns: 2, maxToolCalls: 2, deadlineMs: 10 },
        onTextIncrement,
      },
      vi.fn().mockImplementation(async (request) => {
        request.onTextIncrement?.('starting');
        return {
          message: assistantMessage([
            { type: 'toolCall', callId: 'hang', name: tool.name, arguments: {} },
          ]),
        };
      })
    );
    resolveTool({ content: [{ type: 'text', text: 'late' }] });
    await Promise.resolve();

    expect(result).toMatchObject({ kind: 'limit_reached', limit: 'deadline' });
    expect(onTextIncrement).toHaveBeenCalledWith('starting');
    expect(result.messages).not.toContainEqual(
      expect.objectContaining({ role: 'tool', content: [{ type: 'text', text: 'late' }] })
    );
  });

  it('discards a Provider result when the caller cancels before it settles', async () => {
    const controller = new AbortController();
    const initial = input();
    const call = vi.fn(async () => {
      // Cancel after the dependency race settles, before the loop consumes its result.
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return { message: assistantMessage([{ type: 'text', text: 'Too late.' }]) };
    });

    const result = await runInternalAgentLoop({ ...initial, signal: controller.signal }, call);

    expect(result).toEqual({ kind: 'aborted', messages: initial.messages });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('discards a Tool result when the closure cancels its run', async () => {
    const controller = new AbortController();
    const tool: AgentTool = {
      name: 'environment.status',
      description: 'Read status.',
      inputSchema: { type: 'object' },
      execute: async () => {
        queueMicrotask(() => queueMicrotask(() => controller.abort()));
        return { content: [{ type: 'text', text: 'Too late.' }] };
      },
    };
    const message = assistantMessage([
      { type: 'toolCall', callId: 'cancel', name: tool.name, arguments: {} },
    ]);
    const initial = input([tool]);
    const call = vi.fn(async () => ({ message }));

    const result = await runInternalAgentLoop({ ...initial, signal: controller.signal }, call);

    expect(result).toEqual({ kind: 'aborted', messages: [...initial.messages, message] });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each(['quiescent', 'failed', 'limit_reached'] as const)(
    'ignores saved text callbacks after a %s exit',
    async (kind) => {
      let emit!: NonNullable<InternalAgentProviderRequest['onTextIncrement']>;
      const onTextIncrement = vi.fn();
      const call = vi.fn(async (request: InternalAgentProviderRequest) => {
        emit = request.onTextIncrement!;
        emit('Before exit.');
        if (kind === 'failed') throw new Error('Provider failed.');
        return {
          message: assistantMessage(
            kind === 'limit_reached'
              ? [{ type: 'toolCall', callId: 'unknown', name: 'unavailable', arguments: {} }]
              : [{ type: 'text', text: 'Done.' }]
          ),
        };
      });
      const initial = input();

      const result = await runInternalAgentLoop(
        { ...initial, limits: { ...initial.limits, maxModelTurns: 1 }, onTextIncrement },
        call
      );
      emit('After exit.');

      expect(result.kind).toBe(kind);
      expect(call).toHaveBeenCalledTimes(1);
      expect(onTextIncrement.mock.calls).toEqual([['Before exit.']]);
    }
  );

  it('keeps the first cancellation cause when a deadline precedes caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const initial = input();
      const call = vi.fn(() => new Promise<never>(() => undefined));
      const running = runInternalAgentLoop(
        {
          ...initial,
          signal: controller.signal,
          limits: { ...initial.limits, deadlineMs: 10 },
        },
        call
      );
      vi.advanceTimersByTime(10);
      controller.abort();

      expect(await running).toEqual({
        kind: 'limit_reached',
        limit: 'deadline',
        messages: initial.messages,
      });
      expect(call).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts model-visible tool text and ignores observer failures', async () => {
    const tool: AgentTool = {
      name: 'environment.status',
      description: 'Read status.',
      inputSchema: { type: 'object' },
      execute: async () => ({
        content: [{ type: 'text', text: 'authorization: Bearer secret-value token=abc123' }],
        details: { private: 'must stay server-side' },
      }),
    };
    const call = vi
      .fn()
      .mockImplementationOnce(async (request) => {
        request.onTextIncrement?.('ignored observer exception');
        return {
          message: assistantMessage([
            { type: 'toolCall', callId: 'safe', name: tool.name, arguments: {} },
          ]),
        };
      })
      .mockResolvedValueOnce({ message: assistantMessage([{ type: 'text', text: 'Done.' }]) });

    const result = await runInternalAgentLoop(
      {
        ...input([tool]),
        onTextIncrement: () => {
          throw new Error('disconnected');
        },
      },
      call
    );

    expect(result.kind).toBe('quiescent');
    expect(JSON.stringify(call.mock.calls[1]?.[0].messages)).not.toContain('secret-value');
    expect(JSON.stringify(call.mock.calls[1]?.[0].messages)).not.toContain('abc123');
    expect(JSON.stringify(call.mock.calls[1]?.[0].messages)).not.toContain('must stay server-side');
  });
});
