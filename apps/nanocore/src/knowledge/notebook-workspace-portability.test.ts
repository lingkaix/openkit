// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { applyMigrations } from '../storage/migrate.js';
import { readWorkspacePortableFileState } from '../storage/workspace-portable-file-state.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';
import { remintPortableWorkspaceNotebookPages } from './notebook-workspace-portability.js';
import { readWorkspaceNotebookSelection } from './notebook-workspace-selection.js';
import { updateOkfFrontmatter } from './okf.js';

const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real deployment and ordinary creation keep publication authority with the Notebook owner. */
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

/** Publish test-owned bytes through the Notebook owner; no fixture file is a canonical page. */
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
  const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
  const listedResponse = await app.request(
    ...operationRequest('knowledge.notebook.list', { workspaceId: workspace.id })
  );
  expect(listedResponse.status, await listedResponse.clone().text()).toBe(200);
  const listed = (await listedResponse.json()) as { notebookRevision: string };
  const saveRequestId = randomUUID();
  const savedResponse = await app.request(
    ...operationRequest(
      'knowledge.notebook.create',
      { workspaceId: workspace.id },
      {
        body: JSON.stringify({
          requestId: saveRequestId,
          baseRevision: listed.notebookRevision,
          path: 'notes/portable.md',
          content,
          summary: 'Test-owned portable page',
        }),
        headers: { 'x-openkit-request-id': saveRequestId },
      }
    )
  );
  expect(savedResponse.status, await savedResponse.clone().text()).toBe(200);
  const saved = (await savedResponse.json()) as { notebookRevision: string };
  const workspaceDb = openWorkspaceDb(f.dataRoot, workspace.id);
  try {
    const notebook = readWorkspaceNotebookSelection({
      workspaceDb,
      workspaceRoot: root,
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot: f.dataRoot,
        scope: { kind: 'workspace', workspaceId: workspace.id },
      }),
    }).notebook;
    const revision = notebook.publishedRevision();
    expect(revision).toBe(saved.notebookRevision);
    expect(notebook.readRevision(revision).files['notes/portable.md']).toBe(content);
    return { ...f, workspace, root, notebook, content, revision };
  } finally {
    workspaceDb.sqlite.close();
  }
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
    expect(originalAudit).toHaveLength(6);
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
    const restoredDbForSelection = openWorkspaceDb(restoredRoot, f.workspace.id);
    const restoredRootPath = join(restoredRoot, 'workspaces', f.workspace.id);
    const restoredSelection = readWorkspaceNotebookSelection({
      workspaceDb: restoredDbForSelection,
      workspaceRoot: restoredRootPath,
      knowledgeBaseId: readDefaultKnowledgeBaseId({
        dataRoot: restoredRoot,
        scope: { kind: 'workspace', workspaceId: f.workspace.id },
      }),
    });
    restoredDbForSelection.sqlite.close();
    const restored = new KnowledgeNotebook({
      repositoryPath: join(restoredRootPath, 'knowledge', 'notebook.git'),
      selectedRevision: restoredSelection.head.notebookCommit,
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
