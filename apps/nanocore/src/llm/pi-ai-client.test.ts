import { readFileSync } from 'node:fs';

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
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUnsupportedFeatureError } from './gateway-converters.js';
import {
  createDefaultPiAiGatewayModels,
  PiAiGatewayClient,
  PiAiGatewayConfigurationError,
} from './pi-ai-client.js';

/**
 * Creates a pi-ai-backed provider config for adapter tests.
 *
 * @param input Provider field overrides.
 * @returns Resolved provider config.
 */
function providerConfig(input: Partial<ResolvedLLMProviderConfig> = {}): ResolvedLLMProviderConfig {
  return {
    adapterId: 'anthropic',
    apiKey: 'explicit-secret',
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'Anthropic',
    extraBody: {},
    extraHeaders: {},
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    id: 'anthropic_primary',
    requiresApiKey: true,
    ...input,
  };
}

describe('PiAiGatewayClient', () => {
  it('keeps the pi-ai dependency exact-pinned and importable inside nanocore', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { dependencies: Record<string, string> };
    const version = packageJson.dependencies['@earendil-works/pi-ai'];

    expect(version).toBe('0.80.3');
    expect(version).not.toMatch(/^[~^]/);
    await expect(import('@earendil-works/pi-ai')).resolves.toHaveProperty('createModels');
  });

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

  it('does not forward Codex turn state through non-Codex pi-ai providers', async () => {
    let seenOptions: (StreamOptions & Record<string, unknown>) | undefined;
    const turnStates: string[] = [];
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (_context, options) => {
        seenOptions = options as StreamOptions & Record<string, unknown>;
        await options?.onResponse?.(
          {
            headers: {
              'x-codex-turn-state': 'pi-response-state',
              'x-request-id': 'private-provider-request-id',
            },
            status: 200,
          },
          faux.provider.getModels()[0]!
        );
        return fauxAssistantMessage('turn state ok');
      },
    ]);

    await new PiAiGatewayClient({ models }).createChatCompletion(
      providerConfig(),
      {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Preserve turn state' }],
      },
      undefined,
      {
        codexTurnState: 'pi-request-state',
        onCodexTurnState: (turnState) => turnStates.push(turnState),
      }
    );

    expect(seenOptions?.headers).toBeUndefined();
    expect(seenOptions?.onResponse).toBeUndefined();
    expect(turnStates).toEqual([]);
  });

  it('does not expose streaming Codex turn state through non-Codex pi-ai providers', async () => {
    const turnStates: string[] = [];
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
      tokensPerSecond: 100,
      tokenSize: { min: 100, max: 100 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (_context, options) => {
        await options?.onResponse?.(
          {
            headers: { 'x-codex-turn-state': 'pi-stream-response-state' },
            status: 200,
          },
          faux.provider.getModels()[0]!
        );
        return fauxAssistantMessage('stream state ready');
      },
    ]);

    const stream = await new PiAiGatewayClient({ models }).createChatCompletionStream(
      providerConfig(),
      {
        messages: [{ role: 'user', content: 'Preserve stream state' }],
        model: 'faux-chat',
        stream: true,
      },
      undefined,
      { onCodexTurnState: (turnState) => turnStates.push(turnState) }
    );

    await expect(new Response(stream).text()).resolves.toContain('stream state ready');
    expect(turnStates).toEqual([]);
  });

  it('registers a custom OpenAI-compatible provider model when pi-ai has no catalog entry', () => {
    const models = createModels();
    const customProvider = providerConfig({
      adapterId: 'custom-proxy',
      id: 'custom-proxy',
      displayName: 'Custom Proxy',
      baseUrl: 'https://proxy.example/v1',
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

  it('binds adapter models to the configured instance endpoint and auth boundary', async () => {
    const models = createDefaultPiAiGatewayModels();
    const provider = providerConfig({
      adapterId: 'openai',
      apiKey: null,
      baseUrl: 'https://proxy.example/v1',
      gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
      id: 'proxy-openai',
      requiresApiKey: false,
    });
    const client = new PiAiGatewayClient({ models }) as unknown as {
      resolveModel(provider: ResolvedLLMProviderConfig, modelId: string): Model<string>;
    };
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-secret';

    try {
      const model = client.resolveModel(provider, 'gpt-5.1');

      expect(model).toMatchObject({
        baseUrl: 'https://proxy.example/v1',
        provider: 'proxy-openai',
      });
      await expect(models.getAuth(model)).resolves.toBeUndefined();

      expect(client.resolveModel(provider, 'private-gpt')).toMatchObject({
        api: 'openai-responses',
        baseUrl: 'https://proxy.example/v1',
        provider: 'proxy-openai',
      });
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it('prefers the adapter identity over a colliding configured instance id', () => {
    const client = new PiAiGatewayClient() as unknown as {
      lookupProviderIds(provider: ResolvedLLMProviderConfig): string[];
    };

    expect(
      client.lookupProviderIds(
        providerConfig({
          adapterId: 'anthropic',
          id: 'openai',
        })
      )
    ).toEqual(['anthropic', 'openai']);
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

  it('observes raw terminal usage exactly once for a successful completion', async () => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [
        {
          id: 'faux-chat',
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
        },
      ],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('usage observed')]);
    const observed: unknown[] = [];

    await new PiAiGatewayClient({ models }).createChatCompletion(
      providerConfig(),
      {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Observe usage' }],
        prompt_cache_key: 'private-cache-key',
        prompt_cache_retention: 'long',
      },
      (usage: unknown) => observed.push(usage)
    );

    expect(observed).toEqual([
      expect.objectContaining({
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
        cost: expect.objectContaining({ total: expect.any(Number) }),
        input: expect.any(Number),
        output: expect.any(Number),
      }),
    ]);
    expect((observed[0] as { cacheWrite: number }).cacheWrite).toBeGreaterThan(0);
    expect((observed[0] as { cost: { total: number } }).cost.total).toBe(0);
  });

  it.each([
    { message: 'terminal provider error', stopReason: 'error' as const },
    { message: 'terminal provider abort', stopReason: 'aborted' as const },
  ])('observes raw usage exactly once for a $stopReason stream', async (testCase) => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [
        {
          id: 'faux-chat',
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
        },
      ],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('partially consumed usage', {
        errorMessage: testCase.message,
        stopReason: testCase.stopReason,
      }),
    ]);
    const observed: unknown[] = [];

    const stream = await new PiAiGatewayClient({ models }).createChatCompletionStream(
      providerConfig(),
      {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Observe terminal usage' }],
        prompt_cache_key: 'private-cache-key',
        prompt_cache_retention: 'long',
        stream: true,
      },
      (usage: unknown) => observed.push(usage)
    );

    await expect(new Response(stream).text()).rejects.toThrow(testCase.message);
    expect(observed).toEqual([
      expect.objectContaining({
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
        cost: expect.objectContaining({ total: expect.any(Number) }),
        input: expect.any(Number),
        output: expect.any(Number),
      }),
    ]);
    expect((observed[0] as { cacheWrite: number }).cacheWrite).toBeGreaterThan(0);
    expect((observed[0] as { cost: { total: number } }).cost.total).toBe(0);
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

  it('passes the caller signal to pi-ai and aborts its local signal on downstream cancellation', async () => {
    const callerAbortController = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
      tokensPerSecond: 100,
      tokenSize: { min: 1, max: 1 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      (_context, options) => {
        upstreamSignal = options?.signal;
        return fauxAssistantMessage('slow stream');
      },
    ]);
    const stream = await new PiAiGatewayClient({ models }).createChatCompletionStream(
      providerConfig(),
      {
        model: 'faux-chat',
        stream: true,
        messages: [{ role: 'user', content: 'Cancel after start' }],
      },
      undefined,
      { signal: callerAbortController.signal }
    );
    const reader = stream.getReader();

    await reader.read();
    await reader.cancel('consumer disconnected');

    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal).not.toBe(callerAbortController.signal);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(callerAbortController.signal.aborted).toBe(false);
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
        new PiAiGatewayClient({ models }).createChatCompletion(providerConfig({ apiKey: null }), {
          model: 'faux-chat',
          messages: [{ role: 'user', content: 'Hello' }],
        })
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
