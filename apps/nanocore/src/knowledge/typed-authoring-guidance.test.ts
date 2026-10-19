// openkit-test-platform: posix
// This L2 runner double proves native assembly and notebook effects, not model comprehension.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeOwnerScope } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import type {
  KnowledgeManagerAgentRun,
  ServerKnowledgeManagerAgentRun,
} from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { runKnowledgeMaintenanceCommand } from './knowledge-maintenance-command.js';
import { KnowledgeNotebook } from './notebook.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  stringListFrontmatterField,
  updateOkfFrontmatter,
} from './okf.js';
import { initializeScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import { runServerKnowledgeMaintenanceCommand } from './server-knowledge-maintenance.js';
import { runUserMemoryMaintenanceCommand } from './user-memory-agent-maintenance.js';

type Run = KnowledgeManagerAgentRun | ServerKnowledgeManagerAgentRun;
type Scope = 'workspace' | 'user' | 'server';
const NOW = '2026-10-19T00:00:00.000Z';
const evidence =
  'Invoice review requires a receipt. Observed checks found fewer errors. Last checked 2026-10-19T00:00:00.000Z. The objective is reliable invoices.';

/** Preserve all delivered strings without requiring a new context property or Tool. */
function deliveredText(run: Run): string {
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string') {
      try {
        return strings(JSON.parse(value));
      } catch {
        return [value];
      }
    }
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
  };
  return strings([run.messages, run.tools.map(({ description }) => description)]).join('\n');
}

/** Execute the real admitted editor or publisher, without a replacement on either side. */
async function tool(run: Run, name: string, value: unknown) {
  const selected = run.tools.find((entry) => entry.name === name);
  if (!selected) throw new Error(`Missing native Tool ${name}`);
  const result = await selected.execute(value, {
    callId: randomUUID(),
    toolOccurrence: 1,
    signal: run.signal,
  });
  return JSON.parse(
    result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  );
}

/** Author an existing domain type with actual source pins and supplied Effect assessment facts. */
function page(
  ownerScope: KnowledgeOwnerScope,
  type: string,
  references: string[],
  missing?: string
) {
  return updateOkfFrontmatter({
    path: `${type.toLowerCase()}.md`,
    content: serializeKnowledgePageFixture(
      {
        title: `Invoice ${type}`,
        content: evidence,
        sourceReferences: references,
        createdAt: NOW,
        updatedAt: NOW,
      },
      ownerScope
    ),
    updates: {
      type,
      applies_to: ['tool:invoice.check', 'step:invoice-review'],
      ...(type === 'Effect'
        ? { basis: 'Observed checks found fewer errors.', last_checked_at: NOW }
        : {}),
      ...(missing ? { [missing]: undefined } : {}),
    },
  });
}

