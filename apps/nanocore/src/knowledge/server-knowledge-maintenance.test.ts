import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri } from '@openkit/protocol';
import { afterAll, expect, it, onTestFinished, vi } from 'vitest';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { ServerKnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-products.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import {
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from '../storage/index-rebuild.js';
import { applyMigrations } from '../storage/migrate.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';
import { attributedNotebookPageBytes } from './okf.js';
import { initializeScopedNotebook, pinScopedNotebook } from './scoped-notebook-owner.js';
import {
  prepareServerKnowledgeMaintenance,
  runServerKnowledgeMaintenanceCommand,
  type ServerKnowledgeMaintenanceDependencies,
  serverNotebookAdmission,
} from './server-knowledge-maintenance.js';
import { registerServerKnowledgeSource } from './server-knowledge-owner.js';
import {
  createServerNotebookProposal,
  decideServerNotebookProposal,
  readServerNotebookProposal,
  readServerNotebookProposalPreview,
} from './server-notebook-proposals.js';

let initialNotebook: { dataRoot: string; userId: string; human: string } | undefined;
afterAll(() => {
  if (initialNotebook) rmSync(initialNotebook.dataRoot, { recursive: true, force: true });
  if (citationNotebook) rmSync(citationNotebook.dataRoot, { recursive: true, force: true });
});

/** Freezes only acknowledged initial Notebook/Core bytes; no Store or native writer survives. */
function closedInitialNotebook() {
  if (initialNotebook) return initialNotebook;
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-km-baseline-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const actor = { kind: 'user' as const, id: userId };
    const requestActor = { kind: 'local' as const, userId };
    initializeScopedNotebook({
      coreDb,
      actor: requestActor,
      target: { kind: 'server' },
      initialization: { requestId: randomUUID(), instructionReference: 'fixture' },
    });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(dataRoot, 'server', 'knowledge', 'notebook.git'),
    });
    const original = notebook.publishedRevision();
    const human = notebook.prepare({
      baseRevision: original,
      changes: {
        'index.md':
          '---\nokf_version: "0.2"\n---\n# Human overview\n\nPreserve this human correction.\n',
      },
      metadata: {
        summary: 'Human correction',
        changeRequest: {
          requestId: randomUUID(),
          inputDigest: commandInputHash('human correction'),
        },
        producer: actor,
        authority: { kind: 'direct', instructionReference: 'fixture' },
        sourceReferences: [],
      },
    });
    notebook.publish({ baseRevision: original, candidateRevision: human });
    coreDb.sqlite.close();
    initialNotebook = { dataRoot, userId, human };
    return initialNotebook;
  } finally {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    if (!initialNotebook) rmSync(dataRoot, { recursive: true, force: true });
  }
}

/** Actual private Server notebook, Core receipts, Thread records and publisher surround only a fake bounded role. */
function fixture(enabled: boolean, baseline = closedInitialNotebook()) {
  // The first case pays preparation within its original bound; later cases copy only closed bytes.
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-km-'));
  cpSync(baseline.dataRoot, dataRoot, { recursive: true });
  const coreDb = openCoreDb(dataRoot);
  const userId = baseline.userId;
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'server', 'knowledge', 'notebook.git'),
  });
  const human = baseline.human;
  const run = vi.fn(async (input: ServerKnowledgeManagerAgentRun) => {
    const payload = JSON.parse(
      input.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(
        ''
      )
    );
    expect(payload.sourceRange).toEqual([]);
    expect(payload.humanEdits.changes).toContainEqual(
      expect.objectContaining({ after: expect.stringContaining('Preserve this human correction.') })
    );
    expect(input.inputs).toMatchObject({
      ownerScope: { kind: 'server' },
      baseRevision: notebook.publishedRevision(),
      trigger: 'request',
      sourceRange: [],
    });
    expect('workspaceId' in input.turn).toBe(false);
    expect(input.tools.map((tool) => tool.name)).toEqual([
      'thread.history.read',
      'knowledge.notebook-workspace.update',
      'knowledge.notebook.update',
    ]);
    const execute = async (name: string, value: unknown) =>
      input.tools
        .find((tool) => tool.name === name)!
        .execute(value, { signal: input.signal, callId: randomUUID(), toolOccurrence: 1 });
    await execute('knowledge.notebook-workspace.update', {
      script: "printf '\\nThe explicit Server fact is BLUE-HERON-7.\\n' >> index.md",
    });
    await execute('knowledge.notebook.update', {
      summary: 'Keep the human overview and add the explicit fact.',
    });
    expect(input.validateResult(JSON.stringify({ summary: 'Finished.' }))).toBeUndefined();
    await store.updateServerTurn(input.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: input.turn.id, text: '{"summary":"Finished."}' };
  });
  const dependencies: ServerKnowledgeMaintenanceDependencies = {
    store,
    coreDb,
    runtimeConfigManager: {
      current: () => ({
        openKitConfig: { knowledgeMaintenance: { enabled, reviewRequiredPageIds: [] } },
      }),
    } as unknown as RuntimeConfigManager,
    inflightCommands: new WeakMap(),
    pin: async (input) => {
      await store.updateServerTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'server-model',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
          contextStrategy: 'compaction',
          threshold: 1000,
          knowledge: input.inputs!,
        },
      });
    },
    run,
  };
  const input = {
    requestId: randomUUID(),
    requestActor,
    actor,
    trigger: 'request' as const,
    instructions:
      'Integrate the explicit Server fact, preserve human edits, and keep the overview current.',
    sources: [],
    tellContent: 'The explicit Server fact is BLUE-HERON-7.',
    signal: new AbortController().signal,
  };
  return { dependencies, input, run, store, notebook, human, coreDb, requestActor };
}

let citationNotebook:
  | {
      dataRoot: string;
      userId: string;
      human: string;
      target: string;
      baseRevision: string;
    }
  | undefined;

