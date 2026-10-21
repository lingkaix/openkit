// openkit-test-platform: posix
// The runner double proves context assembly and native effects, not model comprehension.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import type { KnowledgeManagerAgentRun } from '../internal-agents/knowledge-manager-agent.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import type { KnowledgeMaintenanceDependencies } from './knowledge-agent-maintenance.js';
import { runKnowledgeMaintenanceCommand } from './knowledge-maintenance-command.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, stringListFrontmatterField } from './okf.js';
import { readSourcePointers } from './source-pointers.js';

const emptyIndex = '---\nokf_version: "0.2"\n---\n# Notebook\n';
const authoredIndex =
  '---\nokf_version: "0.2"\n---\n# Human project overview\n\nKeep cobalt labels.\n';
const original = Array.from({ length: 17 }, (_, index) =>
  [
    `SOURCE FILE ${index + 1}: project/note-${index + 1}.md\r\n`,
    `The release label is COBALT-${index + 1}. Human Review remains required. Ω 雪.\r\n`,
    `Project evidence ${index + 1}. `.repeat(90),
    '\n',
  ].join('')
).join('\n');

/** Hash independently from the native Source and Proposal readers. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content)).digest('hex')}`;
}

/** Author valid source-free or source-pinned page bytes before the candidate exists. */
function page(workspaceId: string, title: string, content: string, references: string[] = []) {
  return serializeKnowledgePageFixture(
    {
      title,
      content,
      sourceReferences: references,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    },
    { kind: 'workspace', workspaceId }
  );
}

/** Read the actual assembled role input; this observation does not classify model output. */
function payload(run: KnowledgeManagerAgentRun) {
  return JSON.parse(
    run.messages[0]!.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  ) as {
    instructions: string;
    notebookRevision: string;
    overview: { content: string; truncated: boolean };
    humanEdits: {
      truncated: boolean;
      changes: Array<{ path: string; before: string | null; after: string | null }>;
    };
    sources: Array<{ reference: string; file: string; content: string; truncated: boolean }>;
  };
}

