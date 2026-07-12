import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListAgentCatalogResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

describe('agent catalog routes', () => {
  it('limits global catalog reads to workspaces visible to scoped tokens', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-catalog-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot, userId: 'user_local' });
    const allowedWorkspace = store.createWorkspace('Allowed agents');
    const deniedWorkspace = store.createWorkspace('Denied agents');

    for (const workspace of [allowedWorkspace, deniedWorkspace]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
    }
    store.upsertAgent(allowedWorkspace.id, {
      ...store.getAgent(allowedWorkspace.id, 'agent_codex_host'),
      id: 'agent_allowed_only',
      name: 'Allowed Agent',
    });
    store.upsertAgent(deniedWorkspace.id, {
      ...store.getAgent(deniedWorkspace.id, 'agent_codex_host'),
      id: 'agent_denied_only',
      name: 'Denied Agent',
    });
    const serverAdmin = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const workspace = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [allowedWorkspace.id],
    });
    const readonly = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: [allowedWorkspace.id],
    });
    const app = createApp({
      auth: {
        api: { getSession: async () => null },
        handler: async () => new Response(null, { status: 404 }),
      },
      coreDb,
      dataRoot,
      mode: 'server',
      storeFactory: () => store,
    });

    try {
      const adminHeaders = { authorization: `Bearer ${serverAdmin.secret}` };
      const adminList = await app.request('/api/app/agents', { headers: adminHeaders });
      const adminListBody = ListAgentCatalogResponseSchema.parse(await adminList.json());
      const adminDetail = await app.request('/api/app/agents/agent_denied_only', {
        headers: adminHeaders,
      });

      expect(adminList.status).toBe(200);
      expect(adminListBody.items.map((agent) => agent.id)).toEqual(
        expect.arrayContaining(['agent_allowed_only', 'agent_denied_only'])
      );
      expect(adminDetail.status).toBe(200);

      for (const token of [workspace, readonly]) {
        const headers = { authorization: `Bearer ${token.secret}` };
        const list = await app.request('/api/app/agents', { headers });
        const listBody = ListAgentCatalogResponseSchema.parse(await list.json());
        const allowedDetail = await app.request('/api/app/agents/agent_allowed_only', { headers });
        const deniedDetail = await app.request('/api/app/agents/agent_denied_only', { headers });
        const missingDetail = await app.request('/api/app/agents/agent_missing', { headers });

        expect(list.status).toBe(200);
        expect(listBody.items.map((agent) => agent.id)).toContain('agent_allowed_only');
        expect(listBody.items.map((agent) => agent.id)).not.toContain('agent_denied_only');
        expect(allowedDetail.status).toBe(200);
        expect(deniedDetail.status).toBe(missingDetail.status);
      }

      coreDb.sqlite
        .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .run(allowedWorkspace.id, 'user_local');

      for (const token of [workspace, readonly]) {
        const headers = { authorization: `Bearer ${token.secret}` };
        const list = await app.request('/api/app/agents', { headers });
        const detail = await app.request('/api/app/agents/agent_allowed_only', { headers });
        const missing = await app.request('/api/app/agents/agent_missing', { headers });

        expect(list.status).toBe(200);
        await expect(list.json()).resolves.toMatchObject({ items: [] });
        expect(detail.status).toBe(missing.status);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});
