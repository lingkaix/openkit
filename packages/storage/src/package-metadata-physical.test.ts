// openkit-test-platform: posix
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrivateMetadataDirectory, writePrivateMetadataText } from './local.js';

const effect = vi.hoisted(() => ({ path: '', error: undefined as Error | undefined }));

// Preserve real files and native creation flags; interrupt one write after real partial output.
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      if (String(args[0]) === effect.path) {
        await actual.writeFile(args[0], Buffer.from([0x50, 0x00, 0xc3, 0xa9]), args[2]);
        throw effect.error;
      }
      return actual.writeFile(...args);
    },
  };
});

const parents: string[] = [];
afterEach(async () => {
  effect.path = '';
  effect.error = undefined;
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** Allocate only disposable physical bytes, without Knowledge or publication authority. */
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'storage-package-metadata-'));
  parents.push(parent);
  return { parent, root: join(parent, 'export-metadata') };
}

// Owner: File Storage And Knowledge Packages / Knowledge Package Format, exact authored bytes.
// Accepted body MOVE also preserves the original native flags, modes and failure residue.
describe('Knowledge export metadata physical operations', () => {
  it('creates exactly one exclusive private directory and creates no missing parent', async () => {
    const { parent, root } = await fixture();
    await createPrivateMetadataDirectory(root);
    expect((await stat(root)).mode & 0o777).toBe(0o700 & ~process.umask());
    await chmod(root, 0o750);
    await writeFile(join(root, 'retained'), 'retained');
    const before = await stat(root);

    await expect(createPrivateMetadataDirectory(root)).rejects.toMatchObject({ code: 'EEXIST' });
    const after = await stat(root);
    expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
    expect(await readFile(join(root, 'retained'), 'utf8')).toBe('retained');
    const missing = join(parent, 'absent', 'metadata');
    await expect(createPrivateMetadataDirectory(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(dirname(missing))).rejects.toMatchObject({ code: 'ENOENT' });
    const occupied = join(parent, 'occupied');
    await writeFile(occupied, 'occupied');
    await expect(createPrivateMetadataDirectory(occupied)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(occupied, 'utf8')).toBe('occupied');
  });

  it('writes exact UTF-8 and NUL bytes through recursive private parents without chmod of existing parents', async () => {
    const { root } = await fixture();
    await createPrivateMetadataDirectory(root);
    const retainedParent = join(root, 'pages');
    await mkdir(retainedParent, { mode: 0o750 });
    await chmod(retainedParent, 0o750);
    const member = join(retainedParent, 'nested', 'guide.md');
    await writePrivateMetadataText(member, 'A\0é😀\r\n');

    expect(await readFile(member)).toEqual(
      Buffer.from([0x41, 0x00, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0x0d, 0x0a])
    );
    expect((await stat(retainedParent)).mode & 0o777).toBe(0o750);
    expect((await stat(dirname(member))).mode & 0o777).toBe(0o700 & ~process.umask());
    expect((await stat(member)).mode & 0o777).toBe(0o600 & ~process.umask());
    const empty = join(root, 'schema', 'empty.yaml');
    await writePrivateMetadataText(empty, '');
    expect(await readFile(empty)).toEqual(Buffer.alloc(0));
    const before = await stat(member);
    await expect(writePrivateMetadataText(member, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    const after = await stat(member);
    expect([after.dev, after.ino, after.mode, after.size]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.size,
    ]);
    expect(await readFile(member)).toEqual(
      Buffer.from([0x41, 0x00, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0x0d, 0x0a])
    );
  });

  it('preserves umask filtering rather than repairing creation modes', async () => {
    const { parent, root } = await fixture();
    const prior = process.umask(0o200);
    try {
      await createPrivateMetadataDirectory(root);
      expect((await stat(root)).mode & 0o777).toBe(0o500);
    } finally {
      process.umask(prior);
      await chmod(root, 0o700).catch(() => undefined);
    }
    const member = join(parent, 'masked.md');
    const beforeWrite = process.umask(0o400);
    try {
      await writePrivateMetadataText(member, 'masked');
      expect((await stat(member)).mode & 0o777).toBe(0o200);
    } finally {
      process.umask(beforeWrite);
    }
  });

  it('keeps prior bytes and the native parent-creation refusal without cleanup', async () => {
    const { root } = await fixture();
    await createPrivateMetadataDirectory(root);
    const retained = join(root, 'pages', 'retained.md');
    await writePrivateMetadataText(retained, 'retained');
    const blocker = join(root, 'schema');
    await writeFile(blocker, 'blocking file');

    await expect(
      writePrivateMetadataText(join(blocker, 'scope-schema.yaml'), 'schema')
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(retained, 'utf8')).toBe('retained');
    expect(await readFile(blocker, 'utf8')).toBe('blocking file');
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('propagates the same write failure and retains completed parents and partial bytes', async () => {
    const { root } = await fixture();
    await createPrivateMetadataDirectory(root);
    const retained = join(root, 'pages', 'retained.md');
    await writePrivateMetadataText(retained, 'retained');
    const member = join(root, 'sources', 'pointer.md');
    const failure = new Error('injected metadata write failure after partial bytes');
    effect.path = member;
    effect.error = failure;

    await expect(writePrivateMetadataText(member, 'complete pointer')).rejects.toBe(failure);

    expect(await readFile(member)).toEqual(Buffer.from([0x50, 0x00, 0xc3, 0xa9]));
    expect((await stat(dirname(member))).isDirectory()).toBe(true);
    expect(await readFile(retained, 'utf8')).toBe('retained');
    effect.path = '';
    await expect(writePrivateMetadataText(member, 'retry')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(member)).toEqual(Buffer.from([0x50, 0x00, 0xc3, 0xa9]));
  });
});
