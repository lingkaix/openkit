// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { restoreDataRootBackup, writeHotDataRootBackup } from '../storage/data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID, readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { retrieveWorkspaceKnowledge } from '../storage/index-rebuild.js';
import { applyMigrations } from '../storage/migrate.js';
import { allocateRetrievalTraceId, readRetrievalTrace } from '../storage/retrieval-traces.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { readWorkspacePortableFileState } from '../storage/workspace-portable-file-state.js';
import {
  createVerifiedWorkspaceExport,
  importVerifiedWorkspace,
} from '../storage/workspace-transfer-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';
import { parseOkfDocument, updateOkfFrontmatter } from './okf.js';

const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real deployment and ordinary creation keep import authority separate from archived content. */
function deployment() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-notebook-workspace-portability-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  return { dataRoot, coreDb, store };
}

/** Publish test-owned bytes through Git; no fixture file is a canonical page. */
function source() {
  const f = deployment();
  const workspace = f.store.createWorkspace('Portable Notebook', {
    requestId: randomUUID(),
    producer: { kind: 'user', id: LOCAL_USER_ID },
    instructionReference: 'test:workspace-create',
  });
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: workspace.id,
    ownerUserId: LOCAL_USER_ID,
  });
  const root = join(f.dataRoot, 'workspaces', workspace.id);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(root, 'knowledge', 'notebook.git'),
  });
  const content = updateOkfFrontmatter({
    path: 'notes/portable.md',
    content: serializeUserAuthoredKnowledgePage(
      {
        id: 'notes/portable',
        kind: 'project-context',
        title: 'Exact portable note',
        content: 'Exact Unicode body: 漢字.\r\n\t  ',
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
        sourceReferences: [],
      },
      { kind: 'workspace', workspaceId: workspace.id }
    ),
    updates: { custom: { preserve: ['one', 'two'] } },
  });
  const baseRevision = notebook.publishedRevision();
  const revision = notebook.prepare({
    baseRevision,
    changes: { 'notes/portable.md': content },
    metadata: {
      summary: 'Test-owned portable page',
      producer: { kind: 'user', id: LOCAL_USER_ID },
      authority: { kind: 'direct', instructionReference: 'test:portable-page' },
      changeRequest: {
        requestId: randomUUID(),
        inputDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      },
      sourceReferences: [],
    },
  });
  notebook.publish({ baseRevision, candidateRevision: revision });
  return { ...f, workspace, root, notebook, content, revision };
}

