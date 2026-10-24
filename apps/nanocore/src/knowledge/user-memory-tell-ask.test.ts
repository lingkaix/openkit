import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { openAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import { readInternalContextEvidence } from '../internal-agents/internal-context-evidence.js';
import {
  createKnowledgeManagerTranscript,
  pinKnowledgeManagerExecution,
  runKnowledgeManagerAgent,
} from '../internal-agents/knowledge-manager-agent.js';
import { quickChatWorkspaceIdForUser } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { retrieveUserMemory } from '../storage/index-rebuild.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { readRetrievalTrace } from '../storage/retrieval-traces.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { ensureUserQuickChatWorkspace } from '../workspace-membership.js';
import { askKnowledgeAgent } from './knowledge-agent.js';
import { recordMemorySuppression, saveMemoryPage } from './memory-lifecycle.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, updateOkfFrontmatter } from './okf.js';
import {
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './scoped-knowledge-sources.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';
import {
  readUserMemoryNotebookAdmission,
  runUserMemoryMaintenanceCommand,
} from './user-memory-agent-maintenance.js';
import {
  decideUserMemoryProposal,
  readUserMemoryProposal,
  readUserMemoryProposalPreview,
} from './user-memory-proposals.js';

type TransportRequest = Parameters<LLMGatewayProviderDispatcher['createResponses']>[1];
type ProviderResponse = Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>;
const nativeTime = '2026-10-24T04:00:00.000Z';
const laterTime = '2026-10-24T05:00:00.000Z';
const falseTime = '2001-01-01T00:00:00.000Z';
const preference = 'The meridian label color is ORCHID-TEAL-42.';
const digest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** Replaces only the external Provider response; every requested Tool executes in Core. */
function call(name: string, args: Record<string, unknown>, callId = name): ProviderResponse {
  return {
    id: randomUUID(),
    object: 'response',
    output: [
      {
        type: 'function_call',
        call_id: callId,
        name: operationToolName(name),
        arguments: JSON.stringify(args),
      },
    ],
  };
}

/** Reads the actual completed Tool output from the next external Provider request. */
function output(request: TransportRequest, callId: string) {
  const result = (
    request.input as Array<{ type?: string; call_id?: string; output?: string }>
  ).find((item) => item.type === 'function_call_output' && item.call_id === callId);
  expect(result, `Missing completed Tool output: ${callId}`).toBeDefined();
  return JSON.parse(result!.output!);
}

/** Uses real private owners, publication, role pinning, loop, compaction and evidence verification. */
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(nativeTime);
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-tell-ask-'));
  const store = createTestStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  await ensureUserQuickChatWorkspace({ coreDb, store, userId });
  const workspaceId = quickChatWorkspaceIdForUser(userId);
  const timeline = await openAssistantTimeline(store, workspaceId, userId, 'Private Assistant');
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      displayName: 'External transport fixture',
      kind: 'custom',
      baseUrl: 'https://provider.invalid/v1',
      models: ['memory-model'],
      modelMetadata: { 'memory-model': metadata },
    },
  ]);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    providerRegistry,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'memory',
      logicalModels: [
        {
          id: 'memory',
          displayName: 'Memory',
          contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
          routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: 'memory-model' }],
        },
      ],
    },
  });
  const createResponses = vi.fn<LLMGatewayProviderDispatcher['createResponses']>(async () => {
    throw new Error('The test must supply each external Provider response.');
  });
  const native = {
    store,
    runtimeConfig: () => snapshot,
    dispatcher: { createResponses },
    resolveGatewayProvider: () => ({
      id: 'fixture',
      displayName: 'External transport fixture',
      adapterId: 'fixture',
      models: ['memory-model'],
      baseUrl: null,
      apiKey: '',
      requiresApiKey: false,
      gatewayCapabilities: { responses: 'native' as const, chatCompletions: 'native' as const },
      modelMetadata: { 'memory-model': metadata },
    }),
    openWorkspace: (id: string) => openWorkspaceDb(dataRoot, id),
  };
  const actor = { kind: 'local' as const, userId };
  const runtimeConfigManager = { current: () => snapshot };
  const writer = {
    coreDb,
    userDb,
    store,
    actor,
    runtimeConfigManager,
    inflightCommands: new WeakMap(),
  };
  const maintenance = {
    ...writer,
    openWorkspace: native.openWorkspace,
    pin: (run: Parameters<typeof pinKnowledgeManagerExecution>[1]) =>
      pinKnowledgeManagerExecution(native, run),
    run: (run: Parameters<typeof runKnowledgeManagerAgent>[1]) =>
      runKnowledgeManagerAgent(native, run),
  };
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'users', userId, 'memory', 'notebook.git'),
  });
  const access = {
    coreDb,
    userDb,
    store,
    requestActor: actor,
    actor: { kind: 'user' as const, id: userId },
    outputThreadId: timeline.id,
  };
  const search = (query = 'meridian label ORCHID-TEAL-42') =>
    retrieveUserMemory({
      dataRoot,
      workspaceId,
      access,
      caller: 'app-api',
      query,
      states: ['active'],
    });
  const ask = () =>
    askKnowledgeAgent(native, {
      workspaceId,
      question: 'Which meridian label color should I use?',
      source: 'memory',
      caller: 'app-api',
      access,
      signal: new AbortController().signal,
    });
  const proposalContext = {
    ...writer,
    revalidate: (files: Readonly<Record<string, string>>, paths?: readonly string[]) =>
      readUserMemoryNotebookAdmission(writer, files, paths),
  };
  onTestFinished(async () => {
    await closeRetrievalServices();
    await shutdownControlStoreWorkerClient();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  /** Drives the native tell owner; the model only supplies an edit script and final result. */
  async function tell(
    pages: (source: string) => Record<string, string>,
    tellContent: string | undefined = preference,
    pageIds?: readonly string[]
  ) {
    let step = 0;
    createResponses.mockImplementation(async (_provider, request) => {
      if (++step === 1) {
        const messages = request.input as Array<{
          role?: string;
          content?: Array<{ text?: string }>;
        }>;
        const payload = JSON.parse(
          messages.find((item) => item.role === 'user')!.content![0]!.text!
        );
        const files = pages(payload.sources[0]?.reference ?? '');
        const script = Object.entries(files)
          .map(([path, content]) => `cat > ${path} <<'PAGE'\n${content}PAGE`)
          .join('\n');
        return call('knowledge.notebook-workspace.update', { script });
      }
      if (step === 2)
        return call('knowledge.notebook.update', {
          summary: 'Record the supplied personal preference.',
        });
      return call('knowledge.result', { summary: 'The native candidate is ready for review.' });
    });
    const result = await runUserMemoryMaintenanceCommand(maintenance, {
      requestId: randomUUID(),
      requestActor: actor,
      trigger: 'request',
      instructions: 'Remember the supplied information.',
      sources: [],
      tellContent,
      pageIds,
      askingThreadId: timeline.id,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('review-required');
    expect(store.getTurnById(result.turnId).internalExecution).toMatchObject({
      contextStrategy: 'compaction',
    });
    const selected = readUserMemoryProposal(proposalContext, result.proposalId!);
    return { result, selected };
  }

  /** Publishes only the exact candidate named by the human decision. */
  async function accept(pending: Awaited<ReturnType<typeof tell>>) {
    const { selected, result } = pending;
    return decideUserMemoryProposal(proposalContext, {
      requestId: randomUUID(),
      proposalId: result.proposalId!,
      proposalDigest: selected.proposalDigest,
      baseRevision: selected.proposal.baseRevision,
      candidateRevision: selected.proposal.candidateRevision,
      decision: 'accepted',
    });
  }
  const page = (source: string, content = preference, state = 'draft') =>
    updateOkfFrontmatter({
      path: 'labels.md',
      content: serializeKnowledgePageFixture(
        {
          title: 'Meridian labels',
          content,
          sourceReferences: source ? [source] : [],
          createdAt: falseTime,
          updatedAt: falseTime,
        },
        { kind: 'user', userId }
      ),
      updates: {
        openkit_status: state,
        status: state === 'active' ? 'stable' : 'draft',
        review_state: 'unreviewed',
      },
    });
  return {
    dataRoot,
    store,
    coreDb,
    userDb,
    userId,
    workspaceId,
    timeline,
    writer,
    access,
    native,
    notebook,
    search,
    ask,
    proposalContext,
    createResponses,
    tell,
    accept,
    page,
  };
}

it('remembers through exact review, selects the published bytes, and cites them from a private Timeline without an asking Turn', async () => {
  const f = await fixture();
  const pending = await f.tell((source) => ({
    'labels.md': f.page(source),
    'rough-note.md': updateOkfFrontmatter({
      path: 'rough-note.md',
      content: f.page(source, 'Keep this as a draft working note.'),
      updates: { title: 'Working note' },
    }),
  }));
  const preview = readUserMemoryProposalPreview(f.proposalContext, {
    proposalId: pending.result.proposalId!,
    path: 'labels.md',
    offset: 0,
  });
  expect(preview.after).toBeTruthy();
  const fields = parseOkfDocument({ path: 'labels.md', content: preview.after! }).document!
    .frontmatter;
  // COORD00:3xZ DIAG-KM16: all NEW tell pages are active, and native clock facts precede the frozen Review.
  expect.soft(fields).toMatchObject({
    openkit_status: 'active',
    status: 'stable',
    review_state: 'accepted',
    created_at: nativeTime,
    updated_at: nativeTime,
  });
  const rough = readUserMemoryProposalPreview(f.proposalContext, {
    proposalId: pending.result.proposalId!,
    path: 'rough-note.md',
    offset: 0,
  });
  // The ruling admits every new tell page; model prose cannot introduce an intent classifier.
  expect
    .soft(parseOkfDocument({ path: 'rough-note.md', content: rough.after! }).document!.frontmatter)
    .toMatchObject({
      openkit_status: 'active',
      status: 'stable',
      created_at: nativeTime,
      updated_at: nativeTime,
    });
  expect(
    f.notebook.readRevision(f.notebook.publishedRevision()).files['labels.md']
  ).toBeUndefined();
  expect((await f.search()).selected).toEqual([]);
  vi.setSystemTime(laterTime);
  const accepted = await f.accept(pending);
  const revision = accepted.notebookRevision!;
  // S63 exact Review: acceptance cannot rewrite any previewed candidate byte.
  expect(f.notebook.readRevision(revision).files['labels.md']).toBe(preview.after);
  expect(revision).toBe(pending.selected.proposal.candidateRevision);
  const contentDigest = digest(preview.after!);
  const scopeId = `page/user/${f.userId}/${readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'user', userId: f.userId } })}`;
  const pageId = formatReferenceUri({ scopeId, objectId: 'labels' });
  const selected = await f.search();
  expect
    .soft(selected.selected.find((entry) => entry.reference.objectId === 'labels'))
    .toMatchObject({ reference: { scopeId, objectId: 'labels' }, revision, contentDigest });
  let step = 0;
  f.createResponses.mockClear();
  f.createResponses.mockImplementation(async (_provider, request) => {
    if (++step === 1)
      return call('knowledge.retrieval', { query: 'meridian label ORCHID-TEAL-42' });
    if (step === 2) {
      const retrieval = output(request, 'knowledge.retrieval');
      expect(
        retrieval.sources[0].selected.find((entry: { pageId: string }) => entry.pageId === pageId)
      ).toMatchObject({ pageId, revision, contentDigest });
      return call('knowledge.page.read', { pageId });
    }
    expect(output(request, 'knowledge.page.read')).toMatchObject({
      pageId,
      revision,
      contentDigest,
      content: preview.after,
    });
    return call('knowledge.result', {
      answer: preference,
      citationIds: [pageId],
      uncertainty: null,
    });
  });
  const answer = await f.ask();
  expect(answer).toMatchObject({
    answer: preference,
    uncertainty: null,
    citations: [{ reference: `${pageId}@${contentDigest}`, revision, contentDigest }],
  });
  const retrieval = output(f.createResponses.mock.calls[1]![1], 'knowledge.retrieval');
  const reference = retrieval.sources[0].retrievalTraceRef;
  expect(reference.scopeId).toBe(`retrieval-trace/thread/${f.workspaceId}/${f.timeline.id}`);
  const trace = readRetrievalTrace(join(f.dataRoot, 'workspaces', f.workspaceId), reference)!;
  expect(trace.queryContext.threadId).toBe(f.timeline.id);
  expect(trace.queryContext.turnId).toBeUndefined();
  expect(trace.queryContext.threadId).not.toBe(answer.threadId);
  expect(f.store.listThreadTurns(f.workspaceId, f.timeline.id)).toEqual([]);
}, 120_000);

it('preserves existing lifecycle and creation time, and changes update time only for changed content', async () => {
  const f = await fixture();
  initializeScopedNotebook({
    ...f.writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:authored-memory' },
  });
  const originalTime = '2024-01-02T03:04:05.000Z';
  const original: Record<string, string> = {};
  for (const [pageId, state] of [
    ['draft-note', 'draft'],
    ['active-note', 'active'],
    ['unchanged', 'active'],
  ] as const) {
    const content = updateOkfFrontmatter({
      path: `${pageId}.md`,
      content: f.page('', `Existing ${pageId} personal label note.`, state),
      updates: {
        created_at: originalTime,
        updated_at: originalTime,
        review_state: 'user-authored',
      },
    });
    original[`${pageId}.md`] = content;
    await saveMemoryPage(f.writer, {
      requestId: randomUUID(),
      baseRevision: f.notebook.publishedRevision(),
      pageId,
      content,
      summary: 'Explicitly author a personal note.',
    });
  }
  vi.setSystemTime(laterTime);
  const pending = await f.tell(
    () =>
      Object.fromEntries(
        Object.entries(original).map(([path, content]) => [
          path,
          updateOkfFrontmatter({
            path,
            content:
              path === 'unchanged.md'
                ? content
                : content.replace('personal label note.', 'revised personal label note.'),
            updates: {
              created_at: falseTime,
              updated_at: falseTime,
              openkit_status: path === 'draft-note.md' ? 'active' : 'draft',
              status: path === 'draft-note.md' ? 'stable' : 'draft',
            },
          }),
        ])
      ),
    preference,
    ['draft-note', 'active-note', 'unchanged']
  );
  const candidate = f.notebook.readRevision(pending.result.candidateRevision!).files;
  for (const [path, state] of [
    ['draft-note.md', 'draft'],
    ['active-note.md', 'active'],
    ['unchanged.md', 'active'],
  ] as const) {
    const fields = parseOkfDocument({ path, content: candidate[path]! }).document!.frontmatter;
    // COORD00:3xZ: tell updates retain the existing lifecycle and original creation fact.
    expect.soft(fields).toMatchObject({
      openkit_status: state,
      status: state === 'active' ? 'stable' : 'draft',
      created_at: originalTime,
      updated_at: path === 'unchanged.md' ? originalTime : laterTime,
    });
  }
  await f.accept(pending);
  const selection = await f.search('personal label note');
  expect
    .soft(selection.selected.some(({ reference }) => reference.objectId === 'draft-note'))
    .toBe(false);
  expect.soft(selection.excluded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reference: expect.objectContaining({ objectId: 'draft-note' }),
        reason: 'lower_conformance',
        eligibilityReason: 'state_not_selected',
      }),
    ])
  );
}, 120_000);

