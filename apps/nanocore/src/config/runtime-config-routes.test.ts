import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from '../auth/middleware.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './runtime-config.js';
import { registerRuntimeConfigRoutes } from './runtime-config-routes.js';

describe('runtime config routes', () => {
  it('does not mutate a foreign AgentSession when the retired restart route is absent', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-config-session-lineage-'));
    const store = createDemoStore({ dataRoot });
    const foreignWorkspace = store.createWorkspace('Foreign session workspace');
    const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign session thread');
    const foreignSession = store.createAgentSession({
      agentId: 'agent_codex_host',
      configVersion: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
      id: 'as_foreign_runtime_config',
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
      c.set('actor', { kind: 'session', userId: 'user_local' });
      c.set('workspaceAccess', {
        effectiveRole: 'owner',
        kind: 'workspace',
        policyOperation: 'turn.run',
        workspaceId: 'ws_demo',
      });
      await next();
    });
    registerRuntimeConfigRoutes({
      app,
      requestStore: () => store,
      runtimeConfigFileService: () => {
        throw new Error('Runtime config file service is not used by this test.');
      },
      runtimeConfigManager: createRuntimeConfigManager({
        initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot, version: 2 }),
      }),
    });

    const foreign = await app.request(
      `/api/app/workspaces/ws_demo/runtime-config/stale-sessions/${foreignSession.id}/restart`,
      { method: 'POST' }
    );
    const missing = await app.request(
      '/api/app/workspaces/ws_demo/runtime-config/stale-sessions/as_missing/restart',
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
  });
});
