// openkit-test-platform: posix
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EMPTY_RESOURCE_CATALOG } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectWorkspaceCatalogExport,
  reconstructImportedWorkspaceCatalog,
  writeImportedWorkspaceCatalog,
} from './catalog-portability.js';
import { importWorkspaceSkill, publishWorkspaceResourceCatalog } from './resource-catalog.js';

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
      workspaceId: 'ws_durable',
    });
  const input = {
    activate: true,
    createdAt: '2026-09-08T00:00:00.000Z',
    dataRoot,
    displayName: 'Durable Skill',
    expectedRevision: withCatalogAuthority ? 1 : 0,
    producer: { id: 'user_local', kind: 'user' as const },
    tree,
    workspaceId: 'ws_durable',
  };
  if (kind === 'import') {
    durability.events.length = 0;
    return {
      dataRoot,
      publish: () => importWorkspaceSkill(input),
      read: () => projectWorkspaceCatalogExport(dataRoot, 'ws_durable'),
    };
  }
  importWorkspaceSkill(input);
  const projection = projectWorkspaceCatalogExport(dataRoot, 'ws_durable');
  const catalog = reconstructImportedWorkspaceCatalog(
    projection.catalog,
    new Map(projection.payloads.map(({ path, payload }) => [path, payload]))
  );
  const targetRoot = join(dataRoot, 'workspaces', 'ws_imported');
  durability.events.length = 0;
  return {
    dataRoot,
    publish: () =>
      writeImportedWorkspaceCatalog(
        targetRoot,
        catalog,
        projection.payloads.map(({ payload }) => payload)
      ),
    read: () => projectWorkspaceCatalogExport(dataRoot, 'ws_imported'),
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
        workspaceId: 'ws_durable',
      }).revision
    ).toBe(1);
    const path = join(dataRoot, 'workspaces', 'ws_durable', 'catalog', 'catalog.json');
    const renameAt = durability.events.findIndex(
      (event) => event.op === 'rename' && event.path === path
    );
    expect(renameAt).toBeGreaterThan(0);
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

  it.each([
    'import',
    'portability',
  ] as const)('syncs the complete %s snapshot before publication and preserves executable bytes on readback', (kind) => {
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
        event.op === 'sync' && !event.directory && event.path === join(staged, 'scripts', 'run.sh')
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
  });

  it.each([
    'import',
    'portability',
  ] as const)('does not publish a %s snapshot when a descendant sync fails', (kind) => {
    const f = snapshotFixture(kind);
    durability.fail = (path, directory) => !directory && path.endsWith('.staging/scripts/run.sh');
    expect(f.publish).toThrow('Injected publication sync failure');
    expect(
      durability.events.some((event) => event.op === 'rename' && event.from?.endsWith('.staging'))
    ).toBe(false);
  });

  it.each([
    'import',
    'portability',
  ] as const)('rejects %s success when the snapshot parent sync fails after rename', (kind) => {
    const f = snapshotFixture(kind);
    durability.fail = (path, directory) =>
      directory &&
      durability.events.some(
        (event) =>
          event.op === 'rename' && event.from?.endsWith('.staging') && dirname(event.path) === path
      );
    expect(f.publish).toThrow('Injected publication sync failure');
    const publication = durability.events.find(
      (event) => event.op === 'rename' && event.from?.endsWith('.staging')
    );
    expect(publication).toBeDefined();
    expect(existsSync(join(publication?.path as string, 'scripts', 'run.sh'))).toBe(true);
  });
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
    const catalogPath = join(f.dataRoot, 'workspaces', 'ws_durable', 'catalog', 'catalog.json');
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
