// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  appendFile,
  type FileHandle,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPrivateFileCopy } from './local.js';

type BufferIo = [Buffer, number, number, number | null];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Supplies an independently calculated identity for real private fixture bytes. */
async function fixture(bytes: Buffer = Buffer.from('private member')) {
  const root = await mkdtemp(join(tmpdir(), 'storage-private-member-'));
  roots.push(root);
  const source = join(root, 'source');
  await writeFile(source, bytes);
  return {
    root,
    source,
    output: join(root, 'output'),
    bytes,
    expected: {
      byteLength: bytes.length,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  };
}

/** Obtains the real handle prototype without replacing filesystem modules or handles. */
async function handlePrototype(path: string): Promise<FileHandle> {
  const handle = await open(path, 'r');
  try {
    return Object.getPrototypeOf(handle) as FileHandle;
  } finally {
    await handle.close();
  }
}

describe('private member verification and copy', () => {
  it('verifies and copies exact multi-chunk binary and empty bytes into private independent files', async () => {
    for (const bytes of [
      Buffer.from(Array.from({ length: 2 * 65536 + 37 }, (_, i) => i % 251)),
      Buffer.alloc(0),
    ]) {
      const f = await fixture(bytes);
      await verifyPrivateFileCopy(f.source, f.expected);
      expect(await readdir(f.root)).toEqual(['source']);
      await verifyPrivateFileCopy(f.source, f.expected, f.output);
      // File Storage owner: package capture leaves included authored and raw bytes unchanged.
      expect(await readFile(f.output)).toEqual(bytes);
      expect((await stat(f.output)).mode & 0o777).toBe(0o600);
      expect((await stat(f.output)).ino).not.toBe((await stat(f.source)).ino);
    }
  });

  it('refuses an existing output or output link without changing its target', async () => {
    const f = await fixture();
    const target = join(f.root, 'target');
    await writeFile(target, 'keep target');
    await writeFile(f.output, 'keep output');
    await expect(verifyPrivateFileCopy(f.source, f.expected, f.output)).rejects.toThrow();
    expect(await readFile(f.output, 'utf8')).toBe('keep output');
    await rm(f.output);
    await symlink(target, f.output);
    await expect(verifyPrivateFileCopy(f.source, f.expected, f.output)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('keep target');
  });

  it('refuses wrong lengths, nonregular sources and links before creating output', async () => {
    const f = await fixture();
    await expect(
      verifyPrivateFileCopy(f.source, { ...f.expected, byteLength: f.bytes.length + 1 }, f.output)
    ).rejects.toThrow();
    const directory = join(f.root, 'directory');
    await mkdir(directory);
    await expect(
      verifyPrivateFileCopy(directory, { ...f.expected, byteLength: 0 }, f.output)
    ).rejects.toThrow();
    const alias = join(f.root, 'alias');
    await symlink(f.source, alias);
    await expect(verifyPrivateFileCopy(alias, f.expected, f.output)).rejects.toThrow();
    await rm(alias);
    await link(f.source, alias);
    await expect(verifyPrivateFileCopy(f.source, f.expected, f.output)).rejects.toThrow();
    await expect(lstat(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a wrong digest and leaves its created private output for caller cleanup', async () => {
    const f = await fixture();
    const wrong = { ...f.expected, contentDigest: `sha256:${'0'.repeat(64)}` };
    await expect(verifyPrivateFileCopy(f.source, wrong)).rejects.toThrow();
    await expect(verifyPrivateFileCopy(f.source, wrong, f.output)).rejects.toThrow();
    expect(await readFile(f.output)).toEqual(f.bytes);
    expect(await readFile(f.source)).toEqual(f.bytes);
  });

  it('continues real short writes at the correct buffer offset', async () => {
    const f = await fixture(Buffer.from(Array.from({ length: 65536 + 23 }, (_, i) => i % 251)));
    const prototype = await handlePrototype(f.source);
    const write = prototype.write;
    let writes = 0;
    vi.spyOn(prototype, 'write').mockImplementation(async function (
      this: FileHandle,
      ...args: BufferIo
    ) {
      const [buffer, offset, length, position] = args;
      writes++;
      return write.bind(this)(buffer, offset, Math.min(length, 257), position);
    } as FileHandle['write']);
    await verifyPrivateFileCopy(f.source, f.expected, f.output);
    expect(writes).toBeGreaterThan(2);
    expect(await readFile(f.output)).toEqual(f.bytes);
  });

  it('refuses zero write progress and retains the actual written prefix', async () => {
    const f = await fixture();
    const prototype = await handlePrototype(f.source);
    const write = prototype.write;
    let writes = 0;
    vi.spyOn(prototype, 'write').mockImplementation(async function (
      this: FileHandle,
      ...args: BufferIo
    ) {
      const [buffer, offset, , position] = args;
      if (writes++ === 0) return write.bind(this)(buffer, offset, 3, position);
      if (writes === 2) return { bytesWritten: 0, buffer };
      throw new Error('Zero progress was retried.');
    } as FileHandle['write']);
    // The authorized move preserves this original refusal; the third call bounds a broken loop.
    await expect(verifyPrivateFileCopy(f.source, f.expected, f.output)).rejects.toThrow(
      'output write made no progress'
    );
    expect(await readFile(f.output)).toEqual(f.bytes.subarray(0, 3));
  });

  it('refuses source growth and metadata-only changes during actual reads', async () => {
    for (const fault of ['growth', 'metadata'] as const) {
      const f = await fixture();
      const prototype = await handlePrototype(f.source);
      const read = prototype.read;
      let changed = false;
      const reading = vi.spyOn(prototype, 'read').mockImplementation(async function (
        this: FileHandle,
        ...args: BufferIo
      ) {
        const [buffer, offset, length, position] = args;
        const result = await read.bind(this)(buffer, offset, length, position);
        if (!changed && result.bytesRead > 0) {
          changed = true;
          if (fault === 'growth') await appendFile(f.source, 'added');
          else await utimes(f.source, new Date(0), new Date(0));
        }
        return result;
      } as FileHandle['read']);
      await expect(verifyPrivateFileCopy(f.source, f.expected, f.output)).rejects.toThrow();
      reading.mockRestore();
      expect(changed).toBe(true);
      expect(await readFile(f.output)).toEqual(f.bytes);
    }
  });

  it('still closes the source when destination close fails after closing the real handle', async () => {
    const f = await fixture();
    const prototype = await handlePrototype(f.source);
    const write = prototype.write;
    const reading = vi.spyOn(prototype, 'read');
    const refusal = new Error('Selected destination close failure.');
    let destination: FileHandle | undefined;
    vi.spyOn(prototype, 'write').mockImplementation(async function (
      this: FileHandle,
      ...args: BufferIo
    ) {
      const [buffer, offset, length, position] = args;
      if (!destination) {
        destination = this;
        const close = this.close.bind(this);
        vi.spyOn(this, 'close').mockImplementation(async () => {
          await close();
          throw refusal;
        });
      }
      return write.bind(this)(buffer, offset, length, position);
    } as FileHandle['write']);
    await expect(verifyPrivateFileCopy(f.source, f.expected, f.output)).rejects.toBe(refusal);
    // The preserved nested finally must release the source despite destination close failure.
    expect((reading.mock.contexts[0] as FileHandle).fd).toBe(-1);
    vi.restoreAllMocks();
    expect(await readFile(f.output)).toEqual(f.bytes);
  });
});
