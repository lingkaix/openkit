// openkit-test-platform: posix
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EMPTY_RESOURCE_CATALOG } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reconstructImportedWorkspaceCatalog,
  writeImportedWorkspaceCatalog,
} from '../test-support/catalog-portability-fixture.js';
import { projectWorkspaceCatalogExport } from './catalog-portability.js';
import {
  createMcpConfig,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  publishWorkspaceResourceCatalog,
  replaceWorkspaceEffectiveMcpCatalog,
  updateMcpBinding,
} from './resource-catalog.js';

const durability = vi.hoisted(() => ({
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

const roots: string[] = [];
afterEach(() => {
  durability.fail = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates a retained Skill with nested executable bytes and a real portability consumer. */
function snapshotFixture(kind: 'import' | 'portability', withCatalogAuthority = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-tree-durable-'));
  roots.push(dataRoot);
  const tree = [
    {
      kind: 'file' as const,
      path: 'SKILL.md',
      contentBase64: Buffer.from(
        '---\nname: durable\ndescription: Exercise durable snapshot publication.\n---\n# Durable Skill\n'
      ).toString('base64'),
    },
    { kind: 'directory' as const, path: 'scripts' },
    {
      kind: 'file' as const,
      path: 'scripts/run.sh',
      contentBase64: Buffer.from('#!/bin/sh\nprintf retained\n').toString('base64'),
      executable: true,
    },
  ];
  if (withCatalogAuthority)
    publishWorkspaceResourceCatalog({
      catalog: EMPTY_RESOURCE_CATALOG,
      dataRoot,
      expectedRevision: 0,
      workspaceId: 'ws_00000000-0000-7ca8-a881-c3c5386365fe',
    });
  const input = {
    activate: true,
    createdAt: '2026-09-08T00:00:00.000Z',
    dataRoot,
    displayName: 'Durable Skill',
    expectedRevision: withCatalogAuthority ? 1 : 0,
    producer: { id: 'usr_00000000-0000-7000-8000-000000000001', kind: 'user' as const },
    tree,
    workspaceId: 'ws_00000000-0000-7ca8-a881-c3c5386365fe',
  };
  if (kind === 'import') {
    durability.events.length = 0;
    return {
      dataRoot,
      publish: () => importWorkspaceSkill(input),
      read: () =>
        projectWorkspaceCatalogExport(dataRoot, 'ws_00000000-0000-7ca8-a881-c3c5386365fe'),
    };
  }
  importWorkspaceSkill(input);
  const projection = projectWorkspaceCatalogExport(
    dataRoot,
    'ws_00000000-0000-7ca8-a881-c3c5386365fe'
  );
  const catalog = reconstructImportedWorkspaceCatalog(
    projection.catalog,
    new Map(projection.payloads.map(({ path, payload }) => [path, payload]))
  );
  const targetRoot = join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000099');
  durability.events.length = 0;
  return {
    dataRoot,
    publish: () =>
      writeImportedWorkspaceCatalog(
        targetRoot,
        catalog,
        projection.payloads.map(({ payload }) => payload)
      ),
    read: () => projectWorkspaceCatalogExport(dataRoot, 'ws_00000000-0000-7000-8000-000000000099'),
  };
}

describe('resource catalog durable publication', () => {
  it('syncs catalog.json bytes before rename and the exact parent after rename', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-durable-'));
    roots.push(dataRoot);
    durability.events.length = 0;
    expect(
      publishWorkspaceResourceCatalog({
        catalog: EMPTY_RESOURCE_CATALOG,
        dataRoot,
        expectedRevision: 0,
        workspaceId: 'ws_00000000-0000-7ca8-a881-c3c5386365fe',
      }).revision
    ).toBe(1);
    const path = join(
      dataRoot,
      'workspaces',
      'ws_00000000-0000-7ca8-a881-c3c5386365fe',
      'catalog',
      'catalog.json'
    );
    const renameAt = durability.events.findIndex(
      (event) => event.op === 'rename' && event.path === path
    );
    expect(renameAt).toBeGreaterThan(0);
    // Core Storage, Source of Truth: acknowledge newly created parent entries before publication.
    for (const parent of [dataRoot, join(dataRoot, 'workspaces'), dirname(dirname(path))]) {
      expect(
        durability.events
          .slice(0, renameAt)
          .some((event) => event.op === 'sync' && event.directory && event.path === parent)
      ).toBe(true);
    }
    // Preserve Node's default directory creation permissions, subject to the process umask.
    for (const directory of [join(dataRoot, 'workspaces'), dirname(dirname(path)), dirname(path)]) {
      expect(statSync(directory).mode & 0o777).toBe(0o777 & ~process.umask());
    }
    expect(
      durability.events
        .slice(0, renameAt)
        .some(
          (event) =>
            event.op === 'sync' &&
            !event.directory &&
            event.path === durability.events[renameAt].from
        )
    ).toBe(true);
    expect(
      durability.events
        .slice(renameAt + 1)
        .some((event) => event.op === 'sync' && event.directory && event.path === dirname(path))
    ).toBe(true);
  });

  it('acknowledges MCP data before catalog publication and preserves its key and bytes on binding updates', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-mcp-directory-'));
    const outside = mkdtempSync(join(tmpdir(), 'openkit-catalog-mcp-outside-'));
    roots.push(dataRoot, outside);
    const workspaceId = 'ws_00000000-0000-7ca8-a881-c3c5386365fe';
    const owner = { kind: 'workspace' as const, workspaceId };
    durability.events.length = 0;
    const previousUmask = process.umask(0o027);
    let created: ReturnType<typeof createMcpConfig>;
    try {
      created = createMcpConfig({
        dataRoot,
        owner,
        id: 'echo',
        displayName: 'Echo',
        createdAt: '2026-09-08T00:00:00.000Z',
        expectedRevision: 0,
        allowedTools: ['echo'],
        selectCurrent: true,
        declaration: { kind: 'http', endpoint: 'https://mcp.example.test/mcp' },
      });
    } finally {
      process.umask(previousUmask);
    }
    const binding = created.catalog.mcp.bindings[0]!;
    const catalogPath = join(dataRoot, 'workspaces', workspaceId, 'catalog', 'catalog.json');
    const directory = join(dirname(catalogPath), 'mcp-data', binding.packageDataKey);
    const metadata = statSync(directory);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o750);
    const publicationAt = durability.events.findIndex(
      (event) => event.op === 'rename' && event.path === catalogPath
    );
    // Fault Tolerance, Acknowledge only what is durable: the binding cannot precede its data entry.
    expect(publicationAt).toBeGreaterThan(0);
    expect(
      durability.events
        .slice(0, publicationAt)
        .some(
          (event) => event.op === 'sync' && event.directory && event.path === dirname(directory)
        )
    ).toBe(true);
    writeFileSync(join(directory, 'retained'), 'MCP process bytes');
    let current = created.catalog;
    const update = () =>
      updateMcpBinding({
        dataRoot,
        owner,
        entryId: 'echo',
        expectedRevision: current.revision,
        binding: current.mcp.bindings[0]!,
      });
    current = update();
    expect(current.revision).toBe(created.catalog.revision + 1);
    expect(current.mcp.bindings[0]!.packageDataKey).toBe(binding.packageDataKey);
    expect(statSync(directory).ino).toBe(metadata.ino);
    expect(statSync(directory).mode).toBe(metadata.mode);
    expect(readFileSync(join(directory, 'retained'), 'utf8')).toBe('MCP process bytes');

    const catalogBytes = readFileSync(catalogPath);
    durability.events.length = 0;
    durability.fail = (path, directoryEntry) => directoryEntry && path === dirname(directory);
    expect(update).toThrow('Injected publication sync failure');
    durability.fail = undefined;
    expect(durability.events.some((event) => event.op === 'rename')).toBe(false);
    expect(loadWorkspaceResourceCatalog(dataRoot, workspaceId).revision).toBe(current.revision);
    expect(readFileSync(catalogPath)).toEqual(catalogBytes);

    // Core Storage path safety: an existing data key cannot redirect the binding to other bytes.
    rmSync(directory, { recursive: true });
    writeFileSync(join(outside, 'retained'), 'Outside bytes');
    symlinkSync(outside, directory, 'dir');
    expect(update).toThrow();
    expect(lstatSync(directory).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual(['retained']);
    expect(readFileSync(join(outside, 'retained'), 'utf8')).toBe('Outside bytes');
    expect(readFileSync(catalogPath)).toEqual(catalogBytes);
  });

  it('preserves seeded MCP data across replacement and refuses a linked data directory before publication', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-seeded-directory-'));
    const outside = mkdtempSync(join(tmpdir(), 'openkit-catalog-seeded-outside-'));
    roots.push(dataRoot, outside);
    const workspaceId = 'ws_00000000-0000-7ca8-a881-c3c5386365fe';
    const replace = () =>
      replaceWorkspaceEffectiveMcpCatalog({
        dataRoot,
        workspaceId,
        createdAt: '2026-09-08T00:00:00.000Z',
        catalog: {
          schemaVersion: 1,
          servers: [
            {
              id: 'echo',
              enabled: false,
              allowedTools: ['echo'],
              credentialBindings: [],
              pinnedSchemaSnapshotId: null,
              schemaPolicy: 'tracking',
              timeoutMs: 1000,
              transport: { kind: 'http', endpoint: 'https://mcp.example.test/mcp', headers: {} },
            },
          ],
        },
      });
    durability.events.length = 0;
    const previousUmask = process.umask(0o027);
    let first: ReturnType<typeof replaceWorkspaceEffectiveMcpCatalog>;
    try {
      first = replace();
    } finally {
      process.umask(previousUmask);
    }
    const catalogPath = join(dataRoot, 'workspaces', workspaceId, 'catalog', 'catalog.json');
    const key = first.mcp.bindings[0]!.packageDataKey;
    const directory = join(dirname(catalogPath), 'mcp-data', key);
    const metadata = statSync(directory);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o750);
    const publicationAt = durability.events.findIndex(
      (event) => event.op === 'rename' && event.path === catalogPath
    );
    // Fault Tolerance, Acknowledge only what is durable: seeded bindings use the same boundary.
    expect(publicationAt).toBeGreaterThan(0);
    expect(
      durability.events
        .slice(0, publicationAt)
        .some(
          (event) => event.op === 'sync' && event.directory && event.path === dirname(directory)
        )
    ).toBe(true);
    writeFileSync(join(directory, 'retained'), 'Seeded process bytes');
    const second = replace();
    expect(second.revision).toBe(first.revision + 1);
    expect(second.mcp.bindings[0]!.packageDataKey).toBe(key);
    expect(statSync(directory).ino).toBe(metadata.ino);
    expect(statSync(directory).mode).toBe(metadata.mode);
    expect(readFileSync(join(directory, 'retained'), 'utf8')).toBe('Seeded process bytes');

    const catalogBytes = readFileSync(catalogPath);
    rmSync(directory, { recursive: true });
    writeFileSync(join(outside, 'retained'), 'Outside seeded bytes');
    symlinkSync(outside, directory, 'dir');
    durability.events.length = 0;
    // Core Storage path safety: seeding cannot admit a data directory that redirects outside its tree.
    expect(replace).toThrow();
    expect(durability.events.some((event) => event.op === 'rename')).toBe(false);
    expect(lstatSync(directory).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual(['retained']);
    expect(readFileSync(join(outside, 'retained'), 'utf8')).toBe('Outside seeded bytes');
    expect(readFileSync(catalogPath)).toEqual(catalogBytes);
    expect(loadWorkspaceResourceCatalog(dataRoot, workspaceId).revision).toBe(second.revision);
  });

  it.each(['import', 'portability'] as const)(
    'syncs the complete %s snapshot before publication and preserves executable bytes on readback',
    (kind) => {
      const f = snapshotFixture(kind);
      f.publish();
      const renameAt = durability.events.findIndex(
        (event) => event.op === 'rename' && event.from?.endsWith('.staging')
      );
      expect(renameAt).toBeGreaterThan(0);
      const publication = durability.events[renameAt];
      const staged = publication.from as string;
      const before = durability.events.slice(0, renameAt);
      const fileAt = before.findLastIndex(
        (event) =>
          event.op === 'sync' &&
          !event.directory &&
          event.path === join(staged, 'scripts', 'run.sh')
      );
      const directoryAt = before.findLastIndex(
        (event) => event.op === 'sync' && event.directory && event.path === join(staged, 'scripts')
      );
      const rootAt = before.findLastIndex(
        (event) => event.op === 'sync' && event.directory && event.path === staged
      );
      expect(
        before.some(
          (event) =>
            event.op === 'sync' && !event.directory && event.path === join(staged, 'SKILL.md')
        )
      ).toBe(true);
      expect(fileAt).toBeGreaterThanOrEqual(0);
      expect(directoryAt).toBeGreaterThan(fileAt);
      expect(rootAt).toBeGreaterThan(directoryAt);
      expect(
        durability.events
          .slice(renameAt + 1)
          .some(
            (event) =>
              event.op === 'sync' && event.directory && event.path === dirname(publication.path)
          )
      ).toBe(true);
      // A fresh entry directory must itself be reachable after a host crash.
      expect(
        durability.events.some(
          (event) =>
            event.op === 'sync' &&
            event.directory &&
            event.path === dirname(dirname(publication.path))
        )
      ).toBe(true);
      expect(statSync(join(publication.path, 'scripts', 'run.sh')).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(publication.path, 'scripts', 'run.sh'), 'utf8')).toBe(
        '#!/bin/sh\nprintf retained\n'
      );
      expect(f.read().payloads[0].payload.tree).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'scripts/run.sh', executable: true }),
        ])
      );
    }
  );

  it.each(['import', 'portability'] as const)(
    'does not publish a %s snapshot when a descendant sync fails',
    (kind) => {
      const f = snapshotFixture(kind);
      durability.fail = (path, directory) => !directory && path.endsWith('.staging/scripts/run.sh');
      expect(f.publish).toThrow('Injected publication sync failure');
      expect(
        durability.events.some((event) => event.op === 'rename' && event.from?.endsWith('.staging'))
      ).toBe(false);
    }
  );

  it.each(['import', 'portability'] as const)(
    'rejects %s success when the snapshot parent sync fails after rename',
    (kind) => {
      const f = snapshotFixture(kind);
      durability.fail = (path, directory) =>
        directory &&
        durability.events.some(
          (event) =>
            event.op === 'rename' &&
            event.from?.endsWith('.staging') &&
            dirname(event.path) === path
        );
      expect(f.publish).toThrow('Injected publication sync failure');
      const publication = durability.events.find(
        (event) => event.op === 'rename' && event.from?.endsWith('.staging')
      );
      expect(publication).toBeDefined();
      expect(existsSync(join(publication?.path as string, 'scripts', 'run.sh'))).toBe(true);
    }
  );
});

