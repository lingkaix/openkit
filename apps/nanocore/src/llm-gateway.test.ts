import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { createAuthMiddleware } from './auth/middleware.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import type { ProviderProfile } from './config/providers-loader.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { registerLlmGatewayRoutes } from './llm/gateway-routes.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { ProviderSubscriptionAccountError } from './llm/provider-subscription-accounts.js';
import { resolveProviderProfileToLLMConfig } from './providers/llm-config.js';
import { ProviderRegistry } from './providers/registry.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { listVaultUseRecords } from './vault/vault-use-records.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates runtime app options for one Gateway provider fixture.
 *
 * @param profile Provider profile with an explicit default model.
 * @param credential Credential resolved for the profile secret reference.
 * @returns Runtime Provider supply, logical model route, and credential resolver.
 */
function createProviderOptions(
  profile: ProviderProfile & { defaultModel: string },
  credential: string | null = null
) {
  return {
    gatewayConfig: logicalGatewayConfig(profile),
    openKitConfig: {},
    providerCredentialResolver: () => credential,
    providerRegistry: new ProviderRegistry([profile]),
  };
}

function logicalGatewayConfig(profile: ProviderProfile & { defaultModel: string }) {
  return {
    schemaVersion: 1 as const,
    enabled: true,
    defaultLogicalModelId: profile.defaultModel,
    logicalModels: [
      {
        id: profile.defaultModel,
        displayName: profile.defaultModel,
        routes: [
          {
            id: 'primary',
            providerProfileId: profile.id,
            providerModel: profile.defaultModel,
          },
        ],
      },
    ],
  };
}

/**
 * Records the active local-user authority required by an attributed Gateway fixture.
 *
 * @param coreDb Core database owning identity and Workspace membership.
 * @param workspaceId Workspace attributed by the test request.
 */
function recordLocalGatewayAuthority(
  coreDb: ReturnType<typeof openCoreDb>,
  workspaceId: string
): void {
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId });
}

/** Creates the runtime Ollama fixture used by Gateway tests. */
function createOllamaProviderOptions() {
  return createProviderOptions(
    {
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.1',
      displayName: 'OpenRouter',
      id: 'openrouter-test',
      kind: 'gateway',
      models: ['openai/gpt-5.1'],
      secretRef: 'env:OPENROUTER_API_KEY',
      vendor: 'openrouter',
    },
    'openrouter-secret'
  );
}

/** Creates the runtime OpenAI fixture used by Gateway tests. */
function createOpenAIProviderOptions() {
  return createProviderOptions(
    {
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.1',
      displayName: 'OpenAI',
      id: 'openai',
      kind: 'direct',
      models: ['gpt-5.1'],
      secretRef: 'env:OPENAI_API_KEY',
      vendor: 'openai',
    },
    'sk-test'
  );
}

/** Creates the runtime Anthropic fixture used by Gateway tests. */
function createAnthropicProviderOptions() {
  return createProviderOptions(
    {
      defaultModel: 'claude-sonnet-4-5',
      displayName: 'Anthropic',
      id: 'anthropic',
      kind: 'direct',
      models: ['claude-sonnet-4-5'],
      secretRef: 'env:ANTHROPIC_API_KEY',
      vendor: 'anthropic',
    },
    'anthropic-secret'
  );
}

/**
 * Creates a runtime Google or OpenRouter fixture used by pi-ai Gateway tests.
 *
 * @param providerId Provider implemented by the pi-ai adapter.
 * @returns Runtime provider options with the matching credential.
 */
function createPiAiProviderOptions(providerId: 'google' | 'openrouter') {
  const model = providerId === 'google' ? 'gemini-2.5-pro' : 'anthropic/claude-sonnet-4.5';
  return createProviderOptions(
    {
      defaultModel: model,
      displayName: providerId === 'google' ? 'Gemini' : 'OpenRouter',
      id: providerId,
      kind: providerId === 'openrouter' ? 'gateway' : 'direct',
      models: [model],
      secretRef: providerId === 'google' ? 'env:GOOGLE_GEMINI_API_KEY' : 'env:OPENROUTER_API_KEY',
      vendor: providerId,
    },
    `${providerId}-secret`
  );
}

function runtimeProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      defaultModel: 'gpt-5.1',
      displayName: 'Runtime OpenAI',
      id: 'runtime-openai',
      kind: 'local',
      models: ['gpt-5.1'],
      vendor: 'openai',
    },
  ]);
}

/**
 * Registers one direct Gateway app without activating production startup composition.
 *
 * @param input Runtime profiles, dispatcher, and pair-handle seam used by one test.
 * @returns Local-authenticated Hono app with only the direct Gateway routes registered.
 */
function createDirectGatewayApp(input: {
  readonly defaultProviderId: string;
  readonly dispatcher: LLMGatewayProviderDispatcher;
  readonly getPairHandle: unknown;
  readonly profiles: ProviderProfile[];
}): Hono {
  const providerRegistry = new ProviderRegistry(input.profiles);
  const defaultProfile = input.profiles.find((profile) => profile.id === input.defaultProviderId);
  if (!defaultProfile?.defaultModel) throw new Error('Default test Provider model is required.');
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: null,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: defaultProfile.defaultModel,
      logicalModels: [
        {
          id: defaultProfile.defaultModel,
          displayName: defaultProfile.defaultModel,
          routes: [
            {
              id: 'primary',
              providerProfileId: defaultProfile.id,
              providerModel: defaultProfile.defaultModel,
            },
          ],
        },
      ],
    },
    openKitConfig: {},
    providerRegistry,
  });
  const app = new Hono();
  app.use('*', createAuthMiddleware('local'));
  (registerLlmGatewayRoutes as unknown as (dependencies: Record<string, unknown>) => void)({
    app,
    llmGatewayDispatcher: input.dispatcher,
    providerSubscriptionAccountManager: { getPairHandle: input.getPairHandle },
    resolveGatewayProvider: (providerId: string) => {
      const profile = providerRegistry.get(providerId);
      if (!profile) {
        throw new Error(`Unknown test provider: ${providerId}`);
      }
      return resolveProviderProfileToLLMConfig(profile);
    },
    runtimeConfig: () => snapshot,
  });
  return app;
}