/** Cross the real virtual editor or publisher with the same trusted run context. */
async function tool(run: KnowledgeManagerAgentRun, name: string, value: unknown) {
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

/** Native creation/import, public admission, Source capture and fixed-base publication share real owners. */
async function fixture(initial: 'empty' | 'authored-index' | 'authored-page' = 'empty') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'tell-intake-framing-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user' as const, id: userId };
  const store = new FsStore({ dataRoot });
  const initialization = {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'fixture:human-workspace-creation',
  };
  const imported = await new FsStore().createWorkspace('Authored initial notebook');
  const initialFiles: Record<string, string> =
    initial === 'authored-index'
      ? { 'index.md': authoredIndex }
      : {
          'index.md': emptyIndex,
          'initial-note.md': page(imported.id, 'Initial note', 'Actual authored initial content.'),
        };
  const workspace =
    initial === 'empty'
      ? await store.createWorkspace('Fresh public tell', initialization)
      : await store.importWorkspaceSnapshot({
          workspace: imported,
          threads: [],
          turns: [],
          knowledge: [],
          itemRevisions: [],
          artifacts: [],
          agentSessions: [],
          turnEvents: [],
          notebookInitialization: initialization,
          initialNotebookFiles: initialFiles,
        });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot }),
  });
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const finish = async (run: KnowledgeManagerAgentRun) => {
    expect(
      run.validateResult('{"summary":"Finished the native notebook operation."}')
    ).toBeUndefined();
    await store.updateTurn(run.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    return { turnId: run.turn.id, text: '{"summary":"Finished the native notebook operation."}' };
  };
  const run = vi.fn(async (input: KnowledgeManagerAgentRun) => {
    await tool(input, 'knowledge.notebook.update', { summary: 'No page changes are needed.' });
    return finish(input);
  });
  const dependencies: KnowledgeMaintenanceDependencies = {
    store,
    coreDb,
    runtimeConfigManager,
    workspaceMutationAdmission,
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    inflightCommands: new WeakMap(),
    run,
    pin: async (input) => {
      await store.updateTurn(input.turn.id, {
        internalExecution: {
          roleId: 'knowledge-manager',
          logicalModelId: 'fixture-role-model',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
          contextStrategy: 'compaction',
          threshold: 64_000,
          knowledge: input.inputs!,
        },
      });
    },
  };
  const invoke = createOperationInvocation({
    ...dependencies,
    repositoryWorkspaceDb: dependencies.openWorkspace,
    knowledgeAgent: {
      ask: async () => {
        throw new Error('Tell intake must not invoke a query.');
      },
      maintain: (input) => runKnowledgeMaintenanceCommand(dependencies, input),
    },
  });
  const context = { kind: 'public' as const, actor: { kind: 'local' as const, userId } };
  onTestFinished(async () => {
    await closeRetrievalServices();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { dataRoot, store, workspace, notebook, run, finish, invoke, context };
}

describe('public Workspace tell intake framing', () => {
  it('delivers novel multi-file text intact and keeps the generated empty seed out of human edits', async () => {
    const f = await fixture();
    const initialRevision = f.notebook.publishedRevision();
    const initial = f.notebook.readRevision(initialRevision);
    expect(initial.parentRevision).toBeNull();
    expect(initial.metadata.producer).toEqual({ kind: 'user', id: f.context.actor.userId });
    expect(initial.files).toEqual({ 'index.md': emptyIndex });
    expect(Buffer.byteLength(original)).toBeGreaterThan(30_000);
    expect(original.match(/SOURCE FILE /g)).toHaveLength(17);
    let editorSource: unknown;
    let submitted: unknown;
    let expectedPages: Record<string, string> = {};
    f.run.mockImplementationOnce(async (run) => {
      const supplied = payload(run).sources[0]!;
      editorSource = await tool(run, 'knowledge.notebook-workspace.update', {
        script: `cat ${supplied.file}`,
      });
      expectedPages = {
        'labels.md': page(f.workspace.id, 'Release labels', 'The release label is COBALT-1.', [
          supplied.reference,
        ]),
        'review.md': page(f.workspace.id, 'Review policy', 'Human Review remains required.', [
          supplied.reference,
        ]),
      };
      const script = Object.entries(expectedPages)
        .map(([path, content]) => `cat > ${path} <<'PAGE'\n${content}PAGE`)
        .join('\n');
      const edited = await tool(run, 'knowledge.notebook-workspace.update', {
        script: `${script}\nprintf '\\n[Release labels](labels.md)\\n[Review policy](review.md)\\n' >> index.md`,
      });
      expect(edited).toMatchObject({ exitCode: 0, stderr: '' });
      submitted = await tool(run, 'knowledge.notebook.update', {
        summary: 'Integrate supplied project evidence.',
      });
      return f.finish(run);
    });
    const request = {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      content: original,
      sources: [],
    };
    const result = await f.invoke('knowledge.tell', request, f.context);
    expect(result.outcome).toBe('review-required');
    expect(f.run).toHaveBeenCalledTimes(1);
    const run = f.run.mock.calls[0]![0];
    const assembled = payload(run);
    expect(assembled.instructions).toMatch(/integrate.*supplied information/i);
    expect(assembled.overview).toMatchObject({ content: emptyIndex, truncated: false });
    expect(assembled.sources).toHaveLength(1);
    const supplied = assembled.sources[0]!;
    expect(supplied).toMatchObject({ content: original, truncated: false });
    expect(supplied.reference).toMatch(new RegExp(`@${digest(original)}$`));
    expect(editorSource).toMatchObject({ exitCode: 0, stdout: original, truncated: false });
    const base = run.inputs!.baseRevision;
    expect(assembled.notebookRevision).toBe(base);
    expect(f.notebook.inspectRevision(base).parentRevision).toBe(initialRevision);
    const sources = f.store.listKnowledgeSources(f.workspace.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.contentDigest).toBe(digest(original));
    const captured = await f.invoke(
      'knowledge.source.read',
      { workspaceId: f.workspace.id, sourceId: sources[0]!.id },
      f.context
    );
    expect(captured.source.contentDigest).toBe(digest(original));
    const pointer = readSourcePointers(
      {
        dataRoot: f.dataRoot,
        ownerScope: { kind: 'workspace', workspaceId: f.workspace.id },
      },
      base
    ).get(sources[0]!.id)!;
    expect(pointer.fields.byteLength).toBe(Buffer.byteLength(original));
    expect(
      readFileSync(
        join(
          f.dataRoot,
          'workspaces',
          f.workspace.id,
          'knowledge',
          'raw',
          pointer.fields.contentRef.locator.path
        )
      )
    ).toEqual(Buffer.from(original));
    expect(submitted).toMatchObject({
      outcome: 'review_required',
      baseRevision: base,
      candidateRevision: result.candidateRevision,
    });
    expect(f.notebook.publishedRevision()).toBe(base);
    const candidate = f.notebook.readRevision(result.candidateRevision!);
    expect(candidate.parentRevision).toBe(base);
    for (const [path, requested] of Object.entries(expectedPages)) {
      const parsed = parseOkfDocument({ path, content: candidate.files[path]! });
      const expected = parseOkfDocument({ path, content: requested });
      expect(parsed.ok).toBe(true);
      expect(parsed.document!.body).toBe(expected.document!.body);
      expect(parsed.document!.frontmatter.review_state).toBe('delegated');
      expect(stringListFrontmatterField(parsed.document!, 'source_refs')).toEqual([
        supplied.reference,
      ]);
    }
    expect(candidate.files['index.md']).toContain('[Review policy](review.md)');
    const proposal = f.store.projectKnowledgeProposalDraft(f.workspace.id, result.proposalId!);
    expect(proposal).toMatchObject({ baseRevision: base, candidateRevision: candidate.revision });
    const accepted = await f.invoke(
      'knowledge.proposal.decide',
      {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        proposalId: result.proposalId!,
        decision: 'accepted',
        proposalDigest: f.store.knowledgeProposalDigest(f.workspace.id, result.proposalId!),
        baseRevision: base,
        candidateRevision: candidate.revision,
      },
      f.context
    );
    expect(accepted.review.actor).toEqual({ kind: 'user', id: f.context.actor.userId });
    expect(f.notebook.publishedRevision()).toBe(candidate.revision);
    expect(f.notebook.readRevision(candidate.revision).files).toEqual(candidate.files);
    expect(await f.invoke('knowledge.tell', request, f.context)).toEqual(result);
    expect(f.run).toHaveBeenCalledTimes(1);

    // A fresh duplicate is allowed to submit the unchanged editor, with no forced candidate or retry.
    const duplicate = await f.invoke(
      'knowledge.tell',
      { ...request, requestId: randomUUID(), sources: [supplied.reference] },
      f.context
    );
    expect(duplicate.outcome).toBe('no-change');
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.notebook.readRevision(duplicate.notebookRevision).files).toEqual(candidate.files);
    expect(f.store.listKnowledgeProposals(f.workspace.id)).toHaveLength(1);

    // Deciding RED: the observed defect labels the generated root seed as an authored correction.
    expect(assembled.humanEdits).toEqual({ truncated: false, changes: [] });
  }, 120_000);

  it.each([
    'authored-index',
    'authored-page',
  ] as const)('retains %s root content and genuine later human edits as inputs', async (initial) => {
    const f = await fixture(initial);
    const root = f.notebook.readRevision(f.notebook.publishedRevision());
    const later = page(f.workspace.id, 'Later human note', 'Preserve this later human correction.');
    await f.invoke(
      'knowledge.notebook.update',
      {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        baseRevision: root.revision,
        changes: [{ path: 'later.md', content: later }],
        summary: 'Record a real later human correction.',
      },
      f.context
    );
    const result = await f.invoke(
      'knowledge.tell',
      {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        content: 'Inspect these human notebook changes.',
        sources: [],
      },
      f.context
    );
    expect(result.outcome).toBe('no-change');
    expect(f.run).toHaveBeenCalledTimes(1);
    const assembled = payload(f.run.mock.calls[0]![0]);
    expect(assembled.humanEdits.truncated).toBe(false);
    expect(assembled.humanEdits.changes).toContainEqual({
      path: 'later.md',
      before: null,
      after: later,
    });
    for (const [path, content] of Object.entries(root.files))
      expect(assembled.humanEdits.changes).toContainEqual({ path, before: null, after: content });
    expect(f.notebook.readRevision(result.notebookRevision).files).toEqual({
      ...root.files,
      'later.md': later,
    });
  }, 120_000);
});
