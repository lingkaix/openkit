import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { openAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import { FsStore } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { KnowledgeRetrievalAccess } from '../retrieval-knowledge-adapter.js';
import {
  admitKnowledgeRetrieval,
  readAuthorizedServerNotebookPages,
} from '../retrieval-knowledge-adapter.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { dispatchOpenkitWorkTool } from '../runtime/openkit-work-mcp.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readTurnRetrievalTraces } from '../storage/retrieval-traces.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { askKnowledgeAgent, type KnowledgeAgentDependencies } from './knowledge-agent.js';
import { saveMemoryPage } from './memory-lifecycle.js';
import { appendMemorySuppression } from './memory-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';
import { publishWorkspaceNotebookEntry } from './notebook-entry-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import {
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './scoped-knowledge-sources.js';
import { initializeScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import { publishScopedNotebook } from './scoped-notebook-publication.js';

type TransportRequest = Parameters<LLMGatewayProviderDispatcher['createResponses']>[1];
type Transport = Parameters<LLMGatewayProviderDispatcher['createResponses']>[2];
type ProviderResponse = Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>;

/** Only the external Responses transport is replaced; Core, publication and the retrieval Kernel are real. */
async function fixture(withServerKnowledge = false, emptyOverview = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-query-proof-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Knowledge query proof');
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const actor = { kind: 'user' as const, id: userId };
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const sourceThread = store.createThread(
    workspace.id,
    'Private source',
    undefined,
    'conversation',
    {
      visibility: 'workspace',
    }
  );
  const captured = 'The heliotrope launch uses the cobalt gate. No launch date is documented.';
  const now = new Date().toISOString();
  const source = store.createKnowledgeSource(
    {
      id: allocateEntityId('ks'),
      workspaceId: workspace.id,
      kind: 'document',
      title: 'Launch evidence',
      uri: null,
      contentDigest: `sha256:${createHash('sha256').update(captured).digest('hex')}`,
      originatingThreadId: sourceThread.id,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    captured
  );
  const sourceReference = `source:${source.id}@${source.contentDigest}`;
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  const publicationConfig = createInMemoryRuntimeConfigSnapshot({ dataRoot });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  await publishWorkspaceNotebookEntry(
    {
      store,
      workspaceDb,
      notebook,
      producer: actor,
      inflightCommands: new WeakMap(),
      revalidate: (request) =>
        readWorkspaceNotebookAdmission({
          store,
          coreDb,
          workspaceDb,
          notebook,
          request,
          requestActor: { kind: 'local', userId },
          actor,
          runtimeConfigManager: { current: () => publicationConfig },
          workspaceMutationAdmission,
        }),
    },
    {
      operation: 'knowledge.create',
      requestId: randomUUID(),
      workspaceId: workspace.id,
      knowledgePageId: 'launch-evidence',
      baseRevision: notebook.publishedRevision(),
      kind: 'project-context',
      title: 'Heliotrope launch',
      content: captured,
      sourceReferences: [sourceReference],
    }
  );
  // A valid shared publication does not retain disclosure authority after its Source becomes private.
  Object.assign(sourceThread, { visibility: 'private', privateOwnerUserId: userId });
  if (emptyOverview) {
    const baseRevision = notebook.publishedRevision();
    const candidateRevision = notebook.prepare({
      baseRevision,
      changes: { 'index.md': '---\nokf_version: "0.2"\n---\n# Notebook\n' },
      metadata: {
        summary: 'Retain an empty overview beside the human fact',
        changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${'a'.repeat(64)}` },
        producer: actor,
        authority: { kind: 'direct', instructionReference: 'fixture:empty-overview' },
        sourceReferences: [],
      },
    });
    notebook.publish({ baseRevision, candidateRevision });
  }
  const revision = notebook.publishedRevision();
  const workspaceFiles = notebook.readRevision(revision, ['launch-evidence.md', 'index.md']).files;
  const page = workspaceFiles['launch-evidence.md']!;
  const overviewDigest = `sha256:${createHash('sha256').update(workspaceFiles['index.md']!).digest('hex')}`;
  const contentDigest = `sha256:${createHash('sha256').update(page).digest('hex')}`;
  let server:
    | { revision: string; contentDigest: string; overviewDigest: string; repositoryPath: string }
    | undefined;
  const serverActor = { kind: 'local' as const, userId };
  if (withServerKnowledge) {
    const context = { coreDb, actor: serverActor, target: { kind: 'server' as const } };
    const initial = initializeScopedNotebook({
      ...context,
      initialization: {
        requestId: randomUUID(),
        instructionReference: 'fixture:shared-server-knowledge',
      },
    });
    const repositoryPath = join(resolveScopedNotebookOwner(context).notebookRoot, 'notebook.git');
    const serverNotebook = new KnowledgeNotebook({ repositoryPath });
    const timestamp = new Date().toISOString();
    const content = serializeUserAuthoredKnowledgePage(
      {
        id: 'launch-evidence',
        kind: 'project-context',
        title: 'Heliotrope launch policy',
        content: 'The heliotrope launch requires cobalt approval from the Server owner.',
        sourceReferences: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'server' }
    );
    const publication = await publishScopedNotebook(
      {
        ...context,
        store,
        runtimeConfigManager: createRuntimeConfigManager({
          dataRoot,
          initialSnapshot: publicationConfig,
        }),
        inflightCommands: new WeakMap(),
      },
      {
        requestId: randomUUID(),
        baseRevision: initial,
        changes: [
          { path: 'launch-evidence.md', content },
          {
            path: 'index.md',
            content:
              '---\nokf_version: "0.2"\n---\n# Launch policies\n[Launch evidence](launch-evidence.md)\n',
          },
        ],
        summary: 'Record shared launch policy',
      }
    );
    const serverFiles = serverNotebook.readRevision(publication.notebookRevision, [
      'launch-evidence.md',
      'index.md',
    ]).files;
    const exact = serverFiles['launch-evidence.md']!;
    server = {
      revision: publication.notebookRevision,
      contentDigest: `sha256:${createHash('sha256').update(exact).digest('hex')}`,
      overviewDigest: `sha256:${createHash('sha256').update(serverFiles['index.md']!).digest('hex')}`,
      repositoryPath,
    };
  }
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      displayName: 'Fake transport',
      kind: 'custom',
      baseUrl: 'https://provider.invalid/v1',
      models: ['default-model', 'knowledge-model'],
      modelMetadata: { 'default-model': metadata, 'knowledge-model': metadata },
    },
  ]);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    providerRegistry,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'ordinary',
      logicalModels: ['ordinary', 'knowledge'].map((id) => ({
        id,
        displayName: id,
        contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
        routes: [
          {
            id: 'route',
            providerProfileId: 'fixture',
            providerModel: id === 'knowledge' ? 'knowledge-model' : 'default-model',
          },
        ],
      })),
    },
    internalRoleProfiles: {
      schemaVersion: 1,
      profiles: [
        {
          id: 'workspace-knowledge',
          roleId: 'knowledge-manager',
          preferredLogicalModelId: 'knowledge',
          compatibleLogicalModelIds: [],
          requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
          limits: { maxModelTurns: 8, maxToolCalls: 24, deadlineMs: 120_000 },
        },
      ],
    },
    workspaceConfigs: [
      {
        workspaceId: workspace.id,
        path: join(dataRoot, 'workspace.yaml'),
        config: WorkspaceConfigSchema.parse({
          schemaVersion: 1,
          workspace: {
            name: workspace.name,
            internalRoles: [{ roleId: 'knowledge-manager', profileId: 'workspace-knowledge' }],
          },
        }),
      },
    ],
  });
  const createResponses = vi.fn(
    async (
      _provider: unknown,
      _request: TransportRequest,
      _context: Transport
    ): Promise<ProviderResponse> => message('unused')
  );
  const dependencies: KnowledgeAgentDependencies = {
    store,
    runtimeConfig: () => snapshot,
    dispatcher: { createResponses },
    resolveGatewayProvider: (_id, model) => ({
      id: 'fixture',
      displayName: 'Fake transport',
      adapterId: 'fixture',
      models: [model],
      baseUrl: null,
      apiKey: '',
      requiresApiKey: false,
      gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
      modelMetadata: { [model]: metadata },
    }),
    openWorkspace: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
  };
  const thread = store.createThread(
    workspace.id,
    'Asking conversation',
    undefined,
    'conversation',
    {
      visibility: 'private',
      privateOwnerUserId: userId,
    }
  );
  const turn = store.createTurn(workspace.id, thread.id, 'Which launch gate and date?', actor);
  const askingCall = startCapabilityCall({
    workspaceDb,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    authorityActor: actor,
    family: 'knowledge',
    operation: 'knowledge.ask',
    capabilityId: 'knowledge.ask',
    providerRef: null,
    redactionClass: 'metadata-only',
  });
  const access: KnowledgeRetrievalAccess = {
    store,
    coreDb,
    actor,
    outputThreadId: thread.id,
    outputTurnId: turn.id,
    ...(withServerKnowledge ? { serverKnowledgeActor: serverActor } : {}),
  };
  const ask = () =>
    askKnowledgeAgent(dependencies, {
      workspaceId: workspace.id,
      question: 'Which launch gate and date?',
      caller: 'internal-agent',
      access,
      capabilityCallId: askingCall.id,
      signal: new AbortController().signal,
    });
  return {
    dataRoot,
    workspaceScope: `page/workspace/${workspace.id}/${readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'workspace', workspaceId: workspace.id } })}`,
    serverScope: withServerKnowledge
      ? `page/server/${readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'server' } })}`
      : undefined,
    store,
    coreDb,
    workspaceDb,
    workspace,
    userId,
    actor,
    thread,
    turn,
    askingCall,
    access,
    revision,
    contentDigest,
    overviewDigest,
    page,
    sourceReference,
    sourceId: source.id,
    server,
    sourceThread,
    createResponses,
    dependencies,
    ask,
  };
}

/** Emits a Provider Tool request without implementing or intercepting the actual Tool. */
function call(name: string, args: Record<string, unknown>, callId = `call-${name}`) {
  return {
    id: randomUUID(),
    object: 'response' as const,
    output: [
      {
        type: 'function_call' as const,
        call_id: callId,
        name: operationToolName(name),
        arguments: JSON.stringify(args),
      },
    ],
  };
}

/** Emits the strict Knowledge Agent answer contract through the real response projection. */
function message(
  answer: string,
  citationIds: string[] = [],
  uncertainty: string | null = 'No launch date is documented.'
) {
  return call('knowledge.result', { answer, citationIds, uncertainty }, randomUUID());
}

/** Reads the Provider-visible result of a real Tool, rather than inferring execution from Tool declarations. */
function toolOutput(request: TransportRequest, name: string, callId = `call-${name}`): string {
  const outputs = request.input as Array<{ type?: string; call_id?: string; output?: string }>;
  const result = outputs.find(
    (item) => item.type === 'function_call_output' && item.call_id === callId
  );
  expect(result, `Missing actual ${name} result`).toBeDefined();
  return result!.output!;
}

// Two real Git notebooks, Kernel selections and exact Source revalidation use the same allowance as bounded maintenance integration.
it('keeps real Workspace and Server selections distinct while reading exact pages and Source bytes with isolated work usage', async () => {
  const f = await fixture(true);
  const workspacePageId = `openkit:${f.workspaceScope}/launch-evidence`;
  const serverPageId = `openkit:${f.serverScope}/launch-evidence`;
  let step = 0;
  f.createResponses.mockImplementation(async (_provider, _request, context) => {
    context?.onUsage?.({ input_tokens: 9, output_tokens: 3, total_tokens: 12 });
    if (++step === 1) {
      return call('knowledge.retrieval', { query: 'heliotrope cobalt', limit: 5 });
    }
    if (step === 2) {
      return call('knowledge.page.read', { pageId: workspacePageId });
    }
    if (step === 3)
      return call('knowledge.source.read', { pageId: workspacePageId, sourceId: f.sourceId });
    if (step === 4) return call('knowledge.page.read', { pageId: serverPageId }, 'server-page');
    return message('Use the cobalt gate and obtain Server approval.', [
      workspacePageId,
      serverPageId,
    ]);
  });
  const answer = await f.ask();
  expect(f.createResponses).toHaveBeenCalledTimes(5);
  expect(
    f.createResponses.mock.calls.every(([, request]) => request.model === 'knowledge-model')
  ).toBe(true);
  expect(
    (f.createResponses.mock.calls[0]![1].tools as Array<{ name: string }>).map((tool) => tool.name)
  ).toEqual(
    expect.arrayContaining(['knowledge_retrieval', 'knowledge_page_read', 'knowledge_source_read'])
  );
  const initialMessages = f.createResponses.mock.calls[0]![1].input as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  const initial = JSON.parse(
    initialMessages.find((item) => item.role === 'user')!.content![0]!.text!
  );
  expect(initial.unavailableSources).toEqual([]);
  expect(initial.overviews).toMatchObject([
    {
      source: 'workspace',
      pageId: `openkit:${f.workspaceScope}/index`,
      notebookRevision: f.revision,
      contentDigest: f.overviewDigest,
      readTool: 'knowledge.page.read',
      truncated: false,
      nextOffset: null,
    },
    {
      source: 'server',
      pageId: `openkit:${f.serverScope}/index`,
      notebookRevision: f.server!.revision,
      contentDigest: f.server!.overviewDigest,
      readTool: 'knowledge.page.read',
      truncated: false,
      nextOffset: null,
    },
  ]);
  for (const overview of initial.overviews) {
    expect(overview.contentDigest).toBe(
      `sha256:${createHash('sha256').update(overview.content).digest('hex')}`
    );
    expect(overview.deliveredDigest).toBe(overview.contentDigest);
  }
  const search = JSON.parse(toolOutput(f.createResponses.mock.calls[1]![1], 'knowledge.retrieval'));
  expect(search.unavailableSources).toEqual([]);
  expect(search.sources).toMatchObject([
    {
      source: 'workspace',
      sourceScope: f.workspaceScope,
      notebookRevision: f.revision,
      selected: [
        {
          pageId: workspacePageId,
          reference: { objectId: 'launch-evidence' },
          contentDigest: f.contentDigest,
        },
      ],
    },
    {
      source: 'server',
      sourceScope: f.serverScope,
      notebookRevision: f.server!.revision,
      selected: [
        {
          pageId: serverPageId,
          reference: { objectId: 'launch-evidence' },
          contentDigest: f.server!.contentDigest,
        },
      ],
    },
  ]);
  const workspacePage = JSON.parse(
    toolOutput(f.createResponses.mock.calls[2]![1], 'knowledge.page.read')
  );
  expect(workspacePage).toMatchObject({ pageId: workspacePageId, contentDigest: f.contentDigest });
  expect(workspacePage.content).toContain('heliotrope launch uses the cobalt gate');
  const source = JSON.parse(
    toolOutput(f.createResponses.mock.calls[3]![1], 'knowledge.source.read')
  );
  expect(source).toMatchObject({ pageId: workspacePageId, reference: f.sourceReference });
  expect(source.content).toContain('heliotrope launch uses the cobalt gate');
  const serverPage = JSON.parse(
    toolOutput(f.createResponses.mock.calls[4]![1], 'knowledge.page.read', 'server-page')
  );
  expect(serverPage).toMatchObject({
    pageId: serverPageId,
    contentDigest: f.server!.contentDigest,
  });
  expect(serverPage.content).toContain('requires cobalt approval from the Server owner');
  expect(answer).toMatchObject({
    answer: 'Use the cobalt gate and obtain Server approval.',
    uncertainty: 'No launch date is documented.',
    citations: [
      {
        reference: formatReferenceUri(
          { scopeId: f.workspaceScope, objectId: 'launch-evidence' },
          f.contentDigest
        ),
        revision: f.revision,
        contentDigest: f.contentDigest,
        sourceReferences: [f.sourceReference],
      },
      {
        reference: formatReferenceUri(
          { scopeId: f.serverScope!, objectId: 'launch-evidence' },
          f.server!.contentDigest
        ),
        revision: f.server!.revision,
        contentDigest: f.server!.contentDigest,
        sourceReferences: [],
      },
    ],
  });
  expect(answer.threadId).not.toBe(f.thread.id);
  expect(answer.turnId).not.toBe(f.turn.id);
  const work = f.store.getTurnById(answer.turnId);
  expect(work).toMatchObject({
    status: 'completed',
    agentId: 'knowledge-manager',
    internalExecution: {
      roleId: 'knowledge-manager',
      logicalModelId: 'knowledge',
      knowledge: {
        purpose: 'query',
        baseRevision: f.revision,
        askingThreadId: f.thread.id,
        askingTurnId: f.turn.id,
        askingCapabilityCallId: f.askingCall.id,
      },
    },
  });
  expect(work.agentSessionId).toBeUndefined();
  expect(work.items.filter((item) => item.type === 'tool-call').map((item) => item.tool)).toEqual([
    'knowledge.retrieval',
    'knowledge.page.read',
    'knowledge.source.read',
    'knowledge.page.read',
    'knowledge.result',
  ]);
  expect(f.store.getTurnById(f.turn.id).items).toEqual([]);
  const usage = listWorkspaceUsageRecords(f.workspaceDb, f.workspace.id);
  expect(usage.length).toBeGreaterThan(0);
  expect(
    usage.every(
      (record) => record.turnId === answer.turnId && record.agentId === 'knowledge-manager'
    )
  ).toBe(true);
  const modelCalls = listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id).filter(
    (call) => call.agentId === 'knowledge-manager'
  );
  expect(modelCalls).toHaveLength(5);
  expect(modelCalls.every((call) => call.turnId === answer.turnId)).toBe(true);
  const root = join(f.dataRoot, 'workspaces', f.workspace.id);
  const traces = readTurnRetrievalTraces(root, f.workspace.id, f.thread.id, f.turn.id);
  expect(traces).toHaveLength(2);
  expect(
    traces.map(({ trace }) => ('sourceScope' in trace ? trace.sourceScope : null)).sort()
  ).toEqual([f.serverScope, f.workspaceScope].sort());
  for (const { trace } of traces)
    expect(trace.queryContext).toMatchObject({
      workspaceId: f.workspace.id,
      actor: f.actor,
      threadId: f.thread.id,
      turnId: f.turn.id,
    });
  expect(readTurnRetrievalTraces(root, f.workspace.id, answer.threadId, answer.turnId)).toEqual([]);
}, 120_000);

it('binds Worker dispatch to its package Workspace and shared audience, refusing private-source reads with visible uncertainty', async () => {
  const f = await fixture();
  const thread = f.store.createThread(f.workspace.id, 'Shared Worker output');
  const turn = f.store.createTurn(f.workspace.id, thread.id, 'Ask knowledge', f.actor);
  // This fixture proves the dispatch binding after admission; it does not simulate an authenticated MCP transport or CapabilityCall delivery.
  const environmentPackage = resolveAgentEnvironmentPackage({
    coreDb: f.coreDb,
    agentSetup: createTestAgentSetup(),
    agentSessionId: allocateEntityId('as'),
    triggerActor: f.actor,
    backend: { kind: 'openshell' },
    createdAt: new Date().toISOString(),
    requestId: randomUUID(),
    turn,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  f.store.updateTurn(turn.id, {
    status: 'running',
    agentId: environmentPackage.agent.agentId,
    agentSessionId: environmentPackage.scope.agentSessionId,
  });
  let step = 0;
  f.createResponses.mockImplementation(async (_provider, request) => {
    if (++step === 1) return call('knowledge.notebook.history', {});
    if (step === 2) {
      const output = toolOutput(request, 'knowledge.notebook.history');
      const history = JSON.parse(output) as { revisions: Array<{ revision: string }> };
      expect(history.revisions.find((revision) => revision.revision === f.revision)).toEqual({
        revision: f.revision,
        parentRevision: expect.any(String),
        availability: 'unavailable',
      });
      expect(output).not.toContain('launch-evidence');
      expect(output).not.toContain(f.userId);
      expect(output).not.toContain(f.sourceReference);
      return call('knowledge.retrieval', { query: 'heliotrope cobalt', limit: 5 });
    }
    if (step === 3) {
      const search = toolOutput(request, 'knowledge.retrieval');
      expect(search).not.toContain('launch-evidence');
      expect(search).not.toContain('cobalt gate');
      return call('knowledge.page.read', {
        pageId: `openkit:${f.workspaceScope}/launch-evidence`,
      });
    }
    expect(toolOutput(request, 'knowledge.page.read')).toContain(
      'The Tool failed without a safe result.'
    );
    return message(
      'No evidence is available to this shared Task.',
      [],
      'The private source is not available to this audience.'
    );
  });
  const admitted = vi.fn();
  const knowledgeCall = startCapabilityCall({
    workspaceDb: f.workspaceDb,
    workspaceId: f.workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    authorityActor: f.actor,
    family: 'knowledge',
    operation: 'knowledge.ask',
    capabilityId: 'knowledge.ask',
    providerRef: null,
    redactionClass: 'metadata-only',
  });
  const input = {
    environmentPackage,
    coreDb: f.coreDb,
    store: f.store,
    workspaceDb: f.workspaceDb,
    requireAdmission: admitted,
    knowledgeCallId: knowledgeCall.id,
    knowledgeAgent: {
      ask: (question: Parameters<typeof askKnowledgeAgent>[1]) =>
        askKnowledgeAgent(f.dependencies, question),
      maintain: async () => {
        throw new Error('Query must not publish.');
      },
    },
  };
  await expect(
    dispatchOpenkitWorkTool(input, operationToolName('knowledge.ask'), {
      question: 'Which launch gate?',
      workspaceId: 'untrusted-workspace',
    })
  ).rejects.toThrow('Unrecognized key');
  expect(f.createResponses).not.toHaveBeenCalled();
  const result = await dispatchOpenkitWorkTool(input, operationToolName('knowledge.ask'), {
    question: 'Which launch gate?',
  });
  expect(result.isError).toBe(false);
  const answer = JSON.parse(result.content[0]!.text);
  expect(answer).toMatchObject({
    citations: [],
    uncertainty: 'The private source is not available to this audience.',
  });
  expect(admitted).toHaveBeenCalled();
  const work = f.store.getTurnById(answer.turnId);
  expect(work.internalExecution?.knowledge).toMatchObject({
    ownerScope: { kind: 'workspace', workspaceId: f.workspace.id },
    askingThreadId: thread.id,
    askingTurnId: turn.id,
    askingCapabilityCallId: knowledgeCall.id,
  });
  expect(work.items).toContainEqual(
    expect.objectContaining({
      type: 'tool-call',
      tool: 'knowledge.page.read',
      result: expect.stringContaining('The Tool failed without a safe result.'),
    })
  );
  const traces = readTurnRetrievalTraces(
    join(f.dataRoot, 'workspaces', f.workspace.id),
    f.workspace.id,
    thread.id,
    turn.id
  );
  expect(traces).toHaveLength(1);
  expect(traces[0]!.trace).toMatchObject({
    caller: 'task-mode',
    queryContext: { threadId: thread.id, turnId: turn.id },
    selected: [],
  });
});

it('refuses an overview-only answer when its Server credential is revoked during the Provider call', async () => {
  const f = await fixture(true);
  const tokenId = allocateEntityId('tok');
  createOpenKitAccessTokenRecord(f.coreDb, {
    tokenId,
    ownerUserId: f.userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  f.access.serverKnowledgeActor = {
    kind: 'token',
    userId: f.userId,
    tokenId,
    tokenScope: 'server-admin',
  };
  const selection = {
    dataRoot: f.dataRoot,
    workspaceId: f.workspace.id,
    access: f.access,
    notebookRevision: f.server!.revision,
    pageIds: ['index'],
  };
  expect(readAuthorizedServerNotebookPages(selection).pages).toHaveLength(1);
  f.createResponses.mockImplementation(async () => {
    // Revocation changes only the admitted Server credential; the asking Workspace member stays authorized.
    revokeOpenKitAccessTokenRecord(f.coreDb, tokenId);
    return message('The Server overview lists the launch policy.');
  });
  const outcome = await f.ask().then(
    (answer) => ({ answer, error: undefined }),
    (error: unknown) => ({ answer: undefined, error })
  );
  expect(f.createResponses).toHaveBeenCalledTimes(1);
  const messages = f.createResponses.mock.calls[0]![1].input as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  const initial = JSON.parse(messages.find((item) => item.role === 'user')!.content![0]!.text!);
  expect(initial.unavailableSources).toEqual([]);
  expect(initial.overviews).toContainEqual(
    expect.objectContaining({
      source: 'server',
      pageId: `openkit:${f.serverScope}/index`,
      notebookRevision: f.server!.revision,
      contentDigest: f.server!.overviewDigest,
      content: expect.stringContaining('launch-evidence'),
    })
  );
  expect(() => admitKnowledgeRetrieval(selection)).not.toThrow();
  expect(() => readAuthorizedServerNotebookPages(selection)).toThrow(
    'Server Knowledge access denied.'
  );
  expect(
    outcome.answer,
    'Revoked overview evidence must not produce a delivered answer'
  ).toBeUndefined();
  expect(outcome.error).toMatchObject({
    code: 'workspace_access_denied',
    message: 'Server Knowledge access denied.',
  });
  const work = f.store
    .listThreads(f.workspace.id)
    .flatMap((thread) => f.store.listThreadTurns(f.workspace.id, thread.id))
    .find((turn) => turn.agentId === 'knowledge-manager');
  expect(work).toMatchObject({ status: 'failed' });
  expect(work!.items.filter((item) => item.type === 'tool-call')).toEqual([]);
}, 120_000);

it('rejects an unread citation and retains a failed Knowledge Manager Turn instead of a completed answer', async () => {
  const f = await fixture();
  f.createResponses.mockResolvedValue(
    message('Invented citation.', [`openkit:${f.workspaceScope}/launch-evidence`], null)
  );
  await expect(f.ask()).rejects.toThrow(
    'Knowledge query failed. Inspect the retained Turn before a new request.'
  );
  const work = f.store
    .listThreads(f.workspace.id)
    .flatMap((thread) => f.store.listThreadTurns(f.workspace.id, thread.id))
    .find((turn) => turn.agentId === 'knowledge-manager');
  expect(work).toMatchObject({ status: 'failed' });
  expect(f.store.getTurnById(f.turn.id).status).toBe('running');
});

it('requires stated uncertainty when admitted Server Knowledge is unavailable despite a valid Workspace citation', async () => {
  const f = await fixture(true);
  renameSync(f.server!.repositoryPath, `${f.server!.repositoryPath}.unavailable`);
  const pageId = `openkit:${f.workspaceScope}/launch-evidence`;
  let step = 0;
  f.createResponses.mockImplementation(async () => {
    if (++step === 1) return call('knowledge.retrieval', { query: 'heliotrope cobalt', limit: 5 });
    if (step === 2) return call('knowledge.page.read', { pageId });
    return message('Use the cobalt gate.', [pageId], null);
  });
  await expect(f.ask()).rejects.toThrow(
    'Knowledge query failed. Inspect the retained Turn before a new request.'
  );
  expect(f.createResponses).toHaveBeenCalledTimes(4);
  const messages = f.createResponses.mock.calls[0]![1].input as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  const initial = JSON.parse(messages.find((item) => item.role === 'user')!.content![0]!.text!);
  expect(initial.unavailableSources).toEqual(['server']);
  const search = JSON.parse(toolOutput(f.createResponses.mock.calls[1]![1], 'knowledge.retrieval'));
  expect(search.unavailableSources).toEqual(['server']);
  expect(search.sources).toMatchObject([{ source: 'workspace' }]);
  const read = JSON.parse(toolOutput(f.createResponses.mock.calls[2]![1], 'knowledge.page.read'));
  expect(read).toMatchObject({ pageId, contentDigest: f.contentDigest });
  expect(read.content).toContain('heliotrope launch uses the cobalt gate');
}, 120_000);

it('repairs a markdown answer once through the schema-validated result Tool', async () => {
  const f = await fixture();
  f.createResponses
    .mockResolvedValueOnce({
      id: 'markdown',
      object: 'response',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '**Answer:** No evidence.' }] },
      ],
    })
    .mockResolvedValueOnce(call('knowledge.retrieval', { query: 'missing evidence' }))
    .mockResolvedValueOnce(
      call(
        'knowledge.result',
        {
          answer: 'No evidence.',
          citationIds: [],
          uncertainty: 'No page was read.',
        },
        'answer-result'
      )
    );
  const answer = await f.ask();
  expect(answer).toMatchObject({
    answer: 'No evidence.',
    citations: [],
    uncertainty: 'No page was read.',
  });
  expect(f.createResponses).toHaveBeenCalledTimes(3);
  const turn = f.store.getTurnById(answer.turnId);
  expect(turn.status).toBe('completed');
  expect(turn.items).toContainEqual(
    expect.objectContaining({ type: 'assistant-message', text: '**Answer:** No evidence.' })
  );
  expect(turn.items).toContainEqual(
    expect.objectContaining({
      type: 'tool-call',
      tool: 'knowledge.result',
      status: 'completed',
      arguments: { answer: 'No evidence.', citationIds: [], uncertainty: 'No page was read.' },
    })
  );
});

it('retains a failed Turn and returns a typed refusal after one unsuccessful output repair', async () => {
  const f = await fixture();
  f.createResponses.mockResolvedValue({
    id: 'markdown',
    object: 'response',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: '**Answer:** Still markdown.' }] },
    ],
  });
  const error = await f.ask().catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'knowledge_query_failed',
    status: 422,
    details: { threadId: expect.any(String), turnId: expect.any(String) },
  });
  const turn = f.store.getTurnById(error.details.turnId);
  expect(turn).toMatchObject({
    threadId: error.details.threadId,
    status: 'failed',
    error: { code: 'knowledge_manager_failed' },
  });
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  expect(turn.items.filter((item) => item.type === 'assistant-message')).toHaveLength(2);
});

it('enforces the result Tool schema and allows only one repair for rejected arguments', async () => {
  const f = await fixture();
  f.createResponses
    .mockResolvedValueOnce(
      call('knowledge.result', { answer: 'Missing required result fields.' }, 'invalid-result')
    )
    .mockResolvedValueOnce(call('knowledge.retrieval', { query: 'missing evidence' }))
    .mockResolvedValueOnce(
      call(
        'knowledge.result',
        { answer: 'No evidence.', citationIds: [], uncertainty: 'No page was read.' },
        'repaired-result'
      )
    );
  const answer = await f.ask();
  expect(answer).toMatchObject({
    answer: 'No evidence.',
    citations: [],
    uncertainty: 'No page was read.',
  });
  expect(f.createResponses).toHaveBeenCalledTimes(3);
  const turn = f.store.getTurnById(answer.turnId);
  expect(
    turn.items
      .filter((item) => item.type === 'tool-call' && item.tool === 'knowledge.result')
      .map((item) => item.status)
  ).toEqual(['failed', 'completed']);
});

it('refuses a reused call id during output repair without losing the original Tool evidence', async () => {
  const f = await fixture();
  f.createResponses
    .mockResolvedValueOnce(
      call('knowledge.page.read', { pageId: `openkit:${f.workspaceScope}/index` }, 'reused-call')
    )
    .mockResolvedValueOnce({
      id: 'markdown',
      object: 'response',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '**Answer:** Done.' }] }],
    })
    .mockResolvedValueOnce(
      call(
        'knowledge.result',
        { answer: 'Done.', citationIds: [], uncertainty: 'Only the overview was read.' },
        'reused-call'
      )
    );
  const error = await f.ask().catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'knowledge_query_failed', status: 422 });
  const turn = f.store.getTurnById(error.details.turnId);
  expect(turn.status).toBe('failed');
  expect(turn.items.filter((item) => item.type === 'tool-call').map((item) => item.tool)).toEqual([
    'knowledge.page.read',
  ]);
  expect(f.createResponses).toHaveBeenCalledTimes(3);
});

it('repairs an unsearched absence by indexing the pinned notebook, reading the unlinked fact and citing it', async () => {
  const f = await fixture(false, true);
  const retrievalRoot = join(f.dataRoot, 'workspaces', f.workspace.id, 'indexes', 'retrieval');
  expect(existsSync(retrievalRoot)).toBe(false);
  const pageId = `openkit:${f.workspaceScope}/launch-evidence`;
  f.createResponses
    .mockResolvedValueOnce(message('The notebook is empty.', [], 'Only the overview was read.'))
    .mockResolvedValueOnce(call('knowledge.retrieval', { query: 'heliotrope cobalt' }))
    .mockResolvedValueOnce(call('knowledge.page.read', { pageId }))
    .mockResolvedValueOnce(message('The heliotrope launch uses the cobalt gate.', [pageId]));
  const answer = await f.ask();
  expect(answer).toMatchObject({
    answer: 'The heliotrope launch uses the cobalt gate.',
    citations: [{ revision: f.revision, contentDigest: f.contentDigest }],
  });
  expect(existsSync(retrievalRoot)).toBe(true);
  const initial = f.createResponses.mock.calls[0]![1].input as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  const payload = JSON.parse(initial.find((entry) => entry.role === 'user')!.content![0]!.text!);
  expect(payload.overviews[0].content).not.toContain('launch-evidence');
  const search = JSON.parse(toolOutput(f.createResponses.mock.calls[2]![1], 'knowledge.retrieval'));
  expect(search.sources[0]).toMatchObject({
    notebookRevision: f.revision,
    selected: [expect.objectContaining({ pageId, contentDigest: f.contentDigest })],
  });
  const turn = f.store.getTurnById(answer.turnId);
  expect(turn.status).toBe('completed');
  expect(
    turn.items
      .filter((item) => item.type === 'tool-call' && item.tool === 'knowledge.result')
      .map((item) => item.status)
  ).toEqual(['failed', 'completed']);
  expect(f.createResponses).toHaveBeenCalledTimes(4);
}, 120_000);

it('refuses a second unsearched absence after one bounded repair with retained work and no delivery', async () => {
  const f = await fixture(false, true);
  f.createResponses.mockImplementation(async () => message('No evidence.', [], 'No search.'));
  const error = await f.ask().catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'knowledge_query_failed', status: 422 });
  const turn = f.store.getTurnById(error.details.turnId);
  expect(turn.status).toBe('failed');
  expect(f.createResponses).toHaveBeenCalledTimes(2);
  expect(
    turn.items.filter((item) => item.type === 'tool-call').map((item) => [item.tool, item.status])
  ).toEqual([
    ['knowledge.result', 'failed'],
    ['knowledge.result', 'failed'],
  ]);
  const asking = listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id).find(
    (call) => call.id === f.askingCall.id
  );
  expect(asking!.extensions?.['openkit.knowledge/delivery']).toBeUndefined();
});

/** Uses real private Timeline, User Source and User notebook owners around the existing fake transport. */
async function memoryFixture() {
  const f = await fixture(true);
  const userDb = openUserDb(f.dataRoot, f.userId);
  applyScopedMigrations(userDb);
  onTestFinished(() => userDb.sqlite.close());
  const requestActor = { kind: 'local' as const, userId: f.userId };
  const writer = {
    coreDb: f.coreDb,
    userDb,
    workspaceDb: f.workspaceDb,
    store: f.store,
    actor: requestActor,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot: f.dataRoot }),
    inflightCommands: new WeakMap(),
  };
  const baseRevision = initializeScopedNotebook({
    ...writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:private-km' },
  });
  const source = await registerUserKnowledgeSource(writer, {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Private User preference',
    content: 'I prefer the meridian violet tea. USER_PRIVATE_SOURCE',
  });
  const pageId = 'preferences';
  const publication = await saveMemoryPage(writer, {
    requestId: randomUUID(),
    baseRevision,
    pageId,
    summary: 'Save private preference',
    content: serializeUserAuthoredKnowledgePage(
      {
        id: pageId,
        kind: 'preference',
        title: 'Meridian tea preference',
        content: 'I prefer meridian violet tea. USER_PRIVATE_PAGE',
        sourceReferences: [`source:${source.id}@${source.contentDigest}`],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { kind: 'user', userId: f.userId }
    ),
  });
  const timeline = openAssistantTimeline(f.store, f.workspace.id, f.userId, 'Private Assistant');
  const turn = f.store.createTurn(f.workspace.id, timeline.id, 'Which tea?', f.actor);
  const access = {
    ...f.access,
    userDb,
    requestActor,
    outputThreadId: timeline.id,
    outputTurnId: turn.id,
  };
  const question = {
    workspaceId: f.workspace.id,
    question: 'Which meridian tea do I prefer?',
    caller: 'internal-agent' as const,
    source: 'memory' as const,
    access,
    signal: new AbortController().signal,
  };
  return {
    ...f,
    writer,
    source,
    publication,
    timeline,
    question,
    pageId,
    memoryPageDigest: `sha256:${createHash('sha256')
      .update(
        new KnowledgeNotebook({
          repositoryPath: join(f.dataRoot, 'users', f.userId, 'memory', 'notebook.git'),
        }).readRevision(publication.notebookRevision, [`${pageId}.md`]).files[`${pageId}.md`]!
      )
      .digest('hex')}`,
    memoryScope: `page/user/${f.userId}/${readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'user', userId: f.userId } })}`,
    citation: formatReferenceUri({
      scopeId: `page/user/${f.userId}/${readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'user', userId: f.userId } })}`,
      objectId: pageId,
    }),
    askMemory: () => askKnowledgeAgent(f.dependencies, question),
  };
}

it('answers from only current-self Memory through actual search, page and model-admitted Source reads', async () => {
  const f = await memoryFixture();
  let step = 0;
  f.createResponses.mockImplementation(async (_provider, _request, context) => {
    context?.onUsage?.({ input_tokens: 9, output_tokens: 3, total_tokens: 12 });
    if (++step === 1) return call('knowledge.retrieval', { query: 'meridian violet tea' });
    if (step === 2) return call('knowledge.page.read', { pageId: f.citation });
    if (step === 3)
      return call('knowledge.source.read', { pageId: f.citation, sourceId: f.source.id });
    return message('You prefer violet tea.', [f.citation], null);
  });
  const answer = await f.askMemory();
  expect(answer).toMatchObject({
    answer: 'You prefer violet tea.',
    citations: [
      {
        reference: `${f.citation}@${f.memoryPageDigest}`,
        sourceReferences: [`source:${f.source.id}@${f.source.contentDigest}`],
      },
    ],
  });
  const search = toolOutput(f.createResponses.mock.calls[1]![1], 'knowledge.retrieval');
  expect(JSON.parse(search).sources).toMatchObject([
    { source: 'memory', sourceScope: f.memoryScope, selected: [{ pageId: f.citation }] },
  ]);
  expect(search).not.toContain('page/workspace/');
  expect(search).not.toContain('page/server');
  expect(toolOutput(f.createResponses.mock.calls[2]![1], 'knowledge.page.read')).toContain(
    'USER_PRIVATE_PAGE'
  );
  expect(toolOutput(f.createResponses.mock.calls[3]![1], 'knowledge.source.read')).toContain(
    'USER_PRIVATE_SOURCE'
  );
  expect(
    readTurnRetrievalTraces(
      join(f.dataRoot, 'workspaces', f.workspace.id),
      f.workspace.id,
      f.timeline.id,
      f.question.access.outputTurnId
    )
  ).toMatchObject([
    {
      trace: {
        sourceScope: f.memoryScope,
        queryContext: { threadId: f.timeline.id, turnId: f.question.access.outputTurnId },
      },
    },
  ]);
  const workThread = f.store.getThread(f.workspace.id, answer.threadId);
  expect(workThread).toMatchObject({ visibility: 'private', privateOwnerUserId: f.userId });
  const workTurn = f.store.getTurnById(answer.turnId);
  expect(workTurn.internalExecution?.knowledge?.ownerScope).toEqual({
    kind: 'user',
    userId: f.userId,
  });
  expect(listWorkspaceUsageRecords(f.workspaceDb, f.workspace.id).length).toBeGreaterThan(0);
  expect(
    listWorkspaceUsageRecords(f.workspaceDb, f.workspace.id).every(
      (record) => record.turnId === answer.turnId
    )
  ).toBe(true);
  const initial = JSON.stringify(f.createResponses.mock.calls[0]![1]);
  expect(initial).not.toContain('page/workspace/');
  expect(initial).not.toContain('page/server');
  expect(initial).not.toContain('knowledge_notebook_history');
  expect(initial).not.toContain('cobalt');
});

it('refuses Memory for shared work, another User or a Worker before Provider dispatch', async () => {
  const f = await memoryFixture();
  const shared = f.store.createThread(f.workspace.id, 'Shared work', undefined, 'conversation', {
    visibility: 'workspace',
  });
  for (const question of [
    {
      ...f.question,
      access: { ...f.question.access, outputThreadId: shared.id, outputTurnId: undefined },
    },
    {
      ...f.question,
      access: {
        ...f.question.access,
        actor: { kind: 'user' as const, id: allocateEntityId('usr') },
      },
    },
    { ...f.question, caller: 'worker' as const },
  ])
    await expect(askKnowledgeAgent(f.dependencies, question)).rejects.toMatchObject({
      code: 'memory_access_denied',
    });
  expect(f.createResponses).not.toHaveBeenCalled();
});

it('rechecks Memory page suppression before delivering a synthesized answer', async () => {
  const f = await memoryFixture();
  let step = 0;
  let readPage = '';
  f.createResponses.mockImplementation(async (_provider, request) => {
    if (++step === 1) return call('knowledge.retrieval', { query: 'meridian violet tea' });
    if (step === 2) return call('knowledge.page.read', { pageId: f.citation });
    readPage = toolOutput(request, 'knowledge.page.read');
    const owner = resolveScopedNotebookOwner({ ...f.writer, target: { kind: 'user' } });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(owner.notebookRoot, 'notebook.git'),
    });
    const content = notebook.readRevision(f.publication.notebookRevision).files['preferences.md']!;
    appendMemorySuppression(owner.notebookRoot, {
      userId: f.userId,
      actorId: f.userId,
      requestId: randomUUID(),
      pageId: f.pageId,
      lastRevision: f.publication.notebookRevision,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      sourceFingerprints: [`source:${f.source.id}@${f.source.contentDigest}`],
    });
    return message('You prefer violet tea.', [f.citation], null);
  });
  await expect(f.askMemory()).rejects.toMatchObject({ code: 'memory_access_denied' });
  expect(readPage).toContain('USER_PRIVATE_PAGE');
  expect(readUserKnowledgeSource(f.writer, f.source.id, 'model')).toBeNull();
});

it('rechecks current User authority after Memory page reads before answer delivery', async () => {
  const f = await memoryFixture();
  let step = 0;
  let readPage = '';
  f.createResponses.mockImplementation(async (_provider, request) => {
    if (++step === 1) return call('knowledge.retrieval', { query: 'meridian violet tea' });
    if (step === 2) return call('knowledge.page.read', { pageId: f.citation });
    readPage = toolOutput(request, 'knowledge.page.read');
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
    return message('You prefer violet tea.', [f.citation], null);
  });
  await expect(f.askMemory()).rejects.toMatchObject({ code: 'memory_access_denied' });
  expect(readPage).toContain('USER_PRIVATE_PAGE');
});
