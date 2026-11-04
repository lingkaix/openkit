// openkit-test-platform: posix
import {
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writePrivateTextFileExclusive } from './local.js';

const roots: string[] = [];
const handles: FileHandle[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) {
    if (handle.fd !== -1) await handle.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Own only disposable files; domain admission and failed-tree cleanup stay outside Storage. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'storage-private-text-exclusive-'));
  roots.push(root);
  return { root, path: join(root, 'manifest.json') };
}

/** Obtain the real handle prototype without replacing filesystem modules or handles. */
async function handlePrototype(path: string): Promise<FileHandle> {
  const handle = await open(path, 'wx', 0o600);
  try {
    return Object.getPrototypeOf(handle) as FileHandle;
  } finally {
    await handle.close();
  }
}

// File Storage / Knowledge Package Format requires fresh private staging.
// The authorized physical move preserves the original manifest body's bytes and close-only lifetime.
describe('exclusive private text file writing', () => {
  it.each([
    {
      name: 'UTF-8',
      text: 'aé中😀\0\r\n',
      bytes: Buffer.from('61c3a9e4b8adf09f9880000d0a', 'hex'),
    },
    { name: 'empty', text: '', bytes: Buffer.alloc(0) },
  ])('creates exact $name bytes with native private creation mode', async ({ text, bytes }) => {
    const { root, path } = await fixture();
    const control = join(root, 'native-mode-control');
    const native = await open(control, 'wx', 0o600);
    await native.close();

    await writePrivateTextFileExclusive(path, text);

    expect(await readFile(path)).toEqual(bytes);
    // The original requested mode is 0600; native umask may remove permissions.
    expect((await stat(path)).mode & 0o777).toBe((await stat(control)).mode & 0o777);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it('refuses existing files and links without changing retained bytes or the link', async () => {
    const { root, path } = await fixture();
    const retained = Buffer.from([0, 255, 13, 10]);
    await writeFile(path, retained);
    await expect(writePrivateTextFileExclusive(path, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(path)).toEqual(retained);

    const target = join(root, 'retained');
    await writeFile(target, retained);
    await rm(path);
    await symlink(target, path);
    const link = await lstat(path);
    await expect(writePrivateTextFileExclusive(path, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect((await lstat(path)).ino).toBe(link.ino);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target)).toEqual(retained);
  });

  it('preserves missing-parent refusal without creating a partial parent tree', async () => {
    const { root } = await fixture();
    await expect(
      writePrivateTextFileExclusive(join(root, 'missing', 'nested', 'manifest.json'), 'text')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    { name: 'write failure', writeFails: true, closeFails: false },
    { name: 'close failure', writeFails: false, closeFails: true },
    { name: 'close failure over write failure', writeFails: true, closeFails: true },
  ])('preserves $name, closed descriptors and caller-owned residue', async (fault) => {
    const { root, path } = await fixture();
    const prototype = await handlePrototype(join(root, 'probe'));
    const originalWriteFile = prototype.writeFile;
    const writeFailure = new Error('Selected native write boundary failure.');
    const closeFailure = new Error('Selected native close boundary failure.');
    const prefix = Buffer.from('61c3a9e4', 'hex');
    const text = 'aé中😀\0\r\n';
    const complete = Buffer.from('61c3a9e4b8adf09f9880000d0a', 'hex');
    let output: FileHandle | undefined;
    vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle['writeFile']>
    ) {
      output = this;
      handles.push(this);
      const close = this.close.bind(this);
      vi.spyOn(this, 'close').mockImplementation(async () => {
        await close();
        if (fault.closeFails) throw closeFailure;
      });
      // Keep a real open, real write and real close; interrupt only the selected completion boundary.
      if (fault.writeFails) {
        await originalWriteFile.call(this, prefix);
        throw writeFailure;
      }
      await originalWriteFile.apply(this, args);
    });

    await expect(writePrivateTextFileExclusive(path, text)).rejects.toBe(
      fault.closeFails ? closeFailure : writeFailure
    );
    expect(output).toBeDefined();
    expect(output!.fd).toBe(-1);
    expect(await readFile(path)).toEqual(fault.writeFails ? prefix : complete);
  });
});