describe('canonical Notebook Workspace portability', () => {
  it('exports one published Git tree and the actual scope schema, ignoring stale page files', () => {
    const f = source();
    mkdirSync(join(f.root, 'knowledge', 'pages'), { recursive: true });
    writeFileSync(
      join(f.root, 'knowledge', 'pages', 'stale.md'),
      'Unpublished stale materialization.'
    );
    const state = readWorkspacePortableFileState(f.root, {
      workspaceId: f.workspace.id,
      threads: [],
      turns: [],
    });
    expect([...state.nativeKnowledgePages.keys()].sort()).toEqual([
      'knowledge/pages/index.md',
      'knowledge/pages/notes/portable.md',
    ]);
    expect(state.nativeKnowledgePages.get('knowledge/pages/notes/portable.md')).toBe(f.content);
    expect(state.workspaceSchema).toBe(
      readFileSync(join(f.root, 'knowledge', 'schema', 'scope-schema.yaml'), 'utf8')
    );
  });

  it('rebuilds a new target Notebook through the existing verified Workspace archive import', () => {
    const f = source();
    const target = deployment();
    target.store.createWorkspace('Existing target forces remint', {
      requestId: randomUUID(),
      producer: { kind: 'user', id: LOCAL_USER_ID },
      instructionReference: 'test:existing-target',
    });
    const exported = createVerifiedWorkspaceExport({
      authorityUserId: LOCAL_USER_ID,
      authorityActor: { kind: 'user', id: LOCAL_USER_ID },
      requestActor: { kind: 'local', userId: LOCAL_USER_ID },
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
      store: f.store,
      workspaceId: f.workspace.id,
    });
    const imported = importVerifiedWorkspace({
      authorityUserId: LOCAL_USER_ID,
      coreDb: target.coreDb,
      dataRoot: target.dataRoot,
      requestId: randomUUID(),
      store: target.store,
      verified: exported.verified,
    });
    expect(exported.verified.manifest.knowledgeNotebookRevision).toBe(f.revision);
    const targetRoot = join(target.dataRoot, 'workspaces', imported.workspace.id);
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(targetRoot, 'knowledge', 'notebook.git'),
    });
    const current = notebook.readRevision(notebook.publishedRevision());
    const page = parseOkfDocument({
      path: 'notes/portable.md',
      content: current.files['notes/portable.md']!,
    });
    const original = parseOkfDocument({ path: 'notes/portable.md', content: f.content });
    expect(page.ok && original.ok).toBe(true);
    expect(page.document?.body).toBe(original.document?.body);
    expect(page.document?.frontmatter).toMatchObject({
      scope: { kind: 'workspace', workspaceId: imported.workspace.id },
      custom: { preserve: ['one', 'two'] },
    });
    expect(imported.workspace.id).not.toBe(f.workspace.id);
    expect(current.parentRevision).toBeNull();
    expect(current.metadata.producer).toEqual({ kind: 'user', id: LOCAL_USER_ID });
    expect(current.metadata.authority).toEqual({
      kind: 'direct',
      instructionReference: `workspace.import:${exported.verified.manifest.id}:notebook:${f.revision}`,
    });
    expect(current.revision).not.toBe(f.revision);
    expect(existsSync(join(targetRoot, 'knowledge', 'pages'))).toBe(false);
    expect(
      new KnowledgeNotebook({
        repositoryPath: join(f.root, 'knowledge', 'notebook.git'),
      }).publishedRevision()
    ).toBe(f.revision);
  });

  it('remints a retained current-revision Knowledge selection into the imported Notebook', async () => {
    const f = source();
    const thread = f.store.createThread(f.workspace.id, 'Portable trace', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const selected = await retrieveWorkspaceKnowledge({
      dataRoot: f.dataRoot,
      workspaceId: f.workspace.id,
      caller: 'app-api',
      query: 'Exact portable note',
      limit: 1,
      pinnedReferences: [{ scopeId: `page/workspace/${f.workspace.id}`, objectId: 'notes/portable' }],
      access: {
        store: f.store,
        coreDb: f.coreDb,
        actor: { kind: 'user', id: LOCAL_USER_ID },
        requestActor: { kind: 'local', userId: LOCAL_USER_ID },
        outputThreadId: thread.id,
      },
      traceId: allocateRetrievalTraceId(),
    });
    expect(selected.selected).toEqual([
      expect.objectContaining({ revision: f.revision, contentDigest: `sha256:${createHash('sha256').update(f.content).digest('hex')}` }),
    ]);
    expect(selected.retrievalTraceRef).toBeDefined();
    const exported = createVerifiedWorkspaceExport({
      authorityUserId: LOCAL_USER_ID,
      authorityActor: { kind: 'user', id: LOCAL_USER_ID },
      requestActor: { kind: 'local', userId: LOCAL_USER_ID },
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
      store: f.store,
      workspaceId: f.workspace.id,
    });
    const target = deployment();
    const imported = importVerifiedWorkspace({
      authorityUserId: LOCAL_USER_ID,
      coreDb: target.coreDb,
      dataRoot: target.dataRoot,
      requestId: randomUUID(),
      store: target.store,
      verified: exported.verified,
    });
    const importedThread = target.store.listThreads(imported.workspace.id).find((entry) => entry.name === thread.name);
    expect(importedThread).toBeDefined();
    const targetRoot = join(target.dataRoot, 'workspaces', imported.workspace.id);
    const notebook = new KnowledgeNotebook({ repositoryPath: join(targetRoot, 'knowledge', 'notebook.git') });
    const revision = notebook.publishedRevision();
    const page = notebook.readRevision(revision).files['notes/portable.md']!;
    const trace = readRetrievalTrace(targetRoot, {
      scopeId: `retrieval-trace/thread/${imported.workspace.id}/${importedThread!.id}`,
      objectId: selected.retrievalTraceRef!.objectId,
    });
    expect(trace).toMatchObject({
      notebookRevision: revision,
      selected: [{
        reference: { scopeId: `page/workspace/${imported.workspace.id}`, objectId: 'notes/portable' },
        revision,
        contentDigest: `sha256:${createHash('sha256').update(page).digest('hex')}`,
      }],
    });
    expect(page).toContain('Exact Unicode body: 漢字.');
    expect(exported.verified.manifest.knowledgeNotebookRevision).toBe(f.revision);
  });

  it('retains published and unpublished Git content and existing Audit in the ordinary same-deployment backup', async () => {
    const f = source();
    const unpublished = f.notebook.prepare({
      baseRevision: f.revision,
      changes: { 'notes/portable.md': `${f.content}Unpublished candidate bytes.\n` },
      metadata: {
        summary: 'Unpublished test candidate',
        producer: { kind: 'user', id: LOCAL_USER_ID },
        authority: { kind: 'direct', instructionReference: 'test:unpublished-backup' },
        changeRequest: {
          requestId: randomUUID(),
          inputDigest: `sha256:${createHash('sha256').update('candidate').digest('hex')}`,
        },
        sourceReferences: [],
      },
    });
    const destination = mkdtempSync(join(tmpdir(), 'openkit-notebook-backup-'));
    roots.push(destination);
    const backupRoot = join(destination, 'backup');
    const restoredRoot = join(destination, 'restored');
    const originalDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
    const originalAudit = originalDb.sqlite
      .prepare('SELECT * FROM audit_events ORDER BY audit_event_id')
      .all();
    originalDb.sqlite.close();
    expect(originalAudit).toHaveLength(2);
    const timestamp = '2026-10-16T00:00:00.000Z';
    await writeHotDataRootBackup({
      dataRoot: f.dataRoot,
      backupRoot,
      backupId: randomUUID(),
      sourceDeploymentId: readDataRootLayoutMarker(f.dataRoot).deploymentId,
      startedAt: timestamp,
      completedAt: timestamp,
    });
    restoreDataRootBackup({ backupRoot, dataRoot: restoredRoot });
    const restored = new KnowledgeNotebook({
      repositoryPath: join(restoredRoot, 'workspaces', f.workspace.id, 'knowledge', 'notebook.git'),
    });
    expect(restored.validateRetainedGraph().publishedRevision).toBe(f.revision);
    expect(restored.readRevision(f.revision).files['notes/portable.md']).toBe(f.content);
    expect(restored.readRevision(unpublished).files['notes/portable.md']).toBe(
      `${f.content}Unpublished candidate bytes.\n`
    );
    const restoredDb = openWorkspaceDb(restoredRoot, f.workspace.id);
    try {
      expect(
        restoredDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all()
      ).toEqual(originalAudit);
    } finally {
      restoredDb.sqlite.close();
    }
    expect(new FsStore({ dataRoot: restoredRoot }).getWorkspace(f.workspace.id).id).toBe(
      f.workspace.id
    );
    expect(f.notebook.publishedRevision()).toBe(f.revision);
  });
});
