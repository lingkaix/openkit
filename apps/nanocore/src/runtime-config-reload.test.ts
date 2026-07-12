import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

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
      "providers": [
        {
          "id": "agent-openrouter",
          "vendor": "openrouter",
          "kind": "gateway",
          "displayName": "Agent OpenRouter",
          "models": ["${model}"]
        }
      ],
      "defaults": {
        "coreProviderId": "agent-openrouter",
        "gatewayProviderId": "agent-openrouter"
      }
    }`
  );
}

describe('runtime config reload API', () => {
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

  it('marks active sessions stale after reload without interrupting them', async () => {
    const dataRoot = createConfiguredDataRoot('openai/gpt-5.1');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({
      coreDb,
      dataRoot,
      store: createDemoStore({ dataRoot }),
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-runtime-reload-repository-'));

    try {
      mkdirSync(join(repositoryPath, '.git'));
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

      writeServerConfig(dataRoot, 'openai/gpt-5.2');
      await app.request('/api/admin/config/reload', {
        method: 'POST',
        body: JSON.stringify({ mode: 'safe' }),
        headers: { 'content-type': 'application/json' },
      });

      const dashboardRes = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/dashboard'
      );
      const dashboard = (await dashboardRes.json()) as {
        activeSession: { configVersion: number | null; stale: boolean } | null;
      };

      expect(dashboard.activeSession).toMatchObject({ configVersion: 1, stale: true });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
