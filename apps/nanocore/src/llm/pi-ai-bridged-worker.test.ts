import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentTools,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUnsupportedFeatureError, PiAiGatewayClient } from './pi-ai-client.js';

/**
 * Chat-native bridged provider used as the worker-inference Responses test double.
 *
 * `subscriptionProviderId` is only the faux pi-ai Models lookup key. It is not an OAuth
 * subscription profile and does not claim catalog `tool_call` metadata for any live Orca id.
 */
function bridgedChatNativeProvider(): ResolvedLLMProviderConfig {
  return {
    adapterId: 'orcarouter-bridged',
    apiKey: 'bridged-secret',
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'Bridged Chat Native',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    id: 'orcarouter-bridged',
    models: ['faux-bridged-chat'],
    requiresApiKey: true,
    subscriptionProviderId: 'orcarouter-bridged',
  } as unknown as ResolvedLLMProviderConfig;
}

/**
 * Builds one worker-inference Responses request after current additional_tools lowering.
 *
 * @param tools Message-anchored local tool declarations.
 * @returns OpenAI-compatible Responses stream request with empty top-level tools.
 */
function workerResponsesRequest(tools: readonly Record<string, unknown>[]) {
  return {
    input: [
      { role: 'developer', tools, type: 'additional_tools' },
      { content: [{ text: 'Read README.md at git HEAD.', type: 'input_text' }], role: 'user' },
    ],
    model: 'faux-bridged-chat',
    store: false,
    stream: true,
    tools: [],
  };
}

const READ_FILE_FUNCTION = {
  description: 'Read one file from the attached workspace.',
  name: 'read_file',
  parameters: {
    properties: { path: { type: 'string' } },
    required: ['path'],
    type: 'object',
  },
  strict: false,
  type: 'function',
} as const;

const EXEC_CUSTOM = {
  description: 'Run one command.',
  format: { type: 'text' },
  name: 'exec',
  type: 'custom',
} as const;

