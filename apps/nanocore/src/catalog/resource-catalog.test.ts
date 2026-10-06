import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import {
  projectWorkspaceCatalogExport,
  reconstructImportedWorkspaceCatalog,
} from './catalog-portability.js';
import {
  CatalogForbiddenError,
  CatalogIntegrityError,
  catalogDocumentPath,
  createWorkspaceMcpConfig,
  importWorkspacePlugin,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  materializeCatalogTree,
  projectEffectiveWorkspaceMcpCatalog,
  replaceWorkspaceEffectiveMcpCatalog,
  selectWorkspaceMcpVersion,
  setWorkspaceSkillPin,
  submitWorkspaceSkillCandidate,
  updateWorkspaceMcpBinding,
} from './resource-catalog.js';

function skillTree(body = '# Hello\n'): Array<{
  contentBase64?: string;
  executable?: boolean;
  kind: 'directory' | 'file';
  path: string;
}> {
  return [
    { contentBase64: Buffer.from(body, 'utf8').toString('base64'), kind: 'file', path: 'SKILL.md' },
  ];
}

function writeStdioPluginPackage(packageRoot: string, scriptBody: string): void {
  mkdirSync(join(packageRoot, 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'plugin.json'),
    JSON.stringify({ name: 'demo-pack', version: '1.0.0' })
  );
  writeFileSync(join(packageRoot, 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');
  writeFileSync(join(packageRoot, 'scripts', 'run.sh'), scriptBody);
  writeFileSync(
    join(packageRoot, 'mcp.json'),
    JSON.stringify({
      mcpServers: { echo: { args: ['scripts/run.sh'], command: 'node' } },
    })
  );
}

function catalogHasStagingResidue(dataRoot: string, workspaceId: string): boolean {
  const root = join(dataRoot, 'workspaces', workspaceId, 'catalog');
  if (!existsSync(root)) {
    return false;
  }
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of readdirSync(current)) {
      if (name.endsWith('.staging')) {
        return true;
      }
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        pending.push(path);
      }
    }
  }
  return false;
}

