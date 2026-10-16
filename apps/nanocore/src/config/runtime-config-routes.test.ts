import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from '../auth/middleware.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './runtime-config.js';

describe('canonical runtime configuration registration', () => {
  it('does not mutate a foreign AgentSession when the retired restart route is absent', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-config-session-lineage-'));
    const store = createDemoStore({ dataRoot });
    const foreignWorkspace = store.createWorkspace('Foreign session workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign session thread');
    const foreignSession = store.createAgentSession({
      agentId: 'agent_codex_host',
      configVersion: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
      id: 'as_00000000-0000-74d0-b1a2-1989a12cdcb5',
      message: null,
      status: 'busy',
      threadId: foreignThread.id,
      updatedAt: '2026-07-19T00:00:00.000Z',
      workspaceId: foreignWorkspace.id,
      workspaceRoots: [],
    });
    const updateAgentSession = vi.spyOn(store, 'updateAgentSession');
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' });
      c.set('workspaceAccess', {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      await next();
    });
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    registerOperationJsonRoutes({
      app,
      requestStore: () => store,
      coreDb,
      runtimeConfigOperations: {
        filesForActor: () => {
          throw new Error('Runtime config file service is not used by this test.');
        },
        manager: createRuntimeConfigManager({
          initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot, version: 2 }),
        }),
      },
    });

    const foreign = await app.request(
      `/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/runtime-config/stale-sessions/${foreignSession.id}/restart`,
      { method: 'POST' }
    );
    const missing = await app.request(
      '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/runtime-config/stale-sessions/as_00000000-0000-7fdd-8f71-4a23eb7a922b/restart',
      { method: 'POST' }
    );

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(updateAgentSession).not.toHaveBeenCalled();
    expect(store.getAgentSession(foreignSession.id)).toMatchObject({
      configVersion: 1,
      status: 'busy',
      workspaceId: foreignWorkspace.id,
    });
    coreDb.sqlite.close();
  });
});
