import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartChatModeResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import type { CodexResponsesClient } from './llm/codex-responses-client.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { ProviderRegistry } from './providers/registry.js';
import type { TurnExecutor } from './runtime/types.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { listVaultUseRecords } from './vault/vault-use-records.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const EXPECTED_QUICK_CHAT_SYSTEM_PROMPT =
  'You are QuickChatAgent, a lightweight OpenKit Core coordination agent. Answer concise user questions without running worker agents, shell commands, browser automation, file edits, or knowledge writes.';

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
        coreModel: 'llama3.2',
        coreProviderId: 'ollama',
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
    expect(appSource).not.toContain('InternalAgentRunner');
    expect(appSource).not.toContain('getInternalAgentRunner');
    expect(modeEntrySource).not.toContain('InternalAgentRunner');
    expect(modeEntrySource).not.toContain('getInternalAgentRunner');
  });

  it('records a thread-scoped Chat Mode answer without starting a worker turn', async () => {
    const calls: Array<{
      providerId: string;
      request: Parameters<PiAiGatewayClient['createChatCompletion']>[1];
    }> = [];
    const app = createApp({
      ...createQuickChatProviderOptions(),
      store: createDemoStore(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (provider, request) => {
          calls.push({ providerId: provider.id, request });
          return {
            id: 'chatcmpl_chat_answer',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Thread-scoped answer.' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
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
    expect(parsed.turn.triggerActor).toEqual({ kind: 'user', id: 'user_local' });
    expect(parsed.turn.items.find((item) => item.type === 'user-message')).toMatchObject({
      actor: parsed.turn.triggerActor,
    });
    expect(calls[0]).toMatchObject({
      providerId: 'ollama',
      request: {
        messages: [
          { role: 'system', content: EXPECTED_QUICK_CHAT_SYSTEM_PROMPT },
          { role: 'user', content: 'What is OpenKit?' },
        ],
        metadata: {
          openkit: {
            sessionId: 'chat-mode:ws_demo:th_demo',
            workspaceId: 'ws_demo',
          },
        },
      },
    });
    const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'What is OpenKit?', requestId: 'req_chat_answer' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(replayRes.status).toBe(200);
    expect(StartChatModeResponseSchema.parse(await replayRes.json())).toEqual(parsed);
    expect(calls).toHaveLength(1);
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
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
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

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspace.id);
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

  it('answers Chat Mode questions through S61 before calling QuickChatAgent', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-mode-knowledge-'));
    const app = createApp({
      ...createQuickChatProviderOptions(),
      dataRoot,
      store: createDemoStore({ dataRoot }),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new Error('Knowledge-backed Chat Mode must not call QuickChatAgent');
        },
      } as unknown as PiAiGatewayClient,
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
    const knowledge = (await createRes.json()) as { id: string };

    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({
        input: 'Launch cadence',
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
    const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({
        input: 'Launch cadence',
        requestId: 'req_chat_knowledge_answer',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(replayRes.status).toBe(200);
    expect(StartChatModeResponseSchema.parse(await replayRes.json())).toEqual(parsed);
    const pageBytes = readFileSync(
      join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'pages', `${knowledge.id}.md`)
    );
    const contentDigest = `sha256:${createHash('sha256').update(pageBytes).digest('hex')}`;
    const traceRoot = join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'traces');
    const traces = existsSync(traceRoot)
      ? readdirSync(traceRoot).flatMap((fileName) =>
          readFileSync(join(traceRoot, fileName), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        )
      : [];

    expect(traces).toEqual([
      expect.objectContaining({
        caller: 'assistant',
        selected: [
          expect.objectContaining({
            knowledgePageId: knowledge.id,
            contentDigest,
          }),
        ],
      }),
    ]);
  });

  it('asks a bounded clarification question for vague Chat Mode requests', async () => {
    const store = createDemoStore();
    const app = createApp({
      ...createQuickChatProviderOptions(),
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new Error('Clarification-needed Chat Mode must not call QuickChatAgent');
        },
      } as unknown as PiAiGatewayClient,
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
        status: 'completed',
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
    expect(
      store.getCommandRequest('chat.start', 'req_chat_clarify', {
        actorId: 'user_local',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      })?.response.chatMetadata
    ).toEqual({
      downstream: null,
      resultKind: 'clarification',
      status: 202,
    });

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

    const completedAt = new Date().toISOString();
    store.updateTurn(parsed.turn.id, { status: 'completed', humanGate: null, completedAt });

    const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Help', requestId: 'req_chat_clarify' }),
      headers: { 'content-type': 'application/json' },
    });
    const replay = StartChatModeResponseSchema.parse(await replayRes.json());

    expect(replayRes.status).toBe(202);
    expect(replay.turn).toEqual(parsed.turn);
    expect(replay.item).toEqual(parsed.item);

    const storedRequest = store
      .listThreadItems('ws_demo', 'th_demo')
      .find((item) => item.id === parsed.item.id);
    if (storedRequest?.type !== 'user-input-request') {
      throw new Error('Expected the stored Chat clarification request.');
    }
    storedRequest.responsibleUserId = 'user_other';
    const contradictedReplay = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/chat',
      {
        method: 'POST',
        body: JSON.stringify({ input: 'Help', requestId: 'req_chat_clarify' }),
        headers: { 'content-type': 'application/json' },
      }
    );
    expect(contradictedReplay.status).toBe(409);
    await expect(contradictedReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
  });

  it('fails Chat Mode replay closed when durable owners contradict', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new ThrowingTurnExecutor() });
    const requestId = 'req_chat_missing_owner';
    const input = 'Search the web for current OpenKit news.';
    const scope = { actorId: 'user_local', threadId: 'th_demo', workspaceId: 'ws_demo' };
    const first = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({ input, requestId }),
      headers: { 'content-type': 'application/json' },
    });

    expect(first.status).toBe(200);
    const accepted = StartChatModeResponseSchema.parse(await first.json());
    const successfulReplay = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({ input, requestId }),
      headers: { 'content-type': 'application/json' },
    });

    expect(successfulReplay.status).toBe(200);
    expect(StartChatModeResponseSchema.parse(await successfulReplay.json())).toEqual(accepted);
    const userItem = store
      .listThreadItems('ws_demo', 'th_demo')
      .find((item) => item.id === `it_chat_user_${accepted.turn.id}`);
    if (userItem?.type !== 'user-message') {
      throw new Error('Expected the stored Chat user message.');
    }
    userItem.actor = { kind: 'user', id: 'user_other' };
    const contradictedActorReplay = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/chat',
      {
        method: 'POST',
        body: JSON.stringify({ input, requestId }),
        headers: { 'content-type': 'application/json' },
      }
    );
    expect(contradictedActorReplay.status).toBe(409);
    await expect(contradictedActorReplay.json()).resolves.toMatchObject({
      code: 'recovery_required',
    });
    userItem.actor = accepted.turn.triggerActor;
    store.updateTurn(accepted.turn.id, { status: 'failed' });
    const contradictedTurnReplay = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/chat',
      {
        method: 'POST',
        body: JSON.stringify({ input, requestId }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(contradictedTurnReplay.status).toBe(409);
    await expect(contradictedTurnReplay.json()).resolves.toMatchObject({
      code: 'recovery_required',
    });
    store.updateTurn(accepted.turn.id, { status: 'completed' });
    const receipt = store.getCommandRequest('chat.start', requestId, scope);
    expect(receipt).not.toBeNull();
    store.recordCommandRequest({
      command: 'chat.start',
      inputHash: receipt!.inputHash,
      requestId,
      response: { id: 'tu_missing_chat_owner', kind: 'turn' },
      scope,
    });

    const replay = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
      method: 'POST',
      body: JSON.stringify({ input, requestId }),
      headers: { 'content-type': 'application/json' },
    });

    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
  });

  it('records Chat Mode goal handoffs without starting worker turns', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-goal-handoff-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    try {
      const store = createDemoStore({ dataRoot });
      const app = createApp({
        agentManifests: [createTestAgentSetup({ provider: null }).manifest],
        coreDb,
        dataRoot,
        store,
        turnExecutor: new ThrowingTurnExecutor(),
      });
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: 'ws_demo',
      });
      const request = {
        input: 'Plan a multi-step release goal for NanoCore.',
        requestId: 'req_chat_goal',
      };

      const goalRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
      });

      expect(goalRes.status).toBe(202);
      const accepted = StartChatModeResponseSchema.parse(await goalRes.json());
      expect(accepted).toMatchObject({
        outcome: 'goal-handoff',
        handoff: { targetMode: 'goal' },
        item: { type: 'status', title: 'Goal Mode handoff' },
      });
      const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
      });

      expect(replayRes.status).toBe(202);
      expect(StartChatModeResponseSchema.parse(await replayRes.json())).toEqual(accepted);
      expect(store.listCommandRequests().map((record) => record.command)).toEqual(['chat.start']);

      const goalTurn = store
        .listThreadTurns('ws_demo', 'th_demo')
        .find((turn) => turn.id !== accepted.turn.id);
      const creationItem = goalTurn?.items.find((item) => item.type === 'user-message');

      if (!creationItem) {
        throw new Error('Expected the Goal creation Item.');
      }

      store.updateItem(creationItem.id, { status: 'in_progress', completedAt: null });
      const contradictedReplayRes = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/chat',
        {
          method: 'POST',
          body: JSON.stringify(request),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(contradictedReplayRes.status).toBe(409);
      await expect(contradictedReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('routes Quick Chat through one direct provider call', async () => {
    const calls: Array<{
      providerId: string;
      request: Parameters<PiAiGatewayClient['createChatCompletion']>[1];
    }> = [];

    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (provider, request) => {
          calls.push({ providerId: provider.id, request });
          return {
            id: 'chatcmpl_route_agent',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Agent-routed answer' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Route this.' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: 'chatcmpl_route_agent',
      status: 'completed',
      workspaceId: 'ws_quick_chat',
      providerId: 'ollama',
      model: 'llama3.2',
      content: 'Agent-routed answer',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      providerId: 'ollama',
      request: {
        model: 'llama3.2',
        messages: [
          { role: 'system', content: EXPECTED_QUICK_CHAT_SYSTEM_PROMPT },
          { role: 'user', content: 'Route this.' },
        ],
        metadata: {
          openkit: {
            sessionId: 'quick-chat:ws_quick_chat',
            workspaceId: 'ws_quick_chat',
          },
        },
      },
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['a schema-invalid body', JSON.stringify({ input: '' })],
    [
      'caller-supplied Workspace authority',
      JSON.stringify({ input: 'Hello', workspaceId: 'ws_caller_selected' }),
    ],
  ])('rejects %s before provider dispatch', async (_label, body) => {
    const createChatCompletion = vi.fn();
    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: { createChatCompletion } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'invalid_request' });
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it('rejects missing assistant content at the direct provider boundary', async () => {
    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => ({
          id: 'chatcmpl_invalid_quick_chat',
          object: 'chat.completion',
          created: 1,
          model: request.model,
          choices: [],
        }),
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Return no choice.' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('maps the bounded role timeout without exposing the platform abort reason', async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeoutController.signal);
    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          queueMicrotask(() => {
            timeoutController.abort(new DOMException('secret timeout', 'TimeoutError'));
          });
          return new Promise<never>(() => undefined);
        },
      } as unknown as PiAiGatewayClient,
    });

    try {
      const res = await app.request('/api/app/quick-chat', {
        method: 'POST',
        body: JSON.stringify({ input: 'Time out.' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(504);
      await expect(res.json()).resolves.toMatchObject({
        code: 'provider_call_timeout',
        message: 'Quick chat provider call timed out.',
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it('maps caller cancellation at the direct provider boundary', async () => {
    const abortController = new AbortController();
    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, _request, _onUsage, transport) => {
          abortController.abort(new DOMException('private caller reason', 'AbortError'));
          transport.signal?.throwIfAborted();
          throw new Error('unreachable');
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Cancel this.' }),
      headers: { 'content-type': 'application/json' },
      signal: abortController.signal,
    });

    expect(res.status).toBe(499);
    await expect(res.json()).resolves.toMatchObject({
      code: 'provider_call_aborted',
      message: 'Quick chat provider call was aborted.',
    });
  });

  it('redacts unexpected direct provider failures', async () => {
    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new Error('provider failed token=tok_private_quick_chat');
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Fail safely.' }),
      headers: { 'content-type': 'application/json' },
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      code: 'quick_chat_failed',
      message: 'Quick chat failed.',
    });
    expect(JSON.stringify(body)).not.toContain('tok_private_quick_chat');
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
            coreModel: 'quick-vault-model',
            coreProviderId: 'quick-vault',
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
        body: JSON.stringify({ input: 'Use the vault provider.' }),
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
        body: JSON.stringify({ input: 'Track usage.' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_quick_chat');
      try {
        applyScopedMigrations(workspaceDb);
        const call = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE family = ? AND operation = ?')
          .get('llm', 'quick_chat') as Record<string, unknown> | undefined;
        expect(call).toMatchObject({
          agent_id: 'quick-chat',
          capability_id: 'inference.local.quick_chat',
          family: 'llm',
          operation: 'quick_chat',
          provider_ref: 'ollama',
          status: 'succeeded',
          workspace_id: 'ws_quick_chat',
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
          workspace_id: 'ws_quick_chat',
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
          coreModel: 'openai-codex/gpt-5.1-codex',
          coreProviderId: 'openai_codex',
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
      body: JSON.stringify({ input: 'Ping' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(seenRequests[0]?.metadata).toEqual({
      openkit: {
        sessionId: 'quick-chat:ws_quick_chat',
        workspaceId: 'ws_quick_chat',
      },
    });
    expect(seenRequests[0]?.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
  });
});
