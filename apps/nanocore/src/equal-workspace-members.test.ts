import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareCodeUnits } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { readWorkspaceSnapshotMetadata } from './storage/workspace-backup-bundle.js';
import { testEntityId } from './test-support/entity-ids.js';
import {
  createWorkspaceDeletionRequest,
  readWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const USER_IDS = {
  owner: testEntityId('usr', 'equal-owner'),
  member: testEntityId('usr', 'equal-member'),
  other: testEntityId('usr', 'equal-other'),
  invitee: testEntityId('usr', 'equal-invitee'),
  privateOwner: testEntityId('usr', 'equal-private-owner'),
};

/** Inserts synthetic canonical users without granting deployment administration. */
function insertUser(coreDb: ReturnType<typeof openCoreDb>, id: string, label: string): void {
  coreDb.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
    VALUES (?, ?, ?, 0, ?, ?, 'human', 'active')`)
    .run(id, label, `${label}@example.test`, Date.now(), Date.now());
}

it('requires the actual initiating user in the current deletion request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-deletion-required-initiator-'));
  try {
    const requestId = randomUUID();
    const workspaceId = testEntityId('ws', 'deletion-required-initiator');
    const request = createWorkspaceDeletionRequest(root, {
      confirmation: `permanently-delete-workspace:${workspaceId}:1`,
      createdAt: new Date().toISOString(),
      expectedRegistryRevision: 1,
      initiatingUserId: USER_IDS.member,
      originalOwnerUserId: USER_IDS.owner,
      requestId,
      workspaceId: workspaceId,
    });
    expect(readWorkspaceDeletionRequest(root, workspaceId, requestId)).toEqual(request);
    const { initiatingUserId: _initiatingUserId, ...missingInitiator } = request;
    writeFileSync(
      join(
        root,
        'server',
        'exports',
        'workspace-deletions',
        workspaceId,
        requestId,
        'request.json'
      ),
      JSON.stringify(missingInitiator)
    );
    expect(() => readWorkspaceDeletionRequest(root, workspaceId, requestId)).toThrow();
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
  }
});

it('admits member management and exact member deletion replay while preserving private recovery ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-equal-members-deletion-'));
  const coreDb = openCoreDb(root);
  try {
    applyMigrations(coreDb);
    for (const [label, id] of Object.entries(USER_IDS)) insertUser(coreDb, id, label);
    const store = new FsStore({ dataRoot: root });
    const workspace = await store.createWorkspace('Equal members');
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: workspace.id,
      ownerUserId: USER_IDS.owner,
    });
    const now = new Date().toISOString();
    for (const id of [USER_IDS.member, USER_IDS.other, USER_IDS.privateOwner])
      coreDb.sqlite
        .prepare(`INSERT INTO workspace_members
      (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
      VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)`)
        .run(workspace.id, id, now, now, now);
    const privateThread = await store.createThread(
      workspace.id,
      'Private history',
      undefined,
      'administration',
      {
        visibility: 'private',
        privateOwnerUserId: USER_IDS.privateOwner,
      }
    );
    const member = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: USER_IDS.member,
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const other = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: USER_IDS.other,
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const originalOwner = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: USER_IDS.owner,
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const auth: BetterAuthServer = {
      api: {
        getSession: async () => ({
          session: { id: 'synthetic-owner-session' },
          user: { id: USER_IDS.owner },
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
      releaseIdentity: { releaseTag: 'v0.1.0-test', sourceCommit: '1'.repeat(40) },
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
    expect(await invitation.json()).toMatchObject({
      invitation: { inviterUserId: USER_IDS.member },
    });
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
    // Workspace Backup: membership supplies no outward export grant, including private history.
    expect(ordinaryExport.status, await ordinaryExport.clone().text()).toBe(403);
    expect(await ordinaryExport.json()).toMatchObject({ code: 'workspace_access_denied' });
    const missingRecovery = await call('workspace.deleted-recover', {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      deletionRequestId: randomUUID(),
    });
    expect(missingRecovery.status).toBe(409);
    expect(existsSync(join(root, 'server', 'backups', 'workspaces', workspace.id))).toBe(false);
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
    expect(request).toMatchObject({
      initiatingUserId: USER_IDS.member,
      originalOwnerUserId: USER_IDS.owner,
    });
    const verified = await readWorkspaceSnapshotMetadata({
      dataRoot: root,
      workspaceId: workspace.id,
      backupId: request.recoveryBackupId!,
    });
    expect(verified.manifest.workspaceId).toBe(workspace.id);
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
      (
        await readWorkspaceSnapshotMetadata({
          dataRoot: root,
          workspaceId: workspace.id,
          backupId: request.recoveryBackupId!,
        })
      ).manifestDigest
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
    const recoveryRequestId = randomUUID();
    const recovered = await call('workspace.deleted-recover', {
      workspaceId: workspace.id,
      requestId: recoveryRequestId,
      deletionRequestId: requestId,
    });
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    const result = (await recovered.json()) as {
      command: string;
      disposition: string;
      workspaceId: string;
      selection: { kind: string; requestId: string };
      droppedSourceMemberIds: string[];
      restrictedRecovery: boolean;
      nextAction: string;
    };
    expect(result).toMatchObject({
      command: 'restore',
      disposition: 'restored',
      workspaceId: workspace.id,
      selection: { kind: 'admission', requestId: recoveryRequestId },
      droppedSourceMemberIds: [],
      restrictedRecovery: false,
      nextAction: 'none',
    });
    const restoredId = result.workspaceId;
    expect(
      coreDb.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
        .get(restoredId)
    ).toEqual({ owner_user_id: USER_IDS.owner });
    expect(
      coreDb.sqlite
        .prepare(
          'SELECT user_id,status FROM workspace_members WHERE workspace_id = ? ORDER BY user_id'
        )
        .all(restoredId)
    ).toEqual(
      [
        { user_id: USER_IDS.owner, status: 'active' },
        ...[USER_IDS.member, USER_IDS.other, USER_IDS.privateOwner].map((userId) => ({
          user_id: userId,
          status: 'removed',
        })),
      ].sort((left, right) => compareCodeUnits(left.user_id, right.user_id))
    );
    expect(store.listThreads(restoredId)).toContainEqual(
      expect.objectContaining({ privateOwnerUserId: USER_IDS.privateOwner })
    );
    expect(
      (
        coreDb.sqlite
          .prepare(`SELECT actor_json FROM audit_events
            WHERE action = 'workspace.delete'
              AND request_id = ?
              AND workspace_id = ?
              AND outcome = 'succeeded'`)
          .all(requestId, workspace.id) as { actor_json: string }[]
      ).map((row) => JSON.parse(row.actor_json))
    ).toEqual([{ id: USER_IDS.member, kind: 'user' }]);
  } finally {
    await closeRetrievalServices();
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
  }
});
