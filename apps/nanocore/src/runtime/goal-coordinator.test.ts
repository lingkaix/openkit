import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { expect, it, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { initializeScopedNotebook } from '../knowledge/scoped-notebook-owner.js';
import { FsStore } from '../lib/store.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { readGoalView } from './goal-owner.js';

it('uses native Goal knowledge ask and tell with fixed shared lineage and separate KM work', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-knowledge-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Goal Knowledge');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  initializeScopedNotebook({
    coreDb,
    actor: { kind: 'local', userId },
    target: { kind: 'server' },
    initialization: {
      requestId: randomUUID(),
      instructionReference: 'Initialize Goal Knowledge test.',
    },
  });
  const gatewayConfig = createTestGatewayConfig();
  gatewayConfig.logicalModels[0]!.contextManagement = [
    { type: 'compaction', compactThreshold: 64000 },
  ];
  let coordinatorCalls = 0;
  let maintenanceCalls = 0;
  let queryCalls = 0;
  const coordinatorInputs: string[] = [];
  const queryInputs: string[] = [];
  const call = (name: string, value: unknown) => ({
    id: randomUUID(),
    object: 'response',
    output: [
      { type: 'function_call', call_id: randomUUID(), name, arguments: JSON.stringify(value) },
    ],
  });
  const dispatch = vi.fn(
    async (
      _provider: Parameters<LLMGatewayProviderDispatcher['createResponses']>[0],
      request: Parameters<LLMGatewayProviderDispatcher['createResponses']>[1]
    ) => {
      const names = request.tools.map((tool: { name: string }) => tool.name);
      if (names.includes('goal_card_create')) {
        coordinatorInputs.push(JSON.stringify(request.input));
        if (++coordinatorCalls === 1)
          return call('knowledge_ask', { question: 'What is known about this Goal?' });
        if (coordinatorCalls === 2) {
          return call('knowledge_tell', { content: 'Explicit Goal fact.', sources: [] });
        }
        if (coordinatorCalls === 3)
          return call('knowledge_ask', {
            question: 'Forbidden scope.',
            ownerScope: { kind: 'user', userId },
          });
        return {
          id: randomUUID(),
          object: 'response',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Finished this bounded Goal Turn.' }],
            },
          ],
        };
      }
      if (names.includes('knowledge_notebook-workspace_update')) {
        return ++maintenanceCalls === 1
          ? call('knowledge_notebook_update', { summary: 'No changes are needed.' })
          : call('knowledge_result', { summary: 'No changes are needed.' });
      }
      queryInputs.push(JSON.stringify(request.input));
      if (++queryCalls <= 2)
        return call('knowledge_page_read', {
          pageId: queryCalls === 1 ? `page/workspace/${workspace.id}/index` : 'page/server/index',
        });
      return call('knowledge_result', {
        answer: 'Goal knowledge answer',
        citationIds: [`page/workspace/${workspace.id}/index`, 'page/server/index'],
        uncertainty: null,
      });
    }
  );
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    gatewayConfig,
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        kind: 'local',
        displayName: 'Fake Goal transport',
        models: ['openai/gpt-5.2'],
      },
    ]),
    llmGatewayDispatcher: { createResponses: dispatch } as never,
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  try {
    const response = await app.request('/api/app/operations/goal.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({ workspaceId: workspace.id, intent: 'Inspect Goal Knowledge' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const created = await response.json();
    await vi.waitFor(
      () => {
        expect(store.listThreadTurns(workspace.id, created.goal.threadId)).toContainEqual(
          expect.objectContaining({ status: 'completed' })
        );
      },
      { timeout: 15000 }
    );
    expect(coordinatorCalls).toBe(4);
    expect(coordinatorInputs[1]).toContain('Goal knowledge answer');
    expect(coordinatorInputs[2]).toContain('no-change');
    expect(coordinatorInputs[3]).toContain('The Tool arguments do not match the required schema.');
    expect(queryInputs[0]).toContain('page/server/index');
    expect(queryCalls).toBe(3);
    const turn = store.listThreadTurns(workspace.id, created.goal.threadId)[0]!;
    const calls = listWorkspaceCapabilityCalls(db, workspace.id);
    const asking = calls.filter((entry) => entry.operation === 'knowledge.ask');
    expect(asking).toEqual([
      expect.objectContaining({
        threadId: created.goal.threadId,
        turnId: turn.id,
        status: 'succeeded',
      }),
    ]);
    expect(JSON.stringify(asking[0]!.extensions)).toContain('Goal knowledge answer');
    const maintenance = store
      .listThreads(workspace.id)
      .filter((thread) => thread.entryPath === 'knowledge-manager');
    const kmTurns = maintenance.flatMap((thread) => store.listThreadTurns(workspace.id, thread.id));
    expect(kmTurns).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        internalExecution: expect.objectContaining({
          knowledge: expect.objectContaining({
            purpose: 'maintenance',
            ownerScope: { kind: 'workspace', workspaceId: workspace.id },
          }),
        }),
      })
    );
    expect(store.listServerThreads()).toEqual([]);
  } finally {
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 30000);

