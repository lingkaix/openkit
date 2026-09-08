import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  projectWorkspaceCatalogExport,
  reconstructImportedWorkspaceCatalog,
} from './catalog-portability.js';
import {
  CatalogForbiddenError,
  CatalogIntegrityError,
  createWorkspaceMcpConfig,
  importWorkspacePlugin,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  materializeCatalogTree,
  projectEffectiveWorkspaceMcpCatalog,
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

describe('workspace resource catalog', () => {
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
