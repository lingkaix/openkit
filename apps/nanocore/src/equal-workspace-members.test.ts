import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { applyMigrations, applyNativeScopeMigrations } from './storage/migrate.js';
import { verifyWorkspaceExportTree } from './storage/workspace-export.js';
import {
  createVerifiedWorkspaceExport,
  workspaceDeletionRecoveryExportId,
} from './storage/workspace-transfer-routes.js';
import { readWorkspaceDeletionRequest } from './workspace-deletion-request.js';
import {
  recordWorkspaceOwnerMembership,
  resolveWorkspaceMembershipRelation,
} from './workspace-membership.js';

/** Inserts synthetic canonical users without granting deployment administration. */
function insertUser(coreDb: ReturnType<typeof openCoreDb>, id: string): void {
  coreDb.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
    VALUES (?, ?, ?, 0, ?, ?, 'human', 'active')`)
    .run(id, id, `${id}@example.test`, Date.now(), Date.now());
}

it('carries retained tiered membership and invitation records through the one-way equal-member migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-equal-members-migration-'));
  const coreDb = openCoreDb(root);
  try {
    const legacyJournal = join(root, 'legacy-journal');
    mkdirSync(join(legacyJournal, 'meta'), { recursive: true });
    const journalRoot = join(import.meta.dirname, '..', 'drizzle', 'core');
    const journal = JSON.parse(readFileSync(join(journalRoot, 'meta', '_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, 2);
    for (const entry of journal.entries)
      cpSync(join(journalRoot, `${entry.tag}.sql`), join(legacyJournal, `${entry.tag}.sql`));
    writeFileSync(join(legacyJournal, 'meta', '_journal.json'), JSON.stringify(journal));
    applyNativeScopeMigrations(coreDb.sqlite, 'core', legacyJournal);
    for (const id of ['owner', 'member', 'removed', 'invitee']) insertUser(coreDb, id);
    const now = '2026-10-16T00:00:00.000Z';
    coreDb.sqlite
      .prepare("INSERT INTO workspace_registry VALUES ('ws_retained', 'owner', 'active', 7, ?, ?)")
      .run(now, now);
    coreDb.sqlite
      .prepare(`INSERT INTO workspace_invitations VALUES
      ('inv_accepted', 'ws_retained', 'member', 'viewer', 'owner', 'accepted', '2099-01-01T00:00:00.000Z', ?, NULL, NULL, 2, ?, ?)`)
      .run(now, now, now);
    for (const [id, status, level, removedAt] of [
      ['owner', 'active', 'editor', null],
      ['member', 'active', 'viewer', null],
      ['removed', 'removed', 'editor', now],
    ])
      coreDb.sqlite
        .prepare(`INSERT INTO workspace_members
      (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
      VALUES ('ws_retained', ?, ?, ?, ?, ?, ?, 3, ?, ?)`)
        .run(id, status, level, id === 'member' ? 'inv_accepted' : null, now, removedAt, now, now);
    coreDb.sqlite
      .prepare(`INSERT INTO workspace_invitations VALUES
      ('inv_retained', 'ws_retained', 'invitee', 'viewer', 'member', 'pending', '2099-01-01T00:00:00.000Z', NULL, NULL, NULL, 4, ?, ?)`)
      .run(now, now);
    const members = coreDb.sqlite
      .prepare('SELECT * FROM workspace_members ORDER BY user_id')
      .all()
      .map((row) => {
        const { access_level: _retired, ...retained } = row as Record<string, unknown>;
        return retained;
      });
    const invitations = coreDb.sqlite
      .prepare('SELECT * FROM workspace_invitations ORDER BY invitation_id')
      .all()
      .map((row) => {
        const { proposed_access_level: _retired, ...retained } = row as Record<string, unknown>;
        return retained;
      });

    applyMigrations(coreDb);
    applyMigrations(coreDb);

    expect(coreDb.sqlite.prepare('SELECT * FROM workspace_members ORDER BY user_id').all()).toEqual(
      members
    );
    expect(
      coreDb.sqlite.prepare('SELECT * FROM workspace_invitations ORDER BY invitation_id').all()
    ).toEqual(invitations);
    expect(coreDb.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(resolveWorkspaceMembershipRelation(coreDb, 'ws_retained', 'member')).toBe('member');
    expect(resolveWorkspaceMembershipRelation(coreDb, 'ws_retained', 'removed')).toBeNull();
    expect(() =>
      coreDb.sqlite.prepare("DELETE FROM workspace_members WHERE user_id = 'owner'").run()
    ).toThrow('workspace_owner_membership_required');
    expect(() =>
      coreDb.sqlite.prepare("UPDATE workspace_registry SET owner_user_id = 'removed'").run()
    ).toThrow('workspace_owner_membership_required');
  } finally {
    coreDb.sqlite.close();
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
