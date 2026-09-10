import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

import { replaceWorkspaceEffectiveMcpCatalog } from '../catalog/resource-catalog.js';
import { ensureConfigTemplateSurface } from '../storage/fs-layout.js';

import {
  createRuntimeConfigManager,
  diffRuntimeConfig,
  loadRuntimeConfig,
  unknownModelContextFailure,
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

/** Writes the canonical provider profile used by runtime-config tests. */
function writeProviderConfig(dataRoot: string, model: string): void {
  const providersRoot = join(dataRoot, 'config', 'providers');
  mkdirSync(providersRoot, { recursive: true });
  writeFileSync(
    join(providersRoot, 'agent-openrouter.provider.jsonc'),
    JSON.stringify({
      id: 'agent-openrouter',
      vendor: 'openrouter',
      kind: 'gateway',
      displayName: 'Agent OpenRouter',
      models: [model],
    })
  );
}

/** Writes the independent Server and Provider files used by one test snapshot. */
function writeConfiguredServer(dataRoot: string, model: string, extra = ''): void {
  writeServerConfig(
    dataRoot,
    `{
      "schemaVersion": 1,
      "defaults": {
        "defaultAgentId": "agent_server"
      }${extra}
    }`
  );
  writeProviderConfig(dataRoot, model);
}

function writeGatewayConfig(dataRoot: string, model = 'openai/gpt-5.1'): void {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'reasoning',
      logicalModels: [
        {
          id: 'reasoning',
          displayName: 'Reasoning',
          routes: [{ id: 'primary', providerProfileId: 'agent-openrouter', providerModel: model }],
        },
      ],
    })
  );
}

function writeInternalRoleProfiles(dataRoot: string): void {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'internal-role-profiles.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      defaultLogicalModelId: 'reasoning',
      profiles: [
        {
          id: 'assistant-default',
          roleId: 'assistant',
          preferredLogicalModelId: 'reasoning',
        },
      ],
    })
  );
}

function writeUserConfig(dataRoot: string): void {
  const configRoot = join(dataRoot, 'users', 'user_demo', 'config');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, 'user.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [{ workspaceId: 'ws_demo', agentId: 'agent_personal' }],
    })
  );
}

/**
 * Writes one authored agent config whose display name can drive semantic reload tests.
 *
 * @param dataRoot Data root that owns the agent config directory.
 * @param displayName Agent display name to write.
 */
function writeAgentConfig(dataRoot: string, displayName: string): void {
  const configRoot = join(dataRoot, 'config', 'agents');

  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, 'runtime.agent.jsonc'),
    `{
      "schemaVersion": 1,
      "id": "agent_runtime",
      "displayName": "${displayName}",
      "runtime": {
        "kind": "future-runtime",
        "adapter": "future-adapter",
        "image": {
          "kind": "reference",
          "ref": "ghcr.io/openkit/worker-future:test",
          "pullPolicy": "if-not-present"
        },
        "binaries": [
          { "id": "openkit-worker-shim", "path": "/usr/local/bin/openkit-worker-shim" },
          { "id": "future-runtime", "path": "/usr/local/bin/future-runtime" }
        ]
      },
      "models": { "preferredLogicalModelId": "reasoning", "allowedLogicalModelIds": ["reasoning"] },
      "profiles": [{ "id": "default", "instructionsRef": "codex", "skills": [], "mcp": [] }],
      "defaultProfileId": "default",
      "skills": [],
      "workspace": { "root": "." },
      "extensions": {}
    }`
  );
}

/**
 * Writes one workspace config file to the canonical owner-independent Workspace path.
 *
 * @param dataRoot Data root that owns the Workspace tree.
 * @param workspaceId Workspace id to configure.
 * @param body JSONC body to write.
 */
function writeWorkspaceConfig(dataRoot: string, workspaceId: string, body: string): void {
  const configRoot = join(dataRoot, 'workspaces', workspaceId, 'config');

  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'workspace.jsonc'), body);
}

