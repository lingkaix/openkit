import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { ProviderRegistry } from './providers/registry.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { seedWritableGitRepository } from './test-support/git-repository.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates a temporary NanoCore data root with one runtime config.
 *
 * @param model Provider model id.
 * @returns Temporary data root path.
 */
function createConfiguredDataRoot(model: string): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-reload-api-'));

  writeServerConfig(dataRoot, model);

  return dataRoot;
}

/**
 * Writes the canonical server config used by reload API tests.
 *
 * @param dataRoot Data root that owns the config file.
 * @param model Provider model id.
 */
function writeServerConfig(dataRoot: string, model: string): void {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'server.jsonc'),
    `{
      "schemaVersion": 1,
      "defaults": {
        "defaultAgentId": "agent_codex_host"
      }
    }`
  );
  const providersRoot = join(dataRoot, 'config', 'providers');
  mkdirSync(providersRoot, { recursive: true });
  writeFileSync(
    join(providersRoot, 'agent-openrouter.provider.jsonc'),
    JSON.stringify({
      id: 'agent-openrouter',
      vendor: 'openrouter',
      kind: 'gateway',
      displayName: `Agent OpenRouter ${model}`,
      models: ['openai/gpt-5.1'],
    })
  );
  const gatewayPath = join(dataRoot, 'config', 'gateway.jsonc');
  if (!existsSync(gatewayPath))
    writeFileSync(
      gatewayPath,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            routes: [
              { id: 'primary', providerProfileId: 'agent-openrouter', providerModel: model },
            ],
          },
        ],
        requiredFeatures: [],
      })
    );
}

describe('runtime config reload API', () => {
  it('hydrates the joined Workspace name after an accepted config reload', async () => {
    const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
    const store = createDemoStore({ dataRoot });
    const workspaceConfigPath = join(
      dataRoot,
      'workspaces',
      'ws_demo',
      'config',
      'workspace.jsonc'
    );
    const app = createApp({ dataRoot, store, turnExecutor: new SimulatedTurnExecutor() });

    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Reloaded Workspace', defaultAgentId: null },
      })
    );
    const response = await app.request('/api/admin/config/reload', {
      method: 'POST',
      body: JSON.stringify({ mode: 'safe' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(store.getWorkspace('ws_demo').name).toBe('Reloaded Workspace');
  });

  it('keeps provider changes pending restart and exposes the live runtime status', async () => {
    const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
    const app = createApp({ dataRoot, turnExecutor: new SimulatedTurnExecutor() });

    writeServerConfig(dataRoot, 'openai/gpt-5.2');
    const reloadRes = await app.request('/api/admin/config/reload', {
      method: 'POST',
      body: JSON.stringify({ mode: 'safe' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(reloadRes.status).toBe(200);
    const reload = (await reloadRes.json()) as {
      runtimeConfig: { currentVersion: number; pendingRestart: Array<{ path: string }> };
      plan: { applied: Array<{ path: string }>; requiresRestart: Array<{ path: string }> };
    };

    expect(reload.runtimeConfig.currentVersion).toBe(2);
    expect(reload.plan.applied).toEqual([]);
    expect(reload.plan.requiresRestart).toEqual([expect.objectContaining({ path: 'providers' })]);
    expect(reload.runtimeConfig.pendingRestart).toEqual([
      expect.objectContaining({ path: 'providers' }),
    ]);

    const diagnosticsRes = await app.request('/api/app/diagnostics');
    const diagnostics = (await diagnosticsRes.json()) as {
      runtimeConfig: { currentVersion: number };
      providers: { registry: Array<{ id: string; models: string[] }> };
    };

    expect(diagnostics.runtimeConfig.currentVersion).toBe(2);
    expect(diagnostics.providers.registry[0]?.models).toContain('openai/gpt-5.1');
  });

  it('keeps the active AgentSession suspended across a restart-required provider reload', async () => {
    const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const store = createDemoStore({ dataRoot });
    const agentSetup = createTestAgentSetup({
      logicalModelId: 'reasoning',
      privateRoute: {
        providerProfileId: 'agent-openrouter',
        providerModel: 'openai/gpt-5.1',
      },
    });
    const app = createApp({
      agentManifests: [agentSetup.manifest],
      coreDb,
      dataRoot,
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            routes: [
              {
                id: 'primary',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.1',
              },
            ],
          },
        ],
        requiredFeatures: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.1',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.1'],
          vendor: 'openrouter',
        },
      ]),
      store,
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-runtime-reload-repository-'));

    try {
      seedWritableGitRepository(repositoryPath);
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Runtime reload repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const turnRes = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000301',
          input: 'Run with version one',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = (await turnRes.json()) as { configVersion: number };

      expect(turn.configVersion, JSON.stringify(turn)).toBe(1);
      expect(turn).not.toHaveProperty('agentSessionId');
      const sessionsBeforeReload = store.listThreadAgentSessions('ws_demo', 'th_demo');
      expect(sessionsBeforeReload).toEqual([
        expect.objectContaining({ configVersion: 1, stale: false, status: 'suspended' }),
      ]);

      writeServerConfig(dataRoot, 'openai/gpt-5.2');
      const reloadRes = await app.request('/api/admin/config/reload', {
        method: 'POST',
        body: JSON.stringify({ mode: 'safe' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(reloadRes.status).toBe(200);
      const reload = (await reloadRes.json()) as {
        runtimeConfig: { pendingRestart: Array<{ path: string }> };
        plan: { requiresRestart: Array<{ path: string }> };
      };
      expect(reload.plan.requiresRestart).toContainEqual(
        expect.objectContaining({ path: 'providers' })
      );
      expect(reload.runtimeConfig.pendingRestart).toContainEqual(
        expect.objectContaining({ path: 'providers' })
      );

      const dashboardRes = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/dashboard'
      );
      const dashboard = await dashboardRes.json();
      const sessionsAfterReload = store.listThreadAgentSessions('ws_demo', 'th_demo');

      expect(dashboardRes.status, JSON.stringify(dashboard)).toBe(200);
      expect(JSON.stringify(dashboard)).not.toMatch(/agentSession/i);
      expect(sessionsAfterReload).toEqual(sessionsBeforeReload);
      expect(
        store.listThreadTurns('ws_demo', 'th_demo').some((item) => item.status === 'interrupted')
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
