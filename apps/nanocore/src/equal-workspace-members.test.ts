import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { verifyWorkspaceExportTree } from './storage/workspace-export.js';
import {
  createVerifiedWorkspaceExport,
  workspaceDeletionRecoveryExportId,
} from './storage/workspace-transfer-routes.js';
import {
  createWorkspaceDeletionRequest,
  readWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Inserts synthetic canonical users without granting deployment administration. */
function insertUser(coreDb: ReturnType<typeof openCoreDb>, id: string): void {
  coreDb.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
    VALUES (?, ?, ?, 0, ?, ?, 'human', 'active')`)
    .run(id, id, `${id}@example.test`, Date.now(), Date.now());
}

it('requires the actual initiating user in the current deletion request', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-deletion-required-initiator-'));
  try {
    const requestId = randomUUID();
    const request = createWorkspaceDeletionRequest(root, {
      confirmation: 'permanently-delete-workspace:ws_current:1',
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      initiatingUserId: 'member',
      originalOwnerUserId: 'owner',
      requestId,
      workspaceId: 'ws_current',
    });
    expect(readWorkspaceDeletionRequest(root, 'ws_current', requestId)).toEqual(request);
    const { initiatingUserId: _initiatingUserId, ...missingInitiator } = request;
    writeFileSync(
      join(
        root,
        'server',
        'exports',
        'workspace-deletions',
        'ws_current',
        requestId,
        'request.json'
      ),
      JSON.stringify(missingInitiator)
    );
    expect(() => readWorkspaceDeletionRequest(root, 'ws_current', requestId)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('admits member management and exact member deletion replay while preserving private recovery ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-equal-members-deletion-'));
  const coreDb = openCoreDb(root);
  try {
    applyMigrations(coreDb);
    for (const id of ['owner', 'member', 'other', 'invitee', 'private-owner'])
      insertUser(coreDb, id);
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Equal members');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: 'owner' });
    const now = new Date().toISOString();
    for (const id of ['member', 'other', 'private-owner'])
      coreDb.sqlite
        .prepare(`INSERT INTO workspace_members
      (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
      VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)`)
        .run(workspace.id, id, now, now, now);
    const privateThread = store.createThread(
      workspace.id,
      'Private history',
      undefined,
      'administration',
      {
        visibility: 'private',
        privateOwnerUserId: 'private-owner',
      }
    );
    const member = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'member',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const other = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'other',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const originalOwner = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'owner',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const auth: BetterAuthServer = {
      api: {
        getSession: async () => ({
          session: { id: 'synthetic-owner-session' },
          user: { id: 'owner' },
        }),
      },
      handler: async () => Response.json({ status: 'auth-ok' }),
    };
    const app = createApp({
      coreDb,
      dataRoot: root,
      mode: 'server',
      auth,
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const call = (operation: string, input: Record<string, unknown>, token?: string) => {
      const { requestId, ...body } = input;
      return app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        },
        body: JSON.stringify(body),
      });
    };
    const invitation = await call(
      'workspace.invitation-create',
      { workspaceId: workspace.id, requestId: randomUUID(), inviteeEmail: 'invitee@example.test' },
      member.secret
    );
    expect(invitation.status, await invitation.clone().text()).toBe(201);
    expect(await invitation.json()).toMatchObject({ invitation: { inviterUserId: 'member' } });
    const deniedPrivate = await call(
      'thread.items',
      { workspaceId: workspace.id, threadId: privateThread.id },
      member.secret
    );
    expect(deniedPrivate.status, await deniedPrivate.clone().text()).toBe(404);
    expect(await deniedPrivate.json()).toMatchObject({
      code: 'not_found',
      message: 'Thread not found.',
    });
    const ordinaryExport = await call(
      'workspace.export',
      { workspaceId: workspace.id },
      member.secret
    );
    expect(ordinaryExport.status, await ordinaryExport.clone().text()).toBe(500);
    expect(() =>
      createVerifiedWorkspaceExport({
        authorityUserId: 'member',
        coreDb,
        dataRoot: root,
        repositoryWorkspaceDb: (id) => openWorkspaceDb(root, id),
        store,
        workspaceId: workspace.id,
      })
    ).toThrow('Private Thread history requires a separately authorized export.');
    const missingDeletionRequestId = randomUUID();
    expect(() =>
      createVerifiedWorkspaceExport({
        authorityUserId: 'owner',
        coreDb,
        dataRoot: root,
        deletionRecoveryRequestId: missingDeletionRequestId,
        exportId: workspaceDeletionRecoveryExportId(missingDeletionRequestId),
        repositoryWorkspaceDb: (id) => openWorkspaceDb(root, id),
        store,
        workspaceId: workspace.id,
      })
    ).toThrow();
    expect(existsSync(join(root, 'server', 'exports', 'workspaces', workspace.id))).toBe(false);
    const requestId = randomUUID();
    const deletionInput = {
      workspaceId: workspace.id,
      requestId,
      expectedRegistryRevision: 1,
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
    };
    const deleted = await call('workspace.delete', deletionInput, member.secret);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toMatchObject({
      deletion: { phase: 'cleaned', status: 'deleted' },
    });
    const request = readWorkspaceDeletionRequest(root, workspace.id, requestId);
    expect(request).toMatchObject({ initiatingUserId: 'member', originalOwnerUserId: 'owner' });
    const verified = verifyWorkspaceExportTree({
      exportRoot: join(
        root,
        'server',
        'exports',
        'workspaces',
        workspace.id,
        request.recoveryExportId!
      ),
    });
    const exportedThreads = verified.fileContents
      .get('records/threads.jsonl')!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(exportedThreads).toContainEqual(
      expect.objectContaining({ id: privateThread.id, privateOwnerUserId: 'private-owner' })
    );
    const before = coreDb.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
      .all(requestId);
    const replay = await call('workspace.delete', deletionInput, member.secret);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
        .all(requestId)
    ).toEqual(before);
    expect(
      (
        await call(
          'workspace.delete',
          {
            ...deletionInput,
            expectedRegistryRevision: 2,
            confirmation: `permanently-delete-workspace:${workspace.id}:2`,
          },
          member.secret
        )
      ).status
    ).toBe(409);
    expect(readWorkspaceDeletionRequest(root, workspace.id, requestId)).toEqual(request);
    expect(
      verifyWorkspaceExportTree({
        exportRoot: join(
          root,
          'server',
          'exports',
          'workspaces',
          workspace.id,
          request.recoveryExportId!
        ),
      }).manifestDigest
    ).toBe(verified.manifestDigest);
    expect((await call('workspace.delete', deletionInput, other.secret)).status).toBe(403);
    expect((await call('workspace.delete', deletionInput, originalOwner.secret)).status).toBe(403);
    expect(
      (
        await call(
          'workspace.deleted-recover',
          { workspaceId: workspace.id, requestId: randomUUID(), deletionRequestId: requestId },
          member.secret
        )
      ).status
    ).toBe(403);
    const recovered = await call('workspace.deleted-recover', {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      deletionRequestId: requestId,
    });
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    const result = (await recovered.json()) as {
      recovery: { import: { importedWorkspaceId: string } };
    };
    const restoredId = result.recovery.import.importedWorkspaceId;
    expect(
      coreDb.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
        .get(restoredId)
    ).toEqual({ owner_user_id: 'owner' });
    expect(
      coreDb.sqlite
        .prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?')
        .all(restoredId)
    ).toEqual([{ user_id: 'owner' }]);
    expect(store.listThreads(restoredId)).toContainEqual(
      expect.objectContaining({ privateOwnerUserId: 'private-owner' })
    );
    expect(
      (
        coreDb.sqlite
          .prepare("SELECT actor_json FROM audit_events WHERE action = 'workspace.delete'")
          .all() as { actor_json: string }[]
      ).map((row) => JSON.parse(row.actor_json))
    ).toEqual([{ id: 'member', kind: 'user' }]);
  } finally {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
