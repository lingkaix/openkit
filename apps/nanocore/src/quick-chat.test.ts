import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartChatModeResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { QUICK_CHAT_AGENT_ID } from './internal-agents/registry.js';
import { InternalAgentRunner } from './internal-agents/runner.js';
import type { InternalAgentStreamEvent } from './internal-agents/types.js';
import type { CodexResponsesClient } from './llm/codex-responses-client.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { resolveProviderProfileToLLMConfig } from './providers/llm-config.js';
import { ProviderRegistry } from './providers/registry.js';
import type { TurnExecutor } from './runtime/types.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { listVaultUseRecords } from './vault/vault-use-records.js';

class ThrowingTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    interrupts: true,
    artifacts: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
    questions: false,
  };
  public readonly eventFamilies = [] as const;

  /**
   * Fails if quick chat accidentally allocates an agent turn.
   */
  public async startTurn(): Promise<void> {
    throw new Error('Quick chat must not start an agent turn');
  }

  /**
   * Fails if quick chat tries to interrupt an agent turn.
   */
  public async interruptTurn(): Promise<void> {
    throw new Error('Quick chat must not interrupt an agent turn');
  }
}

/**
 * Creates runtime provider options with one quick-chat default.
 *
 * @returns Runtime provider options for quick-chat tests.
 */
function createQuickChatProviderOptions() {
  return {
    openKitConfig: {
      defaults: {
        gatewayModel: 'llama3.2',
        gatewayProviderId: 'ollama',
      },
    },
    providerRegistry: new ProviderRegistry([
      {
        defaultModel: 'llama3.2',
        displayName: 'Ollama',
        id: 'ollama',
        kind: 'local' as const,
        models: ['llama3.2'],
      },
    ]),
  };
}

/**
 * Collects all events from an async iterable.
 *
 * @param iterable Async iterable to drain.
 * @returns Events yielded by the iterable in order.
 */
async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterable) {
    items.push(item);
  }

  return items;
}

