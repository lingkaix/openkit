import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BetterAuthServer } from './auth/middleware.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { recordDataRootDeploymentMove } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import {
  ensureUserQuickChatWorkspace,
  listActiveWorkspaceIdsForActor,
  recordWorkspaceOwnerMembership,
  resolveWorkspaceMembershipRelation,
  WorkspaceOwnerMembershipRemovedError,
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
            ('usr_00000000-0000-7dce-aeaf-a1a2a6523aad', 'Subject', 'subject@example.com', false, ?, ?, 'human'),
            ('usr_00000000-0000-704f-b567-268fed2478ec', 'Steward', 'steward@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);
      for (const [workspaceId, ownerUserId] of [
        ['ws_00000000-0000-764a-ac14-15573e6f8983', 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'],
        ['ws_00000000-0000-7b56-b84d-e36c3b9e04dc', 'usr_00000000-0000-704f-b567-268fed2478ec'],
        ['ws_00000000-0000-7f6f-8712-e3b3efe0bcb4', 'usr_00000000-0000-704f-b567-268fed2478ec'],
        ['ws_00000000-0000-772f-bc57-457ac1c70d5b', 'usr_00000000-0000-704f-b567-268fed2478ec'],
        ['ws_00000000-0000-701f-a9e3-0acd1b3c7409', 'usr_00000000-0000-704f-b567-268fed2478ec'],
        ['ws_00000000-0000-72d2-bf6a-59509134d28f', 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'],
      ] as const) {
        recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId });
      }
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
            workspace_id, user_id, status, invitation_id,
            joined_at, removed_at, revision, created_at, updated_at
          )
          VALUES
            ('ws_00000000-0000-7b56-b84d-e36c3b9e04dc', 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad', 'active', NULL, ?, NULL, 1, ?, ?),
            ('ws_00000000-0000-7f6f-8712-e3b3efe0bcb4', 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad', 'active', NULL, ?, NULL, 1, ?, ?),
            ('ws_00000000-0000-772f-bc57-457ac1c70d5b', 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad', 'removed', NULL, ?, ?, 2, ?, ?),
            ('ws_00000000-0000-701f-a9e3-0acd1b3c7409', 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad', 'active', NULL, ?, NULL, 1, ?, ?)`
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
        .run('ws_00000000-0000-701f-a9e3-0acd1b3c7409');
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
          ) VALUES ('usr_00000000-0000-7e63-b85a-c188de8ee1c3', 'Disabled', 'disabled@example.com', false, ?, ?, 'human', 'disabled', ?)`
        )
        .run(now, now, timestamp);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-704f-b567-268fed2478ec',
        workspaceId: 'ws_00000000-0000-755d-9653-0bbaa7f8fdb4',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
            workspace_id, user_id, status, invitation_id,
            joined_at, removed_at, revision, created_at, updated_at
          ) VALUES ('ws_00000000-0000-755d-9653-0bbaa7f8fdb4', 'usr_00000000-0000-7e63-b85a-c188de8ee1c3', 'active', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(timestamp, timestamp, timestamp);
      coreDb.sqlite.exec('DROP TRIGGER workspace_owner_member_update_guard');
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed', removed_at = updated_at
           WHERE workspace_id = 'ws_00000000-0000-72d2-bf6a-59509134d28f' AND user_id = 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'`
        )
        .run();
      const filesystemOnlyWorkspace = new FsStore({ dataRoot }).createWorkspace('Filesystem only');

      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-764a-ac14-15573e6f8983',
          'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'
        )
      ).toBe('owner');
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-7b56-b84d-e36c3b9e04dc',
          'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'
        )
      ).toBe('member');
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-7f6f-8712-e3b3efe0bcb4',
          'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'
        )
      ).toBe('member');
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-772f-bc57-457ac1c70d5b',
          'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'
        )
      ).toBeNull();
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-701f-a9e3-0acd1b3c7409',
          'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'
        )
      ).toBeNull();
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-755d-9653-0bbaa7f8fdb4',
          'usr_00000000-0000-7e63-b85a-c188de8ee1c3'
        )
      ).toBeNull();
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-72d2-bf6a-59509134d28f',
          'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'
        )
      ).toBeNull();
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          'ws_00000000-0000-7490-845b-dcfa3ee49925',
          'usr_00000000-0000-7dce-aeaf-a1a2a6523aad'
        )
      ).toBeNull();
      expect(
        listActiveWorkspaceIdsForActor(coreDb, 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad')
      ).toEqual([
        'ws_00000000-0000-7b56-b84d-e36c3b9e04dc',
        'ws_00000000-0000-764a-ac14-15573e6f8983',
        'ws_00000000-0000-7f6f-8712-e3b3efe0bcb4',
      ]);
      expect(
        listActiveWorkspaceIdsForActor(coreDb, 'usr_00000000-0000-7dce-aeaf-a1a2a6523aad')
      ).not.toContain(filesystemOnlyWorkspace.id);
      expect(
        listActiveWorkspaceIdsForActor(coreDb, 'usr_00000000-0000-7e63-b85a-c188de8ee1c3')
      ).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('provisions a first-use Quick Chat home and nominally refuses its retained removed owner membership', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-quick-chat-tombstone-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const store = new FsStore({ dataRoot });
      const input = { coreDb, store, userId: 'usr_00000000-0000-7000-8000-000000000001' };
      ensureUserQuickChatWorkspace(input);
      const workspace = store.ensureQuickChatWorkspace('usr_00000000-0000-7000-8000-000000000001');
      expect(
        resolveWorkspaceMembershipRelation(
          coreDb,
          workspace.id,
          'usr_00000000-0000-7000-8000-000000000001'
        )
      ).toBe('owner');
      // Seed a retained contradiction directly; normal owner-removal commands prohibit this state.
      coreDb.sqlite.exec('DROP TRIGGER workspace_owner_member_update_guard');
      coreDb.sqlite
        .prepare(
          "UPDATE workspace_members SET status = 'removed', removed_at = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ?"
        )
        .run(new Date().toISOString(), new Date().toISOString(), workspace.id);
      const membership = coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ?')
        .all(workspace.id);
      const registry = coreDb.sqlite
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
        .all(workspace.id);
      const threads = store.listThreads(workspace.id);
      expect(() => ensureUserQuickChatWorkspace(input)).toThrowError(
        WorkspaceOwnerMembershipRemovedError
      );
      expect(
        coreDb.sqlite
          .prepare('SELECT * FROM workspace_members WHERE workspace_id = ?')
          .all(workspace.id)
      ).toEqual(membership);
      expect(
        coreDb.sqlite
          .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
          .all(workspace.id)
      ).toEqual(registry);
      expect(store.listThreads(workspace.id)).toEqual(threads);
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
           VALUES ('usr_00000000-0000-7011-88df-c2b1e8466b6f', 'Owner', 'owner@example.com', false, NULL, ?, ?, 'human', NULL)`
        )
        .run(Date.now(), Date.now());
      const app = createApp({
        auth: authForUser('usr_00000000-0000-7011-88df-c2b1e8466b6f'),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const response = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            body: JSON.stringify({ name: 'Shared Workspace', requestId: randomUUID() }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      const workspace = (await response.json()) as { id: string };
      const registry = coreDb.sqlite
        .prepare(
          'SELECT workspace_id, owner_user_id, status, revision FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(workspace.id);
      const member = coreDb.sqlite
        .prepare(
          `SELECT workspace_id, user_id, status, invitation_id,
                  joined_at, removed_at, revision
           FROM workspace_members WHERE workspace_id = ?`
        )
        .get(workspace.id);

      expect(response.status).toBe(201);
      expect(registry).toEqual({
        owner_user_id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        revision: 1,
        status: 'active',
        workspace_id: workspace.id,
      });
      expect(member).toEqual({
        invitation_id: null,
        joined_at: expect.any(String),
        removed_at: null,
        revision: 1,
        status: 'active',
        user_id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
            ('usr_00000000-0000-7036-b7d6-6d53799d5d56', 'First User', 'first@example.com', false, ?, ?, 'human'),
            ('usr_00000000-0000-750e-951f-bebbf278d045', 'Second User', 'second@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);
      const requestId = randomUUID();
      const firstApp = createApp({
        auth: authForUser('usr_00000000-0000-7036-b7d6-6d53799d5d56'),
        coreDb,
        mode: 'server',
        store,
      });
      const secondApp = createApp({
        auth: authForUser('usr_00000000-0000-750e-951f-bebbf278d045'),
        coreDb,
        mode: 'server',
        store,
      });
      const firstResponse = await firstApp.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            body: JSON.stringify({ name: 'First Workspace', requestId }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      const secondResponse = await secondApp.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            body: JSON.stringify({ name: 'Second Workspace', requestId }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
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
          ('usr_00000000-0000-7036-b7d6-6d53799d5d56', 'First User', 'first@example.com', false, ?, ?, 'human'),
          ('usr_00000000-0000-750e-951f-bebbf278d045', 'Second User', 'second@example.com', false, ?, ?, 'human')`
        )
        .run(now, now, now, now);

      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-7036-b7d6-6d53799d5d56',
        workspaceId: 'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9',
      });
      expect(() =>
        coreDb.sqlite
          .prepare('UPDATE workspace_registry SET owner_user_id = ? WHERE workspace_id = ?')
          .run(
            'usr_00000000-0000-750e-951f-bebbf278d045',
            'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9'
          )
      ).toThrow('workspace_owner_membership_required');
      expect(() =>
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET status = 'removed'
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run(
            'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9',
            'usr_00000000-0000-7036-b7d6-6d53799d5d56'
          )
      ).toThrow();
      expect(() =>
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET user_id = 'usr_00000000-0000-750e-951f-bebbf278d045'
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run(
            'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9',
            'usr_00000000-0000-7036-b7d6-6d53799d5d56'
          )
      ).toThrow();
      expect(() =>
        coreDb.sqlite
          .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .run(
            'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9',
            'usr_00000000-0000-7036-b7d6-6d53799d5d56'
          )
      ).toThrow();
      expect(() =>
        recordWorkspaceOwnerMembership({
          coreDb,
          ownerUserId: 'usr_00000000-0000-750e-951f-bebbf278d045',
          workspaceId: 'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9',
        })
      ).toThrow('Workspace is already owned by another user.');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-7036-b7d6-6d53799d5d56',
        workspaceId: 'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9',
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT workspace_id, user_id, status
             FROM workspace_members
             WHERE workspace_id = ?
             ORDER BY user_id`
          )
          .all('ws_00000000-0000-70d7-9c64-1e9a1f80c0e9')
      ).toEqual([
        {
          workspace_id: 'ws_00000000-0000-70d7-9c64-1e9a1f80c0e9',
          user_id: 'usr_00000000-0000-7036-b7d6-6d53799d5d56',
          status: 'active',
        },
      ]);
      expect(
        coreDb.sqlite
          .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
          .get('ws_00000000-0000-70d7-9c64-1e9a1f80c0e9')
      ).toEqual({ owner_user_id: 'usr_00000000-0000-7036-b7d6-6d53799d5d56' });
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
            ('usr_00000000-0000-7011-88df-c2b1e8466b6f', 'Owner', 'owner@example.com', false, NULL, ?, ?, 'human', NULL),
            ('usr_00000000-0000-70a2-a677-942b1cfdc1b0', 'Actual Owner', 'actual-owner@example.com', false, NULL, ?, ?, 'human', NULL)`
        )
        .run(Date.now(), Date.now(), Date.now(), Date.now());
      const store = new FsStore({ dataRoot });
      const missing = store.createWorkspace('Missing membership');
      const removed = store.createWorkspace('Removed membership');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-70a2-a677-942b1cfdc1b0',
        workspaceId: removed.id,
      });
      const joinedAt = new Date().toISOString();
      coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_members (
            workspace_id, user_id, status, invitation_id,
            joined_at, removed_at, revision, created_at, updated_at
          )
          VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)`
        )
        .run(removed.id, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', joinedAt, joinedAt, joinedAt);
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = ? AND user_id = ?`
        )
        .run(joinedAt, joinedAt, removed.id, 'usr_00000000-0000-7011-88df-c2b1e8466b6f');
      const app = createApp({
        auth: authForUser('usr_00000000-0000-7011-88df-c2b1e8466b6f'),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const response = await app.request('/api/app/operations/workspace.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status, await response.clone().text()).toBe(200);
      await expect(response.json()).resolves.toEqual({ items: [] });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .get(missing.id, 'usr_00000000-0000-7011-88df-c2b1e8466b6f')
      ).toBeUndefined();
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .get(removed.id, 'usr_00000000-0000-7011-88df-c2b1e8466b6f')
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
            ('usr_00000000-0000-778d-b552-9947e8876ed1', 'Exporter', 'exporter@example.com', false, ?, ?, 'human'),
            ('usr_00000000-0000-73d4-904a-d4c4b905df7c', 'Other', 'other@example.com', false, ?, ?, 'human')`
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
        ownerUserId: 'usr_00000000-0000-778d-b552-9947e8876ed1',
        workspaceId: source.id,
      });
      const exporterApp = createApp({
        auth: authForUser('usr_00000000-0000-778d-b552-9947e8876ed1'),
        coreDb,
        dataRoot,
        mode: 'server',
        store,
      });
      const otherApp = createApp({
        auth: authForUser('usr_00000000-0000-73d4-904a-d4c4b905df7c'),
        coreDb,
        dataRoot,
        mode: 'server',
        store,
      });
      const workspaceIds = store.listWorkspaces().map((workspace) => workspace.id);
      const exportedResponse = await exporterApp.request(
        ...operationRequest('workspace.export', { workspaceId: source.id }, { method: 'POST' })
      );
      const exported = (await exportedResponse.json()) as { exportId: string };
      recordDataRootDeploymentMove(dataRoot, 'dep_00000000-0000-717e-ba4e-06034b3d4ea9');
      const request = {
        exportId: exported.exportId,
        sourceWorkspaceId: source.id,
      };
      const getWorkspace = vi.spyOn(store, 'getWorkspace');

      expect(exportedResponse.status).toBe(200);

      for (const operation of ['workspace.import-dry-run', 'workspace.import'] as const) {
        getWorkspace.mockClear();
        const denied = await otherApp.request(
          ...operationRequest(
            operation,
            {},
            {
              body: JSON.stringify(
                operation === 'workspace.import-dry-run'
                  ? request
                  : { ...request, requestId: randomUUID() }
              ),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
            }
          )
        );

        expect(denied.status, `${operation}: ${await denied.clone().text()}`).toBe(403);
        await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_import_forbidden' });
        expect(getWorkspace).not.toHaveBeenCalled();
      }

      const missing = await otherApp.request(
        ...operationRequest(
          'workspace.import-dry-run',
          {},
          {
            body: JSON.stringify({
              exportId: 'wsexp_00000000-0000-76e9-a1ff-f4d43a476b8c',
              sourceWorkspaceId: 'ws_00000000-0000-7490-845b-dcfa3ee49925',
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      const missingBody = await missing.text();

      expect(missing.status).toBe(400);
      expect(missingBody).not.toContain(dataRoot);
      expect(store.listWorkspaces().map((workspace) => workspace.id)).toEqual(workspaceIds);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
