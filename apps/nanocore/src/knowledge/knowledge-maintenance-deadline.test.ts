import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import {
  type KnowledgeManagerAgentRun,
  pinKnowledgeManagerExecution,
  runKnowledgeManagerAgent,
  type ServerKnowledgeManagerAgentRun,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  type KnowledgeMaintenanceDependencies,
  maintainKnowledgeAgent,
} from './knowledge-agent-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';
import { initializeScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import {
  prepareServerKnowledgeMaintenance,
  type ServerKnowledgeMaintenanceDependencies,
} from './server-knowledge-maintenance.js';
import {
  maintainUserMemoryAgent,
  type UserMemoryMaintenanceDependencies,
} from './user-memory-agent-maintenance.js';

type Scope = 'workspace' | 'server' | 'user';
type MaintenanceRun = KnowledgeManagerAgentRun | ServerKnowledgeManagerAgentRun;
type ToolResult = Awaited<ReturnType<AgentTool['execute']>>;

/** Real native scope admission, notebook and editor surround only the replaceable model wait. */
function fixture(scope: Scope) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-editor-deadline-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Editor deadline', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'test:maintenance-editor-deadline',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  onTestFinished(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await closeRetrievalServices();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const repositoryPath =
    scope === 'workspace'
      ? join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git')
      : (() => {
          const context = { coreDb, actor: requestActor, target: { kind: scope } };
          const initialization = {
            coreDb,
            actor: requestActor,
            initialization: { requestId: randomUUID(), instructionReference: 'test:deadline' },
          };
          initializeScopedNotebook(
            scope === 'user'
              ? { ...initialization, target: { kind: 'user' }, userDb }
              : { ...initialization, target: { kind: 'server' } }
          );
          return join(resolveScopedNotebookOwner(context).notebookRoot, 'notebook.git');
        })();
  const notebook = new KnowledgeNotebook({ repositoryPath });
  const baseRevision = notebook.publishedRevision();
  const overview = notebook.readRevision(baseRevision).files['index.md']!;
  const settings = { enabled: true, reviewRequiredPageIds: [] };
  const runtimeConfigManager = {
    current: () => ({
      openKitConfig: { knowledgeMaintenance: settings },
      userConfigs: [{ userId, config: { knowledgeMaintenance: settings } }],
      workspaceConfigs: [
        { workspaceId: workspace.id, config: { workspace: { knowledgeMaintenance: settings } } },
      ],
    }),
  } as unknown as RuntimeConfigManager;
  const updateTurn = (
    input: Pick<MaintenanceRun, 'turn'>,
    patch: Parameters<FsStore['updateTurn']>[1]
  ) =>
    'owner' in input.turn
      ? store.updateServerTurn(input.turn.id, patch)
      : store.updateTurn(input.turn.id, patch);
  const dependencies = {
    store,
    coreDb,
    userDb,
    runtimeConfigManager,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    openWorkspace: (id: string) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    pin: (input: Pick<MaintenanceRun, 'turn' | 'inputs'>) => {
      updateTurn(input, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'fixture-model',
          contextStrategy: 'compaction',
          threshold: 1000,
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
          knowledge: input.inputs!,
        },
      });
    },
    run: async (_input: MaintenanceRun) => ({ turnId: '', text: '' }),
  };
  const input = {
    workspaceId: workspace.id,
    requestId: randomUUID(),
    requestActor,
    actor,
    trigger: 'request' as const,
    instructions: 'Inspect the current overview and report whether it needs changes.',
    sources: [],
    signal: new AbortController().signal,
  };
  const maintain = () =>
    scope === 'workspace'
      ? maintainKnowledgeAgent(dependencies satisfies KnowledgeMaintenanceDependencies, input)
      : scope === 'server'
        ? prepareServerKnowledgeMaintenance(
            dependencies satisfies ServerKnowledgeMaintenanceDependencies,
            input
          ).execute()
        : maintainUserMemoryAgent(dependencies satisfies UserMemoryMaintenanceDependencies, input);
  const readTurn = (turnId: string) =>
    scope === 'server' ? store.getServerTurnById(turnId) : store.getTurnById(turnId);
  return {
    dataRoot,
    store,
    workspace,
    dependencies,
    notebook,
    baseRevision,
    overview,
    updateTurn,
    maintain,
    readTurn,
  };
}

/** Reads native Tool text without substituting the editor's observable result. */
function toolValue(result: ToolResult) {
  return JSON.parse(
    result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  );
}

