import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { listServerAuditEvents } from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import { ensureLocalUser } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { computeBootReadinessSnapshot } from './bootstrap/readiness.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { operationRequest } from './test-support/operation-request.js';
import { readWorkspaceDeletionRequest } from './workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000023';

it('sends unexpected lifecycle admission-read failures to the HTTP error handler without a mutation or receipt', async () => {
  const f = fixture();
  const app = new Hono<{ Variables: AuthVariables }>();
  const failure = new Error('injected authorization storage failure');
  const onError = vi.fn(() => Response.json({ code: 'framework_failure' }, { status: 500 }));
  app.onError(onError);
  app.use('*', async (c, next) => {
    c.set('actor', { kind: 'session', userId: 'user_local' });
    await next();
  });
  registerOperationJsonRoutes({
    app,
    coreDb: f.coreDb,
    store: f.store,
    requestStore: () => f.store,
    workspaceMutationAdmission: f.admission,
    inflightCommands: new WeakMap(),
  });
  const beforeInvitation = f.coreDb.sqlite.prepare('SELECT * FROM workspace_invitations').all();
  const beforeMembers = f.coreDb.sqlite.prepare('SELECT * FROM workspace_members').all();
  const beforeReceipts = f.coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
  const beforeAudit = listServerAuditEvents(f.coreDb);
  const read = vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementationOnce(() => {
    throw failure;
  });
  try {
    const response = await app.request(
      ...operationRequest(
        'workspace.my-invitation-accept',
        { invitationId: 'inv_fixture' },
        {
          body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1 }),
        }
      )
    );
    expect(read).toHaveBeenCalledWith(expect.stringMatching(/users/));
    read.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 'framework_failure' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure, expect.anything());
    expect(f.coreDb.sqlite.prepare('SELECT * FROM workspace_invitations').all()).toEqual(
      beforeInvitation
    );
    expect(f.coreDb.sqlite.prepare('SELECT * FROM workspace_members').all()).toEqual(beforeMembers);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(
      beforeReceipts
    );
    expect(listServerAuditEvents(f.coreDb)).toEqual(beforeAudit);
  } finally {
    read.mockRestore();
    f.close();
  }
});

