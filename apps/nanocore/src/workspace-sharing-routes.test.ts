import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { recordServerAuditEvent } from './audit-events.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { PUBLIC_OPERATION_ACCESS } from './auth/operation-access.js';
import { FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import { getRegisteredAppApiOperationIds } from './openapi.js';
import type { CoreDb } from './storage/db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { registerWorkspaceSharingRoutes } from './workspace-sharing-routes.js';

const openDatabases: CoreDb[] = [];
const SHARING_OPERATION_IDS = [
  'listAuthorizedWorkspaces',
  'listWorkspaceMembers',
  'listWorkspaceInvitations',
  'createWorkspaceInvitation',
  'listMyWorkspaceInvitations',
  'acceptWorkspaceInvitation',
  'declineWorkspaceInvitation',
  'revokeWorkspaceInvitation',
  'changeWorkspaceMemberAccess',
  'removeWorkspaceMember',
  'leaveWorkspace',
  'transferWorkspaceOwnership',
  'getWorkspaceAccessRecoveryState',
  'recoverWorkspaceAccess',
  'disableUser',
] as const;

/** Mutable actor holder used by one route fixture. */
interface ActorState {
  /** Actor installed on the next request. */
  current: Actor;
}

/** Complete direct route fixture with real Core storage. */
interface RouteFixture {
  /** Hono app containing only the sharing routes and request context. */
  app: Hono<{ Variables: AuthVariables }>;
  /** Mutable request actor. */
  actorState: ActorState;
  /** Migrated Core database. */
  coreDb: CoreDb;
  /** Canonical shared Workspace store. */
  store: FsStore;
  /** Process-local deletion admission used by the route fixture. */
  workspaceMutationAdmission: WorkspaceMutationAdmission;
  /** Primary shared Workspace id. */
  workspaceId: string;
  /** Second Workspace used for lineage denial. */
  foreignWorkspaceId: string;
}

/** Inserts one active canonical user. */
function insertUser(coreDb: CoreDb, userId: string, email: string): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
      ) VALUES (?, ?, ?, false, ?, ?, 'human', 'active', NULL)`
    )
    .run(userId, userId, email, now, now);
}

/** Inserts one active non-owner membership. */
function insertMember(
  coreDb: CoreDb,
  workspaceId: string,
  userId: string,
  accessLevel: 'editor' | 'viewer'
): void {
  const now = '2026-07-19T00:00:00.000Z';
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, NULL, ?, NULL, 1, ?, ?)`
    )
    .run(workspaceId, userId, accessLevel, now, now, now);
}

/** Creates one direct route fixture without duplicating central-authorizer tests. */
function createFixture(): RouteFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-sharing-routes-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  openDatabases.push(coreDb);

  for (const [userId, email] of [
    ['user_owner', 'owner@example.com'],
    ['user_invitee', 'invitee@example.com'],
    ['user_editor', 'editor@example.com'],
    ['user_viewer', 'viewer@example.com'],
    ['user_admin', 'admin@example.com'],
    ['user_disable', 'disable@example.com'],
  ] as const) {
    insertUser(coreDb, userId, email);
  }

  const store = new FsStore();
  const workspaceId = store.createWorkspace('Shared Workspace').id;
  const foreignWorkspaceId = store.createWorkspace('Foreign Workspace').id;
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_owner', workspaceId });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_owner',
    workspaceId: foreignWorkspaceId,
  });
  insertMember(coreDb, workspaceId, 'user_editor', 'editor');
  insertMember(coreDb, workspaceId, 'user_viewer', 'viewer');

  const actorState: ActorState = { current: { kind: 'session', userId: 'user_owner' } };
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', actorState.current);
    const pathWorkspaceId = /^\/api\/app\/workspaces\/([^/]+)/.exec(context.req.path)?.[1];
    if (pathWorkspaceId) {
      context.set('workspaceAccess', {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'workspace.read',
        workspaceId: pathWorkspaceId,
      });
    } else if (context.req.path === '/api/app/workspaces') {
      context.set('workspaceAccess', {
        kind: 'workspace-set',
        policyOperation: 'workspace.read',
        workspaceIds: [workspaceId],
      });
    }
    await next();
  });
  registerWorkspaceSharingRoutes({
    app,
    coreDb,
    inflightCommands: new WeakMap(),
    requestStore: () => store,
    workspaceMutationAdmission,
  });

  return {
    app,
    actorState,
    coreDb,
    foreignWorkspaceId,
    store,
    workspaceId,
    workspaceMutationAdmission,
  };
}

/** Sends one JSON request to a route fixture. */
function jsonRequest(app: RouteFixture['app'], path: string, method: string, body: unknown) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  });
}

afterEach(() => {
  for (const coreDb of openDatabases.splice(0)) {
    coreDb.sqlite.close();
  }
});

