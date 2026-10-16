import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  catalogDocumentPath,
  composeWorkspaceMcpCatalog,
  createMcpConfig,
  loadWorkspaceResourceCatalog,
  projectEffectiveWorkspaceMcpCatalog,
  updateMcpBinding,
} from './resource-catalog.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Produces an explicitly scoped Workspace catalog and its independently fixed raw-binding digest. */
function workspaceCatalog() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-scope-'));
  roots.push(dataRoot);
  const workspaceId = testEntityId('ws', 'retained-workspace');
  const created = createMcpConfig({
    dataRoot,
    owner: { kind: 'workspace', workspaceId },
    id: 'echo',
    displayName: 'Echo',
    expectedRevision: 0,
    createdAt: '2026-10-16T00:00:00.000Z',
    selectCurrent: true,
    allowedTools: ['echo'],
    declaration: { kind: 'http', endpoint: 'https://mcp.example.test/mcp' },
  });
  const binding = created.catalog.mcp.bindings[0]!;
  const catalog = updateMcpBinding({
    dataRoot,
    owner: { kind: 'workspace', workspaceId },
    entryId: 'echo',
    expectedRevision: created.catalog.revision,
    binding: {
      ...binding,
      enabled: true,
      credentialBindings: [
        {
          slot: 'token',
          // This fixed canonical grant is part of the independently calculated digest below.
          vaultGrantId: 'grant_00000000-0000-7a77-8a56-84fc4fb5c8ba',
          sink: { kind: 'header', name: 'Authorization' },
        },
      ],
    },
  });
  const retained = JSON.parse(JSON.stringify(catalog));
  retained.futureDescription = { retained: true };
  const path = catalogDocumentPath(dataRoot, workspaceId);
  const bytes = `${JSON.stringify(retained, null, 2)}\n`;
  writeFileSync(path, bytes);
  return { dataRoot, workspaceId, path, bytes, retained };
}

describe('one scoped resource catalog owner', () => {
  it('observes absent catalogs without creating a Workspace directory', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-read-only-'));
    roots.push(dataRoot);
    const workspaceId = testEntityId('ws', 'deleted-workspace');
    loadWorkspaceResourceCatalog(dataRoot, workspaceId);
    composeWorkspaceMcpCatalog({
      dataRoot,
      workspaceId,
      workspaceCatalog: { schemaVersion: 1, servers: [] },
    });
    expect(existsSync(join(dataRoot, 'workspaces', workspaceId))).toBe(false);
  });

  it('roundtrips explicit Workspace scope without rewriting reads or changing resource identity', () => {
    const f = workspaceCatalog();
    const loaded = loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId);
    expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
    expect(loaded).toHaveProperty('scope', 'workspace');
    expect(
      resolveWorkspaceMcpServer({
        catalog: projectEffectiveWorkspaceMcpCatalog(loaded),
        serverId: 'echo',
      }).catalogDigest
    ).toBe('sha256:822279732d3a4eb33062c7ade755dbc87956c52d7eb587033f81f23c8ef1b188');
    updateMcpBinding({
      dataRoot: f.dataRoot,
      owner: { kind: 'workspace', workspaceId: f.workspaceId },
      expectedRevision: loaded.revision,
      entryId: 'echo',
      binding: loaded.mcp.bindings[0]!,
    });
    const written = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(written).toEqual({
      ...f.retained,
      revision: loaded.revision + 1,
      mcp: {
        ...f.retained.mcp,
        bindings: [
          {
            ...f.retained.mcp.bindings[0],
            revision: f.retained.mcp.bindings[0].revision + 1,
          },
        ],
      },
    });
    expect(
      resolveWorkspaceMcpServer({
        catalog: projectEffectiveWorkspaceMcpCatalog(
          loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)
        ),
        serverId: 'echo',
      }).catalogDigest
    ).toBe('sha256:822279732d3a4eb33062c7ade755dbc87956c52d7eb587033f81f23c8ef1b188');
  });

  it('rejects missing Workspace scope without converting the catalog', () => {
    const f = workspaceCatalog();
    const document = { ...f.retained };
    delete document.scope;
    const bytes = JSON.stringify(document);
    writeFileSync(f.path, bytes);
    expect(() => loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  });

  it.each([
    'server',
    'unknown',
  ])('rejects a misplaced or unknown %s scope without rewriting it', (scope) => {
    const f = workspaceCatalog();
    const bytes = JSON.stringify({ ...f.retained, scope });
    writeFileSync(f.path, bytes);
    expect(() => loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  });
});
