import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import {
  ConversationTargetCatalogSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { GatewayAttemptFailure } from './llm/gateway-execution.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import type { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { ProviderRegistry } from './providers/registry.js';
import type { TurnExecutor } from './runtime/types.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { readWorkObservations } from './storage/work-observations.js';
import { artifactReferenceItemId } from './storage/workspace-file-records.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { listVaultUseRecords } from './vault/vault-use-records.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const EXPECTED_QUICK_CHAT_SYSTEM_PROMPT =
  'You are QuickChatAgent, a lightweight OpenKit Core coordination agent. Answer concise user questions without running worker agents, shell commands, browser automation, file edits, or knowledge writes. Use only the supplied request and admitted context, state uncertainty rather than inventing facts, and end this bounded response with an answer or a clear need for user input.';

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
    gatewayConfig: {
      schemaVersion: 1 as const,
      enabled: true,
      defaultLogicalModelId: 'quick-chat',
      logicalModels: [
        {
          id: 'quick-chat',
          displayName: 'Quick Chat',
          contextManagement: [{ type: 'compaction' as const, compactThreshold: 8_000 }],
          routes: [
            {
              id: 'primary',
              providerProfileId: 'ollama',
              providerModel: 'openai/gpt-5.2',
            },
          ],
        },
      ],
      requiredFeatures: [],
    },
    internalRoleProfiles: {
      schemaVersion: 1 as const,
      defaultLogicalModelId: 'quick-chat',
      profiles: [],
    },
    providerRegistry: new ProviderRegistry([
      {
        defaultModel: 'openai/gpt-5.2',
        displayName: 'Ollama',
        id: 'ollama',
        kind: 'local' as const,
        models: ['openai/gpt-5.2'],
      },
    ]),
  };
}

/** Builds one explicit Assistant-targeted conversation submission. */
function conversationRequest(input: string, requestId: string) {
  return { input, requestId, targetRef: 'internal-role:assistant', artifactRefs: [] };
}