describe('Workspace sharing routes', () => {
  it('registers the exact closed operation surface and access owners', () => {
    const fixture = createFixture();

    expect(getRegisteredAppApiOperationIds(fixture.app)).toEqual(SHARING_OPERATION_IDS);
    expect(PUBLIC_OPERATION_ACCESS).toMatchObject({
      listAuthorizedWorkspaces: {
        policyOperation: 'workspace.read',
        resolver: 'authorized-workspace-set',
        scope: 'workspace',
      },
      listMyWorkspaceInvitations: {
        authentication: 'canonical-user',
        policyOperation: 'invitation.respond',
        scope: 'user',
      },
      leaveWorkspace: {
        authentication: 'canonical-user',
        policyOperation: 'workspace.leave',
        scope: 'user',
      },
      recoverWorkspaceAccess: {
        authentication: 'deployment-admin',
        policyOperation: 'deployment.recover',
        scope: 'server',
      },
      transferWorkspaceOwnership: {
        policyOperation: 'workspace.lifecycle',
        resolver: 'path-workspace',
        scope: 'workspace',
      },
    });
  });

  it('projects only the centrally authorized Workspace set', async () => {
    const fixture = createFixture();
    const response = await fixture.app.request('/api/app/workspaces');
    const body = await response.json();

    expect({ body, status: response.status }).toMatchObject({
      body: { items: [{ effectiveRole: 'owner', workspace: { id: fixture.workspaceId } }] },
      status: 200,
    });
  });

  it('hides own invitations for fenced and deleting Workspaces', async () => {
    const fixture = createFixture();
    const now = '2026-07-19T00:00:00.000Z';
    for (const [invitationId, workspaceId] of [
      ['inv_fenced', fixture.workspaceId],
      ['inv_deleting', fixture.foreignWorkspaceId],
    ] as const) {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_invitations (
            invitation_id, workspace_id, invitee_user_id, proposed_access_level, inviter_user_id,
            status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
          ) VALUES (?, ?, 'user_invitee', 'viewer', 'user_owner', 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
        )
        .run(invitationId, workspaceId, '2026-07-26T00:00:00.000Z', now, now);
    }
    await fixture.workspaceMutationAdmission.close(fixture.workspaceId);
    fixture.coreDb.sqlite
      .prepare(
        `UPDATE workspace_registry
         SET status = 'deleting', revision = revision + 1, updated_at = ?
         WHERE workspace_id = ?`
      )
      .run(now, fixture.foreignWorkspaceId);
    fixture.actorState.current = { kind: 'session', userId: 'user_invitee' };

    const response = await fixture.app.request('/api/app/workspace-invitations');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [] });
  });

  it('commits one lifecycle audit and pointer receipt, replays, and rejects changed input', async () => {
    const fixture = createFixture();
    const path = `/api/app/workspaces/${fixture.workspaceId}/invitations`;
    const requestId = '00000000-0000-4000-8000-000000000001';
    const input = {
      inviteeEmail: 'invitee@example.com',
      proposedAccessLevel: 'viewer',
      requestId,
    } as const;

    const created = await jsonRequest(fixture.app, path, 'POST', input);
    const replayed = await jsonRequest(fixture.app, path, 'POST', input);
    const changed = await jsonRequest(fixture.app, path, 'POST', {
      ...input,
      proposedAccessLevel: 'editor',
    });

    expect(created.status).toBe(201);
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toEqual(await created.json());
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
    ).toEqual({ count: 1 });
    expect(
      fixture.coreDb.sqlite
        .prepare(
          `SELECT action, actor_json AS actorJson, subject_json AS subjectJson,
                  resource_revision AS resourceRevision, workspace_id AS workspaceId
           FROM audit_events`
        )
        .get()
    ).toEqual({
      action: 'workspace.invitation.create',
      actorJson: JSON.stringify({ kind: 'user', id: 'user_owner' }),
      resourceRevision: 1,
      subjectJson: JSON.stringify({ kind: 'user', id: 'user_invitee' }),
      workspaceId: fixture.workspaceId,
    });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 1 });
  });

  it('writes only a receipt for an exact no-op and returns typed revision conflicts', async () => {
    const fixture = createFixture();
    const path = `/api/app/workspaces/${fixture.workspaceId}/members/user_editor`;
    const noOp = await jsonRequest(fixture.app, path, 'PATCH', {
      accessLevel: 'editor',
      expectedRevision: 1,
      requestId: '00000000-0000-4000-8000-000000000002',
    });
    const conflict = await jsonRequest(fixture.app, path, 'PATCH', {
      accessLevel: 'viewer',
      expectedRevision: 9,
      requestId: '00000000-0000-4000-8000-000000000003',
    });

    expect(noOp.status).toBe(200);
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
    ).toEqual({ count: 0 });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 1 });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'revision_conflict',
      details: { current: { revision: 1, userId: 'user_editor' }, resource: 'membership' },
    });
  });

  it('fails closed on child-lineage mismatch and request-owned audit without a receipt', async () => {
    const fixture = createFixture();
    const invitation = fixture.coreDb.sqlite.transaction(() => {
      const now = '2026-07-19T00:00:00.000Z';
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_invitations (
            invitation_id, workspace_id, invitee_user_id, proposed_access_level, inviter_user_id,
            status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
          ) VALUES ('inv_foreign', ?, 'user_invitee', 'viewer', 'user_owner', 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
        )
        .run(fixture.foreignWorkspaceId, '2026-07-26T00:00:00.000Z', now, now);
      return 'inv_foreign';
    })();
    const mismatch = await jsonRequest(
      fixture.app,
      `/api/app/workspaces/${fixture.workspaceId}/invitations/${invitation}/revoke`,
      'POST',
      {
        expectedRevision: 1,
        requestId: '00000000-0000-4000-8000-000000000004',
      }
    );

    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      userId: 'user_admin',
    };
    recordServerAuditEvent({
      action: 'user.disable',
      actor: { id: 'user_admin', kind: 'user' },
      coreDb: fixture.coreDb,
      outcome: 'succeeded',
      requestId: '00000000-0000-4000-8000-000000000005',
      resource: 'user:user_disable',
      subject: { id: 'user_disable', kind: 'user' },
      summary: 'Canonical user disabled.',
    });
    const uncertain = await jsonRequest(
      fixture.app,
      '/api/app/users/user_disable/disable',
      'POST',
      {
        requestId: '00000000-0000-4000-8000-000000000005',
      }
    );

    expect(mismatch.status).toBe(403);
    await expect(mismatch.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    expect(uncertain.status).toBe(409);
    await expect(uncertain.json()).resolves.toMatchObject({ code: 'recovery_required' });
  });

  it('allows leave only from current policy authority or the exact own tombstone receipt', async () => {
    const fixture = createFixture();
    fixture.actorState.current = { kind: 'session', userId: 'user_editor' };
    const path = `/api/app/workspaces/${fixture.workspaceId}/leave`;
    const input = {
      expectedRevision: 1,
      requestId: '00000000-0000-4000-8000-000000000006',
    };

    const left = await jsonRequest(fixture.app, path, 'POST', input);
    const replayed = await jsonRequest(fixture.app, path, 'POST', input);
    const unrelated = await jsonRequest(fixture.app, path, 'POST', {
      ...input,
      requestId: '00000000-0000-4000-8000-000000000007',
    });

    expect(left.status).toBe(200);
    await expect(left.json()).resolves.toMatchObject({ member: { status: 'removed' } });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({ member: { status: 'removed' } });
    expect(unrelated.status).toBe(403);
    await expect(unrelated.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('keeps deployment recovery and user disable behind explicit administrator authority', async () => {
    const fixture = createFixture();
    const recoveryPath = `/api/app/workspaces/${fixture.workspaceId}/access-recovery`;
    const denied = await fixture.app.request(recoveryPath);

    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      userId: 'user_admin',
    };
    const read = await fixture.app.request(recoveryPath);
    const recovered = await jsonRequest(fixture.app, recoveryPath, 'POST', {
      action: 'add-self-as-editor',
      expectedRegistryRevision: 1,
      requestId: '00000000-0000-4000-8000-000000000008',
    });
    const disabled = await jsonRequest(fixture.app, '/api/app/users/user_disable/disable', 'POST', {
      requestId: '00000000-0000-4000-8000-000000000009',
    });
    const disabledNoOp = await jsonRequest(
      fixture.app,
      '/api/app/users/user_disable/disable',
      'POST',
      { requestId: '00000000-0000-4000-8000-000000000010' }
    );

    expect(denied.status).toBe(403);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      recovery: {
        administratorRole: null,
        ownerUserId: 'user_owner',
        registryRevision: 1,
        workspaceId: fixture.workspaceId,
      },
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      recovery: { administratorRole: 'editor', registryRevision: 2 },
    });
    expect(disabled.status).toBe(200);
    expect(disabledNoOp.status).toBe(200);
    expect(
      fixture.coreDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'user.disable'")
        .get()
    ).toEqual({ count: 1 });
  });

  it('rejects administrator recovery for the owner-only Quick Chat Workspace', async () => {
    const fixture = createFixture();
    const workspaceId = quickChatWorkspaceIdForUser('user_owner');
    recordWorkspaceOwnerMembership({
      coreDb: fixture.coreDb,
      ownerUserId: 'user_owner',
      workspaceId,
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      userId: 'user_admin',
    };

    const response = await jsonRequest(
      fixture.app,
      `/api/app/workspaces/${workspaceId}/access-recovery`,
      'POST',
      {
        action: 'add-self-as-editor',
        expectedRegistryRevision: 1,
        requestId: '00000000-0000-4000-8000-000000000011',
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'quick_chat_not_shareable' });
    expect(
      fixture.coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
        )
        .get(workspaceId, 'user_admin')
    ).toEqual({ count: 0 });
  });
});
