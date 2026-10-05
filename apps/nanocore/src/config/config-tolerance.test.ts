import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_BUILD_CONTEXT_DIGEST, EMPTY_BUILD_CONTEXT_REF } from '@openkit/config-schema';

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

/** Known authored envelopes used to observe real schema-to-loader-to-snapshot composition. */
const descriptiveFixtures = {
  gateway: {
    file: 'gateway.jsonc',
    value: {
      schemaVersion: 1,
      logicalModels: [
        {
          id: 'tier',
          displayName: 'Tier',
          routing: { autoFailover: true },
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [{ id: 'route', providerProfileId: 'missing', providerModel: 'model' }],
        },
      ],
    },
    locations: [
      [],
      ['logicalModels', 0],
      ['logicalModels', 0, 'routing'],
      ['logicalModels', 0, 'contextManagement', 0],
      ['logicalModels', 0, 'routes', 0],
    ],
  },
  provider: {
    file: 'providers/future.provider.jsonc',
    value: {
      id: 'future',
      displayName: 'Future',
      kind: 'custom',
      models: ['native.model'],
      modelMetadata: {
        'native.model': {
          limit: { context: 32000, output: 1000 },
          cost: { input: 0 },
          modalities: { input: ['text'] },
        },
      },
      readiness: { status: 'ready' },
    },
    locations: [
      [],
      ['readiness'],
      ['modelMetadata', 'native.model'],
      ['modelMetadata', 'native.model', 'limit'],
      ['modelMetadata', 'native.model', 'cost'],
      ['modelMetadata', 'native.model', 'modalities'],
    ],
  },
  'model-catalog': {
    file: 'model-catalog.jsonc',
    value: {
      schemaVersion: 1,
      providers: {
        vendor: {
          models: {
            'native.model': {
              limit: { context: 32000 },
              cost: { input: 0 },
              modalities: { input: ['text'] },
            },
          },
        },
      },
    },
    locations: [
      [],
      ['providers', 'vendor'],
      ['providers', 'vendor', 'models', 'native.model'],
      ['providers', 'vendor', 'models', 'native.model', 'limit'],
      ['providers', 'vendor', 'models', 'native.model', 'cost'],
      ['providers', 'vendor', 'models', 'native.model', 'modalities'],
    ],
  },
  'internal-role': {
    file: 'internal-role-profiles.jsonc',
    value: {
      schemaVersion: 1,
      profiles: [
        {
          id: 'assistant',
          roleId: 'assistant',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 120000 },
        },
      ],
    },
    locations: [[], ['profiles', 0]],
  },
  agent: {
    file: 'agents/future.agent.jsonc',
    value: {
      schemaVersion: 1,
      id: 'agent_future',
      displayName: 'Future',
      models: { preferredLogicalModelId: 'tier', allowedLogicalModelIds: ['tier'] },
      runtime: {
        kind: 'future-runtime',
        adapter: 'future-adapter',
        image: { kind: 'reference', ref: 'test:image', pullPolicy: 'never' },
        binaries: [{ id: 'shim', path: '/usr/local/bin/shim' }],
      },
      profiles: [{ id: 'default', skills: [{ id: 'skill' }], mcp: [{ id: 'mcp' }] }],
      readiness: { status: 'ready' },
      workspace: { root: '.' },
      sandbox: { network: [], backend: { preferred: 'openshell' } },
    },
    locations: [[], ['runtime'], ['runtime', 'image'], ['models'], ['profiles', 0], ['readiness']],
  },
};

/** Selects a fixture object without conflating map keys and path syntax. */
function atPath(value: unknown, path: readonly (string | number)[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') throw new Error(`Missing fixture path: ${path}`);
    current = (current as Record<string, unknown>)[String(key)];
  }
  if (!current || typeof current !== 'object' || Array.isArray(current))
    throw new Error(`Not a fixture object: ${path}`);
  return current as Record<string, unknown>;
}

