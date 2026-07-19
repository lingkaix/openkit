import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppSearchResponseSchema } from '@openkit/app-api-schemas';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { FsStore } from './lib/store.js';
import { registerSearchRoutes } from './search-routes.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('search app API', () => {
  it('opens only authorized workspaces and never scans global items', async () => {
    const store = createDemoStore();
    const allowedThread = store.createThread('ws_demo', 'Authorized needle thread');
    const allowedTurn = store.createTurn('ws_demo', allowedThread.id, 'Authorized needle turn', {
      kind: 'user',
      id: 'user_local',
    });
    store.createItem({
      id: 'it_authorized_needle',
      workspaceId: 'ws_demo',
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
      id: 'user_local',
    });
    store.createItem({
      id: 'it_denied_needle',
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
    registerSearchRoutes({
      app,
      authorizedWorkspaceIds: () => ['ws_demo'],
      requestStore: () => store,
    });

    const response = await app.request('/api/app/search?q=needle');
    const items = AppSearchResponseSchema.parse(await response.json()).items;

    expect(response.status).toBe(200);
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'item', id: 'it_authorized_needle' })
    );
    expect(items).not.toContainEqual(expect.objectContaining({ id: 'it_denied_needle' }));
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(listAllItems).not.toHaveBeenCalled();
  });

  it('searches workspaces, threads, knowledge, artifacts, and items', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Needle thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Find needle', {
      kind: 'user',
      id: 'user_local',
    });
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
    const store = new FsStore({ dataRoot });
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
      const turn = store.createTurn(workspace.id, thread.id, `${prefix} visibility needle turn`, {
        kind: 'user',
        id: 'user_local',
      });
      const timestamp = turn.startedAt ?? new Date().toISOString();
      const artifactBody = `${prefix} visibility needle body`;
      const artifactRequestId = `search-artifact-${prefix}-1`;
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
      store,
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

      const transferredAt = new Date().toISOString();
      coreDb.sqlite.transaction(() => {
        coreDb.sqlite
          .prepare(
            `INSERT INTO users
              (id, display_name, email, email_verified, created_at, updated_at, kind)
             VALUES ('user_replacement_owner', 'Replacement Owner',
                     'search-replacement@example.com', false, ?, ?, 'human')`
          )
          .run(Date.now(), Date.now());
        coreDb.sqlite
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, status, access_level, invitation_id,
              joined_at, removed_at, revision, created_at, updated_at
            ) VALUES (?, 'user_replacement_owner', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
          )
          .run(allowedWorkspace.id, transferredAt, transferredAt, transferredAt);
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_registry
             SET owner_user_id = 'user_replacement_owner', revision = revision + 1, updated_at = ?
             WHERE workspace_id = ?`
          )
          .run(transferredAt, allowedWorkspace.id);
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run(transferredAt, transferredAt, allowedWorkspace.id, 'user_local');
      })();
      app = createApp({ auth, coreDb, dataRoot, mode: 'server', store });

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