it('allows the administrator recovery-state read through a closed mutation gate while refusing recovery without state change', async () => {
  const f = fixture(undefined, 'server');
  try {
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'target',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const headers = { authorization: `Bearer ${admin.secret}` };
    const openRead = await f.app.request(
      ...operationRequest(
        'workspace.access-recovery-read',
        { workspaceId: f.workspaceId },
        { headers }
      )
    );
    expect(openRead.status).toBe(200);
    const expected = await openRead.json();
    expect(expected).toEqual({
      recovery: {
        workspaceId: f.workspaceId,
        ownerUserId: 'user_local',
        administratorRole: null,
        registryRevision: 1,
      },
    });
    const beforeRegistry = f.coreDb.sqlite.prepare('SELECT * FROM workspace_registry').all();
    const beforeMembers = f.coreDb.sqlite.prepare('SELECT * FROM workspace_members').all();
    const beforeReceipts = f.coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
    const beforeAudit = listServerAuditEvents(f.coreDb);
    await f.admission.close(f.workspaceId);
    const closedRead = await f.app.request(
      ...operationRequest(
        'workspace.access-recovery-read',
        { workspaceId: f.workspaceId },
        { headers }
      )
    );
    expect(closedRead.status).toBe(200);
    expect(await closedRead.json()).toEqual(expected);
    const mutation = await f.app.request(
      ...operationRequest(
        'workspace.access-recover',
        { workspaceId: f.workspaceId },
        {
          headers,
          body: JSON.stringify({
            action: 'add-self-as-editor',
            expectedRegistryRevision: 1,
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(mutation.status).toBe(403);
    expect(await mutation.json()).toMatchObject({ code: 'workspace_access_denied' });
    expect(f.coreDb.sqlite.prepare('SELECT * FROM workspace_registry').all()).toEqual(
      beforeRegistry
    );
    expect(f.coreDb.sqlite.prepare('SELECT * FROM workspace_members').all()).toEqual(beforeMembers);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(
      beforeReceipts
    );
    expect(listServerAuditEvents(f.coreDb)).toEqual(beforeAudit);
  } finally {
    f.close();
  }
});

/** Creates real owner, member, invitation and Workspace records, without fixture-supplied admission defaults. */
function fixture(
  getBootReadiness?: () => BootReadinessSnapshot,
  mode: 'local' | 'server' = 'local'
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-lifecycle-cutover-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const now = Date.now();
  for (const id of ['member', 'target'])
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, ?, ?, 0, ?, ?, 'human', 'active')"
      )
      .run(id, id, `${id}@example.com`, now, now);
  const store = new FsStore({ dataRoot });
  const workspaceId = store.createWorkspace('Lifecycle cutover').id;
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId });
  const timestamp = new Date().toISOString();
  coreDb.sqlite
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, status, access_level, joined_at, revision, created_at, updated_at) VALUES (?, 'member', 'active', 'editor', ?, 1, ?, ?)"
    )
    .run(workspaceId, timestamp, timestamp, timestamp);
  coreDb.sqlite
    .prepare(
      "INSERT INTO workspace_invitations (invitation_id, workspace_id, invitee_user_id, proposed_access_level, inviter_user_id, status, expires_at, revision, created_at, updated_at) VALUES ('inv_fixture', ?, 'user_local', 'viewer', 'user_local', 'pending', ?, 1, ?, ?)"
    )
    .run(workspaceId, new Date(Date.now() + 86400000).toISOString(), timestamp, timestamp);
  const admission = new WorkspaceMutationAdmission();
  const app = createApp({
    workspaceMutationAdmission: admission,
    ...(getBootReadiness ? { getBootReadiness } : {}),
    coreDb,
    dataRoot,
    store,
    mode,
    turnExecutor: new SimulatedTurnExecutor(),
  });
  return {
    app,
    coreDb,
    dataRoot,
    store,
    admission,
    invoke: createOperationInvocation({
      repositoryWorkspaceDb: (id) => {
        const db = openWorkspaceDb(dataRoot, id);
        applyScopedMigrations(db);
        return db;
      },
      coreDb,
      dataRoot,
      store,
      workspaceMutationAdmission: admission,
      inflightCommands: new WeakMap(),
    }),
    workspaceId,
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

const cases = [
  ['workspace.member-list', 'GET', '/api/app/workspaces/$workspace/members', {}, 200],
  ['workspace.invitation-list', 'GET', '/api/app/workspaces/$workspace/invitations', {}, 200],
  [
    'workspace.invitation-create',
    'POST',
    '/api/app/workspaces/$workspace/invitations',
    { inviteeEmail: 'target@example.com', proposedAccessLevel: 'viewer' },
    201,
  ],
  ['workspace.my-invitation-list', 'GET', '/api/app/workspace-invitations', {}, 200],
  [
    'workspace.my-invitation-accept',
    'POST',
    '/api/app/workspace-invitations/inv_fixture/accept',
    { expectedRevision: 1 },
    200,
  ],
  [
    'workspace.my-invitation-decline',
    'POST',
    '/api/app/workspace-invitations/inv_fixture/decline',
    { expectedRevision: 1 },
    200,
  ],
  [
    'workspace.invitation-revoke',
    'POST',
    '/api/app/workspaces/$workspace/invitations/inv_fixture/revoke',
    { expectedRevision: 1 },
    200,
  ],
  [
    'workspace.member-access-change',
    'PATCH',
    '/api/app/workspaces/$workspace/members/member',
    { accessLevel: 'viewer', expectedRevision: 1 },
    200,
  ],
  [
    'workspace.member-remove',
    'POST',
    '/api/app/workspaces/$workspace/members/member/remove',
    { expectedRevision: 1 },
    200,
  ],
  ['workspace.leave', 'POST', '/api/app/workspaces/$workspace/leave', { expectedRevision: 1 }, 409],
  [
    'workspace.ownership-transfer',
    'POST',
    '/api/app/workspaces/$workspace/ownership/transfer',
    { targetUserId: 'member', expectedRegistryRevision: 1 },
    200,
  ],
  [
    'workspace.access-recovery-read',
    'GET',
    '/api/app/workspaces/$workspace/access-recovery',
    {},
    200,
  ],
  [
    'workspace.access-recover',
    'POST',
    '/api/app/workspaces/$workspace/access-recovery',
    { action: 'add-self-as-editor', expectedRegistryRevision: 1 },
    200,
  ],
  ['user.disable', 'POST', '/api/app/users/target/disable', {}, 200],
  [
    'workspace.delete',
    'POST',
    '/api/app/workspaces/$workspace/delete',
    { expectedRegistryRevision: 1 },
    200,
  ],
  [
    'workspace.deleted-recover',
    'POST',
    '/api/app/workspace-deletions/$workspace/recover',
    { deletionRequestId: REQUEST_ID },
    409,
  ],
] as const;

it.each(
  cases
)('retires the authorized former binding and preserves %s owned outcome', async (id, method, path, body, status) => {
  const state = fixture();
  try {
    if (id === 'workspace.deleted-recover')
      state.coreDb.sqlite
        .prepare("UPDATE workspace_registry SET status = 'deleted' WHERE workspace_id = ?")
        .run(state.workspaceId);
    const request = {
      ...body,
      requestId: REQUEST_ID,
      ...(id === 'workspace.delete'
        ? { confirmation: `permanently-delete-workspace:${state.workspaceId}:1` }
        : {}),
    };
    const legacy = await state.app.request(path.replace('$workspace', state.workspaceId), {
      method,
      ...(method === 'GET'
        ? {}
        : { body: JSON.stringify(request), headers: { 'content-type': 'application/json' } }),
    });
    expect(legacy.status).toBe(404);
    const selectors = {
      ...('workspaceId' in WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS[id].inputSchema.shape
        ? { workspaceId: state.workspaceId }
        : {}),
      ...('invitationId' in WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS[id].inputSchema.shape
        ? { invitationId: 'inv_fixture' }
        : {}),
      ...(id === 'workspace.member-access-change' || id === 'workspace.member-remove'
        ? { targetUserId: 'member' }
        : id === 'user.disable'
          ? { targetUserId: 'target' }
          : {}),
    };
    const canonical = await state.app.request(
      ...operationRequest(id, selectors, { body: JSON.stringify(method === 'GET' ? {} : request) })
    );
    expect(canonical.status).toBe(status);
    const result = await canonical.json();
    if (id === 'workspace.leave') expect(result).toMatchObject({ code: 'owner_transfer_required' });
    if (id === 'workspace.deleted-recover')
      expect(result).toMatchObject({ code: 'recovery_required' });
  } finally {
    state.close();
  }
});

it.each([
  'session',
  'token',
] as const)('uses current administrator %s authority on foreign members without impersonation', async (kind) => {
  const f = fixture();
  try {
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'target',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const actor: Actor = {
      kind,
      userId: 'target',
      ...(kind === 'token'
        ? { tokenId: admin.record.tokenId, tokenScope: 'server-admin' as const }
        : {}),
    };
    const requestId = randomUUID();
    const input = {
      workspaceId: f.workspaceId,
      targetUserId: 'member',
      accessLevel: 'viewer' as const,
      expectedRevision: 1,
      requestId,
    };
    const output = await f.invoke('workspace.member-access-change', input, {
      kind: 'public',
      actor,
    });
    expect(output.member).toMatchObject({ userId: 'member', accessLevel: 'viewer', revision: 2 });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
        .get(f.workspaceId)
    ).toEqual({ owner_user_id: 'user_local' });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(f.workspaceId, 'target')
    ).toBeUndefined();
    expect(
      listServerAuditEvents(f.coreDb).filter((event) => event.requestId === requestId)
    ).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: 'target' },
        subject: { kind: 'user', id: 'member' },
      }),
    ]);
    f.coreDb.sqlite
      .prepare('UPDATE workspace_invitations SET invitee_user_id = ? WHERE invitation_id = ?')
      .run('member', 'inv_fixture');
    const accepted = await f.invoke(
      'workspace.my-invitation-accept',
      { invitationId: 'inv_fixture', expectedRevision: 1, requestId: randomUUID() },
      { kind: 'public', actor }
    );
    expect(accepted.invitation).toMatchObject({
      inviteeUserId: 'member',
      effectiveStatus: 'accepted',
    });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(f.workspaceId, 'target')
    ).toBeUndefined();
    const transfer = await f.invoke(
      'workspace.ownership-transfer',
      {
        workspaceId: f.workspaceId,
        targetUserId: 'member',
        expectedRegistryRevision: 1,
        requestId: randomUUID(),
      },
      { kind: 'public', actor }
    );
    expect(transfer.workspace.ownerUserId).toBe('member');
    revokeOpenKitAccessTokenRecord(f.coreDb, admin.record.tokenId);
    const deniedId = randomUUID();
    const before = f.coreDb.sqlite
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(f.workspaceId, 'member');
    await expect(
      f.invoke(
        'workspace.member-access-change',
        { ...input, accessLevel: 'editor', expectedRevision: 2, requestId: deniedId },
        { kind: 'public', actor }
      )
    ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(f.workspaceId, 'member')
    ).toEqual(before);
    expect(
      f.store.getCommandRequest(
        'workspace.member.access.change',
        deniedId,
        {
          coreId: 'server',
          actorId: 'target',
          targetWorkspaceId: f.workspaceId,
          targetUserId: 'member',
        },
        f.coreDb
      )
    ).toBeNull();
    expect(listServerAuditEvents(f.coreDb).filter((event) => event.requestId === deniedId)).toEqual(
      []
    );
  } finally {
    f.close();
  }
});