describe('quick chat app API', () => {
  it.each([
    'resolve',
    'reject',
  ] as const)('interrupts internal Chat without a worker and ignores a late provider %s', async (lateOutcome) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-interrupt-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const store = createDemoStore({ dataRoot });
    const admitted = Promise.withResolvers<AbortSignal>();
    const provider = Promise.withResolvers<unknown>();
    const executor = new ThrowingTurnExecutor();
    executor.capabilities.interrupts = false;
    const interruptWorker = vi.spyOn(executor, 'interruptTurn');
    const answer = {
      id: 'chatcmpl_cancel_test',
      object: 'chat.completion',
      created: 1,
      model: 'openai/gpt-5.2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'A fresh answer.' },
          finish_reason: 'stop',
        },
      ],
    };
    let calls = 0;
    const appOptions = {
      ...createQuickChatProviderOptions(),
      store,
      turnExecutor: executor,
      llmPiAiClient: {
        createChatCompletion: async (_provider, _request, _onUsage, transport) => {
          calls += 1;
          if (calls > 1) return answer;
          admitted.resolve(transport.signal!);
          return provider.promise;
        },
      } as unknown as PiAiGatewayClient,
    };
    const app = createApp(appOptions);
    const submit = (requestId: string) =>
      app.request('/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationRequest('Explain a short concept.', requestId)),
      });
    const pending = submit('req_chat_cancel');
    const signal = await admitted.promise;
    const turn = store.listThreadTurns('ws_demo', 'th_demo')[0]!;
    expect(turn.status).toBe('running');
    const interrupt = (threadId = 'th_demo') =>
      app.request(`/api/workspaces/ws_demo/threads/${threadId}/turns/${turn.id}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000901',
          workspaceId: 'ws_demo',
          threadId,
          turnId: turn.id,
        }),
      });
    try {
      const wrongThread = await interrupt('th_wrong');
      expect(wrongThread.status).toBe(404);
      expect(signal.aborted).toBe(false);
      const stopped = await interrupt();
      expect(stopped.status, await stopped.clone().text()).toBe(200);
      await expect(stopped.json()).resolves.toMatchObject({
        id: turn.id,
        status: 'interrupted',
        error: { code: 'provider_call_aborted' },
      });
      expect(signal.aborted).toBe(true);
      expect(interruptWorker).not.toHaveBeenCalled();
      const submitted = await pending;
      expect(submitted.status).toBe(499);
      await expect(submitted.json()).resolves.toMatchObject({ code: 'provider_call_aborted' });
      const retained = structuredClone(store.getTurnById(turn.id));
      const replay = await interrupt();
      expect(replay.status).toBe(200);
      const freshStop = await app.request(
        `/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}/interrupt`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000903',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turn.id,
          }),
        }
      );
      expect(freshStop.status).toBe(409);
      await expect(freshStop.json()).resolves.toMatchObject({ code: 'turn_not_interruptible' });
      expect(store.getTurnById(turn.id)).toEqual(retained);
      expect(
        store.getCommandRequest('turn.interrupt', '00000000-0000-4000-8000-000000000903', {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
        })
      ).toBeNull();
      expect(interruptWorker).not.toHaveBeenCalled();
      const submitReplay = await submit('req_chat_cancel');
      expect(submitReplay.status).toBe(499);
      await expect(submitReplay.json()).resolves.toMatchObject({ code: 'provider_call_aborted' });
      const coldReplay = await createApp({
        ...appOptions,
        store: new FsStore({ dataRoot }),
      }).request('/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationRequest('Explain a short concept.', 'req_chat_cancel')),
      });
      expect(coldReplay.status).toBe(499);
      const coldInterrupt = await createApp({
        ...appOptions,
        store: new FsStore({ dataRoot }),
      }).request(`/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000901',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
        }),
      });
      expect(coldInterrupt.status).toBe(200);
      await expect(coldInterrupt.json()).resolves.toMatchObject({
        id: turn.id,
        status: 'interrupted',
      });
      const changedInput = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(conversationRequest('A changed request.', 'req_chat_cancel')),
        }
      );
      expect(changedInput.status).toBe(409);
      await expect(changedInput.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      const fresh = await submit('req_chat_after_stop');
      expect(fresh.status).toBe(200);
      if (lateOutcome === 'resolve') provider.resolve(answer);
      else provider.reject(new Error('private late provider failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(store.getTurnById(turn.id)).toEqual(retained);
      expect(
        store.listThreadItems('ws_demo', 'th_demo').filter((item) => item.turnId === turn.id)
      ).toEqual([expect.objectContaining({ type: 'user-message' })]);
      expect(new FsStore({ dataRoot }).getTurnById(turn.id)).toEqual(retained);
      expect(calls).toBe(2);
    } finally {
      provider.resolve(answer);
      await pending;
    }
  });

  it('keeps internal Chat running when its HTTP transport disconnects', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-disconnect-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const store = createDemoStore({ dataRoot });
    const transport = new AbortController();
    const admitted = Promise.withResolvers<AbortSignal>();
    const provider = Promise.withResolvers<unknown>();
    const app = createApp({
      ...createQuickChatProviderOptions(),
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, _request, _onUsage, options) => {
          admitted.resolve(options.signal!);
          return provider.promise;
        },
      } as unknown as PiAiGatewayClient,
    });
    const pending = app.request('/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: transport.signal,
      body: JSON.stringify(conversationRequest('Explain a short concept.', 'req_chat_disconnect')),
    });
    const signal = await admitted.promise;
    transport.abort(new Error('private transport reason'));
    const remainedRunning = store.listThreadTurns('ws_demo', 'th_demo')[0]!.status;
    const aborted = signal.aborted;
    provider.resolve({
      id: 'chatcmpl_disconnect',
      object: 'chat.completion',
      created: 1,
      model: 'openai/gpt-5.2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Finished after disconnect.' },
          finish_reason: 'stop',
        },
      ],
    });
    const response = await pending;
    expect(remainedRunning).toBe('running');
    expect(aborted).toBe(false);
    expect(response.status).toBe(200);
    expect(store.listThreadTurns('ws_demo', 'th_demo')[0]!.status).toBe('completed');
  });

  it.each([
    'Turn',
    'receipt',
    'interrupt receipt',
  ] as const)('reports recovery_required when Chat Stop cannot persist its %s', async (failure) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-stop-persistence-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const store = createDemoStore({ dataRoot });
    const admitted = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<unknown>();
    const createChatCompletion = vi.fn(async () => {
      admitted.resolve();
      return provider.promise;
    });
    const app = createApp({
      ...createQuickChatProviderOptions(),
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: { createChatCompletion } as unknown as PiAiGatewayClient,
    });
    const submit = () =>
      app.request('/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          conversationRequest('Explain a short concept.', 'req_chat_stop_refusal')
        ),
      });
    const pending = submit();
    await admitted.promise;
    const turn = store.listThreadTurns('ws_demo', 'th_demo')[0]!;
    const originalUpdate = store.updateTurn.bind(store);
    const update = vi.spyOn(store, 'updateTurn').mockImplementation((...args) => {
      if (failure === 'Turn' && args[1].status === 'interrupted')
        throw new Error('private persist refusal');
      return originalUpdate(...args);
    });
    const originalRecord = store.recordCommandRequest.bind(store);
    const record = vi.spyOn(store, 'recordCommandRequest').mockImplementation((...args) => {
      if (
        (failure === 'receipt' && args[0].command === 'conversation.submit') ||
        (failure === 'interrupt receipt' && args[0].command === 'turn.interrupt')
      )
        throw new Error('private receipt refusal');
      return originalRecord(...args);
    });
    try {
      const stop = () =>
        app.request(`/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}/interrupt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000902',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turn.id,
          }),
        });
      const requests = failure === 'interrupt receipt' ? [stop(), stop()] : [stop()];
      const [stopped, concurrent] = await Promise.all(requests);
      expect(stopped.status).toBe(409);
      const stopBody = await stopped.json();
      expect(stopBody).toMatchObject({ code: 'recovery_required' });
      expect(JSON.stringify(stopBody)).not.toContain('private');
      if (concurrent) {
        expect(concurrent.status).toBe(409);
        const concurrentBody = await concurrent.json();
        expect(concurrentBody).toMatchObject({ code: 'recovery_required' });
        expect(JSON.stringify(concurrentBody)).not.toContain('private');
      }
      const response = await pending;
      expect(response.status).toBe(failure === 'interrupt receipt' ? 499 : 409);
      const body = await response.json();
      expect(body).toMatchObject({
        code: failure === 'interrupt receipt' ? 'provider_call_aborted' : 'recovery_required',
      });
      expect(JSON.stringify(body)).not.toContain('private');
      expect(
        store.getCommandRequest('turn.interrupt', '00000000-0000-4000-8000-000000000902', {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
        })
      ).toBeNull();
      update.mockRestore();
      record.mockRestore();
      const replay = await submit();
      expect(replay.status).toBe(failure === 'interrupt receipt' ? 499 : 409);
      await expect(replay.json()).resolves.toMatchObject({
        code: failure === 'interrupt receipt' ? 'provider_call_aborted' : 'recovery_required',
      });
      if (failure !== 'interrupt receipt') {
        const retainedTurns = store.listThreadTurns('ws_demo', 'th_demo');
        const retainedItems = store.listThreadItems('ws_demo', 'th_demo');
        for (const change of [
          { input: 'Search the web for updates' },
          { targetRef: 'internal-role:knowledge-manager' },
        ]) {
          const changed = await app.request(
            '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ...conversationRequest('Explain a short concept.', 'req_chat_stop_refusal'),
                ...change,
              }),
            }
          );
          expect(changed.status, await changed.clone().text()).toBe(409);
          await expect(changed.json()).resolves.toMatchObject({ code: 'recovery_required' });
          expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual(retainedTurns);
          expect(store.listThreadItems('ws_demo', 'th_demo')).toEqual(retainedItems);
          expect(
            store.getCommandRequest('conversation.submit', 'req_chat_stop_refusal', {
              actorId: 'user_local',
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
            })
          ).toBeNull();
        }
      }
      if (failure === 'interrupt receipt') {
        const stopReplay = await app.request(
          `/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}/interrupt`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000902',
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              turnId: turn.id,
            }),
          }
        );
        expect(stopReplay.status).toBe(409);
        await expect(stopReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      }
      expect(createChatCompletion).toHaveBeenCalledTimes(1);
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .every((item) => item.type !== 'assistant-message')
      ).toBe(true);
    } finally {
      update.mockRestore();
      record.mockRestore();
      provider.resolve({ choices: [] });
      await pending;
    }
  });

  it('scopes existing Worker targets to this conversation and preserves truthful availability', async () => {
    const store = createDemoStore();
    const workerSetup = createTestAgentSetup({
      logicalModelId: 'quick-chat',
      privateRoute: { providerProfileId: 'ollama', providerModel: 'openai/gpt-5.2' },
    });
    const states = [
      'ready',
      'idle',
      'busy',
      'created',
      'initializing',
      'degraded',
      'interrupted',
      'failed',
      'closed',
    ] as const;
    const threads = states.map((status) => {
      const thread = store.createThread('ws_demo', `Worker ${status}`);
      store.createAgentSession({
        id: `as_${status}`,
        agentId: workerSetup.manifest.id,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        status,
        message: null,
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      });
      return thread;
    });
    const app = createApp({
      ...createQuickChatProviderOptions(),
      agentManifests: [workerSetup.manifest],
      store,
      turnExecutor: new ThrowingTurnExecutor(),
    });

    for (const [index, status] of states.entries()) {
      const response = await app.request(
        `/api/app/workspaces/ws_demo/conversation-targets?threadId=${threads[index]!.id}`
      );
      expect(response.status).toBe(200);
      const catalog = ConversationTargetCatalogSchema.parse(await response.json());
      const workers = catalog.targets.filter((target) => target.kind === 'running-worker');
      if (['interrupted', 'failed', 'closed'].includes(status)) {
        expect(workers).toEqual([]);
      } else {
        expect(workers).toEqual([
          expect.objectContaining({
            threadId: threads[index]!.id,
            label: 'Codex Agent · This conversation',
            availability:
              status === 'busy'
                ? 'busy'
                : ['ready', 'idle'].includes(status)
                  ? 'available'
                  : 'unavailable',
          }),
        ]);
      }
      expect(JSON.stringify(catalog)).not.toContain('as_');
    }

    for (const index of [0, 2]) {
      store.updateAgentSession(`as_${states[index]}`, { stale: true });
      const stale = await app.request(
        `/api/app/workspaces/ws_demo/conversation-targets?threadId=${threads[index]!.id}`
      );
      const staleCatalog = ConversationTargetCatalogSchema.parse(await stale.json());
      expect(staleCatalog.targets.find((target) => target.kind === 'running-worker')).toMatchObject(
        {
          availability: 'unavailable',
          unavailableReason: 'Worker is not ready.',
        }
      );
    }

    const starter = await app.request('/api/app/workspaces/ws_demo/conversation-targets');
    const catalog = ConversationTargetCatalogSchema.parse(await starter.json());
    expect(catalog.targets.some((target) => target.kind === 'running-worker')).toBe(false);

    const response = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...conversationRequest('Do not send to another conversation.', 'req_foreign_worker'),
          targetRef: `running-worker:${threads[0]!.id}:${workerSetup.manifest.id}`,
        }),
      }
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'target_missing' });
    expect(store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    expect(store.listThreadTurns('ws_demo', threads[0]!.id)).toEqual([]);
  });

  it('rejects an administration Thread at the ordinary conversation entry', async () => {
    const store = createDemoStore();
    const thread = store.createThread(
      'ws_demo',
      'Private administration',
      undefined,
      'administration'
    );
    const app = createApp({
      ...createQuickChatProviderOptions(),
      store,
      turnExecutor: new ThrowingTurnExecutor(),
    });

    const response = await app.request(
      `/api/app/workspaces/ws_demo/threads/${thread.id}/conversation-turns`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationRequest('Continue here.', 'req_wrong_entry')),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'thread_entry_path_mismatch' });
  });

  it('falls back only to the configured default Worker when Assistant is unavailable', async () => {
    const workerSetup = createTestAgentSetup({
      logicalModelId: 'quick-chat',
      privateRoute: { providerProfileId: 'ollama', providerModel: 'openai/gpt-5.2' },
    });
    const app = createApp({
      ...createQuickChatProviderOptions(),
      agentManifests: [workerSetup.manifest],
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'missing',
        profiles: [],
      },
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store: createDemoStore(),
      turnExecutor: new ThrowingTurnExecutor(),
    });

    const response = await app.request('/api/app/workspaces/ws_demo/conversation-targets');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ defaultTargetRef: 'new-task-worker' });
  });

  it('keeps Quick Chat, Chat Mode, and Task Mode route ownership outside app composition', () => {
    const appSource = readFileSync('./src/app.ts', 'utf8');
    const modeEntrySource = readFileSync('./src/mode-entry-routes.ts', 'utf8');

    expect(appSource).toContain('registerQuickAndChatModeRoutes({');
    expect(appSource).toContain('registerTaskModeRoute({');
    expect(appSource).not.toContain("registerAppApiRoute(app, 'quickChat'");
    expect(appSource).not.toContain("registerAppApiRoute(app, 'submitConversation'");
    expect(appSource).not.toContain("registerAppApiRoute(app, 'startTaskMode'");
    expect(modeEntrySource).toContain("registerAppApiRoute(app, 'quickChat'");
    expect(modeEntrySource).toContain("registerAppApiRoute(app, 'submitConversation'");
    expect(modeEntrySource).toContain("registerAppApiRoute(app, 'startTaskMode'");
    expect(appSource).not.toContain('InternalAgentRunner');
    expect(appSource).not.toContain('getInternalAgentRunner');
    expect(modeEntrySource).not.toContain('InternalAgentRunner');
    expect(modeEntrySource).not.toContain('getInternalAgentRunner');
  });

  it('records a thread-scoped Chat Mode answer without starting a worker turn', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-mode-answer-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    onTestFinished(() => coreDb.sqlite.close());
    const calls: Array<{
      providerId: string;
      request: Parameters<PiAiGatewayClient['createChatCompletion']>[1];
    }> = [];
    const app = createApp({
      ...createQuickChatProviderOptions(),
      coreDb,
      dataRoot,
      store: createDemoStore({ dataRoot }),
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
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });

    const res = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest('What is OpenKit?', 'req_chat_answer')),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = SubmitConversationResponseSchema.parse(await res.json());

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
    expect(parsed.turn.agentId).toBe('quick-chat');
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
      },
    });
    expect(calls[0]?.request).not.toHaveProperty('metadata');
    const captureDb = openWorkspaceDb(dataRoot, 'ws_demo');
    try {
      const observations = readWorkObservations(captureDb, {
        threadId: 'th_demo',
        turnId: parsed.turn.id,
      });
      expect(observations[0]).toMatchObject({
        type: 'env.bound',
        obs: 'core',
        payload: { version: expect.any(String), workspaceId: 'ws_demo', tools: [] },
      });
      expect(JSON.stringify(observations[0])).not.toContain(EXPECTED_QUICK_CHAT_SYSTEM_PROMPT);
      expect(observations[1]?.type).toBe('model.observed');
    } finally {
      captureDb.sqlite.close();
    }
    const replayRes = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest('What is OpenKit?', 'req_chat_answer')),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(replayRes.status).toBe(200);
    expect(SubmitConversationResponseSchema.parse(await replayRes.json())).toEqual(parsed);
    expect(calls).toHaveLength(1);
  });

  it('rebuilds Assistant continuity from only the current Thread after a disk reload', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-continuity-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const otherThread = store.createThread('ws_demo', 'Unrelated conversation');
    const initialInput = 'Explain why the sky is blue in two sentences.';
    const otherInput = 'Explain why leaves are green.';
    const currentInput = 'Shorten your previous answer to one sentence.';
    const replies = [
      'Air scatters blue light more strongly than red light. That scattered light makes the sky look blue.',
      'Unrelated Thread answer: chlorophyll absorbs other colors and reflects green.',
      'Air scatters blue light, making the sky look blue.',
    ];
    const calls: Array<Parameters<PiAiGatewayClient['createChatCompletion']>[1]> = [];
    const appOptions = {
      ...createQuickChatProviderOptions(),
      coreDb,
      dataRoot,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          calls.push(request);
          return {
            id: `chatcmpl_continuity_${calls.length}`,
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: replies[calls.length - 1] },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
    };
    const app = createApp({ ...appOptions, store });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });

    for (const [threadId, input, requestId] of [
      ['th_demo', initialInput, 'req_continuity_first'],
      [otherThread.id, otherInput, 'req_continuity_other'],
    ] as const) {
      const response = await app.request(
        `/api/app/workspaces/ws_demo/threads/${threadId}/conversation-turns`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(conversationRequest(input, requestId)),
        }
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const answer = SubmitConversationResponseSchema.parse(await response.json());
      expect(answer.outcome).toBe('answered');
      expect(answer.turn.status).toBe('completed');
    }
    expect(calls).toHaveLength(2);
    const priorTurn = store.createTurn('ws_demo', 'th_demo', 'Interrupted worker attempt', {
      kind: 'user',
      id: 'user_local',
    }).id;
    for (const status of ['in_progress', 'failed'] as const) {
      store.createItem({
        id: `it_partial_${status}`,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: priorTurn,
        type: 'assistant-message',
        status,
        text: `Unfinished worker text: ${status}`,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
    }
    store.updateTurn(priorTurn, { status: 'failed', completedAt: new Date().toISOString() });
    const priorItems = store.listThreadItems('ws_demo', 'th_demo');

    // Reconstruct the app and store so continuity cannot depend on their in-memory history.
    const reloadedStore = new FsStore({ dataRoot });
    expect(reloadedStore.listThreadItems('ws_demo', 'th_demo')).toEqual(priorItems);
    const priorMessages = reloadedStore
      .listThreadItems('ws_demo', 'th_demo')
      .flatMap((item) =>
        item.status === 'completed' &&
        (item.type === 'user-message' || item.type === 'assistant-message')
          ? [{ role: item.type === 'user-message' ? 'user' : 'assistant', content: item.text }]
          : []
      );
    expect(priorMessages).toEqual([
      { role: 'user', content: initialInput },
      { role: 'assistant', content: replies[0] },
    ]);
    expect(reloadedStore.listThreadItems('ws_demo', otherThread.id)).toEqual(
      store.listThreadItems('ws_demo', otherThread.id)
    );
    const reloadedApp = createApp({ ...appOptions, store: reloadedStore });
    const response = await reloadedApp.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationRequest(currentInput, 'req_continuity_next')),
      }
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(SubmitConversationResponseSchema.parse(await response.json()).outcome).toBe('answered');
    expect(calls).toHaveLength(3);
    const messages = calls[2]!.messages.filter((message) => message.role !== 'system');
    expect(messages.some((message) => message.content === otherInput)).toBe(false);
    expect(messages.some((message) => message.content === replies[1])).toBe(false);
    expect(messages).toEqual([...priorMessages, { role: 'user', content: currentInput }]);
  });

  it('answers a Chat Mode handoff summary from current input despite incidental review nouns', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-mode-handoff-summary-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    onTestFinished(() => coreDb.sqlite.close());
    const store = createDemoStore({ dataRoot });
    const calls: Array<{
      request: Parameters<PiAiGatewayClient['createChatCompletion']>[1];
    }> = [];
    const input =
      'Current handoff evidence includes the last review notes and the audit write. For this turn only, do not call tools, start workers, change configuration, approve anything, publish, or deploy. Summarize this handoff from the current input only.';
    const app = createApp({
      ...createQuickChatProviderOptions(),
      coreDb,
      dataRoot,
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          calls.push({ request });
          return {
            id: 'chatcmpl_handoff_summary',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Handoff summary from current input.' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const listKnowledgeProposals = vi.spyOn(store, 'listKnowledgeProposals');

    try {
      const res = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          method: 'POST',
          body: JSON.stringify(conversationRequest(input, 'req_chat_handoff_summary')),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(res.status, await res.clone().text()).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'answered',
        explanation: 'The Assistant answered directly.',
        handoff: null,
        item: {
          type: 'assistant-message',
          text: 'Handoff summary from current input.',
          status: 'completed',
        },
      });
      expect(listKnowledgeProposals).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.request).toMatchObject({
        messages: [
          { role: 'system', content: EXPECTED_QUICK_CHAT_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
      });
      expect(calls[0]?.request).not.toHaveProperty('metadata');
    } finally {
      listKnowledgeProposals.mockRestore();
    }
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
        `/api/app/workspaces/${workspace.id}/threads/${thread.id}/conversation-turns`,
        {
          method: 'POST',
          body: JSON.stringify(conversationRequest('Answer through the provider.', requestId)),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(res.status).toBe(200);
      const parsed = SubmitConversationResponseSchema.parse(await res.json());

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
          request_id: requestId,
          thread_id: thread.id,
          turn_id: parsed.turn.id,
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

  it('answers an explicit Knowledge Manager query through S61 without calling QuickChatAgent', async () => {
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

    const res = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify({
          ...conversationRequest('Launch cadence', 'req_chat_knowledge_answer'),
          targetRef: 'internal-role:knowledge-manager',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(res.status).toBe(200);
    const parsed = SubmitConversationResponseSchema.parse(await res.json());

    expect(parsed).toMatchObject({
      outcome: 'answered',
      explanation: 'The Knowledge Manager answered from Workspace Knowledge.',
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
    const replayRes = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify({
          ...conversationRequest('Launch cadence', 'req_chat_knowledge_answer'),
          targetRef: 'internal-role:knowledge-manager',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(replayRes.status).toBe(200);
    expect(SubmitConversationResponseSchema.parse(await replayRes.json())).toEqual(parsed);
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
        caller: 'app-api',
        selected: [
          expect.objectContaining({
            knowledgePageId: knowledge.id,
            contentDigest,
          }),
        ],
      }),
    ]);
  });

  it('answers a generic Assistant prompt without reading overlapping Workspace Knowledge', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-mode-weak-knowledge-'));
    const store = createDemoStore({ dataRoot });
    let providerCalls = 0;
    const app = createApp({
      ...createQuickChatProviderOptions(),
      dataRoot,
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => {
          providerCalls += 1;
          return {
            id: 'chatcmpl_catalog_ok_grok',
            object: 'chat.completion',
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'CATALOG_OK_GROK' },
                finish_reason: 'stop',
              },
            ],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const createRes = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-00000000c002',
        kind: 'project-context',
        title: 'Workspace maintenance notes',
        content: 'This page is not about the selected Assistant model.',
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(createRes.status).toBe(201);

    const listKnowledgeProposals = vi.spyOn(store, 'listKnowledgeProposals');
    onTestFinished(() => listKnowledgeProposals.mockRestore());

    const res = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(
          conversationRequest(
            'Reply exactly CATALOG_OK_GROK. Do not call tools.',
            'req_chat_weak_knowledge_overlap'
          )
        ),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = SubmitConversationResponseSchema.parse(await res.json());
    expect(providerCalls).toBe(1);
    expect(listKnowledgeProposals).not.toHaveBeenCalled();
    expect(existsSync(join(dataRoot, 'workspaces', 'ws_demo', 'knowledge', 'traces'))).toBe(false);
    expect(parsed).toMatchObject({
      outcome: 'answered',
      explanation: 'The Assistant answered directly.',
      item: {
        type: 'assistant-message',
        text: 'CATALOG_OK_GROK',
      },
    });
    expect(parsed.item.text).not.toContain('This page is not about the selected Assistant model.');
  });

  it('answers explicit Artifact input without substituting matching Workspace Knowledge', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-artifact-source-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const prompts: string[] = [];
      const app = createApp({
        ...createQuickChatProviderOptions(),
        dataRoot,
        coreDb,
        store: createDemoStore({ dataRoot }),
        turnExecutor: new ThrowingTurnExecutor(),
        llmPiAiClient: {
          createChatCompletion: async (_provider, request) => {
            const user = request.messages.find((message) => message.role === 'user');
            prompts.push(typeof user?.content === 'string' ? user.content : '');
            return {
              id: 'chatcmpl_artifact_source',
              object: 'chat.completion',
              created: 1,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'artifact-roundtrip-c7f46a19; 62 passed.',
                  },
                  finish_reason: 'stop',
                },
              ],
            };
          },
        } as unknown as PiAiGatewayClient,
      });
      recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
      const knowledge = await app.request('/api/workspaces/ws_demo/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-00000000c002',
          kind: 'project-context',
          title: 'Maintenance report acceptance',
          content: 'Maintenance report acceptance: unrelated-knowledge-marker.',
        }),
      });
      expect(knowledge.status).toBe(201);
      const content = '# Maintenance report acceptance\n\nartifact-roundtrip-c7f46a19; 62 passed.';
      const imported = await app.request('/api/app/workspaces/ws_demo/artifacts/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'artifact-source-import',
          title: 'Maintenance report acceptance',
          mediaType: 'text/markdown',
          contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          content,
        }),
      });
      expect(imported.status, await imported.clone().text()).toBe(201);
      const artifact = await imported.json();
      const input =
        '请只阅读本次明确附加的维护报告，回复报告中的验收标记和已通过的 Goal Web 测试数量。如果无法读取正文，请明确说明，不要猜测。不要执行开发任务、修改文件或配置。';
      const response = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...conversationRequest(input, 'artifact-source-answer'),
            artifactRefs: [
              { artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion },
            ],
          }),
        }
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const answer = SubmitConversationResponseSchema.parse(await response.json());
      expect(answer).toMatchObject({
        outcome: 'answered',
        explanation: 'The Assistant answered directly.',
        handoff: null,
      });
      expect(prompts).toEqual([expect.stringContaining(content)]);
      expect(prompts[0]).toContain(input);
      expect(prompts[0]).not.toContain('unrelated-knowledge-marker');
      expect(answer.item.text).toBe('artifact-roundtrip-c7f46a19; 62 passed.');
      const referenceId = artifactReferenceItemId(artifact.artifactId, answer.turn.id);
      expect(
        answer.turn.items
          .filter((item) => item.type === 'artifact-reference')
          .map((item) => item.id)
      ).toEqual([referenceId]);
      const reloaded = new FsStore({ dataRoot });
      expect(
        reloaded
          .getTurn('ws_demo', 'th_demo', answer.turn.id)
          .items.filter((item) => item.type === 'artifact-reference')
          .map((item) => item.id)
      ).toEqual([referenceId]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('asks a bounded clarification question for vague Chat Mode requests', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-clarify-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const app = createApp({
      ...createQuickChatProviderOptions(),
      coreDb,
      dataRoot,
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new Error('Clarification-needed Chat Mode must not call QuickChatAgent');
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest('Help', 'req_chat_clarify')),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(res.status).toBe(202);
    const parsed = SubmitConversationResponseSchema.parse(await res.json());

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
    expect(parsed.turn.status).toBe('completed');
    expect(store.listThreadItems('ws_demo', 'th_demo').map((item) => item.type)).toEqual([
      'user-message',
      'user-input-request',
    ]);
    expect(
      store.getCommandRequest('conversation.submit', 'req_chat_clarify', {
        actorId: 'user_local',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      })?.response.conversationMetadata
    ).toEqual({
      downstream: null,
      logicalModelId: 'quick-chat',
      receivingThreadId: 'th_demo',
      receivingWorkspaceId: 'ws_demo',
      resultKind: 'clarification',
      status: 202,
      targetRef: 'internal-role:assistant',
    });

    const actionCenterRes = await app.request('/api/app/workspaces/ws_demo/action-center');
    const actionCenter = (await actionCenterRes.json()) as {
      items: Array<{ kind: string; source: unknown }>;
    };

    expect(actionCenter.items.filter((item) => item.kind === 'question')).toEqual([
      expect.objectContaining({
        kind: 'question',
        id: `question:ui_chat_clarify_${parsed.turn.id}`,
        source: expect.objectContaining({
          type: 'protocol_item',
          itemType: 'user-input-request',
          itemId: parsed.item.id,
        }),
      }),
    ]);

    const replayRes = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest('Help', 'req_chat_clarify')),
        headers: { 'content-type': 'application/json' },
      }
    );
    const replay = SubmitConversationResponseSchema.parse(await replayRes.json());

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
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest('Help', 'req_chat_clarify')),
        headers: { 'content-type': 'application/json' },
      }
    );
    expect(contradictedReplay.status).toBe(409);
    await expect(contradictedReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
    coreDb.sqlite.close();
  });

  it('delivers a clarified answer through the Assistant service without a conversation receipt', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-clarify-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const app = createApp({
      ...createQuickChatProviderOptions(),
      coreDb,
      dataRoot,
      store,
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          const accepted = openWorkspaceDb(dataRoot, 'ws_demo');
          expect(
            accepted.sqlite
              .prepare('SELECT delivery FROM pending_requests WHERE request_id = ?')
              .get(`ui_chat_clarify_${parsed.turn.id}`)
          ).toEqual({ delivery: 'delivered' });
          accepted.sqlite.close();
          return {
            id: 'clarified-answer',
            choices: [{ message: { content: 'Four is the answer.', role: 'assistant' } }],
          };
        },
      } as unknown as PiAiGatewayClient,
    });

    const res = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest('Help', 'req_chat_clarify')),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(res.status).toBe(202);
    const parsed = SubmitConversationResponseSchema.parse(await res.json());

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
    expect(parsed.turn.status).toBe('completed');
    expect(store.listThreadItems('ws_demo', 'th_demo').map((item) => item.type)).toEqual([
      'user-message',
      'user-input-request',
    ]);
    expect(
      store.getCommandRequest('conversation.submit', 'req_chat_clarify', {
        actorId: 'user_local',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      })?.response.conversationMetadata
    ).toEqual({
      downstream: null,
      logicalModelId: 'quick-chat',
      receivingThreadId: 'th_demo',
      receivingWorkspaceId: 'ws_demo',
      resultKind: 'clarification',
      status: 202,
      targetRef: 'internal-role:assistant',
    });

    const actionCenterRes = await app.request('/api/app/workspaces/ws_demo/action-center');
    const actionCenter = (await actionCenterRes.json()) as {
      items: Array<{ kind: string; source: unknown }>;
    };

    expect(actionCenter.items.filter((item) => item.kind === 'question')).toEqual([
      expect.objectContaining({
        kind: 'question',
        id: `question:ui_chat_clarify_${parsed.turn.id}`,
        source: expect.objectContaining({
          type: 'protocol_item',
          itemType: 'user-input-request',
          itemId: parsed.item.id,
        }),
      }),
    ]);

    const replayRes = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest('Help', 'req_chat_clarify')),
        headers: { 'content-type': 'application/json' },
      }
    );
    const replay = SubmitConversationResponseSchema.parse(await replayRes.json());

    expect(replayRes.status).toBe(202);
    expect(replay.turn).toEqual(parsed.turn);
    expect(replay.item).toEqual(parsed.item);

    const answer = await app.request(
      `/api/user-input-requests/ui_chat_clarify_${parsed.turn.id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userInputRequestId: `ui_chat_clarify_${parsed.turn.id}`,
          requestId: '00000000-0000-4000-8000-00000000aa01',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          answers: { chat_clarification: ['What is two plus two?'] },
        }),
      }
    );
    expect(answer.status, await answer.clone().text()).toBe(200);
    for (
      let attempt = 0;
      attempt < 1000 &&
      !store
        .listThreadItems('ws_demo', 'th_demo')
        .some((item) => item.type === 'assistant-message' && item.text === 'Four is the answer.');
      attempt += 1
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const result = store
      .listThreadItems('ws_demo', 'th_demo')
      .find((item) => item.type === 'assistant-message' && item.text === 'Four is the answer.');
    expect(
      result,
      JSON.stringify(
        store.listThreadTurns('ws_demo', 'th_demo').map((turn) => ({
          status: turn.status,
          error: turn.error,
          trigger: turn.triggerSource,
          items: turn.items.map((item) => item.type),
        }))
      )
    ).toBeDefined();
    expect(result?.turnId).not.toBe(parsed.turn.id);
    expect(store.getTurnById(result!.turnId!).agentSessionId).toBeFalsy();
    expect(
      store.listCommandRequests().filter((receipt) => receipt.command === 'conversation.submit')
    ).toHaveLength(1);
    coreDb.sqlite.close();
  });

  it('fails Chat Mode replay closed when durable owners contradict', async () => {
    const store = createDemoStore();
    const app = createApp({
      ...createQuickChatProviderOptions(),
      store,
      turnExecutor: new ThrowingTurnExecutor(),
    });
    const requestId = 'req_chat_missing_owner';
    const input = 'Search the web for current OpenKit news.';
    const scope = { actorId: 'user_local', threadId: 'th_demo', workspaceId: 'ws_demo' };
    const first = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest(input, requestId)),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(first.status).toBe(200);
    const accepted = SubmitConversationResponseSchema.parse(await first.json());
    const successfulReplay = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest(input, requestId)),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(successfulReplay.status).toBe(200);
    expect(SubmitConversationResponseSchema.parse(await successfulReplay.json())).toEqual(accepted);
    const userItem = store
      .listThreadItems('ws_demo', 'th_demo')
      .find((item) => item.id === `it_chat_user_${accepted.turn.id}`);
    if (userItem?.type !== 'user-message') {
      throw new Error('Expected the stored Chat user message.');
    }
    userItem.actor = { kind: 'user', id: 'user_other' };
    const contradictedActorReplay = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest(input, requestId)),
        headers: { 'content-type': 'application/json' },
      }
    );
    expect(contradictedActorReplay.status).toBe(409);
    await expect(contradictedActorReplay.json()).resolves.toMatchObject({
      code: 'recovery_required',
    });
    userItem.actor = accepted.turn.triggerActor;
    const storedTurn = store.getTurnById(accepted.turn.id);
    storedTurn.status = 'failed';
    const contradictedTurnReplay = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest(input, requestId)),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(contradictedTurnReplay.status).toBe(409);
    await expect(contradictedTurnReplay.json()).resolves.toMatchObject({
      code: 'recovery_required',
    });
    storedTurn.status = 'completed';
    const receipt = store.getCommandRequest('conversation.submit', requestId, scope);
    expect(receipt).not.toBeNull();
    store.recordCommandRequest({
      command: 'conversation.submit',
      inputHash: receipt!.inputHash,
      requestId,
      response: { id: 'tu_missing_chat_owner', kind: 'turn' },
      scope,
    });

    const replay = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
      {
        method: 'POST',
        body: JSON.stringify(conversationRequest(input, requestId)),
        headers: { 'content-type': 'application/json' },
      }
    );

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
        ...createQuickChatProviderOptions(),
        agentManifests: [createTestAgentSetup().manifest],
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
        targetRef: 'internal-role:assistant',
        artifactRefs: [],
      };

      const turnsBefore = store.listThreadTurns('ws_demo', 'th_demo').map((turn) => turn.id);
      const goalRes = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          method: 'POST',
          body: JSON.stringify(request),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(goalRes.status).toBe(409);
      await expect(goalRes.json()).resolves.toMatchObject({ code: 'goal_mode_unavailable' });
      expect(store.listThreadTurns('ws_demo', 'th_demo').map((turn) => turn.id)).toEqual(
        turnsBefore
      );
      expect(
        store.getCommandRequest('conversation.submit', request.requestId, {
          actorId: 'user_local',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        })
      ).toBeNull();

      const replayRes = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/conversation-turns',
        {
          method: 'POST',
          body: JSON.stringify(request),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(replayRes.status).toBe(409);
      await expect(replayRes.json()).resolves.toMatchObject({ code: 'goal_mode_unavailable' });
      expect(store.listThreadTurns('ws_demo', 'th_demo').map((turn) => turn.id)).toEqual(
        turnsBefore
      );
      expect(store.listCommandRequests().map((record) => record.command)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('logs a redacted unexpected Quick Chat error at the existing console sink', async () => {
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({
      ...createQuickChatProviderOptions(),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new Error('Unexpected provider defect; token=synthetic-canary');
        },
      } as unknown as PiAiGatewayClient,
    });
    try {
      const response = await app.request('/api/app/quick-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        code: 'quick_chat_failed',
        message: 'Quick chat failed.',
      });
      expect(diagnostics.mock.calls).toEqual([
        ['quick_chat_failed', 'Unexpected provider defect; token=[redacted]'],
      ]);
    } finally {
      diagnostics.mockRestore();
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
      modelId: 'quick-chat',
      content: 'Agent-routed answer',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      providerId: 'ollama',
      request: {
        model: 'openai/gpt-5.2',
        messages: [
          { role: 'system', content: EXPECTED_QUICK_CHAT_SYSTEM_PROMPT },
          { role: 'user', content: 'Route this.' },
        ],
      },
    });
    expect(calls[0]?.request).not.toHaveProperty('metadata');
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

  it('answers with the configured quick-chat provider without starting an AgentSession', async () => {
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
            model: 'openai/gpt-5.2',
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
      modelId: 'quick-chat',
      content: 'It is sunny.',
    });
    expect(seenRequests[0]).not.toHaveProperty('metadata');
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
      createVaultReference(coreDb, {
        referenceId: 'vault_quick_chat',
        ownerScope: 'server',
        displayName: 'Quick Chat test key',
        secretKind: 'provider-api-key',
        backendKind: 'encrypted-file',
      });

      const app = createApp({
        coreDb,
        dataRoot,
        gatewayConfig: {
          schemaVersion: 1,
          enabled: true,
          defaultLogicalModelId: 'quick-vault-model',
          logicalModels: [
            {
              id: 'quick-vault-model',
              displayName: 'Quick Vault Model',
              contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
              routes: [
                {
                  id: 'primary',
                  providerProfileId: 'quick-vault',
                  providerModel: 'openai/gpt-5.2',
                },
              ],
            },
          ],
          requiredFeatures: [],
        },
        internalRoleProfiles: {
          schemaVersion: 1,
          defaultLogicalModelId: 'quick-vault-model',
          profiles: [],
        },
        providerRegistry: new ProviderRegistry([
          {
            baseUrl: 'https://api.example.com/v1',
            defaultModel: 'openai/gpt-5.2',
            displayName: 'Quick Vault',
            id: 'quick-vault',
            kind: 'direct',
            models: ['openai/gpt-5.2'],
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
        modelId: 'quick-vault-model',
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
          provider_ref: null,
          status: 'succeeded',
          workspace_id: 'ws_quick_chat',
        });

        const usage = workspaceDb.sqlite
          .prepare('SELECT * FROM usage_records WHERE capability_call_id = ?')
          .get(call?.call_id) as Record<string, unknown> | undefined;
        expect(usage).toMatchObject({
          category: 'llm',
          model_id: 'quick-chat',
          provider_ref: 'ollama',
          quantity: 12,
          unit: 'tokens',
          workspace_id: 'ws_quick_chat',
        });
        expect(usage?.provider_ref).toBe('ollama');
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

  it('admits Codex-backed quick chat through the real Chat Completions bridge without internal metadata', async () => {
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol' }],
    });
    const pairModels = createModels();
    pairModels.setProvider({ ...faux.provider, baseUrl: openaiCodexProvider().baseUrl });
    vi.spyOn(pairModels, 'checkAuth').mockResolvedValue({ source: 'OAuth', type: 'oauth' });
    faux.setResponses([fauxAssistantMessage('Quick response')]);
    const getPairHandle = vi.fn(async () => ({ credentials: {} as never, models: pairModels }));
    const piAiClient = new PiAiGatewayClient();
    const createResponses = vi.spyOn(piAiClient, 'createResponses');
    const app = createApp({
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'codex-fast',
        logicalModels: [
          {
            id: 'codex-fast',
            displayName: 'Codex Fast',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              {
                id: 'primary',
                providerProfileId: 'openai_codex',
                providerModel: 'openai-codex/gpt-5.6-sol',
              },
            ],
          },
        ],
        requiredFeatures: [],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'codex-fast',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai-codex/gpt-5.6-sol',
          displayName: 'OpenAI Codex',
          extensions: {
            openkit: {
              subscriptionAccount: {
                accountSlotId: 'default',
              },
            },
          },
          id: 'openai_codex',
          kind: 'oauth',
          models: ['openai-codex/gpt-5.6-sol'],
          vendor: 'openai_codex',
        },
      ]),
      turnExecutor: new ThrowingTurnExecutor(),
      llmPiAiClient: piAiClient,
      providerSubscriptionAccountManager: {
        gatewayUnavailableReason: () => null,
        getPairHandle,
      } as unknown as ProviderSubscriptionAccountManager,
    });

    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({ input: 'Ping' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(getPairHandle).toHaveBeenCalledWith({
      accountSlotId: 'default',
      subscriptionProviderId: 'openai-codex',
    });
    expect(createResponses.mock.calls[0]?.[1]).not.toHaveProperty('metadata');
    expect(createResponses.mock.calls[0]?.[1]?.prompt_cache_key).toMatch(
      /^openkit:responses:[a-f0-9]{32}$/
    );
    expect(faux.state.callCount).toBe(1);
    await expect(res.json()).resolves.toMatchObject({
      status: 'completed',
      modelId: 'codex-fast',
      content: 'Quick response',
    });
  });
});

