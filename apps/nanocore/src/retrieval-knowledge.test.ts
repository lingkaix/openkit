import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { retrieveWorkspaceKnowledge } from './storage/index-rebuild.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const testRoots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const db of databases.splice(0)) db.sqlite.close();
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
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge segmentation');
    const coreDb = openCoreDb(dataRoot);
    databases.push(coreDb);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const app = createApp({ coreDb, dataRoot, store });
    const currentNotebook = async () => {
      const response = await app.request(
        ...operationRequest('knowledge.list', { workspaceId: workspace.id })
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()).notebookRevision as string;
    };
    const created = await app.request(
      ...operationRequest(
        'knowledge.create',
        {
          workspaceId: workspace.id,
          knowledgePageId: 'segmentation-evidence',
          baseRevision: await currentNotebook(),
          kind: 'project-context',
          title: 'Unrelated',
          content: body,
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const page = await created.json();
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
        reference: { scopeId: `page/workspace/${workspace.id}`, objectId: page.id },
      }),
    ]);
    expect(await retrieve(two)).toMatchObject({
      selected: [{ reference: { scopeId: `page/workspace/${workspace.id}`, objectId: page.id } }],
    });
    const updated = await app.request(
      ...operationRequest(
        'knowledge.update',
        {
          workspaceId: workspace.id,
          knowledgeEntryId: page.id,
          baseRevision: await currentNotebook(),
          title: one,
        },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await retrieve(one)).toMatchObject({
      selected: [{ reference: { scopeId: `page/workspace/${workspace.id}`, objectId: page.id } }],
    });
  });
});