it('dispatches an ordinary Coordinator Turn through Gateway and invokes a table-derived Goal Tool', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-gateway-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Gateway Goal');
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: workspace.id,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const dispatch = vi
    .fn()
    .mockResolvedValueOnce({
      id: 'goal-call',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'discover-workers',
          name: 'agent_list',
          arguments: '{}',
        },
        {
          type: 'function_call',
          call_id: 'card-create',
          name: 'goal_card_create',
          arguments: JSON.stringify({ description: 'Review the release', priority: 1 }),
        },
      ],
    })
    .mockResolvedValue({
      id: 'goal-idle',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Awaiting a human Plan decision.' }],
        },
      ],
    });
  const gatewayConfig = createTestGatewayConfig();
  gatewayConfig.logicalModels[0]!.contextManagement = [
    { type: 'compaction', compactThreshold: 64000 },
  ];
  const app = createApp({
    agentManifests: [
      createTestAgentSetup({ agentId: 'discoverable-worker' }).manifest,
      {
        ...createTestAgentSetup({ agentId: 'blocked-worker' }).manifest,
        readiness: { status: 'blocked', message: 'PRIVATE_REASON_CANARY' },
      },
    ],
    gatewayConfig,
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        kind: 'local',
        displayName: 'Test inference',
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
      },
    ]),
    coreDb,
    dataRoot,
    store,
    llmGatewayDispatcher: { createResponses: dispatch } as never,
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  try {
    const response = await app.request('/api/app/operations/goal.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({ workspaceId: workspace.id, intent: 'Review this release' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const created = await response.json();
    await vi.waitFor(
      () => {
        const turns = store.listThreadTurns(workspace.id, created.goal.threadId);
        expect(turns.length).toBeGreaterThan(0);
        expect(turns.map((turn) => ({ status: turn.status, error: turn.error }))).toEqual(
          expect.arrayContaining([{ status: 'completed', error: null }])
        );
        expect(
          turns.some((turn) => turn.status === 'failed'),
          JSON.stringify(turns.map((turn) => turn.error))
        ).toBe(false);
        expect(readGoalView(store, db, created.goal.goalId).cards).toMatchObject([
          { description: 'Review the release', revision: 0 },
        ]);
      },
      { timeout: 10000 }
    );
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(dispatch.mock.calls[1]?.[1].input)).toContain('discoverable-worker');
    expect(JSON.stringify(dispatch.mock.calls[1]?.[1].input)).toContain('codex');
    expect(JSON.stringify(dispatch.mock.calls[1]?.[1].input)).toContain('blocked-worker');
    expect(JSON.stringify(dispatch.mock.calls[1]?.[1].input)).not.toContain(
      'PRIVATE_REASON_CANARY'
    );
    expect(JSON.stringify(dispatch.mock.calls[1]?.[1].input)).not.toContain('/usr/local/bin');
    expect(dispatch.mock.calls[0]?.[1].tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        'thread_items',
        'agent_list',
        'artifact_read',
        'turn_read',
        'evidence_runtime-list',
        'goal_task_dispatch',
      ])
    );
    expect(store.listThreadAgentSessions(workspace.id, created.goal.threadId)).toEqual([]);
    expect(readGoalView(store, db, created.goal.goalId).tasks).toEqual([]);
    expect(readGoalView(store, db, created.goal.goalId).goal?.disposition).toBeNull();
    const calls = db.sqlite
      .prepare("SELECT operation,status FROM capability_calls WHERE operation='goal.coordinate'")
      .all();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => (call as { status: string }).status === 'succeeded')).toBe(true);
  } finally {
    db.sqlite.close();
    coreDb.sqlite.close();
  }
});

