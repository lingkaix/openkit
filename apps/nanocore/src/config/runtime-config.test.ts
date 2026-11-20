import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { RETAINED_FORMAT_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { isScopeAdmitted, refuseScope } from '../bootstrap/readiness.js';
import { replaceWorkspaceEffectiveMcpCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import { resolveLogicalModelCatalog } from '../llm/logical-models.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { ensureConfigTemplateSurface } from '../storage/fs-layout.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  captureCoverageBindingFromOpenKitConfig,
  createRuntimeConfigManager,
  diffRuntimeConfig,
  loadRuntimeConfig,
} from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

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
      schemaVersion: RETAINED_FORMAT_VERSION,
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

function writeSpeechGateway(dataRoot: string, chatModel: string): void {
  const providersRoot = join(dataRoot, 'config', 'providers');
  mkdirSync(providersRoot, { recursive: true });
  writeFileSync(
    join(providersRoot, 'speech.provider.jsonc'),
    JSON.stringify({
      schemaVersion: RETAINED_FORMAT_VERSION,
      id: 'speech',
      vendor: 'openai',
      kind: 'custom',
      displayName: 'Speech',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [chatModel, 'handwritten/whisper-1'],
    })
  );
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
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [{ id: 'primary', providerProfileId: 'speech', providerModel: chatModel }],
        },
      ],
      transcription: {
        id: 'voice',
        providerProfileId: 'speech',
        providerModel: 'handwritten/whisper-1',
      },
    })
  );
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
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
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
  const configRoot = join(dataRoot, 'users', 'usr_00000000-0000-7e68-be9b-ac7521cb7be0', 'config');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, 'user.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', agentId: 'agent_personal' },
      ],
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

