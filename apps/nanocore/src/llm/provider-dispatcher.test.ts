import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUsageTracker } from './gateway-usage.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from './provider-subscription-accounts.js';

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
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    id: 'anthropic_primary',
    models: ['faux-chat', 'gpt-test'],
    requiresApiKey: true,
    ...input,
  } as unknown as ResolvedLLMProviderConfig;
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

  it('rejects models outside the configured provider allowlist before every adapter call', async () => {
    const invocations = [
      (dispatcher: LLMGatewayProviderDispatcher) =>
        dispatcher.createChatCompletion(piProviderConfig({ models: ['configured-model'] }), {
          model: 'adapter-catalog-only-model',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      (dispatcher: LLMGatewayProviderDispatcher) =>
        dispatcher.createChatCompletionStream(piProviderConfig({ models: ['configured-model'] }), {
          model: 'adapter-catalog-only-model',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      (dispatcher: LLMGatewayProviderDispatcher) =>
        dispatcher.createResponses(piProviderConfig({ models: ['configured-model'] }), {
          model: 'adapter-catalog-only-model',
          input: 'Hello',
        }),
      (dispatcher: LLMGatewayProviderDispatcher) =>
        dispatcher.createResponsesStream(piProviderConfig({ models: ['configured-model'] }), {
          model: 'adapter-catalog-only-model',
          input: 'Hello',
          stream: true,
        }),
    ];

    for (const invoke of invocations) {
      const adapterCalls = {
        createChatCompletion: vi.fn(),
        createChatCompletionStream: vi.fn(),
        createResponses: vi.fn(),
        createResponsesStream: vi.fn(),
      };
      const dispatcher = new LLMGatewayProviderDispatcher({
        piAiClient: adapterCalls as unknown as PiAiGatewayClient,
      });

      await expect(invoke(dispatcher)).rejects.toMatchObject({
        code: 'model_not_configured',
        status: 400,
      });
      expect(Object.values(adapterCalls).every((call) => call.mock.calls.length === 0)).toBe(true);
    }
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

  it('bridges pi-ai backend Responses streams with client-executed tools', async () => {
    const faux = fauxProvider({
      provider: 'anthropic_primary',
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('dispatcher response stream')]);
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });

    const stream = await dispatcher.createResponsesStream(piProviderConfig(), {
      model: 'faux-chat',
      input: [
        {
          role: 'developer',
          tools: [
            {
              description: 'Run code.',
              format: {
                definition: 'start: SOURCE\nSOURCE: /[\\s\\S]+/',
                syntax: 'lark',
                type: 'grammar',
              },
              name: 'exec',
              type: 'custom',
            },
          ],
          type: 'additional_tools',
        },
        { content: 'Hello', role: 'user' },
      ],
      stream: true,
    });

    const body = await new Response(stream).text();

    expect(body).toContain('response.output_text.delta');
    expect(body).toContain('dispatcher response stream');
    expect(body).toContain('data: [DONE]');
    expect(faux.state.callCount).toBe(1);
  });
});

describe('LLMGatewayProviderDispatcher subscription routing', () => {
  it('rejects malformed Codex tool history before subscription or provider access', async () => {
    const getPairHandle = vi.fn();
    const piAiCalls = {
      createChatCompletion: vi.fn(),
      createChatCompletionStream: vi.fn(),
      createResponses: vi.fn(),
      createResponsesStream: vi.fn(),
    };
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: piAiCalls as unknown as PiAiGatewayClient,
      providerSubscriptionAccountManager: {
        getPairHandle,
      } as unknown as ProviderSubscriptionAccountManager,
    });
    const provider = piProviderConfig({
      accountSlotId: 'shared_slot',
      adapterId: 'openai-codex',
      apiKey: null,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      id: 'codex-work',
      requiresApiKey: false,
      subscriptionProviderId: 'openai-codex',
    } as Partial<ResolvedLLMProviderConfig>);
    const cases = [
      dispatcher.createResponses(provider, {
        input: [
          {
            call_id: 'call_undeclared',
            id: 'ctc_undeclared',
            input: 'text(true);',
            name: 'exec',
            type: 'custom_tool_call',
          },
        ],
        model: 'gpt-test',
      }),
      dispatcher.createResponsesStream(provider, {
        input: [
          {
            role: 'developer',
            tools: [{ name: 'exec', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
          {
            call_id: 'call_exec',
            id: 'ctc_exec',
            input: 'text(true);',
            name: 'exec',
            type: 'custom_tool_call',
          },
        ],
        model: 'gpt-test',
        stream: true,
      }),
    ];

    for (const response of cases) {
      await expect(response).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
    }
    expect(getPairHandle).not.toHaveBeenCalled();
    expect(Object.values(piAiCalls).every((call) => call.mock.calls.length === 0)).toBe(true);
  });

  it('routes every subscription candidate only through pi-ai with the exact pair Models', async () => {
    const codexModels = createModels();
    const xaiModels = createModels();
    vi.spyOn(codexModels, 'checkAuth').mockResolvedValue({ source: 'OAuth', type: 'oauth' });
    vi.spyOn(xaiModels, 'checkAuth').mockResolvedValue({ source: 'OAuth', type: 'oauth' });
    const turnStates: string[] = [];
    const usage = { input_tokens: 8, output_tokens: 2, total_tokens: 10 };
    const piAiCalls = {
      createChatCompletion: vi.fn(
        async (
          _provider: ResolvedLLMProviderConfig,
          _request: OpenAICompatibleChatCompletionRequest,
          _onUsage?: (value: unknown) => void,
          _transport?: unknown,
          _models?: unknown
        ) => ({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: 'chat', role: 'assistant' },
            },
          ],
          created: 1,
          id: 'chatcmpl_subscription',
          model: 'gpt-test',
          object: 'chat.completion',
        })
      ),
      createChatCompletionStream: vi.fn(async () => new Response('data: [DONE]\n\n').body!),
      createResponses: vi.fn(
        async (
          _provider: ResolvedLLMProviderConfig,
          _request: OpenAICompatibleResponsesRequest,
          onUsage?: (value: unknown) => void,
          transport?: { readonly onCodexTurnState?: (value: string) => void },
          _models?: unknown
        ) => {
          onUsage?.(usage);
          transport?.onCodexTurnState?.('pi-codex-state');
          return {
            id: 'resp_subscription',
            model: 'gpt-test',
            object: 'response',
            output: [],
            status: 'completed',
            usage,
          };
        }
      ),
      createResponsesStream: vi.fn(async () => new Response('data: [DONE]\n\n').body!),
    };
    const getPairHandle = vi.fn(
      async (pair: {
        readonly accountSlotId: string;
        readonly subscriptionProviderId: string;
      }) => ({
        credentials: {} as never,
        models: pair.subscriptionProviderId === 'openai-codex' ? codexModels : xaiModels,
      })
    );
    const providerSubscriptionAccountManager = {
      getPairHandle,
    } as unknown as ProviderSubscriptionAccountManager;
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: piAiCalls as unknown as PiAiGatewayClient,
      providerSubscriptionAccountManager,
    });
    const codex = piProviderConfig({
      accountSlotId: 'shared_slot',
      adapterId: 'openai-codex',
      apiKey: null,
      displayName: 'OpenAI Codex',
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      id: 'codex-work',
      requiresApiKey: false,
      subscriptionProviderId: 'openai-codex',
    } as Partial<ResolvedLLMProviderConfig>);
    const xai = piProviderConfig({
      accountSlotId: 'shared_slot',
      adapterId: 'xai',
      apiKey: null,
      displayName: 'xAI',
      gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
      id: 'xai-work',
      requiresApiKey: false,
      subscriptionProviderId: 'xai',
    } as Partial<ResolvedLLMProviderConfig>);
    const codexContext = {
      onUsage: vi.fn(),
      transport: {
        codexTurnState: 'previous-state',
        onCodexTurnState: (state: string) => turnStates.push(state),
      },
    } as unknown as NonNullable<Parameters<LLMGatewayProviderDispatcher['createResponses']>[2]>;
    const xaiContext = {} as NonNullable<
      Parameters<LLMGatewayProviderDispatcher['createResponses']>[2]
    >;

    await dispatcher.createResponses(codex, { input: 'Hello', model: 'gpt-test' }, codexContext);
    await dispatcher.createChatCompletion(
      xai,
      { messages: [{ content: 'Hello', role: 'user' }], model: 'gpt-test' },
      xaiContext
    );

    expect(getPairHandle.mock.calls.map(([pair]) => pair)).toEqual([
      { accountSlotId: 'shared_slot', subscriptionProviderId: 'openai-codex' },
      { accountSlotId: 'shared_slot', subscriptionProviderId: 'xai' },
    ]);
    expect(codexModels.checkAuth).toHaveBeenCalledOnce();
    expect(codexModels.checkAuth).toHaveBeenCalledWith('openai-codex');
    expect(xaiModels.checkAuth).toHaveBeenCalledOnce();
    expect(xaiModels.checkAuth).toHaveBeenCalledWith('xai');
    expect(piAiCalls.createResponses).toHaveBeenCalledOnce();
    expect(piAiCalls.createResponses.mock.calls[0]?.[4]).toBe(codexModels);
    expect(piAiCalls.createChatCompletion).toHaveBeenCalledOnce();
    expect(piAiCalls.createChatCompletion.mock.calls[0]?.[4]).toBe(xaiModels);
    expect(piAiCalls.createChatCompletionStream).not.toHaveBeenCalled();
    expect(piAiCalls.createResponsesStream).not.toHaveBeenCalled();
    expect(codexContext.onUsage).toHaveBeenCalledOnce();
    expect(codexContext.onUsage).toHaveBeenCalledWith(usage);
    expect(turnStates).toEqual(['pi-codex-state']);
  });
});