/** Selects only the effective authored surface, excluding timestamps and warning diagnostics. */
function effectiveConfig(snapshot: ReturnType<typeof loadRuntimeConfig>, kind: string): unknown {
  switch (kind) {
    case 'gateway':
      return snapshot.gatewayConfig;
    case 'provider':
      return snapshot.providerRegistry.get('future');
    case 'model-catalog':
      return snapshot.modelCatalog;
    case 'internal-role':
      return snapshot.internalRoleProfiles;
    default:
      return snapshot.agentManifests;
  }
}

const descriptiveCases = Object.entries(descriptiveFixtures).flatMap(([kind, fixture]) =>
  fixture.locations.map((location) => ({
    kind,
    file: fixture.file,
    value: fixture.value,
    location,
  }))
);

/** Independent expected JSON location, including consumed identifiers with punctuation. */
function jsonLocation(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (parent, key) =>
      typeof key === 'number'
        ? `${parent}[${key}]`
        : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
          ? `${parent}.${key}`
          : `${parent}[${JSON.stringify(key)}]`,
    '$'
  );
}

describe('descriptive configuration extension loading', () => {
  it.each(
    descriptiveCases
  )('strips and warns through snapshot, reload and editing for $kind at $location', ({
    kind,
    file,
    value,
    location,
  }) => {
    const { dataRoot, path } = authoredFile(`config/${file}`, JSON.stringify(value));
    const manager = createRuntimeConfigManager({ dataRoot });
    const before = manager.current();
    const draft = structuredClone(value);
    atPath(draft, location)['future.note'] = { secret: 'ignored-private-canary' };
    const content = JSON.stringify(draft);
    writeFileSync(path, content);
    const candidate = loadRuntimeConfig(dataRoot);
    expect(effectiveConfig(candidate, kind)).toEqual(effectiveConfig(before, kind));
    expect(candidate.contentHash).toBe(before.contentHash);
    const expectedPath = `${jsonLocation(location)}["future.note"]`;
    expect(
      candidate.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'authored_config.unknown_key'
      )
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        source: expect.stringContaining(file),
        message: `Unknown configuration key "future.note" at ${expectedPath} was ignored.`,
      }),
    ]);
    const reloaded = manager.reload({ mode: 'safe', dryRun: false });
    expect(reloaded.status).toBe('applied');
    expect(reloaded.plan.warnings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining(expectedPath) })
    );
    expect(effectiveConfig(manager.current(), kind)).toEqual(effectiveConfig(before, kind));
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'user_demo',
      workspaceIds: [],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const validation = files.validate({ files: [{ id: file, content }], mode: 'safe' });
    expect(validation.valid).toBe(true);
    expect(
      validation.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'authored_config.unknown_key'
      )
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'authored_config.unknown_key',
        jsonPath: expectedPath,
      }),
    ]);
    files.updateFile({
      id: file,
      kind: kind as Parameters<typeof files.updateFile>[0]['kind'],
      content,
      expectedRevision: files.readFile(file).file.revision,
    });
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(
      JSON.stringify([
        ...candidate.diagnostics,
        ...validation.diagnostics,
        ...reloaded.plan.warnings,
      ])
    ).not.toContain('ignored-private-canary');
  });

  it('strips a descriptive build-image key while retaining exact build inputs', () => {
    const draft = structuredClone(descriptiveFixtures.agent.value);
    const content = 'FROM scratch';
    atPath(draft, ['runtime']).image = {
      kind: 'build',
      contextRef: EMPTY_BUILD_CONTEXT_REF,
      contextDigest: EMPTY_BUILD_CONTEXT_DIGEST,
      input: {
        kind: 'dockerfile',
        content,
        digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      },
      egress: [{ host: 'example.com', port: 443 }],
      layerLimit: 1,
      outputLimitBytes: 1024,
      timeLimitSeconds: 30,
      futureNote: 'ignored-private-canary',
    };
    const { dataRoot } = authoredFile('config/agents/future.agent.jsonc', JSON.stringify(draft));
    const loaded = loadAgentManifests(dataRoot);
    expect(loaded.manifests).toHaveLength(1);
    expect(loaded.manifests[0]?.runtime.image).not.toHaveProperty('futureNote');
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('$.runtime.image.futureNote'),
      }),
    ]);
    expect(loadRuntimeConfig(dataRoot).agentManifests).toEqual(loaded.manifests);
  });

  it.each([
    { kind: 'provider', location: ['extensions', 'openkit'], field: 'futureRule', value: true },
    { kind: 'agent', location: [], field: 'vault', value: { futureRule: true } },
    { kind: 'agent', location: [], field: 'policy', value: { futureRule: true } },
    { kind: 'agent', location: [], field: 'providers', value: { futureRule: true } },
    { kind: 'agent', location: [], field: 'tools', value: { futureRule: true } },
    { kind: 'agent', location: [], field: 'scale', value: { futureRule: true } },
    {
      kind: 'agent',
      location: ['runtime'],
      field: 'image',
      value: {
        arguments: {},
        contextDigest: EMPTY_BUILD_CONTEXT_DIGEST,
        contextRef: EMPTY_BUILD_CONTEXT_REF,
        egress: [{ host: 'example.com', port: 443 }],
        input: {
          kind: 'dockerfile',
          content: 'FROM scratch',
          digest: `sha256:${createHash('sha256').update('FROM scratch').digest('hex')}`,
        },
        layerLimit: 1,
        outputLimitBytes: 1024,
        timeLimitSeconds: 30,
        kind: 'reference',
        ref: 'test:image',
        pullPolicy: 'never',
      },
    },
    { kind: 'agent', location: ['sandbox'], field: 'futureRule', value: true },
    { kind: 'agent', location: ['sandbox', 'backend'], field: 'futureRule', value: true },
    { kind: 'agent', location: ['workspace'], field: 'futureRule', value: true },
    { kind: 'agent', location: ['profiles', 0, 'mcp', 0], field: 'futureRule', value: true },
    { kind: 'agent', location: ['profiles', 0, 'skills', 0], field: 'futureRule', value: true },
    {
      kind: 'internal-role',
      location: ['profiles', 0, 'limits'],
      field: 'futureRule',
      value: true,
    },
    {
      kind: 'gateway',
      location: ['logicalModels', 0, 'contextManagement', 0],
      field: 'type',
      value: 'future',
    },
    { kind: 'provider', location: [], field: 'kind', value: 'future' },
    {
      kind: 'provider',
      location: ['modelMetadata', 'native.model', 'limit'],
      field: 'context',
      value: 0,
    },
    { kind: 'model-catalog', location: [], field: 'schemaVersion', value: 2 },
    { kind: 'agent', location: ['models'], field: 'reasoningEffort', value: 'future' },
    { kind: 'agent', location: ['runtime', 'image'], field: 'pullPolicy', value: 'future' },
    { kind: 'agent', location: ['readiness'], field: 'status', value: 'future' },
    { kind: 'internal-role', location: ['profiles', 0, 'limits'], field: 'deadlineMs', value: -1 },
  ])('refuses authority additions or invalid core values on reload for $kind at $location for $field', ({
    kind,
    location,
    field,
    value,
  }) => {
    const fixture = descriptiveFixtures[kind as keyof typeof descriptiveFixtures];
    const { dataRoot, path } = authoredFile(
      `config/${fixture.file}`,
      JSON.stringify(fixture.value)
    );
    const manager = createRuntimeConfigManager({ dataRoot });
    const before = manager.current();
    const draft = structuredClone(fixture.value);
    if (kind === 'provider' && field === 'futureRule')
      atPath(draft, []).extensions = { openkit: {} };
    atPath(draft, location)[field] = value;
    writeFileSync(path, JSON.stringify(draft));
    const result = manager.reload({ mode: 'safe', dryRun: false });
    expect(result.status).toBe('failed');
    expect(manager.current()).toBe(before);
    const files = new RuntimeConfigFileService({
      dataRoot,
      userId: 'user_demo',
      workspaceIds: [],
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    expect(
      files.validate({
        files: [{ id: fixture.file, content: JSON.stringify(draft) }],
        mode: 'safe',
      }).valid
    ).toBe(false);
  });
});
