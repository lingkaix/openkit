import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { ServerKnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb } from '../storage/db.js';
import {
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from '../storage/index-rebuild.js';
import { applyMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';
import { attributedNotebookPageBytes } from './notebook-publication.js';
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

/** Actual Server notebook, Core receipts, Thread records and publisher surround only a fake bounded role. */
function fixture(enabled: boolean) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-km-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
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
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash('human correction') },
      producer: actor,
      authority: { kind: 'direct', instructionReference: 'fixture' },
      sourceReferences: [],
    },
  });
  notebook.publish({ baseRevision: original, candidateRevision: human });
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
      baseRevision: human,
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
    store.updateServerTurn(input.turn.id, {
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
    pin: (input) => {
      store.updateServerTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'server-model',
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

it.each([
  'unpinned',
  'pinned',
  'candidate-pinned',
  'reviewed-candidate',
  'foreign-scope',
  'wrong-pin',
  'missing-target',
] as const)('admits only exact Server page citations through maintenance publication: %s', async (kind) => {
  const f = fixture(kind !== 'reviewed-candidate');
  const context = { coreDb: f.coreDb, actor: f.requestActor };
  const source = await registerServerKnowledgeSource(context, {
    requestId: randomUUID(),
    kind: 'document',
    title: 'Server evidence',
    content: 'Server evidence remains available.',
  });
  const target = serializeUserAuthoredKnowledgePage(
    {
      id: 'target',
      kind: 'project-context',
      title: 'Target',
      content: 'Server evidence.',
      sourceReferences: [`source:${source.id}@${source.contentDigest}`],
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
    { kind: 'server' }
  );
  const baseRevision = f.notebook.prepare({
    baseRevision: f.human,
    changes: { 'target.md': target },
    metadata: {
      summary: 'Retain source-backed target',
      producer: f.input.actor,
      authority: { kind: 'direct', instructionReference: 'fixture' },
      sourceReferences: [`source:${source.id}@${source.contentDigest}`],
      changeRequest: { requestId: randomUUID(), inputDigest: commandInputHash(target) },
    },
  });
  f.notebook.publish({ baseRevision: f.human, candidateRevision: baseRevision });
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
  const citing = serializeUserAuthoredKnowledgePage(
    {
      id: 'citing',
      kind: 'project-context',
      title: 'Citing',
      content: 'Compare the target.',
      sourceReferences: [reference],
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
    { kind: 'server' }
  );
  f.run.mockImplementationOnce(async (run) => {
    const script = `${changesTarget ? `cat > target.md <<'TARGET'\n${authoredTarget}\nTARGET\n` : ''}cat > citing.md <<'PAGE'\n${citing}\nPAGE`;
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
    f.store.updateServerTurn(run.turn.id, {
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
    const candidateFiles = f.notebook.readRevision(result.candidateRevision!).files;
    const proposalContext = {
      ...f.dependencies,
      actor: f.requestActor,
      revalidate: (files = candidateFiles) =>
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

it('withholds historical human page bodies when their original Source is unavailable', async () => {
  const f = fixture(true);
  const source = await registerServerKnowledgeSource(
    { coreDb: f.coreDb, actor: f.requestActor },
    {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Historical evidence',
      content: 'Historical private evidence.',
    }
  );
  let baseRevision = f.human;
  for (const historical of [true, false]) {
    const content = serializeUserAuthoredKnowledgePage(
      {
        id: 'history',
        kind: 'project-context',
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
    join(f.coreDb.dataRoot, 'server', 'sources', 'materials', source.id, 'content.txt'),
    'Changed Source bytes.'
  );
  const result = await runServerKnowledgeMaintenanceCommand(f.dependencies, {
    ...f.input,
    tellContent: undefined,
  });
  expect(result.outcome).toBe('failed');
  expect(f.run).not.toHaveBeenCalled();
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
  expect(turn).toMatchObject({
    owner: { kind: 'server' },
    internalExecution: {
      roleId: 'knowledge-manager',
      logicalModelId: 'server-model',
      contextStrategy: 'compaction',
      knowledge: { baseRevision: f.human, ownerScope: { kind: 'server' } },
    },
  });
  expect(f.store.listWorkspaces()).toEqual([]);
  if (!enabled) {
    expect(f.notebook.publishedRevision()).toBe(f.human);
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
  const content = serializeUserAuthoredKnowledgePage(
    {
      id: 'release-rule',
      kind: 'project-context',
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
  const proposal = createServerNotebookProposal(
    context,
    {
      requestId: randomUUID(),
      baseRevision: f.human,
      summary: 'Save the explicit Server release rule.',
      changes: [{ path: 'release-rule.md', content }],
    },
    producer,
    [sourceReference]
  );
  expect(f.notebook.publishedRevision()).toBe(f.human);
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
  expect(f.notebook.publishedRevision()).toBe(f.human);
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
  const workspace = f.store.createWorkspace('Server review recall');
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: workspace.id,
    ownerUserId: f.requestActor.userId,
  });
  const thread = f.store.createThread(
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
  const thread = f.store.createServerThread('Server Knowledge maintenance');
  const active = f.store.createServerTurn(thread.id, 'Active run', f.input.actor, null, {
    agentId: 'knowledge-manager',
  });
  const skipped = await prepareServerKnowledgeMaintenance(f.dependencies, {
    ...f.input,
    trigger: 'schedule',
  }).execute();
  expect(skipped.outcome).toBe('skipped');
  expect(f.run).not.toHaveBeenCalled();
  expect(f.store.getServerTurnById(active.id).status).toBe('running');
  f.store.updateServerTurn(active.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: { code: 'recovery_required', message: 'Interrupted run.' },
  });
  const failed = await prepareServerKnowledgeMaintenance(f.dependencies, {
    ...f.input,
    requestActor: undefined,
    trigger: 'schedule',
  }).execute();
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
