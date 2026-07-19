import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { recordDataRootDeploymentMove } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import {
  listActiveWorkspaceIdsForActor,
  recordWorkspaceOwnerMembership,
  resolveWorkspaceRole,
} from './workspace-membership.js';

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
  it('derives effective roles and candidates only from consistent active Core facts', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-role-resolution-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
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
            ('user_subject', 'Subject', 'subject@example.com', false, ?, ?, 'human'),
            ('user_steward', 'Steward', 'steward@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);
      for (const [workspaceId, ownerUserId] of [
        ['ws_owner', 'user_subject'],
        ['ws_editor', 'user_steward'],
        ['ws_viewer', 'user_steward'],
        ['ws_removed', 'user_steward'],
        ['ws_deleting', 'user_steward'],
        ['ws_contradictory', 'user_subject'],
      ] as const) {
        recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId });
      }
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
            workspace_id, user_id, status, access_level, invitation_id,
            joined_at, removed_at, revision, created_at, updated_at
          )
          VALUES
            ('ws_editor', 'user_subject', 'active', 'editor', NULL, ?, NULL, 1, ?, ?),
            ('ws_viewer', 'user_subject', 'active', 'viewer', NULL, ?, NULL, 1, ?, ?),
            ('ws_removed', 'user_subject', 'removed', 'editor', NULL, ?, ?, 2, ?, ?),
            ('ws_deleting', 'user_subject', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp
        );
      coreDb.sqlite
        .prepare("UPDATE workspace_registry SET status = 'deleting' WHERE workspace_id = ?")
        .run('ws_deleting');
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
          ) VALUES ('user_disabled', 'Disabled', 'disabled@example.com', false, ?, ?, 'human', 'disabled', ?)`
        )
        .run(now, now, timestamp);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_steward',
        workspaceId: 'ws_disabled_member',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
            workspace_id, user_id, status, access_level, invitation_id,
            joined_at, removed_at, revision, created_at, updated_at
          ) VALUES ('ws_disabled_member', 'user_disabled', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(timestamp, timestamp, timestamp);
      coreDb.sqlite.exec('DROP TRIGGER workspace_owner_member_update_guard');
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET access_level = 'viewer'
           WHERE workspace_id = 'ws_contradictory' AND user_id = 'user_subject'`
        )
        .run();
      const filesystemOnlyWorkspace = new FsStore({ dataRoot }).createWorkspace('Filesystem only');

      expect(resolveWorkspaceRole(coreDb, 'ws_owner', 'user_subject')).toBe('owner');
      expect(resolveWorkspaceRole(coreDb, 'ws_editor', 'user_subject')).toBe('editor');
      expect(resolveWorkspaceRole(coreDb, 'ws_viewer', 'user_subject')).toBe('viewer');
      expect(resolveWorkspaceRole(coreDb, 'ws_removed', 'user_subject')).toBeNull();
      expect(resolveWorkspaceRole(coreDb, 'ws_deleting', 'user_subject')).toBeNull();
      expect(resolveWorkspaceRole(coreDb, 'ws_disabled_member', 'user_disabled')).toBeNull();
      expect(resolveWorkspaceRole(coreDb, 'ws_contradictory', 'user_subject')).toBeNull();
      expect(resolveWorkspaceRole(coreDb, 'ws_missing', 'user_subject')).toBeNull();
      expect(listActiveWorkspaceIdsForActor(coreDb, 'user_subject')).toEqual([
        'ws_editor',
        'ws_owner',
        'ws_viewer',
      ]);
      expect(listActiveWorkspaceIdsForActor(coreDb, 'user_subject')).not.toContain(
        filesystemOnlyWorkspace.id
      );
      expect(listActiveWorkspaceIdsForActor(coreDb, 'user_disabled')).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

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
          'SELECT workspace_id, owner_user_id, status, revision FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(workspace.id);
      const member = coreDb.sqlite
        .prepare(
          `SELECT workspace_id, user_id, status, access_level, invitation_id,
                  joined_at, removed_at, revision
           FROM workspace_members WHERE workspace_id = ?`
        )
        .get(workspace.id);

      expect(response.status).toBe(201);
      expect(registry).toEqual({
        owner_user_id: 'user_owner',
        revision: 1,
        status: 'active',
        workspace_id: workspace.id,
      });
      expect(member).toEqual({
        access_level: 'editor',
        invitation_id: null,
        joined_at: expect.any(String),
        removed_at: null,
        revision: 1,
        status: 'active',
        user_id: 'user_owner',
        workspace_id: workspace.id,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('scopes workspace creation idempotency to the authenticated user', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-create-scope-'));
    const coreDb = openCoreDb(dataRoot);
    const store = new FsStore({ dataRoot });

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
      const requestId = randomUUID();
      const firstApp = createApp({
        auth: authForUser('user_first'),
        coreDb,
        mode: 'server',
        store,
      });
      const secondApp = createApp({
        auth: authForUser('user_second'),
        coreDb,
        mode: 'server',
        store,
      });
      const firstResponse = await firstApp.request('/api/workspaces', {
        body: JSON.stringify({ name: 'First Workspace', requestId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const secondResponse = await secondApp.request('/api/workspaces', {
        body: JSON.stringify({ name: 'Second Workspace', requestId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const firstWorkspace = (await firstResponse.json()) as { id: string };
      const secondWorkspace = (await secondResponse.json()) as { id: string };

      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(201);
      expect(secondWorkspace.id).not.toBe(firstWorkspace.id);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a second owner and preserves active owner membership', () => {
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
      expect(() =>
        coreDb.sqlite
          .prepare('UPDATE workspace_registry SET owner_user_id = ? WHERE workspace_id = ?')
          .run('user_second', 'ws_imported_shared')
      ).toThrow('workspace_owner_membership_required');
      expect(() =>
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET status = 'removed'
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run('ws_imported_shared', 'user_first')
      ).toThrow();
      expect(() =>
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET access_level = 'viewer'
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run('ws_imported_shared', 'user_first')
      ).toThrow();
      expect(() =>
        coreDb.sqlite
          .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .run('ws_imported_shared', 'user_first')
      ).toThrow();
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
          status: 'active',
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
           VALUES
            ('user_owner', 'Owner', 'owner@example.com', false, NULL, ?, ?, 'human', NULL),
            ('user_actual_owner', 'Actual Owner', 'actual-owner@example.com', false, NULL, ?, ?, 'human', NULL)`
        )
        .run(Date.now(), Date.now(), Date.now(), Date.now());
      const store = new FsStore({ dataRoot });
      const missing = store.createWorkspace('Missing membership');
      const removed = store.createWorkspace('Removed membership');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_actual_owner',
        workspaceId: removed.id,
      });
      const joinedAt = new Date().toISOString();
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
            workspace_id, user_id, status, access_level, invitation_id,
            joined_at, removed_at, revision, created_at, updated_at
          )
          VALUES (?, ?, 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(removed.id, 'user_owner', joinedAt, joinedAt, joinedAt);
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND user_id = ?`
        )
        .run(joinedAt, joinedAt, removed.id, 'user_owner');
      const app = createApp({
        auth: authForUser('user_owner'),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const response = await app.request('/api/workspaces');

      expect(response.status, await response.clone().text()).toBe(200);
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
      const store = new FsStore({ dataRoot });
      const source = store.createWorkspace('Private export source');
      store.createKnowledgeEntry(source.id, {
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
        store,
      });
      const otherApp = createApp({
        auth: authForUser('user_other'),
        coreDb,
        dataRoot,
        mode: 'server',
        store,
      });
      const workspaceIds = store.listWorkspaces().map((workspace) => workspace.id);
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
      const getWorkspace = vi.spyOn(store, 'getWorkspace');

      expect(exportedResponse.status).toBe(200);

      for (const path of ['/api/app/workspace-imports/dry-run', '/api/app/workspace-imports']) {
        getWorkspace.mockClear();
        const denied = await otherApp.request(path, {
          body: JSON.stringify(
            path.endsWith('/dry-run') ? request : { ...request, requestId: randomUUID() }
          ),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });

        expect(denied.status, `${path}: ${await denied.clone().text()}`).toBe(403);
        await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_import_forbidden' });
        expect(getWorkspace).not.toHaveBeenCalled();
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
      expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(workspaceIds);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