it.each([
  'workspace.my-invitation-accept',
  'workspace.my-invitation-decline',
  'workspace.leave',
  'workspace.access-recover',
] as const)('fences %s through its mutation target before any row or receipt changes', async (id) => {
  const f = fixture();
  try {
    await f.admission.close(f.workspaceId);
    const requestId = randomUUID();
    const input =
      id === 'workspace.leave'
        ? { workspaceId: f.workspaceId, expectedRevision: 1, requestId }
        : id === 'workspace.access-recover'
          ? {
              workspaceId: f.workspaceId,
              action: 'add-self-as-editor',
              expectedRegistryRevision: 1,
              requestId,
            }
          : { invitationId: 'inv_fixture', expectedRevision: 1, requestId };
    const beforeInvitation = f.coreDb.sqlite
      .prepare('SELECT * FROM workspace_invitations WHERE invitation_id = ?')
      .get('inv_fixture');
    const beforeMembers = f.coreDb.sqlite
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id')
      .all(f.workspaceId);
    const response = await f.app.request(
      ...operationRequest(id, {}, { body: JSON.stringify(input) })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM workspace_invitations WHERE invitation_id = ?')
        .get('inv_fixture')
    ).toEqual(beforeInvitation);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id')
        .all(f.workspaceId)
    ).toEqual(beforeMembers);
    expect(
      listServerAuditEvents(f.coreDb).filter((event) => event.requestId === requestId)
    ).toEqual([]);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
        .all(requestId)
    ).toEqual([]);
  } finally {
    f.close();
  }
});

