import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserConfigSchema, WorkspaceConfigSchema } from '@openkit/config-schema';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { listServerCapabilityCalls } from '../capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import {
  type KnowledgeManagerAgentRun,
  pinKnowledgeManagerExecution,
  runKnowledgeManagerAgent,
  runServerKnowledgeManagerAgent,
  type ServerKnowledgeManagerAgentRun,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
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
async function fixture(scope: Scope, deadlineMs = 300_000) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-editor-deadline-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Editor deadline', {
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
    await shutdownControlStoreWorkerClient();
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
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    openKitConfig: { knowledgeMaintenance: settings },
    userConfigs: [
      {
        userId,
        path: join(dataRoot, 'user.jsonc'),
        config: UserConfigSchema.parse({ schemaVersion: 1, knowledgeMaintenance: settings }),
      },
    ],
    workspaceConfigs: [
      {
        workspaceId: workspace.id,
        path: join(dataRoot, 'workspace.jsonc'),
        config: WorkspaceConfigSchema.parse({
          schemaVersion: 1,
          workspace: { name: workspace.name, knowledgeMaintenance: settings },
        }),
      },
    ],
    providerRegistry: new ProviderRegistry([
      {
        id: 'fixture',
        kind: 'custom',
        displayName: 'Unused transport',
        baseUrl: 'https://provider.invalid/v1',
        models: ['fixture-model'],
        modelMetadata: {
          'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
        },
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
          id: 'admitted-editor-budget',
          roleId: 'knowledge-manager',
          preferredLogicalModelId: 'km-model',
          compatibleLogicalModelIds: [],
          requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs },
        },
      ],
    },
  });
  const runtimeConfigManager: RuntimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: snapshot,
  });
  const updateTurn = async (
    input: Pick<MaintenanceRun, 'turn'>,
    patch: Parameters<FsStore['updateTurn']>[1]
  ) =>
    input.turn.owner.kind === 'server'
      ? await store.updateServerTurn(input.turn.id, patch)
      : await store.updateTurn(input.turn.id, patch);
  const dependencies = {
    store,
    coreDb,
    userDb,
    runtimeConfigManager,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    openWorkspace: (id: string) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    pin: async (input: Pick<MaintenanceRun, 'turn' | 'inputs'>) => {
      await pinKnowledgeManagerExecution(
        {
          store,
          runtimeConfig: () => snapshot,
          dispatcher: {
            createResponses: async () => {
              throw new Error('Only the model wait is replaced.');
            },
          },
          resolveGatewayProvider: () => {
            throw new Error('No Provider call is needed.');
          },
        },
        input
      );
    },
    run: async (_input: MaintenanceRun) => ({ turnId: '', text: '' }),
  };
  const caller = new AbortController();
  const input = {
    workspaceId: workspace.id,
    requestId: randomUUID(),
    requestActor,
    actor,
    trigger: 'request' as const,
    instructions: 'Inspect the current overview and report whether it needs changes.',
    sources: [],
    signal: caller.signal,
  };
  const maintain = async () =>
    scope === 'workspace'
      ? maintainKnowledgeAgent(dependencies satisfies KnowledgeMaintenanceDependencies, input)
      : scope === 'server'
        ? (
            await prepareServerKnowledgeMaintenance(
              dependencies satisfies ServerKnowledgeMaintenanceDependencies,
              input
            )
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
    caller,
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
    { deadlineMs: 300_000, elapsed: 0 },
    { deadlineMs: 300_000, elapsed: 150_000 },
    { deadlineMs: 600_000, elapsed: 301_000 },
  ])('accepts a real editor Tool after $elapsed ms within its pinned $deadlineMs ms run', async ({
    deadlineMs,
    elapsed,
  }) => {
    const f = await fixture(scope, deadlineMs);
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
      await f.updateTurn(input, { status: 'completed', completedAt: new Date().toISOString() });
      return { turnId: input.turn.id, text: '{"summary":"No changes are needed."}' };
    });
    f.dependencies.run = run;
    // Date alone controls the editor's absolute deadline; Git and editor I/O stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const result = await f.maintain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.readTurn(result.turnId).internalExecution?.limits?.deadlineMs).toBe(deadlineMs);
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
  it('stops the editor on caller cancellation before the pinned run deadline', async () => {
    const f = await fixture(scope, 600_000);
    let editorObservation: 'returned' | 'threw' | undefined;
    const run = vi.fn(async (input: MaintenanceRun) => {
      vi.setSystemTime(Date.now() + 150_000);
      f.caller.abort(new DOMException('Caller stopped waiting.', 'AbortError'));
      try {
        await input.tools
          .find((tool) => tool.name === 'knowledge.notebook-workspace.update')!
          .execute(
            { script: 'printf "Must not write after admission ends." > index.md' },
            { callId: randomUUID(), toolOccurrence: 1, signal: input.signal }
          );
        editorObservation = 'returned';
      } catch {
        editorObservation = 'threw';
      }
      return { turnId: input.turn.id, text: 'The editor must refuse this attempt.' };
    });
    f.dependencies.run = run;
    vi.useFakeTimers({ toFake: ['Date'] });
    const result = await f.maintain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.readTurn(result.turnId).internalExecution?.limits?.deadlineMs).toBe(600_000);
    expect(editorObservation).toBe('threw');
    expect(result.outcome).toBe('failed');
    expect(f.caller.signal.aborted).toBe(true);
    expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
    expect(f.notebook.readRevision(f.baseRevision).files['index.md']).toBe(f.overview);
  });
});

