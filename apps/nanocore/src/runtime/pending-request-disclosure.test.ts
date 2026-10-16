import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationId } from '@openkit/app-api-schemas';
import { expect, it } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  setDefaultServerAdminTokenId,
} from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { projectApprovalEffect } from './pending-request-disclosure.js';
import { readPendingRequest } from './pending-requests.js';

/** Uses real public operations, canonical credentials and retained request state; auth supplies identity only. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pending-session-disclosure-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  for (const id of ['review-admin', 'ordinary-member'])
    coreDb.sqlite
      .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
        VALUES (?, ?, ?, 0, ?, ?, 'human', 'active')`)
      .run(id, id, `${id}@example.test`, Date.now(), Date.now());
  const vault = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server', 'vault'),
  });
  vault.unlock({ masterKey: Buffer.alloc(32, 23) });
  const store = new FsStore({ dataRoot });
  const options = {
    coreDb,
    dataRoot,
    store,
    vaultUnlockState: vault,
    agentManifests: [createTestAgentSetup().manifest],
  };
  const local = createApp(options);
  const sessions = new Map<string, ReturnType<typeof createApp>>();
  const send = (
    userId: string | null,
    operation: OperationId,
    body: Record<string, unknown>,
    secret?: string
  ) => {
    let app = local;
    if (userId) {
      app =
        sessions.get(userId) ??
        createApp({
          ...options,
          mode: 'server',
          auth: {
            api: {
              getSession: async () => ({
                session: { id: `session-${userId}` },
                user: { id: userId },
              }),
            },
            handler: async () => Response.json({}),
          },
        });
      sessions.set(userId, app);
    }
    return app.request(
      ...operationRequest(
        operation,
        {},
        {
          body: JSON.stringify(body),
          ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}),
        }
      )
    );
  };
  const cleanup = () => {
    vault.lock();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  };
  try {
    const workspaceResponse = await send(null, 'workspace.create', {
      name: 'Disclosure authority',
      requestId: randomUUID(),
    });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (await workspaceResponse.json()).id as string;
    const now = new Date().toISOString();
    coreDb.sqlite
      .prepare(`INSERT INTO workspace_members
      (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
      VALUES (?, 'ordinary-member', 'active', NULL, ?, NULL, 1, ?, ?)`)
      .run(workspaceId, now, now, now);
    const threadResponse = await send(null, 'thread.create', {
      workspaceId,
      name: 'Private exact request',
      requestId: randomUUID(),
    });
    expect(threadResponse.status).toBe(200);
    const threadId = (await threadResponse.json()).id as string;
    const referenceResponse = await send(null, 'vault.secret-create', {
      workspaceId,
      secretKind: 'mcp-credential',
      material: 'synthetic-disclosure-material-canary',
    });
    expect(referenceResponse.status).toBe(200);
    const referenceId = (await referenceResponse.json()).referenceId as string;
    const terms = {
      referenceId,
      ownerScope: 'workspace',
      lifetime: 'workspace',
      injectionPath: 'gateway-only',
      targetCapabilityId: 'mcp.call_tool',
    };
    const raised = await send('user_local', 'vault.grant-request', {
      workspaceId,
      threadId,
      terms,
      requestId: randomUUID(),
    });
    expect(raised.status).toBe(200);
    const request = await raised.json();
    const administrator = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'review-admin',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(setDefaultServerAdminTokenId(coreDb, 'review-admin', administrator.tokenId)).toBe(true);
    const db = openWorkspaceDb(dataRoot, workspaceId);
    const read = () => readPendingRequest(db.sqlite, request.approvalRequestId)!;
    const approval = {
      workspaceId,
      threadId,
      turnId: request.raisingTurnId,
      approvalRequestId: request.approvalRequestId,
      decision: 'granted',
      requestId: randomUUID(),
    };
    return {
      coreDb,
      store,
      send,
      terms,
      request,
      read,
      approval,
      administrator,
      selector: { workspaceId, threadId },
      memberships: () =>
        coreDb.sqlite
          .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id')
          .all(workspaceId),
      cleanup: () => {
        db.sqlite.close();
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

it('discloses the exact private request and accepts its current nonmember administrator Web session decision', async () => {
  const f = await fixture();
  try {
    const memberships = f.memberships();
    expect(memberships).not.toContainEqual(expect.objectContaining({ user_id: 'review-admin' }));
    const response = await f.send('review-admin', 'vault.grant-request-list', f.selector);
    expect(response.status).toBe(200);
    const observed = (await response.json()).items[0];
    const approved = await f.send('review-admin', 'approval.respond', f.approval);
    expect.soft(observed).toMatchObject({ canApprove: true, effect: { status: 'available' } });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(JSON.parse(observed.effect.detail)).toMatchObject({
      operation: 'vault.grant-issue',
      terms: f.terms,
    });
    expect(f.read()).toMatchObject({
      resolution: 'granted',
      decidingActor: { kind: 'user', id: 'review-admin' },
      decidingActorContext: {
        kind: 'session',
        userId: 'review-admin',
        adminTokenId: f.administrator.tokenId,
      },
    });
    expect(f.memberships()).toEqual(memberships);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_use_records').all()).toHaveLength(0);
    expect(JSON.stringify(observed)).not.toContain('synthetic-disclosure-material-canary');
  } finally {
    f.cleanup();
  }
});

it.each([
  'revoked',
  'disabled',
] as const)('refuses a %s nonmember administrator session before disclosure or decision effects', async (ending) => {
  const f = await fixture();
  try {
    const before = f.read();
    const memberships = f.memberships();
    if (ending === 'revoked') revokeOpenKitAccessTokenRecord(f.coreDb, f.administrator.tokenId);
    else f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, 'review-admin'))();
    const list = await f.send('review-admin', 'vault.grant-request-list', f.selector);
    const approved = await f.send('review-admin', 'approval.respond', f.approval);
    expect([401, 403]).toContain(list.status);
    expect([401, 403]).toContain(approved.status);
    expect(f.read()).toEqual(before);
    expect(f.memberships()).toEqual(memberships);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_use_records').all()).toHaveLength(0);
    expect(JSON.stringify([await list.json(), await approved.json()])).not.toContain(
      f.terms.referenceId
    );
  } finally {
    f.cleanup();
  }
});

it('retains ordinary responsible-user disclosure, administrator-only grant review and private Thread audience', async () => {
  const f = await fixture();
  try {
    const before = f.read();
    const response = await f.send('user_local', 'vault.grant-request-list', f.selector);
    expect(response.status).toBe(200);
    expect((await response.json()).items[0]).toMatchObject({
      canApprove: false,
      effect: { status: 'available' },
    });
    const approved = await f.send('user_local', 'approval.respond', f.approval);
    expect(approved.status).toBe(403);
    const readonly = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: [f.selector.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const readonlyList = await f.send(
      'user_local',
      'vault.grant-request-list',
      f.selector,
      readonly.secret
    );
    expect(readonlyList.status).toBe(200);
    expect((await readonlyList.json()).items[0]).toMatchObject({
      canApprove: false,
      effect: { status: 'available' },
    });
    expect(
      (await f.send('user_local', 'approval.respond', f.approval, readonly.secret)).status
    ).toBe(403);
    const foreign = await f.send('ordinary-member', 'vault.grant-request-list', f.selector);
    expect(foreign.status).toBe(404);
    expect(
      projectApprovalEffect({
        record: before,
        store: f.store,
        coreDb: f.coreDb,
        actor: { kind: 'session', userId: 'ordinary-member' },
      })
    ).toMatchObject({ status: 'unavailable' });
    expect(
      projectApprovalEffect({
        record: before,
        store: f.store,
        actor: { kind: 'session', userId: 'user_local' },
      })
    ).toMatchObject({ status: 'available' });
    expect(f.read()).toEqual(before);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
