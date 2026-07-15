import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { AutomationStore } from './lib/automation-store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';

describe('automation app API', () => {
  it('lists and creates local automation definitions', async () => {
    const app = createApp({ store: createDemoStore() });

    const emptyRes = await app.request('/api/app/automations');
    expect(emptyRes.status).toBe(200);
    await expect(emptyRes.json()).resolves.toEqual({ items: [] });

    const createRes = await app.request('/api/app/automations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Morning status',
        workspaceId: 'ws_demo',
        cron: '0 9 * * *',
        prompt: 'Summarize active threads',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(createRes.status).toBe(201);
    await expect(createRes.json()).resolves.toMatchObject({
      id: expect.any(String),
      name: 'Morning status',
      status: 'paused',
    });

    const listRes = await app.request('/api/app/automations');
    await expect(listRes.json()).resolves.toMatchObject({
      items: [{ name: 'Morning status', cron: '0 9 * * *' }],
    });
  });

  it('updates and deletes local automation definitions', async () => {
    const app = createApp({ store: createDemoStore() });
    const createRes = await app.request('/api/app/automations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Morning status',
        workspaceId: 'ws_demo',
        cron: '0 9 * * *',
        prompt: 'Summarize active threads',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const automation = (await createRes.json()) as { id: string };

    const enableRes = await app.request(`/api/app/automations/${automation.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'enabled' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(enableRes.status).toBe(200);
    await expect(enableRes.json()).resolves.toMatchObject({
      id: automation.id,
      status: 'enabled',
    });

    const deleteRes = await app.request(`/api/app/automations/${automation.id}`, {
      method: 'DELETE',
    });

    expect(deleteRes.status).toBe(204);

    const listRes = await app.request('/api/app/automations');
    await expect(listRes.json()).resolves.toEqual({ items: [] });
  });

  it('isolates process-local records by user even when workspace ids match', () => {
    const automationStore = new AutomationStore();
    const input = {
      cron: '0 9 * * *',
      name: 'Morning status',
      prompt: 'Summarize active threads',
      workspaceId: 'ws_shared',
    };
    const first = automationStore.createAutomation('user_first', input);
    const second = automationStore.createAutomation('user_second', input);

    expect(first.id).toMatch(
      /^auto_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(second.id).not.toBe(first.id);
    expect(automationStore.listAutomations('user_first')).toEqual([first]);
    expect(automationStore.listAutomations('user_second')).toEqual([second]);

    expect(() =>
      automationStore.updateAutomation('user_second', first.id, { status: 'enabled' })
    ).toThrow(`Automation not found: ${first.id}`);
    expect(() => automationStore.deleteAutomation('user_second', first.id)).toThrow(
      `Automation not found: ${first.id}`
    );
    expect(automationStore.listAutomations('user_first')).toEqual([first]);
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
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
      });
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
      });
      /**
       * Creates one workspace through the authenticated App API.
       *
       * @param name Workspace name.
       * @returns Created workspace identity.
       */
      const createWorkspace = async (name: string) => {
        const response = await app.request('/api/workspaces', {
          body: JSON.stringify({ name, requestId: randomUUID() }),
          headers: {
            authorization: `Bearer ${admin.secret}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        });

        expect(response.status).toBe(201);
        return (await response.json()) as { id: string };
      };
      const allowedWorkspace = await createWorkspace('Allowed');
      const deniedWorkspace = await createWorkspace('Denied');
      /**
       * Creates one process-local automation through the authenticated App API.
       *
       * @param workspaceId Target workspace id.
       * @param name Automation name.
       * @returns Created automation identity and workspace binding.
       */
      const createAutomation = async (workspaceId: string, name: string) => {
        const response = await app.request('/api/app/automations', {
          body: JSON.stringify({
            cron: '0 9 * * *',
            name,
            prompt: 'Summarize active threads',
            workspaceId,
          }),
          headers: {
            authorization: `Bearer ${admin.secret}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        });

        expect(response.status).toBe(201);
        return (await response.json()) as { id: string; workspaceId: string };
      };
      const allowedAutomation = await createAutomation(allowedWorkspace.id, 'Allowed automation');
      const deniedAutomation = await createAutomation(deniedWorkspace.id, 'Denied automation');
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: 'user_owner',
        scope: 'workspace',
        workspaceIds: [allowedWorkspace.id],
      });
      const list = await app.request('/api/app/automations', {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
      });

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toEqual({
        items: [expect.objectContaining(allowedAutomation)],
      });

      const deniedUpdate = await app.request(`/api/app/automations/${deniedAutomation.id}`, {
        body: JSON.stringify({ status: 'enabled' }),
        headers: {
          authorization: `Bearer ${workspaceToken.secret}`,
          'content-type': 'application/json',
        },
        method: 'PATCH',
      });
      const deniedDelete = await app.request(`/api/app/automations/${deniedAutomation.id}`, {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
        method: 'DELETE',
      });

      expect(deniedUpdate.status).toBe(403);
      expect(deniedDelete.status).toBe(403);
      expect(automationStore.getAutomation('user_owner', deniedAutomation.id).status).toBe(
        'paused'
      );

      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed'
           WHERE workspace_id = ? AND user_id = ?`
        )
        .run(allowedWorkspace.id, 'user_owner');
      const removed = await app.request('/api/app/automations', {
        headers: { authorization: `Bearer ${workspaceToken.secret}` },
      });

      expect(removed.status).toBe(200);
      await expect(removed.json()).resolves.toEqual({ items: [] });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
