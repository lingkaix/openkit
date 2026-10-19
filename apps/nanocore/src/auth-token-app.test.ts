import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listServerAuditEvents } from './audit-events.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { createBetterAuth } from './auth/better-auth.js';
import { ensureServerBootstrapToken } from './auth/bootstrap-token.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';

const OWNER_SESSION_HEADER = 'x-openkit-test-owner-session';
const MEMBER_SESSION_HEADER = 'x-openkit-test-member-session';

/** Creates a narrow Better Auth test double that recognizes explicit owner or member session headers. */
function ownerSessionAuth(): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) => {
        if (headers.get(OWNER_SESSION_HEADER) === '1') {
          return {
            session: { id: 'session_owner' },
            user: { id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f' },
          };
        }
        if (headers.get(MEMBER_SESSION_HEADER) === '1') {
          return {
            session: { id: 'session_member' },
            user: { id: 'usr_00000000-0000-7d56-82f8-ec994b63859b' },
          };
        }
        return null;
      },
    },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/** Extracts the session cookie pair from one Better Auth response. */
function sessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');

  if (!setCookie) {
    throw new Error('Expected response to set a session cookie.');
  }

  return setCookie.split(';')[0] ?? '';
}

/**
 * Inserts the canonical owner user used by direct access-token fixtures.
 *
 * @param coreDb Core database handles.
 */
function insertTokenOwnerUser(coreDb: CoreDb): void {
  insertCanonicalUser(
    coreDb,
    'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    'Owner',
    'owner@example.com'
  );
}

/**
 * Inserts one canonical human user used by access-token fixtures.
 *
 * @param coreDb Core database handles.
 * @param userId Canonical user id.
 * @param displayName Display name.
 * @param email Unique email.
 */