it.each([
  'workspace',
  'user',
] as const)('returns the owned timeout code in %s maintenance without publication or retry', async (scope) => {
  const f = await fixture(scope);
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: f.dataRoot,
    userConfigs: [
      {
        userId: f.dependencies.userDb.userId,
        path: join(f.dataRoot, 'user.jsonc'),
        config: UserConfigSchema.parse({
          schemaVersion: 1,
          knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
        }),
      },
    ],
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
  f.dependencies.pin = async (input) => {
    if (input.turn.owner.kind === 'server') throw new Error('Expected a Workspace run.');
    await pinKnowledgeManagerExecution(roleDependencies, input);
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
  // Observe rejection while the clock advances; awaiting the original below still fails the test.
  void pending.catch(() => {});
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

it('returns the owned timeout code in the Server maintenance summary without publication or retry', async () => {
  const f = await fixture('server');
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: f.dataRoot,
    openKitConfig: { knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] } },
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
  });
  const dispatched = Promise.withResolvers<void>();
  const response =
    Promise.withResolvers<Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>>();
  let providerSignal: AbortSignal | undefined;
  let callerSignal: AbortSignal | undefined;
  const createResponses = vi.fn<LLMGatewayProviderDispatcher['createResponses']>(
    async (_provider, _request, context) => {
      const signal = context?.transport?.signal;
      if (!signal) throw new Error('Provider transport has no cancellation signal.');
      providerSignal = signal;
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
  f.dependencies.pin = async (input) => {
    if (input.turn.owner.kind !== 'server') throw new Error('Expected a Server run.');
    await pinKnowledgeManagerExecution(roleDependencies, input);
  };
  f.dependencies.run = (input) => {
    if (!('kind' in input)) throw new Error('Expected a Server run.');
    callerSignal = input.signal;
    return runServerKnowledgeManagerAgent(roleDependencies, input);
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
  expect(providerSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(90_000);
  const result = await pending;
  const settledTurn = f.readTurn(result.turnId);
  const settledCalls = listServerCapabilityCalls(f.dependencies.coreDb);
  expect(result.outcome).toBe('failed');
  expect.soft(result.summary).toContain('knowledge_manager_timeout');
  expect(settledTurn).toMatchObject({
    owner: { kind: 'server' },
    status: 'failed',
    error: { code: 'knowledge_manager_timeout' },
    internalExecution: { limits: { deadlineMs: 90_000 } },
  });
  expect('workspaceId' in settledTurn).toBe(false);
  expect(
    settledTurn.items
      .filter((item) => item.type === 'status' && item.knowledgeMaintenanceResult)
      .map((item) => item.knowledgeMaintenanceResult)
  ).toEqual([result]);
  expect(callerSignal?.aborted).toBe(false);
  expect(providerSignal?.aborted).toBe(true);
  expect(settledCalls).toEqual([
    expect.objectContaining({
      status: 'timed-out',
      turnId: result.turnId,
    }),
  ]);
  response.resolve({ id: 'late-response', object: 'response', output: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(createResponses).toHaveBeenCalledTimes(1);
  expect(f.readTurn(result.turnId)).toEqual(settledTurn);
  expect(listServerCapabilityCalls(f.dependencies.coreDb)).toEqual(settledCalls);
  expect(f.notebook.publishedRevision()).toBe(f.baseRevision);
  expect(f.notebook.readRevision(f.baseRevision).files['index.md']).toBe(f.overview);
});
