import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from './config/providers-loader.js';
import { CodexResponsesClient, type CodexTokenResolver } from './llm/codex-responses-client.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { ProviderRegistry } from './providers/registry.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { listVaultUseRecords } from './vault/vault-use-records.js';

/**
 * Creates runtime app options for one Gateway provider fixture.
 *
 * @param profile Provider profile with an explicit default model.
 * @param credential Credential resolved for the profile secret reference.
 * @returns Runtime provider registry, Gateway defaults, and credential resolver.
 */
function createProviderOptions(
  profile: ProviderProfile & { defaultModel: string },
  credential: string | null = null
) {
  return {
    openKitConfig: {
      defaults: {
        gatewayModel: profile.defaultModel,
        gatewayProviderId: profile.id,
      },
    },
    providerCredentialResolver: () => credential,
    providerRegistry: new ProviderRegistry([profile]),
  };
}

/** Creates the runtime Ollama fixture used by Gateway tests. */
function createOllamaProviderOptions() {
  return createProviderOptions({
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    displayName: 'Ollama',
    id: 'ollama',
    kind: 'local',
    models: ['llama3.2'],
    vendor: 'ollama',
  });
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
      defaultModel: 'faux-chat',
      displayName: 'Anthropic',
      id: 'anthropic',
      kind: 'direct',
      models: ['faux-chat'],
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
  return createProviderOptions(
    {
      defaultModel: 'faux-chat',
      displayName: providerId === 'google' ? 'Gemini' : 'OpenRouter',
      id: providerId,
      kind: providerId === 'openrouter' ? 'gateway' : 'direct',
      models: ['faux-chat'],
      secretRef: providerId === 'google' ? 'env:GOOGLE_GEMINI_API_KEY' : 'env:OPENROUTER_API_KEY',
      vendor: providerId,
    },
    `${providerId}-secret`
  );
}

/** Creates the runtime default-account Codex fixture used by Gateway tests. */
function createCodexProviderOptions() {
  return createProviderOptions({
    baseUrl: 'https://chatgpt.com/backend-api',
    defaultModel: 'openai-codex/gpt-5.1-codex',
    displayName: 'OpenAI Codex',
    extensions: { openkit: { codexOAuth: { accountSlotId: 'default' } } },
    id: 'openai_codex',
    kind: 'oauth',
    models: ['openai-codex/gpt-5.1-codex'],
    vendor: 'openai_codex',
  });
}

function unusedCodexClient(): CodexResponsesClient {
  return new CodexResponsesClient({
    tokenResolver: {
      resolve: async () => ({ accessToken: 'unused', chatgptAccountId: 'unused' }),
    } satisfies CodexTokenResolver,
  });
}

function runtimeProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      defaultModel: 'llama3.2',
      displayName: 'Runtime Ollama',
      id: 'runtime-ollama',
      kind: 'local',
      models: ['llama3.2'],
      vendor: 'ollama',
    },
    {
      defaultModel: 'openai-codex/gpt-5.1-codex',
      displayName: 'Codex Team A',
      extensions: {
        openkit: {
          codexOAuth: {
            accountSlotId: 'team_a',
          },
        },
      },
      id: 'codex-team-a',
      kind: 'oauth',
      models: ['openai-codex/gpt-5.1-codex'],
      vendor: 'openai_codex',
    },
    {
      defaultModel: 'openai-codex/gpt-5.1-codex',
      displayName: 'Codex Team B',
      extensions: {
        openkit: {
          codexOAuth: {
            accountSlotId: 'team_b',
          },
        },
      },
      id: 'codex-team-b',
      kind: 'oauth',
      models: ['openai-codex/gpt-5.1-codex'],
      vendor: 'openai_codex',
    },
  ]);
}

