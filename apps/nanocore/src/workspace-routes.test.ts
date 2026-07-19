import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ListWorkspacesResponseSchema } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from './auth/middleware.js';
import { FsStore } from './lib/store.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';

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
});
