import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  createKnowledgeManagerTranscript,
  runKnowledgeManagerAgent,
} from './knowledge-manager-agent.js';
import { internalContextDigest } from './rolling-context.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real retained Turn and database; only the external Provider transport is fake. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-agent-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Knowledge');
  const thread = store.createThread(workspace.id, 'Knowledge', undefined, 'knowledge-manager');
  const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
  const turn = store.createTurn(workspace.id, thread.id, 'Question', actor, null, {
    agentId: 'knowledge-manager',
    executorKind: 'assistant',
  });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  return { store, workspace, thread, turn, actor, workspaceDb };
}

it('runs a fresh configured Knowledge Manager Turn through the Gateway and retains its own usage lineage and actual Tool pairs', async () => {
  const f = fixture();
  try {
    const providerRegistry = new ProviderRegistry([
      {
        id: 'fixture',
        adapter: 'openai-compatible',
        displayName: 'Fake transport',
        kind: 'llm',
        enabled: true,
        baseUrl: 'https://provider.invalid/v1',
        models: ['fixture-model'],
        credential: { kind: 'none' },
        capabilities: { llm: { responses: 'supported', chatCompletions: 'supported' } },
        modelMetadata: {
          'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
        },
      },
    ]);
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot: f.store.getDataRoot(),
      providerRegistry,
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        requiredFeatures: [],
        defaultLogicalModelId: 'km-model',
        logicalModels: [
          {
            id: 'km-model',
            displayName: 'KM',
            contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
            routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: 'fixture-model' }],
          },
        ],
      },
    });
    let calls = 0;
    const createResponses = vi.fn(
      async (
        _provider: unknown,
        _request: unknown,
        context: Parameters<LLMGatewayProviderDispatcher['createResponses']>[2]
      ) => {
        context?.onUsage?.({ input_tokens: 9, output_tokens: 3, total_tokens: 12 });
        return {
          id: `response-${++calls}`,
          object: 'response' as const,
          output:
            calls === 1
              ? [
                  {
                    type: 'function_call',
                    call_id: 'read-1',
                    name: 'knowledge_page_read',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'function_call',
                    call_id: 'result-1',
                    name: 'knowledge_result',
                    arguments: JSON.stringify({ answer: 'Cited answer.' }),
                  },
                ],
        };
      }
    );
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Exact page@revision evidence.' }],
    }));
    const result = await runKnowledgeManagerAgent(
      {
        store: f.store,
        runtimeConfig: () => snapshot,
        dispatcher: { createResponses: createResponses as never },
        resolveGatewayProvider: () => ({
          id: 'fixture',
          displayName: 'Fake transport',
          adapterId: 'fixture',
          models: ['fixture-model'],
          baseUrl: null,
          apiKey: '',
          requiresApiKey: false,
          gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
          modelMetadata: {
            'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
          },
        }),
      },
      {
        turn: f.turn,
        workspaceDb: f.workspaceDb,
        signal: new AbortController().signal,
        inputs: {
          purpose: 'query',
          ownerScope: { kind: 'workspace', workspaceId: f.workspace.id },
          baseRevision: 'base',
          trigger: 'request',
          instructions: 'Question',
          sourceRange: [],
        },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Fresh overview and question.' }] },
        ],
        tools: [
          {
            name: 'knowledge.page.read',
            description: 'Read a page.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute,
          },
        ],
        assertCurrent: () => {},
        readEvidence: () => internalContextDigest([]),
        resultSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
        validateResult: (text) => {
          expect(JSON.parse(text)).toEqual({ answer: 'Cited answer.' });
        },
      }
    );
    expect(JSON.parse(result.text)).toEqual({ answer: 'Cited answer.' });
    expect(execute).toHaveBeenCalledTimes(1);
    const stored = f.store.getTurnById(f.turn.id);
    expect(stored).toMatchObject({
      status: 'completed',
      internalExecution: {
        roleId: 'knowledge-manager',
        logicalModelId: 'km-model',
        contextStrategy: 'compaction',
        threshold: 32_000,
      },
    });
    expect(stored.items.map((item) => item.type)).toEqual([
      'user-message',
      'tool-call',
      'tool-call',
    ]);
    expect(stored.items[1]).toMatchObject({
      tool: 'knowledge.page.read',
      causationId: 'read-1',
      result: JSON.stringify([{ type: 'text', text: 'Exact page@revision evidence.' }]),
    });
    const ledger = listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id);
    expect(ledger).toHaveLength(2);
    expect(
      ledger.every((call) => call.agentId === 'knowledge-manager' && call.turnId === f.turn.id)
    ).toBe(true);
    const usage = listWorkspaceUsageRecords(f.workspaceDb, f.workspace.id);
    expect(usage.length).toBeGreaterThan(0);
    expect(
      usage.every((record) => record.agentId === 'knowledge-manager' && record.turnId === f.turn.id)
    ).toBe(true);
    await expect(
      runKnowledgeManagerAgent({} as never, { turn: stored } as never)
    ).rejects.toThrow();
  } finally {
    f.workspaceDb.sqlite.close();
  }
});

it('commits a completed Tool pair once and never fabricates a result for an unsettled call', () => {
  const f = fixture();
  try {
    const commit = createKnowledgeManagerTranscript(f.store, f.turn, f.actor);
    const messages = [
      {
        role: 'assistant' as const,
        truncated: false,
        content: [
          {
            type: 'toolCall' as const,
            name: 'knowledge.page.read',
            callId: 'call-1',
            arguments: {},
          },
        ],
      },
    ];
    expect(commit(messages)).toEqual([]);
    const complete = [
      ...messages,
      {
        role: 'tool' as const,
        callId: 'call-1',
        isError: false,
        content: [{ type: 'text' as const, text: 'Exact evidence.' }],
      },
    ];
    expect(commit(complete)).toHaveLength(1);
    expect(commit(complete)).toHaveLength(1);
    expect(f.store.getTurnById(f.turn.id).items).toHaveLength(1);
  } finally {
    f.workspaceDb.sqlite.close();
  }
});
