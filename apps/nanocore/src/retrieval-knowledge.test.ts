import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { retrieveWorkspaceKnowledge } from './storage/index-rebuild.js';
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
  await closeRetrievalServices();
  for (const db of databases.splice(0)) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
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