/** Captures the acknowledged citation prerequisite once, then admits each case from closed private bytes. */
async function fixtureWithCitationTarget(enabled: boolean) {
  if (!citationNotebook) {
    const f = fixture(enabled);
    const context = { ...f.dependencies, actor: f.requestActor };
    const source = await registerServerKnowledgeSource(context, {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Server evidence',
      content: 'Server evidence remains available.',
    });
    const target = serializeKnowledgePageFixture(
      {
        title: 'Target',
        content: 'Server evidence.',
        sourceReferences: [`source:${source.id}@${source.contentDigest}`],
        createdAt: '2026-10-18T00:00:00Z',
        updatedAt: '2026-10-18T00:00:00Z',
      },
      { kind: 'server' }
    );
    const sourceBaseRevision = f.notebook.publishedRevision();
    const baseRevision = f.notebook.prepare({
      baseRevision: sourceBaseRevision,
      changes: { 'target.md': target },
      metadata: {
        summary: 'Retain source-backed target',
        producer: f.input.actor,
        authority: { kind: 'direct', instructionReference: 'fixture' },
        sourceReferences: [`source:${source.id}@${source.contentDigest}`],
        changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(target) },
      },
    });
    f.notebook.publish({ baseRevision: sourceBaseRevision, candidateRevision: baseRevision });
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(f.coreDb.dataRoot);
    f.coreDb.sqlite.close();
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-km-citation-baseline-'));
    try {
      cpSync(f.coreDb.dataRoot, dataRoot, { recursive: true });
      citationNotebook = {
        dataRoot,
        userId: f.requestActor.userId,
        human: f.human,
        target,
        baseRevision,
      };
    } catch (error) {
      rmSync(dataRoot, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    f: fixture(enabled, citationNotebook),
    target: citationNotebook.target,
    baseRevision: citationNotebook.baseRevision,
  };
}

it.each([
  'unpinned',
  'pinned',
  'candidate-pinned',
  'reviewed-candidate',
  'foreign-scope',
  'wrong-pin',
  'missing-target',
] as const)('admits only exact Server page citations through maintenance publication: %s', async (kind) => {
  const { f, target, baseRevision } = await fixtureWithCitationTarget(
    kind !== 'reviewed-candidate'
  );
  const context = { ...f.dependencies, actor: f.requestActor };
  const pin = pinScopedNotebook({ ...context, target: { kind: 'server' } });
  const changesTarget = kind === 'candidate-pinned' || kind === 'reviewed-candidate';
  const authoredTarget = target.replace('Server evidence.', 'Updated Server evidence.');
  const selectedTarget = changesTarget
    ? attributedNotebookPageBytes(
        'target.md',
        authoredTarget,
        { kind: 'server' },
        kind === 'reviewed-candidate' ? 'accepted' : 'delegated'
      )
    : target;
  const reference = formatReferenceUri(
    {
      scopeId:
        kind === 'foreign-scope'
          ? `page/user/${f.requestActor.userId}/${pin.knowledgeBaseId}`
          : `page/server/${pin.knowledgeBaseId}`,
      objectId: kind === 'missing-target' ? 'missing' : 'target',
    },
    kind === 'pinned' || changesTarget
      ? `sha256:${createHash('sha256').update(selectedTarget).digest('hex')}`
      : kind === 'wrong-pin'
        ? `sha256:${'0'.repeat(64)}`
        : undefined
  );
  const citing = serializeKnowledgePageFixture(
    {
      title: 'Citing',
      content: 'Compare the target.',
      sourceReferences: [reference],
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
    { kind: 'server' }
  );
  f.run.mockImplementationOnce(async (run) => {
    const script = `${changesTarget ? `cat > target.md <<'TARGET'\n${authoredTarget}TARGET\n` : ''}cat > citing.md <<'PAGE'\n${citing}\nPAGE`;
    for (const [name, args] of [
      ['knowledge.notebook-workspace.update', { script }],
      ['knowledge.notebook.update', { summary: 'Compare admitted Server page bytes.' }],
    ] as const) {
      await run.tools
        .find((tool) => tool.name === name)!
        .execute(args, {
          callId: randomUUID(),
          toolOccurrence: 1,
          signal: run.signal,
        });
    }
    await f.store.updateServerTurn(run.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: run.turn.id, text: '{"summary":"Finished."}' };
  });
  const result = await runServerKnowledgeMaintenanceCommand(f.dependencies, {
    ...f.input,
    tellContent: undefined,
  });
  const allowed = kind === 'unpinned' || kind === 'pinned' || changesTarget;
  expect(result.outcome).toBe(
    kind === 'reviewed-candidate' ? 'review-required' : allowed ? 'published' : 'failed'
  );
  expect(f.run).toHaveBeenCalledTimes(1);
  let publishedRevision = result.notebookRevision;
  if (kind === 'reviewed-candidate') {
    expect(f.notebook.publishedRevision()).toBe(baseRevision);
    const proposalContext = {
      ...f.dependencies,
      actor: f.requestActor,
      revalidate: (files?: Readonly<Record<string, string>>) =>
        serverNotebookAdmission(f.dependencies, f.requestActor, files),
    };
    const saved = readServerNotebookProposal(proposalContext, result.proposalId!);
    const accepted = await decideServerNotebookProposal(proposalContext, {
      requestId: randomUUID(),
      proposalId: result.proposalId!,
      proposalDigest: saved.proposalDigest,
      baseRevision,
      candidateRevision: result.candidateRevision!,
      decision: 'accepted',
    });
    publishedRevision = accepted.notebookRevision!;
    expect(publishedRevision).toBe(result.candidateRevision);
  }
  if (allowed) {
    expect(f.notebook.readRevision(publishedRevision).files['citing.md']).toContain(reference);
    expect(f.notebook.readRevision(publishedRevision).files['target.md']).toBe(selectedTarget);
    const admission = serverNotebookAdmission(f.dependencies, f.requestActor);
    expect(admission.pageScopeId).toBe(`page/server/${pin.knowledgeBaseId}`);
    expect(admission.resolvedReferences.get('citing')?.has(reference)).toBe(true);
  } else {
    expect(f.notebook.publishedRevision()).toBe(baseRevision);
  }
});

it('keeps independent historical human page bodies when their original Source is unavailable', async () => {
  const f = fixture(true);
  const source = await registerServerKnowledgeSource(
    { ...f.dependencies, actor: f.requestActor },
    {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Historical evidence',
      content: 'Historical private evidence.',
    }
  );
  let baseRevision = f.notebook.publishedRevision();
  for (const historical of [true, false]) {
    const content = serializeKnowledgePageFixture(
      {
        title: 'History',
        content: historical ? 'Historical private evidence.' : 'Current independent human note.',
        sourceReferences: historical ? [`source:${source.id}@${source.contentDigest}`] : [],
        createdAt: '2026-10-18T00:00:00Z',
        updatedAt: '2026-10-18T00:00:00Z',
      },
      { kind: 'server' }
    );
    const revision = f.notebook.prepare({
      baseRevision,
      changes: { 'history.md': content },
      metadata: {
        summary: 'Human history',
        producer: f.input.actor,
        authority: { kind: 'direct', instructionReference: 'fixture' },
        sourceReferences: [],
        changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(content) },
      },
    });
    f.notebook.publish({ baseRevision, candidateRevision: revision });
    baseRevision = revision;
  }
  writeFileSync(
    join(f.coreDb.dataRoot, 'server', 'knowledge', 'raw', 'sources', source.id, 'original'),
    'Changed Source bytes.'
  );
  f.run.mockImplementationOnce(async (run) => {
    const context = run.messages[0]!.content.flatMap((part) =>
      part.type === 'text' ? [part.text] : []
    ).join('');
    expect(context).toContain('Historical private evidence.');
    expect(context).toContain('Current independent human note.');
    expect(context).not.toContain('Changed Source bytes.');
    await run.tools
      .find((tool) => tool.name === 'knowledge.notebook.update')!
      .execute(
        { summary: 'Preserve the independent human edits.' },
        { callId: randomUUID(), toolOccurrence: 1, signal: run.signal }
      );
    await f.store.updateServerTurn(run.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: run.turn.id, text: '{"summary":"Preserved."}' };
  });
  const result = await runServerKnowledgeMaintenanceCommand(f.dependencies, {
    ...f.input,
    tellContent: undefined,
  });
  expect(result.outcome).toBe('no-change');
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.notebook.publishedRevision()).toBe(baseRevision);
});

