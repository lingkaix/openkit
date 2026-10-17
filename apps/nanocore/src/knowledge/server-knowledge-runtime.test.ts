import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerCapabilityCalls, listServerUsageRecords } from '../capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import {
  pinKnowledgeManagerExecution,
  runServerKnowledgeManagerAgent,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { readWorkObservations } from '../storage/work-observations.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { KnowledgeNotebook } from './notebook.js';
import {
  recoverServerKnowledgeManagerTurns,
  runServerKnowledgeMaintenanceCommand,
  type ServerKnowledgeMaintenanceDependencies,
} from './server-knowledge-maintenance.js';

it('executes a Server request on the configured role model with its own captured usage and no Workspace anchor, then replays without inference', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-km-runtime-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    providerRegistry: new ProviderRegistry([
      {
        id: 'fixture',
        kind: 'custom',
        displayName: 'Fake transport',
        baseUrl: 'https://provider.invalid/v1',
        models: ['ordinary-model', 'server-model'],
        modelMetadata: { 'ordinary-model': metadata, 'server-model': metadata },
      },
    ]),
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'ordinary',
      logicalModels: [
        ['ordinary', 'ordinary-model'],
        ['server-maintenance', 'server-model'],
      ].map(([id, providerModel]) => ({
        id: id!,
        displayName: id!,
        contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
        routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: providerModel! }],
      })),
    },
    internalRoleProfiles: {
      schemaVersion: 1,
      profiles: [
        {
          id: 'server-km-profile',
          roleId: 'knowledge-manager',
          preferredLogicalModelId: 'server-maintenance',
          compatibleLogicalModelIds: [],
          requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
          limits: { maxModelTurns: 8, maxToolCalls: 24, deadlineMs: 120_000 },
        },
      ],
    },
  });
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: {
      ...snapshot,
      openKitConfig: {
        ...snapshot.openKitConfig,
        knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
      },
    },
  });
  let calls = 0;
  const createResponses = vi.fn(
    async (
      _provider: unknown,
      request: Parameters<LLMGatewayProviderDispatcher['createResponses']>[1],
      context: Parameters<LLMGatewayProviderDispatcher['createResponses']>[2]
    ) => {
      expect(request.model).toBe('server-model');
      context?.onUsage?.({ input_tokens: 9, output_tokens: 3, total_tokens: 12 });
      const step = ++calls;
      const name =
        step === 1
          ? 'knowledge.notebook-workspace.update'
          : step === 2
            ? 'knowledge.notebook.update'
            : 'knowledge.result';
      const args =
        step === 1
          ? { script: "printf '\\nThe Server fact is BLUE-HERON-7.\\n' >> index.md" }
          : { summary: 'Integrated the explicit Server fact.' };
      return {
        id: `response-${step}`,
        object: 'response' as const,
        output: [
          {
            type: 'function_call' as const,
            name: operationToolName(name),
            call_id: `call-${step}`,
            arguments: JSON.stringify(args),
          },
        ],
      };
    }
  );
  const role = {
    store,
    runtimeConfig: () => runtimeConfigManager.current(),
    dispatcher: { createResponses } as unknown as LLMGatewayProviderDispatcher,
    resolveGatewayProvider: () => ({
      id: 'fixture',
      kind: 'custom',
      displayName: 'Fake transport',
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'public-test-key',
      models: ['server-model', 'ordinary-model'],
    }),
  };
  const dependencies: ServerKnowledgeMaintenanceDependencies = {
    store,
    coreDb,
    runtimeConfigManager,
    inflightCommands: new WeakMap(),
    pin: (input) => {
      pinKnowledgeManagerExecution(role, input);
    },
    run: (input) => runServerKnowledgeManagerAgent(role, input),
  };
  const input = {
    requestId: randomUUID(),
    requestActor: { kind: 'local' as const, userId },
    actor: { kind: 'user' as const, id: userId },
    trigger: 'request' as const,
    instructions: 'Integrate this explicit Server fact and keep the overview current.',
    sources: [],
    tellContent: 'The Server fact is BLUE-HERON-7.',
    signal: new AbortController().signal,
  };
  const result = await runServerKnowledgeMaintenanceCommand(dependencies, input);
  expect(result.outcome).toBe('published');
  expect(createResponses).toHaveBeenCalledTimes(3);
  expect(await runServerKnowledgeMaintenanceCommand(dependencies, input)).toEqual(result);
  expect(createResponses).toHaveBeenCalledTimes(3);
  const turn = store.getServerTurnById(result.turnId);
  expect(turn).toMatchObject({
    owner: { kind: 'server' },
    status: 'completed',
    internalExecution: {
      logicalModelId: 'server-maintenance',
      contextStrategy: 'compaction',
      threshold: 32_000,
      knowledge: { ownerScope: { kind: 'server' }, trigger: 'request', sourceRange: [] },
    },
  });
  expect(turn).not.toHaveProperty('workspaceId');
  expect(store.listWorkspaces()).toEqual([]);
  const ledger = listServerCapabilityCalls(coreDb).filter((call) => call.turnId === turn.id);
  expect(ledger).toHaveLength(3);
  expect(
    ledger.every(
      (call) =>
        call.owner.kind === 'server' &&
        call.agentId === 'knowledge-manager' &&
        call.operation === 'knowledge.run' &&
        call.status === 'succeeded'
    )
  ).toBe(true);
  expect(
    listServerUsageRecords(coreDb).filter((usage) => usage.turnId === turn.id)
  ).not.toHaveLength(0);
  expect(readWorkObservations(coreDb, { threadId: turn.threadId, turnId: turn.id })).toContainEqual(
    expect.objectContaining({
      type: 'env.bound',
      payload: expect.objectContaining({ owner: { kind: 'server' } }),
    })
  );
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'server', 'knowledge', 'notebook.git'),
  });
  expect(notebook.readRevision(result.notebookRevision).files['index.md']).toContain(
    'BLUE-HERON-7'
  );
  const next = store.createServerTurn(turn.threadId, 'Interrupted future run', input.actor, null, {
    agentId: 'knowledge-manager',
  });
  const reopened = new FsStore({ dataRoot });
  recoverServerKnowledgeManagerTurns(reopened);
  expect(reopened.getServerTurnById(next.id)).toMatchObject({
    status: 'failed',
    error: { code: 'recovery_required' },
  });
  expect(createResponses).toHaveBeenCalledTimes(3);
}, 60_000);
