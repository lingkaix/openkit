import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { CodexResponsesClient } from './codex-responses-client.js';
import { GatewayUsageTracker } from './gateway-usage.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
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

  it('bridges pi-ai Responses without forwarding Codex-private continuity state', async () => {
    let seenOptions: StreamOptions | undefined;
    const turnStates: string[] = [];
    const faux = fauxProvider({ provider: 'anthropic_primary', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (_context, options) => {
        seenOptions = options;
        await options?.onResponse?.(
          {
            headers: { 'x-codex-turn-state': 'dispatcher-pi-response-state' },
            status: 200,
          },
          faux.provider.getModels()[0]!
        );
        return fauxAssistantMessage('dispatcher responses');
      },
    ]);
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient: new CodexResponsesClient({
        tokenResolver: {
          resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
        },
      }),
      piAiClient: new PiAiGatewayClient({ models }),
    });

    const response = await dispatcher.createResponses(
      piProviderConfig(),
      {
        model: 'faux-chat',
        input: 'Hello',
      },
      {
        transport: {
          codexTurnState: 'dispatcher-pi-request-state',
          onCodexTurnState: (turnState) => turnStates.push(turnState),
        },
      }
    );

    expect(response).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [{ content: [{ text: 'dispatcher responses' }] }],
    });
    expect(faux.state.callCount).toBe(1);
    expect(seenOptions?.headers).toBeUndefined();
    expect(seenOptions?.onResponse).toBeUndefined();
    expect(turnStates).toEqual([]);
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
  it('records non-stream and stream usage while preserving Codex turn state', async () => {
    const turnStates: string[] = [];
    const codexResponsesClient = new CodexResponsesClient({
      tokenResolver: {
        resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
      },
    });
    const createResponses = vi
      .spyOn(codexResponsesClient, 'createResponses')
      .mockImplementation(async (_provider, _request, transport) => {
        transport?.onCodexTurnState?.('dispatcher-codex-json-response-state');
        return {
          id: 'resp_codex_usage',
          object: 'response',
          status: 'completed',
          model: 'gpt-test',
          output: [],
          usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
        };
      });
    const createResponsesStream = vi
      .spyOn(codexResponsesClient, 'createResponsesStream')
      .mockImplementation(async (_provider, _request, transport) => {
        transport?.onCodexTurnState?.('dispatcher-codex-stream-response-state');
        return new Response(
          'data: {"type":"response.completed","response":{"id":"resp_codex_stream_usage","object":"response","status":"completed","model":"gpt-test","output":[],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\ndata: [DONE]\n\n'
        ).body!;
      });
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
      {
        onUsage: nonstreamOnUsage,
        transport: {
          codexTurnState: 'dispatcher-codex-json-request-state',
          onCodexTurnState: (turnState) => turnStates.push(turnState),
        },
      }
    );

    expect(nonstreamOnUsage).toHaveBeenCalledOnce();
    expect(nonstreamOnUsage).toHaveBeenCalledWith({
      input_tokens: 8,
      output_tokens: 2,
      total_tokens: 10,
    });
    expect(usageTracker.snapshot().summaries[0]?.requestCount).toBe(1);
    expect(createResponses.mock.calls[0]?.[2]).toMatchObject({
      codexTurnState: 'dispatcher-codex-json-request-state',
    });

    const streamOnUsage = vi.fn();
    const stream = await dispatcher.createResponsesStream(
      provider,
      { input: 'Hello', model: 'gpt-test', stream: true },
      {
        onUsage: streamOnUsage,
        transport: {
          codexTurnState: 'dispatcher-codex-stream-request-state',
          onCodexTurnState: (turnState) => turnStates.push(turnState),
        },
      }
    );

    await new Response(stream).text();

    expect(streamOnUsage).toHaveBeenCalledOnce();
    expect(streamOnUsage).toHaveBeenCalledWith({
      input_tokens: 5,
      output_tokens: 1,
      total_tokens: 6,
    });
    expect(usageTracker.snapshot().summaries[0]?.requestCount).toBe(2);
    expect(createResponsesStream.mock.calls[0]?.[2]).toMatchObject({
      codexTurnState: 'dispatcher-codex-stream-request-state',
    });
    expect(turnStates).toEqual([
      'dispatcher-codex-json-response-state',
      'dispatcher-codex-stream-response-state',
    ]);
  });
});

describe('LLMGatewayProviderDispatcher cancellation', () => {
  it('forwards one dispatch signal through pi-ai and Codex provider calls', async () => {
    const abortController = new AbortController();
    let codexSignal: AbortSignal | undefined;
    let piAiSignal: AbortSignal | undefined;
    const piAiClient = {
      createChatCompletion: async (
        _provider: ResolvedLLMProviderConfig,
        request: OpenAICompatibleChatCompletionRequest,
        _onUsage?: (usage: unknown) => void,
        transport?: { readonly signal?: AbortSignal }
      ): Promise<OpenAICompatibleChatCompletionResponse> => {
        piAiSignal = transport?.signal;
        return {
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: 'pi signal', role: 'assistant' },
            },
          ],
          created: 1,
          id: 'chatcmpl_pi_signal',
          model: request.model,
          object: 'chat.completion',
        };
      },
    } as unknown as PiAiGatewayClient;
    const codexResponsesClient = {
      createResponses: async (
        _provider: ResolvedLLMProviderConfig,
        request: OpenAICompatibleResponsesRequest,
        transport?: { readonly signal?: AbortSignal }
      ): Promise<OpenAICompatibleResponsesResponse> => {
        codexSignal = transport?.signal;
        return {
          id: 'resp_codex_signal',
          model: request.model,
          object: 'response',
          output: [],
          status: 'completed',
        };
      },
    } as unknown as CodexResponsesClient;
    const dispatcher = new LLMGatewayProviderDispatcher({
      codexResponsesClient,
      piAiClient,
    });
    const dispatchContext = {
      transport: { signal: abortController.signal },
    } as NonNullable<Parameters<LLMGatewayProviderDispatcher['createResponses']>[2]> & {
      readonly transport: { readonly signal: AbortSignal };
    };

    await dispatcher.createChatCompletion(
      piProviderConfig(),
      { messages: [{ content: 'Hello', role: 'user' }], model: 'faux-chat' },
      dispatchContext
    );
    await dispatcher.createResponses(
      piProviderConfig({
        adapterId: 'openai_codex',
        apiKey: null,
        backend: 'codex-oauth',
        displayName: 'OpenAI Codex',
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        id: 'openai_codex',
        requiresApiKey: false,
      }),
      { input: 'Hello', model: 'gpt-test' },
      dispatchContext
    );

    expect(piAiSignal).toBe(abortController.signal);
    expect(codexSignal).toBe(abortController.signal);
  });
});