/** Exercises actual Coordinator assembly and stock Codex serialization without Provider effects. */
it('completes the real Coordinator request through stock Codex with unchanged Tool schemas', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-stock-codex-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Stock Codex Goal');
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: workspace.id,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const credential = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.synthetic`;
  const models = createModels({
    credentials: {
      list: async () => [{ providerId: 'openai-codex', type: 'oauth' }],
      read: async () => ({
        type: 'oauth',
        access: credential,
        refresh: 'synthetic',
        expires: Date.now() + 3600000,
      }),
      modify: async () => {
        throw new Error('The synthetic credential must not refresh.');
      },
      delete: async () => {},
    },
  });
  models.setProvider(openaiCodexProvider());
  const manager = {
    gatewayUnavailableReason: () => null,
    getPairHandle: async () => ({ models }),
  };
  const gatewayConfig = createTestGatewayConfig();
  gatewayConfig.logicalModels[0]!.routes[0]!.providerModel = 'openai-codex/gpt-6-astra';
  gatewayConfig.logicalModels[0]!.contextManagement = [
    { type: 'compaction', compactThreshold: 64000 },
  ];
  const payloads: Record<string, unknown>[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body =
      new Headers(init?.headers).get('content-encoding') === 'zstd'
        ? zstdDecompressSync(init?.body as Uint8Array).toString()
        : String(init?.body);
    payloads.push(JSON.parse(body));
    const message = {
      type: 'message',
      id: 'msg_fixture',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Awaiting human approval.' }],
    };
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'Awaiting human approval.',
      },
      { type: 'response.output_item.done', output_index: 0, item: message },
      {
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          status: 'completed',
          output: [message],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  });
  const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient() });
  const dispatch = vi.spyOn(dispatcher, 'createResponses');
  const app = createApp({
    gatewayConfig,
    coreDb,
    dataRoot,
    store,
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        vendor: 'openai-codex',
        kind: 'oauth',
        displayName: 'Synthetic Codex',
        models: ['openai-codex/gpt-6-astra'],
        extensions: { openkit: { subscriptionAccount: { accountSlotId: 'fixture' } } },
        modelMetadata: {
          'openai-codex/gpt-6-astra': {
            tool_call: true,
            limit: { context: 256000, output: 32000 },
          },
        },
      },
    ]),
    providerSubscriptionAccountManager: manager as never,
    llmGatewayDispatcher: dispatcher,
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  try {
    const response = await app.request('/api/app/operations/goal.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({ workspaceId: workspace.id, intent: 'Review this release' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const created = await response.json();
    await vi.waitFor(
      () => {
        const turns = store.listThreadTurns(workspace.id, created.goal.threadId);
        expect(turns).toHaveLength(1);
        expect(['completed', 'failed']).toContain(turns[0]?.status);
      },
      { timeout: 10000 }
    );
    await expect(dispatch.mock.results[0]!.value).resolves.toMatchObject({ status: 'completed' });
    expect(store.listThreadTurns(workspace.id, created.goal.threadId)[0]?.status).toBe('completed');
    expect(payloads).toHaveLength(1);
    const tools = dispatch.mock.calls[0]![1].tools as Array<Record<string, unknown>>;
    const wireTools = payloads[0]!.tools as Array<Record<string, unknown>>;
    expect(wireTools.map(({ name }) => name)).toEqual(tools.map(({ name }) => name));
    expect(wireTools.map(({ parameters }) => parameters)).toEqual(
      tools.map(({ parameters }) => parameters)
    );
    expect(wireTools.every((tool) => tool.strict !== true)).toBe(true);
    expect(
      db.sqlite
        .prepare("SELECT status FROM capability_calls WHERE operation='goal.coordinate'")
        .all()
    ).toEqual([{ status: 'succeeded' }]);
  } finally {
    fetchMock.mockRestore();
    db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
