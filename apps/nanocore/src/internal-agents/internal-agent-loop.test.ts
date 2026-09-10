import { describe, expect, it, vi } from 'vitest';

import {
  type AgentAssistantMessage,
  type AgentMessage,
  type AgentTool,
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