describe('OpenAI-compatible agent gateway', () => {
  it('keeps the public Gateway surface on Chat Completions and Responses only', () => {
    const appSource = readFileSync('./src/app.ts', 'utf8');
    const gatewaySource = readFileSync('./src/llm/gateway-routes.ts', 'utf8');

    expect(appSource).toContain('registerLlmGatewayRoutes({');
    expect(appSource).not.toContain('registerOpenAICompatFacade');
    expect(appSource).not.toContain('/internal/v1/chat/completions');
    expect(appSource).not.toContain("app.get('/v1/models'");
    expect(appSource).not.toContain("app.post('/v1/chat/completions'");
    expect(appSource).not.toContain("app.post('/v1/responses'");
    expect(gatewaySource).toContain("app.get('/v1/models'");
    expect(gatewaySource).toContain("app.post('/v1/chat/completions'");
    expect(gatewaySource).toContain("app.post('/v1/responses'");
    expect(gatewaySource).not.toContain("app.post('/v1/completions'");
  });

  it('does not expose the historical internal Chat Completions facade', async () => {
    const app = createApp();

    const res = await app.request('/internal/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', messages: [] }),
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
        model: 'llama3.2',
        prompt: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(404);
  });

  it('lists models from the runtime provider registry', async () => {
    const app = createApp({
      openKitConfig: {
        defaults: {
          gatewayModel: 'llama3.2',
          gatewayProviderId: 'runtime-ollama',
        },
      },
      providerRegistry: runtimeProviderRegistry(),
    });

    const res = await app.request('/v1/models');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      object: 'list',
      data: [
        { id: 'llama3.2', object: 'model', owned_by: 'runtime-ollama' },
        {
          id: 'openai-codex/gpt-5.1-codex',
          object: 'model',
          owned_by: 'codex-team-a',
        },
        {
          id: 'openai-codex/gpt-5.1-codex',
          object: 'model',
          owned_by: 'codex-team-b',
        },
      ],
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
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: 'chatcmpl_gateway',
      model: 'llama3.2',
      choices: [{ message: { content: 'Gateway response' } }],
    });
    expect(seenRequests).toEqual([
      expect.objectContaining({
        prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
      }),
    ]);
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
        model: 'llama3.2',
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
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        codexResponsesClient: unusedCodexClient(),
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'faux-chat',
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
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'faux-chat' }] });
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
        codexResponsesClient: unusedCodexClient(),
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'faux-chat',
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
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic stream through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        codexResponsesClient: unusedCodexClient(),
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'faux-chat',
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
      models: [{ id: 'faux-chat' }],
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
        codexResponsesClient: unusedCodexClient(),
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'faux-chat',
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
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'faux-chat' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic responses through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        codexResponsesClient: unusedCodexClient(),
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'faux-chat',
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
      const faux = fauxProvider({
        provider: providerId,
        models: [{ id: 'faux-chat' }],
        tokenSize: { min: 1000, max: 1000 },
      });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage(`${providerId} via pi-ai`)]);
      const app = createApp({
        ...createPiAiProviderOptions(providerId),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          codexResponsesClient: unusedCodexClient(),
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'faux-chat',
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

  it('records durable usage for attributed Anthropic Chat Completions through pi-ai', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const store = createDemoStore({ dataRoot });
    const workspace = store.createWorkspace('Gateway usage');
    const piAiClient: Pick<PiAiGatewayClient, 'createChatCompletion'> = {
      createChatCompletion: async (_provider, request, onUsage) => {
        onUsage?.({
          cacheRead: 3,
          cacheWrite: 2,
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

      const app = createApp({
        coreDb,
        dataRoot,
        store,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          codexResponsesClient: unusedCodexClient(),
          piAiClient: piAiClient as PiAiGatewayClient,
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'faux-chat',
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

      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', workspace.id);
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
            quantity: 3,
            source: 'llm-gateway-adapter-reported:cache_read',
            unit: 'tokens',
          },
          {
            quantity: 2,
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
        expect(usageRows.every((row) => (row as { quantity: number }).quantity > 0)).toBe(true);
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
            modelId: 'faux-chat',
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

      const app = createApp({
        coreDb,
        dataRoot,
        store,
        openKitConfig: {
          defaults: {
            gatewayModel: 'llama3.2',
            gatewayProviderId: 'runtime-ollama',
          },
        },
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
          model: 'llama3.2',
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
            providerRef: 'runtime-ollama',
            status: 'succeeded',
            threadId: 'thread_openai',
          }),
        ],
        usageRecords: expect.arrayContaining([
          expect.objectContaining({
            category: 'llm',
            modelId: 'llama3.2',
            providerRef: 'runtime-ollama',
            quantity: 7,
            source: 'llm-gateway-adapter-reported:input',
            unit: 'tokens',
            workspaceId: workspace.id,
          }),
          expect.objectContaining({
            category: 'llm',
            modelId: 'llama3.2',
            providerRef: 'runtime-ollama',
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

  it('records durable usage for attributed Codex Responses calls', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-codex-usage-'));
    const coreDb = openCoreDb(dataRoot);
    const store = createDemoStore({ dataRoot });
    const workspace = store.createWorkspace('Codex usage');

    try {
      applyMigrations(coreDb);

      const app = createApp({
        coreDb,
        dataRoot,
        store,
        ...createCodexProviderOptions(),
        llmCodexResponsesClient: {
          createResponses: async (_provider, request) => ({
            id: 'resp_codex_usage',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Codex usage' }],
              },
            ],
            usage: {
              input_tokens: 11,
              output_tokens: 3,
              total_tokens: 14,
            },
          }),
        } as CodexResponsesClient,
      });

      const res = await app.request('/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'openai-codex/gpt-5.1-codex',
          input: 'Hello',
          metadata: {
            openkit: {
              agentId: 'assistant',
              requestId: '33333333-3333-4333-8333-333333333333',
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
            agentId: 'assistant',
            capabilityId: 'llm.responses',
            operation: 'responses',
            providerRef: 'openai_codex',
            status: 'succeeded',
          }),
        ],
        usageRecords: expect.arrayContaining([
          expect.objectContaining({
            category: 'llm',
            modelId: 'openai-codex/gpt-5.1-codex',
            providerRef: 'openai_codex',
            quantity: 11,
            source: 'llm-gateway-adapter-reported:input',
            unit: 'tokens',
            workspaceId: workspace.id,
          }),
          expect.objectContaining({
            category: 'llm',
            modelId: 'openai-codex/gpt-5.1-codex',
            providerRef: 'openai_codex',
            quantity: 3,
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
      models: [{ id: 'faux-chat' }],
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

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          codexResponsesClient: unusedCodexClient(),
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'faux-chat',
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

      expect(res.status).toBe(502);
      const body = await res.text();

      expect(body).toContain('"code":"gateway_provider_unavailable"');
      expect(body).not.toContain('tok_secret');

      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_chat_failed_usage');
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
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('durable responses usage ok')]);

    try {
      applyMigrations(coreDb);

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          codexResponsesClient: unusedCodexClient(),
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'faux-chat',
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

      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_responses_usage');
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
      models: [{ id: 'faux-chat' }],
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

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          codexResponsesClient: unusedCodexClient(),
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'faux-chat',
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

      expect(res.status).toBe(502);
      const body = await res.text();

      expect(body).toContain('"code":"gateway_provider_unavailable"');
      expect(body).not.toContain('tok_secret');

      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_responses_failed_usage');
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
      models: [{ id: 'faux-chat' }],
      tokenSize: { min: 1000, max: 1000 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Anthropic response stream through pi-ai')]);
    const app = createApp({
      ...createAnthropicProviderOptions(),
      llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
        codexResponsesClient: unusedCodexClient(),
        piAiClient: new PiAiGatewayClient({ models }),
      }),
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'faux-chat',
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
          model: 'faux-chat',
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
          model: 'faux-chat',
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
        models: [{ id: 'faux-chat' }],
        tokenSize: { min: 1000, max: 1000 },
      });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('durable stream usage ok')]);

      try {
        applyMigrations(coreDb);

        const app = createApp({
          coreDb,
          dataRoot,
          ...createAnthropicProviderOptions(),
          llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
            codexResponsesClient: unusedCodexClient(),
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

        const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', testCase.workspaceId);
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
      models: [{ id: 'faux-chat' }],
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

      const app = createApp({
        coreDb,
        dataRoot,
        ...createAnthropicProviderOptions(),
        llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
          codexResponsesClient: unusedCodexClient(),
          piAiClient: new PiAiGatewayClient({ models }),
        }),
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'faux-chat',
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

      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_chat_stream_failed_usage');
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
        models: [{ id: 'faux-chat' }],
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

        const app = createApp({
          coreDb,
          dataRoot,
          ...createAnthropicProviderOptions(),
          llmGatewayDispatcher: new LLMGatewayProviderDispatcher({
            codexResponsesClient: unusedCodexClient(),
            piAiClient: new PiAiGatewayClient({ models }),
          }),
        });

        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: 'faux-chat',
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

        const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', testCase.workspaceId);
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

  it('routes gateway provider credentials through audited vault references', async () => {
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

      const app = createApp({
        coreDb,
        dataRoot,
        openKitConfig: {
          defaults: {
            gatewayModel: 'gpt-test',
            gatewayProviderId: 'vault-backed',
          },
        },
        providerRegistry: new ProviderRegistry([
          {
            defaultModel: 'gpt-test',
            displayName: 'Vault Backed Gateway',
            id: 'vault-backed',
            kind: 'direct',
            models: ['gpt-test'],
            secretRef: 'vault://vault_gateway',
          },
        ]),
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
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-test',
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

  it('fails gateway vault-backed provider calls with a typed locked-vault error', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-llm-gateway-vault-locked-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });

    try {
      applyMigrations(coreDb);
      const app = createApp({
        coreDb,
        dataRoot,
        openKitConfig: {
          defaults: {
            gatewayModel: 'gpt-test',
            gatewayProviderId: 'vault-locked',
          },
        },
        providerRegistry: new ProviderRegistry([
          {
            defaultModel: 'gpt-test',
            displayName: 'Vault Locked Gateway',
            id: 'vault-locked',
            kind: 'direct',
            models: ['gpt-test'],
            secretRef: 'vault://vault_locked_gateway',
          },
        ]),
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
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(423);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: 'vault-locked',
          type: 'provider_credential_error',
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
        model: 'llama3.2',
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
        model: 'llama3.2',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('data: {"choices":[{"delta":{"content":"Hi"}}]}');
    expect(body).toContain('"code":"gateway_stream_failed"');
    expect(body).toContain('"stopReason":"error"');
    expect(body).toContain('data: [DONE]');
    expect(body).not.toContain('tok_secret');
  });

  it('classifies chat stream provider failures into terminal SSE errors', async () => {
    for (const testCase of [
      {
        message: 'unauthorized invalid api key token=tok_secret',
        code: 'gateway_provider_authentication_failed',
      },
      { message: 'rate limit exceeded token=tok_secret', code: 'gateway_provider_rate_limited' },
      {
        message: 'context length exceeds maximum token=tok_secret',
        code: 'gateway_context_overflow',
      },
      {
        message: 'invalid request payload token=tok_secret',
        code: 'gateway_provider_request_invalid',
      },
      {
        message: 'provider unavailable timeout token=tok_secret',
        code: 'gateway_provider_unavailable',
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
          model: 'llama3.2',
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const body = await res.text();

      expect(body).toContain(`"code":"${testCase.code}"`);
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
        model: 'llama3.2',
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
        model: 'llama3.2',
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

  it('routes OpenAI Codex Responses requests through the subscription Responses client', async () => {
    const seenRequests: unknown[] = [];
    const app = createApp({
      ...createCodexProviderOptions(),
      llmCodexResponsesClient: {
        createResponses: async (_provider, request) => {
          seenRequests.push(request);
          return {
            id: 'resp_codex',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Codex response' }],
              },
            ],
          };
        },
      } as CodexResponsesClient,
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai-codex/gpt-5.1-codex',
        input: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: 'resp_codex',
      output: [{ content: [{ text: 'Codex response' }] }],
    });
    expect(seenRequests).toEqual([
      {
        model: 'openai-codex/gpt-5.1-codex',
        input: 'Hello',
        prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
        stream: false,
      },
    ]);
  });

  it('bridges chat completions to OpenAI Codex native Responses', async () => {
    const seenRequests: unknown[] = [];
    const app = createApp({
      ...createCodexProviderOptions(),
      llmCodexResponsesClient: {
        createResponses: async (_provider, request) => {
          seenRequests.push(request);
          return {
            id: 'resp_codex_bridge',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Codex bridged chat' }],
              },
            ],
          };
        },
      } as CodexResponsesClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai-codex/gpt-5.1-codex',
        messages: [
          { role: 'developer', content: 'Use one sentence.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'Codex bridged chat' } }],
    });
    expect(seenRequests).toEqual([
      {
        model: 'openai-codex/gpt-5.1-codex',
        instructions: 'Use one sentence.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
        prompt_cache_key: expect.stringMatching(/^openkit:responses:request:/),
        stream: false,
      },
    ]);
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
        model: 'llama3.2',
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
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'Hello' }],
          metadata: {
            openkit: {
              sessionId: 'session_demo',
              threadId: 'th_demo',
              workspaceId: 'ws_demo',
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
              workspaceId: 'ws_demo',
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

  it('reports Gateway usage and cached token diagnostics', async () => {
    const app = createApp({
      ...createOpenAIProviderOptions(),
      llmPiAiClient: {
        createResponses: async (_provider, request, onUsage) => {
          const usage = {
            input_tokens: 100,
            output_tokens: 25,
            total_tokens: 125,
            input_tokens_details: {
              cached_tokens: 60,
            },
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
    await expect(diagnostics.json()).resolves.toMatchObject({
      gateway: {
        usage: {
          summaries: [
            {
              cachedInputTokens: 60,
              cacheHitRate: 0.6,
              endpoint: 'responses',
              inputTokens: 100,
              model: 'gpt-5.1',
              providerId: 'openai',
              requestCount: 1,
            },
          ],
        },
      },
    });
  });

  it('routes runtime Codex provider instances to their configured account slots', async () => {
    const seenSlots: Array<string | null | undefined> = [];
    const app = createApp({
      openKitConfig: {
        defaults: {
          gatewayModel: 'openai-codex/gpt-5.1-codex',
          gatewayProviderId: 'codex-team-b',
        },
      },
      providerRegistry: runtimeProviderRegistry(),
      llmCodexResponsesClient: {
        createResponses: async (provider, request) => {
          seenSlots.push(provider.codexOAuthAccountSlotId);
          return {
            id: 'resp_codex_team_b',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Team B response' }],
              },
            ],
          };
        },
      } as CodexResponsesClient,
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai-codex/gpt-5.1-codex',
        input: 'Hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 'resp_codex_team_b' });
    expect(seenSlots).toEqual(['team_b']);
  });

  it('bridges runtime chat requests to the Codex account slot selected by the gateway default', async () => {
    const seenSlots: Array<string | null | undefined> = [];
    const app = createApp({
      openKitConfig: {
        defaults: {
          gatewayModel: 'openai-codex/gpt-5.1-codex',
          gatewayProviderId: 'codex-team-a',
        },
      },
      providerRegistry: runtimeProviderRegistry(),
      llmCodexResponsesClient: {
        createResponses: async (provider, request) => {
          seenSlots.push(provider.codexOAuthAccountSlotId);
          return {
            id: 'resp_codex_team_a',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Team A response' }],
              },
            ],
          };
        },
      } as CodexResponsesClient,
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openai-codex/gpt-5.1-codex',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'Team A response' } }],
    });
    expect(seenSlots).toEqual(['team_a']);
  });
});
