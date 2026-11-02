// openkit-test-platform: posix
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_RESOURCE_CATALOG } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  publishWorkspaceResourceCatalog,
  readWorkspaceSkillSnapshot,
  skillSnapshotPath,
} from './resource-catalog.js';

const io = vi.hoisted(() => ({
  failWrite: false,
  staged: '',
  target: '',
  error: new Error('Injected snapshot publication failure'),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      const path = String(args[0]);
      if (io.failWrite && path.endsWith('.staging/scripts/nested/run.sh')) {
        io.staged = path.slice(0, path.indexOf('.staging') + '.staging'.length);
        io.target = io.staged.slice(0, -'.staging'.length);
        throw io.error;
      }
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
  };
});

const roots: string[] = [];
afterEach(() => {
  io.failWrite = false;
  io.staged = '';
  io.target = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the catalog owners to admit authority and a complete bounded Skill tree. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-catalog-physical-'));
  roots.push(dataRoot);
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  publishWorkspaceResourceCatalog({
    catalog: EMPTY_RESOURCE_CATALOG,
    dataRoot,
    expectedRevision: 0,
    workspaceId,
  });
  const header =
    '---\nname: physical\ndescription: Preserve exact retained bytes.\n---\n# Physical\n';
  const script = '#!/bin/sh\nexit 0\n';
  const text = 'line\r\ncaf\u00e9\u0000';
  const tree = [
    {
      kind: 'file' as const,
      path: 'SKILL.md',
      contentBase64: Buffer.from(header).toString('base64'),
    },
    { kind: 'directory' as const, path: 'empty' },
    { kind: 'file' as const, path: 'scripts/nested/empty.bin', contentBase64: '' },
    {
      kind: 'file' as const,
      path: 'scripts/nested/run.sh',
      contentBase64: Buffer.from(script).toString('base64'),
      executable: true,
    },
    {
      kind: 'file' as const,
      path: 'utf8.txt',
      contentBase64: Buffer.from(text).toString('base64'),
    },
  ];
  return {
    dataRoot,
    workspaceId,
    header,
    script,
    publish: () =>
      importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Physical',
        expectedRevision: 1,
        producer: { id: 'usr_00000000-0000-7000-8000-000000000001', kind: 'user' },
        tree,
        workspaceId,
      }),
  };
}

describe('catalog physical snapshot publication', () => {
  it('retains exact nested, executable, empty and UTF-8 entries through the public reader', () => {
    const f = fixture();
    const { version } = f.publish();
    const snapshot = readWorkspaceSkillSnapshot({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      entryId: version.entryId,
      digest: version.digest,
    });
    // Skill owner, Payload and deterministic digest: preserve directories, bytes and executability.
    expect(
      snapshot.entries.map(({ path, kind, content }) => [
        path,
        kind,
        content?.toString('hex') ?? null,
      ])
    ).toEqual([
      ['SKILL.md', 1, Buffer.from(f.header).toString('hex')],
      ['empty', 0, null],
      ['scripts', 0, null],
      ['scripts/nested', 0, null],
      ['scripts/nested/empty.bin', 1, ''],
      ['scripts/nested/run.sh', 2, Buffer.from(f.script).toString('hex')],
      ['utf8.txt', 1, '6c696e650d0a636166c3a900'],
    ]);
    const target = skillSnapshotPath(f.dataRoot, f.workspaceId, version.entryId, version.digest);
    expect(statSync(join(target, 'scripts/nested/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, 'empty')).isDirectory()).toBe(true);
  });

  it('preserves a staged write failure and removes the incomplete snapshot', () => {
    const f = fixture();
    io.failWrite = true;
    try {
      f.publish();
      expect.unreachable('Publication must report the injected failure');
    } catch (error) {
      expect(error).toBe(io.error);
    }
    expect(io.staged).not.toBe('');
    expect(existsSync(io.staged)).toBe(false);
    expect(existsSync(io.target)).toBe(false);
    expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId).skills.versions).toEqual([]);
  });
});
