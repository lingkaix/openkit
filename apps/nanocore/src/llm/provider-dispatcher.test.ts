import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { CodexResponsesClient } from './codex-responses-client.js';
import { GatewayUsageTracker } from './gateway-usage.js';
import type {
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

/**
 * Creates a pi-ai-backed provider config for dispatcher tests.
 *
 * @returns Resolved provider config.
 */
function piProviderConfig(
  input: Partial<ResolvedLLMProviderConfig> = {}
): ResolvedLLMProviderConfig {
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

describe('LLMGatewayProviderDispatcher pi-ai routing', () => {
  it('routes pi-ai backend chat completions through the pi-ai client', async () => {
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('dispatcher ok', { responseId: 'resp_dispatcher' })]);
    const usageTracker = new GatewayUsageTracker();
    const onUsage = vi.fn();
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
      usageTracker,
    });

    const response = await dispatcher.createChatCompletion(
      piProviderConfig(),
      {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      { onUsage }
    );

    expect(response.choices[0]?.message.content).toBe('dispatcher ok');
    expect(faux.state.callCount).toBe(1);
    expect(onUsage).toHaveBeenCalledOnce();
    expect(usageTracker.snapshot().summaries[0]?.requestCount).toBe(1);
  });

  it('honors the provider capability matrix before calling the pi-ai client', async () => {
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const provider = piProviderConfig({
      gatewayCapabilities: { chatCompletions: 'unsupported', responses: 'unsupported' },
    });
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
    });

    await expect(
      dispatcher.createChatCompletion(provider, {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
    expect(faux.state.callCount).toBe(0);
  });

  it('routes pi-ai backend chat completion streams through the pi-ai client', async () => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('dispatcher stream')]);
    const usageTracker = new GatewayUsageTracker();
    const onUsage = vi.fn();
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
      usageTracker,
    });

    const stream = await dispatcher.createChatCompletionStream(
      piProviderConfig(),
      {
        model: 'faux-chat',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
        prompt_cache_key: 'private-cache-key',
        prompt_cache_retention: 'long',
      },
      { onUsage }
    );

    const body = await new Response(stream).text();

    expect(body).toContain('dispatcher stream');
    expect(body).not.toMatch(/cacheWrite|"cost"|private-cache-key/);
    expect(faux.state.callCount).toBe(1);
    expect(onUsage).toHaveBeenCalledOnce();
    expect(usageTracker.snapshot().summaries[0]?.requestCount).toBe(1);
  });

  it.each([
    { message: 'terminal provider error', stopReason: 'error' as const },
    { message: 'terminal provider abort', stopReason: 'aborted' as const },
  ])('records $stopReason stream usage exactly once without leaking private usage', async (testCase) => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat', cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 } }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('partial dispatcher stream', {
        errorMessage: testCase.message,
        stopReason: testCase.stopReason,
      }),
    ]);
    const usageTracker = new GatewayUsageTracker();
    const onUsage = vi.fn();
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
      usageTracker,
    });
    const stream = await dispatcher.createChatCompletionStream(
      piProviderConfig(),
      {
        model: 'faux-chat',
        messages: [{ role: 'user', content: 'Hello' }],
        prompt_cache_key: 'private-cache-key',
        prompt_cache_retention: 'long',
        stream: true,
      },
      { onUsage }
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let streamError: unknown;

    try {
      while (true) {
        const result = await reader.read();

        if (result.done) {
          break;
        }
        body += decoder.decode(result.value, { stream: true });
      }
    } catch (error) {
      streamError = error;
    }

    expect(streamError).toMatchObject({ message: testCase.message });
    expect(body).not.toMatch(/cacheWrite|"cost"|private-cache-key/);
    expect(onUsage).toHaveBeenCalledOnce();
    expect(usageTracker.snapshot().summaries[0]?.requestCount).toBe(1);
  });

  it('bridges pi-ai backend Responses requests through the pi-ai chat client', async () => {
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('dispatcher responses')]);
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
    });

    const response = await dispatcher.createResponses(piProviderConfig(), {
      model: 'faux-chat',
      input: 'Hello',
    });

    expect(response).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [{ content: [{ text: 'dispatcher responses' }] }],
    });
    expect(faux.state.callCount).toBe(1);
  });

  it('routes native pi-ai backend Responses requests through the pi-ai responses client', async () => {
    class NativeResponsesClient extends PiAiGatewayClient {
      public callCount = 0;

      /**
       * Creates a native test Responses payload.
       *
       * @param _provider Resolved provider config.
       * @param request Responses request.
       * @returns OpenAI-compatible Responses payload.
       */
      public async createResponses(
        _provider: ResolvedLLMProviderConfig,
        request: OpenAICompatibleResponsesRequest
      ): Promise<OpenAICompatibleResponsesResponse> {
        this.callCount += 1;
        return {
          id: 'resp_native_pi',
          object: 'response',
          status: 'completed',
          model: request.model,
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'native ok' }] }],
        };
      }
    }

    const piAiClient = new NativeResponsesClient();
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient,
    });

    const response = await dispatcher.createResponses(
      piProviderConfig({
        gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
      }),
      {
        model: 'faux-chat',
        input: 'Hello',
      }
    );

    expect(response.output?.[0]).toMatchObject({
      content: [{ text: 'native ok' }],
    });
    expect(piAiClient.callCount).toBe(1);
  });

  it('bridges pi-ai backend Responses streams through the pi-ai chat client', async () => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('dispatcher response stream')]);
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
    });

    const stream = await dispatcher.createResponsesStream(piProviderConfig(), {
      model: 'faux-chat',
      input: 'Hello',
      stream: true,
    });

    const body = await new Response(stream).text();

    expect(body).toContain('response.output_text.delta');
    expect(body).toContain('dispatcher response stream');
    expect(body).toContain('data: [DONE]');
    expect(faux.state.callCount).toBe(1);
  });
});

