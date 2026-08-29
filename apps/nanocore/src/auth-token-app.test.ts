import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { listServerAuditEvents } from './audit-events.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureServerBootstrapToken } from './auth/bootstrap-token.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';

const OWNER_SESSION_HEADER = 'x-openkit-test-owner-session';

/** Creates a narrow Better Auth test double that recognizes only the explicit owner header. */
function ownerSessionAuth(): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) =>
        headers.get(OWNER_SESSION_HEADER) === '1'
          ? {
              session: { id: 'session_owner' },
              user: { id: 'user_owner' },
            }
          : null,
    },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/**
 * Inserts the canonical owner user used by direct access-token fixtures.
 *
 * @param coreDb Core database handles.
 */
function insertTokenOwnerUser(coreDb: CoreDb): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO users (
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
    .run(now, now);
}

describe('server-mode access-token auth', () => {
  it('consumes a bootstrap token through the public App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-bootstrap-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const bootstrap = ensureServerBootstrapToken(coreDb)!;
      const app = createApp({
        auth: {
          api: { getSession: async () => null },
          handler: async () => new Response(null, { status: 404 }),
        },
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const consumeBody = JSON.stringify({
        displayName: 'Owner',
        ownerUserId: 'user_owner',
        token: bootstrap.token,
        tokenExpiresAt: '2999-01-01T00:00:00.000Z',
      });
      const remotePlaintext = await app.request(
        new Request('http://public.example/api/app/auth/bootstrap/consume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: consumeBody,
        }),
        undefined,
        {
          incoming: {
            socket: {
              remoteAddress: '203.0.113.10',
              remoteFamily: 'IPv4',
              remotePort: 43123,
            },
          },
        }
      );

      const consumed = await app.request('/api/app/auth/bootstrap/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: consumeBody,
      });
      const consumedBody = (await consumed.json()) as {
        record: { ownerUserId: string; scope: string };
        token: string;
      };
      const listed = await app.request('/api/app/auth/tokens', {
        headers: { authorization: `Bearer ${consumedBody.token}` },
      });
      const secondConsume = await app.request('/api/app/auth/bootstrap/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: consumeBody,
      });

      expect(remotePlaintext.status).toBe(400);
      await expect(remotePlaintext.json()).resolves.toMatchObject({
        code: 'core.auth.insecure_transport',
      });
      expect(consumed.status).toBe(201);
      expect(consumedBody.record).toMatchObject({
        ownerUserId: 'user_owner',
        scope: 'server-admin',
      });
      expect(consumedBody.token).toMatch(/^okt_/);
      expect(listed.status).toBe(200);
      expect(secondConsume.status).toBe(409);
      expect(JSON.stringify(consumedBody)).not.toContain(bootstrap.token);
      const auditEvents = listServerAuditEvents(coreDb);
      expect(auditEvents.map((event) => event.action)).toContain('auth.bootstrap.consume');
      expect(JSON.stringify(auditEvents)).not.toContain(bootstrap.token);
      expect(JSON.stringify(auditEvents)).not.toContain(consumedBody.token);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('authenticates admin routes without granting bearer tokens ordinary Workspace access', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const denied = await app.request('/api/workspaces');
      const adminWorkspaceDenied = await app.request('/api/workspaces', {
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      const sessionAllowed = await app.request('/api/workspaces', {
        headers: { [OWNER_SESSION_HEADER]: '1' },
      });
      const listed = await app.request('/api/app/auth/tokens', {
        headers: {
          authorization: `Bearer ${issued.secret}`,
          'x-openkit-client-channel': 'mcp',
          'x-openkit-client-source': 'desktop-agent',
        },
      });
      const listedBody = (await listed.json()) as {
        items: Array<{
          lastUsedAt: string | null;
          lastUsedChannel: string | null;
          lastUsedSource: string | null;
        }>;
      };

      expect(denied.status).toBe(401);
      expect(adminWorkspaceDenied.status).toBe(403);
      await expect(adminWorkspaceDenied.json()).resolves.toMatchObject({
        code: 'workspace_access_denied',
      });
      expect(sessionAllowed.status).toBe(200);
      expect(listed.status).toBe(200);
      expect(listedBody.items[0]?.lastUsedAt).toEqual(expect.any(String));
      expect(listedBody.items[0]?.lastUsedChannel).toBe('mcp');
      expect(listedBody.items[0]?.lastUsedSource).toBe('desktop-agent');
      expect(await denied.text()).not.toContain(issued.secret);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('allows workspace tokens for workspaces owned by the token owner', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-seeded-workspace-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const createdWorkspace = await app.request('/api/workspaces', {
        method: 'POST',
        headers: {
          [OWNER_SESSION_HEADER]: '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Owned token workspace',
          requestId: '44444444-4444-4444-8444-444444444444',
        }),
      });
      const workspace = (await createdWorkspace.json()) as { id: string };
      const listed = await app.request('/api/workspaces', {
        headers: { [OWNER_SESSION_HEADER]: '1' },
      });
      const listedBody = (await listed.json()) as { items: Array<{ id: string }> };
      const created = await app.request('/api/app/auth/tokens', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scope: 'workspace-readonly',
          workspaceIds: [workspace.id],
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
      });

      expect(createdWorkspace.status).toBe(201);
      expect(listed.status).toBe(200);
      expect(listedBody.items.map((item) => item.id)).toContain(workspace.id);
      expect(created.status).toBe(201);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('issues, lists, and revokes access tokens through server-admin App API routes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-admin-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const workspaceResponse = await app.request('/api/workspaces', {
        method: 'POST',
        headers: {
          [OWNER_SESSION_HEADER]: '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Token administration workspace',
          requestId: '33333333-3333-4333-8333-333333333333',
        }),
      });
      const workspace = (await workspaceResponse.json()) as { id: string };
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: [workspace.id],
      });

      const created = await app.request('/api/app/auth/tokens', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scope: 'workspace-readonly',
          workspaceIds: [workspace.id],
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
      });
      const createdBody = (await created.json()) as {
        record: { tokenId: string; scope: string };
        token: string;
      };
      const unowned = await app.request('/api/app/auth/tokens', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scope: 'workspace',
          workspaceIds: ['ws_missing'],
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
      });
      const denied = await app.request('/api/app/auth/tokens', {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
      });
      const listed = await app.request('/api/app/auth/tokens', {
        headers: { authorization: `Bearer ${admin.secret}` },
      });
      const revoked = await app.request(
        `/api/app/auth/tokens/${createdBody.record.tokenId}/revoke`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${admin.secret}` },
        }
      );

      expect(workspaceResponse.status).toBe(201);
      expect(created.status).toBe(201);
      expect(createdBody.token).toMatch(/^okt_/);
      expect(createdBody.record.scope).toBe('workspace-readonly');
      expect(unowned.status).toBe(403);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(await listed.json())).not.toContain(createdBody.token);
      await expect(revoked.json()).resolves.toMatchObject({
        record: { status: 'revoked', tokenId: createdBody.record.tokenId },
      });
      const auditEvents = listServerAuditEvents(coreDb);
      expect(auditEvents.map((event) => event.action)).toEqual(
        expect.arrayContaining(['auth.token.issue', 'auth.token.revoke'])
      );
      expect(JSON.stringify(auditEvents)).not.toContain(admin.secret);
      expect(JSON.stringify(auditEvents)).not.toContain(createdBody.token);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies access-token administration to Better Auth sessions', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-session-admin-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const token = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
      });
      const app = createApp({
        auth: {
          api: {
            getSession: async () => ({
              session: { id: 'session_token_admin' },
              user: { id: 'user_owner' },
            }),
          },
          handler: async () => new Response(null, { status: 404 }),
        },
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const responses = await Promise.all([
        app.request('/api/app/auth/tokens'),
        app.request('/api/app/auth/tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expiresAt: '2999-01-01T00:00:00.000Z',
            scope: 'server-admin',
            workspaceIds: [],
          }),
        }),
        app.request(`/api/app/auth/tokens/${token.tokenId}/rotate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ graceSeconds: 60 }),
        }),
        app.request(`/api/app/auth/tokens/${token.tokenId}/revoke`, { method: 'POST' }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          code: 'access_token_admin_forbidden',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rotates access tokens through server-admin App API routes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-rotate-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const workspaceResponse = await app.request('/api/workspaces', {
        method: 'POST',
        headers: {
          [OWNER_SESSION_HEADER]: '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Rotated token workspace',
          requestId: '55555555-5555-4555-8555-555555555555',
        }),
      });
      const workspace = (await workspaceResponse.json()) as { id: string };
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: [workspace.id],
      });

      const rotated = await app.request(`/api/app/auth/tokens/${workspaceToken.tokenId}/rotate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ graceSeconds: 60 }),
      });
      const rotatedBody = (await rotated.json()) as {
        record: { predecessorTokenId: string; tokenId: string };
        rotatedRecord: { status: string; tokenId: string };
        token: string;
      };
      const oldStillWorks = await app.request(`/api/workspaces/${workspace.id}`, {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
      });
      const newWorks = await app.request(`/api/workspaces/${workspace.id}`, {
        headers: { authorization: `Bearer ${rotatedBody.token}` },
      });

      expect(workspaceResponse.status).toBe(201);
      expect(rotated.status).toBe(200);
      expect(rotatedBody.token).toMatch(/^okt_/);
      expect(rotatedBody.token).not.toBe(workspaceToken.secret);
      expect(rotatedBody.record.predecessorTokenId).toBe(workspaceToken.tokenId);
      expect(rotatedBody.rotatedRecord).toMatchObject({
        status: 'rotated',
        tokenId: workspaceToken.tokenId,
      });
      expect(oldStillWorks.status).toBe(200);
      expect(newWorks.status).toBe(200);
      expect(JSON.stringify(rotatedBody)).not.toContain(workspaceToken.secret);
      const auditEvents = listServerAuditEvents(coreDb);
      expect(auditEvents.map((event) => event.action)).toContain('auth.token.rotate');
      expect(JSON.stringify(auditEvents)).not.toContain(admin.secret);
      expect(JSON.stringify(auditEvents)).not.toContain(workspaceToken.secret);
      expect(JSON.stringify(auditEvents)).not.toContain(rotatedBody.token);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('enforces workspace-scoped token route gates in the App API path', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-scope-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: ['ws_allowed'],
      });
      const readonlyToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_allowed'],
      });
      const app = createApp({
        auth: {
          api: { getSession: async () => null },
          handler: async () => new Response(null, { status: 404 }),
        },
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const unbound = await app.request('/api/app/workspaces/ws_denied/dashboard', {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
      });
      const readonlyWrite = await app.request('/api/workspaces/ws_allowed/threads', {
        method: 'POST',
        headers: { authorization: `Bearer ${readonlyToken.secret}` },
        body: JSON.stringify({ name: 'Blocked thread', requestId: 'req_blocked_thread' }),
      });

      expect(unbound.status).toBe(403);
      expect(readonlyWrite.status).toBe(403);
      expect(await unbound.text()).not.toContain('ws_denied');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('filters workspace collection reads for workspace-scoped tokens', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-workspace-list-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const allowedWorkspaceResponse = await app.request('/api/workspaces', {
        method: 'POST',
        headers: {
          [OWNER_SESSION_HEADER]: '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Allowed',
          requestId: '11111111-1111-4111-8111-111111111111',
        }),
      });
      const allowedWorkspace = (await allowedWorkspaceResponse.json()) as { id: string };
      const deniedWorkspaceResponse = await app.request('/api/workspaces', {
        method: 'POST',
        headers: {
          [OWNER_SESSION_HEADER]: '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Denied',
          requestId: '22222222-2222-4222-8222-222222222222',
        }),
      });
      const deniedWorkspace = (await deniedWorkspaceResponse.json()) as { id: string };
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: [allowedWorkspace.id],
      });
      const listed = await app.request('/api/workspaces', {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
      });
      const listedBody = (await listed.json()) as { items: Array<{ id: string }> };
      const transferredAt = new Date().toISOString();
      coreDb.sqlite.transaction(() => {
        coreDb.sqlite
          .prepare(
            `INSERT INTO users
              (id, display_name, email, email_verified, created_at, updated_at, kind)
             VALUES ('user_replacement_owner', 'Replacement Owner',
                     'token-replacement@example.com', false, ?, ?, 'human')`
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
          .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .run(allowedWorkspace.id, 'user_owner');
      })();
      const listedAfterMembershipRemoval = await app.request('/api/workspaces', {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
      });
      const listedAfterMembershipRemovalBody = (await listedAfterMembershipRemoval.json()) as {
        items: Array<{ id: string }>;
      };

      expect(allowedWorkspaceResponse.status).toBe(201);
      expect(deniedWorkspaceResponse.status).toBe(201);
      expect(listed.status).toBe(200);
      expect(listedBody.items.map((workspace) => workspace.id)).toEqual([allowedWorkspace.id]);
      expect(JSON.stringify(listedBody)).not.toContain(deniedWorkspace.id);
      expect(listedAfterMembershipRemoval.status).toBe(200);
      expect(listedAfterMembershipRemovalBody.items).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
