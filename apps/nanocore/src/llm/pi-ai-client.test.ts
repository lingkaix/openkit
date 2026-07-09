import {
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { GatewayUnsupportedFeatureError } from './gateway-converters.js';
import {
  createDefaultPiAiGatewayModels,
  PiAiGatewayClient,
  PiAiGatewayConfigurationError,
} from './pi-ai-client.js';
import type { ResolvedLLMProviderConfig } from './provider-config.js';
import type { LLMProviderSpec } from './provider-registry.js';

/**
 * Creates a pi-ai-backed provider config for adapter tests.
 *
 * @param input Provider field overrides.
 * @returns Resolved provider config.
 */
function providerConfig(input: Partial<ResolvedLLMProviderConfig> = {}): ResolvedLLMProviderConfig {
  const spec: LLMProviderSpec = {
    id: 'anthropic',
    displayName: 'Anthropic',
    backend: 'pi-ai',
    defaultBaseUrl: null,
    envKey: 'ANTHROPIC_API_KEY',
    modelKeywords: ['claude'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: false,
    extraBodyAllowed: false,
  };

  return {
    id: 'anthropic_primary',
    specId: 'anthropic',
    displayName: 'Anthropic',
    model: 'faux-chat',
    baseUrl: null,
    hasApiKey: true,
    apiKeySource: 'stored',
    gatewayCapabilities: spec.gatewayCapabilities,
    extraHeaders: {},
    extraBody: {},
    spec,
    apiKey: 'explicit-secret',
    ...input,
  };
}

describe('PiAiGatewayClient', () => {
  it('registers Anthropic models in the default pi-ai collection', () => {
    const models = createDefaultPiAiGatewayModels();

    expect(models.getModel('anthropic', 'claude-3-5-sonnet-20241022')).toMatchObject({
      provider: 'anthropic',
      api: 'anthropic-messages',
    });
  });

  it('registers runtime provider families routed through pi-ai', () => {
    const models = createDefaultPiAiGatewayModels();

    expect(models.getModel('google', 'gemini-2.5-pro')).toMatchObject({
      provider: 'google',
    });
    expect(models.getModel('openrouter', 'openai/gpt-5.1')).toMatchObject({
      provider: 'openrouter',
    });
    expect(models.getModel('xai', 'grok-4.3')).toMatchObject({
      provider: 'xai',
    });
  });

  it('registers a custom OpenAI-compatible provider model when pi-ai has no catalog entry', () => {
    const models = createModels();
    const customProvider = providerConfig({
      id: 'custom-proxy',
      specId: 'custom-proxy',
      displayName: 'Custom Proxy',
      model: 'custom-chat',
      baseUrl: 'https://proxy.example/v1',
      spec: {
        ...providerConfig().spec,
        id: 'custom-proxy',
        displayName: 'Custom Proxy',
        defaultBaseUrl: 'https://proxy.example/v1',
      },
    });

    const client = new PiAiGatewayClient({ models }) as unknown as {
      resolveModel(provider: ResolvedLLMProviderConfig, modelId: string): Model<string>;
    };
    const model = client.resolveModel(customProvider, 'custom-chat');

    expect(model).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://proxy.example/v1',
      id: 'custom-chat',
      provider: 'custom-proxy',
    });
    expect(models.getProvider('custom-proxy')).toMatchObject({
      id: 'custom-proxy',
      baseUrl: 'https://proxy.example/v1',
    });
  });

  it('maps a pi-ai completion to an OpenAI-compatible chat response', async () => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('adapter ok', {
        responseId: 'resp_pi_1',
        stopReason: 'stop',
        timestamp: 1783260591000,
      }),
    ]);

    const response = await new PiAiGatewayClient({ models }).createChatCompletion(
      providerConfig(),
      {
        model: 'faux-chat',
        messages: [
          { role: 'system', content: 'System rule' },
          { role: 'developer', content: 'Developer rule' },
          { role: 'user', content: 'Say hello' },
        ],
        prompt_cache_key: 'cache-key-1',
        prompt_cache_retention: 'long',
        temperature: 0.2,
      }
    );

    expect(response).toMatchObject({
      id: 'chatcmpl_resp_pi_1',
      object: 'chat.completion',
      created: 1783260591,
      model: 'faux-chat',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'adapter ok' },
          finish_reason: 'stop',
        },
      ],
    });
    expect(response.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
  });

  it('maps chat function tools and tool choice into the pi-ai request', async () => {
    let seenContext: Context | undefined;
    let seenOptions: (StreamOptions & Record<string, unknown>) | undefined;
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      (context, options) => {
        seenContext = context;
        seenOptions = options as StreamOptions & Record<string, unknown>;
        return fauxAssistantMessage('tool ready');
      },
    ]);

    await new PiAiGatewayClient({ models }).createChatCompletion(providerConfig(), {
      model: 'faux-chat',
      messages: [
        { role: 'user', content: 'Search the docs' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_previous',
              type: 'function',
              function: { name: 'search_docs', arguments: '{"query":"previous"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_previous', content: 'Previous result' },
      ],
      tool_choice: { type: 'function', function: { name: 'search_docs' } },
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search project documentation.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        },
      ],
    });

    expect(seenContext?.tools).toEqual([
      {
        name: 'search_docs',
        description: 'Search project documentation.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]);
    expect(seenContext?.messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call_previous',
          name: 'search_docs',
          arguments: { query: 'previous' },
        },
      ],
      stopReason: 'toolUse',
    });
    expect(seenOptions?.toolChoice).toEqual({ type: 'tool', name: 'search_docs' });
  });

  it('maps pi-ai tool calls to OpenAI-compatible chat tool calls', async () => {
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('search_docs', { query: 'OpenKit' }, { id: 'call_search' })],
        {
          responseId: 'resp_tool_pi_1',
          stopReason: 'toolUse',
          timestamp: 1783260591000,
        }
      ),
    ]);

    const response = await new PiAiGatewayClient({ models }).createChatCompletion(
      providerConfig(),
      {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Search the docs' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'search_docs',
              description: 'Search project documentation.',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }
    );

    expect(response.choices[0]?.finish_reason).toBe('tool_calls');
    expect(response.choices[0]?.message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_search',
          type: 'function',
          function: { name: 'search_docs', arguments: '{"query":"OpenKit"}' },
        },
      ],
    });
  });

  it('maps a pi-ai stream to OpenAI-compatible chat SSE chunks', async () => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('stream ok', {
        responseId: 'resp_stream_pi_1',
        stopReason: 'stop',
        timestamp: 1783260591000,
      }),
    ]);

    const stream = await new PiAiGatewayClient({ models }).createChatCompletionStream(
      providerConfig(),
      {
        model: 'faux-chat',
        stream: true,
        messages: [{ role: 'user', content: 'Stream hello' }],
      }
    );
    const body = await new Response(stream).text();

    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain('"content":"stream ok"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"usage":{"prompt_tokens"');
    expect(body).toContain('data: [DONE]');
  });

  it('maps pi-ai stream tool calls to OpenAI-compatible chat SSE chunks', async () => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('search_docs', { query: 'OpenKit' }, { id: 'call_stream' })],
        {
          responseId: 'resp_stream_tool_pi_1',
          stopReason: 'toolUse',
          timestamp: 1783260591000,
        }
      ),
    ]);

    const stream = await new PiAiGatewayClient({ models }).createChatCompletionStream(
      providerConfig(),
      {
        model: 'faux-chat',
        stream: true,
        messages: [{ role: 'user', content: 'Search the docs' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'search_docs',
              description: 'Search project documentation.',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }
    );
    const body = await new Response(stream).text();

    expect(body).toContain(
      '"tool_calls":[{"index":0,"id":"call_stream","type":"function","function":{"name":"search_docs","arguments":""}}]'
    );
    expect(body).toContain(
      '"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"OpenKit\\"}"}}]'
    );
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('data: [DONE]');
  });

  it('fails closed before pi-ai can read ambient provider credentials', async () => {
    const oldKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'canary-ambient-key';
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);

    try {
      await expect(
        new PiAiGatewayClient({ models }).createChatCompletion(
          providerConfig({ apiKey: null, hasApiKey: false, apiKeySource: 'missing' }),
          { model: 'faux-chat', messages: [{ role: 'user', content: 'Hello' }] }
        )
      ).rejects.toBeInstanceOf(PiAiGatewayConfigurationError);
      expect(faux.state.callCount).toBe(0);
    } finally {
      if (oldKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = oldKey;
      }
    }
  });

  it('rejects unsupported chat fields instead of silently dropping them', async () => {
    const client = new PiAiGatewayClient({ models: createModels() });

    await expect(
      client.createChatCompletion(providerConfig(), {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Hello' }],
        logprobs: true,
      })
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
  });
});