describe('quick chat app API', () => {
  it('keeps Quick Chat, Chat Mode, and Task Mode route ownership outside app composition', () => {
    const appSource = readFileSync('./src/app.ts', 'utf8');
    const modeEntrySource = readFileSync('./src/mode-entry-routes.ts', 'utf8');

    expect(appSource).toContain('registerQuickAndChatModeRoutes({');
    expect(appSource).toContain('registerTaskModeRoute({');
    expect(appSource).not.toContain("registerAppApiRoute(app, 'quickChat'");
    expect(appSource).not.toContain("registerAppApiRoute(app, 'startChatMode'");
    expect(appSource).not.toContain("registerAppApiRoute(app, 'startTaskMode'");
    expect(modeEntrySource).toContain("registerAppApiRoute(app, 'quickChat'");
    expect(modeEntrySource).toContain("registerAppApiRoute(app, 'startChatMode'");
    expect(modeEntrySource).toContain("registerAppApiRoute(app, 'startTaskMode'");
  });

  it('records a thread-scoped Chat Mode answer without starting a worker turn', async () => {
    const calls: Parameters<InternalAgentRunner['run']>[0][] = [];
    const app = createApp({
      ...createQuickChatProviderOptions(),
      store: createDemoStore(),
      turnExecutor: new ThrowingTurnExecutor(),
      internalAgentRunner: {
        run: async (input) => {
          calls.push(input);

          return {
            id: 'chatcmpl_chat_answer',
            agentId: QUICK_CHAT_AGENT_ID,
            status: 'completed',
            providerId: 'ollama',
            model: 'llama3.2',
            output: { content: 'Thread-scoped answer.' },
            durationMs: 1,
          };
        },
      },
    });

    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'What is OpenKit?', requestId: 'req_chat_answer' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const parsed = StartChatModeResponseSchema.parse(await res.json());

    expect(parsed).toMatchObject({
      outcome: 'answered',
      explanation: 'The Assistant answered directly.',
      handoff: null,
      item: {
        type: 'assistant-message',
        text: 'Thread-scoped answer.',
        status: 'completed',
      },
    });
    expect(parsed.turn.status).toBe('completed');
    expect(calls[0]).toMatchObject({
      agentId: QUICK_CHAT_AGENT_ID,
      messages: [{ role: 'user', content: 'What is OpenKit?' }],
      metadata: {
        openkit: {
          sessionId: 'chat-mode:ws_demo:th_demo',
          workspaceId: 'ws_demo',
        },
      },
    });
  });

  it('records Chat Mode provider fallback usage with request, thread, and turn lineage', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-mode-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    try {
      const store = createDemoStore({ dataRoot });
      const workspace = store.createWorkspace('Chat usage lineage');
      const thread = store.createThread(workspace.id, 'Chat usage lineage');
      const requestId = '11111111-1111-4111-8111-111111111111';
      const app = createApp({
        ...createQuickChatProviderOptions(),
        coreDb,
        store,
        turnExecutor: new ThrowingTurnExecutor(),
        llmPiAiClient: {
          createChatCompletion: async (_provider, request) => ({
            id: 'chatcmpl_chat_mode_usage',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Lineaged answer.' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 4,
              total_tokens: 7,
            },
          }),
        } as unknown as PiAiGatewayClient,
      });

      const res = await app.request(
        `/api/app/workspaces/${workspace.id}/threads/${thread.id}/chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            input: 'Answer through the provider.',
            requestId,
          }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(res.status).toBe(200);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', workspace.id);
      try {
        applyScopedMigrations(workspaceDb);
        const call = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE family = ? AND operation = ?')
          .get('llm', 'quick_chat') as Record<string, unknown> | undefined;

        expect(call).toMatchObject({
          capability_id: 'inference.local.quick_chat',
          family: 'llm',
          operation: 'quick_chat',
          request_id: requestId,
          status: 'succeeded',
          thread_id: thread.id,
          turn_id: parsed.turn.id,
          workspace_id: workspace.id,
        });

        const usage = workspaceDb.sqlite
          .prepare('SELECT * FROM usage_records WHERE capability_call_id = ?')
          .get(call?.call_id) as Record<string, unknown> | undefined;

        expect(usage).toMatchObject({
          category: 'llm',
          quantity: 7,
          unit: 'tokens',
          workspace_id: workspace.id,
        });
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('answers Chat Mode questions from Knowledge Manager before calling QuickChatAgent', async () => {
    const app = createApp({
      store: createDemoStore(),
      turnExecutor: new ThrowingTurnExecutor(),
      internalAgentRunner: {
        run: async () => {
          throw new Error('Knowledge-backed Chat Mode must not call QuickChatAgent');
        },
      },
    });

    const createRes = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-00000000c001',
        kind: 'project-context',
        title: 'Launch cadence',
        content: 'OpenKit ships release candidates only after NanoCore smoke passes on a1.',
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(createRes.status).toBe(201);

    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({
        input: 'What is the Launch cadence?',
        requestId: 'req_chat_knowledge_answer',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const parsed = StartChatModeResponseSchema.parse(await res.json());

    expect(parsed).toMatchObject({
      outcome: 'answered',
      explanation: 'The Assistant answered from workspace knowledge.',
      handoff: null,
      item: {
        type: 'assistant-message',
        status: 'completed',
      },
    });
    expect(parsed.item.text).toContain(
      'OpenKit ships release candidates only after NanoCore smoke passes on a1.'
    );
    expect(parsed.item.text).toContain('Sources: Launch cadence');
  });

  it('asks a bounded clarification question for vague Chat Mode requests', async () => {
    const store = createDemoStore();
    const app = createApp({
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      internalAgentRunner: {
        run: async () => {
          throw new Error('Clarification-needed Chat Mode must not call QuickChatAgent');
        },
      },
    });

    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Help', requestId: 'req_chat_clarify' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(202);
    const parsed = StartChatModeResponseSchema.parse(await res.json());

    expect(parsed).toMatchObject({
      outcome: 'clarification-needed',
      explanation: 'The Assistant needs a concrete request before choosing a mode.',
      handoff: null,
      item: {
        type: 'user-input-request',
        status: 'in_progress',
        prompt: 'Chat Mode needs a more specific request.',
      },
    });
    expect(parsed.turn.status).toBe('awaiting_human');
    expect(parsed.turn.humanGate).toMatchObject({
      kind: 'user-input',
      itemId: parsed.item.id,
    });
    expect(store.listThreadItems('ws_demo', 'th_demo').map((item) => item.type)).toEqual([
      'user-message',
      'user-input-request',
    ]);

    const actionCenterRes = await app.request('/api/app/workspaces/ws_demo/action-center');
    const actionCenter = (await actionCenterRes.json()) as { items: Array<{ source: unknown }> };

    expect(actionCenter.items).toEqual([
      expect.objectContaining({
        kind: 'question',
        source: expect.objectContaining({
          type: 'protocol_item',
          itemType: 'user-input-request',
          itemId: parsed.item.id,
        }),
      }),
    ]);
  });

  it('records Chat Mode goal handoffs without starting worker turns', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-goal-handoff-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    try {
      const app = createApp({
        coreDb,
        dataRoot,
        store: createDemoStore({ dataRoot }),
        turnExecutor: new ThrowingTurnExecutor(),
      });

      const goalRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          input: 'Plan a multi-step release goal for NanoCore.',
          requestId: 'req_chat_goal',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(goalRes.status).toBe(202);
      expect(StartChatModeResponseSchema.parse(await goalRes.json())).toMatchObject({
        outcome: 'goal-handoff',
        handoff: { targetMode: 'goal' },
        item: { type: 'status', title: 'Goal Mode handoff' },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('routes requests through QuickChatAgent while preserving the app response shape', async () => {
    const calls: Parameters<InternalAgentRunner['run']>[0][] = [];

    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      internalAgentRunner: {
        run: async (input) => {
          calls.push(input);

          return {
            id: 'chatcmpl_route_agent',
            agentId: QUICK_CHAT_AGENT_ID,
            status: 'completed',
            providerId: 'ollama',
            model: 'llama3.2',
            output: { content: 'Agent-routed answer' },
            durationMs: 1,
          };
        },
      },
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Route this.', workspaceId: 'ws_quick' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: 'chatcmpl_route_agent',
      status: 'completed',
      workspaceId: 'ws_quick',
      providerId: 'ollama',
      model: 'llama3.2',
      content: 'Agent-routed answer',
    });
    expect(calls).toEqual([
      {
        agentId: QUICK_CHAT_AGENT_ID,
        providerId: 'ollama',
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Route this.' }],
        metadata: {
          openkit: {
            sessionId: 'quick-chat:ws_quick',
            workspaceId: 'ws_quick',
          },
        },
        dispatchContext: {
          promptCacheScope: {
            sessionId: 'quick-chat:ws_quick',
            workspaceId: 'ws_quick',
          },
          usageEndpoint: 'quick_chat',
        },
      },
    ]);
  });

  it('answers with the configured quick-chat provider without starting an agent session', async () => {
    const seenRequests: Array<{ metadata?: unknown; prompt_cache_key?: unknown }> = [];
    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          seenRequests.push(request);

          return {
            id: 'chatcmpl_quick',
            object: 'chat.completion',
            created: 1,
            model: 'llama3.2',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'It is sunny.' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'How is the weather?' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'completed',
      providerId: 'ollama',
      model: 'llama3.2',
      content: 'It is sunny.',
    });
    expect(seenRequests[0]?.metadata).toEqual({
      openkit: {
        sessionId: 'quick-chat:ws_quick_chat',
        workspaceId: 'ws_quick_chat',
      },
    });
    expect(seenRequests[0]?.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
  });

  it('routes quick-chat provider credentials through audited vault references', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-quick-chat-vault-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const seenProviders: Array<{ apiKey: string | null; id: string }> = [];

    try {
      applyMigrations(coreDb);
      vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 6) });
      vaultUnlockState.backend().store({
        material: 'sk-vault-quick-chat',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_quick_chat',
      });

      const app = createApp({
        coreDb,
        dataRoot,
        openKitConfig: {
          defaults: {
            gatewayModel: 'quick-vault-model',
            gatewayProviderId: 'quick-vault',
          },
        },
        providerRegistry: new ProviderRegistry([
          {
            baseUrl: 'https://api.example.com/v1',
            defaultModel: 'quick-vault-model',
            displayName: 'Quick Vault',
            id: 'quick-vault',
            kind: 'direct',
            models: ['quick-vault-model'],
            secretRef: 'vault://vault_quick_chat',
          },
        ]),
        turnExecutor: new ThrowingTurnExecutor(),
        llmPiAiClient: {
          createChatCompletion: async (provider, request) => {
            seenProviders.push({
              apiKey: provider.apiKey,
              id: provider.id,
            });

            return {
              id: 'chatcmpl_quick_vault',
              object: 'chat.completion',
              created: 1,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Vault quick answer.' },
                  finish_reason: 'stop',
                },
              ],
            };
          },
        } as unknown as PiAiGatewayClient,
        vaultUnlockState,
      });

      const res = await app.request('/api/app/quick-chat', {
        method: 'POST',
        body: JSON.stringify({ input: 'Use the vault provider.', workspaceId: 'ws_quick_vault' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        status: 'completed',
        providerId: 'quick-vault',
        model: 'quick-vault-model',
        content: 'Vault quick answer.',
      });
      expect(seenProviders).toEqual([
        {
          apiKey: 'sk-vault-quick-chat',
          id: 'quick-vault',
        },
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          resolvingPath: 'provider',
          vaultReferenceId: 'vault_quick_chat',
        }),
      ]);
      expect(JSON.stringify(listVaultUseRecords(coreDb))).not.toContain('sk-vault-quick-chat');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records durable LLM usage for QuickChatAgent when storage is available', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-quick-chat-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    try {
      const app = createApp({
        ...createQuickChatProviderOptions(),
        coreDb,
        turnExecutor: new ThrowingTurnExecutor(),
        llmPiAiClient: {
          createChatCompletion: async (_provider, request) => ({
            id: 'chatcmpl_quick_usage',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Accounted answer.' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 5,
              total_tokens: 12,
            },
          }),
        } as unknown as PiAiGatewayClient,
      });

      const res = await app.request('/api/app/quick-chat', {
        method: 'POST',
        body: JSON.stringify({ input: 'Track usage.', workspaceId: 'ws_usage' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', 'ws_usage');
      try {
        applyScopedMigrations(workspaceDb);
        const call = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE family = ? AND operation = ?')
          .get('llm', 'quick_chat') as Record<string, unknown> | undefined;
        expect(call).toMatchObject({
          agent_id: QUICK_CHAT_AGENT_ID,
          capability_id: 'inference.local.quick_chat',
          family: 'llm',
          operation: 'quick_chat',
          provider_ref: 'ollama',
          status: 'succeeded',
          workspace_id: 'ws_usage',
        });

        const usage = workspaceDb.sqlite
          .prepare('SELECT * FROM usage_records WHERE capability_call_id = ?')
          .get(call?.call_id) as Record<string, unknown> | undefined;
        expect(usage).toMatchObject({
          category: 'llm',
          model_id: 'llama3.2',
          provider_ref: 'ollama',
          quantity: 12,
          unit: 'tokens',
          workspace_id: 'ws_usage',
        });
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a config error when no quick-chat provider is selected', async () => {
    const app = createApp({
      turnExecutor: new ThrowingTurnExecutor(),
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'How many active threads?' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'quick_chat_not_configured',
    });
  });

  it('adds stable OpenKit prompt cache metadata for Codex-backed quick chat', async () => {
    const seenRequests: Array<{ metadata?: unknown; prompt_cache_key?: unknown }> = [];
    const app = createApp({
      openKitConfig: {
        defaults: {
          gatewayModel: 'openai-codex/gpt-5.1-codex',
          gatewayProviderId: 'openai_codex',
        },
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai-codex/gpt-5.1-codex',
          displayName: 'OpenAI Codex',
          extensions: {
            openkit: {
              codexOAuth: {
                accountSlotId: 'default',
              },
            },
          },
          id: 'openai_codex',
          kind: 'oauth',
          models: ['openai-codex/gpt-5.1-codex'],
          vendor: 'openai_codex',
        },
      ]),
      turnExecutor: new ThrowingTurnExecutor(),
      llmCodexResponsesClient: {
        createResponses: async (_provider, request) => {
          seenRequests.push(request);
          return {
            id: 'resp_quick',
            object: 'response',
            status: 'completed',
            model: request.model,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Quick response' }],
              },
            ],
          };
        },
      } as CodexResponsesClient,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Ping', workspaceId: 'ws_quick' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(seenRequests[0]?.metadata).toEqual({
      openkit: {
        sessionId: 'quick-chat:ws_quick',
        workspaceId: 'ws_quick',
      },
    });
    expect(seenRequests[0]?.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
  });

  it('streams QuickChatAgent message_update events through the internal event path', async () => {
    const { openKitConfig, providerRegistry } = createQuickChatProviderOptions();
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: () => ({
        providerId: openKitConfig.defaults.gatewayProviderId,
        model: openKitConfig.defaults.gatewayModel,
      }),
      llmClient: {
        createChatCompletion: async (_provider, request) => ({
          id: 'chatcmpl_quick_stream',
          object: 'chat.completion',
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Streamed quick chat.' },
              finish_reason: 'stop',
            },
          ],
        }),
      },
      providerResolver: (providerId) =>
        resolveProviderProfileToLLMConfig(providerRegistry.get(providerId)!),
    });

    const events = await collectAsync(
      runner.stream({
        agentId: QUICK_CHAT_AGENT_ID,
        messages: [{ role: 'user', content: 'Stream this.' }],
      })
    );
    const messageUpdates = events.filter(
      (event): event is Extract<InternalAgentStreamEvent, { eventType: 'message_update' }> =>
        event.eventType === 'message_update'
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(messageUpdates.map((event) => event.delta)).toEqual(['Streamed quick chat.']);
  });

  it('emits terminal stop reasons for QuickChatAgent stream errors after stream start', async () => {
    const { openKitConfig, providerRegistry } = createQuickChatProviderOptions();
    const runner = new InternalAgentRunner({
      defaultSelectionResolver: () => ({
        providerId: openKitConfig.defaults.gatewayProviderId,
        model: openKitConfig.defaults.gatewayModel,
      }),
      llmClient: {
        createChatCompletion: async () => {
          throw new Error('provider failed token=tok_secret');
        },
      },
      providerResolver: (providerId) =>
        resolveProviderProfileToLLMConfig(providerRegistry.get(providerId)!),
    });

    const events = await collectAsync(
      runner.stream({
        agentId: QUICK_CHAT_AGENT_ID,
        messages: [{ role: 'user', content: 'Stream error.' }],
      })
    );

    expect(events.map((event) => event.eventType)).toEqual([
      'agent_start',
      'turn_start',
      'turn_end',
      'agent_end',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(events.at(-1)).toMatchObject({
      eventType: 'agent_end',
      status: 'error',
      stopReason: 'error',
      errorMessage: 'provider failed token=[redacted]',
    });
    expect(JSON.stringify(events)).not.toContain('tok_secret');
  });
});