describe('LLMGatewayProviderDispatcher cancellation', () => {
  it('forwards one dispatch signal through pi-ai for ordinary and subscription calls', async () => {
    const abortController = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const piAiClient = {
      createChatCompletion: async (
        _provider: ResolvedLLMProviderConfig,
        request: OpenAICompatibleChatCompletionRequest,
        _onUsage?: (usage: unknown) => void,
        transport?: { readonly signal?: AbortSignal }
      ): Promise<OpenAICompatibleChatCompletionResponse> => {
        seenSignals.push(transport?.signal);
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
      createResponses: async (
        _provider: ResolvedLLMProviderConfig,
        request: OpenAICompatibleResponsesRequest,
        _onUsage?: (usage: unknown) => void,
        transport?: { readonly signal?: AbortSignal }
      ): Promise<OpenAICompatibleResponsesResponse> => {
        seenSignals.push(transport?.signal);
        return {
          id: 'resp_codex_signal',
          model: request.model,
          object: 'response',
          output: [],
          status: 'completed',
        };
      },
    } as unknown as PiAiGatewayClient;
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient,
    });
    const dispatchContext = {
      models: createModels(),
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
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        displayName: 'OpenAI Codex',
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        id: 'codex-team',
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      { input: 'Hello', model: 'gpt-test' },
      dispatchContext
    );

    expect(seenSignals).toEqual([abortController.signal, abortController.signal]);
  });
});
