// openkit-test-platform: posix
// L2 native continuity only: scripted model transport does not prove semantic or numerical use.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { formatReferenceUri } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { createOperationInvocation } from '../operation-composition.js';
import { ProviderRegistry } from '../providers/registry.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { retrieveWorkspaceKnowledge } from '../storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readTurnRetrievalTraces } from '../storage/retrieval-traces.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { readWorkspaceNotebookSelection } from './notebook-workspace-selection.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { askKnowledgeAgent, type KnowledgeAgentDependencies } from './knowledge-agent.js';
import type { KnowledgeMaintenanceDependencies } from './knowledge-agent-maintenance.js';
import { runKnowledgeMaintenanceCommand } from './knowledge-maintenance-command.js';
import { parseOkfDocument } from './okf.js';

const NOW = '2026-10-19T00:00:00.000Z';
const APPLIES_TO = ['tool:aster.metrics', 'step:aster.issue-close'];
const QUERY = 'aster metric';
const RULES = [
  {
    id: 'settled-receipts',
    meaning: 'Aster metric receipts include settled receipts only. Pending receipts are excluded.',
    origin:
      'Agent-found: the agent found the settlement distinction in supplied evidence; the user confirmed it.',
  },
  {
    id: 'refund-exclusion',
    meaning:
      'Aster metric receipts exclude refunded receipts, even when settlement happened earlier.',
    origin:
      'User-provided: the user supplied the refund exclusion; the agent recorded it without changing its meaning.',
  },
  {
    id: 'closing-boundary',
    meaning:
      'Aster metric issue closing uses the UTC calendar boundary, not the viewer local timezone.',
    origin:
      'Decided-in-discussion: the user and agent compared timezone choices; the user confirmed UTC.',
  },
];
type Rule = (typeof RULES)[number];
type ExpectedPage = { id: string; content: string; sources: string[] };
type TransportRequest = Parameters<LLMGatewayProviderDispatcher['createResponses']>[1];

/** Compute exact byte identity independently of Notebook and retrieval digest helpers. */
function digest(text: string) {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}

/** Fix complete governed bytes before the editor sees them; business origin is body text only. */
function rulePage(
  workspaceId: string,
  rule: Rule,
  sources: string[],
  appliesTo = APPLIES_TO,
  state: 'active' | 'superseded' = 'active',
  link = ''
): ExpectedPage {
  const content = [
    '---',
    'type: Rule',
    `title: ${JSON.stringify(`Aster metric ${rule.id}`)}`,
    'schema_version: openkit-scope-knowledge-schema-v4',
    `openkit_status: ${state}`,
    `status: ${state === 'active' ? 'stable' : 'deprecated'}`,
    `scope: ${JSON.stringify({ kind: 'workspace', workspaceId })}`,
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    `source_refs: ${JSON.stringify(sources)}`,
    'review_state: delegated',
    'sensitivity: normal',
    'freshness: current',
    `created_at: ${JSON.stringify(NOW)}`,
    `updated_at: ${JSON.stringify(NOW)}`,
    `applies_to: ${JSON.stringify(appliesTo)}`,
    '---',
    rule.meaning,
    '',
    rule.origin,
    ...(link ? ['', link] : []),
    '',
  ].join('\n');
  return { id: rule.id, content, sources };
}

/** Invoke an admitted Tool without replacing its editor, publisher or authority closure. */
async function maintenanceTool(run: KnowledgeManagerAgentRun, name: string, args: unknown) {
  const selected = run.tools.find((entry) => entry.name === name);
  if (!selected) throw new Error(`Missing native Tool ${name}`);
  const result = await selected.execute(args, {
    callId: randomUUID(),
    toolOccurrence: 1,
    signal: run.signal,
  });
  return JSON.parse(
    result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  );
}

/** Script only the external transport's next Tool request, never the Tool result. */
function call(name: string, args: Record<string, unknown>) {
  return {
    id: randomUUID(),
    object: 'response' as const,
    output: [
      {
        type: 'function_call' as const,
        call_id: name === 'knowledge.page.read' ? `${name}:${randomUUID()}` : name,
        name: operationToolName(name),
        arguments: JSON.stringify(args),
      },
    ],
  };
}

