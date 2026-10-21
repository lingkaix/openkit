// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { restoreDataRootBackup, writeHotDataRootBackup } from '../storage/data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { retrieveWorkspaceKnowledge } from '../storage/index-rebuild.js';
import { applyMigrations } from '../storage/migrate.js';
import { allocateRetrievalTraceId, readRetrievalTrace } from '../storage/retrieval-traces.js';
import { readWorkspacePortableFileState } from '../storage/workspace-portable-file-state.js';
import {
  createVerifiedWorkspaceExport,
  importVerifiedWorkspace,
} from '../storage/workspace-transfer-routes.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { unresolvedNotebookSubjects } from './conflicts.js';
import { KnowledgeNotebook } from './notebook.js';
import { remintPortableWorkspaceNotebookPages } from './notebook-workspace-portability.js';
import { parseOkfDocument, updateOkfFrontmatter } from './okf.js';

const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await shutdownControlStoreWorkerClient();
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
async function source() {
  const f = deployment();
  const workspace = await f.store.createWorkspace('Portable Notebook', {
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
    content: serializeKnowledgePageFixture(
      {
        title: 'Exact portable note',
        content: 'Exact Unicode body: 漢字.\r\n\t  ',
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
        sourceReferences: [],
      },
      { kind: 'workspace', workspaceId: workspace.id }
    ),
    updates: { custom: { preserve: ['one', 'two'] } },
  }).replace(/^openkit_entry_(?:id|kind):.*\n/gm, '');
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
  it('remints exact dependent page pins after scope and captured Source identity change', () => {
    const sourceWorkspaceId = allocateEntityId('ws');
    const targetWorkspaceId = allocateEntityId('ws');
    const sourceKnowledgeBaseId = allocateEntityId('kb');
    const targetKnowledgeBaseId = allocateEntityId('kb');
    const sourcePageScope = `page/workspace/${sourceWorkspaceId}/${sourceKnowledgeBaseId}`;
    const targetPageScope = `page/workspace/${targetWorkspaceId}/${targetKnowledgeBaseId}`;
    const sourceId = allocateEntityId('ks');
    const targetSourceId = allocateEntityId('ks');
    const capturedDigest = `sha256:${createHash('sha256').update('Captured evidence.').digest('hex')}`;
    const hash = (content: string) =>
      `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const page = (id: string, sourceReferences: string[]) =>
      updateOkfFrontmatter({
        path: `${id}.md`,
        content: serializeKnowledgePageFixture(
          {
            title: id,
            content: `Exact ${id} body.\r\n\t  `,
            sourceReferences,
            createdAt: '2026-10-16T00:00:00Z',
            updatedAt: '2026-10-16T00:00:00Z',
          },
          { kind: 'workspace', workspaceId: sourceWorkspaceId }
        ),
        updates: { custom: { retained: ['original', 'metadata'] } },
      });
    const evidence = page('evidence', [`source:${sourceId}@${capturedDigest}`]);
    const dependent = page('dependent', [
      formatReferenceUri({ scopeId: sourcePageScope, objectId: 'evidence' }, hash(evidence)),
    ]);
    const summary = page('summary', [
      formatReferenceUri({ scopeId: sourcePageScope, objectId: 'dependent' }, hash(dependent)),
    ]);
    const pages = new Map([
      ['knowledge/pages/summary.md', summary],
      ['knowledge/pages/dependent.md', dependent],
      ['knowledge/pages/evidence.md', evidence],
    ]);
    const reminted = remintPortableWorkspaceNotebookPages({
      pages,
      sourceWorkspaceId,
      targetWorkspaceId,
      sourceKnowledgeBaseId,
      targetKnowledgeBaseId,
      rewriteReferences: (references) =>
        references.map((reference) => reference.replaceAll(sourceId, targetSourceId)),
    });
    const targetEvidence = updateOkfFrontmatter({
      path: 'evidence.md',
      content: evidence,
      updates: {
        scope: { kind: 'workspace', workspaceId: targetWorkspaceId },
        source_refs: [`source:${targetSourceId}@${capturedDigest}`],
      },
    });
    const targetDependent = updateOkfFrontmatter({
      path: 'dependent.md',
      content: dependent,
      updates: {
        scope: { kind: 'workspace', workspaceId: targetWorkspaceId },
        source_refs: [
          formatReferenceUri(
            { scopeId: targetPageScope, objectId: 'evidence' },
            hash(targetEvidence)
          ),
        ],
      },
    });
    expect(reminted.pages.get('knowledge/pages/evidence.md')).toBe(targetEvidence);
    expect(reminted.pages.get('knowledge/pages/dependent.md')).toBe(targetDependent);
    expect(reminted.pages.get('knowledge/pages/summary.md')).toBe(
      updateOkfFrontmatter({
        path: 'summary.md',
        content: summary,
        updates: {
          scope: { kind: 'workspace', workspaceId: targetWorkspaceId },
          source_refs: [
            formatReferenceUri(
              { scopeId: targetPageScope, objectId: 'dependent' },
              hash(targetDependent)
            ),
          ],
        },
      })
    );
    expect(
      reminted.referenceReplacements.get(
        formatReferenceUri({ scopeId: sourcePageScope, objectId: 'evidence' }, hash(evidence))
      )
    ).toBe(
      formatReferenceUri({ scopeId: targetPageScope, objectId: 'evidence' }, hash(targetEvidence))
    );
    expect(pages.get('knowledge/pages/evidence.md')).toBe(evidence);
  });

  it('exports one published Git tree and the actual scope schema, ignoring stale page files', async () => {
    const f = await source();
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

  it('rebuilds a new target Notebook through the existing verified Workspace archive import', async () => {
    const f = await source();
    const target = deployment();
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
    const occupied = await importVerifiedWorkspace({
      authorityUserId: LOCAL_USER_ID,
      coreDb: target.coreDb,
      dataRoot: target.dataRoot,
      requestId: randomUUID(),
      store: target.store,
      verified: exported.verified,
    });
    expect(occupied.workspace.id).toBe(f.workspace.id);
    const imported = await importVerifiedWorkspace({
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
    expect(original.document?.frontmatter).not.toHaveProperty('openkit_entry_id');
    expect(original.document?.frontmatter).not.toHaveProperty('openkit_entry_kind');
    expect(page.document?.conceptId).toBe('notes/portable');
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

  it('refuses current-tree import when an inert historical subject pin requires omitted target bytes', async () => {
    const f = await source();
    const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: f.dataRoot,
      scope: { kind: 'workspace', workspaceId: f.workspace.id },
    });
    const scopeId = `page/workspace/${f.workspace.id}/${knowledgeBaseId}`;
    const targetReference = { scopeId, objectId: 'notes/portable' };
    const targetPin = formatReferenceUri(
      targetReference,
      `sha256:${createHash('sha256').update(f.content).digest('hex')}`
    );
    const assessmentPath = 'assessments/historical.md';
    const assessment = updateOkfFrontmatter({
      path: assessmentPath,
      content: serializeKnowledgePageFixture(
        {
          title: 'Assessment of the original target version',
          content: 'Only the exact original target bytes remain disputed.',
          sourceReferences: [],
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z',
        },
        { kind: 'workspace', workspaceId: f.workspace.id }
      ),
      updates: {
        type: 'Observation',
        openkit_status: 'draft',
        status: 'draft',
        conflict_status: 'unresolved',
        subject_refs: [targetPin],
      },
    });
    const publish = async (path: string, content: string): Promise<string> => {
      const response = await app.request('/api/app/operations/knowledge.notebook.update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          workspaceId: f.workspace.id,
          baseRevision: f.notebook.publishedRevision(),
          changes: [{ path, content }],
          summary: 'Retain exact assessment scope through an ordinary target edit',
        }),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.outcome).toBe('published');
      return result.notebookRevision;
    };
    const assessedRevision = await publish(assessmentPath, assessment);
    const assessed = f.notebook.readRevision(assessedRevision);
    expect(unresolvedNotebookSubjects(assessed.files, scopeId)).toEqual(
      new Set([formatReferenceUri(targetReference)])
    );

    const editedRevision = await publish(
      'notes/portable.md',
      `${f.content}\nA later independently edited target version.\n`
    );
    const edited = f.notebook.readRevision(editedRevision);
    expect(edited.parentRevision).toBe(assessedRevision);
    expect(edited.files['notes/portable.md']).not.toBe(f.content);
    expect(edited.files[assessmentPath]).toBe(assessed.files[assessmentPath]);
    expect(
      parseOkfDocument({ path: assessmentPath, content: edited.files[assessmentPath]! }).document
        ?.frontmatter.subject_refs
    ).toEqual([targetPin]);
    expect(unresolvedNotebookSubjects(edited.files, scopeId)).toEqual(new Set());
    expect(f.notebook.readRevision(assessedRevision).files['notes/portable.md']).toBe(f.content);

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
    expect(exported.verified.manifest.knowledgeNotebookRevision).toBe(editedRevision);
    const target = deployment();
    const targetRoot = join(target.dataRoot, 'workspaces');
    const targetFiles = () =>
      existsSync(targetRoot) ? readdirSync(targetRoot, { recursive: true }).sort() : [];
    const beforeFiles = targetFiles();
    const beforeWorkspaces = structuredClone(target.store.listWorkspaces());
    const sourceWorkspace = structuredClone(f.store.getWorkspace(f.workspace.id));

    // A current-tree archive cannot reconstruct the old subject bytes retained only in source Git.
    expect(() =>
      importVerifiedWorkspace({
        authorityUserId: LOCAL_USER_ID,
        coreDb: target.coreDb,
        dataRoot: target.dataRoot,
        requestId: randomUUID(),
        store: target.store,
        verified: exported.verified,
      })
    ).toThrow('Portable Knowledge Page requires unavailable pinned source bytes.');
    expect(target.store.listWorkspaces()).toEqual(beforeWorkspaces);
    expect(targetFiles()).toEqual(beforeFiles);
    expect(existsSync(join(targetRoot, f.workspace.id, 'knowledge', 'notebook.git'))).toBe(false);
    expect(f.notebook.publishedRevision()).toBe(editedRevision);
    expect(f.notebook.readRevision(editedRevision)).toEqual(edited);
    expect(f.notebook.readRevision(assessedRevision)).toEqual(assessed);
    expect(f.store.getWorkspace(f.workspace.id)).toEqual(sourceWorkspace);
  }, 60_000);

  it('remints a retained current-revision Knowledge selection into the imported Notebook', async () => {
    const f = await source();
    const thread = await f.store.createThread(
      f.workspace.id,
      'Portable trace',
      undefined,
      'conversation',
      {
        visibility: 'workspace',
      }
    );
    const sourceKnowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: f.dataRoot,
      scope: { kind: 'workspace', workspaceId: f.workspace.id },
    });
    const selected = await retrieveWorkspaceKnowledge({
      dataRoot: f.dataRoot,
      workspaceId: f.workspace.id,
      caller: 'app-api',
      query: 'Exact portable note',
      limit: 1,
      pinnedReferences: [
        {
          scopeId: `page/workspace/${f.workspace.id}/${sourceKnowledgeBaseId}`,
          objectId: 'notes/portable',
        },
      ],
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
      expect.objectContaining({
        revision: f.revision,
        contentDigest: `sha256:${createHash('sha256').update(f.content).digest('hex')}`,
      }),
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
    const imported = await importVerifiedWorkspace({
      authorityUserId: LOCAL_USER_ID,
      coreDb: target.coreDb,
      dataRoot: target.dataRoot,
      requestId: randomUUID(),
      store: target.store,
      verified: exported.verified,
    });
    const importedThread = target.store
      .listThreads(imported.workspace.id)
      .find((entry) => entry.name === thread.name);
    expect(importedThread).toBeDefined();
    const targetRoot = join(target.dataRoot, 'workspaces', imported.workspace.id);
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(targetRoot, 'knowledge', 'notebook.git'),
    });
    const revision = notebook.publishedRevision();
    const page = notebook.readRevision(revision).files['notes/portable.md']!;
    const targetKnowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot: target.dataRoot,
      scope: { kind: 'workspace', workspaceId: imported.workspace.id },
    });
    const trace = readRetrievalTrace(targetRoot, {
      scopeId: `retrieval-trace/thread/${imported.workspace.id}/${importedThread!.id}`,
      objectId: selected.retrievalTraceRef!.objectId,
    });
    expect(trace).toMatchObject({
      notebookRevision: revision,
      selected: [
        {
          reference: {
            scopeId: `page/workspace/${imported.workspace.id}/${targetKnowledgeBaseId}`,
            objectId: 'notes/portable',
          },
          revision,
          contentDigest: `sha256:${createHash('sha256').update(page).digest('hex')}`,
        },
      ],
    });
    expect(page).toContain('Exact Unicode body: 漢字.');
    expect(exported.verified.manifest.knowledgeNotebookRevision).toBe(f.revision);
  });

  it('retains published and unpublished Git content and existing Audit in the ordinary same-deployment backup', async () => {
    const f = await source();
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
      backupId: allocateEntityId('drb'),
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
