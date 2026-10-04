import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp, createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real HTTP and derived-client seam with explicit local Workspace authority. */
describe('automation operation projections', () => {
  it('creates, updates and deletes through the derived client, mapping bodyless success to null', async () => {
    const automationStore = new AutomationStore();
    const app = createAppWithWorkspaceAuthority({ store: createDemoStore(), automationStore });
    const responses: Response[] = [];
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async (url, init) => {
        const response = await app.request(new Request(url, init));
        responses.push(response.clone());
        return response;
      },
    });
    const record = await client.operations['automation.create']({
      workspaceId: 'ws_demo',
      name: 'Morning',
      cron: '0 9 * * *',
      prompt: 'Summarize work',
    });
    expect(responses[0]!.status).toBe(201);
    expect(automationStore.getAutomation('user_local', record.id)).toEqual(record);
    expect(
      await client.operations['automation.update']({ automationId: record.id, status: 'enabled' })
    ).toMatchObject({ status: 'enabled' });
    expect(await client.operations['automation.delete']({ automationId: record.id })).toBeNull();
    const deleted = responses.at(-1)!;
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('content-type')).toBeNull();
    expect(await deleted.text()).toBe('');
    expect(automationStore.listAutomations('user_local')).toEqual([]);
    expect(deleted.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    'list',
    'create',
    'update',
    'delete',
  ] as const)('preserves %s availability refusal when Core admits an unavailable Workspace record', async (action) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b9-absent-workspace-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_absent', ownerUserId: 'user_local' });
    const store = new FsStore({ dataRoot });
    const automationStore = new AutomationStore();
    const retained =
      action === 'create'
        ? undefined
        : automationStore.createAutomation('user_local', {
            workspaceId: 'ws_absent',
            name: 'Retained',
            cron: '*',
            prompt: 'Work',
          });
    const before = automationStore.listAutomations('user_local').map((record) => ({ ...record }));
    const app = createApp({ coreDb, dataRoot, store, automationStore });
    try {
      const input =
        action === 'list'
          ? {}
          : action === 'create'
            ? {
                workspaceId: 'ws_absent',
                name: 'Unexpected',
                cron: '*',
                prompt: 'Work',
              }
            : { automationId: retained!.id, ...(action === 'update' ? { status: 'enabled' } : {}) };
      const response = await app.request(`/api/app/operations/automation.${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(action === 'list' || action === 'create' ? 500 : 404);
      if (action === 'update' || action === 'delete') {
        await expect(response.json()).resolves.toMatchObject({
          code: `automation_${action}_failed`,
          message: 'Workspace not found: ws_absent',
        });
      } else {
        await expect(response.json()).resolves.toEqual({
          protocolVersion: '0.5.0',
          code: 'internal_error',
          message: 'Internal Server Error',
        });
      }
      expect(automationStore.listAutomations('user_local')).toEqual(before);
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