/** Inspect actual provider-visible native output rather than a declared Tool schema. */
function toolOutput(request: TransportRequest, name: string) {
  const outputs = request.input as Array<{ type?: string; call_id?: string; output?: string }>;
  const output = outputs[name === 'knowledge.page.read' ? 'findLast' : 'find'](
    (item) =>
      item.type === 'function_call_output' &&
      (name === 'knowledge.page.read'
        ? item.call_id?.startsWith(`${name}:`)
        : item.call_id === name)
  );
  expect(output, `Missing actual ${name} output`).toBeDefined();
  return JSON.parse(output!.output!);
}

/** Real scoped admission, Sources, fixed-base editor/publication, human Review and retrieval. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'typed-rule-continuity-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Aster rule continuity', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'fixture:human-notebook-creation',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: workspace.id },
  });
  const reopen = () =>
    readWorkspaceNotebookSelection({ workspaceDb, workspaceRoot, knowledgeBaseId }).notebook;
  const metadata = { tool_call: true, limit: { context: 64_000, output: 2_000 } };
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      displayName: 'Scripted transport',
      kind: 'custom',
      baseUrl: 'https://provider.invalid/v1',
      models: ['knowledge-model'],
      modelMetadata: { 'knowledge-model': metadata },
    },
  ]);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    providerRegistry,
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'knowledge',
      logicalModels: [
        {
          id: 'knowledge',
          displayName: 'Knowledge',
          contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
          routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: 'knowledge-model' }],
        },
      ],
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
  const run = vi.fn<KnowledgeMaintenanceDependencies['run']>();
  const dependencies: KnowledgeMaintenanceDependencies = {
    coreDb,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot, initialSnapshot: snapshot }),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    run,
    pin: async (input) => {
      await store.updateTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'knowledge',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
          contextStrategy: 'compaction',
          threshold: 32_000,
          knowledge: input.inputs!,
        },
      });
    },
  };
  const invoke = createOperationInvocation({
    ...dependencies,
    repositoryWorkspaceDb: dependencies.openWorkspace,
  });
  const context = { kind: 'public' as const, actor: requestActor };
  const scopeId = `page/workspace/${workspace.id}/${readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'workspace', workspaceId: workspace.id } })}`;
  const access = { store, coreDb, actor, requestActor };
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    workspace,
    scopeId,
    actor,
    reopen,
    invoke,
    context,
    /** Capture actual immutable evidence through native Source admission. */
    capture: async (content: string) => {
      const result = await invoke(
        'knowledge.source.register',
        {
          workspaceId: workspace.id,
          requestId: randomUUID(),
          kind: 'document',
          title: 'Synthetic Aster evidence',
          content,
        },
        context
      );
      expect(result.source.contentDigest).toBe(digest(content));
      return `source:${result.source.id}@${digest(content)}`;
    },
    /** The runner authors fixed bytes; native submission must retain an exact pending candidate. */
    edit: async (pages: ExpectedPage[], sources: string[], summary: string) => {
      const baseRevision = reopen().publishedRevision();
      run.mockImplementationOnce(async (input) => {
        expect(input.inputs!.baseRevision).toBe(baseRevision);
        const script = pages
          .map(({ id, content }) => `cat > ${id}.md <<'PAGE'\n${content}PAGE`)
          .join('\n');
        expect(
          await maintenanceTool(input, 'knowledge.notebook-workspace.update', { script })
        ).toMatchObject({ exitCode: 0, stderr: '' });
        expect(
          await maintenanceTool(input, 'knowledge.notebook.update', { summary })
        ).toMatchObject({
          outcome: 'review_required',
          baseRevision,
        });
        expect(input.validateResult('{"summary":"Native candidate prepared."}')).toBeUndefined();
        await store.updateTurn(input.turn.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        return { turnId: input.turn.id, text: '{"summary":"Native candidate prepared."}' };
      });
      const result = await runKnowledgeMaintenanceCommand(dependencies, {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        actor,
        requestActor,
        trigger: 'request',
        instructions: 'Record the supplied Aster metric evidence. Require human Review.',
        sources,
        signal: new AbortController().signal,
      });
      expect(result.outcome).toBe('review-required');
      expect(reopen().publishedRevision()).toBe(baseRevision);
      const candidate = reopen().readRevision(result.candidateRevision!);
      expect(candidate.parentRevision).toBe(baseRevision);
      for (const page of pages) expect(candidate.files[`${page.id}.md`]).toBe(page.content);
      return { ...result, baseRevision };
    },
    /** Human acceptance names the exact saved candidate; origin never supplies approval. */
    accept: async (candidate: {
      proposalId?: string;
      candidateRevision?: string;
      baseRevision: string;
    }) => {
      const result = await invoke(
        'knowledge.proposal.decide',
        {
          workspaceId: workspace.id,
          requestId: randomUUID(),
          proposalId: candidate.proposalId!,
          decision: 'accepted',
          proposalDigest: store.knowledgeProposalDigest(workspace.id, candidate.proposalId!),
          baseRevision: candidate.baseRevision,
          candidateRevision: candidate.candidateRevision!,
        },
        context
      );
      expect(result.review).toMatchObject({
        actor,
        decision: 'accepted',
        proposalId: candidate.proposalId,
      });
      expect(reopen().publishedRevision()).toBe(candidate.candidateRevision);
      return candidate.candidateRevision!;
    },
    retrieve: (pinnedReferences: Array<{ scopeId: string; objectId: string }> = []) =>
      retrieveWorkspaceKnowledge({
        dataRoot,
        workspaceId: workspace.id,
        access,
        caller: 'app-api',
        query: QUERY,
        types: ['Rule'],
        appliesTo: ['tool:aster.metrics'],
        pinnedReferences,
      }),
    /** Each ask starts in a new empty asking Thread and reads only real selected page bytes. */
    ask: async (pages: ExpectedPage[], revision: string) => {
      const question = 'Find the current Aster metric rules for issue preparation.';
      const thread = await store.createThread(
        workspace.id,
        'Fresh issue',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: userId,
        }
      );
      const turn = await store.createTurn(workspace.id, thread.id, question, actor);
      expect(turn.items).toEqual([]);
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
      let step = 0;
      const pageId = (page: ExpectedPage) => formatReferenceUri({ scopeId, objectId: page.id });
      const createResponses = vi.fn<LLMGatewayProviderDispatcher['createResponses']>(
        async (_provider, request) => {
          const current = step++;
          if (current === 0) {
            const initial = JSON.stringify(request.input);
            for (const rule of RULES) {
              expect(initial).not.toContain(rule.meaning);
              expect(initial).not.toContain(rule.origin);
            }
            for (const page of pages) {
              const body = parseOkfDocument({ path: `${page.id}.md`, content: page.content })
                .document!.body;
              for (const line of body.split('\n').filter(Boolean))
                expect(initial).not.toContain(line);
            }
            return call('knowledge.retrieval', {
              query: QUERY,
              types: ['Rule'],
              appliesTo: ['tool:aster.metrics'],
            });
          }
          if (current === 1) {
            const result = toolOutput(request, 'knowledge.retrieval');
            expect(result.sources).toHaveLength(1);
            const selected = result.sources[0];
            expect(selected).toMatchObject({
              source: 'workspace',
              sourceScope: scopeId,
              notebookRevision: revision,
            });
            expect(
              selected.selected.map((page: { pageId: string }) => page.pageId).sort(),
              JSON.stringify({
                excluded: selected.excluded,
                unavailableSources: result.unavailableSources,
              })
            ).toEqual(pages.map(pageId).sort());
            for (const page of pages)
              expect(selected.selected).toContainEqual(
                expect.objectContaining({
                  pageId: pageId(page),
                  reference: { scopeId, objectId: page.id },
                  revision,
                  contentDigest: digest(page.content),
                  sourceReferences: page.sources,
                })
              );
            return call('knowledge.page.read', { pageId: pageId(pages[0]!) });
          }
          const page = pages[current - 2]!;
          expect(toolOutput(request, 'knowledge.page.read')).toMatchObject({
            pageId: pageId(page),
            revision,
            content: page.content,
            contentDigest: digest(page.content),
            sourceReferences: page.sources,
            nextOffset: null,
          });
          if (current - 1 < pages.length)
            return call('knowledge.page.read', { pageId: pageId(pages[current - 1]!) });
          return call('knowledge.result', {
            answer: 'Native rule pages read. No calculation or semantic-use claim.',
            citationIds: pages.map(pageId),
            uncertainty: 'Server Knowledge is unavailable; only Workspace Rules were read.',
          });
        }
      );
      const queryDependencies: KnowledgeAgentDependencies = {
        store,
        runtimeConfig: () => snapshot,
        dispatcher: { createResponses },
        resolveGatewayProvider: (_id, model) => ({
          id: 'fixture',
          displayName: 'Scripted transport',
          adapterId: 'fixture',
          models: [model],
          baseUrl: null,
          apiKey: '',
          requiresApiKey: false,
          gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
          modelMetadata: { [model]: metadata },
        }),
        openWorkspace: dependencies.openWorkspace,
      };
      const answer = await askKnowledgeAgent(queryDependencies, {
        workspaceId: workspace.id,
        question,
        caller: 'internal-agent',
        access: { ...access, outputThreadId: thread.id, outputTurnId: turn.id },
        capabilityCallId: askingCall.id,
        signal: new AbortController().signal,
      }).catch(async (error: unknown) => {
        // The role runtime contains provider errors; expose fixture assertions without changing it.
        for (const result of createResponses.mock.results)
          if (result.type === 'return') await result.value;
        throw error;
      });
      expect(createResponses).toHaveBeenCalledTimes(pages.length + 2);
      expect(answer.citations).toEqual(
        pages.map((page) => ({
          reference: formatReferenceUri({ scopeId, objectId: page.id }, digest(page.content)),
          revision,
          contentDigest: digest(page.content),
          sourceReferences: page.sources,
        }))
      );
      const traces = readTurnRetrievalTraces(
        join(dataRoot, 'workspaces', workspace.id),
        workspace.id,
        thread.id,
        turn.id
      );
      expect(traces).toHaveLength(1);
      expect(traces[0]!.trace).toMatchObject({
        notebookRevision: revision,
        queryContext: { threadId: thread.id, turnId: turn.id, actor },
        retrievalParameters: {
          types: ['Rule'],
          appliesTo: ['tool:aster.metrics'],
          states: ['active'],
        },
      });
      expect(store.getTurnById(answer.turnId).internalExecution?.knowledge).toMatchObject({
        askingThreadId: thread.id,
        askingTurnId: turn.id,
        baseRevision: revision,
      });
      return { threadId: thread.id, answer };
    },
  };
}