describe('OpenAI-compatible agent gateway', () => {
  it('keeps the public Gateway surface on Chat Completions and Responses only', () => {
    const appSource = readFileSync('./src/app.ts', 'utf8');
    const dispatcherSource = readFileSync('./src/llm/provider-dispatcher.ts', 'utf8');
    const gatewaySource = readFileSync('./src/llm/gateway-routes.ts', 'utf8');

    expect(appSource).toContain('registerLlmGatewayRoutes({');
    expect(appSource).not.toContain('CodexOAuthStore');
    expect(appSource).not.toContain('CodexAuthTokenResolver');
    expect(appSource).not.toContain('CodexResponsesClient');
    expect(appSource).not.toContain('codexOAuthStore');
    expect(appSource).not.toContain('llmCodexResponsesClient');
    expect(appSource).not.toContain('registerOpenAICompatFacade');
    expect(appSource).not.toContain('/internal/v1/chat/completions');
    expect(appSource).not.toContain("app.get('/v1/models'");
    expect(appSource).not.toContain("app.post('/v1/chat/completions'");
    expect(appSource).not.toContain("app.post('/v1/responses'");
    expect(gatewaySource).toContain("app.get('/v1/models'");
    expect(gatewaySource).toContain("app.post('/v1/chat/completions'");
    expect(gatewaySource).toContain("app.post('/v1/responses'");
    expect(gatewaySource).not.toContain("app.post('/v1/completions'");
    expect(dispatcherSource).not.toContain('codexResponsesClient');
  });

  it('does not expose the historical internal Chat Completions facade', async () => {
    const app = createApp();

    const res = await app.request('/internal/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-5.1', messages: [] }),
    });

    expect(res.status).toBe(404);
  });

  it('returns process health for gateway clients', async () => {
    const app = createApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'nanocore',
    });
  });

  it('does not expose the unsupported text completions endpoint', async () => {
    const app = createApp();

    const res = await app.request('/v1/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        prompt: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(404);
  });

  it('lists only product-visible logical models', async () => {
    const app = createApp(createOpenAIProviderOptions());

    const res = await app.request('/v1/models');
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; object: string };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      object: 'list',
      data: [{ id: 'gpt-5.1', display_name: 'gpt-5.1', owned_by: 'openkit' }],
    });
    expect(JSON.stringify(body)).not.toContain('openai');
  });

  it('retains a logical model when at least one configured route is dispatchable', async () => {
    const app = createApp({
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            routes: [
              { id: 'blocked', providerProfileId: 'blocked', providerModel: 'gpt-5.1' },
              { id: 'ready', providerProfileId: 'ready', providerModel: 'gpt-5.1' },
            ],
          },
        ],
      },
      openKitConfig: {},
      providerRegistry: new ProviderRegistry([
        {
          displayName: 'Blocked',
          id: 'blocked',
          kind: 'local',
          models: ['gpt-5.1'],
          readiness: { status: 'blocked', summary: 'Unavailable' },
          vendor: 'openai',
        },
        {
          displayName: 'Ready',
          id: 'ready',
          kind: 'local',
          models: ['gpt-5.1'],
          vendor: 'openai',
        },
      ]),
    });

    const body = (await (await app.request('/v1/models')).json()) as {
      data: Array<{ id: string }>;
    };

    expect(body.data).toEqual([expect.objectContaining({ id: 'reasoning' })]);
  });

  it('projects JSON provider failures with stable generic OpenKit errors', async () => {
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new OpenAICompatibleProviderError({
            code: 'native_quota_exceeded',
            message: 'private upstream quota text marker=upstream-json-secret',
            status: 429,
            type: 'pi_ai_provider_error',
          });
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'gateway_logical_model_unavailable',
        message: 'Logical model is temporarily unavailable.',
        type: 'provider_error',
      },
    });
  });

  it('does not publish provider-native codes that resemble internal vault errors', async () => {
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new OpenAICompatibleProviderError({
            code: 'vault-private-upstream-code',
            message: 'private upstream vault-shaped failure marker=upstream-code-secret',
            status: 502,
            type: 'pi_ai_provider_error',
          });
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'gateway_logical_model_unavailable',
        message: 'Logical model is temporarily unavailable.',
        type: 'provider_error',
      },
    });
  });

  it('routes non-streaming chat completions through the gateway default provider', async () => {
    const seenRequests: unknown[] = [];
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          seenRequests.push(request);

          return {
            id: 'chatcmpl_gateway',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Gateway response' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: 'chatcmpl_gateway',
      model: 'openai/gpt-5.1',
      choices: [{ message: { content: 'Gateway response' } }],
    });
    expect(seenRequests).toEqual([
      expect.objectContaining({
        prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
      }),
    ]);
  });

  it('keeps private routes hidden while falling back before output', async () => {
    const attempts: Array<{ model: string; providerId: string }> = [];
    const app = createApp({
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            routes: [
              { id: 'primary', providerProfileId: 'openai-primary', providerModel: 'gpt-5.1' },
              {
                id: 'backup',
                providerProfileId: 'openrouter-backup',
                providerModel: 'openai/gpt-5.1',
              },
            ],
          },
        ],
      },
      openKitConfig: {},
      providerRegistry: new ProviderRegistry([
        {
          displayName: 'Primary',
          id: 'openai-primary',
          kind: 'local',
          models: ['gpt-5.1'],
          vendor: 'openai',
        },
        {
          displayName: 'Backup',
          id: 'openrouter-backup',
          kind: 'local',
          models: ['openai/gpt-5.1'],
          vendor: 'openrouter',
        },
      ]),
      llmGatewayDispatcher: {
        createChatCompletion: async (provider, request) => {
          attempts.push({ model: request.model, providerId: provider.id });
          if (provider.id === 'openai-primary') {
            throw new OpenAICompatibleProviderError({ message: 'quota', status: 429 });
          }
          return {
            id: 'chatcmpl_fallback',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'backup' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as LLMGatewayProviderDispatcher,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'reasoning',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ model: 'reasoning' });
    expect(attempts).toEqual([
      { model: 'gpt-5.1', providerId: 'openai-primary' },
      { model: 'openai/gpt-5.1', providerId: 'openrouter-backup' },
    ]);
  });

  it('rewrites provider-native models in public SSE events', async () => {
    const options = createOpenAIProviderOptions();
    const app = createApp({
      ...options,
      gatewayConfig: {
        ...options.gatewayConfig,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            routes: [{ id: 'primary', providerProfileId: 'openai', providerModel: 'gpt-5.1' }],
          },
        ],
      },
      llmGatewayDispatcher: {
        createChatCompletionStream: async () =>
          new Response(
            'data: {"id":"chunk","object":"chat.completion.chunk","model":"gpt-5.1","choices":[]}\n\ndata: [DONE]\n\n'
          ).body!,
      } as unknown as LLMGatewayProviderDispatcher,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'reasoning',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('"model":"reasoning"');
    expect(body).not.toContain('gpt-5.1');
  });

  it('passes the public request abort signal to the gateway dispatcher', async () => {
    const abortController = new AbortController();
    let dispatchedSignal: AbortSignal | undefined;
    let markProviderStarted: (() => void) | undefined;
    let releaseProvider: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmGatewayDispatcher: {
        createChatCompletion: async (_provider, request, context = {}) => {
          dispatchedSignal = (context as { readonly transport?: { readonly signal?: AbortSignal } })
            .transport?.signal;
          markProviderStarted?.();
          await providerRelease;

          return {
            id: 'chatcmpl_signal',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Signal received' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as LLMGatewayProviderDispatcher,
    });

    const responsePromise = app.request('/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'openai/gpt-5.1',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: abortController.signal,
    });

    await providerStarted;
    expect(dispatchedSignal?.aborted).toBe(false);
    abortController.abort();
    expect(dispatchedSignal?.aborted).toBe(true);
    releaseProvider?.();

    expect((await responsePromise).status).toBe(200);
  });

  it('routes Anthropic chat completions through the pi-ai dispatcher path', async () => {
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'claude-sonnet-4-5' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'Anthropic through pi-ai' } }],
    });
    expect(faux.state.callCount).toBe(1);
  });

  it('routes Anthropic chat function tools through the pi-ai dispatcher path', async () => {
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'claude-sonnet-4-5' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_docs', { query: 'OpenKit' }, { id: 'call_1' })], {
        stopReason: 'toolUse',
      }),
    ]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Search the docs' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'search_docs',
              description: 'Search project documentation.',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search_docs', arguments: '{"query":"OpenKit"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(faux.state.callCount).toBe(1);
  });

  it('streams Anthropic chat completions through the pi-ai dispatcher path', async () => {
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic stream through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();

    expect(body).toContain('Anthropic stream through pi-ai');
    expect(body).toContain('data: [DONE]');
    expect(faux.state.callCount).toBe(1);
  });

  it('streams Anthropic chat function tools through the pi-ai dispatcher path', async () => {
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('search_docs', { query: 'OpenKit' }, { id: 'call_stream_route' })],
        { stopReason: 'toolUse' }
      ),
    ]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'Search the docs' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'search_docs',
              description: 'Search project documentation.',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();

    expect(body).toContain('"id":"call_stream_route"');
    expect(body).toContain('"name":"search_docs"');
    expect(body).toContain('"arguments":"{\\"query\\":\\"OpenKit\\"}"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('data: [DONE]');
    expect(faux.state.callCount).toBe(1);
  });

  it('bridges Anthropic Responses requests through the pi-ai dispatcher path', async () => {
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'claude-sonnet-4-5' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic responses through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        input: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      object: 'response',
      output: [{ content: [{ text: 'Anthropic responses through pi-ai' }] }],
    });
    expect(faux.state.callCount).toBe(1);
  });

  it('routes Google and OpenRouter Chat Completions through pi-ai', async () => {
    for (const providerId of ['google', 'openrouter']) {
      const model = providerId === 'google' ? 'gemini-2.5-pro' : 'anthropic/claude-sonnet-4.5';
      const faux = fauxProvider({
        provider: providerId,
        models: [{ id: model }],
        tokenSize: { min: 1000, max: 1000 },
      });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage(`${providerId} via pi-ai`)]);
      const app = createApp({
        ...createPiAiProviderOptions(providerId),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });
      const body = await res.text();

      expect(res.status, body).toBe(200);
      expect(body).toContain(`${providerId} via pi-ai`);
      expect(faux.state.callCount).toBe(1);
    }
  });

  it('denies an attributed Gateway call when current Workspace authority is revoked before provider dispatch', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-current-authority-'));
    const coreDb = openCoreDb(dataRoot);
    const store = createDemoStore({ dataRoot });
    const workspace = store.createWorkspace('Gateway current authority');
    const providerOptions = createOllamaProviderOptions();
    let upstreamCalls = 0;

    try {
      applyMigrations(coreDb);
      recordLocalGatewayAuthority(coreDb, workspace.id);
      const baseRuntimeConfigManager = createRuntimeConfigManager({
        dataRoot,
        initialSnapshot: createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          openKitConfig: providerOptions.openKitConfig,
          providerRegistry: providerOptions.providerRegistry,
        }),
      });
      let revokeOnNextConfigRead = false;
      const runtimeConfigManager = {
        ...baseRuntimeConfigManager,
        current: () => {
          if (revokeOnNextConfigRead) {
            revokeOnNextConfigRead = false;
            coreDb.sqlite.transaction(() => {
              disableCanonicalUser(coreDb, 'user_local');
            })();
          }
          return baseRuntimeConfigManager.current();
        },
      };
      const app = createApp({
        coreDb,
        dataRoot,
        store,
        providerCredentialResolver: providerOptions.providerCredentialResolver,
        runtimeConfigManager,
        llmPiAiClient: {
          createChatCompletion: async (_provider, request, onUsage) => {
            upstreamCalls += 1;
            onUsage?.({ completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 });
            return {
              choices: [],
              created: 1,
              id: 'chatcmpl_stale_authority',
              model: request.model,
              object: 'chat.completion',
            };
          },
        } as unknown as PiAiGatewayClient,
      });
      revokeOnNextConfigRead = true;

      const response = await app.request('/v1/chat/completions', {
        body: JSON.stringify({
          messages: [{ content: 'Do not dispatch', role: 'user' }],
          metadata: { openkit: { workspaceId: workspace.id } },
          model: 'openai/gpt-5.1',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(upstreamCalls).toBe(0);

      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        applyScopedMigrations(workspaceDb);
        expect(
          workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get()
        ).toEqual({ count: 0 });
        expect(
          workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM usage_records').get()
        ).toEqual({ count: 0 });
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records durable usage for attributed Anthropic Chat Completions through pi-ai', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const store = createDemoStore({ dataRoot });
    const workspace = store.createWorkspace('Gateway usage');
    const piAiClient: Pick<PiAiGatewayClient, 'createChatCompletion'> = {
      createChatCompletion: async (_provider, request, onUsage) => {
        onUsage?.({
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.0012 },
          input: 6,
          output: 4,
          totalTokens: 15,
        });

        return {
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: 'durable usage ok', role: 'assistant' },
            },
          ],
          created: 1,
          id: 'chatcmpl_durable_usage',
          model: request.model,
          object: 'chat.completion',
          usage: { completion_tokens: 4, prompt_tokens: 9, total_tokens: 13 },
        };
      },
    };

    try {
      applyMigrations(coreDb);
      recordLocalGatewayAuthority(coreDb, workspace.id);

      const app = createApp({
        coreDb,
        dataRoot,
        store,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          piAiClient: piAiClient as PiAiGatewayClient,
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'Hello with an appended suffix' }],
          prompt_cache_key: 'private-cache-key',
          prompt_cache_retention: 'long',
          metadata: {
            openkit: {
              agentId: 'assistant',
              agentSessionId: 'session_1',
              itemId: 'item_1',
              requestId: '11111111-1111-4111-8111-111111111111',
              sourceIds: ['repo_default'],
              threadId: 'thread_1',
              turnId: 'turn_1',
              workspaceId: workspace.id,
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });

      const responseText = await res.text();

      expect(res.status, responseText).toBe(200);
      expect(responseText).not.toContain('cacheRead');
      expect(responseText).not.toContain('cacheWrite');
      expect(responseText).not.toContain('cost');
      expect(responseText).not.toContain('private-cache-key');

      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        const call = workspaceDb.sqlite
          .prepare(
            `SELECT workspace_id, thread_id, turn_id, item_id, agent_id, agent_session_id,
                    request_id, source_ids_json, capability_id, family, operation, provider_ref,
                    service_ref, redaction_class, status
             FROM capability_calls`
          )
          .get();
        const usageRows = workspaceDb.sqlite
          .prepare(
            `SELECT workspace_id, thread_id, turn_id, item_id, capability_call_id, request_id,
                    agent_id, agent_session_id, source_ids_json, category, unit, quantity,
                    model_id, provider_ref, source
             FROM usage_records
             ORDER BY source`
          )
          .all();

        expect(call).toMatchObject({
          agent_id: 'assistant',
          agent_session_id: 'session_1',
          capability_id: 'llm.chat_completions',
          family: 'llm',
          item_id: 'item_1',
          operation: 'chat_completions',
          provider_ref: 'anthropic',
          redaction_class: 'metadata-only',
          request_id: '11111111-1111-4111-8111-111111111111',
          service_ref: 'llm-gateway',
          source_ids_json: '["repo_default"]',
          status: 'succeeded',
          thread_id: 'thread_1',
          turn_id: 'turn_1',
          workspace_id: workspace.id,
        });
        expect(
          usageRows.map((row) => {
            const usage = row as { quantity: number; source: string; unit: string };

            return { quantity: usage.quantity, source: usage.source, unit: usage.unit };
          })
        ).toEqual([
          {
            quantity: 0,
            source: 'llm-gateway-adapter-reported:cache_read',
            unit: 'tokens',
          },
          {
            quantity: 0,
            source: 'llm-gateway-adapter-reported:cache_write',
            unit: 'tokens',
          },
          {
            quantity: 0.0012,
            source: 'llm-gateway-adapter-reported:cost_estimate',
            unit: 'usd',
          },
          {
            quantity: 6,
            source: 'llm-gateway-adapter-reported:input',
            unit: 'tokens',
          },
          {
            quantity: 4,
            source: 'llm-gateway-adapter-reported:output',
            unit: 'tokens',
          },
        ]);
        expect(usageRows.every((row) => (row as { quantity: number }).quantity >= 0)).toBe(true);
      } finally {
        workspaceDb.sqlite.close();
      }

      const usageRes = await app.request(`/api/app/workspaces/${workspace.id}/capability-usage`);
      const usageText = await usageRes.text();
      expect(usageRes.status, usageText).toBe(200);
      const usageBody = JSON.parse(usageText);

      expect(usageBody).toMatchObject({
        capabilityCalls: [
          expect.objectContaining({
            capabilityId: 'llm.chat_completions',
            operation: 'chat_completions',
            providerRef: 'anthropic',
            status: 'succeeded',
          }),
        ],
        usageRecords: expect.arrayContaining([
          expect.objectContaining({
            category: 'llm',
            modelId: 'claude-sonnet-4-5',
            providerRef: 'anthropic',
            unit: 'tokens',
            workspaceId: workspace.id,
          }),
        ]),
        workspaceId: workspace.id,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records durable usage for attributed native OpenAI-compatible Chat Completions', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-openai-compatible-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const store = createDemoStore({ dataRoot });
    const workspace = store.createWorkspace('Native OpenAI usage');

    try {
      applyMigrations(coreDb);
      recordLocalGatewayAuthority(coreDb, workspace.id);

      const app = createApp({
        coreDb,
        dataRoot,
        store,
        gatewayConfig: logicalGatewayConfig({
          defaultModel: 'gpt-5.1',
          displayName: 'Runtime OpenAI',
          id: 'runtime-openai',
          kind: 'local',
          models: ['gpt-5.1'],
          vendor: 'openai',
        }),
        openKitConfig: {},
        providerRegistry: runtimeProviderRegistry(),
        llmPiAiClient: {
          createChatCompletion: async (_provider, request, onUsage) => {
            const usage = {
              prompt_tokens: 7,
              completion_tokens: 5,
              total_tokens: 12,
            };
            onUsage?.(usage);

            return {
              id: 'chatcmpl_openai_usage',
              object: 'chat.completion',
              created: 1,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Native OpenAI usage' },
                  finish_reason: 'stop',
                },
              ],
              usage,
            };
          },
        } as unknown as PiAiGatewayClient,
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.1',
          messages: [{ role: 'user', content: 'Hello' }],
          metadata: {
            openkit: {
              requestId: '22222222-2222-4222-8222-222222222222',
              threadId: 'thread_openai',
              workspaceId: workspace.id,
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });
      const body = await res.text();

      expect(res.status, body).toBe(200);

      const usageRes = await app.request(`/api/app/workspaces/${workspace.id}/capability-usage`);
      const usageText = await usageRes.text();
      expect(usageRes.status, usageText).toBe(200);

      expect(JSON.parse(usageText)).toMatchObject({
        capabilityCalls: [
          expect.objectContaining({
            capabilityId: 'llm.chat_completions',
            operation: 'chat_completions',
            providerRef: 'runtime-openai',
            status: 'succeeded',
            threadId: 'thread_openai',
          }),
        ],
        usageRecords: expect.arrayContaining([
          expect.objectContaining({
            category: 'llm',
            modelId: 'gpt-5.1',
            providerRef: 'runtime-openai',
            quantity: 7,
            source: 'llm-gateway-adapter-reported:input',
            unit: 'tokens',
            workspaceId: workspace.id,
          }),
          expect.objectContaining({
            category: 'llm',
            modelId: 'gpt-5.1',
            providerRef: 'runtime-openai',
            quantity: 5,
            source: 'llm-gateway-adapter-reported:output',
            unit: 'tokens',
            workspaceId: workspace.id,
          }),
        ]),
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records partial durable usage for failed attributed Anthropic Chat Completions through pi-ai', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-failed-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('partial usage before failure', {
        errorMessage: 'upstream failed token=tok_secret',
        stopReason: 'error',
      }),
    ]);

    try {
      applyMigrations(coreDb);
      recordLocalGatewayAuthority(coreDb, 'ws_chat_failed_usage');

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'Hello' }],
          metadata: {
            openkit: {
              requestId: '66666666-6666-4666-8666-666666666666',
              workspaceId: 'ws_chat_failed_usage',
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(503);
      const body = await res.text();

      expect(body).toContain('"code":"gateway_logical_model_unavailable"');
      expect(body).not.toContain('tok_secret');

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_chat_failed_usage');
      try {
        expect(
          workspaceDb.sqlite
            .prepare('SELECT capability_id, operation, status, error_code FROM capability_calls')
            .get()
        ).toMatchObject({
          capability_id: 'llm.chat_completions',
          operation: 'chat_completions',
          status: 'failed',
          error_code: 'llm_gateway_failed',
        });
        const usageCount = workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM usage_records')
          .get() as { count: number };

        expect(usageCount.count).toBeGreaterThan(0);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records durable usage for attributed Anthropic Responses through pi-ai', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-responses-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('durable responses usage ok')]);

    try {
      applyMigrations(coreDb);
      recordLocalGatewayAuthority(coreDb, 'ws_responses_usage');

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          input: 'Hello',
          metadata: {
            openkit: {
              requestId: '22222222-2222-4222-8222-222222222222',
              threadId: 'thread_2',
              workspaceId: 'ws_responses_usage',
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });
      const responseText = await res.text();

      expect(res.status, responseText).toBe(200);

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_responses_usage');
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT capability_id, operation, provider_ref, request_id, status, thread_id
               FROM capability_calls`
            )
            .get()
        ).toMatchObject({
          capability_id: 'llm.responses',
          operation: 'responses',
          provider_ref: 'anthropic',
          request_id: '22222222-2222-4222-8222-222222222222',
          status: 'succeeded',
          thread_id: 'thread_2',
        });
        const usageCount = workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM usage_records')
          .get() as { count: number };

        expect(usageCount.count).toBeGreaterThan(0);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records partial durable usage for failed attributed Anthropic Responses through pi-ai', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-responses-failed-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('partial responses usage before failure', {
        errorMessage: 'upstream failed token=tok_secret',
        stopReason: 'error',
      }),
    ]);

    try {
      applyMigrations(coreDb);
      recordLocalGatewayAuthority(coreDb, 'ws_responses_failed_usage');

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          input: 'Hello',
          metadata: {
            openkit: {
              requestId: '77777777-7777-4777-8777-777777777777',
              workspaceId: 'ws_responses_failed_usage',
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(503);
      const body = await res.text();

      expect(body).toContain('"code":"gateway_logical_model_unavailable"');
      expect(body).not.toContain('tok_secret');

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_responses_failed_usage');
      try {
        expect(
          workspaceDb.sqlite
            .prepare('SELECT capability_id, operation, status, error_code FROM capability_calls')
            .get()
        ).toMatchObject({
          capability_id: 'llm.responses',
          operation: 'responses',
          status: 'failed',
          error_code: 'llm_gateway_failed',
        });
        const usageCount = workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM usage_records')
          .get() as { count: number };

        expect(usageCount.count).toBeGreaterThan(0);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('bridges Anthropic Responses streams through the pi-ai dispatcher path', async () => {
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic response stream through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        input: 'Hello',
        stream: true,
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();

    expect(body).toContain('response.output_text.delta');
    expect(body).toContain('Anthropic response stream through pi-ai');
    expect(body).toContain('data: [DONE]');
    expect(faux.state.callCount).toBe(1);
  });

  it('records durable usage for attributed Anthropic streams through pi-ai', async () => {
    for (const testCase of [
      {
        body: {
          model: 'claude-sonnet-4-5',
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
          metadata: {
            openkit: {
              requestId: '33333333-3333-4333-8333-333333333333',
              workspaceId: 'ws_chat_stream_usage',
            },
          },
        },
        capabilityId: 'llm.chat_completions',
        operation: 'chat_completions',
        path: '/v1/chat/completions',
        workspaceId: 'ws_chat_stream_usage',
      },
      {
        body: {
          model: 'claude-sonnet-4-5',
          input: 'Hello',
          stream: true,
          metadata: {
            openkit: {
              requestId: '44444444-4444-4444-8444-444444444444',
              workspaceId: 'ws_responses_stream_usage',
            },
          },
        },
        capabilityId: 'llm.responses',
        operation: 'responses',
        path: '/v1/responses',
        workspaceId: 'ws_responses_stream_usage',
      },
    ]) {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-stream-usage-'));
      const coreDb = openCoreDb(dataRoot);
      const faux = fauxProvider({
        provider: 'anthropic',
        models: [{ id: 'claude-sonnet-4-5' }],
        tokenSize: { min: 1000, max: 1000 },
      });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('durable stream usage ok')]);

      try {
        applyMigrations(coreDb);
        recordLocalGatewayAuthority(coreDb, testCase.workspaceId);

        const app = createApp({
          coreDb,
          dataRoot,
          ...createAnthropicProviderOptions(),
          llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
            piAiClient: new PiAiGatewayClient({ models }),
          }),
        });

        const res = await app.request(testCase.path, {
          method: 'POST',
          body: JSON.stringify(testCase.body),
          headers: { 'content-type': 'application/json' },
        });

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toContain('data: [DONE]');

        const workspaceDb = openWorkspaceDb(dataRoot, testCase.workspaceId);
        try {
          expect(
            workspaceDb.sqlite
              .prepare('SELECT capability_id, operation, status FROM capability_calls')
              .get()
          ).toMatchObject({
            capability_id: testCase.capabilityId,
            operation: testCase.operation,
            status: 'succeeded',
          });
          const usageCount = workspaceDb.sqlite
            .prepare('SELECT COUNT(*) AS count FROM usage_records')
            .get() as { count: number };

          expect(usageCount.count).toBeGreaterThan(0);
        } finally {
          workspaceDb.sqlite.close();
        }
      } finally {
        coreDb.sqlite.close();
      }
    }
  });

  it('records partial durable usage for failed attributed Anthropic streams through pi-ai', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-stream-failed-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const faux = fauxProvider({
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('partial usage before failure', {
        errorMessage: 'upstream failed token=tok_secret',
        stopReason: 'error',
      }),
    ]);

    try {
      applyMigrations(coreDb);
      recordLocalGatewayAuthority(coreDb, 'ws_chat_stream_failed_usage');

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
          metadata: {
            openkit: {
              requestId: '55555555-5555-4555-8555-555555555555',
              workspaceId: 'ws_chat_stream_failed_usage',
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain('"usage":{"prompt_tokens"');
      expect(body).toContain('"code":"gateway_stream_failed"');
      expect(body).toContain('"stopReason":"error"');
      expect(body).toContain('data: [DONE]');
      expect(body).not.toContain('tok_secret');

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_chat_stream_failed_usage');
      try {
        expect(
          workspaceDb.sqlite
            .prepare('SELECT capability_id, operation, status, error_code FROM capability_calls')
            .get()
        ).toMatchObject({
          capability_id: 'llm.chat_completions',
          operation: 'chat_completions',
          status: 'failed',
          error_code: 'llm_gateway_stream_failed',
        });
        const usageCount = workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM usage_records')
          .get() as { count: number };

        expect(usageCount.count).toBeGreaterThan(0);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records durable terminal usage for aborted and timed-out attributed Anthropic streams through pi-ai', async () => {
    for (const testCase of [
      {
        code: 'gateway_stream_failed',
        message: 'client aborted token=tok_secret',
        requestId: '88888888-8888-4888-8888-888888888888',
        stopReason: 'aborted' as const,
        workspaceId: 'ws_chat_stream_aborted_usage',
      },
      {
        code: 'gateway_provider_unavailable',
        message: 'provider timeout token=tok_secret',
        requestId: '99999999-9999-4999-8999-999999999999',
        stopReason: 'error' as const,
        workspaceId: 'ws_chat_stream_timeout_usage',
      },
    ]) {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-stream-terminal-'));
      const coreDb = openCoreDb(dataRoot);
      const faux = fauxProvider({
        provider: 'anthropic',
        models: [{ id: 'claude-sonnet-4-5' }],
        tokenSize: { min: 1000, max: 1000 },
      });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage('partial usage before terminal stream failure', {
          errorMessage: testCase.message,
          stopReason: testCase.stopReason,
        }),
      ]);

      try {
        applyMigrations(coreDb);
        recordLocalGatewayAuthority(coreDb, testCase.workspaceId);

        const app = createApp({
          coreDb,
          dataRoot,
          ...createAnthropicProviderOptions(),
          llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
            piAiClient: new PiAiGatewayClient({ models }),
          }),
        });

        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            stream: true,
            messages: [{ role: 'user', content: 'Hello' }],
            metadata: {
              openkit: {
                requestId: testCase.requestId,
                workspaceId: testCase.workspaceId,
              },
            },
          }),
          headers: { 'content-type': 'application/json' },
        });

        expect(res.status).toBe(200);
        const body = await res.text();

        expect(body).toContain(`"code":"${testCase.code}"`);
        expect(body).toContain('data: [DONE]');
        expect(body).not.toContain('tok_secret');

        const workspaceDb = openWorkspaceDb(dataRoot, testCase.workspaceId);
        try {
          expect(
            workspaceDb.sqlite
              .prepare('SELECT capability_id, operation, status, error_code FROM capability_calls')
              .get()
          ).toMatchObject({
            capability_id: 'llm.chat_completions',
            operation: 'chat_completions',
            status: 'failed',
            error_code: 'llm_gateway_stream_failed',
          });
          const usageCount = workspaceDb.sqlite
            .prepare('SELECT COUNT(*) AS count FROM usage_records')
            .get() as { count: number };

          expect(usageCount.count).toBeGreaterThan(0);
        } finally {
          workspaceDb.sqlite.close();
        }
      } finally {
        coreDb.sqlite.close();
      }
    }
  });

  it('resolves audited gateway credentials only after model authorization', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-vault-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const seenApiKeys: Array<string | null> = [];

    try {
      applyMigrations(coreDb);
      vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
      vaultUnlockState.backend().store({
        material: 'sk-vault-gateway',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_gateway',
      });

      const profile = {
        defaultModel: 'gpt-5.1',
        displayName: 'Vault Backed Gateway',
        id: 'vault-backed',
        kind: 'direct' as const,
        models: ['gpt-5.1'],
        secretRef: 'vault://vault_gateway',
        vendor: 'openai',
      };
      const app = createApp({
        coreDb,
        dataRoot,
        gatewayConfig: logicalGatewayConfig(profile),
        openKitConfig: {},
        providerRegistry: new ProviderRegistry([profile]),
        llmPiAiClient: {
          createChatCompletion: async (provider, request) => {
            seenApiKeys.push(provider.apiKey);

            return {
              id: 'chatcmpl_vault_gateway',
              object: 'chat.completion',
              created: 1,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'vault ok' },
                  finish_reason: 'stop',
                },
              ],
            };
          },
        } as unknown as PiAiGatewayClient,
        vaultUnlockState,
      });
      const rejected = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'undeclared-model',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: 'model_not_configured' },
      });
      expect(seenApiKeys).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.1',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ id: 'chatcmpl_vault_gateway' });
      expect(seenApiKeys).toEqual(['sk-vault-gateway']);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          resolvingPath: 'provider',
          vaultReferenceId: 'vault_gateway',
        }),
      ]);
      expect(JSON.stringify(listVaultUseRecords(coreDb))).not.toContain('sk-vault-gateway');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a fixed provider error while retaining locked-vault audit evidence', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-vault-locked-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });

    try {
      applyMigrations(coreDb);
      const profile = {
        defaultModel: 'gpt-5.1',
        displayName: 'Vault Locked Gateway',
        id: 'vault-locked',
        kind: 'direct' as const,
        models: ['gpt-5.1'],
        secretRef: 'vault://vault_locked_gateway',
        vendor: 'openai',
      };
      const app = createApp({
        coreDb,
        dataRoot,
        gatewayConfig: logicalGatewayConfig(profile),
        openKitConfig: {},
        providerRegistry: new ProviderRegistry([profile]),
        llmPiAiClient: {
          createChatCompletion: async () => {
            throw new Error('provider should not be called while vault is locked');
          },
        } as unknown as PiAiGatewayClient,
        vaultUnlockState,
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.1',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: 'gateway_logical_model_unavailable',
          message: 'Logical model is temporarily unavailable.',
          type: 'provider_error',
        },
      });
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          failureCode: 'vault-locked',
          outcome: 'failed',
          resolvingPath: 'provider',
          vaultReferenceId: 'vault_locked_gateway',
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('streams OpenAI-compatible chat completion chunks', async () => {
    const seenRequests: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
        );
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletionStream: async (_provider, request) => {
          seenRequests.push(request);

          return stream;
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await expect(res.text()).resolves.toContain('data: [DONE]');
    expect(seenRequests).toEqual([
      expect.objectContaining({
        prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
        stream: true,
      }),
    ]);
  });

  it('normalizes Codex HTTP 200 terminal error events before public SSE projection', async () => {
    const profile: ProviderProfile = {
      defaultModel: 'openai-codex/gpt-5.6-sol',
      displayName: 'OpenAI Codex',
      extensions: { openkit: { subscriptionAccount: { accountSlotId: 'team' } } },
      id: 'openai-codex',
      kind: 'oauth',
      models: ['openai-codex/gpt-5.6-sol'],
    };
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol', reasoning: true }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    vi.spyOn(models, 'checkAuth').mockResolvedValue({ source: 'OAuth', type: 'oauth' });
    faux.setResponses([
      fauxAssistantMessage('Hi', {
        errorMessage: 'rate limit exceeded marker=codex-sse-secret',
        stopReason: 'error',
      }),
    ]);
    const getPairHandle = vi.fn(async () => ({ credentials: {} as never, models }));
    const app = createDirectGatewayApp({
      defaultProviderId: profile.id,
      dispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient(),
      }),
      getPairHandle,
      profiles: [profile],
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai-codex/gpt-5.6-sol',
        input: 'Hello',
        stream: true,
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('response.output_text.delta');
    expect(body).toContain('"code":"gateway_provider_rate_limited"');
    expect(body).toContain('"message":"Provider rate limit exceeded."');
    expect(body).toContain('"stopReason":"error"');
    expect(body).toContain('data: [DONE]');
    expect(body).not.toContain('codex-sse-secret');
    expect(getPairHandle).toHaveBeenCalledWith({
      accountSlotId: 'team',
      subscriptionProviderId: 'openai-codex',
    });
  });

  it('normalizes chat stream read failures into terminal SSE errors', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) {
          pulls += 1;
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
          );

          return;
        }

        if (pulls === 1) {
          pulls += 1;
          controller.error(new Error('upstream failed token=tok_secret'));
        }
      },
    });
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletionStream: async () => stream,
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('data: {"choices":[{"delta":{"content":"Hi"}}]}');
    expect(body).toContain('"code":"gateway_stream_failed"');
    expect(body).toContain('"message":"Provider stream failed."');
    expect(body).toContain('"stopReason":"error"');
    expect(body).toContain('data: [DONE]');
    expect(body).not.toContain('tok_secret');
  });

  it('classifies chat stream provider failures into terminal SSE errors', async () => {
    for (const testCase of [
      {
        message: 'unauthorized invalid api key token=tok_secret',
        code: 'gateway_provider_authentication_failed',
        publicMessage: 'Provider authentication failed.',
      },
      {
        message: 'rate limit exceeded token=tok_secret',
        code: 'gateway_provider_rate_limited',
        publicMessage: 'Provider rate limit exceeded.',
      },
      {
        message: 'context length exceeds maximum token=tok_secret',
        code: 'gateway_context_overflow',
        publicMessage: 'Provider context limit exceeded.',
      },
      {
        message: 'invalid request payload token=tok_secret',
        code: 'gateway_provider_request_invalid',
        publicMessage: 'Provider rejected the request.',
      },
      {
        message: 'provider unavailable timeout token=tok_secret',
        code: 'gateway_provider_unavailable',
        publicMessage: 'Provider is unavailable.',
      },
    ]) {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error(testCase.message));
        },
      });
      const app = createApp({
        ...createOllamaProviderOptions(),
        llmPiAiClient: {
          createChatCompletionStream: async () => stream,
        } as unknown as PiAiGatewayClient,
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'openai/gpt-5.1',
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain(`"code":"${testCase.code}"`);
      expect(body).toContain(`"message":"${testCase.publicMessage}"`);
      expect(body).toContain('"stopReason":"error"');
      expect(body).toContain('data: [DONE]');
      expect(body).not.toContain('tok_secret');
    }
  });

  it('routes non-streaming Responses requests through native OpenAI responses support', async () => {
    const app = createApp({
      ...createOpenAIProviderOptions(),
      llmPiAiClient: {
        createResponses: async (_provider, request) => ({
          id: 'resp_gateway',
          object: 'response',
          status: 'completed',
          model: request.model,
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Responses gateway' }],
            },
          ],
        }),
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1',
        input: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: 'resp_gateway',
      model: 'gpt-5.1',
      output: [{ content: [{ text: 'Responses gateway' }] }],
    });
  });

  it('bridges Responses requests to chat completions for chat-only providers', async () => {
    const seenRequests: Array<{
      readonly messages: readonly unknown[];
      readonly prompt_cache_key?: unknown;
    }> = [];
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          seenRequests.push(request);
          return {
            id: 'chatcmpl_bridge',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Bridged response' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        instructions: 'Be brief.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      object: 'response',
      output: [{ content: [{ text: 'Bridged response' }] }],
    });
    expect(seenRequests[0]?.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(seenRequests[0]?.prompt_cache_key).toMatch(/^openkit:responses:request:/);
  });

  it('returns unsupported feature errors when Responses built-in tools target chat-only providers', async () => {
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {} as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        input: 'Hello',
        tools: [{ type: 'web_search_preview' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'unsupported_gateway_feature',
      },
    });
  });

  it('injects the exact Codex pair Models before direct Responses dispatch', async () => {
    const profile: ProviderProfile = {
      defaultModel: 'openai-codex/gpt-5.6-sol',
      displayName: 'OpenAI Codex',
      extensions: { openkit: { subscriptionAccount: { accountSlotId: 'team' } } },
      id: 'openai-codex',
      kind: 'oauth',
      models: ['openai-codex/gpt-5.6-sol'],
    };
    const models = createModels();
    vi.spyOn(models, 'checkAuth').mockResolvedValue({ source: 'OAuth', type: 'oauth' });
    const getPairHandle = vi.fn(async () => ({ credentials: {} as never, models }));
    const createResponses = vi.fn(
      async (
        _provider: unknown,
        request: { readonly model: string },
        _context?: { readonly models?: unknown }
      ) => {
        return {
          id: 'resp_codex',
          object: 'response' as const,
          status: 'completed' as const,
          model: request.model,
          output: [
            {
              type: 'message' as const,
              role: 'assistant' as const,
              content: [{ type: 'output_text' as const, text: 'Codex response' }],
            },
          ],
        };
      }
    );
    const app = createDirectGatewayApp({
      defaultProviderId: profile.id,
      dispatcher: {
        createResponses,
      } as unknown as LLMGatewayProviderDispatcher,
      getPairHandle,
      profiles: [profile],
    });

    const rejected = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: 'Hello', model: 'openai-codex/not-configured' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'model_not_configured' },
    });
    expect(getPairHandle).not.toHaveBeenCalled();
    expect(models.checkAuth).not.toHaveBeenCalled();
    expect(createResponses).not.toHaveBeenCalled();

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai-codex/gpt-5.6-sol',
        input: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status, await res.clone().text()).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: 'resp_codex',
      output: [{ content: [{ text: 'Codex response' }] }],
    });
    expect(getPairHandle).toHaveBeenCalledWith({
      accountSlotId: 'team',
      subscriptionProviderId: 'openai-codex',
    });
    expect(models.checkAuth).toHaveBeenCalledWith('openai-codex');
    expect(createResponses).toHaveBeenCalledOnce();
    expect(createResponses.mock.calls[0]?.[2]?.models).toBe(models);
  });

  it('injects exact xAI pair Models without changing native Chat capability', async () => {
    const profile: ProviderProfile = {
      defaultModel: 'grok-4.3',
      displayName: 'xAI Subscription',
      extensions: { openkit: { subscriptionAccount: { accountSlotId: 'work' } } },
      id: 'xai-work',
      kind: 'oauth',
      models: ['grok-4.3'],
      vendor: 'xai',
    };
    const models = createModels();
    vi.spyOn(models, 'checkAuth').mockResolvedValue({ source: 'OAuth', type: 'oauth' });
    const getPairHandle = vi.fn(async () => ({ credentials: {} as never, models }));
    const createChatCompletion = vi.fn(
      async (
        _provider: unknown,
        request: { readonly model: string },
        _context?: { readonly models?: unknown }
      ) => {
        return {
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: 'xAI native chat', role: 'assistant' as const },
            },
          ],
          created: 1,
          id: 'chat_xai',
          model: request.model,
          object: 'chat.completion' as const,
        };
      }
    );
    const app = createDirectGatewayApp({
      defaultProviderId: profile.id,
      dispatcher: {
        createChatCompletion,
      } as unknown as LLMGatewayProviderDispatcher,
      getPairHandle,
      profiles: [profile],
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'grok-4.3',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status, await res.clone().text()).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'xAI native chat' } }],
    });
    expect(getPairHandle).toHaveBeenCalledWith({
      accountSlotId: 'work',
      subscriptionProviderId: 'xai',
    });
    expect(models.checkAuth).toHaveBeenCalledWith('xai');
    expect(createChatCompletion).toHaveBeenCalledOnce();
    expect(createChatCompletion.mock.calls[0]?.[2]?.models).toBe(models);
  });

  it('preserves explicit prompt cache keys for native Responses providers', async () => {
    const seenRequests: unknown[] = [];
    const app = createApp({
      ...createOpenAIProviderOptions(),
      llmPiAiClient: {
        createResponses: async (_provider, request) => {
          seenRequests.push(request);
          return {
            id: 'resp_gateway',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1',
        input: 'Hello',
        prompt_cache_key: 'client-key',
        prompt_cache_retention: 'in-memory',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(seenRequests).toEqual([
      expect.objectContaining({
        prompt_cache_key: 'client-key',
        prompt_cache_retention: 'in-memory',
      }),
    ]);
  });

  it('preserves explicit prompt cache keys for native Chat Completions providers', async () => {
    const seenRequests: unknown[] = [];
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          seenRequests.push(request);

          return {
            id: 'chatcmpl_gateway',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai/gpt-5.1',
        messages: [{ role: 'user', content: 'Hello' }],
        prompt_cache_key: 'chat-client-key',
        prompt_cache_retention: 'in-memory',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(seenRequests).toEqual([
      expect.objectContaining({
        prompt_cache_key: 'chat-client-key',
        prompt_cache_retention: 'in-memory',
      }),
    ]);
  });

  it('derives prompt cache keys from OpenKit metadata for Chat Completions requests', async () => {
    const seenRequests: Array<{ prompt_cache_key?: unknown }> = [];
    const app = createApp({
      ...createOllamaProviderOptions(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          seenRequests.push(request);

          return {
            id: 'chatcmpl_gateway',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    for (let index = 0; index < 2; index += 1) {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'openai/gpt-5.1',
          messages: [{ role: 'user', content: 'Hello' }],
          metadata: {
            openkit: {
              sessionId: 'session_demo',
              threadId: 'th_demo',
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
    }

    expect(seenRequests[0]?.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(seenRequests[0]?.prompt_cache_key).toBe(seenRequests[1]?.prompt_cache_key);
  });

  it('derives prompt cache keys from OpenKit metadata for Responses requests', async () => {
    const seenRequests: Array<{ prompt_cache_key?: unknown }> = [];
    const app = createApp({
      ...createOpenAIProviderOptions(),
      llmPiAiClient: {
        createResponses: async (_provider, request) => {
          seenRequests.push(request);
          return {
            id: 'resp_gateway',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    for (let index = 0; index < 2; index += 1) {
      const res = await app.request('/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.1',
          input: 'Hello',
          metadata: {
            openkit: {
              threadId: 'th_demo',
            },
          },
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
    }

    expect(seenRequests[0]?.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(seenRequests[0]?.prompt_cache_key).toBe(seenRequests[1]?.prompt_cache_key);
  });

  it('reports provider cache read and write quantities without a derived hit rate', async () => {
    const app = createApp({
      ...createOpenAIProviderOptions(),
      llmPiAiClient: {
        createResponses: async (_provider, request, onUsage) => {
          const usage = {
            cacheRead: 60,
            cacheWrite: 20,
            input_tokens: 100,
            output_tokens: 25,
            total_tokens: 125,
          };
          onUsage?.(usage);

          return {
            id: 'resp_gateway',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [],
            usage,
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1',
        input: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);

    const diagnostics = await app.request('/api/app/diagnostics');

    expect(diagnostics.status).toBe(200);
    const diagnosticsBody = (await diagnostics.json()) as {
      gateway: { usage: { summaries: unknown[] } };
    };
    expect(diagnosticsBody.gateway.usage.summaries).toEqual([
      {
        cacheReadTokens: 60,
        cacheWriteTokens: 20,
        completionTokens: 25,
        endpoint: 'responses',
        inputTokens: 100,
        lastObservedAt: expect.any(String),
        model: 'gpt-5.1',
        providerId: 'openai',
        requestCount: 1,
        totalTokens: 125,
      },
    ]);
  });

  it('maps unavailable subscription pairs before upstream or SSE startup', async () => {
    const profile: ProviderProfile = {
      defaultModel: 'grok-4.3',
      displayName: 'xAI Subscription',
      extensions: { openkit: { subscriptionAccount: { accountSlotId: 'unavailable' } } },
      id: 'xai-unavailable',
      kind: 'oauth',
      models: ['grok-4.3'],
      vendor: 'xai',
    };
    const getPairHandle = vi.fn(async () => {
      throw new ProviderSubscriptionAccountError(
        'provider_subscription_vault_unavailable',
        'vault detail token=pair-secret'
      );
    });
    const createResponses = vi.fn();
    const createResponsesStream = vi.fn(async () => new Response('data: [DONE]\n\n').body!);
    const app = createDirectGatewayApp({
      defaultProviderId: profile.id,
      dispatcher: {
        createResponses,
        createResponsesStream,
      } as unknown as LLMGatewayProviderDispatcher,
      getPairHandle,
      profiles: [profile],
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'grok-4.3',
        input: 'Hello',
        stream: true,
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status, await res.clone().text()).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'gateway_logical_model_unavailable',
        message: 'Logical model is temporarily unavailable.',
        type: 'provider_error',
      },
    });
    expect(getPairHandle).toHaveBeenCalledWith({
      accountSlotId: 'unavailable',
      subscriptionProviderId: 'xai',
    });
    expect(createResponses).not.toHaveBeenCalled();
    expect(createResponsesStream).not.toHaveBeenCalled();
  });

  it('maps missing subscription credentials before upstream or SSE startup', async () => {
    const profile: ProviderProfile = {
      defaultModel: 'openai-codex/gpt-5.6-sol',
      displayName: 'OpenAI Codex',
      extensions: { openkit: { subscriptionAccount: { accountSlotId: 'logged-out' } } },
      id: 'openai-codex',
      kind: 'oauth',
      models: ['openai-codex/gpt-5.6-sol'],
    };
    const models = createModels();
    vi.spyOn(models, 'checkAuth').mockResolvedValue(undefined);
    const getPairHandle = vi.fn(async () => ({ credentials: {} as never, models }));
    const createChatCompletion = vi.fn();
    const createChatCompletionStream = vi.fn(async () => new Response('data: [DONE]\n\n').body!);
    const app = createDirectGatewayApp({
      defaultProviderId: profile.id,
      dispatcher: {
        createChatCompletion,
        createChatCompletionStream,
      } as unknown as LLMGatewayProviderDispatcher,
      getPairHandle,
      profiles: [profile],
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai-codex/gpt-5.6-sol',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status, await res.clone().text()).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'gateway_logical_model_unavailable',
        message: 'Logical model is temporarily unavailable.',
        type: 'provider_error',
      },
    });
    expect(getPairHandle).toHaveBeenCalledWith({
      accountSlotId: 'logged-out',
      subscriptionProviderId: 'openai-codex',
    });
    expect(models.checkAuth).toHaveBeenCalledWith('openai-codex');
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(createChatCompletionStream).not.toHaveBeenCalled();
  });
});