it('refuses HTTP user.disable during closed product admission without disabling the user or writing its receipt', async () => {
  const readiness = computeBootReadinessSnapshot({
    bootId: 'boot_b23',
    subsystems: {
      storage: {
        state: 'failed',
        reasons: [{ code: 'storage.failed', message: 'Unavailable', blocks: ['product_work'] }],
      },
    },
  });
  const f = fixture(() => readiness);
  try {
    const requestId = randomUUID();
    const before = f.coreDb.sqlite.prepare('SELECT * FROM users WHERE id = ?').get('target');
    const response = await f.app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: 'target' },
        { body: JSON.stringify({ requestId }) }
      )
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'product_work_unavailable' });
    expect(f.coreDb.sqlite.prepare('SELECT * FROM users WHERE id = ?').get('target')).toEqual(
      before
    );
    expect(
      f.store.getCommandRequest(
        'user.disable',
        requestId,
        { coreId: 'server', actorId: 'user_local', targetUserId: 'target' },
        f.coreDb
      )
    ).toBeNull();
  } finally {
    f.close();
  }
});

it('preserves administrator actor, original deletion owner, exact retry and recovery ownership', async () => {
  const f = fixture(undefined, 'server');
  try {
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'target',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await f.invoke(
      'goal.create',
      {
        workspaceId: f.workspaceId,
        requestId: randomUUID(),
        intent: 'Preserve the original Goal responsibility',
      },
      { kind: 'public', actor: { kind: 'session', userId: 'user_local' } }
    );
    const requestId = randomUUID();
    const input = {
      workspaceId: f.workspaceId,
      expectedRegistryRevision: 1,
      confirmation: `permanently-delete-workspace:${f.workspaceId}:1`,
      requestId,
    };
    const result = await f.app.request(
      ...operationRequest(
        'workspace.delete',
        {},
        { body: JSON.stringify(input), headers: { authorization: `Bearer ${admin.secret}` } }
      )
    );
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({
      deletion: { phase: 'cleaned', status: 'deleted' },
    });
    const record = readWorkspaceDeletionRequest(f.dataRoot, f.workspaceId, requestId);
    expect(record.originalOwnerUserId).toBe('user_local');
    expect(
      listServerAuditEvents(f.coreDb).filter((event) => event.action === 'workspace.delete')
    ).toEqual([expect.objectContaining({ actor: { kind: 'user', id: 'target' } })]);
    const ownerToken = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [f.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const replay = await f.app.request(
      ...operationRequest(
        'workspace.delete',
        {},
        { body: JSON.stringify(input), headers: { authorization: `Bearer ${ownerToken.secret}` } }
      )
    );
    expect(replay.status, await replay.clone().text()).toBe(200);
    const anotherId = randomUUID();
    const another = await f.app.request(
      ...operationRequest(
        'workspace.delete',
        {},
        {
          body: JSON.stringify({ ...input, requestId: anotherId }),
          headers: { authorization: `Bearer ${ownerToken.secret}` },
        }
      )
    );
    expect(another.status).toBe(403);
    expect(await another.json()).toMatchObject({ code: 'workspace_access_denied' });
    expect(
      existsSync(
        join(
          f.dataRoot,
          'server',
          'exports',
          'workspace-deletions',
          f.workspaceId,
          anotherId,
          'request.json'
        )
      )
    ).toBe(false);
    expect(readWorkspaceDeletionRequest(f.dataRoot, f.workspaceId, requestId)).toEqual(record);
    const recovery = await f.app.request(
      ...operationRequest(
        'workspace.deleted-recover',
        { workspaceId: f.workspaceId },
        {
          body: JSON.stringify({ deletionRequestId: requestId, requestId: randomUUID() }),
          headers: { authorization: `Bearer ${admin.secret}` },
        }
      )
    );
    expect(recovery.status, await recovery.clone().text()).toBe(200);
    const body = await recovery.json();
    const restoredDb = openWorkspaceDb(f.dataRoot, body.recovery.import.importedWorkspaceId);
    try {
      const rows = restoredDb.sqlite.prepare('SELECT payload_json FROM goals').all() as Array<{
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
        responsibleUserId: 'user_local',
        responsibleActorContext: { kind: 'session', userId: 'user_local' },
      });
    } finally {
      restoredDb.sqlite.close();
    }
    expect(
      f.coreDb.sqlite
        .prepare('SELECT owner_user_id,status FROM workspace_registry WHERE workspace_id = ?')
        .get(body.recovery.import.importedWorkspaceId)
    ).toEqual({ owner_user_id: 'user_local', status: 'active' });
    expect(
      f.coreDb.sqlite
        .prepare(
          'SELECT user_id,status FROM workspace_members WHERE workspace_id = ? ORDER BY user_id'
        )
        .all(body.recovery.import.importedWorkspaceId)
    ).toEqual([{ user_id: 'user_local', status: 'active' }]);
  } finally {
    f.close();
  }
});

