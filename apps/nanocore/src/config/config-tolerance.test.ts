import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentManifests } from './agents-loader.js';
import { loadOpenKitConfigWithDiagnostics } from './openkit-config.js';
import { createRuntimeConfigManager, loadRuntimeConfig } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const dataRoots: string[] = [];

afterEach(() => {
  for (const root of dataRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authoredFile(relativePath: string, content: string): { dataRoot: string; path: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-tolerance-'));
  dataRoots.push(dataRoot);
  const path = join(dataRoot, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return { dataRoot, path };
}

describe('authored configuration tolerance', () => {
  it('reports ignored Gateway routing keys through file validation without exposing values', () => {
    const content = JSON.stringify({
      schemaVersion: 1,
      logicalModels: [
        {
          id: 'retained',
          displayName: 'Retained',
          routing: { autoFailover: true, futureStrategy: 'private-canary' },
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [{ id: 'missing-route', providerProfileId: 'missing', providerModel: 'model' }],
        },
      ],
    });
    const { dataRoot, path } = authoredFile('config/gateway.jsonc', content);
    const manager = createRuntimeConfigManager({ dataRoot });
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'user_demo',
      workspaceIds: [],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const validation = files.validate({ files: [{ id: 'gateway.jsonc', content }], mode: 'safe' });
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authored_config.unknown_key',
        severity: 'warning',
        jsonPath: '$.logicalModels[0].routing.futureStrategy',
      })
    );
    expect(JSON.stringify(validation.diagnostics)).not.toContain('private-canary');
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it.each([
    'environmnt',
    'credentials',
    'credentialRef',
    'credentialDeclarations',
    'token',
    'process',
  ])('reports stripped Agent runtime keys through loader, snapshot and file diagnostics for %s without warning about variable names', (key) => {
    const authored = {
      schemaVersion: 1,
      id: 'agent_future',
      displayName: 'Future',
      models: { preferredLogicalModelId: 'reasoning', allowedLogicalModelIds: ['reasoning'] },
      runtime: {
        kind: 'pi',
        adapter: 'pi',
        image: { kind: 'reference', ref: 'test:image', pullPolicy: 'never' },
        binaries: [{ id: 'shim', path: '/usr/local/bin/shim' }],
        environment: { PUBLIC: '', environmnt: 'legitimate variable name' },
        [key]: { SETTING: 'canary-ignored-value' },
        'future.note': 'canary-ignored-value',
      },
    };
    const content = JSON.stringify(authored);
    const { dataRoot, path } = authoredFile('config/agents/future.agent.jsonc', content);
    const loaded = loadAgentManifests(dataRoot);
    expect(loaded.manifests[0]?.runtime.environment).toEqual(authored.runtime.environment);
    expect(loaded.manifests[0]?.runtime).not.toHaveProperty(key);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path,
        agentId: 'agent_future',
        message: `Unknown configuration key "${key}" at $.runtime.${key} was ignored.`,
      }),
      expect.objectContaining({
        severity: 'warning',
        path,
        message: 'Unknown configuration key "future.note" at $.runtime["future.note"] was ignored.',
      }),
    ]);
    const manager = createRuntimeConfigManager({ dataRoot });
    const warnings = manager
      .current()
      .diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(
      loaded.diagnostics.map(({ code, message, severity }) => ({
        code,
        message,
        severity,
        source: 'config/agents/future.agent.jsonc',
      }))
    );
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'user_demo',
      workspaceIds: [],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const validation = files.validate({
      files: [{ id: 'agents/future.agent.jsonc', content }],
      mode: 'safe',
    });
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        source: 'agents/future.agent.jsonc',
        jsonPath: `$.runtime.${key}`,
      }),
      expect.objectContaining({
        severity: 'warning',
        source: 'agents/future.agent.jsonc',
        jsonPath: '$.runtime["future.note"]',
      }),
    ]);
    expect(JSON.stringify([...loaded.diagnostics, ...validation.diagnostics])).not.toContain(
      'canary-ignored-value'
    );
  });

  it('loads an unknown optional Server key, reports its location, and preserves authored bytes on edit', () => {
    const content =
      '{\n  "schemaVersion": 1,\n  "mode": "server",\n  "futureDisplayHint": "compact" // newer release\n}\n';
    const { dataRoot, path } = authoredFile('config/server.jsonc', content);

    const loaded = loadOpenKitConfigWithDiagnostics(dataRoot);
    expect(loaded.config).toMatchObject({ schemaVersion: 1, mode: 'server' });
    expect(loaded.config).not.toHaveProperty('futureDisplayHint');
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringMatching(/futureDisplayHint.*\$|\$.*futureDisplayHint/),
      }),
    ]);

    const manager = createRuntimeConfigManager({ dataRoot });
    expect(manager.current().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          source: 'DATA_ROOT/config/server.jsonc',
          message: expect.stringContaining('futureDisplayHint'),
        }),
      ])
    );
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'user_demo',
      workspaceIds: [],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const revision = files.readFile('server.jsonc').file.revision;
    const validation = files.validate({ files: [{ id: 'server.jsonc', content }], mode: 'safe' });
    expect(validation.valid).toBe(true);
    expect(
      validation.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('futureDisplayHint')
      )
    ).toEqual([expect.objectContaining({ fileId: 'server.jsonc', severity: 'warning' })]);
    expect(
      files.updateFile({ id: 'server.jsonc', kind: 'server', content, expectedRevision: revision })
        .diagnostics
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          message: expect.stringContaining('futureDisplayHint'),
        }),
      ])
    );
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('keeps unknown authority keys and unsupported declared features blocking', () => {
    const { dataRoot, path } = authoredFile(
      'config/server.jsonc',
      JSON.stringify({ schemaVersion: 1, auth: { futureSignupRule: true } })
    );
    expect(() => loadOpenKitConfigWithDiagnostics(dataRoot)).toThrow(/futureSignupRule/);

    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, requiredFeatures: ['future.config.rule'] })
    );
    expect(() => loadOpenKitConfigWithDiagnostics(dataRoot)).toThrow(/future\.config\.rule/);
  });

  it('returns a tolerant-key warning through the public reload plan', () => {
    const { dataRoot, path } = authoredFile('config/server.jsonc', '{ "schemaVersion": 1 }');
    const manager = createRuntimeConfigManager({ dataRoot });
    writeFileSync(path, '{ "schemaVersion": 1, "futureDisplayHint": "compact" }');

    const result = manager.reload({ mode: 'safe', dryRun: false });
    expect(result.status).toBe('applied');
    expect(result.plan.warnings).toHaveLength(1);
    expect(result.plan.warnings[0]?.message).toContain('futureDisplayHint');
    expect(result.plan.warnings[0]?.message).toContain('DATA_ROOT/config/server.jsonc');
    expect(result.plan.warnings[0]?.message).not.toContain(dataRoot);
  });

  it('loads unknown personal and Workspace preference keys with located warnings', () => {
    const { dataRoot } = authoredFile(
      'users/user_demo/config/user.jsonc',
      JSON.stringify({
        schemaVersion: 1,
        workspaces: [
          {
            workspaceId: 'ws_demo',
            futurePreference: 'quiet',
            internalRoles: [{ roleId: 'assistant', futureRolePreference: 'quiet' }],
          },
        ],
      })
    );
    const workspacePath = join(dataRoot, 'workspaces/ws_demo/config/workspace.jsonc');
    mkdirSync(join(workspacePath, '..'), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: {
          name: 'Demo',
          internalRoles: [{ roleId: 'assistant', futureRoleHint: 'quiet' }],
        },
      })
    );

    const snapshot = loadRuntimeConfig(dataRoot);
    expect(snapshot.userConfigs[0]?.config.workspaces[0]?.workspaceId).toBe('ws_demo');
    expect(snapshot.workspaceConfigs[0]?.config.workspace.name).toBe('Demo');
    for (const [source, key, location] of [
      ['DATA_ROOT/users/user_demo/config/user.jsonc', 'futurePreference', 'workspaces'],
      ['DATA_ROOT/users/user_demo/config/user.jsonc', 'futureRolePreference', 'internalRoles'],
      ['DATA_ROOT/workspaces/ws_demo/config/workspace.jsonc', 'futureRoleHint', 'internalRoles'],
    ]) {
      const warning = snapshot.diagnostics.find(
        (diagnostic) => diagnostic.source === source && diagnostic.message.includes(key)
      );
      expect(warning?.severity).toBe('warning');
      expect(warning?.message).toContain(location);
    }
  });

  it('reports unknown optional data-source keys already accepted by the catalog reader', () => {
    const { dataRoot } = authoredFile(
      'workspaces/ws_demo/config/data-sources.jsonc',
      JSON.stringify({
        schemaVersion: 1,
        reviewBatch: 'batch-1',
        sources: [
          {
            id: 'corpus',
            kind: 'r2',
            displayName: 'Corpus',
            locator: { bucket: 'research' },
            access: 'read-only',
            sensitivity: 'internal',
            allowedSlotKinds: ['data'],
            status: 'active',
            reviewNote: 'check later',
          },
        ],
      })
    );

    const snapshot = loadRuntimeConfig(dataRoot);
    expect(snapshot.workspaceDataSourceCatalogs[0]?.catalog).toMatchObject({
      reviewBatch: 'batch-1',
      sources: [{ reviewNote: 'check later' }],
    });
    for (const [key, location] of [
      ['reviewBatch', '$'],
      ['reviewNote', 'sources'],
    ]) {
      const warning = snapshot.diagnostics.find((diagnostic) => diagnostic.message.includes(key));
      expect(warning).toMatchObject({
        severity: 'warning',
        source: 'DATA_ROOT/workspaces/ws_demo/config/data-sources.jsonc',
      });
      expect(warning?.message).toContain(location);
    }
  });

  it('blocks an editor write that declares a registered but unsupported data-source feature', () => {
    const original = JSON.stringify({ schemaVersion: 1, sources: [] });
    const { dataRoot, path } = authoredFile(
      'workspaces/ws_demo/config/data-sources.jsonc',
      original
    );
    const manager = createRuntimeConfigManager({ dataRoot });
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'user_demo',
      workspaceIds: ['ws_demo'],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const id = 'workspaces/ws_demo/data-sources.jsonc';
    const content = JSON.stringify({
      schemaVersion: 1,
      requiredFeatures: ['workspace.mount.fuse'],
      sources: [],
    });

    const validation = files.validate({ files: [{ id, content }], mode: 'safe' });
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: id,
          severity: 'error',
          message: expect.stringContaining('workspace.mount.fuse'),
        }),
      ])
    );
    expect(() =>
      files.updateFile({
        id,
        kind: 'data-source',
        content,
        expectedRevision: files.readFile(id).file.revision,
      })
    ).toThrow(/workspace\.mount\.fuse/);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.each([
    {
      path: 'users/user_demo/config/user.jsonc',
      id: 'users/user_demo/user.jsonc',
      original: { schemaVersion: 1 },
      draft: { schemaVersion: 1, workspaces: [{ workspaceId: 'ws_demo', futurePreference: true }] },
      key: 'futurePreference',
    },
    {
      path: 'workspaces/ws_demo/config/workspace.jsonc',
      id: 'workspaces/ws_demo/workspace.jsonc',
      original: { schemaVersion: 1, workspace: { name: 'Demo' } },
      draft: {
        schemaVersion: 1,
        workspace: { name: 'Demo', internalRoles: [{ roleId: 'assistant', futureRoleHint: true }] },
      },
      key: 'futureRoleHint',
    },
    {
      path: 'workspaces/ws_demo/config/data-sources.jsonc',
      id: 'workspaces/ws_demo/data-sources.jsonc',
      original: { schemaVersion: 1, sources: [] },
      draft: { schemaVersion: 1, sources: [], reviewBatch: 'batch-1' },
      key: 'reviewBatch',
    },
  ])('reports one located editor warning for $id', ({ path, id, original, draft, key }) => {
    const { dataRoot } = authoredFile(path, JSON.stringify(original));
    const manager = createRuntimeConfigManager({ dataRoot });
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'user_demo',
      workspaceIds: ['ws_demo'],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });

    const validation = files.validate({
      files: [{ id, content: JSON.stringify(draft) }],
      mode: 'safe',
    });
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics.filter((diagnostic) => diagnostic.message.includes(key))).toEqual(
      [expect.objectContaining({ fileId: id, severity: 'warning' })]
    );
  });

  it.each([
    ['users/user_demo/config/user.jsonc', { schemaVersion: 1 }],
    [
      'workspaces/ws_demo/config/workspace.jsonc',
      { schemaVersion: 1, workspace: { name: 'Demo' } },
    ],
  ])('rejects unsupported required features in %s', (relativePath, base) => {
    const { dataRoot } = authoredFile(
      relativePath,
      JSON.stringify({ ...base, requiredFeatures: ['future.config.rule'] })
    );
    expect(() => loadRuntimeConfig(dataRoot)).toThrow(/future\.config\.rule/);
  });
});