it.each([
  true,
  false,
])('keeps Server maintenance off Workspace storage, preserves human inputs and uses delegation=%s or exact review', async (enabled) => {
  const f = fixture(enabled);
  const result = await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input);
  expect(result.outcome).toBe(enabled ? 'published' : 'review-required');
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input)).toEqual(result);
  expect(f.run).toHaveBeenCalledTimes(1);
  const turn = f.store.getServerTurnById(result.turnId);
  const sourceBaseRevision = turn.internalExecution!.knowledge!.baseRevision!;
  expect(f.notebook.inspectRevision(sourceBaseRevision).parentRevision).toBe(f.human);
  expect(Object.keys(f.notebook.readSourcePointers(sourceBaseRevision))).toHaveLength(1);
  expect(turn).toMatchObject({
    owner: { kind: 'server' },
    internalExecution: {
      roleId: 'knowledge-manager',
      logicalModelId: 'server-model',
      contextStrategy: 'compaction',
      knowledge: { baseRevision: sourceBaseRevision, ownerScope: { kind: 'server' } },
    },
  });
  expect(f.store.listWorkspaces()).toEqual([]);
  if (!enabled) {
    expect(f.notebook.publishedRevision()).toBe(sourceBaseRevision);
    const context = {
      ...f.dependencies,
      actor: f.requestActor,
      revalidate: (files?: Readonly<Record<string, string>>) =>
        serverNotebookAdmission(f.dependencies, f.requestActor, files),
    };
    const candidate = readServerNotebookProposal(context, result.proposalId!);
    expect(candidate.diff[0]!.after).toContain('Preserve this human correction.');
    const decision = await decideServerNotebookProposal(context, {
      proposalId: result.proposalId!,
      requestId: randomUUID(),
      proposalDigest: candidate.proposalDigest,
      baseRevision: candidate.proposal.baseRevision,
      candidateRevision: candidate.proposal.candidateRevision,
      decision: 'accepted',
    });
    expect(decision.notebookRevision).toBe(candidate.proposal.candidateRevision);
  }
  const files = f.notebook.readRevision(f.notebook.publishedRevision()).files;
  expect(files['index.md']).toContain('Preserve this human correction.');
  expect(files['index.md']).toContain('BLUE-HERON-7');
});