describe('bridged worker Responses local tools', () => {
  it('advertises function-only additional_tools on a chat-native bridge', async () => {
    let providerCalls = 0;
    let seenContext: TranscriptContext | undefined;
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (context) => {
        providerCalls += 1;
        seenContext = context;
        return fauxAssistantMessage(
          [fauxToolCall('read_file', { path: 'README.md' }, { id: 'call_read' }), fauxText('ok')],
          { stopReason: 'toolUse' }
        );
      },
    ]);

    const stream = await new PiAiGatewayClient().createResponsesStream(
      bridgedChatNativeProvider(),
      workerResponsesRequest([READ_FILE_FUNCTION]),
      undefined,
      {},
      models
    );
    const body = await new Response(stream).text();
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);

    expect(providerCalls).toBe(1);
    expect(seenContext ? getCurrentTools(seenContext.messages) : undefined).toEqual([
      expect.objectContaining({
        description: READ_FILE_FUNCTION.description,
        name: 'read_file',
      }),
    ]);
    expect(events.map((event) => event.type)).toContain('response.function_call_arguments.done');
    expect(events.some((event) => event.type === 'response.custom_tool_call_input.done')).toBe(
      false
    );
  });

  it('round-trips custom additional_tools calls and results through the chat-native bridge', async () => {
    const contexts: TranscriptContext[] = [];
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (context) => {
        contexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall('exec', { input: 'pwd' }, { id: 'call_exec|ctc_exec' }),
          { stopReason: 'toolUse' }
        );
      },
      async (context) => {
        contexts.push(context);
        return fauxAssistantMessage('Directory checked.');
      },
    ]);

    const client = new PiAiGatewayClient();
    const request = { ...workerResponsesRequest([EXEC_CUSTOM]), stream: false };
    const response = await client.createResponses(
      bridgedChatNativeProvider(),
      request,
      undefined,
      {},
      models
    );
    expect(response).toMatchObject({
      status: 'completed',
      output: [
        {
          type: 'custom_tool_call',
          id: 'ctc_exec',
          call_id: 'call_exec',
          name: 'exec',
          input: 'pwd',
        },
      ],
    });
    expect(getCurrentTools(contexts[0]!.messages)).toMatchObject([
      {
        name: 'exec',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      },
    ]);
    const continuation = await client.createResponses(
      bridgedChatNativeProvider(),
      {
        ...request,
        input: [
          ...request.input,
          ...response.output,
          { type: 'custom_tool_call_output', call_id: 'call_exec', output: '/workspace' },
        ],
      },
      undefined,
      {},
      models
    );
    expect(continuation).toMatchObject({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Directory checked.' }] }],
    });
    expect(contexts[1]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_exec|ctc_exec',
              name: 'exec',
              arguments: { input: 'pwd' },
            },
          ],
        }),
        expect.objectContaining({
          role: 'toolResult',
          toolCallId: 'call_exec|ctc_exec',
          toolName: 'exec',
          content: [{ type: 'text', text: '/workspace' }],
        }),
      ])
    );
    expect(faux.state.callCount).toBe(2);
  });

  it('streams mixed function and namespaced custom tools with their public identities', async () => {
    let seenContext: TranscriptContext | undefined;
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (context) => {
        seenContext = context;
        const tools = getCurrentTools(context.messages);
        const custom = tools.find((tool) => tool.name !== 'read_file');
        expect(custom).toMatchObject({
          parameters: { properties: { input: { type: 'string' } }, required: ['input'] },
        });
        return fauxAssistantMessage(
          [
            fauxToolCall('read_file', { path: 'README.md' }, { id: 'call_read|fc_read' }),
            fauxToolCall(custom!.name, { input: 'pwd' }, { id: 'call_shell|ctc_shell' }),
          ],
          { stopReason: 'toolUse' }
        );
      },
    ]);

    const stream = await new PiAiGatewayClient().createResponsesStream(
      bridgedChatNativeProvider(),
      workerResponsesRequest([
        READ_FILE_FUNCTION,
        { type: 'namespace', name: 'shell', tools: [EXEC_CUSTOM] },
      ]),
      undefined,
      {},
      models
    );
    const body = await new Response(stream).text();
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(events.at(-1)?.type).toBe('response.completed');
    expect(events.filter((event) => event.type === 'response.completed')).toHaveLength(1);
    const response = events.at(-1).response;
    expect(response).toMatchObject({
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: 'fc_read',
          call_id: 'call_read',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
        {
          type: 'custom_tool_call',
          id: 'ctc_shell',
          call_id: 'call_shell',
          namespace: 'shell',
          name: 'exec',
          input: 'pwd',
        },
      ],
    });
    const customDeltas = events.filter(
      (event) => event.type === 'response.custom_tool_call_input.delta'
    );
    expect(customDeltas.map((event) => event.delta).join('')).toBe('pwd');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.custom_tool_call_input.done',
        item_id: 'ctc_shell',
        output_index: 1,
        input: 'pwd',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_read',
        output_index: 0,
        arguments: '{"path":"README.md"}',
      })
    );
    expect(
      events
        .filter((event) => event.type === 'response.output_item.done')
        .map((event) => event.item)
    ).toMatchObject(response.output);
    for (const event of events) {
      if (event.item) expect(event.item.id).toBe(response.output[event.output_index]?.id);
      if (event.item_id) expect(event.item_id).toBe(response.output[event.output_index]?.id);
    }
    expect(seenContext ? getCurrentTools(seenContext.messages) : undefined).toHaveLength(2);
    expect(faux.state.callCount).toBe(1);
  });

  it('rejects native Responses builtins in additional_tools before the bridged provider effect', async () => {
    let providerCalls = 0;
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async () => {
        providerCalls += 1;
        return fauxAssistantMessage('should not run');
      },
    ]);

    await expect(
      new PiAiGatewayClient().createResponsesStream(
        bridgedChatNativeProvider(),
        workerResponsesRequest([{ name: 'web_search', type: 'web_search' }]),
        undefined,
        {},
        models
      )
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
    expect(providerCalls).toBe(0);
  });
});