describe('slice 1d round 2 Quick Chat deadline', () => {
  it('keeps the execution deadline across same-member retry and failover', async () => {
    vi.useFakeTimers();
    const options = createQuickChatProviderOptions();
    options.gatewayConfig.logicalModels[0]!.routes.push({
      id: 'backup',
      providerProfileId: 'backup',
      providerModel: 'openai/gpt-5.2',
    });
    const contexts: Array<Parameters<LLMGatewayProviderDispatcher['createChatCompletion']>[2]> = [];
    const dispatch = vi.fn(async (_provider, request, context) => {
      contexts.push(context);
      if (contexts.length < 3)
        throw new GatewayAttemptFailure({
          kind: contexts.length === 1 ? 'rate_limited' : 'auth_rejected',
          settled: true,
        });
      return {
        id: 'chat_deadline',
        object: 'chat.completion',
        created: 1,
        model: request.model,
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'served' } },
        ],
      };
    });
    const app = createApp({
      ...options,
      providerRegistry: new ProviderRegistry([
        { id: 'ollama', displayName: 'Primary', kind: 'local', models: ['openai/gpt-5.2'] },
        { id: 'backup', displayName: 'Backup', kind: 'local', models: ['openai/gpt-5.2'] },
      ]),
      llmGatewayDispatcher: { createChatCompletion: dispatch } as never,
      turnExecutor: new ThrowingTurnExecutor(),
    });
    try {
      const before = Date.now();
      const pending = app.request('/api/app/quick-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Hello' }),
      });
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(200);
      expect(dispatch.mock.calls.map(([p]) => p.id)).toEqual(['ollama', 'ollama', 'backup']);
      expect(contexts.map((c) => c?.transport?.deadline)).toEqual([
        before + 120000,
        before + 120000,
        before + 120000,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