it('recalls the exact Server candidate only after its human Review publishes the shown bytes', async () => {
  const f = fixture(false);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const source = await registerServerKnowledgeSource(context, {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Server release rule',
    content: 'The Server release rule uses BLUE-HERON-7.',
  });
  const sourceReference = `source:${source.id}@${source.contentDigest}`;
  const content = serializeKnowledgePageFixture(
    {
      title: 'Server release rule',
      content: 'The Server release rule uses BLUE-HERON-7.',
      sourceReferences: [sourceReference],
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
    },
    { kind: 'server' }
  );
  const producer = {
    kind: 'agent' as const,
    id: 'knowledge-manager',
    responsibleUserId: f.requestActor.userId,
  };
  const sourceBaseRevision = f.notebook.publishedRevision();
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision: sourceBaseRevision,
      summary: 'Save the explicit Server release rule.',
      changes: [{ path: 'release-rule.md', content }],
    },
    producer,
    [sourceReference]
  );
  expect(f.notebook.publishedRevision()).toBe(sourceBaseRevision);
  const selected = readServerNotebookProposal(context, proposal.id);
  const preview = readServerNotebookProposalPreview(context, {
    proposalId: proposal.id,
    path: 'release-rule.md',
    offset: 0,
  });
  const request = {
    requestId: randomUUID(),
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision: proposal.baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision: 'accepted' as const,
  };
  const invoke = createOperationInvocation({
    coreDb: f.coreDb,
    store: f.store,
    serverKnowledgeMaintenance: f.dependencies,
  });
  await expect(
    invoke('knowledge.server.proposal.decide', request, {
      kind: 'public',
      actor: f.requestActor,
      delivery: 'model',
    })
  ).rejects.toMatchObject({ code: 'human_review_required', status: 403 });
  expect(f.notebook.publishedRevision()).toBe(sourceBaseRevision);
  const afterRefusal = readServerNotebookProposal(context, proposal.id);
  expect(afterRefusal.reviews).toEqual([]);
  expect(afterRefusal.proposalDigest).toBe(selected.proposalDigest);
  const human = { kind: 'public' as const, actor: f.requestActor, delivery: 'human' as const };
  const accepted = await invoke('knowledge.server.proposal.decide', request, human);
  expect(await invoke('knowledge.server.proposal.decide', request, human)).toEqual(accepted);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toHaveLength(1);
  expect(f.notebook.publishedRevision()).toBe(accepted.notebookRevision);
  const published = f.notebook.readRevision(accepted.notebookRevision!);
  expect(published.metadata.producer).toEqual(producer);
  expect(published.files['release-rule.md']).toBe(preview.after);
  const workspace = await f.store.createWorkspace('Server review recall');
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: workspace.id,
    ownerUserId: f.requestActor.userId,
  });
  const thread = await f.store.createThread(
    workspace.id,
    'Shared Server query',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const query = {
    dataRoot: f.coreDb.dataRoot,
    workspaceId: workspace.id,
    access: {
      store: f.store,
      coreDb: f.coreDb,
      actor: f.input.actor,
      requestActor: f.requestActor,
      outputThreadId: thread.id,
    },
    caller: 'app-api' as const,
    sourceScope: 'server' as const,
    query: 'release rule',
  };
  try {
    const selection = await retrieveWorkspaceKnowledge(query);
    expect(selection.selected.map(({ reference }) => reference.objectId)).toContain('release-rule');
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({ ...query, selection })?.find(
        ({ knowledgePageId }) => knowledgePageId === 'release-rule'
      )?.content
    ).toBe(preview.after);
    expect(published.files['release-rule.md']).toMatch(/review_state: ["']?accepted/);
  } finally {
    await closeRetrievalServices();
  }
});

it('retains skipped active-writer and missing-authority schedule outcomes without a model call', async () => {
  const f = fixture(true);
  const thread = await f.store.createServerThread('Server Knowledge maintenance');
  const active = await f.store.createServerTurn(thread.id, 'Active run', f.input.actor, null, {
    agentId: 'knowledge-manager',
  });
  const skipped = await (
    await prepareServerKnowledgeMaintenance(f.dependencies, {
      ...f.input,
      trigger: 'schedule',
    })
  ).execute();
  expect(skipped.outcome).toBe('skipped');
  expect(f.run).not.toHaveBeenCalled();
  expect(f.store.getServerTurnById(active.id).status).toBe('running');
  await f.store.updateServerTurn(active.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: { code: 'recovery_required', message: 'Interrupted run.' },
  });
  const failed = await (
    await prepareServerKnowledgeMaintenance(f.dependencies, {
      ...f.input,
      requestActor: undefined,
      trigger: 'schedule',
    })
  ).execute();
  expect(failed.outcome).toBe('failed');
  expect(f.run).not.toHaveBeenCalled();
  expect(f.store.getServerTurnById(failed.turnId).items).toContainEqual(
    expect.objectContaining({ type: 'status', knowledgeMaintenanceResult: failed })
  );
});

it.each([
  true,
  false,
])('retains a completed native outcome when the later model call fails, delegation=%s', async (enabled) => {
  const f = fixture(enabled);
  f.run.mockImplementationOnce(async (run) => {
    const execute = async (name: string, value: unknown) =>
      run.tools
        .find((tool) => tool.name === name)!
        .execute(value, { callId: randomUUID(), toolOccurrence: 1, signal: run.signal });
    await execute('knowledge.notebook-workspace.update', {
      script: "printf '\\nNative change before Provider failure.\\n' >> index.md",
    });
    await execute('knowledge.notebook.update', { summary: 'Retain the actual native outcome.' });
    throw new Error('Synthetic Provider failure after native submission.');
  });
  const result = await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input);
  expect(result.outcome).toBe(enabled ? 'published' : 'review-required');
  expect(result.proposalId !== undefined).toBe(!enabled);
  expect(await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input)).toEqual(result);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.store.getServerTurnById(result.turnId)).toMatchObject({ status: 'failed' });
  expect(f.store.getServerTurnById(result.turnId).items).toContainEqual(
    expect.objectContaining({ type: 'status', knowledgeMaintenanceResult: result })
  );
});

it('previews and reviews a valid candidate larger than the display limit using the shared bounded path cursor', async () => {
  const f = fixture(false);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const content = `---\nokf_version: "0.2"\n---\n# Large candidate\n${'Large retained content. '.repeat(3600)}`;
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision: f.human,
      summary: 'Review a complete large candidate.',
      changes: [{ path: 'index.md', content }],
    },
    { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.input.actor.id },
    []
  );
  const inventory = readServerNotebookProposalPreview(context, {
    proposalId: proposal.id,
    offset: 0,
  });
  expect(inventory.paths).toEqual(['index.md']);
  expect(inventory).not.toHaveProperty('after');
  expect(JSON.stringify(inventory).length).toBeLessThan(65_536);
  const chunk = readServerNotebookProposalPreview(context, {
    proposalId: proposal.id,
    path: 'index.md',
    offset: 0,
  });
  expect(chunk.nextOffset).not.toBeNull();
  expect(chunk.after).toBe(content.slice(0, chunk.nextOffset!));
  const decision = await decideServerNotebookProposal(context, {
    proposalId: proposal.id,
    requestId: randomUUID(),
    proposalDigest: inventory.proposalDigest,
    baseRevision: inventory.baseRevision,
    candidateRevision: inventory.candidateRevision,
    decision: 'accepted',
  });
  expect(f.notebook.readRevision(decision.notebookRevision!).files['index.md']).toBe(content);
});