describe('LLMGatewayProviderDispatcher Codex usage', () => {
  it('records public non-stream and stream usage exactly once per request', async () => {
    const codexResponsesClient = new CodexResponsesClient({
      tokenResolver: {
        resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
      },
    });
    vi.spyOn(codexResponsesClient, 'createResponses').mockResolvedValue({
      id: 'resp_codex_usage',
      object: 'response',
      status: 'completed',
      model: 'gpt-test',
      output: [],
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    });
    vi.spyOn(codexResponsesClient, 'createResponsesStream').mockResolvedValue(
      new Response(
        'data: {"type":"response.completed","response":{"id":"resp_codex_stream_usage","object":"response","status":"completed","model":"gpt-test","output":[],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\ndata: [DONE]\n\n'
      ).body!
    );
    const usageTracker = new GatewayUsageTracker();
    const dispatcher = new LLMGatewayProviderDispatcher({ codexResponsesClient, usageTracker });
    const provider = piProviderConfig({
      adapterId: 'openai_codex',
      apiKey: null,
      backend: 'codex-oauth',
      displayName: 'OpenAI Codex',
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      id: 'openai_codex',
      requiresApiKey: false,
    });
    const nonstreamOnUsage = vi.fn();

    await dispatcher.createResponses(
      provider,
      { input: 'Hello', model: 'gpt-test' },
      { onUsage: nonstreamOnUsage }
    );

    expect(nonstreamOnUsage).toHaveBeenCalledOnce();
    expect(nonstreamOnUsage).toHaveBeenCalledWith({
      input_tokens: 8,
      output_tokens: 2,
      total_tokens: 10,
    });
    expect(usageTracker.snapshot().summaries[0]?.requestCount).toBe(1);

    const streamOnUsage = vi.fn();
    const stream = await dispatcher.createResponsesStream(
      provider,
      { input: 'Hello', model: 'gpt-test', stream: true },
      { onUsage: streamOnUsage }
    );

    await new Response(stream).text();

    expect(streamOnUsage).toHaveBeenCalledOnce();
    expect(streamOnUsage).toHaveBeenCalledWith({
      input_tokens: 5,
      output_tokens: 1,
      total_tokens: 6,
    });
    expect(usageTracker.snapshot().summaries[0]?.requestCount).toBe(2);
  });
});