describe('resource snapshot acknowledgement recovery', () => {
  it('does not admit catalog authority on exact retry until the visible snapshot and parent synchronize', () => {
    // Existing authority lets exact retry reach the retained snapshot; orphan-only reads fail closed.
    const f = snapshotFixture('import', true);
    durability.fail = (path, directory) =>
      directory &&
      durability.events.some(
        (event) =>
          event.op === 'rename' && event.from?.endsWith('.staging') && dirname(event.path) === path
      );
    expect(f.publish).toThrow('Injected publication sync failure');
    const firstPublication = durability.events.find(
      (event) => event.op === 'rename' && event.from?.endsWith('.staging')
    );
    expect(firstPublication).toBeDefined();
    const target = firstPublication?.path as string;
    const parent = dirname(target);
    expect(readFileSync(join(target, 'scripts', 'run.sh'), 'utf8')).toBe(
      '#!/bin/sh\nprintf retained\n'
    );
    expect(f.read().catalog.skills.versions).toEqual([]);

    durability.events.length = 0;
    durability.fail = (path, directory) => directory && path === parent;
    expect(f.publish).toThrow('Injected publication sync failure');
    expect(f.read().catalog.skills.versions).toEqual([]);
    expect(durability.events.some((event) => event.op === 'rename')).toBe(false);
    for (const path of [join(target, 'SKILL.md'), join(target, 'scripts', 'run.sh')]) {
      expect(
        durability.events.some(
          (event) => event.op === 'sync' && !event.directory && event.path === path
        )
      ).toBe(true);
    }

    durability.events.length = 0;
    durability.fail = undefined;
    f.publish();
    const catalogPath = join(
      f.dataRoot,
      'workspaces',
      'ws_00000000-0000-7ca8-a881-c3c5386365fe',
      'catalog',
      'catalog.json'
    );
    const catalogAt = durability.events.findIndex(
      (event) => event.op === 'rename' && event.path === catalogPath
    );
    const snapshotAt = durability.events.findLastIndex(
      (event) => event.op === 'sync' && event.directory && event.path === target
    );
    const parentAt = durability.events.findLastIndex(
      (event) => event.op === 'sync' && event.directory && event.path === parent
    );
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(parentAt).toBeGreaterThan(snapshotAt);
    expect(catalogAt).toBeGreaterThan(parentAt);
    expect(durability.events.some((event) => event.op === 'rename' && event.path === target)).toBe(
      false
    );
    const retained = f.read();
    expect(retained.catalog.skills.versions).toHaveLength(1);
    expect(retained.payloads).toHaveLength(1);
    expect(retained.payloads[0].payload.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'scripts/run.sh',
          contentBase64: Buffer.from('#!/bin/sh\nprintf retained\n').toString('base64'),
          executable: true,
        }),
      ])
    );
  });
});
