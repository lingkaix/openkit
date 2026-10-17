import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
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
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readTurnRetrievalTraces } from '../storage/retrieval-traces.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { askKnowledgeAgent, type KnowledgeAgentDependencies } from './knowledge-agent.js';
import { KnowledgeNotebook } from './notebook.js';
import { publishWorkspaceNotebookEntry } from './notebook-entry-publication.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import { initializeScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import { publishScopedNotebook } from './scoped-notebook-publication.js';

type TransportRequest = Parameters<LLMGatewayProviderDispatcher['createResponses']>[1];
type Transport = Parameters<LLMGatewayProviderDispatcher['createResponses']>[2];
type ProviderResponse = Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>;

/** Only the external Responses transport is replaced; Core, publication and the retrieval Kernel are real. */
async function fixture(withServerKnowledge = false) {
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
  return {
    id: randomUUID(),
    object: 'response' as const,
    output: [
      {
        type: 'message' as const,
        content: [
          {
            type: 'output_text' as const,
            text: JSON.stringify({ answer, citationIds, uncertainty }),
          },
        ],
      },
    ],
  };
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
  const workspacePageId = `page/workspace/${f.workspace.id}/launch-evidence`;
  const serverPageId = 'page/server/launch-evidence';
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
      pageId: `page/workspace/${f.workspace.id}/index`,
      notebookRevision: f.revision,
      contentDigest: f.overviewDigest,
      readTool: 'knowledge.page.read',
      truncated: false,
      nextOffset: null,
    },
    {
      source: 'server',
      pageId: 'page/server/index',
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
      sourceScope: `page/workspace/${f.workspace.id}`,
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
      sourceScope: 'page/server',
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
        reference: `page/workspace/${f.workspace.id}/launch-evidence@${f.revision}`,
        revision: f.revision,
        contentDigest: f.contentDigest,
        sourceReferences: [f.sourceReference],
      },
      {
        reference: `${serverPageId}@${f.server!.revision}`,
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
  ).toEqual(['page/server', `page/workspace/${f.workspace.id}`].sort());
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
        pageId: `page/workspace/${f.workspace.id}/launch-evidence`,
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
    caller: 'worker',
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
      pageId: 'page/server/index',
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
    message('Invented citation.', [`page/workspace/${f.workspace.id}/launch-evidence`], null)
  );
  await expect(f.ask()).rejects.toThrow(
    'Knowledge answer lacks cited evidence or stated uncertainty.'
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
  const pageId = `page/workspace/${f.workspace.id}/launch-evidence`;
  let step = 0;
  f.createResponses.mockImplementation(async () => {
    if (++step === 1) return call('knowledge.retrieval', { query: 'heliotrope cobalt', limit: 5 });
    if (step === 2) return call('knowledge.page.read', { pageId });
    return message('Use the cobalt gate.', [pageId], null);
  });
  await expect(f.ask()).rejects.toThrow(
    'Knowledge answer lacks cited evidence or stated uncertainty.'
  );
  expect(f.createResponses).toHaveBeenCalledTimes(3);
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
