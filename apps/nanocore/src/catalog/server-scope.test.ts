import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { afterEach, describe, expect, it } from 'vitest';
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

/** Produces the existing retained Workspace shape and its independently fixed raw-binding digest. */
function retainedWorkspace() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-scope-'));
  roots.push(dataRoot);
  const workspaceId = 'retained-workspace';
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
          vaultGrantId: 'grant_canary',
          sink: { kind: 'header', name: 'Authorization' },
        },
      ],
    },
  });
  const retained = JSON.parse(JSON.stringify(catalog));
  delete retained.scope;
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
    const workspaceId = 'deleted-workspace';
    loadWorkspaceResourceCatalog(dataRoot, workspaceId);
    composeWorkspaceMcpCatalog({
      dataRoot,
      workspaceId,
      workspaceCatalog: { schemaVersion: 1, servers: [] },
    });
    expect(existsSync(join(dataRoot, 'workspaces', workspaceId))).toBe(false);
  });

  it('preserves retained Workspace bytes on read and adds scope only on authorized CAS', () => {
    const f = retainedWorkspace();
    const loaded = loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId);
    expect(readFileSync(f.path, 'utf8')).toBe(f.bytes);
    expect(loaded).toHaveProperty('scope', 'workspace');
    expect(
      resolveWorkspaceMcpServer({
        catalog: projectEffectiveWorkspaceMcpCatalog(loaded),
        serverId: 'echo',
      }).catalogDigest
    ).toBe('sha256:ece03620450bfab5be716543f17a1e8f7846e24d9cd612a245f8bcd6a2cd5df5');
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
      scope: 'workspace',
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
    ).toBe('sha256:ece03620450bfab5be716543f17a1e8f7846e24d9cd612a245f8bcd6a2cd5df5');
  });

  it.each([
    'server',
    'unknown',
  ])('rejects a misplaced or unknown %s scope without rewriting it', (scope) => {
    const f = retainedWorkspace();
    const bytes = JSON.stringify({ ...f.retained, scope });
    writeFileSync(f.path, bytes);
    expect(() => loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  });
});