it('D1 preserves three confirmed Rule origins and exact evidence across Review, reopen and a fresh KM ask', async () => {
  const f = await fixture();
  const pages: ExpectedPage[] = [];
  // Source writes are serial at this Notebook's one publication head.
  for (const rule of RULES) {
    const pin = await f.capture(`${rule.meaning}\n\n${rule.origin}\n`);
    pages.push(rulePage(f.workspace.id, rule, [pin]));
  }
  const decoy = rulePage(
    f.workspace.id,
    {
      id: 'preview-only',
      meaning:
        'Aster metric preview includes pending receipts. This is not the issue-closing rule.',
      origin: 'User-provided: a separate preview definition.',
    },
    [pages[0]!.sources[0]!],
    ['tool:aster.metrics.preview']
  );
  const candidate = await f.edit(
    [...pages, decoy],
    pages.flatMap((page) => page.sources),
    'Confirm the three Aster metric meanings.'
  );
  const unpublished = await f.retrieve();
  expect(unpublished.notebookRevision).toBe(candidate.baseRevision);
  expect(unpublished.selected).toEqual([]);
  const revision = await f.accept(candidate);
  await closeRetrievalServices();
  const reopened = f.reopen().readRevision(revision);
  for (const page of [...pages, decoy]) expect(reopened.files[`${page.id}.md`]).toBe(page.content);
  expect(reopened.metadata).toMatchObject({
    producer: { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.actor.id },
    authority: { kind: 'proposal', proposalId: candidate.proposalId },
    sourceReferences: pages.flatMap((page) => page.sources).sort(),
  });
  await f.ask(pages, revision);
}, 120_000);