it('reads retained Proposal/Review annotations and preserves them on the next human decision', async () => {
  const f = fixture(false);
  const result = await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const path = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'proposals',
    `${result.proposalId}.md`
  );
  const annotated = readFileSync(path, 'utf8')
    .replace(
      /^producer: (.+)$/m,
      (_line, value) =>
        `producer: ${JSON.stringify({ ...JSON.parse(value), note: 'retained producer annotation' })}`
    )
    .replace(
      /^owner_scope: (.+)$/m,
      (_line, value) =>
        `owner_scope: ${JSON.stringify({ ...JSON.parse(value), note: 'retained scope annotation' })}`
    );
  writeFileSync(path, annotated);
  const selected = readServerNotebookProposal(context, result.proposalId!);
  const request = {
    proposalId: result.proposalId!,
    requestId: randomUUID(),
    proposalDigest: selected.proposalDigest,
    baseRevision: selected.proposal.baseRevision,
    candidateRevision: selected.proposal.candidateRevision,
    decision: 'deferred' as const,
  };
  await decideServerNotebookProposal(context, request);
  const reviewPath = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'reviews',
    `${result.proposalId}.json`
  );
  const retained = JSON.parse(readFileSync(reviewPath, 'utf8'));
  retained.note = 'file note';
  retained.ownerScope.note = 'scope note';
  retained.decisions[0].note = 'decision note';
  retained.decisions[0].actor.note = 'actor note';
  writeFileSync(reviewPath, JSON.stringify(retained));
  expect(readServerNotebookProposal(context, result.proposalId!).reviews).toHaveLength(1);
  await decideServerNotebookProposal(context, {
    ...request,
    requestId: randomUUID(),
    decision: 'accepted',
  });
  const rewritten = JSON.parse(readFileSync(reviewPath, 'utf8'));
  expect(rewritten.note).toBe('file note');
  expect(rewritten.ownerScope.note).toBe('scope note');
  expect(rewritten.decisions[0].note).toBe('decision note');
  expect(rewritten.decisions[0].actor.note).toBe('actor note');
  expect(rewritten.decisions).toHaveLength(2);
  expect(readFileSync(path, 'utf8')).toBe(annotated);
});

// S61 exact Proposal/Review evidence: corrupt retained files only after their actual owners write them.
it.each([
  'candidate-parent',
  'candidate-producer',
  'review-id',
  'review-proposal-digest',
  'review-content-digest',
  'duplicate-request',
  'terminal-order',
] as const)('refuses contradictory retained Server evidence: %s', async (fault) => {
  const { existsSync } = await import('node:fs');
  const f = fixture(false);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const producer = {
    kind: 'agent' as const,
    id: 'knowledge-manager',
    responsibleUserId: f.requestActor.userId,
  };
  const published = f.notebook.publishedRevision();
  const original = f.notebook.readRevision(published).files['index.md']!;
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision: published,
      summary: 'Retain one exact evidence candidate.',
      changes: [{ path: 'index.md', content: `${original}\nExact evidence candidate.\n` }],
    },
    producer,
    []
  );
  const selected = readServerNotebookProposal(context, proposal.id);
  const proposalPath = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'proposals',
    `${proposal.id}.md`
  );
  const reviewPath = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'reviews',
    `${proposal.id}.json`
  );
  if (fault === 'candidate-parent') {
    // Public Notebook preparation permits an empty comparison revision; no Git object is fabricated.
    const comparison = f.notebook.prepare({
      baseRevision: published,
      changes: {},
      metadata: {
        summary: 'Lawful same-tree comparison revision.',
        changeRequest: {
          requestId: randomUUID(),
          inputDigest: commandInputHash('same-tree comparison revision'),
        },
        producer: f.input.actor,
        authority: { kind: 'direct', instructionReference: 'fixture' },
        sourceReferences: [],
      },
    });
    expect(f.notebook.readRevision(comparison).files).toEqual(
      f.notebook.readRevision(published).files
    );
    expect(comparison).not.toBe(published);
    writeFileSync(
      proposalPath,
      readFileSync(proposalPath, 'utf8').replace(
        /^base_revision: .+$/m,
        `base_revision: ${JSON.stringify(comparison)}`
      )
    );
  } else if (fault === 'candidate-producer') {
    // The actual human is valid, but substituting them erases this candidate's Agent provenance.
    writeFileSync(
      proposalPath,
      readFileSync(proposalPath, 'utf8').replace(
        /^producer: .+$/m,
        `producer: ${JSON.stringify(f.input.actor)}`
      )
    );
  } else {
    const request = {
      requestId: randomUUID(),
      proposalId: proposal.id,
      proposalDigest: selected.proposalDigest,
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      decision: 'deferred' as const,
    };
    await decideServerNotebookProposal(context, request);
    await decideServerNotebookProposal(context, { ...request, requestId: randomUUID() });
    if (fault === 'terminal-order')
      await decideServerNotebookProposal(context, {
        ...request,
        requestId: randomUUID(),
        decision: 'rejected',
      });
    const retained = JSON.parse(readFileSync(reviewPath, 'utf8'));
    if (fault === 'review-id') retained.decisions[0].reviewId = retained.decisions[1].reviewId;
    else if (fault === 'duplicate-request') retained.decisions.push(retained.decisions[0]);
    else if (fault === 'terminal-order') retained.decisions.unshift(retained.decisions.pop());
    else {
      const other = createServerNotebookProposal(
        context,
        {
          requestId: randomUUID(),
          baseRevision: published,
          summary: 'Retain a different exact candidate.',
          changes: [{ path: 'index.md', content: `${original}\nDifferent evidence candidate.\n` }],
        },
        producer,
        []
      );
      const otherSelected = readServerNotebookProposal(context, other.id);
      if (fault === 'review-proposal-digest')
        retained.decisions[0].proposalDigest = otherSelected.proposalDigest;
      else retained.decisions[0].contentDigest = other.contentDigest;
    }
    writeFileSync(reviewPath, `${JSON.stringify(retained)}\n`);
  }
  const damagedProposal = readFileSync(proposalPath, 'utf8');
  const damagedReviews = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : undefined;
  expect
    .soft(() => readServerNotebookProposalPreview(context, { proposalId: proposal.id, offset: 0 }))
    .toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  expect(f.notebook.publishedRevision()).toBe(published);
  expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
  expect(readFileSync(proposalPath, 'utf8')).toBe(damagedProposal);
  expect(existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : undefined).toBe(
    damagedReviews
  );
});