function insertCanonicalUser(
  coreDb: CoreDb,
  userId: string,
  displayName: string,
  email: string
): void {
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
       VALUES (?, ?, ?, false, NULL, ?, ?, 'human', NULL)`
    )
    .run(userId, displayName, email, now, now);
}

describe('server-mode access-token auth', () => {
  it('consumes a bootstrap token into a login-capable server administrator', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-bootstrap-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const bootstrap = ensureServerBootstrapToken(coreDb)!;
      const app = createApp({
        auth: createBetterAuth(coreDb),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const consumeBody = JSON.stringify({
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        password: 'password123456',
        token: bootstrap.token,
        tokenExpiresAt: '2999-01-01T00:00:00.000Z',
      });
      const remotePlaintext = await app.request(
        new Request('http://public.example/api/app/operations/bootstrap.consume', {
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

      const consumed = await app.request('/api/app/operations/bootstrap.consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: consumeBody,
      });
      const consumedBody = (await consumed.json()) as {
        record: { ownerUserId: string; scope: string };
        token: string;
      };
      const bootstrapOwner = coreDb.sqlite
        .prepare('SELECT id, email FROM users WHERE id = ?')
        .get('usr_00000000-0000-7011-88df-c2b1e8466b6f') as
        | { email: string; id: string }
        | undefined;
      const bootstrapCredential = coreDb.sqlite
        .prepare('SELECT account_id, provider_id, user_id FROM account WHERE user_id = ?')
        .get('usr_00000000-0000-7011-88df-c2b1e8466b6f') as
        | { account_id: string; provider_id: string; user_id: string }
        | undefined;
      const listed = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: { authorization: `Bearer ${consumedBody.token}` },
          }
        )
      );
      const signIn = await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', password: 'password123456' }),
      });

      expect(remotePlaintext.status).toBe(400);
      await expect(remotePlaintext.json()).resolves.toMatchObject({
        code: 'core.auth.insecure_transport',
      });
      expect(consumed.status).toBe(201);
      expect(consumedBody.record).toMatchObject({
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
      });
      expect(consumedBody.token).toMatch(/^okt_/);
      expect(bootstrapOwner).toEqual({
        email: 'owner@example.com',
        id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      });
      expect(bootstrapCredential).toEqual({
        account_id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        provider_id: 'credential',
        user_id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      });
      expect(listed.status).toBe(200);
      expect(signIn.status).toBe(200);
      const sessionAdminTokens = await app.request(
        ...operationRequest(
          'token.my-admin-list',
          {},
          {
            headers: { cookie: sessionCookie(signIn) },
          }
        )
      );
      const secondConsume = await app.request('/api/app/operations/bootstrap.consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: consumeBody,
      });
      expect(sessionAdminTokens.status).toBe(200);
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

  it('authenticates admin routes and grants usable server-admin bearer tokens Workspace authority', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      insertCanonicalUser(
        coreDb,
        'usr_00000000-0000-7d56-82f8-ec994b63859b',
        'Member',
        'member@example.com'
      );
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const denied = await app.request('/api/app/operations/workspace.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const memberWorkspace = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [MEMBER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Member owned workspace',
              requestId: '11111111-1111-4111-8111-111111111111',
            }),
          }
        )
      );
      const memberWorkspaceBody = (await memberWorkspace.json()) as { id: string };
      const adminWorkspaceList = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { authorization: `Bearer ${issued.secret}` },
        },
        method: 'POST',
        headers: {
          ...{ authorization: `Bearer ${issued.secret}` },
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const adminWorkspaceListBody = (await adminWorkspaceList.json()) as {
        items: Array<{ workspace: { id: string } }>;
      };
      const adminCreated = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${issued.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Admin created workspace',
              requestId: '22222222-2222-4222-8222-222222222222',
            }),
          }
        )
      );
      const adminCreatedBody = (await adminCreated.json()) as { id: string; ownerUserId?: string };
      const sessionAllowed = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { [OWNER_SESSION_HEADER]: '1' },
        },
        method: 'POST',
        headers: { ...{ [OWNER_SESSION_HEADER]: '1' }, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const listed = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: {
              authorization: `Bearer ${issued.secret}`,
              'x-openkit-client-channel': 'mcp',
              'x-openkit-client-source': 'desktop-agent',
            },
          }
        )
      );
      const listedBody = (await listed.json()) as {
        items: Array<{
          lastUsedAt: string | null;
          lastUsedChannel: string | null;
          lastUsedSource: string | null;
        }>;
      };
      coreDb.sqlite
        .prepare(
          `UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?`
        )
        .run(new Date().toISOString(), issued.tokenId);
      const revokedDenied = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { authorization: `Bearer ${issued.secret}` },
        },
        method: 'POST',
        headers: {
          ...{ authorization: `Bearer ${issued.secret}` },
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(denied.status).toBe(401);
      expect(memberWorkspace.status).toBe(201);
      expect(adminWorkspaceList.status).toBe(200);
      expect(adminWorkspaceListBody.items.map((entry) => entry.workspace.id)).toEqual(
        expect.arrayContaining([memberWorkspaceBody.id])
      );
      expect(adminCreated.status).toBe(201);
      expect(adminCreatedBody.id).toEqual(expect.any(String));
      expect(sessionAllowed.status).toBe(200);
      expect(listed.status).toBe(200);
      expect(listedBody.items[0]?.lastUsedAt).toEqual(expect.any(String));
      expect(listedBody.items[0]?.lastUsedChannel).toBe('mcp');
      expect(listedBody.items[0]?.lastUsedSource).toBe('desktop-agent');
      expect(revokedDenied.status).toBe(401);
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });

      const createdWorkspace = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [OWNER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Owned token workspace',
              requestId: '44444444-4444-4444-8444-444444444444',
            }),
          }
        )
      );
      const workspace = (await createdWorkspace.json()) as { id: string };
      const listed = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { [OWNER_SESSION_HEADER]: '1' },
        },
        method: 'POST',
        headers: { ...{ [OWNER_SESSION_HEADER]: '1' }, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const listedBody = (await listed.json()) as { items: Array<{ workspace: { id: string } }> };
      const created = await app.request(
        ...operationRequest(
          'token.create',
          {},
          {
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
          }
        )
      );

      expect(createdWorkspace.status).toBe(201);
      expect(listed.status).toBe(200);
      expect(listedBody.items.map((entry) => entry.workspace.id)).toContain(workspace.id);
      expect(created.status).toBe(201);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('issues, lists, and revokes access tokens through canonical administrator operations', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-admin-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const workspaceResponse = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [OWNER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Token administration workspace',
              requestId: '33333333-3333-4333-8333-333333333333',
            }),
          }
        )
      );
      const workspace = (await workspaceResponse.json()) as { id: string };
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: [workspace.id],
      });

      const created = await app.request(
        ...operationRequest(
          'token.create',
          {},
          {
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
          }
        )
      );
      const createdBody = (await created.json()) as {
        record: { tokenId: string; scope: string };
        token: string;
      };
      const unowned = await app.request(
        ...operationRequest(
          'token.create',
          {},
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${admin.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              scope: 'workspace',
              workspaceIds: ['ws_00000000-0000-7490-845b-dcfa3ee49925'],
              expiresAt: '2999-01-01T00:00:00.000Z',
            }),
          }
        )
      );
      const denied = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: { authorization: `Bearer ${workspaceToken.secret}` },
          }
        )
      );
      const listed = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: { authorization: `Bearer ${admin.secret}` },
          }
        )
      );
      const revoked = await app.request(
        ...operationRequest(
          'token.revoke',
          { tokenId: createdBody.record.tokenId },
          {
            method: 'POST',
            headers: { authorization: `Bearer ${admin.secret}` },
          }
        )
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
      const issueEvent = auditEvents.find((event) => event.action === 'auth.token.issue');
      const revokeEvent = auditEvents.find((event) => event.action === 'auth.token.revoke');
      expect(auditEvents.map((event) => event.action)).toEqual(
        expect.arrayContaining(['auth.token.issue', 'auth.token.revoke'])
      );
      expect(issueEvent).toMatchObject({
        actor: { kind: 'user', id: admin.record.ownerUserId },
        authentication: { credentialKind: 'token', credentialId: admin.tokenId },
        resource: `auth-token:${createdBody.record.tokenId}`,
      });
      expect(revokeEvent).toMatchObject({
        actor: { kind: 'user', id: admin.record.ownerUserId },
        authentication: { credentialKind: 'token', credentialId: admin.tokenId },
      });
      expect(issueEvent?.summary).toContain(`using presented admin ${admin.tokenId}`);
      expect(revokeEvent?.summary).toContain(`using presented admin ${admin.tokenId}`);
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      });
      const app = createApp({
        auth: {
          api: {
            getSession: async () => ({
              session: { id: 'session_token_admin' },
              user: { id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f' },
            }),
          },
          handler: async () => new Response(null, { status: 404 }),
        },
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const responses = await Promise.all([
        app.request(...operationRequest('token.list', {}, {})),
        app.request(
          ...operationRequest(
            'token.create',
            {},
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                expiresAt: '2999-01-01T00:00:00.000Z',
                scope: 'server-admin',
                workspaceIds: [],
              }),
            }
          )
        ),
        app.request(
          ...operationRequest(
            'token.rotate',
            { tokenId: token.tokenId },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ graceSeconds: 60 }),
            }
          )
        ),
        app.request(
          ...operationRequest('token.revoke', { tokenId: token.tokenId }, { method: 'POST' })
        ),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          code: 'deployment_admin_required',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rotates access tokens through canonical administrator operations', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-rotate-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const workspaceResponse = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [OWNER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Rotated token workspace',
              requestId: '55555555-5555-4555-8555-555555555555',
            }),
          }
        )
      );
      const workspace = (await workspaceResponse.json()) as { id: string };
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: [workspace.id],
      });

      const rotated = await app.request(
        ...operationRequest(
          'token.rotate',
          { tokenId: workspaceToken.tokenId },
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${admin.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ graceSeconds: 60 }),
          }
        )
      );
      const rotatedBody = (await rotated.json()) as {
        record: { predecessorTokenId: string; tokenId: string };
        rotatedRecord: { status: string; tokenId: string };
        token: string;
      };
      const oldStillWorks = await app.request(
        ...operationRequest(
          'workspace.read',
          { workspaceId: workspace.id },
          {
            headers: { authorization: `Bearer ${workspaceToken.secret}` },
          }
        )
      );
      const newWorks = await app.request(
        ...operationRequest(
          'workspace.read',
          { workspaceId: workspace.id },
          {
            headers: { authorization: `Bearer ${rotatedBody.token}` },
          }
        )
      );

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
      const rotateEvent = auditEvents.find((event) => event.action === 'auth.token.rotate');
      expect(auditEvents.map((event) => event.action)).toContain('auth.token.rotate');
      expect(rotateEvent?.summary).toContain(`using presented admin ${admin.tokenId}`);
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7056-a1a1-4f49a5d58035'],
      });
      const readonlyToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7056-a1a1-4f49a5d58035'],
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

      const unbound = await app.request(
        ...operationRequest(
          'workspace.dashboard',
          { workspaceId: 'ws_00000000-0000-77e6-9d59-59f0f02f181e' },
          {
            headers: { authorization: `Bearer ${workspaceToken.secret}` },
          }
        )
      );
      const readonlyWrite = await ((input: Record<string, unknown>) =>
        app.request('/api/app/operations/thread.create', {
          method: 'POST',
          headers: {
            ...{
              ...{ authorization: `Bearer ${readonlyToken.secret}` },
              'content-type': 'application/json',
              'x-openkit-request-id': '11111111-1111-4111-8111-111111111901',
            },
            ...(typeof input.requestId === 'string'
              ? { 'x-openkit-request-id': input.requestId }
              : {}),
          },
          body: JSON.stringify(input),
        }))({
        ...{ name: 'Blocked thread', requestId: '11111111-1111-4111-8111-111111111901' },
        workspaceId: 'ws_00000000-0000-7056-a1a1-4f49a5d58035',
      });

      expect(unbound.status).toBe(403);
      expect(readonlyWrite.status).toBe(403);
      expect(await unbound.text()).not.toContain('ws_00000000-0000-77e6-9d59-59f0f02f181e');
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

      const allowedWorkspaceResponse = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [OWNER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Allowed',
              requestId: '11111111-1111-4111-8111-111111111111',
            }),
          }
        )
      );
      const allowedWorkspace = (await allowedWorkspaceResponse.json()) as { id: string };
      const deniedWorkspaceResponse = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [OWNER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Denied',
              requestId: '22222222-2222-4222-8222-222222222222',
            }),
          }
        )
      );
      const deniedWorkspace = (await deniedWorkspaceResponse.json()) as { id: string };
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'workspace',
        workspaceIds: [allowedWorkspace.id],
      });
      const listed = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { authorization: `Bearer ${workspaceToken.secret}` },
        },
        method: 'POST',
        headers: {
          ...{ authorization: `Bearer ${workspaceToken.secret}` },
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const listedBody = (await listed.json()) as { items: Array<{ workspace: { id: string } }> };
      const transferredAt = new Date().toISOString();
      coreDb.sqlite.transaction(() => {
        coreDb.sqlite
          .prepare(
            `INSERT INTO users
              (id, display_name, email, email_verified, created_at, updated_at, kind)
             VALUES ('usr_00000000-0000-7cfc-ba59-df60b2f09c20', 'Replacement Owner',
                     'token-replacement@example.com', false, ?, ?, 'human')`
          )
          .run(Date.now(), Date.now());
        coreDb.sqlite
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, status, invitation_id,
              joined_at, removed_at, revision, created_at, updated_at
            ) VALUES (?, 'usr_00000000-0000-7cfc-ba59-df60b2f09c20', 'active', NULL, ?, NULL, 1, ?, ?)`
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
          .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .run(allowedWorkspace.id, 'usr_00000000-0000-7011-88df-c2b1e8466b6f');
      })();
      const listedAfterMembershipRemoval = await app.request('/api/app/operations/workspace.list', {
        ...{
          headers: { authorization: `Bearer ${workspaceToken.secret}` },
        },
        method: 'POST',
        headers: {
          ...{ authorization: `Bearer ${workspaceToken.secret}` },
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const listedAfterMembershipRemovalBody = (await listedAfterMembershipRemoval.json()) as {
        items: Array<{ workspace: { id: string } }>;
      };

      expect(allowedWorkspaceResponse.status).toBe(201);
      expect(deniedWorkspaceResponse.status).toBe(201);
      expect(listed.status).toBe(200);
      expect(listedBody.items.map((entry) => entry.workspace.id)).toEqual([allowedWorkspace.id]);
      expect(JSON.stringify(listedBody)).not.toContain(deniedWorkspace.id);
      expect(listedAfterMembershipRemoval.status).toBe(200);
      expect(listedAfterMembershipRemovalBody.items).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('issues workspace tokens only when the target owner is an active member of every requested workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-target-owner-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      insertCanonicalUser(
        coreDb,
        'usr_00000000-0000-7d56-82f8-ec994b63859b',
        'Member',
        'member@example.com'
      );
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const ownerWorkspace = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [OWNER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Owner workspace',
              requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            }),
          }
        )
      );
      const memberWorkspace = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [MEMBER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Member workspace',
              requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            }),
          }
        )
      );
      const memberWorkspaceBody = (await memberWorkspace.json()) as { id: string };
      const issuedToMember = await app.request(
        ...operationRequest(
          'token.create',
          {},
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${admin.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              expiresAt: '2999-01-01T00:00:00.000Z',
              ownerUserId: 'usr_00000000-0000-7d56-82f8-ec994b63859b',
              scope: 'workspace',
              workspaceIds: [memberWorkspaceBody.id],
            }),
          }
        )
      );
      const issuedToMemberBody = (await issuedToMember.json()) as {
        record: { ownerUserId: string; scope: string };
        token: string;
      };
      const issuedToCaller = await app.request(
        ...operationRequest(
          'token.create',
          {},
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${admin.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              expiresAt: '2999-01-01T00:00:00.000Z',
              ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
              scope: 'workspace',
              workspaceIds: [memberWorkspaceBody.id],
            }),
          }
        )
      );
      const missingOwner = await app.request(
        ...operationRequest(
          'token.create',
          {},
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${admin.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              expiresAt: '2999-01-01T00:00:00.000Z',
              ownerUserId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
              scope: 'server-admin',
              workspaceIds: [],
            }),
          }
        )
      );

      expect(ownerWorkspace.status).toBe(201);
      expect(memberWorkspace.status).toBe(201);
      expect(issuedToMember.status).toBe(201);
      expect(issuedToMemberBody.record).toMatchObject({
        ownerUserId: 'usr_00000000-0000-7d56-82f8-ec994b63859b',
        scope: 'workspace',
      });
      expect(issuedToCaller.status).toBe(403);
      expect(missingOwner.status).toBe(400);
      expect(JSON.stringify(issuedToMemberBody)).not.toContain(admin.secret);
      expect(issuedToMemberBody.token).toMatch(/^okt_/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('derives session deployment-admin from a usable owned server-admin token and drops it on revocation', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-derived-session-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      insertCanonicalUser(
        coreDb,
        'usr_00000000-0000-7d56-82f8-ec994b63859b',
        'Member',
        'member@example.com'
      );
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-75d5-969a-53fce04182b5',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const deniedMember = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: { [MEMBER_SESSION_HEADER]: '1' },
          }
        )
      );
      const allowedOwner = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );
      const mine = await app.request(
        ...operationRequest(
          'token.my-admin-list',
          {},
          {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );
      const mineBody = (await mine.json()) as {
        defaultTokenId: string | null;
        items: Array<{ ownerUserId: string; scope: string; tokenId: string }>;
      };
      const bearerMine = await app.request(
        ...operationRequest(
          'token.my-admin-list',
          {},
          {
            headers: { authorization: `Bearer ${admin.secret}` },
          }
        )
      );
      const otherWorkspace = await app.request(
        ...operationRequest(
          'workspace.create',
          {},
          {
            method: 'POST',
            headers: {
              [MEMBER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Member only',
              requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            }),
          }
        )
      );
      const otherWorkspaceBody = (await otherWorkspace.json()) as { id: string };
      const bypassDenied = await app.request(
        ...operationRequest(
          'workspace.read',
          { workspaceId: otherWorkspaceBody.id },
          {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );
      const revoked = await app.request(
        ...operationRequest(
          'token.revoke',
          { tokenId: admin.tokenId },
          {
            method: 'POST',
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );
      const afterRevoke = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );

      expect(deniedMember.status).toBe(403);
      expect(allowedOwner.status).toBe(200);
      expect(mine.status).toBe(200);
      expect(mineBody).toMatchObject({
        defaultTokenId: admin.tokenId,
        items: [
          {
            tokenId: admin.tokenId,
            ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
            scope: 'server-admin',
          },
        ],
      });
      expect(bearerMine.status).toBe(200);
      expect(await bearerMine.json()).toMatchObject({
        items: [
          { tokenId: admin.tokenId, ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f' },
        ],
      });
      expect(otherWorkspace.status).toBe(201);
      expect(bypassDenied.status).toBe(200);
      expect(revoked.status).toBe(200);
      expect(afterRevoke.status).toBe(403);
      expect(JSON.stringify(mineBody)).not.toContain(admin.secret);
      const revokeEvent = listServerAuditEvents(coreDb).find(
        (event) => event.action === 'auth.token.revoke'
      );
      expect(revokeEvent?.summary).toContain(`using derived admin ${admin.tokenId}`);
      expect(JSON.stringify(revokeEvent)).not.toContain(admin.secret);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('selects an owned usable default and falls back after that default is revoked', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-token-session-default-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const first = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        now: new Date('2026-08-30T00:00:00.000Z'),
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-7dab-b761-7bf989db36ad',
        workspaceIds: [],
      });
      const second = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        now: new Date('2026-08-30T00:01:00.000Z'),
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        tokenId: 'tok_00000000-0000-7738-b866-40ef37604600',
        workspaceIds: [],
      });
      const app = createApp({
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      });
      const selected = await app.request(
        ...operationRequest(
          'token.my-admin-default',
          {},
          {
            method: 'POST',
            headers: {
              [OWNER_SESSION_HEADER]: '1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ tokenId: first.tokenId }),
          }
        )
      );
      const listed = await app.request(
        ...operationRequest(
          'token.list',
          {},
          {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );
      await app.request(
        ...operationRequest(
          'token.revoke',
          { tokenId: first.tokenId },
          {
            method: 'POST',
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );
      const afterRevoke = await app.request(
        ...operationRequest(
          'token.my-admin-list',
          {},
          {
            headers: { [OWNER_SESSION_HEADER]: '1' },
          }
        )
      );

      expect(selected.status).toBe(200);
      await expect(selected.json()).resolves.toMatchObject({ defaultTokenId: first.tokenId });
      expect(listed.status).toBe(200);
      expect(afterRevoke.status).toBe(200);
      await expect(afterRevoke.json()).resolves.toMatchObject({
        defaultTokenId: second.tokenId,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('personal administrator-token canonical-user access', () => {
  it('lists only local-owned admin tokens and persists a valid local default', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-local-admin-tokens-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      insertTokenOwnerUser(coreDb);
      for (const [tokenId, ownerUserId] of [
        ['tok_00000000-0000-7c1a-914e-7b3f8202307f', 'usr_00000000-0000-7000-8000-000000000001'],
        ['tok_00000000-0000-738c-a01b-b50e38d149f1', 'usr_00000000-0000-7000-8000-000000000001'],
        ['tok_00000000-0000-7358-9dd3-3d116e8695d2', 'usr_00000000-0000-7011-88df-c2b1e8466b6f'],
      ]) {
        createOpenKitAccessTokenRecord(coreDb, {
          tokenId,
          ownerUserId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
      }
      const app = createApp({ coreDb, dataRoot, mode: 'local' });
      const listed = await app.request(...operationRequest('token.my-admin-list', {}, {}));
      expect(listed.status).toBe(200);
      const body = await listed.json();
      expect(body.items.map((item: { tokenId: string }) => item.tokenId).sort()).toEqual(
        [
          'tok_00000000-0000-7c1a-914e-7b3f8202307f',
          'tok_00000000-0000-738c-a01b-b50e38d149f1',
        ].sort()
      );
      expect(JSON.stringify(body)).not.toMatch(/okt_|tokenHash|secret/);
      const selected = await app.request(
        ...operationRequest(
          'token.my-admin-default',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tokenId: 'tok_00000000-0000-738c-a01b-b50e38d149f1' }),
          }
        )
      );
      expect(selected.status).toBe(200);
      expect((await selected.json()).defaultTokenId).toBe(
        'tok_00000000-0000-738c-a01b-b50e38d149f1'
      );
      for (const tokenId of [
        'tok_00000000-0000-7358-9dd3-3d116e8695d2',
        'tok_00000000-0000-7497-9e7b-7d920342ffdc',
      ]) {
        const invalid = await app.request(
          ...operationRequest(
            'token.my-admin-default',
            {},
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tokenId }),
            }
          )
        );
        expect(invalid.status).toBe(400);
        expect((await invalid.json()).code).toBe('access_token_default_invalid');
      }
      const after = await app.request(...operationRequest('token.my-admin-list', {}, {}));
      expect((await after.json()).defaultTokenId).toBe('tok_00000000-0000-738c-a01b-b50e38d149f1');
      for (const [id, input] of [
        ['token.list', {}],
        ['token.create', { scope: 'server-admin', expiresAt: '2999-01-01T00:00:00.000Z' }],
        ['token.rotate', { tokenId: 'tok_00000000-0000-7c1a-914e-7b3f8202307f' }],
      ] as const) {
        const response = await app.request(
          ...operationRequest(id, {}, { body: JSON.stringify(input) })
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          code: 'access_token_admin_server_mode_required',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('admits current administrator bearers to both personal administrator-token operations', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-admin-tokens-bearer-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      insertTokenOwnerUser(coreDb);
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const app = createApp({ auth: ownerSessionAuth(), coreDb, dataRoot, mode: 'server' });
      for (const [id, input] of [
        ['token.my-admin-list', {}],
        ['token.my-admin-default', { tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629' }],
      ] as const) {
        const admitted = await app.request(
          ...operationRequest(
            id,
            {},
            {
              headers: { authorization: `Bearer ${admin.secret}` },
              body: JSON.stringify(input),
            }
          )
        );
        expect(admitted.status).toBe(200);
        expect(await admitted.json()).toMatchObject({
          items: [
            {
              tokenId: 'tok_00000000-0000-75c5-b4dc-6661b8eac629',
              ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
            },
          ],
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});