// Config identity requires next-command publication without activating unrelated saved revisions.
it('publishes only committed Workspace creations and name edits', async () => {
  const dataRoot = createDataRoot();
  const target = 'ws_00000000-0000-7000-8000-000000000001';
  const sibling = 'ws_00000000-0000-7000-8000-000000000002';
  try {
    writeWorkspaceConfig(
      dataRoot,
      sibling,
      JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Loaded sibling', defaultAgentId: null },
      })
    );
    const manager = createRuntimeConfigManager({ dataRoot });
    const before = manager.current();
    writeWorkspaceConfig(
      dataRoot,
      sibling,
      JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Saved sibling', defaultAgentId: 'agent_saved' },
      })
    );
    writeWorkspaceConfig(
      dataRoot,
      target,
      JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Created', defaultAgentId: null },
      })
    );
    await manager.publishWorkspaceConfiguration(target, 'Created');
    expect(
      manager.current().workspaceConfigs.find((entry) => entry.workspaceId === target)?.config
        .workspace.name
    ).toBe('Created');
    expect(manager.current().workspaceConfigs.find((entry) => entry.workspaceId === sibling)).toBe(
      before.workspaceConfigs[0]
    );
    const created = manager.current();
    writeWorkspaceConfig(
      dataRoot,
      target,
      JSON.stringify({
        schemaVersion: 1,
        workspace: {
          name: 'Renamed',
          defaultAgentId: 'agent_saved',
          policy: { workDataCapture: { value: false } },
        },
      })
    );
    await manager.publishWorkspaceConfiguration(target, 'Renamed');
    expect(
      manager.current().workspaceConfigs.find((entry) => entry.workspaceId === target)?.config
        .workspace
    ).toEqual({
      ...created.workspaceConfigs.find((entry) => entry.workspaceId === target)!.config.workspace,
      name: 'Renamed',
    });
    expect(manager.current().openKitConfig).toBe(before.openKitConfig);
    expect(manager.current().workspaceConfigs.find((entry) => entry.workspaceId === sibling)).toBe(
      before.workspaceConfigs[0]
    );
    const renamed = manager.current();
    await manager.publishWorkspaceConfiguration(target, 'Renamed');
    expect(manager.current()).toBe(renamed);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('refuses missing or invalid new Workspace configuration without changing the installed snapshot', async () => {
  const dataRoot = createDataRoot();
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  try {
    const manager = createRuntimeConfigManager({ dataRoot });
    const before = manager.current();
    await expect(manager.publishWorkspaceConfiguration(workspaceId, 'Missing')).rejects.toThrow(
      'Committed Workspace configuration is unavailable.'
    );
    expect(manager.current()).toBe(before);
    writeWorkspaceConfig(
      dataRoot,
      workspaceId,
      '{"schemaVersion":999,"workspace":{"name":"Invalid"}}'
    );
    await expect(manager.publishWorkspaceConfiguration(workspaceId, 'Invalid')).rejects.toThrow();
    expect(manager.current()).toBe(before);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

describe('runtime config loading and reload planning', () => {
  // Backup §Same-Deployment Restore: target admission must preserve unrelated live authority.
  it('reloads only recovered Workspace configuration while its freeze and quarantine remain closed', async () => {
    const dataRoot = createDataRoot();
    const target = 'ws_00000000-0000-7000-8000-000000000001';
    const sibling = 'ws_00000000-0000-7000-8000-000000000002';
    const store = await createDemoStore({ dataRoot });
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeGatewayConfig(dataRoot);
    writeInternalRoleProfiles(dataRoot);
    writeAgentConfig(dataRoot, 'Loaded Agent');
    writeUserConfig(dataRoot);
    for (const workspaceId of [target, sibling]) {
      writeWorkspaceConfig(
        dataRoot,
        workspaceId,
        '{"schemaVersion":1,"workspace":{"name":"Before"}}'
      );
      writeWorkspaceDataSources(dataRoot, workspaceId, '{"schemaVersion":1,"sources":[]}');
      writeWorkspaceMcpServers(dataRoot, workspaceId, '{"schemaVersion":1,"servers":[]}');
    }
    const manager = createRuntimeConfigManager({ dataRoot, captureCoverage: store });
    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.2',
      ', "server": { "bind": { "host": "127.0.0.1", "port": 3999 } }'
    );
    expect((await manager.reload({ mode: 'safe' })).status).toBe('applied');
    expect(manager.status().pendingRestart).toContainEqual(
      expect.objectContaining({ path: 'server' })
    );
    const before = manager.current();
    const status = manager.status();
    const capture = store.getLiveCaptureCoverage();
    writeWorkspaceConfig(dataRoot, target, '{"schemaVersion":1,"workspace":{"name":"Restored"}}');
    writeWorkspaceDataSources(
      dataRoot,
      target,
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: 'restored-repo',
            kind: 'git',
            displayName: 'Restored repository',
            locator: { url: 'https://example.com/restored.git' },
            access: 'read-only',
            sensitivity: 'internal',
            allowedSlotKinds: ['worktree'],
            status: 'active',
          },
        ],
      })
    );
    writeWorkspaceMcpServers(
      dataRoot,
      target,
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: 'echo',
            enabled: false,
            allowedTools: ['echo'],
            credentialBindings: [],
            schemaPolicy: 'tracking',
            timeoutMs: 30_000,
            transport: { kind: 'stdio', command: 'node', args: ['fixtures/echo.mjs'] },
          },
        ],
      })
    );
    writeServerConfig(dataRoot, '{ invalid unrelated Server');
    writeWorkspaceConfig(dataRoot, sibling, '{ invalid unrelated Workspace');
    writeFileSync(join(dataRoot, 'config', 'agents', 'runtime.agent.jsonc'), '{ invalid Agent');
    const frozen = getControlStoreWorkerClient().tryFreezeWorkspace(dataRoot, target, () => []);
    if (frozen.status !== 'frozen') throw new Error('Expected the target freeze.');
    refuseScope(dataRoot, { scope: 'workspace', id: target, check: 'recovery' });
    const after = manager.reloadRecoveredWorkspace(target, frozen);
    expect(manager.current()).toBe(after);
    expect(after.version).toBe(before.version + 1);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(
      after.workspaceConfigs.find((entry) => entry.workspaceId === target)?.config.workspace.name
    ).toBe('Restored');
    expect(
      after.workspaceDataSourceCatalogs.find((entry) => entry.workspaceId === target)?.catalog
        .sources[0]?.id
    ).toBe('restored-repo');
    expect(
      after.workspaceMcpServerCatalogs.find((entry) => entry.workspaceId === target)?.catalog
        .servers[0]?.enabled
    ).toBe(false);
    for (const key of [
      'openKitConfig',
      'providerRegistry',
      'modelCatalog',
      'providerDiagnostics',
      'gatewayConfig',
      'internalRoleProfiles',
      'agentManifests',
      'userConfigs',
      'sources',
    ] as const) {
      expect(after[key]).toBe(before[key]);
    }
    for (const key of [
      'workspaceConfigs',
      'workspaceDataSourceCatalogs',
      'workspaceMcpServerCatalogs',
    ] as const) {
      expect(after[key].find((entry) => entry.workspaceId === sibling)).toBe(
        before[key].find((entry) => entry.workspaceId === sibling)
      );
    }
    expect(manager.status().pendingRestart).toEqual(status.pendingRestart);
    expect(manager.status().lastReload).toEqual(status.lastReload);
    expect(manager.status().lastFailedReload).toEqual(status.lastFailedReload);
    expect(store.getLiveCaptureCoverage()).toEqual(capture);
    expect(getControlStoreWorkerClient().ownsWorkspaceFreeze(dataRoot, target, frozen)).toBe(true);
    expect(
      getControlStoreWorkerClient().enterWorkspaceLatePublisher(
        dataRoot,
        target,
        'worker-turn-closeout'
      )
    ).toBeNull();
    expect(isScopeAdmitted(dataRoot, 'workspace', target)).toBe(false);
    frozen.release();
  });

  it('retains the exact loaded snapshot when recovered Workspace input is invalid or required input is missing', () => {
    const dataRoot = createDataRoot();
    const target = 'ws_00000000-0000-7000-8000-000000000001';
    writeWorkspaceConfig(dataRoot, target, '{"schemaVersion":1,"workspace":{"name":"Before"}}');
    writeWorkspaceDataSources(dataRoot, target, '{"schemaVersion":1,"sources":[]}');
    writeWorkspaceMcpServers(dataRoot, target, '{"schemaVersion":1,"servers":[]}');
    const manager = createRuntimeConfigManager({ dataRoot });
    const before = manager.current();
    const frozen = getControlStoreWorkerClient().tryFreezeWorkspace(dataRoot, target, () => []);
    if (frozen.status !== 'frozen') throw new Error('Expected the target freeze.');
    for (const relativePath of [
      'config/workspace.jsonc',
      'config/data-sources.jsonc',
      'catalog/catalog.json',
    ]) {
      const path = join(dataRoot, 'workspaces', target, relativePath);
      const bytes = readFileSync(path);
      writeFileSync(path, '{ invalid recovered input');
      expect(() => manager.reloadRecoveredWorkspace(target, frozen)).toThrow();
      expect(manager.current()).toBe(before);
      writeFileSync(path, bytes);
    }
    rmSync(join(dataRoot, 'workspaces', target, 'config', 'workspace.jsonc'));
    expect(() => manager.reloadRecoveredWorkspace(target, frozen)).toThrow();
    expect(manager.current()).toBe(before);
    frozen.release();
  });

  it('removes absent optional target entries only and rejects foreign or stale recovery freezes', () => {
    const dataRoot = createDataRoot();
    const target = 'ws_00000000-0000-7000-8000-000000000001';
    const sibling = 'ws_00000000-0000-7000-8000-000000000002';
    for (const workspaceId of [target, sibling]) {
      writeWorkspaceConfig(
        dataRoot,
        workspaceId,
        '{"schemaVersion":1,"workspace":{"name":"Loaded"}}'
      );
      writeWorkspaceDataSources(dataRoot, workspaceId, '{"schemaVersion":1,"sources":[]}');
      writeWorkspaceMcpServers(dataRoot, workspaceId, '{"schemaVersion":1,"servers":[]}');
    }
    const manager = createRuntimeConfigManager({ dataRoot });
    const before = manager.current();
    const frozen = getControlStoreWorkerClient().tryFreezeWorkspace(dataRoot, target, () => []);
    const foreign = getControlStoreWorkerClient().tryFreezeWorkspace(
      join(dataRoot, 'foreign-native-scope'),
      target,
      () => []
    );
    if (frozen.status !== 'frozen' || foreign.status !== 'frozen')
      throw new Error('Expected exact freezes.');
    expect(() => manager.reloadRecoveredWorkspace(target, foreign)).toThrow();
    expect(() => manager.reloadRecoveredWorkspace(sibling, frozen)).toThrow();
    expect(manager.current()).toBe(before);
    rmSync(join(dataRoot, 'workspaces', target, 'config', 'data-sources.jsonc'));
    rmSync(join(dataRoot, 'workspaces', target, 'catalog', 'catalog.json'));
    const after = manager.reloadRecoveredWorkspace(target, frozen);
    for (const key of ['workspaceDataSourceCatalogs', 'workspaceMcpServerCatalogs'] as const) {
      expect(after[key].map((entry) => entry.workspaceId)).toEqual([sibling]);
      expect(after[key][0]).toBe(before[key].find((entry) => entry.workspaceId === sibling));
    }
    frozen.release();
    expect(() => manager.reloadRecoveredWorkspace(target, frozen)).toThrow();
    expect(manager.current()).toBe(after);
    foreign.release();
  });

  it('reloads fresh shipped templates without credentials with exactly the authored tiers and routes', async () => {
    const dataRoot = createDataRoot();
    ensureConfigTemplateSurface(dataRoot);
    const manager = createRuntimeConfigManager({ dataRoot });

    expect((await manager.reload({ mode: 'safe' })).status).toBe('applied');
    const snapshot = manager.current();
    expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual(
      []
    );
    const catalog = resolveLogicalModelCatalog(snapshot.gatewayConfig, snapshot.providerRegistry);
    expect(catalog.map((model) => model.id)).toEqual(['free', 'flash', 'smart', 'pro']);
    expect(snapshot.gatewayConfig.defaultLogicalModelId).toBe('smart');
    expect(
      catalog.map((model) =>
        model.routes.map(({ available, unavailableReason, ...route }) => route)
      )
    ).toEqual(snapshot.gatewayConfig.logicalModels.map((model) => model.routes));
  });

  it.each(['absent', 'delisted'])(
    'reloads a retained tier with a warning for its %s route',
    async (kind) => {
      const dataRoot = createDataRoot();
      writeServerConfig(dataRoot, '{ "schemaVersion": 1 }');
      writeProviderConfig(dataRoot, 'openai/gpt-5.1');
      writeGatewayConfig(dataRoot);
      const manager = createRuntimeConfigManager({ dataRoot });
      writeGatewayConfig(dataRoot, kind === 'delisted' ? 'removed-model' : 'openai/gpt-5.1');
      if (kind === 'absent') {
        const path = join(dataRoot, 'config', 'gateway.jsonc');
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace('agent-openrouter', 'absent-provider')
        );
      }
      const reload = await manager.reload({ mode: 'safe' });
      expect(reload.status).toBe('applied');
      expect(manager.current().gatewayConfig.logicalModels[0]?.id).toBe('reasoning');
      expect(manager.current().diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'gateway.unavailable_member',
          severity: 'warning',
          message: expect.stringContaining('primary'),
        })
      );
    }
  );

  it('warns and ignores an additive routing key on reload', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeGatewayConfig(dataRoot);
    const manager = createRuntimeConfigManager({ dataRoot });
    const path = join(dataRoot, 'config', 'gateway.jsonc');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.logicalModels[0].routing = { autoFailover: false, futureStrategy: 'ignored' };
    writeFileSync(path, JSON.stringify(raw));
    expect((await manager.reload({ mode: 'safe' })).status).toBe('applied');
    expect(manager.current().diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authored_config.unknown_key',
        severity: 'warning',
        message: expect.stringContaining('$.logicalModels[0].routing.futureStrategy'),
      })
    );
    expect(loadRuntimeConfig(dataRoot).gatewayConfig.logicalModels[0]?.routing).toEqual({
      autoFailover: false,
    });
  });

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
      'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            credentialBindings: [],
            enabled: true,
            id: 'echo',
            schemaPolicy: 'tracking',
            timeoutMs,
            transport: { args: ['fixtures/echo.mjs'], command: 'node', kind: 'stdio' },
          },
        ],
      });
    writeWorkspaceMcpServers(baseRoot, 'ws_00000000-0000-7000-8000-000000000001', catalog(60_000));
    writeWorkspaceMcpServers(nextRoot, 'ws_00000000-0000-7000-8000-000000000001', catalog(30_000));

    const base = loadRuntimeConfig(baseRoot, { version: 1 });
    const next = loadRuntimeConfig(nextRoot, { version: 2 });

    expect(base.workspaceMcpServerCatalogs).toEqual([
      expect.objectContaining({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      'ws_00000000-0000-7000-8000-000000000001',
      `{
        "schemaVersion": 1,
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
      'ws_00000000-0000-7000-8000-000000000001',
      `{
        "schemaVersion": 1,
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

  it('classifies Provider updates as live and server process changes as restart-required', () => {
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

    expect(plan.applied).toEqual([
      expect.objectContaining({ path: 'providers', action: 'applied' }),
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

  it('retains Discord startup identity through safe reload and reports the pending restart', async () => {
    const dataRoot = createDataRoot();
    const discord = { applicationId: '123456789012345678', publicKey: 'ab'.repeat(32) };
    const configured = (value: typeof discord) =>
      `, "server": { "publicBaseUrl": "https://openkit.invalid" }, "channels": ${JSON.stringify({ discord: value })}`;
    try {
      writeConfiguredServer(dataRoot, 'openai/gpt-5.1', configured(discord));
      const manager = createRuntimeConfigManager({ dataRoot });
      writeConfiguredServer(
        dataRoot,
        'openai/gpt-5.1',
        configured({ ...discord, publicKey: 'cd'.repeat(32) })
      );
      const applied = await manager.reload({ dryRun: false, mode: 'safe' });
      expect(applied.status).toBe('applied');
      expect(manager.current().openKitConfig.channels).toEqual({ discord });
      expect(manager.status().pendingRestart).toEqual([
        expect.objectContaining({
          action: 'requires-restart',
          category: 'restart-required',
          path: 'channels',
        }),
      ]);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses the retired inert Workspace approval configuration without publishing it', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const initialSnapshot = loadRuntimeConfig(dataRoot, { version: 1 });
    const manager = createRuntimeConfigManager({ dataRoot, initialSnapshot });
    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.1',
      ', "policy": { "workspaceApprovalModes": { "ws_00000000-0000-779d-821b-9fd29ef901ba": { "repo.push": "auto_allow" } } }'
    );
    expect((await manager.reload({ dryRun: false, mode: 'safe' })).status).toBe('failed');
    expect(manager.current()).toBe(initialSnapshot);
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

  describe('NanoHost startup configuration reload', () => {
    const initialHost = {
      bind: { host: '127.0.0.1', port: 3101 },
      credentialRef: 'fixture-nanohost',
      credentialSlots: {
        A: { companionPath: '/fixture/a-companion', secretPath: '/fixture/a-secret' },
        B: { companionPath: '/fixture/b-companion', secretPath: '/fixture/b-secret' },
      },
      deploymentId: 'dep_00000000-0000-7000-8000-000000000001',
      identityId: 'fixture-host',
      maxActiveTurnsPerSandbox: 20,
      rendezvousUrl: 'http://127.0.0.1:3101',
    };
    const transitions = [
      { name: 'addition', previous: undefined, next: initialHost },
      {
        name: 'replacement',
        previous: initialHost,
        next: {
          ...initialHost,
          bind: { host: '127.0.0.1', port: 3102 },
          credentialRef: 'fixture-successor',
          credentialSlots: {
            A: { companionPath: '/fixture/next-a-companion', secretPath: '/fixture/next-a-secret' },
            B: { companionPath: '/fixture/next-b-companion', secretPath: '/fixture/next-b-secret' },
          },
          deploymentId: 'dep_00000000-0000-7000-8000-000000000002',
          identityId: 'fixture-successor',
          maxActiveTurnsPerSandbox: 8,
          rendezvousUrl: 'http://127.0.0.1:3102',
        },
      },
      { name: 'removal', previous: initialHost, next: undefined },
    ];

    it('reports immediate, resident-bound and uncertain capacity changes without requiring restart', async () => {
      const dataRoot = createDataRoot();
      try {
        writeConfiguredServer(
          dataRoot,
          'openai/gpt-5.1',
          `, "nanohost": ${JSON.stringify(initialHost)}`
        );
        let resident: number | null = 20;
        const manager = createRuntimeConfigManager({
          dataRoot,
          readNanoHostResidentTurnLimit: () => resident,
        });
        const capacity = 'nanohost.maxActiveTurnsPerSandbox';
        const next = { ...initialHost, maxActiveTurnsPerSandbox: 8 };
        writeConfiguredServer(dataRoot, 'openai/gpt-5.1', `, "nanohost": ${JSON.stringify(next)}`);

        const response = await manager.reload({ mode: 'strict' });

        expect(response.status).toBe('applied');
        expect(response.plan.requiresRestart).toEqual([]);
        expect(manager.status().pendingRestart).toEqual([]);
        expect(manager.current().openKitConfig.nanohost).toEqual(next);
        expect(response.plan.applied).toContainEqual(expect.objectContaining({ path: capacity }));
        expect(manager.status().nanoHostTurnCapacity).toEqual({ desired: 8, effective: 8 });

        const writeLimit = (maxActiveTurnsPerSandbox: number) =>
          writeConfiguredServer(
            dataRoot,
            'openai/gpt-5.1',
            `, "nanohost": ${JSON.stringify({ ...initialHost, maxActiveTurnsPerSandbox })}`
          );
        writeLimit(12);
        const attainable = await manager.reload({ mode: 'strict' });
        expect(attainable.plan.applied).toContainEqual(expect.objectContaining({ path: capacity }));
        expect(manager.status().nanoHostTurnCapacity).toEqual({
          desired: 12,
          effective: 12,
        });

        resident = 8;
        writeLimit(16);
        const change = expect.objectContaining({
          path: capacity,
          summary: expect.stringContaining('The effective bound is 8.'),
        });
        const preview = await manager.reload({ mode: 'safe', dryRun: true });
        expect(preview.plan.deferred).toContainEqual(change);
        expect(manager.status().nanoHostTurnCapacity).toEqual({ desired: 12, effective: 8 });
        const deferred = await manager.reload({ mode: 'safe' });
        expect(deferred.plan.deferred).toContainEqual(change);
        expect(deferred.plan.requiresRestart).toEqual([]);
        expect(manager.status().nanoHostTurnCapacity).toEqual({ desired: 16, effective: 8 });
        resident = 16;
        expect(manager.status().nanoHostTurnCapacity).toEqual({ desired: 16, effective: 16 });

        resident = null;
        writeLimit(20);
        const unavailable = await manager.reload({ mode: 'safe' });
        expect(unavailable.plan.deferred).toContainEqual(
          expect.objectContaining({
            path: capacity,
            summary: expect.stringContaining('The resident bound is unavailable.'),
          })
        );
        expect(manager.status().nanoHostTurnCapacity).toEqual({ desired: 20, effective: null });
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it('defers an increase when its transport change fences the comparable resident', async () => {
      const dataRoot = createDataRoot();
      try {
        const previous = { ...initialHost, maxActiveTurnsPerSandbox: 2 };
        const next = {
          ...previous,
          credentialRef: 'fixture-successor',
          maxActiveTurnsPerSandbox: 4,
        };
        writeConfiguredServer(
          dataRoot,
          'openai/gpt-5.1',
          `, "nanohost": ${JSON.stringify(previous)}`
        );
        const manager = createRuntimeConfigManager({
          dataRoot,
          readNanoHostResidentTurnLimit: () => 8,
        });
        let fenceEffects = 0;
        const isFenced = manager.bindNanoHostTransportFence(async () => {
          fenceEffects++;
        });
        writeConfiguredServer(dataRoot, 'openai/gpt-5.1', `, "nanohost": ${JSON.stringify(next)}`);

        const preview = await manager.reload({ mode: 'safe', dryRun: true });
        const capacity = expect.objectContaining({
          path: 'nanohost.maxActiveTurnsPerSandbox',
          summary: expect.stringContaining('The resident bound is unavailable.'),
        });
        expect(preview.plan.deferred).toEqual([capacity]);
        expect(manager.status().nanoHostTurnCapacity).toEqual({ desired: 2, effective: 2 });
        expect(isFenced()).toBe(false);
        expect(fenceEffects).toBe(0);

        const applied = await manager.reload({ mode: 'safe' });
        expect(applied.status).toBe('applied');
        expect(applied.plan.applied).not.toContainEqual(capacity);
        expect(applied.plan.deferred).toEqual([capacity]);
        expect(applied.plan.requiresRestart).toContainEqual(
          expect.objectContaining({ path: 'nanohost.transport' })
        );
        expect(manager.status().nanoHostTurnCapacity).toEqual({ desired: 4, effective: null });
        expect(manager.current().openKitConfig.nanohost?.credentialRef).toBe(
          previous.credentialRef
        );
        expect(isFenced()).toBe(true);
        expect(fenceEffects).toBe(1);
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    for (const transition of transitions) {
      const modes =
        transition.name === 'replacement'
          ? (['dry-run', 'strict', 'safe'] as const)
          : (['safe'] as const);
      for (const mode of modes) {
        it(`keeps ${transition.name} startup-owned during ${mode} reload`, async () => {
          const dataRoot = createDataRoot();
          try {
            writeConfiguredServer(
              dataRoot,
              'openai/gpt-5.1',
              transition.previous ? `, "nanohost": ${JSON.stringify(transition.previous)}` : ''
            );
            const manager = createRuntimeConfigManager({ dataRoot });
            const previous = manager.current();
            writeConfiguredServer(
              dataRoot,
              'openai/gpt-5.1',
              `, "policy": { "workDataCapture": { "value": "on" } }${
                transition.next ? `, "nanohost": ${JSON.stringify(transition.next)}` : ''
              }`
            );

            const response = await manager.reload({
              dryRun: mode === 'dry-run',
              mode: mode === 'strict' ? 'strict' : 'safe',
            });

            expect(response.status).toBe(
              mode === 'dry-run' ? 'dry-run' : mode === 'strict' ? 'rejected' : 'applied'
            );
            const startupPaths = [
              'bind',
              'credentialRef',
              'credentialSlots',
              'deploymentId',
              'identityId',
              'rendezvousUrl',
            ];
            expect(response.plan.requiresRestart).toEqual(
              startupPaths.map((path) =>
                expect.objectContaining({
                  action: 'requires-restart',
                  category: 'restart-required',
                  path: `nanohost.${path}`,
                })
              )
            );
            expect(manager.current().openKitConfig.nanohost).toEqual(
              mode === 'safe' && transition.name === 'replacement'
                ? { ...transition.previous, maxActiveTurnsPerSandbox: 8 }
                : transition.previous
            );
            expect(
              captureCoverageBindingFromOpenKitConfig(manager.current().openKitConfig)
            ).toEqual({
              scope: 'server',
              value: 'on',
            });
            if (mode === 'safe') {
              expect(manager.current().version).toBe(previous.version + 1);
              expect(manager.status().pendingRestart).toEqual(response.plan.requiresRestart);
            } else {
              expect(manager.current()).toBe(previous);
              expect(manager.status().pendingRestart).toEqual(
                mode === 'strict' ? response.plan.requiresRestart : []
              );
            }
          } finally {
            rmSync(dataRoot, { recursive: true, force: true });
          }
        });
      }
    }
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

  it('keeps the current snapshot after failed and strict rejected reloads', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const manager = createRuntimeConfigManager({ dataRoot });

    writeServerConfig(dataRoot, '{ invalid jsonc');
    const failed = await manager.reload({ dryRun: false, mode: 'safe' });

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
    const rejected = await manager.reload({ dryRun: false, mode: 'strict' });

    expect(rejected.status).toBe('rejected');
    expect(manager.current().version).toBe(1);
    expect(manager.status().pendingRestart).toHaveLength(1);
  });

  it('safe reload publishes Provider changes while retaining the startup server', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const manager = createRuntimeConfigManager({ dataRoot });

    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.2',
      `,
    "server": { "bind": { "host": "0.0.0.0", "port": 4000 } }`
    );

    const applied = await manager.reload({ dryRun: false, mode: 'safe' });

    expect(applied.status).toBe('applied');
    expect(applied.plan.applied).toContainEqual(expect.objectContaining({ path: 'providers' }));
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

  it('keeps the current snapshot when candidate config has blocking diagnostics', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const manager = createRuntimeConfigManager({ dataRoot });

    writeFileSync(
      join(dataRoot, 'config', 'providers', 'duplicate.provider.jsonc'),
      JSON.stringify({
        schemaVersion: RETAINED_FORMAT_VERSION,
        id: 'agent-openrouter',
        vendor: 'openrouter',
        kind: 'gateway',
        displayName: 'Duplicate OpenRouter',
        models: ['openai/gpt-5.3'],
      })
    );

    const failed = await manager.reload({ dryRun: false, mode: 'safe' });

    expect(failed.status).toBe('failed');
    expect(manager.current().version).toBe(1);
    expect(manager.current().providerRegistry.get('agent-openrouter')?.models).toEqual([
      'openai/gpt-5.1',
    ]);
    expect(manager.status().lastFailedReload?.message).toMatch(/provider.duplicate_id/i);
  });

  it('loads a first runtime snapshot with unknown model context as a warning', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'handwritten/local-flash');
    writeGatewayConfig(dataRoot, 'handwritten/local-flash');
    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'provider.unknown_model_context',
          severity: 'warning',
        }),
      ])
    );
    expect(snapshot.diagnostics[0]?.message).toMatch(/handwritten\/local-flash/);
    expect(createRuntimeConfigManager({ dataRoot }).current().diagnostics).toEqual(
      snapshot.diagnostics
    );
    expect(createRuntimeConfigManager({ dataRoot, initialSnapshot: snapshot }).current()).toBe(
      snapshot
    );
  });

  it('admits a catalogued model without authored metadata and an uncatalogued model with authored context', () => {
    const catalogued = createDataRoot();
    writeConfiguredServer(catalogued, 'openai/gpt-5.1');
    writeGatewayConfig(catalogued);
    expect(loadRuntimeConfig(catalogued, { version: 1 }).diagnostics).toEqual([]);
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
        schemaVersion: RETAINED_FORMAT_VERSION,
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
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
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

  it('loads an unrouted model without known context with a warning', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeGatewayConfig(dataRoot);
    const manager = createRuntimeConfigManager({ dataRoot });
    expect(manager.current().diagnostics).toEqual([]);
    expect(manager.current().version).toBe(1);

    writeFileSync(
      join(dataRoot, 'config', 'providers', 'orca-custom.provider.jsonc'),
      JSON.stringify({
        schemaVersion: RETAINED_FORMAT_VERSION,
        displayName: 'Orca',
        id: 'orca-custom',
        kind: 'custom',
        models: ['handwritten/local-flash'],
      })
    );

    const loaded = await manager.reload({ dryRun: false, mode: 'safe' });
    expect(loaded.status).toBe('applied');
    expect(manager.current().version).toBe(2);
    expect(loaded.plan.applied).toContainEqual(expect.objectContaining({ path: 'providers' }));
    expect(manager.current().providerRegistry.get('orca-custom')?.models).toEqual([
      'handwritten/local-flash',
    ]);
    const authored = loadRuntimeConfig(dataRoot);
    expect(authored.providerRegistry.get('orca-custom')?.models).toEqual([
      'handwritten/local-flash',
    ]);
    const warning = expect.objectContaining({
      code: 'provider.unknown_model_context',
      severity: 'warning',
    });
    expect(authored.diagnostics).toContainEqual(warning);
    expect(manager.current().diagnostics).toContainEqual(warning);
    expect(loaded.plan.warnings).toContainEqual(
      expect.objectContaining({ code: 'provider.unknown_model_context' })
    );
    expect(manager.status().lastFailedReload).toBeNull();

    const restarted = createRuntimeConfigManager({ dataRoot });
    const path = join(dataRoot, 'config', 'providers', 'orca-custom.provider.jsonc');
    const profile = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...profile, secretRef: 'env:OPENKIT_TEST_ORCA' }));
    const pending = await restarted.reload({ dryRun: false, mode: 'safe' });
    expect(pending.plan.requiresRestart).toContainEqual(
      expect.objectContaining({ path: 'providers' })
    );
    expect(
      restarted
        .current()
        .diagnostics.filter((entry) => entry.code === 'provider.unknown_model_context')
    ).toEqual([warning]);
  });

  it('reports a blocked delegated-refresh strategy without rejecting the Gateway config', () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeGatewayConfig(dataRoot);
    const path = join(dataRoot, 'config', 'gateway.jsonc');
    const shape = (id: string, strategy: string) => ({
      id,
      credentialKey: 'EXAMPLE_TOKEN',
      endpoints: [
        { name: 'api', host: 'api.example.test', port: 443, binaries: ['/usr/bin/curl'] },
      ],
      refresh: { strategy, tokenUrl: 'https://auth.example.test/token', scopes: [] },
    });
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(readFileSync(path, 'utf8')),
        providerAccessShapes: [
          shape('rotating-api', 'oauth2_refresh_token'),
          shape('client-api', 'oauth2_client_credentials'),
        ],
      })
    );
    const loaded = loadRuntimeConfig(dataRoot, { version: 1 });
    expect(loaded.gatewayConfig.providerAccessShapes?.map((value) => value.id)).toEqual([
      'rotating-api',
      'client-api',
    ]);
    const blocked = loaded.diagnostics.filter(
      (value) => value.code === 'credential_delegation_blocked'
    );
    expect(blocked).toEqual([
      {
        code: 'credential_delegation_blocked',
        message:
          'Provider access shape rotating-api cannot delegate refresh: rotating-family recovery is unproved.',
        severity: 'warning',
        source: 'DATA_ROOT/config/gateway.jsonc',
      },
    ]);
    expect(loaded.diagnostics.filter((value) => value.severity === 'error')).toEqual([]);
  });

  it('publishes one Provider and Gateway generation or holds all of it for a credential change', async () => {
    const dataRoot = createDataRoot();
    try {
      writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
      writeGatewayConfig(dataRoot);
      const serverPath = join(dataRoot, 'config', 'server.jsonc');
      const providerId = 'providers/agent-openrouter.provider.jsonc';
      const gatewayId = 'gateway.jsonc';
      const providerPath = join(dataRoot, 'config', providerId);
      const gatewayPath = join(dataRoot, 'config', gatewayId);
      const catalogPath = join(dataRoot, 'config', 'model-catalog.jsonc');
      const originalProvider = {
        ...JSON.parse(readFileSync(providerPath, 'utf8')),
        secretRef: 'env:OPENKIT_TEST_PROVIDER_A',
      };
      writeFileSync(providerPath, JSON.stringify(originalProvider));
      const store = await createDemoStore({ dataRoot });
      const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
      const thread = await store.createThread(workspaceId, 'Turn during Gateway reload');
      const running = structuredClone(
        await store.createTurn(workspaceId, thread.id, 'Keep the admitted Turn', {
          kind: 'user',
          id: 'usr_00000000-0000-7000-8000-000000000001',
        })
      );
      expect(running.status).toBe('running');
      const manager = createRuntimeConfigManager({
        dataRoot,
        providerCredentialConfigured: () => false,
      });
      const files = new RuntimeConfigFileService({
        dataRoot,
        userId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceIds: store.listWorkspaces().map((workspace) => workspace.id),
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: manager.status,
      });
      const initial = manager.current();
      const initialGatewayRevision = files.readFile(gatewayId).file.revision;
      const model = 'openai/gpt-5.2';
      const provider = { ...originalProvider, models: [model], displayName: 'New Provider' };
      const modelCatalog = {
        schemaVersion: 1,
        providers: { openrouter: { models: { [model]: { limit: { context: 300_000 } } } } },
      };
      writeFileSync(providerPath, JSON.stringify(provider));
      writeFileSync(catalogPath, JSON.stringify(modelCatalog));
      writeGatewayConfig(dataRoot, model);
      const gateway = JSON.parse(readFileSync(gatewayPath, 'utf8'));
      const server = JSON.parse(readFileSync(serverPath, 'utf8'));
      writeFileSync(
        serverPath,
        JSON.stringify({
          ...server,
          server: { bind: { host: '127.0.0.1', port: 3999 } },
        })
      );

      const preview = files.validate({ files: [], mode: 'safe' });
      expect(preview.valid).toBe(true);
      expect(preview.plan.applied.map((change) => change.path)).toEqual([
        'modelCatalog',
        'providers',
        'gateway',
      ]);
      expect(preview.plan.requiresRestart.map((change) => change.path)).toEqual(['server']);
      expect(await manager.reload({ dryRun: true, mode: 'safe' })).toMatchObject({
        status: 'dry-run',
        plan: preview.plan,
      });
      expect(await manager.reload({ dryRun: false, mode: 'strict' })).toMatchObject({
        status: 'rejected',
      });
      expect(manager.current()).toBe(initial);
      const applied = await manager.reload({ dryRun: false, mode: 'safe' });
      expect(applied.status).toBe('applied');
      expect(applied.plan).toEqual(preview.plan);
      const active = manager.current();
      expect(active.openKitConfig.server).toEqual(initial.openKitConfig.server);
      expect(active.providerRegistry.get('agent-openrouter')).toMatchObject({
        models: [model],
        displayName: 'New Provider',
      });
      expect(active.gatewayConfig.logicalModels[0]?.routes[0]?.providerModel).toBe(model);
      expect(active.modelCatalog.providers.openrouter?.models[model]?.limit?.context).toBe(300_000);

      // The new route and catalog remain saved while the changed credential binding needs handover.
      writeFileSync(serverPath, JSON.stringify(server));
      writeFileSync(
        providerPath,
        JSON.stringify({ ...provider, secretRef: 'env:OPENKIT_TEST_PROVIDER_B' })
      );
      modelCatalog.providers.openrouter.models[model]!.limit.context = 320_000;
      writeFileSync(catalogPath, JSON.stringify(modelCatalog));
      gateway.logicalModels[0].routes[0].id = 'pending';
      writeFileSync(gatewayPath, JSON.stringify(gateway));
      const pending = files.validate({ files: [], mode: 'safe' });
      expect(pending.valid).toBe(true);
      expect(pending.plan.requiresRestart.map((change) => change.path)).toEqual([
        'modelCatalog',
        'providers',
        'gateway',
      ]);
      expect(pending.plan.applied).toEqual([]);
      expect(await manager.reload({ dryRun: false, mode: 'safe' })).toMatchObject({
        status: 'applied',
        plan: pending.plan,
      });
      const held = manager.current();
      expect(held.providerRegistry).toBe(active.providerRegistry);
      expect(held.gatewayConfig).toBe(active.gatewayConfig);
      expect(held.modelCatalog).toBe(active.modelCatalog);

      gateway.logicalModels[0].contextManagement[0].compactThreshold = 400_000;
      writeFileSync(gatewayPath, JSON.stringify(gateway));
      const invalid = files.validate({ files: [], mode: 'safe' });
      expect(invalid.valid).toBe(false);
      expect(invalid.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'gateway.invalid_logical_model', severity: 'error' })
      );
      expect(invalid.plan.applied).toEqual([]);
      expect(await manager.reload({ dryRun: false, mode: 'safe' })).toMatchObject({
        status: 'failed',
      });
      await expect(
        files.updateFile({
          id: gatewayId,
          kind: 'gateway',
          content: JSON.stringify(active.gatewayConfig),
          expectedRevision: initialGatewayRevision,
        })
      ).rejects.toMatchObject({ code: 'config_revision_conflict' });
      expect(manager.current()).toBe(held);
      expect(store.getTurnById(running.id)).toEqual(running);
    } finally {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('admits a transcription-only model without context through file validation and reload', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeSpeechGateway(dataRoot, 'openai/gpt-5.1');
    const loaded = loadRuntimeConfig(dataRoot, { version: 1 });
    expect(
      loaded.diagnostics.filter((entry) => entry.code === 'provider.unknown_model_context')
    ).toEqual([]);
    const manager = createRuntimeConfigManager({ dataRoot });
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
      workspaceIds: [],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const content = readFileSync(join(dataRoot, 'config', 'gateway.jsonc'), 'utf8');
    expect(files.validate({ files: [{ id: 'gateway.jsonc', content }], mode: 'safe' }).valid).toBe(
      true
    );
    const renamed = content.replace('Reasoning', 'Reasoning renamed');
    writeFileSync(join(dataRoot, 'config', 'gateway.jsonc'), renamed);
    expect(
      files.validate({ files: [{ id: 'gateway.jsonc', content: renamed }], mode: 'safe' }).valid
    ).toBe(true);
    expect((await manager.reload({ dryRun: false, mode: 'safe' })).status).toBe('applied');
    expect(manager.current().version).toBe(2);
    expect(manager.current().gatewayConfig.transcription?.routes[0]?.providerModel).toBe(
      'handwritten/whisper-1'
    );
  });

  it('keeps a chat route to a transcription model without context unavailable', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    writeSpeechGateway(dataRoot, 'openai/gpt-5.1');
    const manager = createRuntimeConfigManager({ dataRoot });
    expect(manager.current().version).toBe(1);
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
      workspaceIds: [],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const chatUsesWhisper = JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'reasoning',
      logicalModels: [
        {
          id: 'reasoning',
          displayName: 'Reasoning',
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [
            {
              id: 'primary',
              providerProfileId: 'speech',
              providerModel: 'handwritten/whisper-1',
            },
          ],
        },
      ],
      transcription: {
        id: 'voice',
        providerProfileId: 'speech',
        providerModel: 'handwritten/whisper-1',
      },
    });
    const validation = files.validate({
      files: [{ id: 'gateway.jsonc', content: chatUsesWhisper }],
      mode: 'safe',
    });
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'provider.unknown_model_context',
        severity: 'warning',
      })
    );
    writeFileSync(join(dataRoot, 'config', 'gateway.jsonc'), chatUsesWhisper);
    expect((await manager.reload({ dryRun: false, mode: 'safe' })).status).toBe('applied');
    expect(manager.current().version).toBe(2);
    const logical = resolveLogicalModelCatalog(
      manager.current().gatewayConfig,
      manager.current().providerRegistry
    );
    expect(logical[0]?.routes[0]).toMatchObject({
      available: false,
      unavailableReason: 'provider_not_dispatchable',
    });
  });

  it('admits a genuinely seeded fresh data root without activating the custom placeholder', () => {
    const dataRoot = createDataRoot();
    ensureConfigTemplateSurface(dataRoot);
    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });

    expect(
      snapshot.diagnostics.filter((entry) => entry.code === 'provider.unknown_model_context')
    ).toEqual([]);
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
    expect(snapshot.providerRegistry.get('openai')?.models).toEqual([
      'gpt-6-luna',
      'gpt-6.1-sol',
      'gpt-6-astra',
    ]);
    expect(snapshot.providerRegistry.get('anthropic')?.models).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]);
    expect(snapshot.providerRegistry.get('openrouter')?.models).toEqual([
      'poolside/laguna-s-2.1:free',
      'poolside/laguna-xs-2.1:free',
      'cohere/north-mini-code:free',
    ]);
    expect(snapshot.providerRegistry.get('xai')?.models).toEqual(['grok-4.7']);
    expect(snapshot.providerRegistry.get('google')?.models).toEqual(['gemini-3.8-flash']);
  });

  it('applies server.jsonc workDataCapture to later Turns without interrupting a running Turn', async () => {
    const dataRoot = createDataRoot();
    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.1',
      ', "policy": { "workDataCapture": { "value": "off" } }'
    );
    const store = await createDemoStore({ dataRoot });
    const manager = createRuntimeConfigManager({ captureCoverage: store, dataRoot });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Capture reload'
    );
    const running = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Keep historical pair',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const admittedRunning = structuredClone(running);
    expect(store.getTurnCaptureCoverage(running.id)).toEqual({ scope: 'server', value: 'off' });
    expect(captureCoverageBindingFromOpenKitConfig(manager.current().openKitConfig)).toEqual({
      scope: 'server',
      value: 'off',
    });

    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.1',
      ', "policy": { "workDataCapture": { "value": "on" } }'
    );
    const reloaded = await manager.reload({ dryRun: false, mode: 'safe' });
    expect(reloaded.status).toBe('applied');
    expect(reloaded.plan.applied).toEqual([
      expect.objectContaining({ path: 'policy.workDataCapture', action: 'applied' }),
    ]);
    expect(reloaded.plan.requiresRestart).toEqual([]);
    expect(store.getTurnById(running.id)).toEqual(admittedRunning);
    expect(store.getTurnById(running.id).status).toBe('running');
    expect(store.getTurnCaptureCoverage(running.id)).toEqual({ scope: 'server', value: 'off' });

    const nextThread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Capture after reload'
    );
    const next = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      nextThread.id,
      'Next turn sees on',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    expect(store.getTurnCaptureCoverage(next.id)).toEqual({ scope: 'server', value: 'on' });
    expect(store.getTurnById(running.id)).toEqual(admittedRunning);
    expect(store.getTurnCaptureCoverage(running.id)).toEqual({ scope: 'server', value: 'off' });
  });
});

