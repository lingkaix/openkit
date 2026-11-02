import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { updateOkfFrontmatter } from './knowledge/okf.js';
import { prepareAuthorizedWorkspaceNotebookRead } from './retrieval-knowledge-adapter.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import {
  type KnowledgeRetrievalAccess,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { createTestStore } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const testRoots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeRetrievalServices();
  for (const db of databases.splice(0)) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Publishes a real source-linked selection; no prepared content supplies authority. */
async function preparedRetrievalFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'retrieval-knowledge-prepared-'));
  testRoots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Prepared Knowledge retrieval');
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const access: KnowledgeRetrievalAccess = {
    store,
    coreDb,
    actor: { kind: 'user', id: userId },
    requestActor: { kind: 'local', userId },
  };
  const input = { dataRoot, workspaceId: workspace.id, access, caller: 'app-api' as const };
  const app = createApp({ coreDb, dataRoot, store });
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: workspace.id },
  });
  const scopeId = `page/workspace/${workspace.id}/${knowledgeBaseId}`;
  const contents = ['support', 'selected'].map((id) =>
    serializeKnowledgePageFixture(
      {
        title: id,
        content:
          id === 'selected' ? 'preparedreusemarker exact selected bytes.' : 'Supporting fact.',
        sourceReferences:
          id === 'selected' ? [formatReferenceUri({ scopeId, objectId: 'support' })] : [],
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: workspace.id }
    )
  );
  for (const [index, id] of ['support', 'selected'].entries()) {
    const listed = await app.request(
      ...operationRequest('knowledge.notebook.list', { workspaceId: workspace.id })
    );
    expect(listed.status, await listed.clone().text()).toBe(200);
    const created = await app.request(
      ...operationRequest(
        'knowledge.notebook.create',
        {
          workspaceId: workspace.id,
          path: `${id}.md`,
          content: contents[index]!,
          baseRevision: (await listed.json()).notebookRevision,
          summary: 'Create prepared retrieval evidence',
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(created.status, await created.clone().text()).toBe(200);
  }
  const selection = await retrieveWorkspaceKnowledge({
    ...input,
    query: 'preparedreusemarker',
    limit: 5,
    pinnedReferences: [{ scopeId, objectId: 'selected' }],
  });
  expect(selection.selected).toEqual([
    expect.objectContaining({ reference: { scopeId, objectId: 'selected' } }),
  ]);
  const expected = [
    expect.objectContaining({
      notebookRevision: selection.notebookRevision,
      reference: { scopeId, objectId: 'selected' },
      contentDigest: `sha256:${createHash('sha256').update(contents[1]!).digest('hex')}`,
      content: contents[1],
    }),
  ];
  return { input, app, selection, expected, supportContent: contents[0]! };
}

describe('prepared Knowledge retrieval resolution', () => {
  it('reuses a complete ordinary-page inventory without rereading immutable Notebook bodies', async () => {
    const f = await preparedRetrievalFixture();
    const notebookRead = await prepareAuthorizedWorkspaceNotebookRead(f.input);
    // The real inventory producer retains navigation identities, not their unused bodies.
    expect(Object.hasOwn(notebookRead.selected.entries, 'index.md')).toBe(true);
    expect(Object.hasOwn(notebookRead.selected.files, 'index.md')).toBe(false);
    const contentReads = vi.spyOn(KnowledgeNotebook.prototype, 'readRevision');
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({ ...f.input, selection: f.selection, notebookRead })
    ).toEqual(f.expected);
    // COORD 06:30 Task3(a), S61 Retrieval pipeline and Notebook Content, Revisions And History:
    // reuse request-local immutable bytes, not an old grant; metadata/authority reads stay live.
    expect(contentReads).not.toHaveBeenCalled();
  });

  it('falls back for missing ordinary bodies and refuses a prepared selection after source restriction', async () => {
    const f = await preparedRetrievalFixture();
    const notebookRead = await prepareAuthorizedWorkspaceNotebookRead(f.input);
    // Use the real narrow producer, not a fabricated partial authority record.
    const partial = await prepareAuthorizedWorkspaceNotebookRead({
      ...f.input,
      pageIds: ['selected'],
    });
    expect(Object.hasOwn(partial.selected.files, 'support.md')).toBe(false);
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        ...f.input,
        selection: f.selection,
        notebookRead: partial,
      })
    ).toEqual(f.expected);
    const restricted = await f.app.request(
      ...operationRequest(
        'knowledge.notebook.update',
        {
          workspaceId: f.input.workspaceId,
          baseRevision: notebookRead.current.revision,
          changes: [
            {
              path: 'support.md',
              content: updateOkfFrontmatter({
                path: 'support.md',
                content: f.supportContent,
                updates: { sensitivity: 'confidential' },
              }),
            },
          ],
          summary: 'Restrict the current supporting page',
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(restricted.status, await restricted.clone().text()).toBe(200);
    const publication = await restricted.json();
    expect(publication).toMatchObject({
      outcome: 'published',
      notebookRevision: expect.any(String),
    });
    expect(publication.notebookRevision).not.toBe(notebookRead.current.revision);
    // Core Policy and S61 require current recursive Source admission despite retained exact bytes.
    expect(() =>
      resolveWorkspaceKnowledgeRetrievalPages({ ...f.input, selection: f.selection, notebookRead })
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied' }));
  });
});

describe('Knowledge retrieval segmentation', () => {
  it.each([
    {
      title: 'Chinese body',
      body: '我们完成了测试，并修复了缺陷。',
      one: '测试',
      two: '测试 修复',
    },
    { title: 'Japanese body', body: '検索機能を改善しました。', one: '検索', two: '検索 改善' },
  ])('retrieves segmented terms from the body and title: $title', async ({ body, one, two }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'retrieval-knowledge-cjk-'));
    testRoots.push(dataRoot);
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Knowledge segmentation');
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: workspace.id },
    });
    const coreDb = openCoreDb(dataRoot);
    databases.push(coreDb);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const app = createApp({ coreDb, dataRoot, store });
    const currentNotebook = async () => {
      const response = await app.request(
        ...operationRequest('knowledge.notebook.list', { workspaceId: workspace.id })
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()).notebookRevision as string;
    };
    const created = await app.request(
      ...operationRequest(
        'knowledge.notebook.create',
        {
          workspaceId: workspace.id,
          path: 'segmentation-evidence.md',
          summary: 'Create segmentation evidence',
          baseRevision: await currentNotebook(),
          content: serializeKnowledgePageFixture(
            {
              title: 'Unrelated',
              content: body,
              createdAt: '2026-10-19T00:00:00.000Z',
              updatedAt: '2026-10-19T00:00:00.000Z',
            },
            { kind: 'workspace', workspaceId: workspace.id }
          ),
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(created.status, await created.clone().text()).toBe(200);
    expect((await created.json()).changedPageIds).toEqual(['segmentation-evidence']);
    const page = { id: 'segmentation-evidence' };
    const retrieve = (query: string) =>
      retrieveWorkspaceKnowledge({
        dataRoot,
        workspaceId: workspace.id,
        limit: 5,
        pinnedReferences: [],
        caller: 'app-api',
        query,
        access: {
          store,
          coreDb,
          actor: { kind: 'user', id: userId },
          requestActor: { kind: 'local', userId },
        },
      });
    expect((await retrieve(one)).selected).toEqual([
      expect.objectContaining({
        reference: {
          scopeId: `page/workspace/${workspace.id}/${knowledgeBaseId}`,
          objectId: page.id,
        },
      }),
    ]);
    expect(await retrieve(two)).toMatchObject({
      selected: [
        {
          reference: {
            scopeId: `page/workspace/${workspace.id}/${knowledgeBaseId}`,
            objectId: page.id,
          },
        },
      ],
    });
    const updated = await app.request(
      ...operationRequest(
        'knowledge.notebook.update',
        {
          workspaceId: workspace.id,
          baseRevision: await currentNotebook(),
          changes: [
            {
              path: `${page.id}.md`,
              content: serializeKnowledgePageFixture(
                {
                  title: one,
                  content: body,
                  createdAt: '2026-10-19T00:00:00.000Z',
                  updatedAt: '2026-10-19T00:00:00.000Z',
                },
                { kind: 'workspace', workspaceId: workspace.id }
              ),
            },
          ],
          summary: 'Update segmentation evidence title',
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await retrieve(one)).toMatchObject({
      selected: [
        {
          reference: {
            scopeId: `page/workspace/${workspace.id}/${knowledgeBaseId}`,
            objectId: page.id,
          },
        },
      ],
    });
  });
});
