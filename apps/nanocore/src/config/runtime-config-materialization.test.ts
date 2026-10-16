// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogDocumentPath,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  publishWorkspaceResourceCatalog,
} from '../catalog/resource-catalog.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createRuntimeConfigManager, loadRuntimeConfig } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const durability = vi.hoisted(() => ({
  afterRead: undefined as ((path: string) => void) | undefined,
  readFailurePath: undefined as string | undefined,
  mkdirFailurePath: undefined as string | undefined,
  paths: new Map<number, string>(),
  events: [] as Array<{
    op: 'sync' | 'rename';
    path: string;
    from?: string;
    directory?: boolean;
    mode?: number;
  }>,
  fail: undefined as ((path: string, directory: boolean) => boolean) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const path = String(args[0]);
      if (path === durability.readFailurePath)
        throw Object.assign(new Error('Injected source read failure'), { code: 'EACCES' });
      const content = actual.readFileSync(...args);
      durability.afterRead?.(path);
      return content;
    }) as typeof actual.readFileSync,
    mkdirSync: ((...args: Parameters<typeof actual.mkdirSync>) => {
      if (String(args[0]) === durability.mkdirFailurePath)
        throw Object.assign(new Error('Injected unrelated layout mkdir failure'), {
          code: 'EACCES',
        });
      return actual.mkdirSync(...args);
    }) as typeof actual.mkdirSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      durability.paths.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof actual.openSync,
    closeSync: ((descriptor: number) => {
      durability.paths.delete(descriptor);
      return actual.closeSync(descriptor);
    }) as typeof actual.closeSync,
    fsyncSync: ((descriptor: number) => {
      const path = durability.paths.get(descriptor) ?? '<untracked>';
      const directory = actual.fstatSync(descriptor).isDirectory();
      durability.events.push({
        op: 'sync',
        path,
        directory,
        mode: actual.fstatSync(descriptor).mode & 0o777,
      });
      if (durability.fail?.(path, directory)) throw new Error('Injected publication sync failure');
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    renameSync: ((
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1]
    ) => {
      durability.events.push({ op: 'rename', from: String(from), path: String(to) });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

const MESSAGE =
  'Only credential-free remote Git sources can be materialized into a work slot in this release. Folder and other source kinds are not supported yet. Work without a source input still runs.';
const roots: string[] = [];
afterEach(() => {
  durability.afterRead = undefined;
  durability.readFailurePath = undefined;
  durability.mkdirFailurePath = undefined;
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
    'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc',
    JSON.stringify({ workspace: { name: 'Team', roots: [] } })
  );
  const manager = createRuntimeConfigManager({ initialSnapshot: loadRuntimeConfig(dataRoot) });
  const files = new RuntimeConfigFileService({
    dataRoot,
    workspaceIds: [
      'ws_00000000-0000-7000-8000-000000000001',
      ...(otherWorkspaceId ? [otherWorkspaceId] : []),
    ],
    userId: 'usr_00000000-0000-7000-8000-000000000001',
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

describe('registered config detail read coherence', () => {
  it('binds the revision to one actual source read when an external writer replaces the file', () => {
    const f = fixture();
    const id = 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc';
    const original = '// Original café\n{"workspace":{"name":"Original","roots":[]}}\n';
    const replacement = '// Replacement\n{"workspace":{"name":"Replacement","roots":[]}}\n';
    const path = f.write(id, original);
    const incoming = `${path}.external`;
    writeFileSync(incoming, replacement);
    let sourceReads = 0;
    durability.afterRead = (readPath) => {
      if (readPath !== path) return;
      sourceReads += 1;
      // Replace only after the real read has completed, before a potential second read.
      if (sourceReads === 1) renameSync(incoming, path);
    };

    const result = f.files.readFile(id);
    durability.afterRead = undefined;

    expect(result.file.revision).toBe(
      `sha256:${createHash('sha256').update(result.content).digest('hex')}`
    );
    expect(sourceReads).toBe(1);
    expect(result.content).toBe(original);
    expect(readFileSync(path, 'utf8')).toBe(replacement);
  });

  it('keeps a missing registered file absent and reports not found', () => {
    const f = fixture();
    const id = 'agents/missing.agent.jsonc';
    const path = join(f.dataRoot, 'config', id);

    expect(() => f.files.readFile(id)).toThrow(
      expect.objectContaining({ code: 'config_file_not_found', status: 404 })
    );
    expect(existsSync(path)).toBe(false);
  });

  it('propagates source read failure without changing authored bytes', () => {
    const f = fixture();
    const id = 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc';
    const original = '{"workspace":{"name":"Unreadable","roots":[]}}\n';
    const path = f.write(id, original);
    durability.readFailurePath = path;

    expect(() => f.files.readFile(id)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    durability.readFailurePath = undefined;
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('refuses a foreign Workspace symlink before reading its content', () => {
    const f = fixture(true);
    const id = 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc';
    const path = join(
      f.dataRoot,
      'workspaces/ws_00000000-0000-7000-8000-000000000001/config/workspace.jsonc'
    );
    const foreignContent = '{"workspace":{"name":"Foreign","roots":[]}}\n';
    const foreignPath = f.write(`workspaces/${f.otherWorkspaceId}/workspace.jsonc`, foreignContent);
    rmSync(path);
    symlinkSync(foreignPath, path);
    let sourceReads = 0;
    durability.afterRead = (readPath) => {
      if (readPath === path || readPath === foreignPath) sourceReads += 1;
    };

    expect(() => f.files.readFile(id)).toThrow(
      expect.objectContaining({ code: 'config_path_not_allowed', status: 400 })
    );
    expect(sourceReads).toBe(0);
    durability.afterRead = undefined;
    expect(readlinkSync(path)).toBe(foreignPath);
    expect(readFileSync(foreignPath, 'utf8')).toBe(foreignContent);
  });
});

describe('configuration-stage work-slot source refusal', () => {
  it.each([
    ['create', 'agent-first'],
    ['create', 'catalog-first'],
    ['update', 'agent-first'],
    ['update', 'catalog-first'],
  ] as const)('accepts shared Git/folder docs on both %s writes in %s order', (mode, order) => {
    const f = fixture(true);
    f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
      catalog('git', 'docs')
    );
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
    f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
      catalog('workspace-dir', 'docs')
    );
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
    f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
      catalog('workspace-dir')
    );
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
    f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
      catalog('workspace-dir')
    );
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
    const id = 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc';
    const path = join(
      f.dataRoot,
      'workspaces/ws_00000000-0000-7000-8000-000000000001/config/workspace.jsonc'
    );
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
    const id = 'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc';
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
        id: 'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
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
    expect(
      existsSync(
        join(
          f.dataRoot,
          'workspaces/ws_00000000-0000-7000-8000-000000000001/config/data-sources.jsonc'
        )
      )
    ).toBe(false);
  });

  it('still loads authored folder selections and roots without rewriting their bytes', () => {
    const f = fixture();
    const source = catalog('workspace-dir');
    const sourcePath = f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
      source
    );
    const content = agent(selection);
    const agentPath = f.write('agents/team.agent.jsonc', content);
    f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc',
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
    f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
      catalog('workspace-dir')
    );
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
    f.write(
      'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
      catalog('git')
    );
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

describe('authored configuration durability', () => {
  it('syncs exact replacement bytes and mode before rename, then syncs its parent and reopens', () => {
    const f = fixture();
    const id = 'agents/durable.agent.jsonc';
    const original = agent([], 'agent_durable_fixture');
    const path = f.write(id, original);
    chmodSync(path, 0o640);
    const replacement = agent([], 'agent_durable_replacement');
    durability.events.length = 0;
    f.files.updateFile({
      id,
      kind: 'agent',
      content: replacement,
      expectedRevision: f.files.readFile(id).file.revision,
    });
    const renameAt = durability.events.findIndex(
      (event) => event.op === 'rename' && event.path === path
    );
    expect(renameAt).toBeGreaterThan(0);
    const staged = durability.events[renameAt].from;
    expect(
      durability.events
        .slice(0, renameAt)
        .some(
          (event) =>
            event.op === 'sync' && !event.directory && event.path === staged && event.mode === 0o640
        )
    ).toBe(true);
    expect(
      durability.events
        .slice(renameAt + 1)
        .some((event) => event.op === 'sync' && event.directory && event.path === dirname(path))
    ).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(f.files.readFile(id).content).toBe(replacement);
    expect(loadRuntimeConfig(f.dataRoot).agentManifests).toEqual(
      expect.arrayContaining([expect.objectContaining(JSON.parse(replacement))])
    );
  });

  it.each([
    'before',
    'after',
  ] as const)('rejects success when synchronization fails %s the configuration rename', (boundary) => {
    const f = fixture();
    const id = 'agents/durable.agent.jsonc';
    const original = agent([], 'agent_durable_fixture');
    const path = f.write(id, original);
    const replacement = agent([], 'agent_durable_replacement');
    durability.events.length = 0;
    durability.fail = (candidate, directory) =>
      boundary === 'before'
        ? !directory && dirname(candidate) === dirname(path)
        : directory &&
          candidate === dirname(path) &&
          durability.events.some((event) => event.op === 'rename' && event.path === path);
    try {
      expect(() =>
        f.files.updateFile({
          id,
          kind: 'agent',
          content: replacement,
          expectedRevision: f.files.readFile(id).file.revision,
        })
      ).toThrow();
      expect(f.files.readFile(id).content).toBe(boundary === 'before' ? original : replacement);
    } finally {
      durability.fail = undefined;
    }
  });
});

/** Builds authored Assistant selection without introducing version or runtime authority. */
function assistantSelectionContent(skillIds?: readonly unknown[]): string {
  return JSON.stringify({
    workspace: {
      name: 'Assistant selection',
      roots: [],
      assistant: {
        repositoryInspection: { enabled: false, excludedPaths: ['docs/private'] },
        ...(skillIds === undefined ? {} : { resources: { skillIds } }),
      },
    },
  });
}

/** Supplies real inactive local and foreign Skills after the file service snapshot was created. */
function assistantSelectionFixture(mode: 'create' | 'update') {
  const f = fixture(true);
  for (const [workspaceId, id] of [
    ['ws_00000000-0000-7000-8000-000000000001', 'local-guidance'],
    [f.otherWorkspaceId as string, 'foreign-guidance'],
  ]) {
    importWorkspaceSkill({
      activate: false,
      createdAt: '2026-10-15T00:00:00.000Z',
      dataRoot: f.dataRoot,
      displayName: id,
      id,
      expectedRevision: 0,
      producer: { id: 'usr_00000000-0000-7000-8000-000000000001', kind: 'user' },
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Guidance\n').toString('base64'),
        },
      ],
      workspaceId,
    });
  }
  const id = 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc';
  const path = join(
    f.dataRoot,
    'workspaces',
    'ws_00000000-0000-7000-8000-000000000001',
    'config',
    'workspace.jsonc'
  );
  const previous = assistantSelectionContent();
  f.write(id, previous);
  const revision = f.files.readFile(id).file.revision;
  if (mode === 'create') rmSync(path);
  const write = (content: string) =>
    mode === 'create'
      ? f.files.createFile({ id, kind: 'workspace', content })
      : f.files.updateFile({ id, kind: 'workspace', content, expectedRevision: revision });
  return { ...f, id, path, previous, revision, write };
}

describe('Workspace Assistant Skill selection configuration', () => {
  const invalidSelections = [
    ['missing', ['missing-guidance']],
    ['foreign-only', ['foreign-guidance']],
    ['different exact ID', ['local-guidance ']],
    ['path', ['../local-guidance']],
    ['empty ID', ['']],
    ['duplicate ID', ['local-guidance', 'local-guidance']],
  ] as const;
  it.each(
    invalidSelections.flatMap(([label, ids]) =>
      (['create', 'update'] as const).map((mode) => ({ label, ids, mode }))
    )
  )('refuses $label references on $mode without changing authored or catalog bytes', ({
    ids,
    mode,
  }) => {
    const f = assistantSelectionFixture(mode);
    const localCatalog = catalogDocumentPath(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const foreignCatalog = catalogDocumentPath(f.dataRoot, f.otherWorkspaceId as string);
    const catalogBefore = readFileSync(localCatalog);
    const foreignBefore = readFileSync(foreignCatalog);
    const content = assistantSelectionContent(ids);
    expect(() => f.write(content)).toThrowError(
      expect.objectContaining({ code: 'config_file_invalid', status: 400 })
    );
    if (mode === 'create') expect(existsSync(f.path)).toBe(false);
    else expect(readFileSync(f.path, 'utf8')).toBe(f.previous);
    expect(readFileSync(localCatalog)).toEqual(catalogBefore);
    expect(readFileSync(foreignCatalog)).toEqual(foreignBefore);
    const validation = f.files.validate({ files: [{ id: f.id, content }], mode: 'safe' });
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: f.id,
          code: 'invalid_workspace_config',
          severity: 'error',
        }),
      ])
    );
  });

  it.each(
    (['absent', 'empty', 'selected'] as const).flatMap((selection) =>
      (['create', 'update'] as const).map((mode) => ({ selection, mode }))
    )
  )('persists $selection selection on $mode using current same-Workspace catalog identities', ({
    selection,
    mode,
  }) => {
    const f = assistantSelectionFixture(mode);
    const catalogPath = catalogDocumentPath(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    const catalogBefore = readFileSync(catalogPath);
    expect(
      loadWorkspaceResourceCatalog(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001').skills
        .entries[0].currentDigest
    ).toBeNull();
    const ids =
      selection === 'absent' ? undefined : selection === 'empty' ? [] : ['local-guidance'];
    const content = assistantSelectionContent(ids);
    f.write(content);
    expect(f.files.readFile(f.id).content).toBe(content);
    expect(readFileSync(catalogPath)).toEqual(catalogBefore);
    const loaded = loadRuntimeConfig(f.dataRoot).workspaceConfigs.find(
      (entry) => entry.workspaceId === 'ws_00000000-0000-7000-8000-000000000001'
    );
    expect(loaded?.config.workspace.assistant.repositoryInspection.enabled).toBe(false);
    expect(
      JSON.parse(readFileSync(f.path, 'utf8')).workspace.assistant.resources?.skillIds ?? []
    ).toEqual(ids ?? []);
  });

  it('rejects a reference deleted from current catalog after a prior valid selection without discarding authored selection', () => {
    const f = assistantSelectionFixture('update');
    const selected = assistantSelectionContent(['local-guidance']);
    f.write(selected);
    const current = loadWorkspaceResourceCatalog(
      f.dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    publishWorkspaceResourceCatalog({
      dataRoot: f.dataRoot,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      expectedRevision: current.revision,
      catalog: { ...current, skills: { entries: [], versions: [], pins: [], candidates: [] } },
    });
    expect(readFileSync(f.path, 'utf8')).toBe(selected);
    expect(() =>
      f.files.updateFile({
        id: f.id,
        kind: 'workspace',
        content: selected,
        expectedRevision: f.files.readFile(f.id).file.revision,
      })
    ).toThrowError(expect.objectContaining({ code: 'config_file_invalid', status: 400 }));
    expect(readFileSync(f.path, 'utf8')).toBe(selected);
  });

  it.each(
    (['corrupt', 'missing'] as const).flatMap((authority) =>
      (['create', 'update'] as const).map((mode) => ({ authority, mode }))
    )
  )('refuses $authority current catalog authority on $mode with a redacted error and unchanged authored bytes', ({
    authority,
    mode,
  }) => {
    const f = assistantSelectionFixture(mode);
    const catalogPath = catalogDocumentPath(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    if (authority === 'corrupt') writeFileSync(catalogPath, '{invalid');
    else rmSync(catalogPath);
    let failure: unknown;
    try {
      f.write(assistantSelectionContent(['local-guidance']));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'config_file_invalid', status: 400 });
    expect(
      `${failure instanceof Error ? failure.message : ''}${JSON.stringify(failure)}`
    ).not.toContain(f.dataRoot);
    if (mode === 'create') expect(existsSync(f.path)).toBe(false);
    else expect(readFileSync(f.path, 'utf8')).toBe(f.previous);
    if (authority === 'corrupt') expect(readFileSync(catalogPath, 'utf8')).toBe('{invalid');
    else expect(existsSync(catalogPath)).toBe(false);
  });

  it('keeps exact revision refusal for an otherwise valid existing Skill selection', () => {
    const f = assistantSelectionFixture('update');
    const newer = `${f.previous}\n// Concurrent authored edit\n`;
    writeFileSync(f.path, newer);
    expect(() => f.write(assistantSelectionContent(['local-guidance']))).toThrowError(
      expect.objectContaining({ code: 'config_revision_conflict', status: 409 })
    );
    expect(readFileSync(f.path, 'utf8')).toBe(newer);
  });
});

describe('Workspace Assistant Skill read-only validation', () => {
  it('validates a real selected Skill without repairing an unrelated missing Workspace subtree', () => {
    const f = assistantSelectionFixture('update');
    const unrelated = join(
      f.dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'light-apps'
    );
    const catalogPath = join(
      f.dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'catalog',
      'catalog.json'
    );
    const catalogBefore = readFileSync(catalogPath);
    rmSync(unrelated, { recursive: true });
    const result = f.files.validate({
      files: [
        {
          id: f.id,
          content: assistantSelectionContent(['local-guidance']),
        },
      ],
      mode: 'safe',
    });
    expect(result.valid).toBe(true);
    expect(existsSync(unrelated)).toBe(false);
    expect(readFileSync(f.path, 'utf8')).toBe(f.previous);
    expect(readFileSync(catalogPath)).toEqual(catalogBefore);
  });

  it.each([
    'create',
    'update',
  ] as const)('does not repair an unrelated Workspace subtree while refusing an invalid %s selection', (mode) => {
    const f = assistantSelectionFixture(mode);
    const unrelated = join(
      f.dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'light-apps'
    );
    const catalogPath = join(
      f.dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'catalog',
      'catalog.json'
    );
    const catalogBefore = readFileSync(catalogPath);
    rmSync(unrelated, { recursive: true });
    expect(() => f.write(assistantSelectionContent(['missing-guidance']))).toThrowError(
      expect.objectContaining({ code: 'config_file_invalid', status: 400 })
    );
    expect(existsSync(unrelated)).toBe(false);
    if (mode === 'create') expect(existsSync(f.path)).toBe(false);
    else expect(readFileSync(f.path, 'utf8')).toBe(f.previous);
    expect(readFileSync(catalogPath)).toEqual(catalogBefore);
  });

  it('does not reject a valid Skill because an unrelated layout mkdir would fail', () => {
    const f = assistantSelectionFixture('update');
    const unrelated = join(
      f.dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'light-apps'
    );
    rmSync(unrelated, { recursive: true });
    durability.mkdirFailurePath = unrelated;
    try {
      const result = f.files.validate({
        files: [
          {
            id: f.id,
            content: assistantSelectionContent(['local-guidance']),
          },
        ],
        mode: 'safe',
      });
      expect(result.valid).toBe(true);
      expect(existsSync(unrelated)).toBe(false);
      expect(readFileSync(f.path, 'utf8')).toBe(f.previous);
    } finally {
      durability.mkdirFailurePath = undefined;
    }
  });
});

describe('Workspace Assistant Skill catalog confinement', () => {
  it.each(
    (['directory', 'file'] as const).flatMap((redirect) =>
      (['create', 'update'] as const).map((mode) => ({ redirect, mode }))
    )
  )('rejects a catalog $redirect symlink to another Workspace on $mode without changing either authority', ({
    redirect,
    mode,
  }) => {
    const f = assistantSelectionFixture(mode);
    const localDirectory = join(
      f.dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'catalog'
    );
    const foreignDirectory = join(
      f.dataRoot,
      'workspaces',
      f.otherWorkspaceId as string,
      'catalog'
    );
    const foreignCatalog = join(foreignDirectory, 'catalog.json');
    const foreignBefore = readFileSync(foreignCatalog);
    const linkPath =
      redirect === 'directory' ? localDirectory : join(localDirectory, 'catalog.json');
    const linkTarget = redirect === 'directory' ? foreignDirectory : foreignCatalog;
    rmSync(linkPath, { recursive: redirect === 'directory' });
    symlinkSync(linkTarget, linkPath, redirect === 'directory' ? 'dir' : 'file');
    expect(() => f.write(assistantSelectionContent(['foreign-guidance']))).toThrowError(
      expect.objectContaining({ code: 'config_file_invalid', status: 400 })
    );
    if (mode === 'create') expect(existsSync(f.path)).toBe(false);
    else expect(readFileSync(f.path, 'utf8')).toBe(f.previous);
    expect(readFileSync(foreignCatalog)).toEqual(foreignBefore);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(linkTarget);
    const validation = f.files.validate({
      files: [
        {
          id: f.id,
          content: assistantSelectionContent(['foreign-guidance']),
        },
      ],
      mode: 'safe',
    });
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_workspace_config', severity: 'error' }),
      ])
    );
  });
});
