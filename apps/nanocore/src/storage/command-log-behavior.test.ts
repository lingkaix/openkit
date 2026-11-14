import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createBetterAuth } from '../auth/better-auth.js';
import { FsStore } from '../lib/store.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const DAY = 24 * 60 * 60 * 1_000;
const SCHEMA: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Request retention',
  purpose: 'Keep named record requests distinct from new mutations.',
  collections: [
    {
      name: 'notes',
      type: 'base',
      description: 'Public-safe test records.',
      fields: [{ name: 'label', type: 'text', required: true, description: 'A short label.' }],
      indexes: [],
    },
  ],
};

afterEach(() => vi.useRealTimers());

/** Composes real local identity, HTTP admission and native stores without receipt setup. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'command-log-behavior-'));
  const handles: CoreDb[] = [];
  let coreDb = openCoreDb(root);
  handles.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const auth = createBetterAuth(coreDb, { mode: 'local', env: {} });
  for (const email of ['first@example.com', 'changed@example.com', 'second@example.com']) {
    await auth.api.signUpEmail({
      body: { name: 'Invitation fixture', email, password: 'synthetic-signup-password' },
    });
  }
  let store = await createDemoStore({ dataRoot: root, knowledge: [] });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  let app = createAppWithWorkspaceAuthority({ coreDb, store, dataRoot: root });
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    for (const handle of handles) if (handle.sqlite.open) handle.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    async addWorkspace() {
      const workspace = await store.createWorkspace('Independent command scope');
      recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
      return workspace.id;
    },
    /** Drops native and caller handles, then reconstructs HTTP from the retained root. */
    async reopen() {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      coreDb = openCoreDb(root);
      handles.push(coreDb);
      store = new FsStore({ dataRoot: root });
      app = createAppWithWorkspaceAuthority({ coreDb, store, dataRoot: root });
    },
    call(
      operation: Parameters<typeof operationRequest>[0],
      input: Record<string, unknown>,
      requestId?: string
    ) {
      return app.request(
        ...operationRequest(
          operation,
          {},
          {
            headers: requestId ? { 'x-openkit-request-id': requestId } : {},
            body: JSON.stringify(input),
          }
        )
      );
    },
  };
}

describe('command-log behavior across owner changes', () => {
  it('keeps expired App request identities through new writes and native/Core reopen', async () => {
    // Generative Kernel Data Operations: expired App metadata refuses reuse; it is not pruned.
    const f = await fixture();
    const createdApp = await f.call(
      'kernel.apps.create',
      { ...SCHEMA, workspaceId: DEMO_WORKSPACE_ID },
      randomUUID()
    );
    expect(createdApp.status, await createdApp.clone().text()).toBe(201);
    const app = (await createdApp.json()) as { appId: string; schemaRevision: number };
    const selectors = {
      workspaceId: DEMO_WORKSPACE_ID,
      appId: app.appId,
      collection: 'notes',
      schemaRevision: app.schemaRevision,
    };
    const instant = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
    const originalRequestId = randomUUID();
    const input = { ...selectors, data: { label: 'original' } };
    const first = await f.call('kernel.records.create', input, originalRequestId);
    expect(first.status, await first.clone().text()).toBe(200);
    const record = (await first.json()) as { id: string };
    const activeReplay = await f.call('kernel.records.create', input, originalRequestId);
    expect(activeReplay.status).toBe(200);
    expect((await activeReplay.json()).id).toBe(record.id);

    vi.setSystemTime(instant + 8 * DAY);
    // A distinct successful write exercises ordinary post-command expiry maintenance.
    const fresh = await f.call(
      'kernel.records.create',
      { ...selectors, data: { label: 'fresh' } },
      randomUUID()
    );
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    await f.reopen();
    for (const data of [{ label: 'original' }, { label: 'must not execute' }]) {
      const reused = await f.call(
        'kernel.records.create',
        { ...selectors, data },
        originalRequestId
      );
      expect(reused.status).toBe(409);
      await expect(reused.json()).resolves.toMatchObject({ code: 'recovery_required' });
    }
    const listed = await f.call('kernel.records.list', selectors);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const records = await listed.json();
    expect(records.totalItems).toBe(2);
    expect(
      records.items.map((item: { data: { label: string } }) => item.data.label).sort()
    ).toEqual(['fresh', 'original']);
  }, 60_000);
});
