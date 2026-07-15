import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppSearchResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('search app API', () => {
  it('searches workspaces, threads, knowledge, artifacts, and items', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Needle thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Find needle');
    store.createItem({
      id: 'it_search_needle',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Needle answer',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const app = createApp({ store });

    const res = await app.request('/api/app/search?q=needle');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: 'thread', id: thread.id, title: 'Needle thread' }),
        expect.objectContaining({ kind: 'item', id: 'it_search_needle', title: 'Needle answer' }),
      ]),
    });
  });

  it('limits global search results to workspaces visible to scoped tokens', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-search-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot, userId: 'user_local' });
    const allowedWorkspace = store.createWorkspace('Allowed visibility needle');
    const deniedWorkspace = store.createWorkspace('Denied visibility needle');

    for (const workspace of [allowedWorkspace, deniedWorkspace]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
    }

    for (const [workspace, prefix] of [
      [allowedWorkspace, 'allowed'],
      [deniedWorkspace, 'denied'],
    ] as const) {
      const thread = store.createThread(workspace.id, `${prefix} visibility needle thread`);
      const turn = store.createTurn(workspace.id, thread.id, `${prefix} visibility needle turn`);
      const timestamp = turn.startedAt ?? new Date().toISOString();
      store.createKnowledgeEntry(workspace.id, {
        kind: 'project-context',
        title: `${prefix} visibility needle knowledge`,
        content: `${prefix} visibility needle content`,
      });
      store.createArtifact({
        id: `ar_search_${prefix}`,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        kind: 'summary',
        title: `${prefix} visibility needle artifact`,
        status: 'ready',
        summary: `${prefix} visibility needle summary`,
        version: 1,
        content: { format: 'markdown', body: `${prefix} visibility needle body` },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.createItem({
        id: `it_search_${prefix}`,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: `${prefix} visibility needle item`,
        createdAt: timestamp,
        completedAt: timestamp,
      });
    }

    const scopedToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: [allowedWorkspace.id],
    });
    const auth = {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    };
    let app = createApp({
      auth,
      coreDb,
      dataRoot,
      mode: 'server',
      storeFactory: () => store,
    });

    try {
      const response = await app.request('/api/app/search?q=visibility%20needle', {
        headers: { authorization: `Bearer ${scopedToken.secret}` },
      });
      const items = AppSearchResponseSchema.parse(await response.json()).items;

      expect(response.status).toBe(200);
      expect(new Set(items.map((item) => item.kind))).toEqual(
        new Set(['workspace', 'thread', 'knowledge', 'artifact', 'item'])
      );
      expect(items).toContainEqual(
        expect.objectContaining({ kind: 'workspace', id: allowedWorkspace.id })
      );
      expect(items).not.toContainEqual(
        expect.objectContaining({ kind: 'workspace', id: deniedWorkspace.id })
      );
      expect(items).not.toContainEqual(expect.objectContaining({ id: 'ar_search_denied' }));
      expect(items).not.toContainEqual(expect.objectContaining({ id: 'it_search_denied' }));
      expect(
        items.every((item) => !('workspaceId' in item) || item.workspaceId === allowedWorkspace.id)
      ).toBe(true);

      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed'
           WHERE workspace_id = ? AND user_id = ?`
        )
        .run(allowedWorkspace.id, 'user_local');
      app = createApp({ auth, coreDb, dataRoot, mode: 'server', storeFactory: () => store });

      const hiddenResponse = await app.request('/api/app/search?q=visibility%20needle', {
        headers: { authorization: `Bearer ${scopedToken.secret}` },
      });

      expect(hiddenResponse.status).toBe(200);
      await expect(hiddenResponse.json()).resolves.toMatchObject({ items: [] });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