it('reload warns by route name when its required API key is missing', async () => {
  const dataRoot = createDataRoot();
  writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
  writeGatewayConfig(dataRoot);
  const manager = createRuntimeConfigManager({
    dataRoot,
    providerCredentialConfigured: () => false,
  });
  expect((await manager.reload({ mode: 'safe' })).status).toBe('applied');
  expect(manager.current().diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'gateway.unavailable_member',
      severity: 'warning',
      message: 'Logical model route primary is unavailable: provider_api_key_missing.',
    })
  );
});

// RET §Native Transcripts And Runtime Logs: the operator can adjust the combined limit.
it('RET-2 reload selects a checked log bound without changing a running Turn capture binding', async () => {
  const dataRoot = createDataRoot();
  try {
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1', ', "policy": { "workDataCapture": {} }');
    const store = await createDemoStore({ dataRoot });
    const manager = createRuntimeConfigManager({ dataRoot, captureCoverage: store });
    const prior = manager.current();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Native log policy',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }
    );
    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.1',
      ', "policy": { "workDataCapture": { "nativeLogMaxBytes": 97 } }'
    );
    expect((await manager.reload({ dryRun: false, mode: 'safe' })).status).toBe('applied');
    expect(manager.current().openKitConfig.policy?.workDataCapture).toEqual({
      value: 'on',
      nativeLogMaxBytes: 97,
    });
    expect(prior.openKitConfig.policy?.workDataCapture).toEqual({
      value: 'on',
      nativeLogMaxBytes: 16_777_216,
    });
    expect(store.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'on' });
    const accepted = manager.current();
    writeConfiguredServer(
      dataRoot,
      'openai/gpt-5.1',
      ', "policy": { "workDataCapture": { "nativeLogMaxBytes": 0 } }'
    );
    expect((await manager.reload({ dryRun: false, mode: 'safe' })).status).not.toBe('applied');
    expect(manager.current()).toBe(accepted);
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

