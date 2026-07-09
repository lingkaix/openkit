import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { CodexResponsesClient } from './codex-responses-client.js';
import type {
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import type { ResolvedLLMProviderConfig } from './provider-config.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';
import type { LLMProviderSpec } from './provider-registry.js';

/**
 * Creates a pi-ai-backed provider config for dispatcher tests.
 *
 * @returns Resolved provider config.
 */
function piProviderConfig(
  input: Partial<ResolvedLLMProviderConfig> = {}
): ResolvedLLMProviderConfig {
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

describe('LLMGatewayProviderDispatcher pi-ai routing', () => {
  it('routes pi-ai backend chat completions through the pi-ai client', async () => {
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('dispatcher ok', { responseId: 'resp_dispatcher' })]);
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
    });

    const response = await dispatcher.createChatCompletion(piProviderConfig(), {
      model: 'faux-chat',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(response.choices[0]?.message.content).toBe('dispatcher ok');
    expect(faux.state.callCount).toBe(1);
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
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
    });

    const stream = await dispatcher.createChatCompletionStream(piProviderConfig(), {
      model: 'faux-chat',
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    await expect(new Response(stream).text()).resolves.toContain('dispatcher stream');
    expect(faux.state.callCount).toBe(1);
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
        spec: {
          ...piProviderConfig().spec,
          gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
        },
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
