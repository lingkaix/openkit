import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ListAuthorizedWorkspacesResponseSchema,
  WorkspaceReadResponseSchema,
} from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { runtimePolicyIdentityForSnapshot } from './storage/runtime-policy-publication.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { createTestStore } from './test-support/store.js';
import {
  ensureUserQuickChatWorkspace,
  recordWorkspaceOwnerMembership,
} from './workspace-membership.js';

const ownedDatabases: Array<ReturnType<typeof openCoreDb>> = [];
afterEach(() => {
  for (const coreDb of ownedDatabases.splice(0)) coreDb.sqlite.close();
});

const HIDDEN_PRIVATE_TITLE = 'SECRET_OTHER_PRIVATE_THREAD';

/**
 * Registers workspace routes with one authenticated member actor.
 *
 * @param store Product store under test.
 * @param workspaceId Authorized Workspace id.
 * @param userId Viewer whose private Threads should remain counted.
 * @returns Hono app serving workspace list and direct read.
 */
describe('workspace routes', () => {
  it('publishes concurrent creations, name updates and lazy personal provisioning through the runtime owner', async () => {
    const store = createTestStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-publication-')),
    });
    const coreDb = openCoreDb(store.getDataRoot()!);
    ownedDatabases.push(coreDb);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const manager = createRuntimeConfigManager({ dataRoot: store.getDataRoot() });
    const app = createApp({ coreDb, store, runtimeConfigManager: manager });
    const created = await Promise.all(
      ['First', 'Second'].map(async (name) => {
        const response = await app.request(
          ...operationRequest(
            'workspace.create',
            { name },
            {
              headers: { 'x-openkit-request-id': randomUUID() },
            }
          )
        );
        expect(response.status, await response.clone().text()).toBe(201);
        return (await response.json()) as { id: string; name: string };
      })
    );
    for (const workspace of created) {
      expect(
        manager.current().workspaceConfigs.find((entry) => entry.workspaceId === workspace.id)
          ?.config.workspace.name
      ).toBe(workspace.name);
    }
    const updated = await app.request(
      ...operationRequest(
        'workspace.update',
        { workspaceId: created[0]!.id, name: 'Renamed' },
        {
          headers: { 'x-openkit-request-id': randomUUID() },
        }
      )
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(
      manager.current().workspaceConfigs.find((entry) => entry.workspaceId === created[0]!.id)
        ?.config.workspace.name
    ).toBe('Renamed');
    await ensureUserQuickChatWorkspace({ coreDb, store, userId });
    expect(manager.current().workspaceConfigs).toHaveLength(3);
    await ensureUserQuickChatWorkspace({ coreDb, store, userId });
    expect(manager.current().workspaceConfigs).toHaveLength(3);
    const publication = await getControlStoreWorkerClient().runtimePolicyPublication(coreDb, {
      kind: 'inspect',
    });
    expect(publication).toMatchObject({
      state: 'active',
      identity: runtimePolicyIdentityForSnapshot(manager.current()),
    });
  });

  it('reacknowledges the installed Workspace after an activation acknowledgement fails', async () => {
    const store = createTestStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-publication-retry-')),
    });
    const coreDb = openCoreDb(store.getDataRoot()!);
    ownedDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const manager = createRuntimeConfigManager({ dataRoot: store.getDataRoot() });
    await manager.bindNativePolicyPublication(coreDb);
    const workspace = await store.createWorkspace('Committed before acknowledgement');
    const client = getControlStoreWorkerClient();
    const publish = client.runtimePolicyPublication.bind(client);
    const fault = vi
      .spyOn(client, 'runtimePolicyPublication')
      .mockImplementation(async (...args) => {
        if (args[1].kind === 'activate')
          throw new Error('Controlled activation acknowledgement failure.');
        return publish(...args);
      });
    try {
      await expect(
        manager.publishWorkspaceConfiguration(workspace.id, workspace.name)
      ).rejects.toThrow('Controlled activation acknowledgement failure.');
      expect(
        manager.current().workspaceConfigs.some((entry) => entry.workspaceId === workspace.id)
      ).toBe(true);
      expect(await publish(coreDb, { kind: 'inspect' })).toMatchObject({ state: 'closed' });
    } finally {
      fault.mockRestore();
    }
    await manager.publishWorkspaceConfiguration(workspace.id, workspace.name);
    expect(await publish(coreDb, { kind: 'inspect' })).toMatchObject({
      state: 'active',
      identity: runtimePolicyIdentityForSnapshot(manager.current()),
    });
  });

  it('lists only authorized Workspace ids without physical discovery', async () => {
    const store = createTestStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-routes-authorized-')),
    });
    const allowedWorkspace = await store.createWorkspace('Allowed Workspace');
    // The canonical authority and Notebook content must belong to the same deployment root.
    const coreDb = openCoreDb(store.getDataRoot()!);
    ownedDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    await ensureUserQuickChatWorkspace({
      coreDb,
      store,
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: allowedWorkspace.id,
    });
    const app = createApp({ coreDb, store });
    await store.createWorkspace('Denied Workspace');
    const listWorkspaces = vi.spyOn(store, 'listWorkspaces').mockImplementation(() => {
      throw new Error('Workspace listing must not discover physical Workspaces.');
    });

    const response = await app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = ListAuthorizedWorkspacesResponseSchema.parse(await response.json());
    expect(body.items.map((entry) => entry.workspace.id).sort()).toEqual(
      [allowedWorkspace.id, 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28'].sort()
    );
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('keeps authorized collection records intact while direct Workspace reads count only the member audience', async () => {
    const store = createTestStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-thread-counts-')),
    });
    const workspace = await store.createWorkspace('Counted Workspace');
    await store.createThread(workspace.id, 'own-private', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    await store.createThread(workspace.id, HIDDEN_PRIVATE_TITLE, undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-76a2-91eb-629d90835e80',
    });
    await store.createThread(workspace.id, 'shared-work', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const coreDb = openCoreDb(store.getDataRoot()!);
    ownedDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: workspace.id,
    });
    const app = createApp({
      coreDb,
      store,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({ user: { id: 'usr_00000000-0000-7000-8000-000000000001' } }),
        },
        handler: async () => new Response(null, { status: 404 }),
      },
    });

    const listResponse = await app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const listBody = ListAuthorizedWorkspacesResponseSchema.parse(await listResponse.json());
    const directResponse = await app.request(
      ...operationRequest('workspace.read', { workspaceId: workspace.id })
    );
    const directBody = WorkspaceReadResponseSchema.parse(await directResponse.json());
    expect(directBody).toMatchObject({
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      membershipStatus: 'active',
      accessCause: 'membership',
    });

    expect(store.getWorkspace(workspace.id).counts.threadCount).toBe(3);
    expect(listResponse.status).toBe(200);
    expect(directResponse.status).toBe(200);
    expect(
      listBody.items
        .filter((entry) => entry.workspace.id === workspace.id)
        .map((entry) => entry.workspace)
    ).toEqual([
      expect.objectContaining({
        id: workspace.id,
        counts: expect.objectContaining({ threadCount: 3 }),
      }),
    ]);
    expect(directBody.counts.threadCount).toBe(2);
    expect(JSON.stringify(listBody)).not.toContain(HIDDEN_PRIVATE_TITLE);
    expect(JSON.stringify(directBody)).not.toContain(HIDDEN_PRIVATE_TITLE);
  });
});