describe('Capture Coverage scope resolution (#732)', () => {
  it('defaults on, inherits missing overrides and prefers the exact Workspace Task', () => {
    const server = { schemaVersion: 1 };
    const workspace = {
      schemaVersion: 1,
      workspace: {
        name: 'Coverage',
        policy: {
          workDataCapture: { value: 'off', tasks: { taskA: { value: 'on' } } },
        },
      },
    };
    expect(captureCoverageBindingFromOpenKitConfig(server)).toEqual({
      scope: 'server',
      value: 'on',
    });
    expect(captureCoverageBindingFromOpenKitConfig(server, workspace)).toEqual({
      scope: 'workspace',
      value: 'off',
    });
    expect(captureCoverageBindingFromOpenKitConfig(server, workspace, 'taskA')).toEqual({
      scope: 'task',
      value: 'on',
    });
    expect(captureCoverageBindingFromOpenKitConfig(server, workspace, 'taskB')).toEqual({
      scope: 'workspace',
      value: 'off',
    });
    expect(
      captureCoverageBindingFromOpenKitConfig({
        schemaVersion: 1,
        policy: { workDataCapture: { value: 'off' } },
      })
    ).toEqual({ scope: 'server', value: 'off' });
  });
});

it('snapshots Workspace and Task capture overrides at native admission and preserves them on reload/restart (#732)', async () => {
  const dataRoot = createDataRoot();
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  try {
    writeConfiguredServer(dataRoot, 'openai/gpt-5.1');
    const store = await createDemoStore({ dataRoot });
    const path = join(dataRoot, 'workspaces', workspaceId, 'config', 'workspace.jsonc');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const taskThread = await store.createThread(
      workspaceId,
      'Scoped Task',
      undefined,
      'conversation',
      { visibility: 'workspace', threadSource: 'worker' }
    );
    config.workspace.policy = {
      workDataCapture: { value: 'off', tasks: { [taskThread.id]: { value: 'on' } } },
    };
    writeFileSync(path, JSON.stringify(config));
    const manager = createRuntimeConfigManager({ dataRoot, captureCoverage: store });
    const first = await store.createTurn(workspaceId, threadId, 'Workspace override', actor);
    expect(store.getTurnCaptureCoverage(first.id)).toEqual({ scope: 'workspace', value: 'off' });
    await store.completeTurn(first.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const task = await store.createTurn(workspaceId, taskThread.id, 'Task override', actor);
    expect(store.getTurnCaptureCoverage(task.id)).toEqual({ scope: 'task', value: 'on' });
    config.workspace.policy.workDataCapture.value = 'on';
    writeFileSync(path, JSON.stringify(config));
    expect(store.getLiveCaptureCoverage(workspaceId)).toEqual({ scope: 'workspace', value: 'off' });
    expect((await manager.reload({ dryRun: false, mode: 'safe' })).status).toBe('applied');
    expect(store.getLiveCaptureCoverage(workspaceId)).toEqual({ scope: 'workspace', value: 'on' });
    expect(store.getTurnCaptureCoverage(first.id)).toEqual({ scope: 'workspace', value: 'off' });
    expect(new FsStore({ dataRoot }).getTurnCaptureCoverage(first.id)).toEqual({
      scope: 'workspace',
      value: 'off',
    });
    expect(new FsStore({ dataRoot }).getTurnCaptureCoverage(task.id)).toEqual({
      scope: 'task',
      value: 'on',
    });
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
