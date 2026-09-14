// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('dashboard and search Thread audiences', () => {
  it('binds private creation to the actor and keeps explicitly shared work shared', async () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Creation team');
    const app = createApp({ store });
    for (const visibility of ['private', 'workspace'] as const) {
      const response = await app.request(`/api/workspaces/${workspace.id}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId:
            visibility === 'private'
              ? '11111111-1111-4111-8111-111111111111'
              : '22222222-2222-4222-8222-222222222222',
          name: 'New work',
          visibility,
          privateOwnerUserId: 'user_forged',
        }),
      });
      expect(response.status).toBe(201);
      const thread = await response.json();
      expect(thread.visibility).toBe(visibility);
      expect(thread.privateOwnerUserId).toBe(visibility === 'private' ? 'user_local' : undefined);
    }
  });

  it('isolates private content before discovery and preserves shared work for members and admin', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore();
    const workspace = store.createWorkspace('Team');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at) VALUES ('user_other', 'Other', 'other@example.invalid', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    const stamp = '2026-09-14T00:00:00.000Z';
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(workspace.id, stamp, stamp, stamp);
    const threads = [
      'local-private',
      'other-private',
      'Task',
      'Goal',
      'missing',
      'contradictory',
    ].map((label) => {
      const thread = store.createThread(workspace.id, `${label} needle`);
      const raw = thread as unknown as Record<string, unknown>;
      delete raw.privateOwnerUserId;
      if (label.endsWith('private'))
        Object.assign(raw, {
          visibility: 'private',
          privateOwnerUserId: label.startsWith('local') ? 'user_local' : 'user_other',
        });
      else if (label === 'missing') {
        delete raw.visibility;
        delete raw.privateOwnerUserId;
      } else
        Object.assign(raw, {
          visibility: 'workspace',
          ...(label === 'contradictory' ? { privateOwnerUserId: 'user_other' } : {}),
        });
      const turn = store.createTurn(workspace.id, thread.id, `${label} needle`, {
        kind: 'user',
        id: 'user_local',
      });
      store.createItem({
        id: `it_${label}`,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: `${label} needle content`,
        createdAt: stamp,
        completedAt: stamp,
      });
      return thread;
    });
    const app = createApp({
      auth: {
        api: { getSession: async () => null },
        handler: async () => new Response(null, { status: 404 }),
      },
      coreDb,
      dataRoot,
      mode: 'server',
      store,
    });
    try {
      for (const [userId, scope] of [
        ['user_local', 'workspace-readonly'],
        ['user_other', 'workspace-readonly'],
        ['user_local', 'server-admin'],
      ] as const) {
        const token = createOpenKitAccessTokenRecord(coreDb, {
          ownerUserId: userId,
          scope,
          workspaceIds: scope === 'server-admin' ? [] : [workspace.id],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        const headers = { authorization: `Bearer ${token.secret}` };
        const own = userId === 'user_local' ? threads[0]! : threads[1]!;
        const denied = userId === 'user_local' ? threads[1]! : threads[0]!;
        const readItems = vi.spyOn(store, 'listThreadItems');
        const dashboard = await app.request(`/api/app/workspaces/${workspace.id}/dashboard`, {
          headers,
        });
        expect(dashboard.status).toBe(200);
        const body = await dashboard.json();
        expect(body.recentThreads.map((thread: { id: string }) => thread.id).sort()).toEqual(
          [own.id, threads[2]!.id, threads[3]!.id].sort()
        );
        expect(body.counts.threadCount).toBe(3);
        const search = await app.request('/api/app/search?q=needle', { headers });
        expect(search.status).toBe(200);
        const hits = await search.json();
        expect(
          hits.items
            .filter((item: { kind: string }) => item.kind === 'thread')
            .map((item: { id: string }) => item.id)
            .sort()
        ).toEqual([own.id, threads[2]!.id, threads[3]!.id].sort());
        expect(JSON.stringify(hits)).not.toContain(denied.name);
        for (const hidden of [denied, threads[4]!, threads[5]!]) {
          expect(readItems.mock.calls.some((args) => args[1] === hidden.id)).toBe(false);
          const direct = await app.request(
            `/api/app/workspaces/${workspace.id}/threads/${hidden.id}/dashboard`,
            { headers }
          );
          expect(direct.status).toBe(404);
          expect(await direct.text()).not.toContain(hidden.name);
        }
        for (const visible of [own, threads[2]!, threads[3]!])
          expect(
            (
              await app.request(
                `/api/app/workspaces/${workspace.id}/threads/${visible.id}/dashboard`,
                { headers }
              )
            ).status
          ).toBe(200);
        readItems.mockRestore();
      }
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
