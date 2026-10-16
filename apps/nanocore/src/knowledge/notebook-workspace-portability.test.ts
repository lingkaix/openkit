// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { parseOkfDocument, updateOkfFrontmatter } from './okf.js';
import { readWorkspacePortableFileState } from '../storage/workspace-portable-file-state.js';
import { createVerifiedWorkspaceExport, importVerifiedWorkspace } from '../storage/workspace-transfer-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';

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
  recordWorkspaceOwnerMembership({ coreDb: f.coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
  const root = join(f.dataRoot, 'workspaces', workspace.id);
  const notebook = new KnowledgeNotebook({ repositoryPath: join(root, 'knowledge', 'notebook.git') });
  const content = updateOkfFrontmatter({
    path: 'notes/portable.md',
    content: serializeUserAuthoredKnowledgePage({
      id: 'notes/portable', kind: 'project-context', title: 'Exact portable note',
      content: 'Exact Unicode body: 漢字.\r\n\t  ',
      createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z',
      sourceReferences: [],
    }, { kind: 'workspace', workspaceId: workspace.id }),
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
      changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${createHash('sha256').update(content).digest('hex')}` },
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
    writeFileSync(join(f.root, 'knowledge', 'pages', 'stale.md'), 'Unpublished stale materialization.');
    const state = readWorkspacePortableFileState(f.root, { workspaceId: f.workspace.id, threads: [], turns: [] });
    expect([...state.nativeKnowledgePages.keys()].sort()).toEqual(['knowledge/pages/index.md', 'knowledge/pages/notes/portable.md']);
    expect(state.nativeKnowledgePages.get('knowledge/pages/notes/portable.md')).toBe(f.content);
    expect(state.workspaceSchema).toBe(readFileSync(join(f.root, 'knowledge', 'schema', 'scope-schema.yaml'), 'utf8'));
  });

  it('rebuilds a new target Notebook through the existing verified Workspace archive import', () => {
    const f = source();
    const target = deployment();
    target.store.createWorkspace('Existing target forces remint', {
      requestId: randomUUID(), producer: { kind: 'user', id: LOCAL_USER_ID },
      instructionReference: 'test:existing-target',
    });
    const exported = createVerifiedWorkspaceExport({
      authorityUserId: LOCAL_USER_ID,
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
    const notebook = new KnowledgeNotebook({ repositoryPath: join(targetRoot, 'knowledge', 'notebook.git') });
    const current = notebook.readRevision(notebook.publishedRevision());
    const page = parseOkfDocument({ path: 'notes/portable.md', content: current.files['notes/portable.md']! });
    const original = parseOkfDocument({ path: 'notes/portable.md', content: f.content });
    expect(page.ok && original.ok).toBe(true);
    expect(page.document?.body).toBe(original.document?.body);
    expect(page.document?.frontmatter).toMatchObject({ scope: { kind: 'workspace', workspaceId: imported.workspace.id }, custom: { preserve: ['one', 'two'] } });
    expect(imported.workspace.id).not.toBe(f.workspace.id);
    expect(current.parentRevision).toBeNull();
    expect(current.metadata.producer).toEqual({ kind: 'user', id: LOCAL_USER_ID });
    expect(current.metadata.authority).toEqual({ kind: 'direct', instructionReference: `workspace.import:${exported.verified.manifest.id}:notebook:${f.revision}` });
    expect(current.revision).not.toBe(f.revision);
    expect(existsSync(join(targetRoot, 'knowledge', 'pages'))).toBe(false);
    expect(new KnowledgeNotebook({ repositoryPath: join(f.root, 'knowledge', 'notebook.git') }).publishedRevision()).toBe(f.revision);
  });
});