it('keeps the producing human and another current Server administrator distinct through exact Review', async () => {
  const { createBetterAuth } = await import('../auth/better-auth.js');
  const { createOpenKitAccessTokenRecord, verifyOpenKitAccessTokenRecord } = await import(
    '../auth/access-token-store.js'
  );
  const f = fixture(false);
  const auth = createBetterAuth(f.coreDb, { env: { PORT: '3000' } });
  const response = await auth.handler(
    new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Another Knowledge administrator',
        email: [randomUUID(), 'example.invalid'].join('@'),
        password: randomUUID(),
      }),
    })
  );
  expect(response.status).toBe(200);
  const administratorId: string = (await response.json()).user.id;
  const issued = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: administratorId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const verified = verifyOpenKitAccessTokenRecord(f.coreDb, issued.secret);
  if (!verified) throw new Error('Fixture administrator must authenticate.');
  const administrator: import('../auth/identity.js').Actor = {
    kind: 'token',
    userId: verified.ownerUserId,
    tokenId: verified.tokenId,
    tokenScope: verified.scope,
  };
  expect(administrator.userId).not.toBe(f.requestActor.userId);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const producer = {
    kind: 'agent' as const,
    id: 'knowledge-manager',
    responsibleUserId: f.requestActor.userId,
  };
  const baseRevision = f.notebook.publishedRevision();
  const original = f.notebook.readRevision(baseRevision).files['index.md']!;
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision,
      summary: 'Review a different human-backed Agent candidate.',
      changes: [
        { path: 'index.md', content: `${original}\nExact cross-administrator candidate.\n` },
      ],
    },
    producer,
    []
  );
  const reviewer = {
    ...f.dependencies,
    actor: administrator,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, administrator, files),
  };
  const selected = readServerNotebookProposal(reviewer, proposal.id);
  const preview = readServerNotebookProposalPreview(reviewer, {
    proposalId: proposal.id,
    path: 'index.md',
    offset: 0,
  });
  const accepted = await decideServerNotebookProposal(reviewer, {
    requestId: randomUUID(),
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision: proposal.baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision: 'accepted',
  });
  expect(accepted.review.actor).toEqual({ kind: 'user', id: administrator.userId });
  expect(accepted.notebookRevision).toBe(proposal.candidateRevision);
  const current = f.notebook.readRevision(accepted.notebookRevision!);
  expect(current.metadata.producer).toEqual(producer);
  expect(current.files['index.md']).toBe(preview.after);
});

// Notebook editing:66 binds the deciding command, distinct from the candidate draft request.
it('retains the exact human Server Proposal command receipt and Audit on accepted replay', async () => {
  const { commandRequestKey, getCommandRequestRecord } = await import(
    '../storage/command-request-records.js'
  );
  const { listServerAuditEvents } = await import('../audit-events.js');
  const f = fixture(false);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const baseRevision = f.notebook.publishedRevision();
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision,
      summary: 'Retain the original human deciding command.',
      changes: [
        {
          path: 'index.md',
          content: `${f.notebook.readRevision(baseRevision).files['index.md']}\nA human-reviewed addition.\n`,
        },
      ],
    },
    { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.requestActor.userId },
    []
  );
  const selected = readServerNotebookProposal(context, proposal.id);
  const request = {
    requestId: randomUUID(),
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision: 'accepted' as const,
  };
  const invoke = createOperationInvocation({
    coreDb: f.coreDb,
    store: f.store,
    serverKnowledgeMaintenance: f.dependencies,
  });
  const human = { kind: 'public' as const, actor: f.requestActor, delivery: 'human' as const };
  const accepted = await invoke('knowledge.server.proposal.decide', request, human);
  const scope = { coreId: 'server' as const, actorId: f.requestActor.userId };
  const receipt = () =>
    getCommandRequestRecord(
      f.coreDb.dataRoot,
      scope,
      commandRequestKey('knowledge.proposal.decide', request.requestId, scope),
      new Date().toISOString()
    );
  // This is the publisher's existing semantic command name, not a newly invented public alias.
  expect.soft(receipt()).toMatchObject({
    command: 'knowledge.proposal.decide',
    requestId: request.requestId,
    scope,
    inputHash: commandInputHash(request),
    response: { kind: 'knowledge_notebook_revision', id: proposal.candidateRevision },
  });
  expect
    .soft(
      getCommandRequestRecord(
        f.coreDb.dataRoot,
        scope,
        commandRequestKey('knowledge.notebook.update', request.requestId, scope),
        new Date().toISOString()
      )
    )
    .toBeNull();
  const audits = () =>
    listServerAuditEvents(f.coreDb).filter((event) => event.requestId === request.requestId);
  const beforeReplay = audits();
  expect.soft(beforeReplay).toContainEqual(
    expect.objectContaining({
      action: 'knowledge.proposal.decide',
      actor: { kind: 'user', id: f.requestActor.userId },
      notebookAdmission: expect.objectContaining({
        ownerScope: { kind: 'server' },
        requestId: request.requestId,
        inputDigest: commandInputHash(request),
        baseRevision,
        candidateRevision: proposal.candidateRevision,
        authority: { kind: 'proposal', proposalId: proposal.id },
      }),
    })
  );
  const originalReceipt = receipt();
  expect(await invoke('knowledge.server.proposal.decide', request, human)).toEqual(accepted);
  expect(receipt()).toEqual(originalReceipt);
  expect(audits()).toEqual(beforeReplay);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toHaveLength(1);
  expect(f.notebook.publishedRevision()).toBe(proposal.candidateRevision);
});

