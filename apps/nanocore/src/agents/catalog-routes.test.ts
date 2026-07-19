import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListAgentCatalogResponseSchema } from '@openkit/app-api-schemas';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { registerAgentCatalogRoutes } from './catalog-routes.js';

describe('agent catalog routes', () => {
  it('opens only the authorized Workspace ids', async () => {
    const store = new FsStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-agent-catalog-authorized-')),
    });
    const allowedWorkspace = store.createWorkspace('Allowed agents');
    const deniedWorkspace = store.createWorkspace('Denied agents');
    const catalogAgent = {
      capabilities: [],
      defaultProfileId: null,
      health: { checkedAt: null, message: null, status: 'unknown' as const },
      kind: 'coder' as const,
      modelId: null,
      profiles: [],
      sandboxSummary: null,
      skillIds: [],
      status: 'enabled' as const,
    };
    store.upsertAgent(allowedWorkspace.id, {
      ...catalogAgent,
      id: 'agent_allowed_only',
      name: 'Allowed Agent',
    });
    store.upsertAgent(deniedWorkspace.id, {
      ...catalogAgent,
      id: 'agent_denied_only',
      name: 'Denied Agent',
    });
    const listWorkspaces = vi.spyOn(store, 'listWorkspaces').mockImplementation(() => {
      throw new Error('Agent catalog must not discover physical Workspaces.');
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    registerAgentCatalogRoutes({
      app,
      authorizedWorkspaceIds: () => [allowedWorkspace.id],
      requestStore: () => store,
    });

    const list = await app.request('/api/app/agents');
    const listBody = ListAgentCatalogResponseSchema.parse(await list.json());
    const allowedDetail = await app.request('/api/app/agents/agent_allowed_only');
    const deniedDetail = await app.request('/api/app/agents/agent_denied_only');

    expect(list.status).toBe(200);
    expect(listBody.items.map((agent) => agent.id)).toEqual(['agent_allowed_only']);
    expect(allowedDetail.status).toBe(200);
    expect(deniedDetail.status).toBe(404);
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('limits global catalog reads to workspaces visible to scoped tokens', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-catalog-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const allowedWorkspace = store.createWorkspace('Allowed agents');
    const deniedWorkspace = store.createWorkspace('Denied agents');

    for (const workspace of [allowedWorkspace, deniedWorkspace]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
    }
    const catalogAgent = {
      capabilities: [],
      defaultProfileId: null,
      health: { checkedAt: null, message: null, status: 'unknown' as const },
      kind: 'coder' as const,
      modelId: null,
      profiles: [],
      sandboxSummary: null,
      skillIds: [],
      status: 'enabled' as const,
    };
    store.upsertAgent(allowedWorkspace.id, {
      ...catalogAgent,
      id: 'agent_allowed_only',
      name: 'Allowed Agent',
    });
    store.upsertAgent(deniedWorkspace.id, {
      ...catalogAgent,
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
      store,
    });

    try {
      const adminHeaders = { authorization: `Bearer ${serverAdmin.secret}` };
      const adminList = await app.request('/api/app/agents', { headers: adminHeaders });
      const adminDetail = await app.request('/api/app/agents/agent_denied_only', {
        headers: adminHeaders,
      });

      expect(adminList.status).toBe(403);
      expect(await adminList.text()).not.toContain('agent_denied_only');
      expect(adminDetail.status).toBe(403);

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

      const transferredAt = new Date().toISOString();
      coreDb.sqlite.transaction(() => {
        coreDb.sqlite
          .prepare(
            `INSERT INTO users
              (id, display_name, email, email_verified, created_at, updated_at, kind)
             VALUES ('user_replacement_owner', 'Replacement Owner',
                     'catalog-replacement@example.com', false, ?, ?, 'human')`
          )
          .run(Date.now(), Date.now());
        coreDb.sqlite
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, status, access_level, invitation_id,
              joined_at, removed_at, revision, created_at, updated_at
            ) VALUES (?, 'user_replacement_owner', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
          )
          .run(allowedWorkspace.id, transferredAt, transferredAt, transferredAt);
        coreDb.sqlite
          .prepare(
            `UPDATE workspace_registry
             SET owner_user_id = 'user_replacement_owner', revision = revision + 1, updated_at = ?
             WHERE workspace_id = ?`
          )
          .run(transferredAt, allowedWorkspace.id);
        coreDb.sqlite
          .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .run(allowedWorkspace.id, 'user_local');
      })();

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
