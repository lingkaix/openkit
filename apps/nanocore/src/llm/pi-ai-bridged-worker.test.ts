import {
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUnsupportedFeatureError } from './gateway-converters.js';
import { PiAiGatewayClient } from './pi-ai-client.js';

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

describe('bridged worker Responses function tools', () => {
  it('advertises function-only additional_tools on a chat-native bridge', async () => {
    let providerCalls = 0;
    let seenContext: Context | undefined;
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
    expect(seenContext?.tools).toEqual([
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

  it('rejects custom additional_tools before the bridged provider effect', async () => {
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
        workerResponsesRequest([EXEC_CUSTOM]),
        undefined,
        {},
        models
      )
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
    expect(providerCalls).toBe(0);
  });

  it('rejects mixed function and custom additional_tools before the bridged provider effect', async () => {
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
        workerResponsesRequest([READ_FILE_FUNCTION, EXEC_CUSTOM]),
        undefined,
        {},
        models
      )
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
    expect(providerCalls).toBe(0);
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