// Evidence Audit Producers requires the human decision, independently of content publication.
it.each([
  'rejected',
  'deferred',
] as const)('retains one Server Proposal %s Audit without relabeling it on exact replay', async (decision) => {
  const { listServerAuditEvents } = await import('../audit-events.js');
  const f = fixture(false);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const baseRevision = f.notebook.publishedRevision();
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision,
      summary: 'Retain a human decision without publication.',
      changes: [
        {
          path: 'index.md',
          content: `${f.notebook.readRevision(baseRevision).files['index.md']}\nAn unpublished addition.\n`,
        },
      ],
    },
    { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.requestActor.userId },
    []
  );
  const selected = readServerNotebookProposal(context, proposal.id);
  const request = {
    requestId: randomUUID(),
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision,
  };
  const invoke = createOperationInvocation({
    coreDb: f.coreDb,
    store: f.store,
    serverKnowledgeMaintenance: f.dependencies,
  });
  const human = { kind: 'public' as const, actor: f.requestActor, delivery: 'human' as const };
  const audits = () =>
    listServerAuditEvents(f.coreDb).filter((event) => event.requestId === request.requestId);
  expect(audits()).toEqual([]);
  const result = await invoke('knowledge.server.proposal.decide', request, human);
  const retainedAudit = audits();
  expect.soft(retainedAudit).toEqual([
    expect.objectContaining({
      action: 'knowledge.proposal.decide',
      category: 'knowledge',
      outcome: 'succeeded',
      actor: { kind: 'user', id: f.requestActor.userId },
      resource: `knowledge-proposal:${proposal.id}`,
    }),
  ]);
  expect(result.notebookRevision).toBeNull();
  expect(f.notebook.publishedRevision()).toBe(baseRevision);
  expect(await invoke('knowledge.server.proposal.decide', request, human)).toEqual(result);
  expect(audits()).toEqual(retainedAudit);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toEqual([result.review]);
  expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
});

// S61:220-222: a retained nonaccepted Review without its required Audit is partial evidence.
it.each([
  'rejected',
  'deferred',
] as const)('refuses Server %s replay after the actual Audit write failed after Review retention', async (decision) => {
  const f = fixture(false);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const baseRevision = f.notebook.publishedRevision();
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision,
      summary: 'Inspect incomplete human decision evidence.',
      changes: [
        {
          path: 'index.md',
          content: `${f.notebook.readRevision(baseRevision).files['index.md']}\nAn unpublished audit-fault candidate.\n`,
        },
      ],
    },
    { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.requestActor.userId },
    []
  );
  const selected = readServerNotebookProposal(context, proposal.id);
  const request = {
    requestId: randomUUID(),
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision,
  };
  const invoke = createOperationInvocation({
    coreDb: f.coreDb,
    store: f.store,
    serverKnowledgeMaintenance: f.dependencies,
  });
  const human = { kind: 'public' as const, actor: f.requestActor, delivery: 'human' as const };
  const auditRows = () =>
    f.coreDb.sqlite
      .prepare(
        'SELECT * FROM audit_events WHERE workspace_id IS NULL AND request_id = ? AND action = ? AND resource = ? LIMIT 2'
      )
      .all(request.requestId, 'knowledge.proposal.decide', `knowledge-proposal:${proposal.id}`);
  expect(auditRows()).toEqual([]);
  expect(f.coreDb.sqlite.pragma('query_only', { simple: true })).toBe(0);
  f.coreDb.sqlite.pragma('query_only = ON');
  try {
    await expect(invoke('knowledge.server.proposal.decide', request, human)).rejects.toMatchObject({
      code: 'SQLITE_READONLY',
    });
  } finally {
    f.coreDb.sqlite.pragma('query_only = OFF');
  }
  // These deciding checks refuse credit for an error before the actual Review/Audit boundary.
  const afterFailure = readServerNotebookProposal(context, proposal.id);
  expect(afterFailure.reviews).toHaveLength(1);
  expect(afterFailure.reviews[0]).toMatchObject({ requestId: request.requestId, decision });
  expect(auditRows()).toEqual([]);
  expect(f.notebook.publishedRevision()).toBe(baseRevision);
  expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
  const reviewPath = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'reviews',
    `${proposal.id}.json`
  );
  const retainedReviewBytes = readFileSync(reviewPath, 'utf8');
  const proposalPath = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'proposals',
    `${proposal.id}.md`
  );
  const retainedProposalBytes = readFileSync(proposalPath, 'utf8');
  await expect
    .soft(invoke('knowledge.server.proposal.decide', request, human))
    .rejects.toMatchObject({ code: 'recovery_required' });
  expect(auditRows()).toEqual([]);
  expect(readFileSync(reviewPath, 'utf8')).toBe(retainedReviewBytes);
  expect(readFileSync(proposalPath, 'utf8')).toBe(retainedProposalBytes);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toEqual(afterFailure.reviews);
  expect(f.notebook.publishedRevision()).toBe(baseRevision);
  expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
});