/** Use independent native scope admission, immutable Git, real receipts, editor and publisher. */
function fixture(scope: Scope) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'typed-authoring-guidance-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Typed authoring', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'fixture:human-notebook-creation',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  if (scope === 'user')
    initializeScopedNotebook({
      coreDb,
      userDb,
      actor: requestActor,
      target: { kind: 'user' },
      initialization: { requestId: randomUUID(), instructionReference: 'fixture:user-notebook' },
    });
  if (scope === 'server')
    initializeScopedNotebook({
      coreDb,
      actor: requestActor,
      target: { kind: 'server' },
      initialization: { requestId: randomUUID(), instructionReference: 'fixture:server-notebook' },
    });
  const ownerScope: KnowledgeOwnerScope =
    scope === 'workspace'
      ? { kind: 'workspace', workspaceId: workspace.id }
      : scope === 'user'
        ? { kind: 'user', userId }
        : { kind: 'server' };
  const notebookRoot =
    scope === 'workspace'
      ? join(dataRoot, 'workspaces', workspace.id, 'knowledge')
      : resolveScopedNotebookOwner({ coreDb, actor: requestActor, target: { kind: scope } })
          .notebookRoot;
  const notebook = new KnowledgeNotebook({ repositoryPath: join(notebookRoot, 'notebook.git') });
  const schemaPath = join(notebookRoot, 'schema', 'scope-schema.yaml');
  const activeSchema =
    DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
      /allowed_types: .*/,
      'allowed_types: [SourceSummary, Rule, Effect, Objective]'
    )
      .replace(/allowed_statuses: .*/, 'allowed_statuses: [active]')
      .replace(
        /allowed_sensitivities: .*/,
        'allowed_sensitivities: [normal, internal, confidential]'
      )
      .replace(/allowed_freshness: .*/, 'allowed_freshness: [current]') +
    `authoring_annotation: "ACTIVE-${scope}-CONTRACT"\n`;
  expect(parseScopeKnowledgeSchema(activeSchema).ok).toBe(true);
  writeFileSync(schemaPath, activeSchema);
  writeFileSync(join(dataRoot, 'private-fixture.txt'), 'UNDISCLOSED-PRIVATE-FIXTURE');
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot }),
  });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const finish = (run: Run) => {
    expect(
      run.validateResult('{"summary":"Finished the native notebook operation."}')
    ).toBeUndefined();
    const update = { status: 'completed' as const, completedAt: new Date().toISOString() };
    if (run.turn.owner.kind === 'workspace') store.updateTurn(run.turn.id, update);
    else store.updateServerTurn(run.turn.id, update);
    return { turnId: run.turn.id, text: '{"summary":"Finished the native notebook operation."}' };
  };
  const run = vi.fn(async (input: Run) => {
    await tool(input, 'knowledge.notebook.update', { summary: 'No page changes.' });
    return finish(input);
  });
  const dependencies = {
    coreDb,
    userDb,
    store,
    runtimeConfigManager,
    workspaceMutationAdmission,
    openWorkspace: (id: string) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    run,
    pin: (
      input:
        | Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>
        | Pick<ServerKnowledgeManagerAgentRun, 'turn' | 'inputs'>
    ) => {
      const internalExecution = {
        roleId: 'knowledge-manager' as const,
        logicalModelId: 'fixture-model',
        contextStrategy: 'compaction' as const,
        threshold: 64_000,
        knowledge: input.inputs!,
      };
      if (input.turn.owner.kind === 'workspace')
        store.updateTurn(input.turn.id, { internalExecution });
      else store.updateServerTurn(input.turn.id, { internalExecution });
    },
  };
  const input = () => ({
    requestId: randomUUID(),
    actor,
    requestActor,
    trigger: 'request' as const,
    instructions:
      'Integrate the supplied invoice evidence as Rule, Effect and Objective pages. Human Review remains required.',
    sources: [],
    tellContent: evidence,
    signal: new AbortController().signal,
  });
  const maintain = () =>
    scope === 'workspace'
      ? runKnowledgeMaintenanceCommand(dependencies, { ...input(), workspaceId: workspace.id })
      : scope === 'user'
        ? runUserMemoryMaintenanceCommand(dependencies, input())
        : runServerKnowledgeMaintenanceCommand(dependencies, input());
  const invoke = createOperationInvocation({
    ...dependencies,
    repositoryWorkspaceDb: dependencies.openWorkspace,
  });
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    schemaPath,
    activeSchema,
    notebook,
    ownerScope,
    run,
    finish,
    maintain,
    invoke,
    store,
    workspace,
    requestActor,
    userId,
  };
}

