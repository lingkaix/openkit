import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentHealthRefreshResponseSchema,
  GetAgentCatalogEntryResponseSchema,
  ListAgentCatalogResponseSchema,
} from '@openkit/app-api-schemas';
import { WorkspaceResourcesResponseSchema } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { projectAgentCatalogEntries } from './catalog-projection.js';
import { registerAgentCatalogRoutes } from './catalog-routes.js';

describe('agent catalog routes', () => {
  it('opens only the authorized Workspace ids', async () => {
    const store = new FsStore({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-agent-catalog-authorized-')),
    });
    const allowedWorkspace = store.createWorkspace('Allowed agents');
    const deniedWorkspace = store.createWorkspace('Denied agents');
    store.setWorkspaceAgentCatalogProjection(() =>
      projectAgentCatalogEntries([
        createTestAgentSetup({
          agentId: 'agent_allowed_only',
          displayName: 'Allowed Agent',
        }).manifest,
      ])
    );
    store.upsertAgent(deniedWorkspace.id, {
      capabilities: [],
      defaultProfileId: null,
      health: { checkedAt: null, message: null, status: 'unknown' as const },
      id: 'agent_denied_only',
      kind: 'coder',
      modelId: null,
      name: 'Denied Agent',
      profiles: [],
      sandboxSummary: null,
      skillIds: [],
      status: 'enabled',
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
    const allowedManifest = createTestAgentSetup({
      agentId: 'agent_allowed_only',
      displayName: 'Allowed Agent',
    }).manifest;
    const otherManifest = createTestAgentSetup({
      agentId: 'agent_other_supply',
      displayName: 'Other Supply',
    }).manifest;
    store.upsertAgent(deniedWorkspace.id, {
      capabilities: [],
      defaultProfileId: null,
      health: { checkedAt: null, message: null, status: 'unknown' },
      id: 'agent_denied_only',
      kind: 'coder',
      modelId: null,
      name: 'Denied Agent',
      profiles: [],
      sandboxSummary: null,
      skillIds: [],
      status: 'enabled',
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
      agentManifests: [allowedManifest, otherManifest],
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
      const adminMissing = await app.request('/api/app/agents/agent_missing', {
        headers: adminHeaders,
      });
      const adminListBody = ListAgentCatalogResponseSchema.parse(await adminList.json());

      expect(adminList.status).toBe(200);
      expect(adminListBody.items.map((agent) => agent.id).sort()).toEqual([
        'agent_allowed_only',
        'agent_other_supply',
      ]);
      expect(adminDetail.status).toBe(adminMissing.status);

      for (const token of [workspace, readonly]) {
        const headers = { authorization: `Bearer ${token.secret}` };
        const list = await app.request('/api/app/agents', { headers });
        const listBody = ListAgentCatalogResponseSchema.parse(await list.json());
        const allowedDetail = await app.request('/api/app/agents/agent_allowed_only', { headers });
        const otherDetail = await app.request('/api/app/agents/agent_other_supply', { headers });
        const deniedDetail = await app.request('/api/app/agents/agent_denied_only', { headers });
        const missingDetail = await app.request('/api/app/agents/agent_missing', { headers });
        const allowedResources = await app.request(
          `/api/workspaces/${allowedWorkspace.id}/resources`,
          { headers }
        );
        const deniedResources = await app.request(
          `/api/workspaces/${deniedWorkspace.id}/resources`,
          { headers }
        );

        expect(list.status).toBe(200);
        expect(listBody.items.map((agent) => agent.id).sort()).toEqual([
          'agent_allowed_only',
          'agent_other_supply',
        ]);
        expect(allowedDetail.status).toBe(200);
        expect(otherDetail.status).toBe(200);
        expect(deniedDetail.status).toBe(missingDetail.status);
        expect(allowedResources.status).toBe(200);
        expect(deniedResources.status).toBe(403);
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

  it('projects current server manifests into Workspace resources, catalog, and health refresh', async () => {
    const secretEnv = 'sk-test-catalog-must-not-leak';
    const configured = createTestAgentSetup({
      agentId: 'agent_configured',
      displayName: 'Configured Worker',
    }).manifest;
    const unready = {
      ...createTestAgentSetup({
        adapter: 'opencode',
        agentId: 'agent_unready',
        displayName: 'Unready Worker',
      }).manifest,
      readiness: {
        message: 'export TOKEN=sk-leak; /usr/local/bin/opencode --cwd /secret/path',
        status: 'unknown' as const,
      },
      workspace: { env: { OPENAI_API_KEY: secretEnv } },
    };
    const store = createDemoStore();
    store.upsertAgent('ws_demo', {
      capabilities: [],
      defaultProfileId: null,
      health: { checkedAt: null, message: null, status: 'unknown' },
      id: 'agent_persisted_only',
      kind: 'coder',
      modelId: null,
      name: 'Persisted Only',
      profiles: [],
      sandboxSummary: null,
      skillIds: [],
      status: 'enabled',
    });
    const app = createApp({
      agentManifests: [configured, unready],
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });

    const resourcesRes = await app.request('/api/workspaces/ws_demo/resources');
    const listRes = await app.request('/api/app/agents');
    const configuredDetailRes = await app.request('/api/app/agents/agent_configured');
    const unreadyDetailRes = await app.request('/api/app/agents/agent_unready');
    const persistedDetailRes = await app.request('/api/app/agents/agent_persisted_only');
    const healthRes = await app.request('/api/app/workspaces/ws_demo/agents/health/refresh', {
      method: 'POST',
    });
    const resources = WorkspaceResourcesResponseSchema.parse(await resourcesRes.json());
    const list = ListAgentCatalogResponseSchema.parse(await listRes.json());
    const configuredDetail = GetAgentCatalogEntryResponseSchema.parse(
      await configuredDetailRes.json()
    );
    const unreadyDetail = GetAgentCatalogEntryResponseSchema.parse(await unreadyDetailRes.json());
    const health = AgentHealthRefreshResponseSchema.parse(await healthRes.json());
    const publicJson = JSON.stringify({
      configuredDetail,
      health,
      list,
      resources: resources.agents,
      unreadyDetail,
    });

    expect(resourcesRes.status).toBe(200);
    expect(listRes.status).toBe(200);
    expect(configuredDetailRes.status).toBe(200);
    expect(unreadyDetailRes.status).toBe(200);
    expect(persistedDetailRes.status).toBe(404);
    expect(healthRes.status).toBe(200);
    expect(resources.agents.map((agent) => agent.id).sort()).toEqual([
      'agent_configured',
      'agent_unready',
    ]);
    expect(list.items.map((agent) => agent.id).sort()).toEqual([
      'agent_configured',
      'agent_unready',
    ]);
    expect(configuredDetail).toMatchObject({
      id: 'agent_configured',
      kind: null,
      name: 'Configured Worker',
      status: 'enabled',
    });
    expect(configuredDetail.kind).not.toBe(configured.runtime.kind);
    expect(unreadyDetail).toMatchObject({
      health: { checkedAt: null, message: null, status: 'unknown' },
      id: 'agent_unready',
      kind: null,
      name: 'Unready Worker',
      status: 'enabled',
    });
    expect(health.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'agent_configured',
          checkedAt: expect.any(String),
          status: 'unknown',
        }),
        expect.objectContaining({
          agentId: 'agent_unready',
          checkedAt: expect.any(String),
          status: 'unknown',
        }),
      ])
    );
    expect(health.items.map((item) => item.agentId).sort()).toEqual([
      'agent_configured',
      'agent_unready',
    ]);
    expect(health.items.map((item) => item.message)).toEqual([null, null]);
    expect(health.items.map((item) => item.status)).toEqual(['unknown', 'unknown']);
    expect(
      resources.agents.every(
        (agent) =>
          agent.health.status === 'unknown' &&
          agent.health.checkedAt === null &&
          agent.health.message === null
      )
    ).toBe(true);
    expect(publicJson).not.toContain(secretEnv);
    expect(publicJson).not.toContain('/usr/local/bin');
    expect(publicJson).not.toContain('"config"');
    expect(publicJson).not.toContain('sk-leak');
  });
});
