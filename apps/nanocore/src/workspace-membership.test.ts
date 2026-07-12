import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { recordDataRootDeploymentMove } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates a Better Auth test double with one signed-in user.
 *
 * @param userId Authenticated user id.
 * @returns Better Auth-compatible server.
 */
function authForUser(userId: string): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({ session: { id: 'session_1' }, user: { id: userId } }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

describe('workspace membership foundation', () => {
  it('records the creator as the owner member when creating a workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-membership-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id,
            display_name,
            email,
            email_verified,
            image,
            created_at,
            updated_at,
            kind,
            last_seen_at
          )
           VALUES ('user_owner', 'Owner', 'owner@example.com', false, NULL, ?, ?, 'human', NULL)`
        )
        .run(Date.now(), Date.now());
      const app = createApp({
        auth: authForUser('user_owner'),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const response = await app.request('/api/workspaces', {
        body: JSON.stringify({ name: 'Shared Workspace', requestId: randomUUID() }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const workspace = (await response.json()) as { id: string };
      const registry = coreDb.sqlite
        .prepare(
          'SELECT workspace_id, owner_user_id, status FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(workspace.id);
      const member = coreDb.sqlite
        .prepare(
          'SELECT workspace_id, user_id, status FROM workspace_members WHERE workspace_id = ?'
        )
        .get(workspace.id);

      expect(response.status).toBe(201);
      expect(registry).toEqual({
        owner_user_id: 'user_owner',
        status: 'active',
        workspace_id: workspace.id,
      });
      expect(member).toEqual({
        status: 'active',
        user_id: 'user_owner',
        workspace_id: workspace.id,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a second owner without reviving removed owner access', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-membership-import-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const now = Date.now();
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
          id,
          display_name,
          email,
          email_verified,
          created_at,
          updated_at,
          kind
        )
         VALUES
          ('user_first', 'First User', 'first@example.com', false, ?, ?, 'human'),
          ('user_second', 'Second User', 'second@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);

      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_first',
        workspaceId: 'ws_imported_shared',
      });
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed'
           WHERE workspace_id = ? AND user_id = ?`
        )
        .run('ws_imported_shared', 'user_first');
      expect(() =>
        recordWorkspaceOwnerMembership({
          coreDb,
          ownerUserId: 'user_second',
          workspaceId: 'ws_imported_shared',
        })
      ).toThrow('Workspace is already owned by another user.');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_first',
        workspaceId: 'ws_imported_shared',
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT workspace_id, user_id, status
             FROM workspace_members
             WHERE workspace_id = ?
             ORDER BY user_id`
          )
          .all('ws_imported_shared')
      ).toEqual([
        {
          workspace_id: 'ws_imported_shared',
          user_id: 'user_first',
          status: 'removed',
        },
      ]);
      expect(
        coreDb.sqlite
          .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
          .get('ws_imported_shared')
      ).toEqual({ owner_user_id: 'user_first' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not invent filesystem membership and hides workspaces after access is removed', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-membership-read-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id,
            display_name,
            email,
            email_verified,
            image,
            created_at,
            updated_at,
            kind,
            last_seen_at
          )
           VALUES ('user_owner', 'Owner', 'owner@example.com', false, NULL, ?, ?, 'human', NULL)`
        )
        .run(Date.now(), Date.now());
      const store = new FsStore({ dataRoot, userId: 'user_owner' });
      const missing = store.createWorkspace('Missing membership');
      const removed = store.createWorkspace('Removed membership');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_owner',
        workspaceId: removed.id,
      });
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed'
           WHERE workspace_id = ? AND user_id = ?`
        )
        .run(removed.id, 'user_owner');
      const app = createApp({
        auth: authForUser('user_owner'),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const response = await app.request('/api/workspaces');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ items: [] });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .get(missing.id, 'user_owner')
      ).toBeUndefined();
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .get(removed.id, 'user_owner')
      ).toEqual({ status: 'removed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps same-deployment workspace exports private to users who can read the source', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-membership-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const now = Date.now();
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id,
            display_name,
            email,
            email_verified,
            created_at,
            updated_at,
            kind
          )
          VALUES
            ('user_exporter', 'Exporter', 'exporter@example.com', false, ?, ?, 'human'),
            ('user_other', 'Other', 'other@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);
      const exporterStore = new FsStore({ dataRoot, userId: 'user_exporter' });
      const otherStore = new FsStore({ dataRoot, userId: 'user_other' });
      const source = exporterStore.createWorkspace('Private export source');
      exporterStore.createKnowledgeEntry(source.id, {
        content: 'Private export knowledge.',
        kind: 'project-context',
        title: 'Private export knowledge',
      });
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_exporter',
        workspaceId: source.id,
      });
      const exporterApp = createApp({
        auth: authForUser('user_exporter'),
        coreDb,
        dataRoot,
        mode: 'server',
        storeFactory: () => exporterStore,
      });
      const otherApp = createApp({
        auth: authForUser('user_other'),
        coreDb,
        dataRoot,
        mode: 'server',
        storeFactory: () => otherStore,
      });
      const otherWorkspaceIds = otherStore.listWorkspaces().map((workspace) => workspace.id);
      const exportedResponse = await exporterApp.request(
        `/api/app/workspaces/${source.id}/export`,
        { method: 'POST' }
      );
      const exported = (await exportedResponse.json()) as { exportId: string };
      recordDataRootDeploymentMove(dataRoot, 'dep_moved_after_export');
      const request = {
        exportId: exported.exportId,
        sourceWorkspaceId: source.id,
      };

      expect(exportedResponse.status).toBe(200);

      for (const path of ['/api/app/workspace-imports/dry-run', '/api/app/workspace-imports']) {
        const denied = await otherApp.request(path, {
          body: JSON.stringify(
            path.endsWith('/dry-run') ? request : { ...request, requestId: randomUUID() }
          ),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });

        expect(denied.status, `${path}: ${await denied.clone().text()}`).toBe(403);
        await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_import_forbidden' });
      }

      const missing = await otherApp.request('/api/app/workspace-imports/dry-run', {
        body: JSON.stringify({
          exportId: 'wsexp_missing',
          sourceWorkspaceId: 'ws_missing',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const missingBody = await missing.text();

      expect(missing.status).toBe(400);
      expect(missingBody).not.toContain(dataRoot);
      expect(otherStore.listWorkspaces().map((workspace) => workspace.id)).toEqual(
        otherWorkspaceIds
      );
    } finally {
      coreDb.sqlite.close();
    }
  });
});