describe('bounded typed Knowledge authoring guidance', () => {
  it.each([
    'workspace',
    'user',
    'server',
  ] as const)('delivers the admitted active %s contract and required fields without editable schema authority', async (scope) => {
    const f = fixture(scope);
    let refused = false;
    f.run.mockImplementationOnce(async (run) => {
      try {
        const attempted = await tool(run, 'knowledge.notebook-workspace.update', {
          script: "printf 'status: inactive\\n' > /schema/scope-schema.yaml",
        });
        refused = attempted.exitCode !== 0;
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_request' });
        refused = true;
      }
      await tool(run, 'knowledge.notebook.update', { summary: 'Inspect without changing pages.' });
      return f.finish(run);
    });
    const result = await f.maintain();
    expect(result.outcome).toBe('no-change');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(refused).toBe(true);
    expect(readFileSync(f.schemaPath, 'utf8')).toBe(f.activeSchema);
    const delivered = deliveredText(f.run.mock.calls[0]![0]);
    expect(delivered).not.toContain('UNDISCLOSED-PRIVATE-FIXTURE');
    // Deciding RED: the native request currently contains no admitted active schema contract.
    expect(delivered).toContain(f.activeSchema);
    for (const field of [
      'type',
      'title',
      'schema_version',
      'openkit_status',
      'status',
      'scope',
      'requiredFeatures',
      'source_refs',
      'review_state',
      'sensitivity',
      'freshness',
      'created_at',
      'updated_at',
      'applies_to',
      'basis',
      'last_checked_at',
    ])
      expect(delivered).toContain(field);
    expect(delivered).toMatch(/required/i);
    expect(delivered).toMatch(/(read.only|not.*authority|cannot.*authori)/i);
  }, 120_000);

  it.each([
    'workspace',
    'user',
    'server',
  ] as const)('omits the whole oversized %s contract and exposes a truthful size-bound notice', async (scope) => {
    const f = fixture(scope);
    const oversized =
      f.activeSchema +
      `description: "SCHEMA-BEGIN-${scope}-${'雪'.repeat(6000)}-SCHEMA-END-${scope}"\n`;
    expect(oversized.length).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(16 * 1024);
    expect(parseScopeKnowledgeSchema(oversized).ok).toBe(true);
    writeFileSync(f.schemaPath, oversized);
    const result = await f.maintain();
    expect(result.outcome).toBe('no-change');
    expect(f.run).toHaveBeenCalledTimes(1);
    const delivered = deliveredText(f.run.mock.calls[0]![0]);
    expect(delivered).not.toContain(`ACTIVE-${scope}-CONTRACT`);
    expect(delivered).not.toContain(`SCHEMA-BEGIN-${scope}`);
    expect(delivered).not.toContain(`SCHEMA-END-${scope}`);
    expect(delivered).not.toContain(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
    expect(delivered).not.toContain('UNDISCLOSED-PRIVATE-FIXTURE');
    expect(delivered).toMatch(/(authoring|schema)[\s\S]*(unavailable|size|limit|bound)/i);
    expect(readFileSync(f.schemaPath, 'utf8')).toBe(oversized);
  }, 120_000);

  it('keeps typed source-pinned edits in an exact candidate until the actual human Review', async () => {
    const f = fixture('workspace');
    let references: string[] = [];
    f.run.mockImplementationOnce(async (run) => {
      const payload = JSON.parse((run.messages[0]!.content[0] as { text: string }).text);
      references = payload.sources.map((source: { reference: string }) => source.reference);
      expect(references).toHaveLength(1);
      const script = ['Rule', 'Effect', 'Objective']
        .map(
          (type) =>
            `cat > ${type.toLowerCase()}.md <<'PAGE'\n${page(f.ownerScope, type, references)}PAGE`
        )
        .join('\n');
      expect(await tool(run, 'knowledge.notebook-workspace.update', { script })).toMatchObject({
        exitCode: 0,
        stderr: '',
      });
      await tool(run, 'knowledge.notebook.update', {
        summary: 'Curate the supplied typed invoice evidence.',
      });
      return f.finish(run);
    });
    const result = await f.maintain();
    expect(result.outcome).toBe('review-required');
    const run = f.run.mock.calls[0]![0];
    expect(f.notebook.publishedRevision()).toBe(run.inputs!.baseRevision);
    const candidate = f.notebook.readRevision(result.candidateRevision!);
    expect(candidate.parentRevision).toBe(run.inputs!.baseRevision);
    for (const type of ['Rule', 'Effect', 'Objective']) {
      const parsed = parseOkfDocument({
        path: `${type.toLowerCase()}.md`,
        content: candidate.files[`${type.toLowerCase()}.md`]!,
      });
      expect(parsed.ok).toBe(true);
      expect(parsed.document!.frontmatter.type).toBe(type);
      expect(stringListFrontmatterField(parsed.document!, 'source_refs')).toEqual(references);
      expect(stringListFrontmatterField(parsed.document!, 'applies_to')).toEqual([
        'tool:invoice.check',
        'step:invoice-review',
      ]);
      if (type === 'Effect')
        expect(parsed.document!.frontmatter).toMatchObject({
          basis: 'Observed checks found fewer errors.',
          last_checked_at: NOW,
        });
    }
    const reviewed = await f.invoke(
      'knowledge.proposal.decide',
      {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        proposalId: result.proposalId!,
        decision: 'accepted',
        proposalDigest: f.store.knowledgeProposalDigest(f.workspace.id, result.proposalId!),
        baseRevision: run.inputs!.baseRevision,
        candidateRevision: result.candidateRevision!,
      },
      { kind: 'public', actor: f.requestActor }
    );
    expect(reviewed.review.actor).toEqual({ kind: 'user', id: f.userId });
    expect(f.notebook.publishedRevision()).toBe(candidate.revision);
    expect(f.notebook.readRevision(candidate.revision).files).toEqual(candidate.files);
    // A supplied runner script proves native effects; it cannot prove semantic authoring quality.
    expect(deliveredText(run)).toContain(f.activeSchema);
  }, 120_000);

  it.each([
    ['Rule', 'applies_to'],
    ['Objective', 'applies_to'],
    ['Effect', 'applies_to'],
    ['Effect', 'basis'],
    ['Effect', 'last_checked_at'],
  ])(
    'still refuses %s edits missing %s through the full native validator',
    async (type, missing) => {
      const f = fixture('workspace');
      f.run.mockImplementationOnce(async (run) => {
        const payload = JSON.parse((run.messages[0]!.content[0] as { text: string }).text);
        const references = payload.sources.map((source: { reference: string }) => source.reference);
        expect(
          await tool(run, 'knowledge.notebook-workspace.update', {
            script: `cat > ${type.toLowerCase()}.md <<'PAGE'\n${page(f.ownerScope, type, references, missing)}PAGE`,
          })
        ).toMatchObject({ exitCode: 0 });
        await tool(run, 'knowledge.notebook.update', {
          summary: 'Try the incomplete domain page.',
        });
        return f.finish(run);
      });
      const result = await f.maintain();
      expect(result.outcome).toBe('failed');
      expect(f.run).toHaveBeenCalledTimes(1);
      expect(f.notebook.publishedRevision()).toBe(f.run.mock.calls[0]![0].inputs!.baseRevision);
      expect(f.store.listKnowledgeProposals(f.workspace.id)).toEqual([]);
      expect(
        f.notebook.readRevision(f.notebook.publishedRevision()).files[`${type.toLowerCase()}.md`]
      ).toBeUndefined();
    },
    120_000
  );
});
