import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { recordServerAuditEvent } from './audit-events.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { PUBLIC_OPERATION_ACCESS } from './auth/operation-access.js';
import { FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import { getRegisteredAppApiOperationIds } from './openapi.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import type { CoreDb } from './storage/db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { readAuthorizedWorkspaces } from './workspace-sharing-operations.js';

const openDatabases: CoreDb[] = [];
const SHARING_OPERATION_IDS = [
  'workspace.member-list',
  'workspace.invitation-list',
  'workspace.invitation-create',
  'workspace.my-invitation-list',
  'workspace.my-invitation-accept',
  'workspace.my-invitation-decline',
  'workspace.invitation-revoke',
  'workspace.member-access-change',
  'workspace.member-remove',
  'workspace.leave',
  'workspace.ownership-transfer',
  'workspace.access-recovery-read',
  'workspace.access-recover',
  'user.disable',
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
    ['usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com'],
    ['usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'invitee@example.com'],
    ['usr_00000000-0000-7609-aed5-db4b5c95e76c', 'editor@example.com'],
    ['usr_00000000-0000-7b43-8df8-fd24a5ccdbe8', 'viewer@example.com'],
    ['usr_00000000-0000-768a-8658-44c33d82c1f5', 'admin@example.com'],
    ['usr_00000000-0000-7ab7-8a59-636a897b0c66', 'disable@example.com'],
  ] as const) {
    insertUser(coreDb, userId, email);
  }

  const store = new FsStore();
  const workspaceId = store.createWorkspace('Shared Workspace').id;
  const foreignWorkspaceId = store.createWorkspace('Foreign Workspace').id;
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    workspaceId,
  });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    workspaceId: foreignWorkspaceId,
  });
  insertMember(coreDb, workspaceId, 'usr_00000000-0000-7609-aed5-db4b5c95e76c', 'editor');
  insertMember(coreDb, workspaceId, 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8', 'viewer');

  const actorState: ActorState = {
    current: { kind: 'session', userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f' },
  };
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
  registerOperationJsonRoutes({
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

afterEach(() => {
  for (const coreDb of openDatabases.splice(0)) {
    coreDb.sqlite.close();
  }
});

describe('Workspace sharing routes', () => {
  it('registers the exact closed operation surface and access owners', () => {
    const fixture = createFixture();

    expect(getRegisteredAppApiOperationIds(fixture.app)).toEqual(
      Object.entries(OPERATION_DEFINITIONS)
        .filter(([, definition]) => definition.binding === 'json')
        .map(([id]) => id)
    );
    expect(SHARING_OPERATION_IDS.every((id) => Object.hasOwn(OPERATION_DEFINITIONS, id))).toBe(
      true
    );
    expect(PUBLIC_OPERATION_ACCESS).toMatchObject({
      'workspace.list': {
        policyOperation: 'workspace.read',
        resolver: 'authorized-workspace-set',
        scope: 'workspace',
      },
      'workspace.my-invitation-list': {
        authentication: 'canonical-user',
        policyOperation: 'invitation.respond',
        scope: 'user',
      },
      'workspace.leave': {
        authentication: 'canonical-user',
        policyOperation: 'workspace.leave',
        scope: 'user',
      },
      'workspace.access-recover': {
        authentication: 'deployment-admin',
        policyOperation: 'deployment.recover',
        scope: 'server',
      },
      'workspace.ownership-transfer': {
        policyOperation: 'workspace.lifecycle',
        resolver: 'body-workspace',
        scope: 'workspace',
      },
    });
  });

  it('projects only the centrally authorized Workspace set', async () => {
    const fixture = createFixture();
    const body = readAuthorizedWorkspaces(
      fixture.coreDb,
      fixture.store,
      fixture.actorState.current,
      [fixture.workspaceId]
    );

    expect(body).toMatchObject({
      items: [{ effectiveRole: 'owner', workspace: { id: fixture.workspaceId } }],
    });
  });

  it('projects actual ownership without membership for a usable server-admin bearer', async () => {
    const fixture = createFixture();
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
      scope: 'server-admin',
      tokenId: 'token_admin_list',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_list',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
    };
    const body = readAuthorizedWorkspaces(
      fixture.coreDb,
      fixture.store,
      fixture.actorState.current,
      [fixture.workspaceId]
    );

    expect(body.items).toEqual([
      expect.objectContaining({
        ownerUserId: 'user_owner',
        membershipStatus: null,
        accessCause: 'administrator',
        effectiveRole: null,
        membershipRevision: null,
        workspace: expect.objectContaining({ id: fixture.workspaceId }),
      }),
    ]);
  });

  it('hides own invitations for fenced and deleting Workspaces', async () => {
    const fixture = createFixture();
    const now = '2026-07-19T00:00:00.000Z';
    for (const [invitationId, workspaceId] of [
      ['inv_00000000-0000-7fa0-886a-4a5b14d6d0c8', fixture.workspaceId],
      ['inv_00000000-0000-718f-bfd8-7eb610e403a9', fixture.foreignWorkspaceId],
    ] as const) {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_invitations (
            invitation_id, workspace_id, invitee_user_id, proposed_access_level, inviter_user_id,
            status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
          ) VALUES (?, ?, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'viewer', 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
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
    fixture.actorState.current = {
      kind: 'session',
      userId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
    };

    const response = await fixture.app.request(
      ...operationRequest('workspace.my-invitation-list', {}, {})
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [] });
  });

  it('commits one lifecycle audit and pointer receipt, replays, and rejects changed input', async () => {
    const fixture = createFixture();
    const requestId = '00000000-0000-4000-8000-000000000001';
    const input = {
      inviteeEmail: 'invitee@example.com',
      proposedAccessLevel: 'viewer',
      requestId,
    } as const;

    const created = await fixture.app.request(
      ...operationRequest(
        'workspace.invitation-create',
        { workspaceId: fixture.workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
    );
    const replayed = await fixture.app.request(
      ...operationRequest(
        'workspace.invitation-create',
        { workspaceId: fixture.workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
    );
    const changed = await fixture.app.request(
      ...operationRequest(
        'workspace.invitation-create',
        { workspaceId: fixture.workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...input,
            proposedAccessLevel: 'editor',
          }),
        }
      )
    );

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
      actorJson: JSON.stringify({ kind: 'user', id: 'usr_00000000-0000-7011-88df-c2b1e8466b6f' }),
      resourceRevision: 1,
      subjectJson: JSON.stringify({ kind: 'user', id: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0' }),
      workspaceId: fixture.workspaceId,
    });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 1 });
  });

  it('writes only a receipt for an exact no-op and returns typed revision conflicts', async () => {
    const fixture = createFixture();
    const noOp = await fixture.app.request(
      ...operationRequest(
        'workspace.member-access-change',
        {
          workspaceId: fixture.workspaceId,
          targetUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
        },
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            accessLevel: 'editor',
            expectedRevision: 1,
            requestId: '00000000-0000-4000-8000-000000000002',
          }),
        }
      )
    );
    const conflict = await fixture.app.request(
      ...operationRequest(
        'workspace.member-access-change',
        {
          workspaceId: fixture.workspaceId,
          targetUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
        },
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            accessLevel: 'viewer',
            expectedRevision: 9,
            requestId: '00000000-0000-4000-8000-000000000003',
          }),
        }
      )
    );

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
      details: {
        current: { revision: 1, userId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c' },
        resource: 'membership',
      },
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
          ) VALUES ('inv_00000000-0000-7d26-983c-83c7b6f9b27f', ?, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'viewer', 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
        )
        .run(fixture.foreignWorkspaceId, '2026-07-26T00:00:00.000Z', now, now);
      return 'inv_00000000-0000-7d26-983c-83c7b6f9b27f';
    })();
    const mismatch = await fixture.app.request(
      ...operationRequest(
        'workspace.invitation-revoke',
        { workspaceId: fixture.workspaceId, invitationId: invitation },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 1,
            requestId: '00000000-0000-4000-8000-000000000004',
          }),
        }
      )
    );

    createOpenKitAccessTokenRecord(fixture.coreDb, {
      tokenId: 'token_admin',
      scope: 'server-admin',
      ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      userId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
    };
    recordServerAuditEvent({
      action: 'user.disable',
      actor: { id: 'usr_00000000-0000-768a-8658-44c33d82c1f5', kind: 'user' },
      coreDb: fixture.coreDb,
      outcome: 'succeeded',
      requestId: '00000000-0000-4000-8000-000000000005',
      resource: 'user:usr_00000000-0000-7ab7-8a59-636a897b0c66',
      subject: { id: 'usr_00000000-0000-7ab7-8a59-636a897b0c66', kind: 'user' },
      summary: 'Canonical user disabled.',
    });
    const uncertain = await fixture.app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: 'usr_00000000-0000-7ab7-8a59-636a897b0c66' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000005',
          }),
        }
      )
    );

    expect(mismatch.status).toBe(403);
    await expect(mismatch.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    expect(uncertain.status).toBe(409);
    await expect(uncertain.json()).resolves.toMatchObject({ code: 'recovery_required' });
  });

  it('allows leave only from current policy authority or the exact own tombstone receipt', async () => {
    const fixture = createFixture();
    fixture.actorState.current = {
      kind: 'session',
      userId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
    };
    const input = {
      expectedRevision: 1,
      requestId: '00000000-0000-4000-8000-000000000006',
    };

    const left = await fixture.app.request(
      ...operationRequest(
        'workspace.leave',
        { workspaceId: fixture.workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
    );
    const replayed = await fixture.app.request(
      ...operationRequest(
        'workspace.leave',
        { workspaceId: fixture.workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
    );
    const unrelated = await fixture.app.request(
      ...operationRequest(
        'workspace.leave',
        { workspaceId: fixture.workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...input,
            requestId: '00000000-0000-4000-8000-000000000007',
          }),
        }
      )
    );

    expect(left.status).toBe(200);
    await expect(left.json()).resolves.toMatchObject({ member: { status: 'removed' } });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({ member: { status: 'removed' } });
    expect(unrelated.status).toBe(403);
    await expect(unrelated.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('keeps deployment recovery and user disable behind explicit administrator authority', async () => {
    const fixture = createFixture();
    const denied = await fixture.app.request(
      ...operationRequest(
        'workspace.access-recovery-read',
        { workspaceId: fixture.workspaceId },
        {}
      )
    );

    createOpenKitAccessTokenRecord(fixture.coreDb, {
      tokenId: 'token_admin',
      scope: 'server-admin',
      ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      userId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
    };
    const read = await fixture.app.request(
      ...operationRequest(
        'workspace.access-recovery-read',
        { workspaceId: fixture.workspaceId },
        {}
      )
    );
    const recovered = await fixture.app.request(
      ...operationRequest(
        'workspace.access-recover',
        { workspaceId: fixture.workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'add-self-as-editor',
            expectedRegistryRevision: 1,
            requestId: '00000000-0000-4000-8000-000000000008',
          }),
        }
      )
    );
    const disabled = await fixture.app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: 'usr_00000000-0000-7ab7-8a59-636a897b0c66' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000009',
          }),
        }
      )
    );
    const disabledNoOp = await fixture.app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: 'usr_00000000-0000-7ab7-8a59-636a897b0c66' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000010' }),
        }
      )
    );

    expect(denied.status).toBe(403);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      recovery: {
        administratorRole: null,
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
    const workspaceId = quickChatWorkspaceIdForUser('usr_00000000-0000-7011-88df-c2b1e8466b6f');
    recordWorkspaceOwnerMembership({
      coreDb: fixture.coreDb,
      ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      workspaceId,
    });
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      tokenId: 'token_admin',
      scope: 'server-admin',
      ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      userId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
    };

    const response = await fixture.app.request(
      ...operationRequest(
        'workspace.access-recover',
        { workspaceId: workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'add-self-as-editor',
            expectedRegistryRevision: 1,
            requestId: '00000000-0000-4000-8000-000000000011',
          }),
        }
      )
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'quick_chat_not_shareable' });
    expect(
      fixture.coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
        )
        .get(workspaceId, 'usr_00000000-0000-768a-8658-44c33d82c1f5')
    ).toEqual({ count: 0 });
  });
});

it('keeps safe sharing request field detail in the common validation projection', async () => {
  const fixture = createFixture();
  const response = await fixture.app.request(
    ...operationRequest(
      'workspace.invitation-create',
      { workspaceId: fixture.workspaceId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inviteeEmail: 42,
          proposedAccessLevel: 'viewer',
          requestId: '00000000-0000-4000-8000-000000000001',
        }),
      }
    )
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: 'invalid_request',
    message: 'Invalid operation input.',
    details: { fields: ['inviteeEmail'] },
  });
});
