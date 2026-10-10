import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createRuntimeConfigManager, loadRuntimeConfig } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const MESSAGE =
  'Only credential-free remote Git sources can be materialized into a work slot in this release. Folder and other source kinds are not supported yet. Work without a source input still runs.';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Exercises the actual file owner with authored catalogs, including edits before reload. */
function fixture(withOtherWorkspace = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-source-selection-'));
  roots.push(dataRoot);
  const store = createDemoStore({ dataRoot });
  const otherWorkspaceId = withOtherWorkspace ? store.createWorkspace('Other team').id : null;
  const write = (id: string, content: string) => {
    const path = join(
      dataRoot,
      id.startsWith('workspaces/') ? id.replace(/\/([^/]+\.jsonc)$/, '/config/$1') : `config/${id}`
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  write(
    'workspaces/ws_demo/workspace.jsonc',
    JSON.stringify({ workspace: { name: 'Team', roots: [] } })
  );
  const manager = createRuntimeConfigManager({ initialSnapshot: loadRuntimeConfig(dataRoot) });
  const files = new RuntimeConfigFileService({
    dataRoot,
    workspaceIds: ['ws_demo', ...(otherWorkspaceId ? [otherWorkspaceId] : [])],
    userId: 'user_local',
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  return { dataRoot, files, write, store, otherWorkspaceId };
}

/** A selected source uses the existing manifest and catalog contracts. */
function agent(inputs: unknown[], agentId = 'agent_team_fixture') {
  return JSON.stringify({
    ...createTestAgentSetup({ agentId }).manifest,
    workspace: { inputs },
  });
}
/** Creates a bounded catalog source whose kind drives materialization admission. */
function catalog(kind: string, id = 'documents') {
  return JSON.stringify({
    schemaVersion: 1,
    sources: [
      {
        id,
        kind,
        displayName: 'Documents',
        access: 'read-write',
        sensitivity: 'internal',
        allowedSlotKinds: ['worktree'],
        status: 'active',
        locator:
          kind === 'git'
            ? { url: 'https://git.example.test/team.git', commit: 'a'.repeat(40) }
            : { path: 'files/contracts' },
      },
    ],
  });
}
const selection = [{ id: 'documents', sourceRef: 'documents', access: 'read-write' }];

describe('configuration-stage work-slot source refusal', () => {
  it.each([
    ['create', 'agent-first'],
    ['create', 'catalog-first'],
    ['update', 'agent-first'],
    ['update', 'catalog-first'],
  ] as const)('accepts shared Git/folder docs on both %s writes in %s order', (mode, order) => {
    const f = fixture(true);
    f.write('workspaces/ws_demo/data-sources.jsonc', catalog('git', 'docs'));
    const agentId = 'agents/team.agent.jsonc';
    const catalogId = `workspaces/${f.otherWorkspaceId}/data-sources.jsonc`;
    if (mode === 'update') {
      f.write(agentId, agent([]));
      f.write(catalogId, JSON.stringify({ schemaVersion: 1, sources: [] }));
    }
    const inputs = [
      {
        id: agentId,
        kind: 'agent' as const,
        content: agent([{ id: 'docs', sourceRef: 'docs', access: 'read-write' }]),
      },
      { id: catalogId, kind: 'data-source' as const, content: catalog('workspace-dir', 'docs') },
    ];
    if (order === 'catalog-first') inputs.reverse();
    for (const input of inputs) {
      const result =
        mode === 'create'
          ? f.files.createFile(input)
          : f.files.updateFile({
              ...input,
              expectedRevision: f.files.readFile(input.id).file.revision,
            });
      expect(result.file.exists).toBe(true);
      expect(f.files.readFile(input.id).content).toBe(input.content);
    }
  });

  it.each([
    ['create', 'agent'],
    ['update', 'agent'],
    ['create', 'data-source'],
    ['update', 'data-source'],
  ] as const)('refuses only-folder docs before the %s %s write changes bytes', (mode, kind) => {
    const f = fixture(true);
    f.write('workspaces/ws_demo/data-sources.jsonc', catalog('workspace-dir', 'docs'));
    const agentId = 'agents/team.agent.jsonc';
    const catalogId = `workspaces/${f.otherWorkspaceId}/data-sources.jsonc`;
    const selected = agent([{ id: 'docs', sourceRef: 'docs', access: 'read-write' }]);
    if (kind === 'agent') f.write(catalogId, catalog('workspace-dir', 'docs'));
    else f.write(agentId, selected);
    const id = kind === 'agent' ? agentId : catalogId;
    const content = kind === 'agent' ? selected : catalog('workspace-dir', 'docs');
    const previous = kind === 'agent' ? agent([]) : catalog('git', 'docs');
    if (mode === 'update') f.write(id, previous);
    const input = {
      id,
      kind,
      content,
      expectedRevision: mode === 'update' ? f.files.readFile(id).file.revision : null,
    };
    expect(() =>
      mode === 'create' ? f.files.createFile(input) : f.files.updateFile(input)
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        message: MESSAGE,
        status: 409,
      })
    );
    const path = join(
      f.dataRoot,
      kind === 'agent' ? `config/${id}` : id.replace(/\/([^/]+\.jsonc)$/, '/config/$1')
    );
    expect(existsSync(path)).toBe(mode === 'update');
    if (mode === 'update') expect(readFileSync(path, 'utf8')).toBe(previous);
  });

  it.each([
    ['create', 'inline'],
    ['update', 'inline'],
    ['create', 'sourceRef'],
    ['update', 'sourceRef'],
  ] as const)('accepts an unrelated Agent %s while an authored %s selection still refuses its own write', (mode, shape) => {
    const f = fixture();
    f.write('workspaces/ws_demo/data-sources.jsonc', catalog('workspace-dir'));
    const unsupportedId = 'agents/team.agent.jsonc';
    const unsupported = agent(
      shape === 'sourceRef'
        ? selection
        : [
            {
              id: 'documents',
              access: 'read-write',
              source: { kind: 'workspace-dir', pathRef: 'files/contracts' },
            },
          ]
    );
    const unsupportedPath = f.write(unsupportedId, unsupported);
    const id = 'agents/other.agent.jsonc';
    const content = agent([], 'agent_other_fixture');
    if (mode === 'update') f.write(id, content);
    const input = { id, kind: 'agent' as const, content };
    const written =
      mode === 'create'
        ? f.files.createFile(input)
        : f.files.updateFile({
            ...input,
            expectedRevision: f.files.readFile(id).file.revision,
          });
    expect(written.file.exists).toBe(true);
    expect(f.files.readFile(id).content).toBe(content);
    expect(() =>
      f.files.updateFile({
        id: unsupportedId,
        kind: 'agent',
        content: unsupported,
        expectedRevision: f.files.readFile(unsupportedId).file.revision,
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        message: MESSAGE,
        status: 409,
      })
    );
    expect(readFileSync(unsupportedPath, 'utf8')).toBe(unsupported);
  });

  it.each([
    'create',
    'update',
  ] as const)('refuses a non-Git Agent input before %s stores bytes', (mode) => {
    const f = fixture();
    f.write('workspaces/ws_demo/data-sources.jsonc', catalog('workspace-dir'));
    const id = 'agents/team.agent.jsonc';
    const previous = agent([]);
    const path = mode === 'update' ? f.write(id, previous) : join(f.dataRoot, 'config', id);
    const input = {
      id,
      kind: 'agent' as const,
      content: agent(selection),
      expectedRevision: mode === 'update' ? f.files.readFile(id).file.revision : null,
    };
    expect(() =>
      mode === 'create' ? f.files.createFile(input) : f.files.updateFile(input)
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        message: MESSAGE,
        status: 409,
      })
    );
    expect(existsSync(path)).toBe(mode === 'update');
    if (mode === 'update') expect(readFileSync(path, 'utf8')).toBe(previous);
  });

  it.each([
    'create',
    'update',
  ] as const)('refuses a configured folder root before %s stores bytes', (mode) => {
    const f = fixture();
    const id = 'workspaces/ws_demo/workspace.jsonc';
    const path = join(f.dataRoot, 'workspaces/ws_demo/config/workspace.jsonc');
    const previous = readFileSync(path, 'utf8');
    const revision = f.files.readFile(id).file.revision;
    if (mode === 'create') rmSync(path);
    const input = {
      id,
      kind: 'workspace' as const,
      content: JSON.stringify({
        workspace: {
          name: 'Team',
          roots: [{ id: 'files', kind: 'host-dir', path: 'files/contracts', access: 'read-write' }],
        },
      }),
      expectedRevision: revision,
    };
    expect(() =>
      mode === 'create' ? f.files.createFile(input) : f.files.updateFile(input)
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        message: MESSAGE,
        status: 409,
      })
    );
    expect(existsSync(path)).toBe(mode === 'update');
    if (mode === 'update') expect(readFileSync(path, 'utf8')).toBe(previous);
  });

  it('keeps unselected non-Git catalog registration valid but refuses changing a selected Git source to a folder', () => {
    const f = fixture();
    const id = 'workspaces/ws_demo/data-sources.jsonc';
    const created = f.files.createFile({
      id,
      kind: 'data-source',
      content: catalog('workspace-dir'),
    });
    expect(created.file.exists).toBe(true);
    f.write(id, catalog('git'));
    f.files.createFile({ id: 'agents/team.agent.jsonc', kind: 'agent', content: agent(selection) });
    const previous = f.files.readFile(id);
    expect(() =>
      f.files.updateFile({
        id,
        kind: 'data-source',
        content: catalog('workspace-dir'),
        expectedRevision: previous.file.revision,
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        message: MESSAGE,
        status: 409,
      })
    );
    expect(f.files.readFile(id).content).toBe(previous.content);
  });

  it('refuses catalog creation that would activate an already authored non-Git materialization selection', () => {
    const f = fixture();
    f.write('agents/team.agent.jsonc', agent(selection));
    expect(() =>
      f.files.createFile({
        id: 'workspaces/ws_demo/data-sources.jsonc',
        kind: 'data-source',
        content: catalog('workspace-dir'),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        message: MESSAGE,
        status: 409,
      })
    );
    expect(existsSync(join(f.dataRoot, 'workspaces/ws_demo/config/data-sources.jsonc'))).toBe(
      false
    );
  });

  it('still loads authored folder selections and roots without rewriting their bytes', () => {
    const f = fixture();
    const source = catalog('workspace-dir');
    const sourcePath = f.write('workspaces/ws_demo/data-sources.jsonc', source);
    const content = agent(selection);
    const agentPath = f.write('agents/team.agent.jsonc', content);
    f.write(
      'workspaces/ws_demo/workspace.jsonc',
      JSON.stringify({
        workspace: {
          name: 'Team',
          roots: [{ id: 'files', kind: 'host-dir', path: 'files/contracts', access: 'read-write' }],
        },
      })
    );
    const snapshot = loadRuntimeConfig(f.dataRoot);
    expect(
      snapshot.agentManifests.find((manifest) => manifest.id === 'agent_team_fixture')?.workspace
        ?.inputs
    ).toEqual(selection);
    expect(snapshot.workspaceConfigs[0]?.config.workspace.roots[0]?.kind).toBe('host-dir');
    expect(snapshot.workspaceDataSourceCatalogs[0]?.catalog.sources[0]?.kind).toBe('workspace-dir');
    expect(readFileSync(agentPath, 'utf8')).toBe(content);
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
  });

  it.each([
    'runtime.file-create',
    'runtime.file-update',
  ])('projects the exact refusal through %s', async (operation) => {
    const f = fixture();
    f.write('workspaces/ws_demo/data-sources.jsonc', catalog('workspace-dir'));
    const id = 'agents/team.agent.jsonc';
    if (operation === 'runtime.file-update') f.write(id, agent([]));
    const app = createAppWithWorkspaceAuthority({ dataRoot: f.dataRoot, store: f.store });
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        kind: 'agent',
        content: agent(selection),
        expectedRevision:
          operation === 'runtime.file-update' ? f.files.readFile(id).file.revision : null,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'workspace_data_source_blocked',
      message: MESSAGE,
    });
  });

  it('accepts selected Git with additive input metadata', () => {
    const f = fixture();
    f.write('workspaces/ws_demo/data-sources.jsonc', catalog('git'));
    const content = agent([{ ...selection[0], kind: 'directory' }]);
    const created = f.files.createFile({ id: 'agents/team.agent.jsonc', kind: 'agent', content });
    expect(created.file.exists).toBe(true);
  });

  it('refuses an inline folder input without a catalog reference before storage', () => {
    const f = fixture();
    const id = 'agents/team.agent.jsonc';
    expect(() =>
      f.files.createFile({
        id,
        kind: 'agent',
        content: agent([
          {
            id: 'documents',
            access: 'read-write',
            source: { kind: 'workspace-dir', pathRef: 'files/contracts' },
          },
        ]),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        message: MESSAGE,
        status: 409,
      })
    );
    expect(existsSync(join(f.dataRoot, 'config', id))).toBe(false);
  });

  it('accepts an empty input list through creation and update', () => {
    const f = fixture();
    const id = 'agents/team.agent.jsonc';
    const content = agent([]);
    const created = f.files.createFile({ id, kind: 'agent', content });
    const updated = f.files.updateFile({
      id,
      kind: 'agent',
      content,
      expectedRevision: created.file.revision,
    });
    expect(updated.file.exists).toBe(true);
    expect(f.files.readFile(id).content).toBe(content);
  });
});