describe('workspace resource catalog', () => {
  it('preserves every descriptive catalog annotation through revision mutations and reopening', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-extensions-'));
    const packageRoot = join(dataRoot, 'plugin-source');
    try {
      writeStdioPluginPackage(packageRoot, 'console.log("echo");');
      const imported = importWorkspacePlugin({
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        expectedRevision: 0,
        install: true,
        producer: { id: 'user_local', kind: 'user' },
        treeRoot: packageRoot,
        workspaceId: 'ws_demo',
      });
      const skill = imported.catalog.skills.versions[0]!;
      const pinned = setWorkspaceSkillPin({
        dataRoot,
        workspaceId: 'ws_demo',
        entryId: skill.entryId,
        digest: skill.digest,
        expectedRevision: imported.catalog.revision,
      });
      const candidate = submitWorkspaceSkillCandidate({
        baseDigest: skill.digest,
        createdAt: '2026-09-08T00:01:00.000Z',
        dataRoot,
        entryId: skill.entryId,
        expectedRevision: pinned.revision,
        producer: { id: 'agent_one', kind: 'agent' },
        summary: 'Improve the Skill',
        tree: skillTree('# Improved'),
        workspaceId: 'ws_demo',
      });
      const mcp = candidate.catalog.mcp.versions[0]!;
      expect(mcp.packageRootDigest).toBe(imported.version.digest);
      expect(mcp.digest).not.toBe(imported.version.digest);
      const selected = selectWorkspaceMcpVersion({
        dataRoot,
        workspaceId: 'ws_demo',
        entryId: mcp.entryId,
        digest: mcp.digest,
        expectedRevision: candidate.catalog.revision,
        stdioHostAuthorized: true,
      });
      const bound = updateWorkspaceMcpBinding({
        dataRoot,
        workspaceId: 'ws_demo',
        entryId: mcp.entryId,
        expectedRevision: selected.revision,
        binding: {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          revision: 0,
          schemaPolicy: 'tracking',
          pinnedSchemaSnapshotId: null,
          timeoutMs: 1000,
        },
      });
      const path = catalogDocumentPath(dataRoot, 'ws_demo');
      // Populate the override observation with a real package member, including its produced identity.
      bound.plugins.installations[0]!.memberOverrides.push(bound.plugins.versions[0]!.members[0]!);
      const extended = annotateCatalogHistory(bound);
      writeFileSync(path, JSON.stringify(extended));
      const loaded = loadWorkspaceResourceCatalog(dataRoot, 'ws_demo');
      expect(loaded).toEqual(bound);
      expect(JSON.stringify(loaded)).not.toContain('futureAnnotation');
      const effective = projectEffectiveWorkspaceMcpCatalog(loaded);
      expect(JSON.stringify(effective)).not.toContain('futureAnnotation');
      const beforeDigest = resolveWorkspaceMcpServer({
        catalog: projectEffectiveWorkspaceMcpCatalog(bound),
        serverId: mcp.entryId,
      }).catalogDigest;
      expect(
        resolveWorkspaceMcpServer({ catalog: effective, serverId: mcp.entryId }).catalogDigest
      ).toBe(beforeDigest);
      const next = setWorkspaceSkillPin({
        dataRoot,
        workspaceId: 'ws_demo',
        entryId: skill.entryId,
        digest: skill.digest,
        expectedRevision: loaded.revision,
      });
      expect(loadWorkspaceResourceCatalog(dataRoot, 'ws_demo')).toEqual(next);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        ...(extended as object),
        revision: next.revision,
      });
      const updated = updateWorkspaceMcpBinding({
        dataRoot,
        workspaceId: 'ws_demo',
        entryId: mcp.entryId,
        expectedRevision: next.revision,
        binding: { ...bound.mcp.bindings[0]!, timeoutMs: 2000 },
      });
      const reopened = loadWorkspaceResourceCatalog(dataRoot, 'ws_demo');
      expect(reopened.mcp.bindings[0]).toEqual({
        ...loaded.mcp.bindings[0],
        revision: 2,
        timeoutMs: 2000,
      });
      const retainedBinding = JSON.parse(readFileSync(path, 'utf8')).mcp.bindings[0];
      expect(retainedBinding).toEqual({
        ...(annotateCatalogHistory(loaded.mcp.bindings[0]) as object),
        revision: 2,
        timeoutMs: 2000,
      });
      expect(reopened.mcp.versions).toEqual(loaded.mcp.versions);
      expect(reopened.skills.versions).toEqual(loaded.skills.versions);
      expect(reopened.plugins.versions).toEqual(loaded.plugins.versions);
      expect(updated.revision).toBe(next.revision + 1);
      expect(() =>
        setWorkspaceSkillPin({
          dataRoot,
          workspaceId: 'ws_demo',
          entryId: skill.entryId,
          digest: skill.digest,
          expectedRevision: loaded.revision,
        })
      ).toThrow(/revision conflict/);
      const bad = structuredClone(reopened);
      Object.assign(bad.mcp.versions[0]!.declaration, { futureInstruction: 'execute' });
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadWorkspaceResourceCatalog(dataRoot, 'ws_demo')).toThrow();
      const corrupt = structuredClone(extended) as typeof bound;
      const declaration = corrupt.mcp.versions[0]!.declaration;
      if (declaration.kind !== 'stdio') throw new Error('Expected a produced stdio declaration');
      declaration.command = 'different-command';
      writeFileSync(path, JSON.stringify(corrupt));
      expect(() => loadWorkspaceResourceCatalog(dataRoot, 'ws_demo')).toThrow(
        /configuration digest mismatch/
      );
      for (const coreChange of [
        { schemaVersion: 2 },
        { revision: -1 },
        { futureAnnotation: 'Bearer sk-catalog-canary-not-a-real-secret' },
      ]) {
        writeFileSync(path, JSON.stringify({ ...(extended as object), ...coreChange }));
        expect(() => loadWorkspaceResourceCatalog(dataRoot, 'ws_demo')).toThrow();
      }
      const credentialChange = structuredClone(extended) as typeof bound;
      Object.assign(credentialChange.mcp.bindings[0]!, {
        credentialBindings: [
          {
            slot: 'token',
            vaultGrantId: 'grant_one',
            sink: { kind: 'env', name: 'TOKEN' },
            futureInstruction: true,
          },
        ],
      });
      writeFileSync(path, JSON.stringify(credentialChange));
      expect(() => loadWorkspaceResourceCatalog(dataRoot, 'ws_demo')).toThrow();
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('imports a Skill, pins it, and keeps candidate submission off the current pointer', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-'));
    try {
      const producer = { id: 'user_local', kind: 'user' as const };
      const created = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo Guidelines',
        expectedRevision: 0,
        producer,
        tree: skillTree('# v1\n'),
        workspaceId: 'ws_demo',
      });
      expect(created.version.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(created.catalog.skills.entries[0]?.currentDigest).toBe(created.version.digest);

      const pinned = setWorkspaceSkillPin({
        dataRoot,
        digest: created.version.digest,
        entryId: 'repo-guidelines',
        expectedRevision: created.catalog.revision,
        workspaceId: 'ws_demo',
      });
      const candidate = submitWorkspaceSkillCandidate({
        baseDigest: created.version.digest,
        createdAt: '2026-09-08T00:01:00.000Z',
        dataRoot,
        entryId: 'repo-guidelines',
        expectedRevision: pinned.revision,
        producer,
        summary: 'Clarify the rollback section.',
        tree: skillTree('# v2\n'),
        workspaceId: 'ws_demo',
      });
      const after = loadWorkspaceResourceCatalog(dataRoot, 'ws_demo');
      expect(after.skills.entries[0]?.currentDigest).toBe(created.version.digest);
      expect(candidate.candidate.disposition).toBe('proposed');
      expect(after.skills.pins[0]?.digest).toBe(created.version.digest);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it.each(['openkit-generative'])('rejects the reserved built-in %s catalog id', (id) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-reserved-'));
    try {
      expect(() =>
        createWorkspaceMcpConfig({
          createdAt: '2026-09-08T00:00:00.000Z',
          dataRoot,
          declaration: { args: ['fixtures/echo.mjs'], command: 'node', kind: 'stdio' },
          displayName: 'Generative',
          expectedRevision: 0,
          id,
          workspaceId: 'ws_demo',
        })
      ).toThrow(CatalogForbiddenError);
      expect(() =>
        replaceWorkspaceEffectiveMcpCatalog({
          dataRoot,
          workspaceId: 'ws_demo',
          catalog: {
            schemaVersion: 1,
            servers: [
              {
                id,
                enabled: true,
                allowedTools: ['echo'],
                deniedTools: [],
                approvalRequiredTools: [],
                credentialBindings: [],
                pinnedSchemaSnapshotId: null,
                schemaPolicy: 'tracking',
                timeoutMs: 1000,
                transport: {
                  kind: 'stdio',
                  command: 'node',
                  args: [],
                  cwd: null,
                  environment: {},
                  environmentValues: {},
                },
              },
            ],
          },
        })
      ).toThrow(CatalogForbiddenError);
      expect(loadWorkspaceResourceCatalog(dataRoot, 'ws_demo').mcp.entries).toEqual([]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'raw',
    'bearer',
  ] as const)('round-trips %s presentation through management, storage and the effective digest', (presentation) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-presentation-'));
    try {
      const created = createWorkspaceMcpConfig({
        createdAt: '2026-10-03T00:00:00.000Z',
        dataRoot,
        declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
        displayName: 'Echo',
        expectedRevision: 0,
        selectCurrent: true,
        workspaceId: 'ws_demo',
      });
      const credential = {
        presentation,
        slot: 'token',
        vaultGrantId: 'grant_canary',
        sink: { kind: 'header' as const, name: 'Authorization' },
      };
      const raw = updateWorkspaceMcpBinding({
        binding: {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [
            { slot: credential.slot, vaultGrantId: credential.vaultGrantId, sink: credential.sink },
          ],
          deniedTools: [],
          enabled: true,
          revision: 0,
          schemaPolicy: 'tracking',
          timeoutMs: 60_000,
        },
        dataRoot,
        entryId: 'echo',
        expectedRevision: created.catalog.revision,
        workspaceId: 'ws_demo',
      });
      const before = resolveWorkspaceMcpServer({
        catalog: projectEffectiveWorkspaceMcpCatalog(raw),
        serverId: 'echo',
      });
      const bound = updateWorkspaceMcpBinding({
        binding: { ...raw.mcp.bindings[0]!, credentialBindings: [credential] },
        dataRoot,
        entryId: 'echo',
        expectedRevision: raw.revision,
        workspaceId: 'ws_demo',
      });
      const retained = loadWorkspaceResourceCatalog(dataRoot, 'ws_demo');
      expect(retained.mcp.bindings[0]!.credentialBindings).toEqual([credential]);
      const after = resolveWorkspaceMcpServer({
        catalog: projectEffectiveWorkspaceMcpCatalog(retained),
        serverId: 'echo',
      });
      expect(after.credentialBindings).toEqual([credential]);
      expect(after.catalogDigest).not.toBe(before.catalogDigest);
      expect(retained.mcp.versions[0]!.digest).toBe(created.version.digest);
      expect(bound.mcp.bindings[0]!.revision).toBe(raw.mcp.bindings[0]!.revision + 1);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it.each([
    {
      field: 'auth',
      value: { CLIENT_ID: 'synthetic-client' },
      reason:
        'Upstream OAuth connection required; NanoCore OAuth onboarding and refresh are not implemented',
    },
    {
      field: 'query',
      value: { 'read-only': 'true' },
      reason: 'MCP HTTP query options are unsupported.',
    },
  ])('refuses foreign HTTP $field configuration before inert import publication', ({
    field,
    value,
    reason,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-plugin-deferred-'));
    const treeRoot = mkdtempSync(join(tmpdir(), 'openkit-plugin-source-'));
    try {
      writeFileSync(join(treeRoot, 'plugin.json'), JSON.stringify({ name: 'deferred' }));
      writeFileSync(
        join(treeRoot, 'mcp.json'),
        JSON.stringify({
          mcpServers: { echo: { url: 'https://mcp.example.test/mcp', [field]: value } },
        })
      );
      expect(() =>
        importWorkspacePlugin({
          createdAt: '2026-10-03T00:00:00.000Z',
          dataRoot,
          expectedRevision: 0,
          workspaceId: 'ws_demo',
          install: false,
          producer: { id: 'user_local', kind: 'user' },
          treeRoot,
        })
      ).toThrow(reason);
      expect(loadWorkspaceResourceCatalog(dataRoot, 'ws_demo').mcp.entries).toEqual([]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(treeRoot, { force: true, recursive: true });
    }
  });

  it('imports a foreign HTTP endpoint query string unchanged into the stored declaration and effective transport', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-plugin-query-'));
    const treeRoot = mkdtempSync(join(tmpdir(), 'openkit-plugin-source-'));
    const endpoint = 'https://mcp.example.test/mcp?read-only=true';
    try {
      writeFileSync(join(treeRoot, 'plugin.json'), JSON.stringify({ name: 'query-endpoint' }));
      writeFileSync(
        join(treeRoot, 'mcp.json'),
        JSON.stringify({ mcpServers: { echo: { url: endpoint } } })
      );
      importWorkspacePlugin({
        createdAt: '2026-10-03T00:00:00.000Z',
        dataRoot,
        expectedRevision: 0,
        workspaceId: 'ws_demo',
        install: false,
        producer: { id: 'user_local', kind: 'user' },
        treeRoot,
      });
      const retained = loadWorkspaceResourceCatalog(dataRoot, 'ws_demo');
      expect(retained.mcp.entries).toHaveLength(1);
      expect(retained.mcp.entries[0]!.id).toBe('echo');
      expect(retained.mcp.versions).toHaveLength(1);
      expect(retained.mcp.versions[0]!.declaration).toEqual({
        endpoint,
        headers: {},
        kind: 'http',
      });
      const selected = selectWorkspaceMcpVersion({
        dataRoot,
        digest: retained.mcp.versions[0]!.digest,
        entryId: 'echo',
        expectedRevision: retained.revision,
        workspaceId: 'ws_demo',
      });
      updateWorkspaceMcpBinding({
        binding: {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          revision: 0,
          schemaPolicy: 'tracking',
          timeoutMs: 60_000,
        },
        dataRoot,
        entryId: 'echo',
        expectedRevision: selected.revision,
        workspaceId: 'ws_demo',
      });
      const effective = projectEffectiveWorkspaceMcpCatalog(
        loadWorkspaceResourceCatalog(dataRoot, 'ws_demo')
      );
      expect(effective.servers).toHaveLength(1);
      expect(effective.servers[0]!.transport).toEqual({ endpoint, headers: {}, kind: 'http' });
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(treeRoot, { force: true, recursive: true });
    }
  });

  it('creates an inactive MCP config and projects an effective Gateway entry only after enablement', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-'));
    try {
      const created = createWorkspaceMcpConfig({
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        declaration: { args: ['fixtures/echo.mjs'], command: 'node', kind: 'stdio' },
        displayName: 'Echo',
        expectedRevision: 0,
        workspaceId: 'ws_demo',
      });
      expect(projectEffectiveWorkspaceMcpCatalog(created.catalog).servers).toEqual([]);
      const selected = selectWorkspaceMcpVersion({
        dataRoot,
        digest: created.version.digest,
        entryId: 'echo',
        expectedRevision: created.catalog.revision,
        workspaceId: 'ws_demo',
      });
      const bound = updateWorkspaceMcpBinding({
        binding: {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          revision: 0,
          schemaPolicy: 'tracking',
          timeoutMs: 60_000,
        },
        dataRoot,
        entryId: 'echo',
        expectedRevision: selected.revision,
        workspaceId: 'ws_demo',
      });
      const projected = projectEffectiveWorkspaceMcpCatalog(bound);
      expect(projected.servers).toHaveLength(1);
      expect(projected.servers[0]).toMatchObject({
        enabled: true,
        id: 'echo',
        transport: { command: 'node', kind: 'stdio' },
      });
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('imports a plugin package with two Skills and one MCP member', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-'));
    const packageRoot = mkdtempSync(join(tmpdir(), 'openkit-plugin-'));
    try {
      mkdirSync(join(packageRoot, 'skills', 'alpha'), { recursive: true });
      mkdirSync(join(packageRoot, 'skills', 'beta'), { recursive: true });
      writeFileSync(
        join(packageRoot, 'plugin.json'),
        JSON.stringify({ name: 'demo-pack', version: '1.0.0' })
      );
      writeFileSync(join(packageRoot, 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');
      writeFileSync(join(packageRoot, 'skills', 'beta', 'SKILL.md'), '# Beta\n');
      writeFileSync(
        join(packageRoot, 'mcp.json'),
        JSON.stringify({
          mcpServers: { echo: { args: ['fixtures/echo.mjs'], command: 'node' } },
        })
      );
      const imported = importWorkspacePlugin({
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        expectedRevision: 0,
        install: true,
        producer: { id: 'user_local', kind: 'user' },
        treeRoot: packageRoot,
        workspaceId: 'ws_demo',
      });
      expect(imported.version.members).toHaveLength(3);
      expect(imported.catalog.plugins.installations[0]?.selectedPackageKeys).toHaveLength(3);
      expect(imported.catalog.skills.entries.map((entry) => entry.id).sort()).toEqual([
        'alpha',
        'beta',
      ]);
      expect(imported.catalog.mcp.entries[0]?.currentVersionDigest).toBeNull();
      expect(imported.catalog.revision).toBe(1);
      expect(imported.catalog.mcp.versions[0]).toMatchObject({
        packageRootDigest: imported.version.digest,
        pluginVersionDigest: imported.version.digest,
      });
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it('exports Skill bytes and reconstructs an inactive target catalog', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-export-'));
    try {
      const created = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo Guidelines',
        expectedRevision: 0,
        producer: { id: 'user_local', kind: 'user' },
        tree: skillTree('# v1\n'),
        workspaceId: 'ws_demo',
      });
      setWorkspaceSkillPin({
        dataRoot,
        digest: created.version.digest,
        entryId: 'repo-guidelines',
        expectedRevision: created.catalog.revision,
        workspaceId: 'ws_demo',
      });
      const projection = projectWorkspaceCatalogExport(dataRoot, 'ws_demo');
      expect(projection.payloads).toHaveLength(1);
      const reconstructed = reconstructImportedWorkspaceCatalog(
        projection.catalog,
        new Map(projection.payloads.map((item) => [item.path, item.payload]))
      );
      expect(reconstructed.skills.entries[0]).toMatchObject({
        currentDigest: null,
        id: 'repo-guidelines',
      });
      expect(reconstructed.skills.pins).toEqual([]);
      expect(reconstructed.skills.versions).toHaveLength(1);
      expect(reconstructed.mcp.bindings).toEqual([]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects a portable Skill payload whose inventory disagrees with the retained tree', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-inventory-'));
    try {
      importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo Guidelines',
        expectedRevision: 0,
        producer: { id: 'user_local', kind: 'user' },
        tree: skillTree('# v1\n'),
        workspaceId: 'ws_demo',
      });
      const projection = projectWorkspaceCatalogExport(dataRoot, 'ws_demo');
      const payload = projection.payloads[0]?.payload;
      const version = projection.catalog.skills.versions[0];
      if (!payload || !version) {
        throw new Error('expected exported Skill payload');
      }
      const conflicting = {
        ...projection.catalog,
        skills: {
          ...projection.catalog.skills,
          versions: [
            {
              ...version,
              inventory: [
                {
                  executable: true,
                  kind: 'file' as const,
                  path: 'other.txt',
                  sha256: `sha256:${'a'.repeat(64)}`,
                  size: 999,
                },
              ],
            },
          ],
        },
      };
      expect(() =>
        reconstructImportedWorkspaceCatalog(
          conflicting,
          new Map([[projection.payloads[0]!.path, payload]])
        )
      ).toThrow(/inventory mismatch/);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('keeps MCP version identity scoped to the owning entry', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-mcp-scope-'));
    try {
      const declaration = { args: ['fixtures/echo.mjs'], command: 'node', kind: 'stdio' as const };
      const first = createWorkspaceMcpConfig({
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        declaration,
        displayName: 'Echo',
        expectedRevision: 0,
        workspaceId: 'ws_demo',
      });
      const second = createWorkspaceMcpConfig({
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        declaration,
        displayName: 'Echo Two',
        expectedRevision: first.catalog.revision,
        workspaceId: 'ws_demo',
      });
      expect(second.catalog.mcp.versions).toHaveLength(2);
      expect(second.catalog.mcp.versions.map((item) => item.entryId).sort()).toEqual([
        'echo',
        'echo-two',
      ]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('requires deployment-admin authority to select a new stdio version while enabled', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-stdio-admin-'));
    try {
      const created = createWorkspaceMcpConfig({
        allowedTools: ['echo'],
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        declaration: { args: ['fixtures/echo.mjs'], command: 'node', kind: 'stdio' },
        displayName: 'Echo',
        expectedRevision: 0,
        selectCurrent: true,
        workspaceId: 'ws_demo',
      });
      updateWorkspaceMcpBinding({
        binding: {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          pinnedSchemaSnapshotId: null,
          revision: 1,
          schemaPolicy: 'tracking',
          timeoutMs: 60_000,
        },
        dataRoot,
        entryId: 'echo',
        expectedRevision: created.catalog.revision,
        workspaceId: 'ws_demo',
      });
      const next = createWorkspaceMcpConfig({
        createdAt: '2026-09-08T00:01:00.000Z',
        dataRoot,
        declaration: { args: ['fixtures/other.mjs'], command: 'node', kind: 'stdio' },
        displayName: 'Echo',
        expectedRevision: created.catalog.revision + 1,
        id: 'echo',
        persist: true,
        selectCurrent: false,
        workspaceId: 'ws_demo',
      });
      expect(() =>
        selectWorkspaceMcpVersion({
          dataRoot,
          digest: next.version.digest,
          entryId: 'echo',
          expectedRevision: next.catalog.revision,
          workspaceId: 'ws_demo',
        })
      ).toThrow(CatalogForbiddenError);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('fails closed when catalog.json is missing after publication', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-integrity-'));
    try {
      importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo Guidelines',
        expectedRevision: 0,
        producer: { id: 'user_local', kind: 'user' },
        tree: skillTree('# v1\n'),
        workspaceId: 'ws_demo',
      });
      unlinkSync(join(dataRoot, 'workspaces', 'ws_demo', 'catalog', 'catalog.json'));
      expect(() => loadWorkspaceResourceCatalog(dataRoot, 'ws_demo')).toThrow(
        CatalogIntegrityError
      );
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects raw-secret-shaped HTTP headers on MCP admission', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-secret-'));
    try {
      expect(() =>
        createWorkspaceMcpConfig({
          createdAt: '2026-09-08T00:00:00.000Z',
          dataRoot,
          declaration: {
            endpoint: 'https://example.invalid/mcp',
            headers: { Authorization: 'Bearer sk-audit-canary-not-a-real-secret' },
            kind: 'http',
          },
          displayName: 'Remote',
          expectedRevision: 0,
          workspaceId: 'ws_demo',
        })
      ).toThrow(/raw-secret/);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('changes catalogDigest when plugin scripts change but MCP command arguments stay the same', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-plugin-digest-'));
    const packageRoot = mkdtempSync(join(tmpdir(), 'openkit-plugin-digest-'));
    try {
      writeStdioPluginPackage(packageRoot, 'echo v1\n');
      const first = importWorkspacePlugin({
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        expectedRevision: 0,
        install: true,
        producer: { id: 'user_local', kind: 'user' },
        treeRoot: packageRoot,
        workspaceId: 'ws_demo',
      });
      const firstVersion = first.catalog.mcp.versions.find(
        (item) => item.packageRootDigest === first.version.digest
      );
      if (!firstVersion) {
        throw new Error('expected first plugin MCP version');
      }
      const selected = selectWorkspaceMcpVersion({
        dataRoot,
        digest: firstVersion.digest,
        entryId: 'echo',
        expectedRevision: first.catalog.revision,
        workspaceId: 'ws_demo',
      });
      const bound = updateWorkspaceMcpBinding({
        binding: {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          revision: 0,
          schemaPolicy: 'tracking',
          timeoutMs: 60_000,
        },
        dataRoot,
        entryId: 'echo',
        expectedRevision: selected.revision,
        workspaceId: 'ws_demo',
      });
      const firstDigest = resolveWorkspaceMcpServer({
        catalog: projectEffectiveWorkspaceMcpCatalog(bound),
        serverId: 'echo',
      }).catalogDigest;
      writeFileSync(join(packageRoot, 'scripts', 'run.sh'), 'echo v2\n');
      const second = importWorkspacePlugin({
        createdAt: '2026-09-08T00:00:01.000Z',
        dataRoot,
        expectedRevision: bound.revision,
        install: true,
        producer: { id: 'user_local', kind: 'user' },
        treeRoot: packageRoot,
        workspaceId: 'ws_demo',
      });
      const secondVersion = second.catalog.mcp.versions.find(
        (item) => item.packageRootDigest === second.version.digest
      );
      if (!secondVersion) {
        throw new Error('expected second plugin MCP version');
      }
      expect(secondVersion.digest).not.toBe(firstVersion.digest);
      const reselected = selectWorkspaceMcpVersion({
        dataRoot,
        digest: secondVersion.digest,
        entryId: 'echo',
        expectedRevision: second.catalog.revision,
        stdioHostAuthorized: true,
        workspaceId: 'ws_demo',
      });
      const projected = projectEffectiveWorkspaceMcpCatalog(reselected);
      expect(projected.servers[0]?.packageRootDigest).toBe(second.version.digest);
      expect(projected.servers[0]?.transport).toMatchObject({
        args: ['scripts/run.sh'],
        command: 'node',
      });
      expect(
        resolveWorkspaceMcpServer({ catalog: projected, serverId: 'echo' }).catalogDigest
      ).not.toBe(firstDigest);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it('does not leave failed snapshot staging that blocks later catalog reads', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-staging-'));
    try {
      expect(() =>
        importWorkspaceSkill({
          activate: false,
          createdAt: '2026-09-08T00:00:00.000Z',
          dataRoot,
          displayName: 'Broken Tree',
          expectedRevision: 0,
          producer: { id: 'user_local', kind: 'user' },
          tree: [
            {
              contentBase64: Buffer.from('# Skill\n', 'utf8').toString('base64'),
              kind: 'file',
              path: 'SKILL.md',
            },
            {
              contentBase64: Buffer.from('not-a-directory\n', 'utf8').toString('base64'),
              kind: 'file',
              path: 'scripts',
            },
            {
              contentBase64: Buffer.from('#!/bin/sh\n', 'utf8').toString('base64'),
              kind: 'file',
              path: 'scripts/run.sh',
            },
          ],
          workspaceId: 'ws_demo',
        })
      ).toThrow();
      expect(catalogHasStagingResidue(dataRoot, 'ws_demo')).toBe(false);
      const afterFailure = loadWorkspaceResourceCatalog(dataRoot, 'ws_demo');
      expect(afterFailure.revision).toBe(0);
      expect(afterFailure.skills.entries).toEqual([]);
      const recovered = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Broken Tree',
        expectedRevision: 0,
        producer: { id: 'user_local', kind: 'user' },
        tree: skillTree('# recovered\n'),
        workspaceId: 'ws_demo',
      });
      expect(recovered.catalog.revision).toBe(1);
      expect(recovered.catalog.skills.entries[0]?.currentDigest).toBe(recovered.version.digest);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('ignores leftover snapshot staging when catalog.json is unpublished', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-orphan-staging-'));
    try {
      const staged = join(
        dataRoot,
        'workspaces',
        'ws_demo',
        'catalog',
        'skill-snapshots',
        'broken',
        `${'a'.repeat(64)}.staging`
      );
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(staged, 'SKILL.md'), '# leftover\n');
      const catalog = loadWorkspaceResourceCatalog(dataRoot, 'ws_demo');
      expect(catalog.revision).toBe(0);
      expect(catalog.skills.entries).toEqual([]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects plugin upload paths that escape the staging root', () => {
    const staging = mkdtempSync(join(tmpdir(), 'openkit-plugin-stage-'));
    try {
      expect(() =>
        materializeCatalogTree(staging, [
          {
            contentBase64: Buffer.from('x').toString('base64'),
            kind: 'file',
            path: '../../outside.txt',
          },
        ])
      ).toThrow(/parent path/);
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
  });
});

/** Extends descriptive catalog facts, leaving executable declarations and credentials exact. */
function annotateCatalogHistory(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(annotateCatalogHistory);
  if (value && typeof value === 'object')
    return Object.fromEntries([
      ...Object.entries(value).map(([key, child]) => [
        key,
        key === 'declaration' || key === 'credentialBindings'
          ? child
          : annotateCatalogHistory(child),
      ]),
      ['futureAnnotation', 'retained'],
    ]);
  return value;
}