it('D2 publishes supersession and replacement in one fixed-base revision without losing prior meaning or authority', async () => {
  const f = await fixture();
  const originalRule = RULES[0]!;
  const originalPin = await f.capture(`${originalRule.meaning}\n\n${originalRule.origin}\n`);
  const original = rulePage(f.workspace.id, originalRule, [originalPin]);
  const firstCandidate = await f.edit(
    [original],
    [originalPin],
    'Record the original Aster metric meaning.'
  );
  const first = await f.accept(firstCandidate);
  const changedRule = {
    id: 'booked-receipts',
    meaning:
      'Aster metric receipts include booked receipts, whether settled or pending. Refunded receipts remain excluded.',
    origin: 'Decided-in-discussion: the user confirmed a change from settled to booked receipts.',
  };
  const changedPin = await f.capture(`${changedRule.meaning}\n\n${changedRule.origin}\n`);
  const superseded = rulePage(
    f.workspace.id,
    originalRule,
    [originalPin],
    APPLIES_TO,
    'superseded',
    '[Replacement](booked-receipts.md)'
  );
  const replacement = rulePage(
    f.workspace.id,
    changedRule,
    [changedPin],
    APPLIES_TO,
    'active',
    '[Prior meaning](settled-receipts.md)'
  );
  const secondCandidate = await f.edit(
    [superseded, replacement],
    [originalPin, changedPin],
    'Replace settled with booked receipts.'
  );
  const second = await f.accept(secondCandidate);
  await closeRetrievalServices();
  const reopened = f.reopen();
  const current = reopened.readRevision(second);
  expect(current.parentRevision).toBe(secondCandidate.baseRevision);
  expect(reopened.readRevision(secondCandidate.baseRevision).files[`${original.id}.md`]).toBe(
    original.content
  );
  expect(
    reopened.readRevision(secondCandidate.baseRevision).files[`${replacement.id}.md`]
  ).toBeUndefined();
  expect(current.files[`${original.id}.md`]).toBe(superseded.content);
  expect(current.files[`${replacement.id}.md`]).toBe(replacement.content);
  const history = await f.invoke(
    'knowledge.notebook.history',
    { workspaceId: f.workspace.id, limit: 10 },
    f.context
  );
  for (const [revision, candidate, expected] of [
    [first, firstCandidate, [original]],
    [second, secondCandidate, [superseded, replacement]],
  ] as const) {
    expect(history.revisions).toContainEqual(
      expect.objectContaining({
        revision,
        availability: 'available',
        producer: { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.actor.id },
        changedPaths: expected.map((page) => `${page.id}.md`).sort(),
      })
    );
    const retained = reopened.readRevision(revision);
    expect(retained.metadata.authority).toEqual({
      kind: 'proposal',
      proposalId: candidate.proposalId,
    });
    expect(retained.metadata.sourceReferences).toEqual(
      expected.flatMap((page) => page.sources).sort()
    );
    for (const page of expected) expect(retained.files[`${page.id}.md`]).toBe(page.content);
  }
  const diff = await f.invoke(
    'knowledge.notebook.diff',
    {
      workspaceId: f.workspace.id,
      baseRevision: first,
      fromRevision: second,
      pageIds: [original.id, replacement.id],
    },
    f.context
  );
  expect(diff.truncated).toBe(false);
  expect(diff.changes).toEqual([
    { path: `${original.id}.md`, before: original.content, after: superseded.content },
    { path: `${replacement.id}.md`, before: null, after: replacement.content },
  ]);
  const pinned = await f.retrieve([{ scopeId: f.scopeId, objectId: original.id }]);
  expect(pinned.excluded).toContainEqual(
    expect.objectContaining({
      reference: { scopeId: f.scopeId, objectId: original.id },
      reason: 'lower_conformance',
    })
  );
  expect(
    pinned.selected.map((page) => page.reference.objectId),
    JSON.stringify(pinned.excluded)
  ).toEqual([replacement.id]);
  await f.ask([replacement], second);
}, 120_000);