/**
 * Writes one workspace data source catalog to the canonical workspace config path.
 *
 * @param dataRoot Data root that owns the Workspace tree.
 * @param workspaceId Workspace id to configure.
 * @param body JSONC body to write.
 */
function writeWorkspaceDataSources(dataRoot: string, workspaceId: string, body: string): void {
  const configRoot = join(dataRoot, 'workspaces', workspaceId, 'config');

  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'data-sources.jsonc'), body);
}

/** Writes one Workspace MCP server catalog to its canonical config path. */
function writeWorkspaceMcpServers(dataRoot: string, workspaceId: string, body: string): void {
  replaceWorkspaceEffectiveMcpCatalog({
    catalog: parseWorkspaceMcpServerCatalog(JSON.parse(body)),
    dataRoot,
    workspaceId,
  });
}

describe('runtime config loading and reload planning', () => {
  it('loads one immutable runtime config snapshot from canonical config inputs', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeGatewayConfig(dataRoot);
    writeInternalRoleProfiles(dataRoot);
    writeUserConfig(dataRoot);

    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(snapshot.version).toBe(1);
    expect(snapshot.openKitConfig.defaults?.defaultAgentId).toBe('agent_server');
    expect(snapshot.providerRegistry.get('agent-openrouter')?.models).toEqual(['openai/gpt-5.1']);
    expect(snapshot.gatewayConfig.defaultLogicalModelId).toBe('reasoning');
    expect(snapshot.internalRoleProfiles.profiles[0]?.roleId).toBe('assistant');
    expect(snapshot.userConfigs[0]?.config.workspaces[0]?.agentId).toBe('agent_personal');
  });

  it('exposes one authored agent manifest collection without a derived projection', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeAgentConfig(dataRoot, 'Opaque Runtime Agent');

    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(snapshot).not.toHaveProperty('agentConfigs');
    expect(snapshot.agentManifests).toEqual([expect.objectContaining({ id: 'agent_runtime' })]);
  });

  it('loads workspace config from the owner-independent Workspace tree', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeWorkspaceConfig(
      dataRoot,
      'ws_demo',
      `{
        "schemaVersion": 1,
        "workspace": {
          "name": "Demo Workspace",
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
        workspaceId: 'ws_demo',
        config: expect.objectContaining({
          workspace: expect.objectContaining({
            roots: [expect.objectContaining({ id: 'data', path: 'files/data' })],
          }),
        }),
      }),
    ]);
  });

  it('loads workspace data source catalogs from the owner-independent Workspace tree', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
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
        workspaceId: 'ws_demo',
        catalog: expect.objectContaining({
          sources: [expect.objectContaining({ id: 'main-repo', kind: 'git' })],
        }),
      }),
    ]);
  });

  it('loads Workspace MCP catalogs and scopes their changes to future sessions', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    for (const root of [baseRoot, nextRoot]) {
      writeConfiguredServer(root, 'openai/gpt-5.1');
    }
    const catalog = (timeoutMs: number) =>
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'echo',
            schemaPolicy: 'tracking',
            timeoutMs,
            transport: { args: ['fixtures/echo.mjs'], command: 'node', kind: 'stdio' },
          },
        ],
      });
    writeWorkspaceMcpServers(baseRoot, 'ws_demo', catalog(60_000));
    writeWorkspaceMcpServers(nextRoot, 'ws_demo', catalog(30_000));

    const base = loadRuntimeConfig(baseRoot, { version: 1 });
    const next = loadRuntimeConfig(nextRoot, { version: 2 });

    expect(base.workspaceMcpServerCatalogs).toEqual([
      expect.objectContaining({
        workspaceId: 'ws_demo',
        catalog: expect.objectContaining({
          servers: [expect.objectContaining({ id: 'echo', timeoutMs: 60_000 })],
        }),
      }),
    ]);
    expect(diffRuntimeConfig(base, next).deferred).toContainEqual(
      expect.objectContaining({
        action: 'deferred',
        category: 'session-scoped',
        path: 'workspaceMcpServers',
      })
    );
  });

  it('classifies workspace root changes as session-scoped', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    writeConfiguredServer(baseRoot, 'openai/gpt-5.1');
    writeConfiguredServer(nextRoot, 'openai/gpt-5.1');
    writeWorkspaceConfig(
      baseRoot,
      'ws_demo',
      `{
        "workspace": {
          "name": "Demo Workspace",
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
          "name": "Demo Workspace",
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
    writeConfiguredServer(baseRoot, 'openai/gpt-5.1');
    writeServerConfig(
      nextRoot,
      `{
        // comments must not affect semantic reload diffing
        "schemaVersion": 1,
        "defaults": {
          "defaultAgentId": "agent_server"
        }
      }`
    );
    writeProviderConfig(nextRoot, 'openai/gpt-5.1');

    const plan = diffRuntimeConfig(
      loadRuntimeConfig(baseRoot, { version: 1 }),
      loadRuntimeConfig(nextRoot, { version: 2 })
    );

    expect(plan.applied).toEqual([]);
    expect(plan.deferred).toEqual([]);
    expect(plan.requiresRestart).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });

  it('classifies provider updates and server process changes as restart-required', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    writeConfiguredServer(baseRoot, 'openai/gpt-5.1');
    writeConfiguredServer(
      nextRoot,
      'openai/gpt-5.2',
      `,
    "server": { "bind": { "host": "0.0.0.0", "port": 4000 } },
    "vault": { "encryptedFile": { "keyFilePath": "/run/secrets/openkit-vault.key" } }`
    );

    const plan = diffRuntimeConfig(
      loadRuntimeConfig(baseRoot, { version: 1 }),
      loadRuntimeConfig(nextRoot, { version: 2 })
    );

    expect(plan.applied).toEqual([]);
    expect(plan.requiresRestart).toEqual([
      expect.objectContaining({
        action: 'requires-restart',
        category: 'restart-required',
        path: 'providers',
      }),
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

  it('classifies appUpdate host-identity changes as restart-required', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    writeConfiguredServer(baseRoot, 'openai/gpt-5.1');
    writeConfiguredServer(
      nextRoot,
      'openai/gpt-5.1',
      `,
    "appUpdate": {
      "host": "127.0.0.1",
      "identityFile": "/run/openkit/app-update/id_ed25519",
      "knownHostsFile": "/run/openkit/app-update/known_hosts",
      "port": 22,
      "user": "openkit-update"
    }`
    );

    const previous = loadRuntimeConfig(baseRoot, { version: 1 });
    const next = loadRuntimeConfig(nextRoot, { version: 2 });
    const plan = diffRuntimeConfig(previous, next);

    expect(previous.openKitConfig.appUpdate).toBeUndefined();
    expect(next.openKitConfig.appUpdate).toEqual({
      host: '127.0.0.1',
      identityFile: '/run/openkit/app-update/id_ed25519',
      knownHostsFile: '/run/openkit/app-update/known_hosts',
      port: 22,
      user: 'openkit-update',
    });
    expect(plan.applied).toEqual([]);
    expect(plan.requiresRestart).toEqual([
      expect.objectContaining({
        action: 'requires-restart',
        category: 'restart-required',
        path: 'appUpdate',
      }),
    ]);
  });

  it('classifies agent config changes as session-scoped', () => {
    const baseRoot = createDataRoot();
    const nextRoot = createDataRoot();
    writeConfiguredServer(baseRoot, 'openai/gpt-5.1');
    writeConfiguredServer(nextRoot, 'openai/gpt-5.1');
    writeAgentConfig(baseRoot, 'Runtime Agent One');
    writeAgentConfig(nextRoot, 'Runtime Agent Two');

    const plan = diffRuntimeConfig(
      loadRuntimeConfig(baseRoot, { version: 1 }),
      loadRuntimeConfig(nextRoot, { version: 2 })
    );

    expect(plan.deferred).toEqual([
      expect.objectContaining({
        action: 'deferred',
        category: 'session-scoped',
        path: 'agents',
      }),
    ]);
    expect(plan.requiresRestart).toEqual([]);
  });

  it('keeps the current snapshot after failed and strict rejected reloads', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const manager = createRuntimeConfigManager({ dataRoot });

    writeServerConfig(dataRoot, '{ invalid jsonc');
    const failed = manager.reload({ dryRun: false, mode: 'safe' });

    expect(failed.status).toBe('failed');
    expect(manager.current().version).toBe(1);
    expect(manager.status().lastFailedReload?.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain(dataRoot);
    expect(failed.plan.rejected[0]?.summary).toContain('DATA_ROOT/config/server.jsonc');
    expect(manager.status().lastFailedReload?.message).toContain('DATA_ROOT/config/server.jsonc');

    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.1',
      `,
    "server": { "bind": { "host": "0.0.0.0", "port": 4000 } }`
    );
    const rejected = manager.reload({ dryRun: false, mode: 'strict' });

    expect(rejected.status).toBe('rejected');
    expect(manager.current().version).toBe(1);
    expect(manager.status().pendingRestart).toHaveLength(1);
  });

  it('safe reload preserves provider and server state until restart', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const manager = createRuntimeConfigManager({ dataRoot });

    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.2',
      `,
    "server": { "bind": { "host": "0.0.0.0", "port": 4000 } }`
    );

    const applied = manager.reload({ dryRun: false, mode: 'safe' });

    expect(applied.status).toBe('applied');
    expect(manager.current().version).toBe(2);
    expect(manager.current().providerRegistry.get('agent-openrouter')?.models).toEqual([
      'openai/gpt-5.1',
    ]);
    expect(manager.current().openKitConfig.server).toBeUndefined();
    expect(manager.status().pendingRestart).toEqual([
      expect.objectContaining({
        action: 'requires-restart',
        category: 'restart-required',
        path: 'providers',
      }),
      expect.objectContaining({
        action: 'requires-restart',
        category: 'restart-required',
        path: 'server',
      }),
    ]);
  });

  it('keeps the current snapshot when candidate config has blocking diagnostics', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const manager = createRuntimeConfigManager({ dataRoot });

    writeFileSync(
      join(dataRoot, 'config', 'providers', 'duplicate.provider.jsonc'),
      JSON.stringify({
        id: 'agent-openrouter',
        vendor: 'openrouter',
        kind: 'gateway',
        displayName: 'Duplicate OpenRouter',
        models: ['openai/gpt-5.3'],
      })
    );

    const failed = manager.reload({ dryRun: false, mode: 'safe' });

    expect(failed.status).toBe('failed');
    expect(manager.current().version).toBe(1);
    expect(manager.current().providerRegistry.get('agent-openrouter')?.models).toEqual([
      'openai/gpt-5.1',
    ]);
    expect(manager.status().lastFailedReload?.message).toMatch(/provider.duplicate_id/i);
  });

  it('refuses a first composed runtime snapshot with unknown model context', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'handwritten/local-flash');
    writeGatewayConfig(dataRoot, 'handwritten/local-flash');
    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'provider.unknown_model_context',
          severity: 'error',
        }),
      ])
    );
    expect(snapshot.diagnostics[0]?.message).toMatch(/handwritten\/local-flash/);
    expect(unknownModelContextFailure(snapshot)).toEqual({
      blocks: ['product_work'],
      code: 'provider.unknown_model_context',
      message: expect.stringMatching(/handwritten\/local-flash/),
    });
    expect(() => createRuntimeConfigManager({ dataRoot })).toThrow(
      /provider\.unknown_model_context.*handwritten\/local-flash/s
    );
    expect(() => createRuntimeConfigManager({ dataRoot, initialSnapshot: snapshot })).toThrow(
      /provider\.unknown_model_context.*handwritten\/local-flash/s
    );
  });

  it('admits a catalogued model without authored metadata and an uncatalogued model with authored context', () => {
    const catalogued = createDataRoot();
    writeConfiguredServer(catalogued, 'openai/gpt-5.1');
    writeGatewayConfig(catalogued);
    expect(loadRuntimeConfig(catalogued, { version: 1 }).diagnostics).toEqual([]);
    expect(unknownModelContextFailure(loadRuntimeConfig(catalogued, { version: 1 }))).toBeNull();
    expect(createRuntimeConfigManager({ dataRoot: catalogued }).current().diagnostics).toEqual([]);

    const authored = createDataRoot();
    writeServerConfig(
      authored,
      `{
      "schemaVersion": 1,
      "defaults": {
        "defaultAgentId": "agent_server"
      }
    }`
    );
    const providersRoot = join(authored, 'config', 'providers');
    mkdirSync(providersRoot, { recursive: true });
    writeFileSync(
      join(providersRoot, 'orca-custom.provider.jsonc'),
      JSON.stringify({
        displayName: 'Orca',
        id: 'orca-custom',
        kind: 'custom',
        models: ['handwritten/local-flash'],
        modelMetadata: { 'handwritten/local-flash': { limit: { context: 8192 } } },
      })
    );
    writeFileSync(
      join(authored, 'config', 'gateway.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'local-free',
        logicalModels: [
          {
            id: 'local-free',
            displayName: 'Local Free',
            routes: [
              {
                id: 'primary',
                providerProfileId: 'orca-custom',
                providerModel: 'handwritten/local-flash',
              },
            ],
          },
        ],
      })
    );

    expect(loadRuntimeConfig(authored, { version: 1 }).diagnostics).toEqual([]);
    expect(createRuntimeConfigManager({ dataRoot: authored }).current().diagnostics).toEqual([]);
  });

  it('rejects an unrouted configured model without known context and keeps the active snapshot', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeGatewayConfig(dataRoot);
    const manager = createRuntimeConfigManager({ dataRoot });
    expect(manager.current().diagnostics).toEqual([]);
    expect(manager.current().version).toBe(1);

    writeFileSync(
      join(dataRoot, 'config', 'providers', 'orca-custom.provider.jsonc'),
      JSON.stringify({
        displayName: 'Orca',
        id: 'orca-custom',
        kind: 'custom',
        models: ['handwritten/local-flash'],
      })
    );

    const failed = manager.reload({ dryRun: false, mode: 'safe' });

    expect(failed.status).toBe('failed');
    expect(manager.current().version).toBe(1);
    expect(manager.current().providerRegistry.get('orca-custom')).toBeNull();
    expect(manager.status().lastFailedReload?.message).toMatch(
      /provider\.unknown_model_context.*handwritten\/local-flash/s
    );
  });

  it('admits a genuinely seeded fresh data root without activating the custom placeholder', () => {
    const dataRoot = createDataRoot();
    ensureConfigTemplateSurface(dataRoot);
    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(unknownModelContextFailure(snapshot)).toBeNull();
    expect(() => createRuntimeConfigManager({ dataRoot, initialSnapshot: snapshot })).not.toThrow();
    expect(
      existsSync(join(dataRoot, 'config', 'providers', 'openai-compatible-custom.provider.jsonc'))
    ).toBe(false);
    expect(
      existsSync(
        join(dataRoot, 'config', 'providers', 'openai-compatible-custom.provider.jsonc.example')
      )
    ).toBe(true);
    expect(snapshot.providerRegistry.get('openai-compatible-custom')).toBeNull();
    expect(snapshot.providerRegistry.get('openai')?.models).toEqual(['gpt-5.1']);
    expect(snapshot.providerRegistry.get('anthropic')?.models).toEqual(['claude-sonnet-4-5']);
    expect(snapshot.providerRegistry.get('openrouter')?.models).toEqual(['openai/gpt-5.1']);
    expect(snapshot.providerRegistry.get('xai')?.models).toEqual(['grok-4.3']);
    expect(snapshot.providerRegistry.get('google')?.models).toEqual(['gemini-2.5-pro']);
  });
});