describe.each(['workspace', 'server', 'user'] as const)('%s notebook editor deadline', (scope) => {
  it.each([
    0, 150_000,
  ])('accepts a real editor Tool after %i ms within its admitted run', async (elapsed) => {
    const f = fixture(scope);
    let editorObservation:
      | { kind: 'returned'; result: ToolResult }
      | { kind: 'threw'; error: unknown }
      | undefined;
    const run = vi.fn(async (input: MaintenanceRun) => {
      vi.setSystemTime(Date.now() + elapsed);
      const execute = (name: string, value: unknown) =>
        input.tools
          .find((tool) => tool.name === name)!
          .execute(value, { callId: randomUUID(), toolOccurrence: 1, signal: input.signal });
      try {
        editorObservation = {
          kind: 'returned',
          result: await execute('knowledge.notebook-workspace.update', { script: 'cat index.md' }),
        };
      } catch (error) {
        editorObservation = { kind: 'threw', error };
        throw error;
      }
      await execute('knowledge.notebook.update', {
        summary: 'The current overview is sufficient.',
      });
      expect(input.validateResult('{"summary":"No changes are needed."}')).toBeUndefined();
      f.updateTurn(input, { status: 'completed', completedAt: new Date().toISOString() });
      return { turnId: input.turn.id, text: '{"summary":"No changes are needed."}' };
    });
    f.dependencies.run = run;
    // Date alone controls the editor's absolute deadline; Git and editor I/O stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const result = await f.maintain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(editorObservation).toMatchObject({ kind: 'returned' });
    if (editorObservation?.kind !== 'returned') throw new Error('Editor did not return.');
    expect(editorObservation.result.isError).not.toBe(true);
    expect(toolValue(editorObservation.result)).toEqual({
      exitCode: 0,
      stdout: f.overview,
      stderr: '',
      truncated: false,
    });
    expect(result.outcome).toBe('no-change');
    expect(f.readTurn(result.turnId).status).toBe('completed');
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    expect(f.notebook.readRevision(f.baseRevision).files['index.md']).toBe(f.overview);
    expect(
      f
        .readTurn(result.turnId)
        .items.filter((item) => item.type === 'status' && item.knowledgeMaintenanceResult)
        .map((item) => item.knowledgeMaintenanceResult)
    ).toEqual([result]);
  });
});

it('returns the owned timeout code in the maintenance summary and retained Turn without publication', async () => {
  const f = fixture('workspace');
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: f.dataRoot,
    providerRegistry: new ProviderRegistry([
      {
        id: 'fixture',
        kind: 'custom',
        displayName: 'Deferred transport',
        baseUrl: 'https://provider.invalid/v1',
        models: ['fixture-model'],
        modelMetadata: { 'fixture-model': metadata },
      },
    ]),
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
    internalRoleProfiles: {
      schemaVersion: 1,
      profiles: [
        {
          id: 'explicit-cutoff',
          roleId: 'knowledge-manager',
          preferredLogicalModelId: 'km-model',
          compatibleLogicalModelIds: [],
          requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
          limits: { maxModelTurns: 8, maxToolCalls: 24, deadlineMs: 90_000 },
        },
      ],
    },
    workspaceConfigs: [
      {
        workspaceId: f.workspace.id,
        path: join(f.dataRoot, 'workspace.jsonc'),
        config: WorkspaceConfigSchema.parse({
          schemaVersion: 1,
          workspace: {
            name: f.workspace.name,
            knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
          },
        }),
      },
    ],
  });
  const dispatched = Promise.withResolvers<void>();
  const response =
    Promise.withResolvers<Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>>();
  const createResponses = vi.fn<LLMGatewayProviderDispatcher['createResponses']>(
    async (_provider, _request, context) => {
      const signal = context?.transport?.signal;
      if (!signal) throw new Error('Provider transport has no cancellation signal.');
      dispatched.resolve();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        return await Promise.race([response.promise, cancelled]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
  );
  const roleDependencies = {
    store: f.store,
    runtimeConfig: () => snapshot,
    dispatcher: { createResponses },
    resolveGatewayProvider: () => ({
      id: 'fixture',
      displayName: 'Deferred transport',
      adapterId: 'fixture',
      apiKey: '',
      baseUrl: null,
      models: ['fixture-model'],
      requiresApiKey: false,
      gatewayCapabilities: { responses: 'native' as const, chatCompletions: 'native' as const },
      modelMetadata: { 'fixture-model': metadata },
    }),
  };
  f.dependencies.runtimeConfigManager = {
    current: () => snapshot,
  } as unknown as RuntimeConfigManager;
  f.dependencies.pin = (input) => {
    if ('owner' in input.turn) throw new Error('Expected a Workspace run.');
    pinKnowledgeManagerExecution(roleDependencies, input);
  };
  f.dependencies.run = (input) => {
    if ('kind' in input) throw new Error('Expected a Workspace run.');
    return runKnowledgeManagerAgent(roleDependencies, input);
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Deadline elapsed.', 'TimeoutError')),
      milliseconds
    ).unref();
    return controller.signal;
  });
  const pending = f.maintain();
  await dispatched.promise;
  await vi.advanceTimersByTimeAsync(90_000);
  const result = await pending;
  response.resolve({ id: 'late-response', object: 'response', output: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(result.outcome).toBe('failed');
  expect.soft(result.summary).toContain('knowledge_manager_timeout');
  expect.soft(f.readTurn(result.turnId)).toMatchObject({
    status: 'failed',
    error: { code: 'knowledge_manager_timeout' },
    internalExecution: { limits: { deadlineMs: 90_000 } },
  });
  expect(createResponses).toHaveBeenCalledTimes(1);
  expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
});