it('answers an actual empty thread-scoped retrieval with uncertainty and no citations', async () => {
  const f = await fixture();
  initializeScopedNotebook({
    ...f.writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:empty-memory' },
  });
  let step = 0;
  f.createResponses.mockImplementation(async (_provider, request) => {
    if (++step === 1) return call('knowledge.retrieval', { query: 'unknown meridian label color' });
    expect(output(request, 'knowledge.retrieval').sources[0].selected).toEqual([]);
    return call('knowledge.result', {
      answer: 'I do not have a saved label color.',
      citationIds: [],
      uncertainty: 'No eligible saved Memory provides the color.',
    });
  });
  expect(await f.ask()).toMatchObject({
    citations: [],
    uncertainty: 'No eligible saved Memory provides the color.',
  });
  expect(step).toBe(2);
  expect(f.store.listThreadTurns(f.workspaceId, f.timeline.id)).toEqual([]);
}, 120_000);

it.each([
  'foreign-user',
  'wrong-thread',
  'revoked-source',
] as const)('refuses %s evidence without borrowing a KM Turn or disclosing private Source content', async (fault) => {
  const f = await fixture();
  initializeScopedNotebook({
    ...f.writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:source-admission' },
  });
  const source = await registerUserKnowledgeSource(f.writer, {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Private preference Source',
    content: 'PRIVATE_TELL_ASK_SOURCE_BODY',
  });
  const content = updateOkfFrontmatter({
    path: 'labels.md',
    content: f.page(`source:${source.id}@${source.contentDigest}`, preference, 'active'),
    updates: { created_at: nativeTime, updated_at: nativeTime, review_state: 'user-authored' },
  });
  await saveMemoryPage(f.writer, {
    requestId: randomUUID(),
    baseRevision: f.notebook.publishedRevision(),
    pageId: 'labels',
    content,
    summary: 'Author the private Source-backed control.',
  });
  const selection = await f.search();
  expect(selection.selected.some(({ reference }) => reference.objectId === 'labels')).toBe(true);
  expect(selection.retrievalTraceRef!.scopeId).toBe(
    `retrieval-trace/thread/${f.workspaceId}/${f.timeline.id}`
  );
  const work = await f.store.createThread(
    f.workspaceId,
    'Independent private KM work',
    undefined,
    'knowledge-manager',
    { visibility: 'private', privateOwnerUserId: f.userId }
  );
  const turn = await f.store.createTurn(
    f.workspaceId,
    work.id,
    'Verify private query evidence.',
    f.access.actor,
    null,
    { agentId: 'knowledge-manager' }
  );
  const callId = randomUUID();
  const items = await createKnowledgeManagerTranscript(
    f.store,
    turn,
    f.access.actor
  )([
    {
      role: 'assistant',
      truncated: false,
      content: [
        {
          type: 'toolCall',
          name: 'knowledge.retrieval',
          callId,
          arguments: { query: 'meridian label' },
        },
      ],
    },
    {
      role: 'tool',
      callId,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(selection) }],
    },
  ]);
  const evidence = {
    store: f.store,
    coreDb: f.coreDb,
    actor: f.writer.actor,
    workspaceId: f.workspaceId,
    threadId: work.id,
    items,
    strategy: 'compaction' as const,
    knowledgeProjection: 'selection' as const,
    retrievalContext: { threadId: f.timeline.id },
  };
  // Temporary type bridge: the accepted input has a Thread and no Turn; the current type still requires a Turn.
  const verify = (input: typeof evidence) =>
    readInternalContextEvidence(input as Parameters<typeof readInternalContextEvidence>[0]);
  expect.soft(() => verify(evidence)).not.toThrow();
  if (fault === 'foreign-user') evidence.actor = { kind: 'local', userId: allocateEntityId('usr') };
  else if (fault === 'wrong-thread') evidence.retrievalContext = { threadId: work.id };
  else {
    const exact = f.notebook.readRevision(f.notebook.publishedRevision());
    let step = 0;
    f.createResponses.mockImplementation(async (_provider, request) => {
      if (++step === 1)
        return call('knowledge.retrieval', { query: 'meridian label ORCHID-TEAL-42' });
      expect(output(request, 'knowledge.retrieval').sources[0].selected).not.toEqual([]);
      recordMemorySuppression(f.writer, {
        requestId: randomUUID(),
        pageId: 'labels',
        notebookRevision: exact.revision,
        digest: digest(exact.files['labels.md']!),
      });
      return call('knowledge.result', {
        answer: 'The previously selected source is no longer available.',
        citationIds: [],
        uncertainty: 'Current source authority changed.',
      });
    });
    const failed = await f.ask().catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: 'knowledge_query_failed', status: 422 });
    expect.soft(step).toBe(2);
    const failedTurn = f.store.getTurnById(
      (failed as { details: { turnId: string } }).details.turnId
    );
    // COORD00:3xZ: the real bounded loop's source failure must survive the KM no-result boundary.
    expect
      .soft(failedTurn.error)
      .toMatchObject({ code: 'internal_agent_context_source_unavailable' });
    // On old production, thread admission fails before revocation can run. Keep the lower refusal control reachable.
    if (step === 1)
      recordMemorySuppression(f.writer, {
        requestId: randomUUID(),
        pageId: 'labels',
        notebookRevision: exact.revision,
        digest: digest(exact.files['labels.md']!),
      });
    expect(await readUserKnowledgeSource(f.writer, source.id, 'model')).toBeNull();
  }
  let error: unknown;
  try {
    verify(evidence);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: 'internal_agent_context_source_unavailable' });
  expect((error as Error).message).not.toContain('PRIVATE_TELL_ASK_SOURCE_BODY');
  expect((error as Error).message).not.toContain(source.id);
  if (fault !== 'revoked-source') expect(f.createResponses).not.toHaveBeenCalled();
}, 120_000);
