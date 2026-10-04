import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { createAutomationOperationImplementations } from './automation-operations.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

describe('automation app API', () => {
  it('lists and creates local automation definitions', async () => {
    const app = createApp({ store: createDemoStore() });

    const emptyRes = await app.request(...operationRequest('automation.list', {}));
    expect(emptyRes.status).toBe(200);
    await expect(emptyRes.json()).resolves.toEqual({ items: [] });

    const createRes = await app.request(
      ...operationRequest(
        'automation.create',
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Morning status',
            workspaceId: 'ws_demo',
            cron: '0 9 * * *',
            prompt: 'Summarize active threads',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(createRes.status).toBe(201);
    await expect(createRes.json()).resolves.toMatchObject({
      id: expect.any(String),
      name: 'Morning status',
      status: 'paused',
    });

    const listRes = await app.request(...operationRequest('automation.list', {}));
    await expect(listRes.json()).resolves.toMatchObject({
      items: [{ name: 'Morning status', cron: '0 9 * * *' }],
    });
  });

  it('updates and deletes local automation definitions', async () => {
    const app = createApp({ store: createDemoStore() });
    const createRes = await app.request(
      ...operationRequest(
        'automation.create',
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Morning status',
            workspaceId: 'ws_demo',
            cron: '0 9 * * *',
            prompt: 'Summarize active threads',
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const automation = (await createRes.json()) as { id: string };

    const enableRes = await app.request(
      ...operationRequest(
        'automation.update',
        { automationId: automation.id },
        {
          method: 'PATCH',
          body: JSON.stringify({ status: 'enabled' }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    expect(enableRes.status).toBe(200);
    await expect(enableRes.json()).resolves.toMatchObject({
      id: automation.id,
      status: 'enabled',
    });

    const deleteRes = await app.request(
      ...operationRequest(
        'automation.delete',
        { automationId: automation.id },
        {
          method: 'DELETE',
        }
      )
    );

    expect(deleteRes.status).toBe(204);

    const listRes = await app.request(...operationRequest('automation.list', {}));
    await expect(listRes.json()).resolves.toEqual({ items: [] });
  });

  it('uses the authenticated actor for user-private records with one shared store', async () => {
    const store = createDemoStore();
    const listWorkspaces = vi.spyOn(store, 'listWorkspaces').mockImplementation(() => {
      throw new Error('Collection routes must not enumerate every Workspace.');
    });
    const automationStore = new AutomationStore();
    const operations = createAutomationOperationImplementations({
      coreDb: undefined,
      store,
      automationStore,
    });
    const first = { kind: 'user', id: 'user_first' } as const;
    const second = { kind: 'user', id: 'user_second' } as const;
    const context = {
      kind: 'public',
      actor: { kind: 'session', userId: 'user_first' },
      actorRef: first,
      scope: { kind: 'authorized-workspace-set', workspaceIds: ['ws_demo'] },
    } as const;
    const created = await operations['automation.create'](
      {
        cron: '0 9 * * *',
        name: 'Morning status',
        prompt: 'Summarize active threads',
        workspaceId: 'ws_demo',
      },
      context
    );
    expect(created.status).toBe('paused');
    expect(await operations['automation.list']({}, context)).toMatchObject({
      items: [{ name: 'Morning status' }],
    });
    expect(
      await operations['automation.list'](
        {},
        { ...context, actor: { ...context.actor, userId: second.id }, actorRef: second }
      )
    ).toEqual({
      items: [],
    });
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('lists only active token-bound workspace automations', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-automation-scope-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const now = Date.now();
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (
            id,
            display_name,
            email,
            email_verified,
            created_at,
            updated_at,
            kind
          )
          VALUES ('user_owner', 'Owner', 'owner@example.com', false, ?, ?, 'human')`
        )
        .run(now, now);
      const store = new FsStore({ dataRoot });
      const allowedWorkspace = store.createWorkspace('Allowed');
      const deniedWorkspace = store.createWorkspace('Denied');

      for (const workspace of [allowedWorkspace, deniedWorkspace]) {
        recordWorkspaceOwnerMembership({
          coreDb,
          ownerUserId: 'user_owner',
          workspaceId: workspace.id,
        });
      }

      const automationStore = new AutomationStore();
      const app = createApp({
        automationStore,
        auth: {
          api: { getSession: async () => null },
          handler: async () => new Response(null, { status: 404 }),
        },
        coreDb,
        dataRoot,
        mode: 'server',
        store,
      });
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: [allowedWorkspace.id],
      });
      const create = await app.request(
        ...operationRequest(
          'automation.create',
          {},
          {
            body: JSON.stringify({
              cron: '0 9 * * *',
              name: 'Allowed automation',
              prompt: 'Summarize active threads',
              workspaceId: allowedWorkspace.id,
            }),
            headers: {
              authorization: `Bearer ${workspaceToken.secret}`,
              'content-type': 'application/json',
            },
            method: 'POST',
          }
        )
      );

      expect(create.status).toBe(201);
      const allowedAutomation = (await create.json()) as { id: string; workspaceId: string };
      const deniedAutomation = automationStore.createAutomation('user_owner', {
        cron: '0 9 * * *',
        name: 'Denied automation',
        prompt: 'Summarize active threads',
        workspaceId: deniedWorkspace.id,
      });
      const readonlyToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace-readonly',
        workspaceIds: [allowedWorkspace.id],
      });
      const list = await app.request(
        ...operationRequest(
          'automation.list',
          {},
          {
            headers: { authorization: `Bearer ${readonlyToken.secret}` },
          }
        )
      );

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toEqual({
        items: [expect.objectContaining(allowedAutomation)],
      });

      const deniedUpdate = await app.request(
        ...operationRequest(
          'automation.update',
          { automationId: deniedAutomation.id },
          {
            body: JSON.stringify({ status: 'enabled' }),
            headers: {
              authorization: `Bearer ${workspaceToken.secret}`,
              'content-type': 'application/json',
            },
            method: 'PATCH',
          }
        )
      );
      const deniedDelete = await app.request(
        ...operationRequest(
          'automation.delete',
          { automationId: deniedAutomation.id },
          {
            headers: { authorization: `Bearer ${workspaceToken.secret}` },
            method: 'DELETE',
          }
        )
      );

      expect(deniedUpdate.status).toBe(403);
      expect(deniedDelete.status).toBe(403);
      expect(automationStore.getAutomation('user_owner', deniedAutomation.id).status).toBe(
        'paused'
      );

      const transferredAt = new Date().toISOString();
      coreDb.sqlite.transaction(() => {
        coreDb.sqlite
          .prepare(
            `INSERT INTO users
              (id, display_name, email, email_verified, created_at, updated_at, kind)
             VALUES ('user_replacement_owner', 'Replacement Owner',
                     'automation-replacement@example.com', false, ?, ?, 'human')`
          )
          .run(Date.now(), Date.now());
        coreDb.sqlite
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, status, access_level, invitation_id,
              joined_at, removed_at, revision, created_at, updated_at
            ) VALUES (?, 'user_replacement_owner', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
          )
          .run(allowedWorkspace.id, transferredAt, transferredAt, transferredAt);
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_registry
             SET owner_user_id = 'user_replacement_owner', revision = revision + 1, updated_at = ?
             WHERE workspace_id = ?`
          )
          .run(transferredAt, allowedWorkspace.id);
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_members
             SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
             WHERE workspace_id = ? AND user_id = ?`
          )
          .run(transferredAt, transferredAt, allowedWorkspace.id, 'user_owner');
      })();
      const removed = await app.request(
        ...operationRequest(
          'automation.list',
          {},
          {
            headers: { authorization: `Bearer ${readonlyToken.secret}` },
          }
        )
      );

      expect(removed.status).toBe(200);
      await expect(removed.json()).resolves.toEqual({ items: [] });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
