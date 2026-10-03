import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListAuthorizedWorkspacesResponseSchema } from '@openkit/app-api-schemas';
import { WorkspaceRecordSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp, createAppWithWorkspaceAuthority } from './test-support/app.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

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
  it('lists only authorized Workspace ids without physical discovery', async () => {
    const store = new FsStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-routes-authorized-')),
    });
    const allowedWorkspace = store.createWorkspace('Allowed Workspace');
    const app = createAppWithWorkspaceAuthority({ store });
    store.createWorkspace('Denied Workspace');
    const listWorkspaces = vi.spyOn(store, 'listWorkspaces').mockImplementation(() => {
      throw new Error('Workspace listing must not discover physical Workspaces.');
    });

    const response = await app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = ListAuthorizedWorkspacesResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.items.map((entry) => entry.workspace.id).sort()).toEqual(
      [allowedWorkspace.id, 'ws_quick_chat'].sort()
    );
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('keeps authorized collection records intact while direct Workspace reads count only the member audience', async () => {
    const store = new FsStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-thread-counts-')),
    });
    const workspace = store.createWorkspace('Counted Workspace');
    store.createThread(workspace.id, 'own-private', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_local',
    });
    store.createThread(workspace.id, HIDDEN_PRIVATE_TITLE, undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_outsider',
    });
    store.createThread(workspace.id, 'shared-work', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const coreDb = openCoreDb(store.getDataRoot()!);
    ownedDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const app = createApp({
      coreDb,
      store,
      mode: 'server',
      auth: {
        api: { getSession: async () => ({ user: { id: 'user_local' } }) },
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
    const directBody = WorkspaceRecordSchema.parse(await directResponse.json());

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
