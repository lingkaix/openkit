import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS, WorkspaceSharingErrorSchema } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import * as policyKernel from '@openkit/policy-kernel';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordServerAuditEvent } from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { PUBLIC_OPERATION_ACCESS } from './auth/operation-access.js';
import { FsStore, quickChatWorkspaceIdForUser } from './lib/store.js';
import { getRegisteredAppApiOperationIds } from './openapi.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { closeWorkspaceProductReadHandles } from './storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { testEntityId } from './test-support/entity-ids.js';
import { operationRequest } from './test-support/operation-request.js';
import { workspaceMembershipDecisionFixture } from './test-support/resource-policy.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import {
  getWorkspaceInvitation,
  getWorkspaceMember,
  removeWorkspaceMember,
} from './workspace-sharing.js';
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

/** Sends one typed sharing mutation through its public JSON route. */
function requestSharingMutation(
  fixture: RouteFixture,
  operation: Parameters<typeof operationRequest>[0],
  selectors: Record<string, unknown>,
  body: Record<string, unknown>,
  method: 'PATCH' | 'POST' = 'POST'
): Promise<Response> {
  return fixture.app.request(
    ...operationRequest(operation, selectors, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
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
function insertMember(coreDb: CoreDb, workspaceId: string, userId: string): void {
  const now = '2026-07-19T00:00:00.000Z';
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(workspaceId, userId, now, now, now);
}

/** Creates one direct route fixture without duplicating central-authorizer tests. */
async function createFixture(): Promise<RouteFixture> {
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

  const store = new FsStore({ dataRoot });
  const workspaceId = (await store.createWorkspace('Shared Workspace')).id;
  const foreignWorkspaceId = (await store.createWorkspace('Foreign Workspace')).id;
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
  insertMember(coreDb, workspaceId, 'usr_00000000-0000-7609-aed5-db4b5c95e76c');
  insertMember(coreDb, workspaceId, 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8');

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
        isOwner: true,
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

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const coreDb of openDatabases.splice(0)) {
    closeWorkspaceProductReadHandles(coreDb.dataRoot);
    coreDb.sqlite.close();
    rmSync(coreDb.dataRoot, { recursive: true, force: true });
  }
});

describe('Workspace sharing routes', () => {
  it.each(['workspace.my-invitation-accept', 'workspace.my-invitation-decline'] as const)(
    'centrally retries %s after capture without changing its decision identity',
    async (operation) => {
      const fixture = await createFixture();
      const inviteeId = 'usr_00000000-0000-7a9e-8345-2bce44a3dce0';
      const invitee = fixture.coreDb.sqlite
        .prepare('SELECT email FROM users WHERE id = ?')
        .get(inviteeId) as { email: string };
      const created = await requestSharingMutation(
        fixture,
        'workspace.invitation-create',
        { workspaceId: fixture.workspaceId },
        { inviteeEmail: invitee.email, requestId: randomUUID() }
      );
      expect(created.status).toBe(201);
      const { invitation } = (await created.json()) as {
        invitation: { invitationId: string; revision: number };
      };
      fixture.actorState.current = {
        kind: 'session',
        userId: inviteeId,
        sessionId: 'auth_00000000-0000-7000-8000-000000000124',
      };
      const freeze = fixture.workspaceMutationAdmission.tryFreeze(fixture.workspaceId, () => []);
      expect(freeze.status).toBe('frozen');
      const bodies: unknown[] = [];
      const client = createCoreClient({
        baseUrl: 'http://core.test',
        fetch: async (url, init) => {
          if (String(url).endsWith('/api/meta'))
            return Response.json({
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
              eventFamilies: [],
            });
          bodies.push(init?.body);
          const response = await fixture.app.fetch(new Request(String(url), init));
          if (bodies.length === 1) {
            expect(response.status).toBe(409);
            expect(response.headers.get('Retry-After')).toBe('1');
            expect(getWorkspaceInvitation(fixture.coreDb, invitation.invitationId)?.revision).toBe(
              invitation.revision
            );
            if (freeze.status === 'frozen') freeze.release();
          }
          return response;
        },
      });
      try {
        const result = await client.operations[operation]({
          invitationId: invitation.invitationId,
          expectedRevision: invitation.revision,
          requestId: randomUUID(),
        });
        expect(result.invitation.effectiveStatus).toBe(
          operation === 'workspace.my-invitation-accept' ? 'accepted' : 'declined'
        );
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toBe(bodies[0]);
      } finally {
        if (freeze.status === 'frozen') freeze.release();
      }
    }
  );

  it.each([
    'removed',
    'disabled',
    'policy-denied',
    'authorized-invitee',
    'authorized-administrator',
  ] as const)('rechecks the inviter on acceptance with %s authority', async (scenario) => {
    const fixture = await createFixture();
    const inviterId = 'usr_00000000-0000-7609-aed5-db4b5c95e76c';
    const inviteeId = 'usr_00000000-0000-7a9e-8345-2bce44a3dce0';
    const ownerId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f';
    const administratorId = 'usr_00000000-0000-768a-8658-44c33d82c1f5';
    const invitee = fixture.coreDb.sqlite
      .prepare('SELECT email FROM users WHERE id = ?')
      .get(inviteeId) as { email: string };
    const request = (
      operation: Parameters<typeof operationRequest>[0],
      selectors: Record<string, unknown>,
      body: Record<string, unknown> = {}
    ) =>
      fixture.app.request(
        ...operationRequest(operation, selectors, {
          body: JSON.stringify(body),
          headers: { 'x-openkit-request-id': randomUUID() },
        })
      );
    fixture.actorState.current = { kind: 'session', userId: inviterId };
    const created = await request('workspace.invitation-create', {
      workspaceId: fixture.workspaceId,
      inviteeEmail: invitee.email,
    });
    expect(created.status).toBe(201);
    const invitation = (await created.json()).invitation as {
      invitationId: string;
      revision: number;
    };
    expect(getWorkspaceMember(fixture.coreDb, fixture.workspaceId, inviteeId)).toBeNull();
    fixture.actorState.current = { kind: 'session', userId: ownerId };
    if (scenario === 'removed') {
      const removed = await request(
        'workspace.member-remove',
        {
          targetUserId: inviterId,
          workspaceId: fixture.workspaceId,
        },
        { expectedRevision: 1 }
      );
      expect(removed.status).toBe(200);
    }
    let administrator: Actor | undefined;
    if (scenario === 'disabled' || scenario === 'authorized-administrator') {
      const issued = createOpenKitAccessTokenRecord(fixture.coreDb, {
        expiresAt: '2099-01-01T00:00:00.000Z',
        ownerUserId: administratorId,
        scope: 'server-admin',
        workspaceIds: [],
      });
      administrator = {
        kind: 'token',
        tokenId: issued.tokenId,
        tokenScope: 'server-admin',
        userId: administratorId,
      };
      if (scenario === 'disabled') {
        fixture.actorState.current = administrator;
        const disabled = await request('user.disable', { targetUserId: inviterId });
        expect(disabled.status).toBe(200);
      }
    }
    let restorePolicy = () => {};
    if (scenario === 'policy-denied') {
      const actualEvaluate = policyKernel.evaluateAccess;
      const fault = vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, input) => {
        if (input.operation !== 'membership.manage' || input.user !== `user:${inviterId}`)
          return actualEvaluate(policy, input);
        // Remove the inviter's current grants, while retaining the real evaluator
        // and the invitee's independent invitation.respond authorization.
        const rights = new Set(
          policy.operations.find((entry) => entry.id === input.operation)!.accessRights
        );
        return actualEvaluate(
          {
            ...policy,
            associations: policy.associations.map((association) => ({
              ...association,
              accessRights: association.accessRights.filter((right) => !rights.has(right)),
            })),
          },
          input
        );
      });
      restorePolicy = () => fault.mockRestore();
    }
    try {
      fixture.actorState.current =
        scenario === 'authorized-administrator'
          ? administrator!
          : { kind: 'session', userId: inviteeId };
      const accepted = await request(
        'workspace.my-invitation-accept',
        {
          invitationId: invitation.invitationId,
        },
        { expectedRevision: invitation.revision }
      );
      const authorized = scenario.startsWith('authorized-');
      const persisted = getWorkspaceInvitation(fixture.coreDb, invitation.invitationId)!;
      const member = getWorkspaceMember(fixture.coreDb, fixture.workspaceId, inviteeId);
      const audits = fixture.coreDb.sqlite
        .prepare(
          "SELECT actor_json AS actorJson FROM audit_events WHERE action = 'workspace.invitation.accept'"
        )
        .all();
      // The Multi-User Workspace owner requires current inviter authority before
      // this conditional membership effect; a pending invitation is not authority.
      expect.soft(accepted.status).toBe(authorized ? 200 : 403);
      expect.soft(persisted.effectiveStatus).toBe(authorized ? 'accepted' : 'pending');
      if (authorized) {
        expect(member).toMatchObject({ userId: inviteeId, status: 'active' });
        expect(audits).toEqual([
          {
            actorJson: JSON.stringify({
              kind: 'user',
              id: scenario === 'authorized-administrator' ? administratorId : inviteeId,
            }),
          },
        ]);
      } else {
        expect.soft(member).toBeNull();
        expect.soft(audits).toEqual([]);
        await expect(accepted.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      }
    } finally {
      restorePolicy();
    }
  });

  it('registers the exact closed operation surface and access owners', async () => {
    const fixture = await createFixture();

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
    const fixture = await createFixture();
    const body = readAuthorizedWorkspaces(
      fixture.coreDb,
      fixture.store,
      fixture.actorState.current,
      [fixture.workspaceId]
    );

    expect(body).toMatchObject({
      items: [{ isOwner: true, workspace: { id: fixture.workspaceId } }],
    });
  });

  it('projects actual ownership without membership for a usable server-admin bearer', async () => {
    const fixture = await createFixture();
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
      scope: 'server-admin',
      tokenId: testEntityId('tok', 'token_admin_list'),
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: testEntityId('tok', 'token_admin_list'),
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
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        membershipStatus: null,
        accessCause: 'administrator',
        isOwner: false,
        membershipRevision: null,
        workspace: expect.objectContaining({ id: fixture.workspaceId }),
      }),
    ]);
  });

  it('hides own invitations for fenced and deleting Workspaces', async () => {
    const fixture = await createFixture();
    const now = '2026-07-19T00:00:00.000Z';
    for (const [invitationId, workspaceId] of [
      ['inv_00000000-0000-7fa0-886a-4a5b14d6d0c8', fixture.workspaceId],
      ['inv_00000000-0000-718f-bfd8-7eb610e403a9', fixture.foreignWorkspaceId],
    ] as const) {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_invitations (
            invitation_id, workspace_id, invitee_user_id, inviter_user_id,
            status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
          ) VALUES (?, ?, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
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
    const fixture = await createFixture();
    const requestId = '00000000-0000-4000-8000-000000000001';
    const input = {
      inviteeEmail: 'invitee@example.com',

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
            inviteeEmail: 'different@example.com',
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
    const fixture = await createFixture();
    const noOp = await fixture.app.request(
      ...operationRequest(
        'workspace.ownership-transfer',
        {
          workspaceId: fixture.workspaceId,
          targetUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        },
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRegistryRevision: 1,
            requestId: '00000000-0000-4000-8000-000000000002',
          }),
        }
      )
    );
    const conflict = await fixture.app.request(
      ...operationRequest(
        'workspace.ownership-transfer',
        {
          workspaceId: fixture.workspaceId,
          targetUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        },
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRegistryRevision: 9,
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
        current: { registryRevision: 1, ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f' },
        resource: 'workspace',
      },
    });
  });

  it('fails closed on child-lineage mismatch and request-owned audit without a receipt', async () => {
    const fixture = await createFixture();
    const invitation = fixture.coreDb.sqlite.transaction(() => {
      const now = '2026-07-19T00:00:00.000Z';
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO workspace_invitations (
            invitation_id, workspace_id, invitee_user_id, inviter_user_id,
            status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
          ) VALUES ('inv_00000000-0000-7d26-983c-83c7b6f9b27f', ?, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'pending', ?, NULL, NULL, NULL, 1, ?, ?)`
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
    const fixture = await createFixture();
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
    const fixture = await createFixture();
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
            action: 'add-self-as-member',
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
        administratorMembershipStatus: null,
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        registryRevision: 1,
        workspaceId: fixture.workspaceId,
      },
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      recovery: { administratorMembershipStatus: 'active', registryRevision: 2 },
    });
    expect(disabled.status).toBe(200);
    expect(disabledNoOp.status).toBe(200);
    expect(
      fixture.coreDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'user.disable'")
        .get()
    ).toEqual({ count: 1 });
  });

  it('rejects administrator recovery for the owner-only personal Workspace', async () => {
    const fixture = await createFixture();
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
            action: 'add-self-as-member',
            expectedRegistryRevision: 1,
            requestId: '00000000-0000-4000-8000-000000000011',
          }),
        }
      )
    );

    expect(response.status).toBe(409);
    const failure = await response.json();
    expect.soft(failure).toMatchObject({ code: 'quick_chat_not_shareable' });
    expect.soft(WorkspaceSharingErrorSchema.safeParse(failure).success).toBe(true);
    expect(
      fixture.coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
        )
        .get(workspaceId, 'usr_00000000-0000-768a-8658-44c33d82c1f5')
    ).toEqual({ count: 0 });
  });

  it('native sharing owner commits invitation create and accept while Main Core is read-only', async () => {
    const fixture = await createFixture();
    const ownerId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f';
    const inviteeId = 'usr_00000000-0000-7a9e-8345-2bce44a3dce0';
    const createInput = {
      inviteeEmail: 'invitee@example.com',
      requestId: '00000000-0000-4000-8000-000000120001',
    } as const;
    fixture.coreDb.sqlite.pragma('query_only = ON');

    const created = await requestSharingMutation(
      fixture,
      'workspace.invitation-create',
      { workspaceId: fixture.workspaceId },
      createInput
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      invitation: { invitationId: string; revision: number };
    };
    const acceptInput = {
      expectedRevision: createdBody.invitation.revision,
      requestId: '00000000-0000-4000-8000-000000120002',
    } as const;
    fixture.actorState.current = { kind: 'session', userId: inviteeId };
    const accepted = await requestSharingMutation(
      fixture,
      'workspace.my-invitation-accept',
      { invitationId: createdBody.invitation.invitationId },
      acceptInput
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({ invitation: { effectiveStatus: 'accepted' } });

    fixture.actorState.current = { kind: 'session', userId: ownerId };
    const createReplay = await requestSharingMutation(
      fixture,
      'workspace.invitation-create',
      { workspaceId: fixture.workspaceId },
      createInput
    );
    fixture.actorState.current = { kind: 'session', userId: inviteeId };
    const acceptReplay = await requestSharingMutation(
      fixture,
      'workspace.my-invitation-accept',
      { invitationId: createdBody.invitation.invitationId },
      acceptInput
    );
    expect(createReplay.status).toBe(201);
    // Invitation receipts retain the exact pointer. A replay projects the
    // current invitation after its separately committed acceptance.
    expect(await createReplay.json()).toEqual(acceptedBody);
    expect(acceptReplay.status).toBe(200);
    expect(await acceptReplay.json()).toEqual(acceptedBody);
    expect(getWorkspaceMember(fixture.coreDb, fixture.workspaceId, inviteeId)).toMatchObject({
      status: 'active',
    });
    expect(
      fixture.coreDb.sqlite
        .prepare(
          "SELECT action FROM audit_events WHERE action IN ('workspace.invitation.create', 'workspace.invitation.accept') ORDER BY action"
        )
        .all()
    ).toEqual([
      { action: 'workspace.invitation.accept' },
      { action: 'workspace.invitation.create' },
    ]);
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 2 });
  });

  it('native sharing owner rechecks current membership after opening the writer', async () => {
    const fixture = await createFixture();
    const editorId = 'usr_00000000-0000-7609-aed5-db4b5c95e76c';
    const ownerId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f';
    fixture.actorState.current = { kind: 'session', userId: editorId };
    const client = getControlStoreWorkerClient();
    const open = client.open.bind(client);
    let opened = false;
    vi.spyOn(client, 'open').mockImplementationOnce(async (input) => {
      await open(input);
      opened = true;
      fixture.coreDb.sqlite.transaction(() => {
        const removed = removeWorkspaceMember({
          actorUserId: ownerId,
          authorization: workspaceMembershipDecisionFixture(
            fixture.coreDb,
            ownerId,
            fixture.workspaceId
          ),
          coreDb: fixture.coreDb,
          expectedRevision: 1,
          memberUserId: editorId,
          workspaceId: fixture.workspaceId,
        });
        expect(removed.kind).toBe('removed');
      })();
    });

    const response = await requestSharingMutation(
      fixture,
      'workspace.leave',
      { workspaceId: fixture.workspaceId },
      {
        expectedRevision: 1,
        requestId: '00000000-0000-4000-8000-000000120003',
      }
    );

    expect(opened).toBe(true);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    expect(
      fixture.coreDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'workspace.leave'")
        .get()
    ).toEqual({ count: 0 });
    expect(
      fixture.coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM idempotency_requests WHERE command_name = 'workspace.leave'"
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('native sharing owner rolls ownership and its receipt back together', async () => {
    const fixture = await createFixture();
    const ownerId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f';
    const editorId = 'usr_00000000-0000-7609-aed5-db4b5c95e76c';
    const input = {
      expectedRegistryRevision: 1,
      requestId: '00000000-0000-4000-8000-000000120004',
    } as const;
    fixture.coreDb.sqlite.exec(`
      CREATE TRIGGER refuse_sharing_receipt
      BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name = 'workspace.ownership.transfer'
      BEGIN SELECT RAISE(ABORT, 'private sharing receipt fault'); END
    `);
    const request = () =>
      requestSharingMutation(
        fixture,
        'workspace.ownership-transfer',
        { targetUserId: editorId, workspaceId: fixture.workspaceId },
        input,
        'PATCH'
      );

    const refused = await request();
    expect(refused.status).toBe(500);
    expect(
      fixture.coreDb.sqlite
        .prepare(
          'SELECT owner_user_id AS ownerUserId, revision FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(fixture.workspaceId)
    ).toEqual({ ownerUserId: ownerId, revision: 1 });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
    ).toEqual({ count: 0 });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 0 });

    fixture.coreDb.sqlite.exec('DROP TRIGGER refuse_sharing_receipt');
    const retried = await request();
    const retriedBody = await retried.json();
    const replayed = await request();
    expect(retried.status).toBe(200);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual(retriedBody);
    expect(
      fixture.coreDb.sqlite
        .prepare(
          'SELECT owner_user_id AS ownerUserId, revision FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(fixture.workspaceId)
    ).toEqual({ ownerUserId: editorId, revision: 2 });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
    ).toEqual({ count: 1 });
    expect(
      fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()
    ).toEqual({ count: 1 });
  });

  it('native sharing owner rechecks deployment-admin recovery after opening the writer', async () => {
    const fixture = await createFixture();
    const adminId = 'usr_00000000-0000-768a-8658-44c33d82c1f5';
    const tokenId = 'token_native_recovery';
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: adminId,
      scope: 'server-admin',
      tokenId,
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId,
      tokenScope: 'server-admin',
      userId: adminId,
    };
    const client = getControlStoreWorkerClient();
    const open = client.open.bind(client);
    let opened = false;
    vi.spyOn(client, 'open').mockImplementationOnce(async (input) => {
      await open(input);
      opened = true;
      expect(revokeOpenKitAccessTokenRecord(fixture.coreDb, tokenId)).toMatchObject({
        status: 'revoked',
      });
    });

    const response = await requestSharingMutation(
      fixture,
      'workspace.access-recover',
      { workspaceId: fixture.workspaceId },
      {
        action: 'add-self-as-member',
        expectedRegistryRevision: 1,
        requestId: '00000000-0000-4000-8000-000000120005',
      }
    );

    expect(opened).toBe(true);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'deployment_admin_required' });
    expect(getWorkspaceMember(fixture.coreDb, fixture.workspaceId, adminId)).toBeNull();
    expect(
      fixture.coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action LIKE 'workspace.access.recover.%'"
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      fixture.coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM idempotency_requests WHERE command_name = 'workspace.access.recover'"
        )
        .get()
    ).toEqual({ count: 0 });
  });
});

it('keeps safe sharing request field detail in the common validation projection', async () => {
  const fixture = await createFixture();
  const response = await fixture.app.request(
    ...operationRequest(
      'workspace.invitation-create',
      { workspaceId: fixture.workspaceId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inviteeEmail: 42,

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
