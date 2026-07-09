import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createRuntimeConfigManager,
  createRuntimeConfigStaleSession,
  diffRuntimeConfig,
  loadRuntimeConfig,
} from './runtime-config.js';

/**
 * Creates a temporary NanoCore data root for runtime config tests.
 *
 * @returns Temporary data root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-runtime-config-'));
}

/**
 * Writes one server config file to a data root.
 *
 * @param dataRoot Data root that owns the config directory.
 * @param body JSONC body to write.
 */
function writeServerConfig(dataRoot: string, body: string): void {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'server.jsonc'), body);
}

/**
 * Writes one workspace config file to the canonical user-owned workspace path.
 *
 * @param dataRoot Data root that owns the user workspace tree.
 * @param workspaceId Workspace id to configure.
 * @param body JSONC body to write.
 */
function writeWorkspaceConfig(dataRoot: string, workspaceId: string, body: string): void {
  const configRoot = join(dataRoot, 'users', 'user_local', 'workspaces', workspaceId, 'config');

  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'workspace.jsonc'), body);
}

/**
 * Writes one workspace data source catalog to the canonical workspace config path.
 *
 * @param dataRoot Data root that owns the user workspace tree.
 * @param workspaceId Workspace id to configure.
 * @param body JSONC body to write.
 */
function writeWorkspaceDataSources(dataRoot: string, workspaceId: string, body: string): void {
  const configRoot = join(dataRoot, 'users', 'user_local', 'workspaces', workspaceId, 'config');

  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'data-sources.jsonc'), body);
}

/**
 * Builds a minimal server config with one provider model.
 *
 * @param model Provider model id.
 * @param extra Optional extra server config fields.
 * @returns JSONC config text.
 */
function serverConfig(model: string, extra = ''): string {
  return `{
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
    }${extra}
  }`;
}