// S61:220-222: an owner-produced deciding Audit cannot recreate a lost Review on retry.
it.each([
  'rejected',
  'deferred',
] as const)('refuses Server %s replay when its original Audit survives a lost Review file', async (decision) => {
  const { existsSync, unlinkSync } = await import('node:fs');
  const f = fixture(false);
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const baseRevision = f.notebook.publishedRevision();
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision,
      summary: 'Retain a complete decision before Review loss.',
      changes: [
        {
          path: 'index.md',
          content: `${f.notebook.readRevision(baseRevision).files['index.md']}\nA retained audit control.\n`,
        },
      ],
    },
    { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.requestActor.userId },
    []
  );
  const selected = readServerNotebookProposal(context, proposal.id);
  const request = {
    requestId: randomUUID(),
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision,
  };
  const invoke = createOperationInvocation({
    coreDb: f.coreDb,
    store: f.store,
    serverKnowledgeMaintenance: f.dependencies,
  });
  const human = { kind: 'public' as const, actor: f.requestActor, delivery: 'human' as const };
  const auditRows = () =>
    f.coreDb.sqlite
      .prepare(
        'SELECT * FROM audit_events WHERE workspace_id IS NULL AND request_id = ? AND action = ? AND resource = ? LIMIT 2'
      )
      .all(request.requestId, 'knowledge.proposal.decide', `knowledge-proposal:${proposal.id}`);
  expect(auditRows()).toEqual([]);
  const completed = await invoke('knowledge.server.proposal.decide', request, human);
  expect(completed.notebookRevision).toBeNull();
  expect(readServerNotebookProposal(context, proposal.id).reviews).toEqual([completed.review]);
  const retainedAudit = auditRows();
  expect(retainedAudit).toHaveLength(1);
  expect(retainedAudit[0]).toMatchObject({
    request_id: request.requestId,
    action: 'knowledge.proposal.decide',
    resource: `knowledge-proposal:${proposal.id}`,
    outcome: 'succeeded',
  });
  const reviewPath = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'reviews',
    `${proposal.id}.json`
  );
  const proposalPath = join(
    f.coreDb.dataRoot,
    'server',
    'knowledge',
    'proposals',
    `${proposal.id}.md`
  );
  const retainedReviewBytes = readFileSync(reviewPath, 'utf8');
  const retainedProposalBytes = readFileSync(proposalPath, 'utf8');
  expect(f.notebook.publishedRevision()).toBe(baseRevision);
  expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
  expect(await invoke('knowledge.server.proposal.decide', request, human)).toEqual(completed);
  expect(auditRows()).toEqual(retainedAudit);
  expect(readFileSync(reviewPath, 'utf8')).toBe(retainedReviewBytes);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toEqual([completed.review]);
  // Deliberate corruption after lawful public completion: remove this fixture's Review only.
  unlinkSync(reviewPath);
  expect(existsSync(reviewPath)).toBe(false);
  expect(auditRows()).toEqual(retainedAudit);
  await expect
    .soft(invoke('knowledge.server.proposal.decide', request, human))
    .rejects.toMatchObject({ code: 'recovery_required' });
  expect.soft(existsSync(reviewPath)).toBe(false);
  expect.soft(auditRows()).toEqual(retainedAudit);
  expect.soft(readFileSync(proposalPath, 'utf8')).toBe(retainedProposalBytes);
  expect.soft(f.notebook.publishedRevision()).toBe(baseRevision);
  expect.soft(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
  // Missing original Review also forbids changing the same incomplete command into publication.
  await expect
    .soft(invoke('knowledge.server.proposal.decide', { ...request, decision: 'accepted' }, human))
    .rejects.toMatchObject({ code: 'recovery_required' });
  expect.soft(existsSync(reviewPath)).toBe(false);
  expect.soft(auditRows()).toEqual(retainedAudit);
  expect.soft(readFileSync(proposalPath, 'utf8')).toBe(retainedProposalBytes);
  expect.soft(f.notebook.publishedRevision()).toBe(baseRevision);
  expect.soft(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
});

// S61:220–222 and the 0600 stale-new-decision ruling: only acceptance publishes against current head.
it.each([
  'rejected',
  'deferred',
  'accepted',
] as const)('Server stale new %s decision preserves current publication and its exact reviewed tuple', async (decision) => {
  const f = fixture(false);
  const pending = await runServerKnowledgeMaintenanceCommand(f.dependencies, f.input);
  expect(pending.outcome).toBe('review-required');
  const context = {
    ...f.dependencies,
    actor: f.requestActor,
    revalidate: (files?: Readonly<Record<string, string>>) =>
      serverNotebookAdmission(f.dependencies, f.requestActor, files),
  };
  const selected = readServerNotebookProposal(context, pending.proposalId!);
  const proposal = selected.proposal;
  // Advance the real head through a separately created and accepted Proposal, not a raw ref write.
  const control = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision: proposal.baseRevision,
      summary: 'Publish a separate reviewed change before deciding the older Proposal.',
      changes: [
        {
          path: 'index.md',
          content: `${f.notebook.readRevision(proposal.baseRevision).files['index.md']}\nA separate current publication.\n`,
        },
      ],
    },
    { kind: 'agent', id: 'knowledge-manager', responsibleUserId: f.requestActor.userId },
    []
  );
  const controlSelected = readServerNotebookProposal(context, control.id);
  await decideServerNotebookProposal(context, {
    requestId: randomUUID(),
    proposalId: control.id,
    proposalDigest: controlSelected.proposalDigest,
    baseRevision: control.baseRevision,
    candidateRevision: control.candidateRevision,
    decision: 'accepted',
  });
  const currentHead = f.notebook.publishedRevision();
  const currentFiles = f.notebook.readRevision(currentHead).files;
  expect(currentHead).toBe(control.candidateRevision);
  expect(currentHead).not.toBe(proposal.baseRevision);
  expect(currentHead).not.toBe(proposal.candidateRevision);
  expect(readServerNotebookProposal(context, proposal.id).reviews).toEqual([]);
  const request = {
    requestId: randomUUID(),
    proposalId: proposal.id,
    proposalDigest: selected.proposalDigest,
    baseRevision: proposal.baseRevision,
    candidateRevision: proposal.candidateRevision,
    decision,
  };
  if (decision === 'accepted') {
    await expect(decideServerNotebookProposal(context, request)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(readServerNotebookProposal(context, proposal.id).reviews).toEqual([]);
  } else {
    await expect(decideServerNotebookProposal(context, request)).resolves.toMatchObject({
      review: request,
      notebookRevision: null,
    });
    expect(readServerNotebookProposal(context, proposal.id).reviews).toEqual([
      expect.objectContaining(request),
    ]);
  }
  expect(f.notebook.publishedRevision()).toBe(currentHead);
  expect(f.notebook.readRevision(currentHead).files).toEqual(currentFiles);
  expect(f.notebook.retainedCandidate(proposal.id).revision).toBe(proposal.candidateRevision);
});
