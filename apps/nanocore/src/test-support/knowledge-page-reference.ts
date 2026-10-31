import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { readWorkspaceNotebookAdmission } from '../knowledge/notebook-workspace-admission.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { resolveWorkspaceKnowledgeReferenceProofs } from '../knowledge-source-authority.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-products.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createDemoWorkspaceForUser } from './demo-store.js';
import { serializeKnowledgePageFixture } from './knowledge-page.js';
import { ensureLocalUser } from './local-user.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
} from './store.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const userId = 'usr_00000000-0000-7000-8000-000000000001';
const knowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';
const targetId = 'group/note';

/** Exact fixture bytes are stored in real immutable Git objects. */
export function referencePage(
  references: readonly string[] = [],
  body = 'Selected page bytes.'
): string {
  return serializeKnowledgePageFixture(
    {
      title: 'Reference fixture',
      content: body,
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      sourceReferences: references,
    },
    { kind: 'workspace', workspaceId }
  );
}

/**
 * Injects exact immutable-content corruption into an existing admitted Notebook head.
 * Source-proof tests use this only after genuine Workspace creation; invalid citations
 * cannot acquire publication authority through the normal validating writer.
 * No Audit, receipt, schema binding, or successful publication is fabricated.
 * @param workspaceDb Existing private fixture handle with no concurrent writer.
 * @param knowledgeBaseId Exact admitted base whose existing row is faulted.
 * @param notebookCommit Prepared immutable fault bytes; no Git ref is advanced.
 * @returns Restores the complete original head row after the fault probe.
 */
function corruptTestNotebookCommit(
  workspaceDb: WorkspaceDb,
  knowledgeBaseId: string,
  notebookCommit: string
): () => void {
  const original = workspaceDb.sqlite
    .prepare('SELECT record_json FROM knowledge_notebook_heads WHERE knowledge_base_id = ?')
    .get(knowledgeBaseId) as { record_json: string } | undefined;
  if (!original) throw new Error('Notebook corruption requires an existing native head.');
  const changed = workspaceDb.sqlite
    .prepare(
      "UPDATE knowledge_notebook_heads SET record_json = json_set(record_json, '$.notebookCommit', ?) WHERE knowledge_base_id = ? AND record_json = ?"
    )
    .run(notebookCommit, knowledgeBaseId, original.record_json);
  if (changed.changes !== 1) throw new Error('Notebook corruption lost its exact fixture row.');
  const faulted = workspaceDb.sqlite
    .prepare('SELECT record_json FROM knowledge_notebook_heads WHERE knowledge_base_id = ?')
    .get(knowledgeBaseId) as { record_json: string };
  return () => {
    const restored = workspaceDb.sqlite
      .prepare(
        'UPDATE knowledge_notebook_heads SET record_json = ? WHERE knowledge_base_id = ? AND record_json = ?'
      )
      .run(original.record_json, knowledgeBaseId, faulted.record_json);
    if (restored.changes !== 1)
      throw new Error('Notebook corruption restoration lost its exact fixture row.');
  };
}

/** Admits valid source citations natively; negative probes explicitly corrupt retained content afterward. */
export async function createPageReferenceFixture(
  references: readonly string[],
  corruptReferences = false
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-page-reference-'));
  const store = createTestStore({ dataRoot });
  const coreDb = createTestCoreDb(dataRoot);
  ensureLocalUser(coreDb);
  let workspaceDb: ReturnType<typeof createTestWorkspaceDb> | undefined;
  const restoreFaults: Array<() => void> = [];
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(dataRoot);
    for (const restore of restoreFaults.reverse()) restore();
    if (workspaceDb) closeTestCoreDb(workspaceDb);
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const configPath = join(workspaceRoot, 'config', 'workspace.jsonc');
  const demo = createDemoWorkspaceForUser(userId);
  await store.importWorkspaceSnapshot({
    workspace: demo.workspace,
    defaultKnowledgeBaseId: knowledgeBaseId,
    threads: [demo.thread],
    knowledge: [],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
    notebookInitialization: {
      requestId: randomUUID(),
      producer: { kind: 'user', id: userId },
      instructionReference: 'test:page-reference',
    },
    initialNotebookFiles: {
      'index.md': '---\nokf_version: "0.2"\n---\n# Notebook\n',
      'a.md': referencePage(corruptReferences ? [] : references),
      [`${targetId}.md`]: referencePage(),
    },
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  workspaceDb = createTestWorkspaceDb(dataRoot, workspaceId);
  const selection = readWorkspaceNotebookSelection({ workspaceDb, workspaceRoot, knowledgeBaseId });
  const notebook = selection.notebook;
  const metadata = {
    summary: 'Page reference fixture',
    changeRequest: { requestId: 'fixture', inputDigest: `sha256:${'1'.repeat(64)}` },
    producer: { kind: 'user' as const, id: userId },
    authority: { kind: 'direct' as const, instructionReference: 'test:page-reference' },
    sourceReferences: [],
  };
  const selectCorruptRevision = (commit: string) => {
    restoreFaults.push(corruptTestNotebookCommit(workspaceDb!, knowledgeBaseId, commit));
  };
  // Only negative probes replace already admitted content, without success evidence.
  const revision = corruptReferences
    ? await notebook.prepare({
        baseRevision: selection.head.notebookCommit,
        metadata,
        changes: { 'a.md': referencePage(references) },
      })
    : selection.head.notebookCommit;
  if (corruptReferences) selectCorruptRevision(revision);
  const proofs = (selected = revision) =>
    resolveWorkspaceKnowledgeReferenceProofs({
      coreDb,
      workspaceDb,
      store,
      workspaceId,
      notebookRevision: selected,
      pageIds: ['a'],
    });
  const admit = (changes = [{ path: 'a.md', content: referencePage(references) }]) =>
    readWorkspaceNotebookAdmission({
      store,
      coreDb,
      workspaceDb: workspaceDb!,
      currentAuthority: () => {},
      actor: { kind: 'user', id: userId },
      runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      scopeSchemaText: selection.scopeSchemaText,
      notebook: readWorkspaceNotebookSelection({
        workspaceDb: workspaceDb!,
        workspaceRoot,
        knowledgeBaseId,
      }).notebook,
      request: {
        workspaceId,
        requestId: 'fixture',
        baseRevision: revision,
        changes,
        summary: 'Reference edit',
      },
    });
  return { proofs, admit, notebook, revision, configPath, metadata, selectCorruptRevision };
}
