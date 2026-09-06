import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

import {
  type AuthInteraction,
  type Context,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Model,
  type OAuthCredential,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUnsupportedFeatureError } from './gateway-converters.js';
import {
  createDefaultPiAiGatewayModels,
  PiAiGatewayClient,
  PiAiGatewayConfigurationError,
} from './pi-ai-client.js';
import { WORKER_CLIENT_TOOL_SEARCH_FUNCTION } from './worker-inference-tool-policy.js';

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
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    id: 'anthropic_primary',
    models: ['faux-chat', 'gpt-test'],
    requiresApiKey: true,
    ...input,
  } as unknown as ResolvedLLMProviderConfig;
}

describe('PiAiGatewayClient', () => {
  it('keeps the pi-ai dependency exact-pinned and importable inside nanocore', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { dependencies: Record<string, string> };
    const version = packageJson.dependencies['@earendil-works/pi-ai'];

    expect(version).toBe('0.84.2');
    expect(version).not.toMatch(/^[~^]/);
    await expect(import('@earendil-works/pi-ai')).resolves.toHaveProperty('createModels');
  });

  it('registers Anthropic models in the default pi-ai collection', () => {
    const models = createDefaultPiAiGatewayModels();

    expect(models.getModel('anthropic', 'claude-sonnet-4-6')).toMatchObject({
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

  it('exposes native OAuth and Responses metadata for Codex and xAI', () => {
    const codex = openaiCodexProvider();
    const xai = xaiProvider();

    expect(codex.auth.oauth).toBeDefined();
    expect(codex.getModels()).toContainEqual(
      expect.objectContaining({ api: 'openai-codex-responses' })
    );
    expect(xai.auth.oauth).toBeDefined();
    expect(xai.auth.oauth).toMatchObject({ loginLabel: 'Sign in with SuperGrok or X Premium' });
  });

  it('awaits credential writes and skips them when login is cancelled', async () => {
    const modifyCalls: string[] = [];
    const deleteCalls: string[] = [];
    let releaseModify!: () => void;
    let releaseDelete!: () => void;
    const modifyGate = new Promise<void>((resolve) => {
      releaseModify = resolve;
    });
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const credentials = {
      async list(): Promise<readonly CredentialInfo[]> {
        return [];
      },
      async read() {
        return undefined;
      },
      async modify(providerId, fn) {
        modifyCalls.push(providerId);
        await modifyGate;
        return fn(undefined);
      },
      async delete(providerId) {
        deleteCalls.push(providerId);
        await deleteGate;
      },
    } as CredentialStore;
    const faux = fauxProvider({ provider: 'oauth-faux' });
    const provider = {
      ...faux.provider,
      auth: {
        oauth: {
          name: 'Faux OAuth',
          async login({ signal }: AuthInteraction) {
            if (signal?.aborted) {
              throw signal.reason;
            }
            return { type: 'oauth' as const, access: 'access', refresh: 'refresh', expires: 1 };
          },
          async refresh(credential: OAuthCredential) {
            return credential;
          },
          async toAuth() {
            return { apiKey: 'access' };
          },
        },
      },
    };
    const models = createModels({ credentials });
    models.setProvider(provider);

    let loginSettled = false;
    const login = models
      .login(provider.id, 'oauth', {
        prompt: async () => 'unused',
        notify: () => {},
      })
      .finally(() => {
        loginSettled = true;
      });
    await vi.waitFor(() => expect(modifyCalls).toEqual([provider.id]));
    expect(loginSettled).toBe(false);
    releaseModify();
    await login;

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      models.login(provider.id, 'oauth', {
        prompt: async () => 'unused',
        notify: () => {},
        signal: controller.signal,
      })
    ).rejects.toThrow('cancelled');
    expect(modifyCalls).toEqual([provider.id]);

    let logoutSettled = false;
    const logout = models.logout(provider.id).finally(() => {
      logoutSettled = true;
    });
    await Promise.resolve();
    expect(deleteCalls).toEqual([provider.id]);
    expect(logoutSettled).toBe(false);
    releaseDelete();
    await logout;
  });

  it('awaits persistence before returning auth from a refreshed OAuth credential', async () => {
    const providerId = 'refresh-faux';
    const expired: OAuthCredential = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'expired-refresh',
      expires: Date.now() - 1,
    };
    const refreshed: OAuthCredential = {
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refreshed-refresh',
      expires: Date.now() + 60_000,
    };
    let stored: OAuthCredential = expired;
    const modifyCalls: Array<{ providerId: string; current: OAuthCredential }> = [];
    const refreshCalls: OAuthCredential[] = [];
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const credentials: CredentialStore = {
      async list(): Promise<readonly CredentialInfo[]> {
        return [{ providerId, type: 'oauth' }];
      },
      async read(requestedProviderId) {
        return requestedProviderId === providerId ? stored : undefined;
      },
      async modify(requestedProviderId, fn) {
        modifyCalls.push({ providerId: requestedProviderId, current: stored });
        const next = await fn(stored);
        await persistenceGate;
        if (next?.type === 'oauth') {
          stored = next;
        }
        return next;
      },
      async delete() {},
    };
    const faux = fauxProvider({ provider: providerId });
    const provider = {
      ...faux.provider,
      auth: {
        oauth: {
          name: 'Faux OAuth',
          async login() {
            return refreshed;
          },
          async refresh(credential: OAuthCredential) {
            refreshCalls.push(credential);
            return refreshed;
          },
          async toAuth(credential: OAuthCredential) {
            return { apiKey: credential.access };
          },
        },
      },
    };
    const models = createModels({ credentials });
    models.setProvider(provider);

    let authSettled = false;
    const authPromise = models.getAuth(faux.getModel()).finally(() => {
      authSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshCalls).toEqual([expired]);
    expect(modifyCalls).toEqual([{ providerId, current: expired }]);
    expect(authSettled).toBe(false);

    releasePersistence();
    await expect(authPromise).resolves.toEqual({
      auth: { apiKey: 'refreshed-access' },
      source: 'OAuth',
    });
    expect(stored).toEqual(refreshed);
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

  it('prefetches Codex stream headers, replays the first event once, and cancels safely', async () => {
    let releaseStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const turnStates: string[] = [];
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (_context, options) => {
        await startup;
        await options?.onResponse?.(
          {
            headers: { 'x-codex-turn-state': 'pi-stream-response-state' },
            status: 200,
          },
          faux.provider.getModels()[0]!
        );
        return fauxAssistantMessage(
          [
            fauxText('stream state ready'),
            fauxToolCall('search_docs', { query: 'OpenKit' }, { id: 'call_stream_codex' }),
          ],
          { responseId: 'resp_stream_codex', stopReason: 'toolUse' }
        );
      },
    ]);
    const client = new PiAiGatewayClient();
    const createResponsesStream = client.createResponsesStream.bind(client) as unknown as (
      provider: ResolvedLLMProviderConfig,
      request: OpenAICompatibleResponsesRequest,
      onUsage: Parameters<PiAiGatewayClient['createResponsesStream']>[2],
      transport: Parameters<PiAiGatewayClient['createResponsesStream']>[3],
      pairModels: typeof models
    ) => Promise<ReadableStream<Uint8Array>>;
    let startupSettled = false;
    const observedUsage: unknown[] = [];
    const streamOutcome = createResponsesStream(
      providerConfig({
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        displayName: 'OpenAI Codex',
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        id: 'codex-team',
        models: ['openai-codex/gpt-5.6-sol'],
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      {
        input: 'Preserve stream state',
        model: 'openai-codex/gpt-5.6-sol',
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'search_docs',
            description: 'Search documentation.',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      (usage) => observedUsage.push(usage),
      { onCodexTurnState: (turnState) => turnStates.push(turnState) },
      models
    ).then(
      (stream) => {
        startupSettled = true;
        return { stream };
      },
      (error: unknown) => {
        startupSettled = true;
        return { error };
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(startupSettled).toBe(false);
    releaseStartup();
    const outcome = await streamOutcome;
    if ('error' in outcome) {
      throw outcome.error;
    }
    const body = await new Response(outcome.stream).text();
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
    const created = events.find((event) => event.type === 'response.created') as {
      response: { output: unknown[] };
    };
    const deltas = events.filter((event) => event.type === 'response.output_text.delta');
    const completed = events.find((event) => event.type === 'response.completed') as {
      response: { output: unknown[]; usage: unknown };
    };

    expect(created.response.output).toEqual([]);
    expect(deltas.map((event) => event.delta)).toEqual(['stream state ready']);
    expect(body.indexOf('response.created')).toBeLessThan(
      body.indexOf('response.output_text.delta')
    );
    expect(body.indexOf('response.output_text.delta')).toBeLessThan(
      body.indexOf('response.function_call_arguments.delta')
    );
    expect(body.indexOf('response.function_call_arguments.delta')).toBeLessThan(
      body.indexOf('response.completed')
    );
    expect(body).toContain('call_stream_codex');
    expect(body).toContain('data: [DONE]');
    expect(observedUsage).toEqual([
      {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 36,
        output: 13,
        totalTokens: 49,
      },
    ]);
    expect(JSON.stringify(completed.response.output)).toContain('stream state ready');
    expect(completed.response.usage).toEqual({
      input_tokens: 36,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 13,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 49,
    });
    expect(turnStates).toEqual(['pi-stream-response-state']);

    faux.setResponses([
      async (_context, options) => {
        options?.signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
          void resolve;
        });
      },
    ]);
    const abortController = new AbortController();
    const cancelled = createResponsesStream(
      providerConfig({
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        id: 'codex-team',
        models: ['openai-codex/gpt-5.6-sol'],
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      {
        input: 'Cancel before headers',
        model: 'openai-codex/gpt-5.6-sol',
        stream: true,
        tools: [],
      },
      undefined,
      { onCodexTurnState: () => {}, signal: abortController.signal },
      models
    );
    abortController.abort(new Error('cancelled during prefetch'));

    await expect(cancelled).rejects.toThrow('cancelled during prefetch');
  });

  it('fails a Codex Responses stream that ends without a terminal pi-ai event', async () => {
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    models.stream = (() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'start' as const,
          partial: fauxAssistantMessage([], { responseId: 'resp_incomplete_codex' }),
        };
      },
    })) as unknown as typeof models.stream;

    const stream = await new PiAiGatewayClient().createResponsesStream(
      providerConfig({
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        id: 'codex-team',
        models: ['openai-codex/gpt-5.6-sol'],
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      {
        input: 'Do not close an incomplete stream cleanly',
        model: 'openai-codex/gpt-5.6-sol',
        stream: true,
      },
      undefined,
      {},
      models
    );

    const failure = await new Response(stream).text().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: unknown }).code).toBe('provider_stream_truncated');
    expect((failure as { stopReason?: unknown }).stopReason).toBeUndefined();
  });

  it('carries the pi-ai terminal stop reason and diagnostic category on a Codex stream error', async () => {
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    models.stream = (() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'start' as const,
          partial: fauxAssistantMessage([], { responseId: 'resp_failed_codex' }),
        };
        yield {
          type: 'error' as const,
          reason: 'error' as const,
          error: {
            ...fauxAssistantMessage([], {
              errorMessage: 'Codex transport closed early.',
              responseId: 'resp_failed_codex',
              stopReason: 'error',
            }),
            diagnostics: [
              {
                type: 'provider_transport_failure',
                timestamp: 1,
                error: { message: 'socket hang up', code: 'ECONNRESET' },
              },
            ],
          },
        };
      },
    })) as unknown as typeof models.stream;

    const stream = await new PiAiGatewayClient().createResponsesStream(
      providerConfig({
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        id: 'codex-team',
        models: ['openai-codex/gpt-5.6-sol'],
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      {
        input: 'Report the pi-ai terminal identity',
        model: 'openai-codex/gpt-5.6-sol',
        stream: true,
      },
      undefined,
      {},
      models
    );

    const failure = await new Response(stream).text().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Codex transport closed early.');
    expect((failure as { code?: unknown }).code).toBe('provider_transport_failure');
    expect((failure as { stopReason?: unknown }).stopReason).toBe('error');
  });

  it('uses an injected custom OpenAI-compatible provider through public pi-ai seams', async () => {
    const faux = fauxProvider({
      provider: 'custom-proxy',
      models: [{ id: 'custom-chat' }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('custom ok')]);
    const customProvider = providerConfig({
      adapterId: 'custom-proxy',
      id: 'custom-proxy',
      displayName: 'Custom Proxy',
      baseUrl: 'https://proxy.example/v1',
      models: ['custom-chat'],
    });

    const response = await new PiAiGatewayClient({ models }).createChatCompletion(customProvider, {
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'custom-chat',
    });

    expect(response.choices[0]?.message.content).toBe('custom ok');
    expect(faux.state.callCount).toBe(1);
  });

  it('binds adapter models to the configured instance endpoint and auth boundary', async () => {
    let seenModel: Model<string> | undefined;
    let seenOptions: StreamOptions | undefined;
    const faux = fauxProvider({ provider: 'openai', models: [{ id: 'gpt-5.1' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      (_context, options, _state, model) => {
        seenModel = model;
        seenOptions = options;
        return fauxAssistantMessage('proxy ok');
      },
    ]);
    const provider = providerConfig({
      adapterId: 'openai',
      apiKey: null,
      baseUrl: 'https://proxy.example/v1',
      gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
      id: 'proxy-openai',
      requiresApiKey: false,
    });
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-secret';

    try {
      await new PiAiGatewayClient({ models }).createChatCompletion(provider, {
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-5.1',
      });

      expect(seenModel).toMatchObject({
        baseUrl: 'https://proxy.example/v1',
        provider: 'proxy-openai',
      });
      expect(seenOptions?.apiKey).toBe('openkit-keyless');
      expect(faux.state.callCount).toBe(1);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it('uses native Codex Responses and preserves tools, history, reasoning, and usage', async () => {
    let seenContext: Context | undefined;
    let seenModel: Model<string> | undefined;
    let seenOptions: (StreamOptions & Record<string, unknown>) | undefined;
    let seenPayload: unknown;
    const turnStates: string[] = [];
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const originalProvider = models.getProvider('openai-codex');
    faux.setResponses([
      async (context, options, _state, model) => {
        seenContext = context;
        seenModel = model;
        seenOptions = options as StreamOptions & Record<string, unknown>;
        seenPayload = await options?.onPayload?.(
          {
            input: [],
            model: 'gpt-5.6-sol',
            reasoning: { effort: 'high', summary: 'detailed' },
          },
          model
        );
        await options?.onResponse?.(
          {
            headers: { 'x-codex-turn-state': 'wrong-model-state' },
            status: 200,
          },
          { ...model, id: 'wrong-model' }
        );
        await options?.onResponse?.(
          {
            headers: { 'x-codex-turn-state': 'failed-state' },
            status: 401,
          },
          model
        );
        await options?.onResponse?.(
          {
            headers: { 'x-codex-turn-state': 'accepted-state' },
            status: 200,
          },
          model
        );
        return fauxAssistantMessage(
          [
            fauxThinking('Need the tool.'),
            fauxText('Calling search.'),
            fauxToolCall('search_docs', { query: 'OpenKit' }, { id: 'call_codex' }),
          ],
          { responseId: 'resp_codex_native', stopReason: 'toolUse' }
        );
      },
    ]);
    const client = new PiAiGatewayClient();
    const createResponses = client.createResponses.bind(client) as unknown as (
      provider: ResolvedLLMProviderConfig,
      request: OpenAICompatibleResponsesRequest,
      onUsage: Parameters<PiAiGatewayClient['createResponses']>[2],
      transport: Parameters<PiAiGatewayClient['createResponses']>[3],
      pairModels: typeof models
    ) => Promise<OpenAICompatibleResponsesResponse>;
    const observedUsage: unknown[] = [];
    const response = await createResponses(
      providerConfig({
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        displayName: 'OpenAI Codex',
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        id: 'codex-team',
        models: ['openai-codex/gpt-5.6-sol'],
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      {
        instructions: 'Use the documentation tool.',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Find OpenKit.' }],
          },
          {
            type: 'function_call',
            call_id: 'call_previous',
            name: 'search_docs',
            arguments: '{"query":"previous"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_previous',
            output: 'Previous result',
          },
        ],
        model: 'openai-codex/gpt-5.6-sol',
        prompt_cache_key: 'hashed-cache-key',
        prompt_cache_retention: 'long',
        reasoning: { context: 'all_turns', effort: 'high', summary: 'detailed' },
        tool_choice: 'required',
        tools: [
          {
            type: 'function',
            name: 'search_docs',
            description: 'Search documentation.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      },
      (usage) => observedUsage.push(usage),
      {
        codexTurnState: 'previous-state',
        onCodexTurnState: (turnState) => turnStates.push(turnState),
      },
      models
    );

    expect(models.getProvider('openai-codex')).toBe(originalProvider);
    expect(seenModel).toMatchObject({
      api: 'openai-codex-responses',
      id: 'gpt-5.6-sol',
      provider: 'openai-codex',
    });
    expect(seenContext).toMatchObject({
      systemPrompt: 'Use the documentation tool.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find OpenKit.' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_previous',
              name: 'search_docs',
              arguments: { query: 'previous' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call_previous',
          toolName: 'search_docs',
          content: [{ type: 'text', text: 'Previous result' }],
        },
      ],
      tools: [
        {
          name: 'search_docs',
          parameters: {
            required: ['query'],
          },
        },
      ],
    });
    expect(seenOptions).toMatchObject({
      cacheRetention: 'long',
      headers: { 'x-codex-turn-state': 'previous-state' },
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
      sessionId: 'hashed-cache-key',
      toolChoice: 'required',
      transport: 'sse',
    });
    expect(seenPayload).toMatchObject({
      reasoning: { context: 'all_turns', effort: 'high', summary: 'detailed' },
    });
    expect(response).toMatchObject({
      id: 'resp_codex_native',
      model: 'openai-codex/gpt-5.6-sol',
      object: 'response',
      output: [
        { type: 'reasoning' },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Calling search.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_codex',
          name: 'search_docs',
          arguments: '{"query":"OpenKit"}',
        },
      ],
      status: 'completed',
      usage: expect.objectContaining({
        input_tokens: expect.any(Number),
        input_tokens_details: { cached_tokens: expect.any(Number) },
        output_tokens: expect.any(Number),
        total_tokens: expect.any(Number),
      }),
    });
    expect(observedUsage).toEqual([expect.objectContaining({ cacheRead: expect.any(Number) })]);
    expect(turnStates).toEqual(['accepted-state']);
  });

  it('preserves the exact Codex Responses Lite tool prefix as callable tools', async () => {
    let seenContext: Context | undefined;
    let seenPayload: unknown;
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const additionalTools = {
      role: 'developer',
      tools: [
        { type: 'custom', name: 'exec', description: 'Run a command.', format: { type: 'text' } },
        {
          type: 'function',
          name: 'wait',
          description: 'Wait for work.',
          parameters: { type: 'object', properties: {} },
          strict: false,
        },
        {
          type: 'namespace',
          name: 'collaboration',
          description: 'Coordinate work.',
          tools: [{ type: 'function', name: 'send_message', parameters: { type: 'object' } }],
        },
      ],
      type: 'additional_tools',
    } as const;
    const userInput = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Delegate this task.' }],
    } as const;
    faux.setResponses([
      async (context, options, _state, model) => {
        seenContext = context;
        seenPayload = await options?.onPayload?.(
          { input: [userInput], model: 'gpt-5.6-sol' },
          model
        );
        return fauxAssistantMessage('Done.');
      },
    ]);

    await new PiAiGatewayClient().createResponses(
      providerConfig({
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        id: 'codex-team',
        models: ['openai-codex/gpt-5.6-sol'],
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      {
        input: [additionalTools, userInput],
        model: 'openai-codex/gpt-5.6-sol',
        tools: [],
      },
      undefined,
      {},
      models
    );

    expect(seenContext).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Delegate this task.' }] }],
    });
    expect(seenContext?.tools).toBeUndefined();
    expect(seenPayload).toEqual({
      input: [additionalTools, userInput],
      model: 'gpt-5.6-sol',
      tools: additionalTools.tools,
    });
  });

  it('preserves the Codex 0.153.4 canonical prefix and namespaced custom-tool semantics', async () => {
    let seenContext: Context | undefined;
    let seenPayload: unknown;
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const additionalTools = {
      id: 'at_01234567-89ab-5def-8abc-0123456789ab',
      role: 'developer',
      tools: [
        {
          description: 'Local callable tools.',
          name: 'functions',
          tools: [
            {
              description: 'Run a command.',
              format: { type: 'text' },
              name: 'exec',
              type: 'custom',
            },
          ],
          type: 'namespace',
        },
      ],
      type: 'additional_tools',
    } as const;
    const userInput = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Run the check.' }],
    } as const;
    faux.setResponses([
      async (context, options, _state, model) => {
        seenContext = context;
        seenPayload = await options?.onPayload?.(
          { input: [userInput], model: 'gpt-5.6-sol' },
          model
        );
        return fauxAssistantMessage(
          { ...fauxToolCall('exec', { input: 'text(true);' }), namespace: 'functions' },
          { stopReason: 'toolUse' }
        );
      },
    ]);

    const response = await new PiAiGatewayClient().createResponses(
      providerConfig({
        accountSlotId: 'team',
        adapterId: 'openai-codex',
        apiKey: null,
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        id: 'codex-team',
        models: ['openai-codex/gpt-5.6-sol'],
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      } as Partial<ResolvedLLMProviderConfig>),
      {
        input: [additionalTools, userInput],
        model: 'openai-codex/gpt-5.6-sol',
        tools: [],
      },
      undefined,
      {},
      models
    );

    expect(seenContext?.tools).toBeUndefined();
    expect(seenPayload).toEqual({
      input: [additionalTools, userInput],
      model: 'gpt-5.6-sol',
      tools: additionalTools.tools,
    });
    expect(response.output).toContainEqual(
      expect.objectContaining({
        input: 'text(true);',
        name: 'exec',
        namespace: 'functions',
        type: 'custom_tool_call',
      })
    );
  });

  it('rejects an undeclared provider tool call instead of publishing it', async () => {
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('undeclared', {}), { stopReason: 'toolUse' }),
    ]);

    await expect(
      new PiAiGatewayClient().createResponses(
        providerConfig({
          accountSlotId: 'team',
          adapterId: 'openai-codex',
          apiKey: null,
          gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
          id: 'codex-team',
          models: ['openai-codex/gpt-5.6-sol'],
          requiresApiKey: false,
          subscriptionProviderId: 'openai-codex',
        } as Partial<ResolvedLLMProviderConfig>),
        {
          input: [
            {
              role: 'developer',
              tools: [{ name: 'declared', parameters: { type: 'object' }, type: 'function' }],
              type: 'additional_tools',
            },
            { content: 'Call one tool.', role: 'user' },
          ],
          model: 'openai-codex/gpt-5.6-sol',
          tools: [],
        },
        undefined,
        {},
        models
      )
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
  });

  it('lowers client tool search through the stock Codex parser and activates discovered tools', async () => {
    const accessToken = [
      'e30',
      Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': { chatgpt_account_id: 'account-search' },
        })
      ).toString('base64url'),
      'signature',
    ].join('.');
    const credential: OAuthCredential = {
      access: accessToken,
      expires: Date.now() + 60 * 60_000,
      refresh: 'refresh-search',
      type: 'oauth',
    };
    const credentials: CredentialStore = {
      async delete() {},
      async list() {
        return [{ providerId: 'openai-codex', type: 'oauth' }];
      },
      async modify(_providerId, fn) {
        return fn(credential);
      },
      async read() {
        return credential;
      },
    };
    const models = createModels({ credentials });
    models.setProvider(openaiCodexProvider());
    const searchCall = {
      arguments: '{"query":"local tools","limit":2}',
      call_id: 'call_search',
      id: 'fc_search',
      name: WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
      namespace: 'functions',
      status: 'completed',
      type: 'function_call',
    } as const;
    const secondSearchCall = {
      arguments: '{"query":"more local tools","limit":1}',
      call_id: 'call_search_again',
      id: 'fc_search_again',
      name: WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
      status: 'completed',
      type: 'function_call',
    } as const;
    const discoveredFunctionCall = {
      arguments: '{"task_name":"inspect"}',
      call_id: 'call_discovered_function',
      id: 'fc_discovered_function',
      name: 'send_message',
      namespace: 'collaboration',
      status: 'completed',
      type: 'function_call',
    } as const;
    const discoveredCustomCall = {
      call_id: 'call_discovered_custom',
      id: 'ctc_discovered_custom',
      input: 'text(true);',
      name: 'run',
      namespace: 'shell',
      status: 'completed',
      type: 'custom_tool_call',
    } as const;
    const responseBody = (items: readonly Record<string, unknown>[]): string => {
      const events: Record<string, unknown>[] = [
        {
          response: { id: 'resp_search', model: 'gpt-5.6-sol', output: [], status: 'in_progress' },
          type: 'response.created',
        },
      ];
      items.forEach((item, outputIndex) => {
        if (item.type === 'function_call') {
          events.push(
            {
              item: { ...item, arguments: '', status: 'in_progress' },
              output_index: outputIndex,
              type: 'response.output_item.added',
            },
            {
              call_id: item.call_id,
              delta: item.arguments,
              output_index: outputIndex,
              type: 'response.function_call_arguments.delta',
            },
            { item, output_index: outputIndex, type: 'response.output_item.done' }
          );
        } else {
          events.push(
            {
              item: { ...item, input: '', status: 'in_progress' },
              output_index: outputIndex,
              type: 'response.output_item.added',
            },
            {
              delta: item.input,
              output_index: outputIndex,
              type: 'response.custom_tool_call_input.delta',
            },
            { item, output_index: outputIndex, type: 'response.output_item.done' }
          );
        }
      });
      events.push({
        response: {
          id: 'resp_search',
          model: 'gpt-5.6-sol',
          output: items,
          status: 'completed',
          usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
        },
        type: 'response.completed',
      });
      return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
    };
    const upstreamRequests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = Buffer.from(init?.body as Uint8Array);
      const decodedBody =
        new Headers(init?.headers).get('content-encoding') === 'zstd'
          ? zstdDecompressSync(requestBody)
          : requestBody;
      upstreamRequests.push(JSON.parse(decodedBody.toString()) as Record<string, unknown>);
      const callIndex = upstreamRequests.length - 1;
      return new Response(
        callIndex === 0
          ? responseBody([searchCall])
          : responseBody([secondSearchCall, discoveredFunctionCall, discoveredCustomCall]),
        { headers: { 'content-type': 'text/event-stream' }, status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const rootFunction = {
      description: 'Root function sharing the exec name.',
      name: 'exec',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      type: 'function',
    } as const;
    const namespacedCustom = {
      description: 'Namespaced custom tool sharing the exec name.',
      format: { type: 'text' },
      name: 'exec',
      type: 'custom',
    } as const;
    const additionalTools = {
      id: 'at_01234567-89ab-5def-8abc-0123456789ab',
      role: 'developer',
      tools: [
        {
          description: 'Search local callable tools.',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'number' } },
            required: ['query'],
          },
          type: 'tool_search',
        },
        rootFunction,
        {
          description: 'Namespaced local callable tools.',
          name: 'shell',
          tools: [namespacedCustom],
          type: 'namespace',
        },
      ],
      type: 'additional_tools',
    } as const;
    const discoveredTools = [
      {
        description: 'Coordinate discovered work.',
        name: 'collaboration',
        tools: [
          {
            defer_loading: true,
            description: 'Send one message.',
            name: 'send_message',
            parameters: { type: 'object', properties: { task_name: { type: 'string' } } },
            type: 'function',
          },
        ],
        type: 'namespace',
      },
      {
        description: 'Discovered shell tools.',
        name: 'shell',
        tools: [
          {
            defer_loading: true,
            description: 'Run source text.',
            format: { type: 'text' },
            name: 'run',
            type: 'custom',
          },
        ],
        type: 'namespace',
      },
    ] as const;
    const nullableReasoning = {
      content: null,
      encrypted_content: null,
      id: 'rs_nullable_content',
      summary: [{ text: 'Retain the native reasoning item.', type: 'summary_text' }],
      type: 'reasoning',
    } as const;
    const phasedMessage = {
      content: [{ text: 'Preserve this output phase.', type: 'output_text' }],
      id: 'msg_phase',
      phase: 'commentary',
      role: 'assistant',
      type: 'message',
    } as const;
    const provider = providerConfig({
      accountSlotId: 'team',
      adapterId: 'openai-codex',
      apiKey: null,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      id: 'codex-team',
      models: ['openai-codex/gpt-5.6-sol'],
      requiresApiKey: false,
      subscriptionProviderId: 'openai-codex',
    } as Partial<ResolvedLLMProviderConfig>);
    const client = new PiAiGatewayClient();

    try {
      const first = await client.createResponses(
        provider,
        {
          input: [
            additionalTools,
            { content: 'Retain this input-scoped instruction.', role: 'developer' },
            { content: 'Find local tools.', role: 'user' },
          ],
          instructions: 'Retain this request instruction.',
          model: 'openai-codex/gpt-5.6-sol',
          tools: [],
        },
        undefined,
        {},
        models
      );
      const publicSearchCall = first.output?.[0];
      expect(publicSearchCall).toEqual({
        arguments: { query: 'local tools', limit: 2 },
        call_id: 'call_search',
        execution: 'client',
        id: 'fc_search',
        status: 'completed',
        type: 'tool_search_call',
      });

      const stream = await client.createResponsesStream(
        provider,
        {
          input: [
            additionalTools,
            { content: 'Use the discovered tools.', role: 'user' },
            nullableReasoning,
            phasedMessage,
            {
              arguments: '{"command":"pwd"}',
              call_id: 'call_root_exec',
              id: 'fc_root_exec',
              name: 'exec',
              type: 'function_call',
            },
            { call_id: 'call_root_exec', output: '/workspace', type: 'function_call_output' },
            {
              call_id: 'call_namespaced_exec',
              id: 'ctc_namespaced_exec',
              input: 'text(false);',
              name: 'exec',
              namespace: 'shell',
              type: 'custom_tool_call',
            },
            {
              call_id: 'call_namespaced_exec',
              output: 'false',
              type: 'custom_tool_call_output',
            },
            publicSearchCall,
            {
              call_id: 'call_search',
              execution: 'client',
              status: 'completed',
              tools: discoveredTools,
              type: 'tool_search_output',
            },
          ],
          model: 'openai-codex/gpt-5.6-sol',
          stream: true,
          tools: [],
        },
        undefined,
        {},
        models
      );
      const body = await new Response(stream).text();
      const events = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            item: expect.objectContaining({
              arguments: { query: 'more local tools', limit: 1 },
              call_id: 'call_search_again',
              execution: 'client',
              type: 'tool_search_call',
            }),
            type: 'response.output_item.done',
          }),
          expect.objectContaining({
            item: expect.objectContaining({
              arguments: '{"task_name":"inspect"}',
              name: 'send_message',
              namespace: 'collaboration',
              type: 'function_call',
            }),
            type: 'response.output_item.done',
          }),
          expect.objectContaining({
            item: expect.objectContaining({
              input: 'text(true);',
              name: 'run',
              namespace: 'shell',
              type: 'custom_tool_call',
            }),
            type: 'response.output_item.done',
          }),
        ])
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstRequest = upstreamRequests[0];
      const firstInput = firstRequest?.input as readonly Record<string, unknown>[];
      const secondInput = upstreamRequests[1]?.input as readonly Record<string, unknown>[];
      expect(firstRequest?.instructions).toBe('Retain this request instruction.');
      expect(firstInput).toEqual([
        {
          ...additionalTools,
          tools: [
            {
              description: 'Search local callable tools.',
              name: WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
              parameters: additionalTools.tools[0].parameters,
              type: 'function',
            },
            rootFunction,
            {
              description: 'Namespaced local callable tools.',
              name: 'shell',
              tools: [namespacedCustom],
              type: 'namespace',
            },
          ],
        },
        { content: 'Retain this input-scoped instruction.', role: 'developer' },
        { content: 'Find local tools.', role: 'user' },
      ]);
      expect(secondInput).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            call_id: 'call_root_exec',
            name: 'exec',
            type: 'function_call',
          }),
          expect.objectContaining({
            call_id: 'call_namespaced_exec',
            name: 'exec',
            namespace: 'shell',
            type: 'custom_tool_call',
          }),
          expect.objectContaining({
            call_id: 'call_search',
            name: WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
            type: 'function_call',
          }),
          nullableReasoning,
          phasedMessage,
        ])
      );
      const searchResultIndex = secondInput.findIndex(
        (item) => item.type === 'function_call_output' && item.call_id === 'call_search'
      );
      expect(secondInput[searchResultIndex + 1]).toEqual({
        role: 'developer',
        tools: discoveredTools.map((namespace) => ({
          ...namespace,
          tools: namespace.tools.map(({ defer_loading: _deferLoading, ...tool }) => tool),
        })),
        type: 'additional_tools',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves custom response projection when bridging Responses through Chat Completions', async () => {
    let seenContext: Context | undefined;
    let seenOptions: (StreamOptions & Record<string, unknown>) | undefined;
    let seenPayload: unknown;
    const faux = fauxProvider({
      api: 'openai-completions',
      provider: 'openrouter',
      models: [{ id: 'stealth/ox-alpha', reasoning: true }],
      tokensPerSecond: 100,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const additionalTools = {
      role: 'developer',
      tools: [{ type: 'custom', name: 'exec', description: 'Run code.', format: { type: 'text' } }],
      type: 'additional_tools',
    } as const;
    faux.setResponses([
      async (context, options, _state, model) => {
        seenContext = context;
        seenOptions = options as StreamOptions & Record<string, unknown>;
        seenPayload = await options?.onPayload?.(
          { model: 'stealth/ox-alpha', parallel_tool_calls: true },
          model
        );
        return fauxAssistantMessage(
          [
            fauxThinking('Need the tool.'),
            fauxText('Working.'),
            fauxToolCall('exec', { input: 'text(true);' }, { id: 'call_exec' }),
          ],
          { stopReason: 'toolUse' }
        );
      },
    ]);

    const stream = await new PiAiGatewayClient().createResponsesStream(
      providerConfig({
        adapterId: 'openrouter',
        apiKey: 'openrouter-secret',
        displayName: 'OpenRouter',
        gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
        id: 'openrouter-a1',
        models: ['stealth/ox-alpha'],
        subscriptionProviderId: 'openrouter',
      }),
      {
        include: ['reasoning.encrypted_content'],
        input: [
          additionalTools,
          { role: 'user', content: [{ type: 'input_text', text: 'Run the check.' }] },
        ],
        model: 'stealth/ox-alpha',
        parallel_tool_calls: false,
        reasoning: { effort: 'high', summary: 'auto' },
        store: false,
        stream: true,
        text: { verbosity: 'medium' },
        tool_choice: 'auto',
        tools: [],
      },
      undefined,
      {},
      models
    );

    const body = await new Response(stream).text();
    expect(seenContext).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Run the check.' }] }],
    });
    expect(seenContext?.tools).toBeUndefined();
    expect(seenOptions).toMatchObject({
      apiKey: 'openrouter-secret',
      reasoningEffort: 'high',
      toolChoice: 'auto',
    });
    expect(seenPayload).toEqual({
      model: 'stealth/ox-alpha',
      parallel_tool_calls: false,
    });
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_event, index) => index)
    );
    expect(events[3]).toMatchObject({ item_id: 'reasoning_0', summary_index: 0 });
    expect(events[9]).toMatchObject({ content_index: 0, item_id: 'message_1' });
    expect(events[14]).toMatchObject({ item_id: 'call_exec' });
    expect(events[15]).toMatchObject({ input: 'text(true);', item_id: 'call_exec' });
    expect(body).toContain('text(true);');
    expect(body).toContain('data: [DONE]');
  });

  it('preserves Codex Responses Lite namespace and custom tool semantics through pi-ai', async () => {
    const accessToken = [
      'e30',
      Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' },
        })
      ).toString('base64url'),
      'signature',
    ].join('.');
    const credential: OAuthCredential = {
      access: accessToken,
      expires: Date.now() + 60 * 60_000,
      refresh: 'refresh-test',
      type: 'oauth',
    };
    const credentials: CredentialStore = {
      async delete() {},
      async list() {
        return [{ providerId: 'openai-codex', type: 'oauth' }];
      },
      async modify(_providerId, fn) {
        return fn(credential);
      },
      async read() {
        return credential;
      },
    };
    const models = createModels({ credentials });
    models.setProvider(openaiCodexProvider());
    const functionCall = {
      arguments: '{"task_name":"inspect"}',
      call_id: 'call_spawn',
      id: 'fc_spawn',
      name: 'spawn_agent',
      namespace: 'collaboration',
      status: 'completed',
      type: 'function_call',
    } as const;
    const customCall = {
      call_id: 'call_exec',
      id: 'ctc_exec',
      input: 'text(true);',
      name: 'exec',
      status: 'completed',
      type: 'custom_tool_call',
    } as const;
    const previousReasoning = {
      encrypted_content: null,
      summary: [{ text: 'Previous reasoning.', type: 'summary_text' }],
      type: 'reasoning',
    } as const;
    const currentReasoning = {
      encrypted_content: 'encrypted-current',
      id: 'rs_current',
      status: 'completed',
      summary: [{ text: 'Current reasoning.', type: 'summary_text' }],
      type: 'reasoning',
    } as const;
    const upstreamChunks = [
      [
        `data: ${JSON.stringify({
          response: {
            id: 'resp_lite',
            model: 'gpt-5.6-sol',
            output: [],
            status: 'in_progress',
          },
          type: 'response.created',
        })}\n\n`,
        `data: ${JSON.stringify({ item: { ...currentReasoning, encrypted_content: null, status: 'in_progress', summary: [] }, output_index: 0, type: 'response.output_item.added' })}\n\n`,
        `data: ${JSON.stringify({ delta: 'Current reasoning.', item_id: currentReasoning.id, output_index: 0, summary_index: 0, type: 'response.reasoning_summary_text.delta' })}\n\n`,
        `data: ${JSON.stringify({ item: { ...currentReasoning, encrypted_content: null }, output_index: 0, type: 'response.output_item.done' })}\n\n`,
        `data: ${JSON.stringify({ item: { ...functionCall, arguments: '', namespace: undefined, status: 'in_progress' }, output_index: 1, type: 'response.output_item.added' })}\n\n`,
        `data: ${JSON.stringify({ call_id: functionCall.call_id, delta: functionCall.arguments, output_index: 1, type: 'response.function_call_arguments.delta' })}\n\n`,
      ].join(''),
      [
        `data: ${JSON.stringify({ item: functionCall, output_index: 1, type: 'response.output_item.done' })}\n\n`,
        `data: ${JSON.stringify({ item: { ...customCall, input: '', status: 'in_progress' }, output_index: 2, type: 'response.output_item.added' })}\n\n`,
        `data: ${JSON.stringify({ delta: customCall.input, output_index: 2, type: 'response.custom_tool_call_input.delta' })}\n\n`,
        `data: ${JSON.stringify({ item: customCall, output_index: 2, type: 'response.output_item.done' })}\n\n`,
        `data: ${JSON.stringify({
          response: {
            id: 'resp_lite',
            model: 'gpt-5.6-sol',
            output: [currentReasoning, functionCall, customCall],
            status: 'completed',
            usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          },
          type: 'response.completed',
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
    ] as const;
    let observedUpstreamInput: unknown;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = Buffer.from(init?.body as Uint8Array);
      const decodedBody =
        new Headers(init?.headers).get('content-encoding') === 'zstd'
          ? zstdDecompressSync(requestBody)
          : requestBody;
      observedUpstreamInput = (JSON.parse(decodedBody.toString()) as { input?: unknown }).input;
      const encoder = new TextEncoder();
      let upstreamCancelled = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(upstreamChunks[0]));
            setImmediate(() => {
              if (!upstreamCancelled) {
                controller.enqueue(encoder.encode(upstreamChunks[1]));
                controller.close();
              }
            });
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        {
          headers: {
            'content-type': 'text/event-stream',
            'x-codex-turn-state': 'next-turn-state',
          },
          status: 200,
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const observedUsage: unknown[] = [];
    const observedTurnStates: string[] = [];
    const additionalTools = {
      role: 'developer',
      tools: [
        {
          description: 'Default local tools.',
          name: 'functions',
          tools: [
            {
              description: 'Run code.',
              format: { type: 'text' },
              name: 'exec',
              type: 'custom',
            },
          ],
          type: 'namespace',
        },
        {
          description: 'Coordinate agents.',
          name: 'collaboration',
          tools: [
            {
              description: 'Spawn an agent.',
              name: 'spawn_agent',
              parameters: { type: 'object', properties: {} },
              strict: false,
              type: 'function',
            },
          ],
          type: 'namespace',
        },
      ],
      type: 'additional_tools',
    } as const;

    try {
      const stream = await new PiAiGatewayClient().createResponsesStream(
        providerConfig({
          accountSlotId: 'team',
          adapterId: 'openai-codex',
          apiKey: null,
          gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
          id: 'codex-team',
          models: ['openai-codex/gpt-5.6-sol'],
          requiresApiKey: false,
          subscriptionProviderId: 'openai-codex',
        } as Partial<ResolvedLLMProviderConfig>),
        {
          input: [
            additionalTools,
            { content: [{ text: 'Delegate.', type: 'input_text' }], role: 'user' },
            previousReasoning,
            {
              arguments: '{"task_name":"previous"}',
              call_id: 'call_previous_shared',
              id: 'fc_previous_spawn',
              name: 'spawn_agent',
              namespace: 'collaboration',
              type: 'function_call',
            },
            {
              call_id: 'call_previous_shared',
              output: 'Spawned.',
              type: 'function_call_output',
            },
            {
              call_id: 'call_previous_shared',
              id: 'ctc_previous_exec',
              input: 'text(true);',
              name: 'exec',
              namespace: '',
              type: 'custom_tool_call',
            },
            {
              call_id: 'call_previous_shared',
              output: 'true',
              type: 'custom_tool_call_output',
            },
          ],
          include: ['reasoning.encrypted_content'],
          model: 'openai-codex/gpt-5.6-sol',
          prompt_cache_key: 'safe-cache-key',
          store: false,
          stream: true,
          tool_choice: 'auto',
          tools: [],
        },
        (usage) => observedUsage.push(usage),
        {
          codexTurnState: 'previous-turn-state',
          onCodexTurnState: (value) => observedTurnStates.push(value),
        },
        models
      );

      const body = await new Response(stream).text();
      const events = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
      expect(events.map((event) => event.type)).toEqual([
        'response.created',
        'response.output_item.added',
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_text.delta',
        'response.reasoning_summary_text.done',
        'response.reasoning_summary_part.done',
        'response.output_item.added',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
        'response.output_item.added',
        'response.custom_tool_call_input.delta',
        'response.custom_tool_call_input.done',
        'response.output_item.done',
        'response.output_item.done',
        'response.completed',
      ]);
      expect(events[1]).toMatchObject({ item: { id: currentReasoning.id } });
      expect(events[6]).toMatchObject({
        item: {
          arguments: '',
          call_id: 'call_spawn',
          id: 'fc_spawn',
          name: 'spawn_agent',
          namespace: 'collaboration',
          type: 'function_call',
        },
      });
      expect(events[7]).toMatchObject({
        call_id: functionCall.call_id,
        item_id: functionCall.id,
        delta: functionCall.arguments,
      });
      expect(events[8]).toMatchObject({
        item_id: functionCall.id,
        arguments: functionCall.arguments,
      });
      expect(events[9]).toMatchObject({ item: functionCall });
      expect(events[10]).toMatchObject({
        item: {
          call_id: 'call_exec',
          id: 'ctc_exec',
          input: '',
          name: 'exec',
          type: 'custom_tool_call',
        },
      });
      expect(events[11]).toMatchObject({ delta: customCall.input });
      expect(events[13]).toMatchObject({ item: customCall });
      expect(events[14]).toMatchObject({ item: currentReasoning });
      expect(events[15]).toMatchObject({
        response: { output: [currentReasoning, functionCall, customCall] },
      });
      expect(body).toContain('data: [DONE]');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(observedUpstreamInput).toEqual([
        additionalTools,
        { content: [{ text: 'Delegate.', type: 'input_text' }], role: 'user' },
        previousReasoning,
        {
          arguments: '{"task_name":"previous"}',
          call_id: 'call_previous_shared',
          id: 'fc_previous_spawn',
          name: 'spawn_agent',
          namespace: 'collaboration',
          type: 'function_call',
        },
        {
          call_id: 'call_previous_shared',
          output: 'Spawned.',
          type: 'function_call_output',
        },
        {
          call_id: 'call_previous_shared',
          id: 'ctc_previous_exec',
          input: 'text(true);',
          name: 'exec',
          namespace: '',
          type: 'custom_tool_call',
        },
        {
          call_id: 'call_previous_shared',
          output: 'true',
          type: 'custom_tool_call_output',
        },
      ]);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      const headers = new Headers(init?.headers);
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(headers.get('authorization')).toBe(`Bearer ${accessToken}`);
      expect(headers.get('chatgpt-account-id')).toBe('account-test');
      expect(headers.get('session-id')).toBe('safe-cache-key');
      expect(headers.get('x-client-request-id')).toBe('safe-cache-key');
      expect(headers.get('x-codex-turn-state')).toBe('previous-turn-state');
      expect(observedUsage).toEqual([
        expect.objectContaining({ input: 11, output: 7, totalTokens: 18 }),
      ]);
      expect(observedTurnStates).toEqual(['next-turn-state']);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it.each([
    ['an unknown request field', { background: true }],
    ['an unsupported reasoning context', { reasoning: { context: 'last_turn' } }],
    [
      'a provider-executed additional tool',
      {
        input: [
          {
            role: 'developer',
            tools: [{ type: 'web_search_preview' }],
            type: 'additional_tools',
          },
          { content: 'Hello', role: 'user' },
        ],
      },
    ],
    [
      'a provider-executed namespaced tool',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                name: 'remote',
                tools: [{ type: 'mcp', server_url: 'https://attacker.example/mcp' }],
                type: 'namespace',
              },
            ],
            type: 'additional_tools',
          },
          { content: 'Hello', role: 'user' },
        ],
      },
    ],
    [
      'a nested namespace',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                name: 'local',
                tools: [
                  {
                    name: 'nested',
                    tools: [{ name: 'exec', parameters: { type: 'object' }, type: 'function' }],
                    type: 'namespace',
                  },
                ],
                type: 'namespace',
              },
            ],
            type: 'additional_tools',
          },
          { content: 'Hello', role: 'user' },
        ],
      },
    ],
    [
      'a null additional-tools id',
      {
        input: [
          {
            id: null,
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'a non-additional-tools id prefix',
      {
        input: [
          {
            id: 'msg_01234567-89ab-5def-8abc-0123456789ab',
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'a malformed additional-tools UUIDv5',
      {
        input: [
          {
            id: 'at_01234567-89ab-4def-8abc-0123456789ab',
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'an unknown additional-tools field',
      {
        input: [
          {
            extra: true,
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'a misplaced additional-tools prefix',
      {
        input: [
          { content: 'Hello', role: 'user' },
          {
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'duplicate callable tool keys',
      {
        input: [
          {
            role: 'developer',
            tools: [
              { format: { type: 'text' }, name: 'exec', type: 'custom' },
              { name: 'exec', parameters: { type: 'object' }, type: 'function' },
            ],
            type: 'additional_tools',
          },
          { content: 'Hello', role: 'user' },
        ],
      },
    ],
    [
      'a root and default-namespace callable collision',
      {
        input: [
          {
            role: 'developer',
            tools: [
              { name: 'exec', parameters: { type: 'object' }, type: 'function' },
              {
                name: 'functions',
                tools: [{ format: { type: 'text' }, name: 'exec', type: 'custom' }],
                type: 'namespace',
              },
            ],
            type: 'additional_tools',
          },
          { content: 'Hello', role: 'user' },
        ],
      },
    ],
    [
      'duplicate tool-search declarations',
      {
        input: [
          {
            role: 'developer',
            tools: [{ type: 'tool_search' }, { type: 'tool_search' }],
            type: 'additional_tools',
          },
          { content: 'Hello', role: 'user' },
        ],
      },
    ],
    [
      'a provider-executed tool-search declaration',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                description: 'Search local tools.',
                execution: 'server',
                parameters: { type: 'object' },
                type: 'tool_search',
              },
            ],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'a tool-search declaration without object parameters',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                description: 'Search local tools.',
                execution: 'client',
                parameters: 'not-a-schema',
                type: 'tool_search',
              },
            ],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'a false defer-loading marker',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                defer_loading: false,
                name: 'wait',
                parameters: { type: 'object' },
                type: 'function',
              },
            ],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'a caller-declared reserved search function',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                name: WORKER_CLIENT_TOOL_SEARCH_FUNCTION,
                parameters: { type: 'object' },
                type: 'function',
              },
            ],
            type: 'additional_tools',
          },
        ],
      },
    ],
    [
      'an unmatched client tool-search output',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                description: 'Search local tools.',
                execution: 'client',
                parameters: { type: 'object' },
                type: 'tool_search',
              },
            ],
            type: 'additional_tools',
          },
          {
            call_id: 'call_missing',
            execution: 'client',
            status: 'completed',
            tools: [],
            type: 'tool_search_output',
          },
        ],
      },
    ],
    [
      'a conflicting discovered tool definition',
      {
        input: [
          {
            role: 'developer',
            tools: [
              {
                description: 'Search local tools.',
                execution: 'client',
                parameters: { type: 'object' },
                type: 'tool_search',
              },
              { name: 'wait', parameters: { type: 'object' }, type: 'function' },
            ],
            type: 'additional_tools',
          },
          {
            arguments: {},
            call_id: 'call_search',
            execution: 'client',
            type: 'tool_search_call',
          },
          {
            call_id: 'call_search',
            execution: 'client',
            status: 'completed',
            tools: [
              {
                name: 'wait',
                parameters: { properties: { reason: { type: 'string' } }, type: 'object' },
                type: 'function',
              },
            ],
            type: 'tool_search_output',
          },
        ],
      },
    ],
    [
      'duplicate native call carriers',
      {
        input: [
          {
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
          {
            arguments: '{}',
            call_id: 'call_wait',
            id: 'fc_wait',
            name: 'wait',
            type: 'function_call',
          },
          {
            arguments: '{}',
            call_id: 'call_wait',
            id: 'fc_wait',
            name: 'wait',
            type: 'function_call',
          },
        ],
      },
    ],
    [
      'an unmatched native function call',
      {
        input: [
          {
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
          {
            arguments: '{}',
            call_id: 'call_wait',
            id: 'fc_wait',
            name: 'wait',
            type: 'function_call',
          },
        ],
      },
    ],
    [
      'an unknown native message field',
      {
        input: [
          {
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
          { content: 'Hello', private_extension: true, role: 'user', type: 'message' },
        ],
      },
    ],
    [
      'a null native message phase',
      {
        input: [
          {
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
          { content: 'Hello', phase: null, role: 'assistant', type: 'message' },
        ],
      },
    ],
    [
      'an unknown native message phase',
      {
        input: [
          {
            role: 'developer',
            tools: [{ name: 'wait', parameters: { type: 'object' }, type: 'function' }],
            type: 'additional_tools',
          },
          { content: 'Hello', phase: 'analysis', role: 'assistant', type: 'message' },
        ],
      },
    ],
    [
      'custom history without its message-anchored declaration',
      {
        input: [
          {
            call_id: 'call_undeclared',
            id: 'ctc_undeclared',
            input: 'text(true);',
            name: 'exec',
            type: 'custom_tool_call',
          },
        ],
      },
    ],
    [
      'custom history with an undeclared name',
      {
        input: [
          {
            role: 'developer',
            tools: [{ format: { type: 'text' }, name: 'exec', type: 'custom' }],
            type: 'additional_tools',
          },
          {
            call_id: 'call_other',
            id: 'ctc_other',
            input: 'text(true);',
            name: 'other',
            type: 'custom_tool_call',
          },
        ],
      },
    ],
    [
      'custom history with a declared-kind mismatch',
      {
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
      },
    ],
  ])('rejects %s before credential or provider access', async (_label, patch) => {
    const read = vi.fn(async () => undefined);
    const modify = vi.fn(async () => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const models = createModels({
      credentials: {
        async delete() {},
        async list() {
          return [];
        },
        modify,
        read,
      },
    });
    try {
      await expect(
        new PiAiGatewayClient().createResponsesStream(
          providerConfig({
            accountSlotId: 'team',
            adapterId: 'openai-codex',
            apiKey: null,
            gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
            id: 'codex-team',
            models: ['openai-codex/gpt-5.6-sol'],
            requiresApiKey: false,
            subscriptionProviderId: 'openai-codex',
          } as Partial<ResolvedLLMProviderConfig>),
          {
            input: 'Hello',
            model: 'openai-codex/gpt-5.6-sol',
            stream: true,
            ...patch,
          },
          undefined,
          {},
          models
        )
      ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
      expect(read).not.toHaveBeenCalled();
      expect(modify).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
