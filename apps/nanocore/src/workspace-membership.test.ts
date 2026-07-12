import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { openCoreDb } from './storage/db.js';
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

  it('preserves removed access while adding another user for the same imported workspace id', () => {
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
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_second',
        workspaceId: 'ws_imported_shared',
      });
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed'
           WHERE workspace_id = ? AND user_id = ?`
        )
        .run('ws_imported_shared', 'user_first');
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
        {
          workspace_id: 'ws_imported_shared',
          user_id: 'user_second',
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
});