it('keeps a readonly Workspace credential from changing members or creating a command receipt', async () => {
  const f = fixture();
  try {
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: [f.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const requestId = randomUUID();
    const before = f.coreDb.sqlite
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(f.workspaceId, 'member');
    await expect(
      f.invoke(
        'workspace.member-access-change',
        {
          workspaceId: f.workspaceId,
          targetUserId: 'member',
          expectedRevision: 1,
          accessLevel: 'viewer',
          requestId,
        },
        {
          kind: 'public',
          actor: {
            kind: 'token',
            userId: 'user_local',
            tokenId: token.record.tokenId,
            tokenScope: 'workspace-readonly',
            tokenWorkspaceIds: [f.workspaceId],
          },
        }
      )
    ).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(f.workspaceId, 'member')
    ).toEqual(before);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
        .all(requestId)
    ).toEqual([]);
  } finally {
    f.close();
  }
});

it('preserves private-history export refusal during administrator Workspace deletion', async () => {
  const f = fixture(undefined, 'server');
  try {
    f.store.createThread(f.workspaceId, 'Retained private history', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_local',
    });
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'target',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const requestId = randomUUID();
    const response = await f.app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: f.workspaceId },
        {
          headers: { authorization: `Bearer ${admin.secret}` },
          body: JSON.stringify({
            requestId,
            expectedRegistryRevision: 1,
            confirmation: `permanently-delete-workspace:${f.workspaceId}:1`,
          }),
        }
      )
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'recovery_required' });
    expect(readWorkspaceDeletionRequest(f.dataRoot, f.workspaceId, requestId)).toMatchObject({
      phase: 'deleting',
      originalOwnerUserId: 'user_local',
      recoveryExportId: null,
      closureId: null,
    });
    expect(f.store.listThreads(f.workspaceId)).toEqual([
      expect.objectContaining({ visibility: 'private', privateOwnerUserId: 'user_local' }),
    ]);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT owner_user_id,status FROM workspace_registry WHERE workspace_id = ?')
        .get(f.workspaceId)
    ).toEqual({ owner_user_id: 'user_local', status: 'deleting' });
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
        .all(requestId)
    ).toEqual([]);
    expect(
      listServerAuditEvents(f.coreDb).filter((event) => event.action === 'workspace.delete')
    ).toEqual([]);
  } finally {
    f.close();
  }
});
