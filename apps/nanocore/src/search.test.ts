import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppSearchResponseSchema } from '@openkit/app-api-schemas';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAppSearchOperationImplementations } from './app-search-operation-implementations.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import type { AuthVariables } from './auth/middleware.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

afterEach(closeRetrievalServices);

describe('search app API', () => {
  it('opens only authorized workspaces and never scans global items', async () => {
    const store = createDemoStore({ dataRoot: mkdtempSync(join(tmpdir(), 'openkit-search-')) });
    const allowedThread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Authorized needle thread'
    );
    const allowedTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      allowedThread.id,
      'Authorized needle turn',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.createItem({
      id: 'it_00000000-0000-7c1a-9937-67af1fde2325',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: allowedThread.id,
      turnId: allowedTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Authorized needle item',
      createdAt: allowedTurn.startedAt ?? new Date().toISOString(),
      completedAt: allowedTurn.startedAt ?? new Date().toISOString(),
    });
    const deniedWorkspace = store.createWorkspace('Denied needle workspace');
    const deniedThread = store.createThread(deniedWorkspace.id, 'Denied needle thread');
    const deniedTurn = store.createTurn(deniedWorkspace.id, deniedThread.id, 'Denied needle turn', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    store.createItem({
      id: 'it_00000000-0000-7259-a0ef-9cfa5f715f90',
      workspaceId: deniedWorkspace.id,
      threadId: deniedThread.id,
      turnId: deniedTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Denied needle item',
      createdAt: deniedTurn.startedAt ?? new Date().toISOString(),
      completedAt: deniedTurn.startedAt ?? new Date().toISOString(),
    });
    const listWorkspaces = vi.spyOn(store, 'listWorkspaces').mockImplementation(() => {
      throw new Error('Search must not discover physical Workspaces.');
    });
    const listAllItems = vi.spyOn(store, 'listAllItems').mockImplementation(() => {
      throw new Error('Search must not scan items across Workspaces.');
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', {
        kind: 'local',
        userId: 'usr_00000000-0000-7000-8000-000000000001',
      } as AuthVariables['actor']);
      await next();
    });
    app.post('/api/app/operations/app.search', async (c) =>
      c.json(
        await createAppSearchOperationImplementations({ store, coreDb: undefined })['app.search'](
          { query: 'needle' },
          {
            kind: 'public',
            actor: c.get('actor'),
            actorRef: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
            scope: {
              kind: 'authorized-workspace-set',
              workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
            },
          }
        )
      )
    );

    const response = await app.request(...operationRequest('app.search', { query: 'needle' }, {}));
    const items = AppSearchResponseSchema.parse(await response.json()).items;

    expect(response.status).toBe(200);
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'item', id: 'it_00000000-0000-7c1a-9937-67af1fde2325' })
    );
    expect(items).not.toContainEqual(
      expect.objectContaining({ id: 'it_00000000-0000-7259-a0ef-9cfa5f715f90' })
    );
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(listAllItems).not.toHaveBeenCalled();
  });

  it('searches workspaces, threads, knowledge, artifacts, and items', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-search-'));
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Needle thread');
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Find needle',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.createItem({
      id: 'it_00000000-0000-75ee-bb30-08d9b9c9b051',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Needle answer',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request(...operationRequest('app.search', { query: 'needle' }, {}));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: 'thread', id: thread.id, title: 'Needle thread' }),
        expect.objectContaining({
          kind: 'item',
          id: 'it_00000000-0000-75ee-bb30-08d9b9c9b051',
          title: 'Needle answer',
        }),
      ]),
    });
  });

  it('delegates Knowledge search to the same segmented governed owner', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-search-cjk-'));
    const store = createDemoStore({ dataRoot });
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(
        dataRoot,
        'workspaces',
        'ws_00000000-0000-7000-8000-000000000001',
        'knowledge',
        'notebook.git'
      ),
    });
    const created = await app.request(
      ...operationRequest('knowledge.create', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }, {
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000201',
          baseRevision: notebook.publishedRevision(),
          knowledgePageId: 'segmented-search',
          kind: 'project-context',
          title: 'Unrelated',
          content: '我们完成了测试，并修复了缺陷。',
        }),
      })
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const page = (await created.json()) as { id: string };
    const response = await app.request(
      ...operationRequest('app.search', { query: '测试 修复' }, {})
    );
    expect(response.status).toBe(200);
    expect(AppSearchResponseSchema.parse(await response.json()).items).toContainEqual({
      kind: 'knowledge',
      id: page.id,
      title: 'Unrelated',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
  });

  it('limits global search results to workspaces visible to scoped tokens', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-search-scope-'));
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const allowedWorkspace = store.createWorkspace('Allowed visibility needle');
    const deniedWorkspace = store.createWorkspace('Denied visibility needle');

    for (const workspace of [allowedWorkspace, deniedWorkspace]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: workspace.id,
      });
    }

    const authoringApp = createApp({ coreDb, dataRoot, store });
    for (const [workspace, prefix] of [
      [allowedWorkspace, 'allowed'],
      [deniedWorkspace, 'denied'],
    ] as const) {
      const thread = store.createThread(workspace.id, `${prefix} visibility needle thread`);
      const turn = store.createTurn(workspace.id, thread.id, `${prefix} visibility needle turn`, {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      });
      const timestamp = turn.startedAt ?? new Date().toISOString();
      const artifactBody = `${prefix} visibility needle body`;
      const artifactRequestId = `search-artifact-${prefix}-1`;
      const notebook = new KnowledgeNotebook({
        repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
      });
      const created = await authoringApp.request(
        ...operationRequest('knowledge.create', { workspaceId: workspace.id }, {
          body: JSON.stringify({
            requestId:
              prefix === 'allowed'
                ? '00000000-0000-4000-8000-000000000202'
                : '00000000-0000-4000-8000-000000000203',
            baseRevision: notebook.publishedRevision(),
            knowledgePageId: `${prefix}-visibility`,
            kind: 'project-context',
            title: `${prefix} visibility needle knowledge`,
            content: `${prefix} visibility needle content`,
          }),
        })
      );
      expect(created.status, await created.clone().text()).toBe(200);
      store.createArtifact({
        id: testEntityId('ar', `ar_search_${prefix}`),
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        kind: 'summary',
        title: `${prefix} visibility needle artifact`,
        status: 'ready',
        summary: `${prefix} visibility needle summary`,
        version: 1,
        content: { format: 'markdown', body: artifactBody },
        contentDigest: `sha256:${createHash('sha256').update(artifactBody, 'utf8').digest('hex')}`,
        lastMutationRequestId: artifactRequestId,
        origin: {
          kind: 'turn-output',
          threadId: thread.id,
          turnId: turn.id,
          requestId: artifactRequestId,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.createItem({
        id: testEntityId('it', `it_search_${prefix}`),
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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
      store,
    });

    try {
      const response = await app.request(
        ...operationRequest(
          'app.search',
          { query: 'visibility needle' },
          {
            headers: { authorization: `Bearer ${scopedToken.secret}` },
          }
        )
      );
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
      expect(items).not.toContainEqual(
        expect.objectContaining({ id: 'ar_00000000-0000-7b07-ae01-517f9ca2c172' })
      );
      expect(items).not.toContainEqual(
        expect.objectContaining({ id: 'it_00000000-0000-7a91-b782-a7855a1e7ea2' })
      );
      expect(
        items.every((item) => !('workspaceId' in item) || item.workspaceId === allowedWorkspace.id)
      ).toBe(true);

      const transferredAt = new Date().toISOString();
      coreDb.sqlite.transaction(() => {
        coreDb.sqlite
          .prepare(
            `INSERT INTO users
              (id, display_name, email, email_verified, created_at, updated_at, kind)
             VALUES ('usr_00000000-0000-7cfc-ba59-df60b2f09c20', 'Replacement Owner',
                     'search-replacement@example.com', false, ?, ?, 'human')`
          )
          .run(Date.now(), Date.now());
        coreDb.sqlite
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, status, access_level, invitation_id,
              joined_at, removed_at, revision, created_at, updated_at
            ) VALUES (?, 'usr_00000000-0000-7cfc-ba59-df60b2f09c20', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
          )
          .run(allowedWorkspace.id, transferredAt, transferredAt, transferredAt);
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_registry
             SET owner_user_id = 'usr_00000000-0000-7cfc-ba59-df60b2f09c20', revision = revision + 1, updated_at = ?
             WHERE workspace_id = ?`
          )
          .run(transferredAt, allowedWorkspace.id);
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run(
            transferredAt,
            transferredAt,
            allowedWorkspace.id,
            'usr_00000000-0000-7000-8000-000000000001'
          );
      })();
      app = createApp({ auth, coreDb, dataRoot, mode: 'server', store });

      const hiddenResponse = await app.request(
        ...operationRequest(
          'app.search',
          { query: 'visibility needle' },
          {
            headers: { authorization: `Bearer ${scopedToken.secret}` },
          }
        )
      );

      expect(hiddenResponse.status).toBe(200);
      await expect(hiddenResponse.json()).resolves.toMatchObject({ items: [] });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