describe('runtime config loading and reload planning', () => {
  it('adds recovery choices to stale session diagnostics', () => {
    expect(
      createRuntimeConfigStaleSession({
        sessionId: 'as_stale',
        threadId: 'th_demo',
        agentId: 'agent_codex_host',
        capturedVersion: 1,
        currentVersion: 2,
        reasons: ['runtime-config'],
      }).choices
    ).toEqual([
      {
        kind: 'inspect',
        label: 'Inspect stale session details',
        recommended: true,
      },
      {
        kind: 'restart_session',
        label: 'Restart the stale session before continuing',
      },
      {
        kind: 'request_human',
        label: 'Ask the user how to handle the stale session',
      },
    ]);
  });

  it('loads one immutable runtime config snapshot from canonical config inputs', () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot, serverConfig('openai/gpt-5.1'));

    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(snapshot.version).toBe(1);
    expect(snapshot.openKitConfig.defaults?.coreProviderId).toBe('agent-openrouter');
    expect(snapshot.providerRegistry.get('agent-openrouter')?.models).toEqual(['openai/gpt-5.1']);
  });

  it('loads workspace config from the user-owned workspace tree', () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot, serverConfig('openai/gpt-5.1'));
    writeWorkspaceConfig(
      dataRoot,
      'ws_demo',
      `{
        "schemaVersion": 1,
        "workspace": {
          "roots": [
            {
              "id": "data",
              "kind": "host-dir",
              "path": "files/data",
              "access": "read-only"
            }
          ]
        }
      }`
    );

    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(snapshot.workspaceConfigs).toEqual([
      expect.objectContaining({
        userId: 'user_local',
        workspaceId: 'ws_demo',
        config: expect.objectContaining({
          workspace: expect.objectContaining({
            roots: [expect.objectContaining({ id: 'data', path: 'files/data' })],
          }),
        }),
      }),
    ]);
  });

  it('loads workspace data source catalogs from the user-owned workspace tree', () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot, serverConfig('openai/gpt-5.1'));
    writeWorkspaceDataSources(
      dataRoot,
      'ws_demo',
      `{
        "schemaVersion": 1,
        "sources": [
          {
            "id": "main-repo",
            "kind": "git",
            "displayName": "Main repository",
            "locator": { "url": "https://github.com/acme/app.git" },
            "access": "read-write",
            "sensitivity": "internal",
            "allowedSlotKinds": ["worktree"],
            "status": "active"
          }
        ]
      }`
    );

    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(snapshot.workspaceDataSourceCatalogs).toEqual([
      expect.objectContaining({
        userId: 'user_local',
        workspaceId: 'ws_demo',
        catalog: expect.objectContaining({
          sources: [expect.objectContaining({ id: 'main-repo', kind: 'git' })],
        }),
      }),
    ]);
  });

  it('classifies workspace root changes as session-scoped', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    writeServerConfig(baseRoot, serverConfig('openai/gpt-5.1'));
    writeServerConfig(nextRoot, serverConfig('openai/gpt-5.1'));
    writeWorkspaceConfig(
      baseRoot,
      'ws_demo',
      `{
        "workspace": {
          "roots": [
            { "id": "data", "kind": "host-dir", "path": "files/data", "access": "read-only" }
          ]
        }
      }`
    );
    writeWorkspaceConfig(
      nextRoot,
      'ws_demo',
      `{
        "workspace": {
          "roots": [
            { "id": "data", "kind": "host-dir", "path": "files/raw", "access": "read-only" }
          ]
        }
      }`
    );

    const plan = diffRuntimeConfig(
      loadRuntimeConfig(baseRoot, { version: 1 }),
      loadRuntimeConfig(nextRoot, { version: 2 })
    );

    expect(plan.deferred).toEqual([
      expect.objectContaining({
        action: 'deferred',
        category: 'session-scoped',
        path: 'workspaces',
      }),
    ]);
  });

  it('does not produce runtime changes for comment-only config edits', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    writeServerConfig(baseRoot, serverConfig('openai/gpt-5.1'));
    writeServerConfig(
      nextRoot,
      `{
        // comments must not affect semantic reload diffing
        "schemaVersion": 1,
        "providers": [
          {
            "id": "agent-openrouter",
            "vendor": "openrouter",
            "kind": "gateway",
            "displayName": "Agent OpenRouter",
            "models": ["openai/gpt-5.1"]
          }
        ],
        "defaults": {
          "coreProviderId": "agent-openrouter",
          "gatewayProviderId": "agent-openrouter"
        }
      }`
    );

    const plan = diffRuntimeConfig(
      loadRuntimeConfig(baseRoot, { version: 1 }),
      loadRuntimeConfig(nextRoot, { version: 2 })
    );

    expect(plan.applied).toEqual([]);
    expect(plan.deferred).toEqual([]);
    expect(plan.requiresRestart).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });

  it('classifies provider updates as applied and server bind changes as restart-required', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    writeServerConfig(baseRoot, serverConfig('openai/gpt-5.1'));
    writeServerConfig(
      nextRoot,
      serverConfig(
        'openai/gpt-5.2',
        `,
    "server": { "bind": { "host": "0.0.0.0", "port": 4000 } },
    "vault": { "localDefaultBackend": "encrypted-file" }`
      )
    );

    const plan = diffRuntimeConfig(
      loadRuntimeConfig(baseRoot, { version: 1 }),
      loadRuntimeConfig(nextRoot, { version: 2 })
    );

    expect(plan.applied).toEqual([
      expect.objectContaining({ action: 'applied', category: 'hot-swappable', path: 'providers' }),
    ]);
    expect(plan.requiresRestart).toEqual([
      expect.objectContaining({
        action: 'requires-restart',
        category: 'restart-required',
        path: 'server',
      }),
      expect.objectContaining({
        action: 'requires-restart',
        category: 'restart-required',
        path: 'vault',
      }),
    ]);
  });

  it('keeps the current snapshot after failed and strict rejected reloads', () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot, serverConfig('openai/gpt-5.1'));
    const manager = createRuntimeConfigManager({ dataRoot });

    writeServerConfig(dataRoot, '{ invalid jsonc');
    const failed = manager.reload({ dryRun: false, mode: 'safe' });

    expect(failed.status).toBe('failed');
    expect(manager.current().version).toBe(1);
    expect(manager.status().lastFailedReload?.status).toBe('failed');

    writeServerConfig(
      dataRoot,
      serverConfig(
        'openai/gpt-5.1',
        `,
    "server": { "bind": { "host": "0.0.0.0", "port": 4000 } }`
      )
    );
    const rejected = manager.reload({ dryRun: false, mode: 'strict' });

    expect(rejected.status).toBe('rejected');
    expect(manager.current().version).toBe(1);
    expect(manager.status().pendingRestart).toHaveLength(1);
  });

  it('safe reload applies hot-swappable changes without exposing restart-required changes', () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot, serverConfig('openai/gpt-5.1'));
    const manager = createRuntimeConfigManager({ dataRoot });

    writeServerConfig(
      dataRoot,
      serverConfig(
        'openai/gpt-5.2',
        `,
    "server": { "bind": { "host": "0.0.0.0", "port": 4000 } }`
      )
    );

    const applied = manager.reload({ dryRun: false, mode: 'safe' });

    expect(applied.status).toBe('applied');
    expect(manager.current().version).toBe(2);
    expect(manager.current().providerRegistry.get('agent-openrouter')?.models).toEqual([
      'openai/gpt-5.2',
    ]);
    expect(manager.current().openKitConfig.server).toBeUndefined();
    expect(manager.status().pendingRestart).toEqual([
      expect.objectContaining({
        action: 'requires-restart',
        category: 'restart-required',
        path: 'server',
      }),
    ]);
  });

  it('keeps the current snapshot when candidate config has blocking diagnostics', () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot, serverConfig('openai/gpt-5.1'));
    const manager = createRuntimeConfigManager({ dataRoot });

    writeServerConfig(
      dataRoot,
      `{
        "schemaVersion": 1,
        "providers": [
          {
            "id": "agent-openrouter",
            "vendor": "openrouter",
            "kind": "gateway",
            "displayName": "Agent OpenRouter",
            "models": ["openai/gpt-5.2"]
          },
          {
            "id": "agent-openrouter",
            "vendor": "openrouter",
            "kind": "gateway",
            "displayName": "Duplicate OpenRouter",
            "models": ["openai/gpt-5.3"]
          }
        ]
      }`
    );

    const failed = manager.reload({ dryRun: false, mode: 'safe' });

    expect(failed.status).toBe('failed');
    expect(manager.current().version).toBe(1);
    expect(manager.current().providerRegistry.get('agent-openrouter')?.models).toEqual([
      'openai/gpt-5.1',
    ]);
    expect(manager.status().lastFailedReload?.message).toMatch(/provider.duplicate_id/i);
  });
});
