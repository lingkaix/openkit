import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ListWorkspacesResponseSchema, WorkspaceRecordSchema } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from './auth/middleware.js';
import { FsStore } from './lib/store.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';

const HIDDEN_PRIVATE_TITLE = 'SECRET_OTHER_PRIVATE_THREAD';

/**
 * Registers workspace routes with one authenticated member actor.
 *
 * @param store Product store under test.
 * @param workspaceId Authorized Workspace id.
 * @param userId Viewer whose private Threads should remain counted.
 * @returns Hono app serving workspace list and direct read.
 */
function createMemberWorkspaceApp(store: FsStore, workspaceId: string, userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('actor', { kind: 'session', userId });
    await next();
  });
  registerWorkspaceRoutes({
    app,
    authorizedWorkspaceIds: () => [workspaceId],
    coreDb: undefined,
    inflightCommands: new WeakMap(),
    requestStore: () => store,
  });
  return app;
}

describe('workspace routes', () => {
  it('lists only authorized Workspace ids without physical discovery', async () => {
    const store = new FsStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-routes-authorized-')),
    });
    const allowedWorkspace = store.createWorkspace('Allowed Workspace');
    store.createWorkspace('Denied Workspace');
    const listWorkspaces = vi.spyOn(store, 'listWorkspaces').mockImplementation(() => {
      throw new Error('Workspace listing must not discover physical Workspaces.');
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    registerWorkspaceRoutes({
      app,
      authorizedWorkspaceIds: () => [allowedWorkspace.id],
      coreDb: undefined,
      inflightCommands: new WeakMap(),
      requestStore: () => store,
    });

    const response = await app.request('/api/workspaces');
    const body = ListWorkspacesResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.items.map((workspace) => workspace.id)).toEqual([allowedWorkspace.id]);
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('counts a member own private and shared Threads and excludes another private Thread on list and direct read', async () => {
    const store = new FsStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-workspace-thread-counts-')),
    });
    const workspace = store.createWorkspace('Counted Workspace');
    store.createThread(workspace.id, 'own-private', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_member',
    });
    store.createThread(workspace.id, HIDDEN_PRIVATE_TITLE, undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_outsider',
    });
    store.createThread(workspace.id, 'shared-work', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const app = createMemberWorkspaceApp(store, workspace.id, 'user_member');

    const listResponse = await app.request('/api/workspaces');
    const listBody = ListWorkspacesResponseSchema.parse(await listResponse.json());
    const directResponse = await app.request(`/api/workspaces/${workspace.id}`);
    const directBody = WorkspaceRecordSchema.parse(await directResponse.json());

    expect(store.getWorkspace(workspace.id).counts.threadCount).toBe(3);
    expect(listResponse.status).toBe(200);
    expect(directResponse.status).toBe(200);
    expect(listBody.items).toEqual([
      expect.objectContaining({
        id: workspace.id,
        counts: expect.objectContaining({ threadCount: 2 }),
      }),
    ]);
    expect(directBody.counts.threadCount).toBe(2);
    expect(JSON.stringify(listBody)).not.toContain(HIDDEN_PRIVATE_TITLE);
    expect(JSON.stringify(directBody)).not.toContain(HIDDEN_PRIVATE_TITLE);
  });
});
