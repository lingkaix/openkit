// openkit-test-platform: posix
import fs, { type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendTelemetrySegment,
  closeTelemetrySegment,
  createTelemetrySegment,
  hasTelemetryHeadroom,
  listTelemetrySegments,
  removeTelemetrySegment,
  telemetrySegmentNeedsClose,
} from './local.js';

const readFilesystemStats = fs.statfs;
const roots: string[] = [];
const handles: FileHandle[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close().catch(() => {});
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** Each physical scenario owns real files under a fresh private root. */
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'storage-telemetry-'));
  roots.push(root);
  return { root, directory: join(root, 'logs', 'telemetry') };
}

/** Track actual descriptors so an assertion failure cannot leak a live test handle. */
async function openSegment(path: string): Promise<FileHandle> {
  const handle = await createTelemetrySegment(path);
  handles.push(handle);
  return handle;
}

/** Only capacity is controlled; the default fs object still observes the real fixture filesystem. */
function filesystemCapacity(
  overrides: Partial<{ bsize: bigint; bavail: bigint; files: bigint; ffree: bigint }> = {}
) {
  return vi.spyOn(fs, 'statfs').mockImplementation(async (...args) => {
    const stats = await readFilesystemStats(...args);
    return Object.assign(stats, {
      bsize: 4096n,
      bavail: 10n,
      files: 100n,
      ffree: 20n,
      ...overrides,
    });
  });
}

describe('confined telemetry segment inventory', () => {
  it('creates private directories and inventories exact sizes in age then path order', async () => {
    // Operational Telemetry / Built-in Local Sink: owner-only, separate signals and oldest pruning facts.
    const { root, directory } = await fixture();
    expect(await listTelemetrySegments(directory)).toEqual([]);
    for (const path of [join(root, 'logs'), directory])
      expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
    const entries = [
      { name: 'traces-20-b.jsonl', bytes: Buffer.from([0, 255]), modified: 2_000 },
      { name: 'metrics-30-f.jsonl', bytes: Buffer.from([1, 2, 3]), modified: 1_000 },
      { name: 'traces-10-a.jsonl', bytes: Buffer.from([128]), modified: 2_000 },
      { name: 'metrics-20-a.jsonl', bytes: Buffer.alloc(0), modified: 2_000 },
    ];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      await fs.writeFile(path, entry.bytes);
      await fs.utimes(path, new Date(entry.modified), new Date(entry.modified));
    }
    const inventory = await listTelemetrySegments(directory);
    expect(inventory.map((entry) => entry.path)).toEqual([
      join(directory, 'metrics-30-f.jsonl'),
      join(directory, 'metrics-20-a.jsonl'),
      join(directory, 'traces-10-a.jsonl'),
      join(directory, 'traces-20-b.jsonl'),
    ]);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      expect(inventory).toContainEqual({
        path,
        bytes: entry.bytes.length,
        modified: (await fs.stat(path)).mtimeMs,
      });
      expect(await fs.readFile(path)).toEqual(entry.bytes);
    }
  });

  it.each(['sink', 'ancestor'] as const)(
    'revalidates a replaced %s directory and preserves bytes beyond its symlink',
    async (linkAt) => {
      const { root, directory } = await fixture();
      await listTelemetrySegments(directory);
      const outside = join(root, 'outside');
      const target = linkAt === 'sink' ? outside : join(outside, 'telemetry');
      await fs.mkdir(target, { recursive: true });
      const sentinel = join(target, 'traces-1-a.jsonl');
      const bytes = Buffer.from('external diagnostic bytes');
      await fs.writeFile(sentinel, bytes);
      const linkedPath = linkAt === 'sink' ? directory : join(root, 'logs');
      await fs.rm(linkedPath, { recursive: true });
      await fs.symlink(outside, linkedPath, 'dir');
      await expect(listTelemetrySegments(directory)).rejects.toThrow();
      await expect(listTelemetrySegments(directory)).rejects.toThrow();
      expect(await fs.readFile(sentinel)).toEqual(bytes);
    }
  );

  it('refuses a regular file in a required directory position without changing its bytes', async () => {
    const { root, directory } = await fixture();
    const bytes = Buffer.from('retained non-directory');
    await fs.writeFile(join(root, 'logs'), bytes);
    await expect(listTelemetrySegments(directory)).rejects.toThrow();
    expect(await fs.readFile(join(root, 'logs'))).toEqual(bytes);
  });

  it.each(['unrecognized file', 'nested directory', 'segment symlink'] as const)(
    'refuses an inventory containing a %s before exposing disposable paths',
    async (kind) => {
      const { root, directory } = await fixture();
      await listTelemetrySegments(directory);
      const sentinel = join(root, 'canonical');
      await fs.writeFile(sentinel, 'canonical bytes');
      if (kind === 'unrecognized file')
        await fs.writeFile(join(directory, 'unowned'), 'unowned bytes');
      else if (kind === 'nested directory') await fs.mkdir(join(directory, 'traces-1-a.jsonl'));
      else await fs.symlink(sentinel, join(directory, 'traces-1-a.jsonl'));
      await expect(listTelemetrySegments(directory)).rejects.toThrow();
      expect(await fs.readFile(sentinel, 'utf8')).toBe('canonical bytes');
    }
  );
});

describe('current telemetry filesystem headroom', () => {
  it('reads the live original reserve receiver and admits byte equality without caching capacity', async () => {
    // Core Storage / SQLite Layers and Operational Telemetry / Built-in Local Sink: preserve reserve.
    const { root } = await fixture();
    const checked = filesystemCapacity();
    const options = {
      reserve: 39_960,
      readReserveBytes() {
        expect(this).toBe(options);
        return this.reserve;
      },
    };
    // Ten 4096-byte blocks minus 1000 incoming bytes leave exactly the fixed reserve.
    expect(await hasTelemetryHeadroom(options, root, 1_000)).toBe(true);
    expect(await hasTelemetryHeadroom(options, root, 1_001)).toBe(false);
    options.reserve = 39_959;
    expect(await hasTelemetryHeadroom(options, root, 1_001)).toBe(true);
    expect(checked).toHaveBeenCalledWith(root, { bigint: true });
  });

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['unknown', Number.NaN],
  ] as const)('refuses a %s reserve', async (_label, reserve) => {
    const { root } = await fixture();
    filesystemCapacity();
    expect(await hasTelemetryHeadroom({ readReserveBytes: () => reserve }, root, 1)).toBe(false);
  });

  it.each([
    ['no positive block size', { bsize: 0n }, false],
    ['negative available blocks', { bavail: -1n }, false],
    ['exhausted finite inodes', { ffree: 0n }, false],
    ['unreported inode limit', { files: 0n, ffree: 0n }, true],
    ['unreported inodes and exhausted bytes', { files: 0n, ffree: 0n, bavail: 0n }, false],
  ] as const)('uses actual %s facts without consuming reserve', async (_label, facts, admitted) => {
    const { root } = await fixture();
    filesystemCapacity(facts);
    expect(await hasTelemetryHeadroom({ readReserveBytes: () => 1_000 }, root, 100)).toBe(admitted);
  });

  it('refuses unknown filesystem capacity through the same default fs object', async () => {
    const { root } = await fixture();
    const refusal = Object.assign(new Error('Selected filesystem refusal.'), { code: 'EIO' });
    const checked = vi.spyOn(fs, 'statfs').mockRejectedValue(refusal);
    expect(await hasTelemetryHeadroom({ readReserveBytes: () => 0 }, root, 1)).toBe(false);
    expect(checked).toHaveBeenCalledWith(root, { bigint: true });
  });

  it('refuses an unavailable current reserve rather than granting unknown headroom', async () => {
    const { root } = await fixture();
    filesystemCapacity();
    expect(
      await hasTelemetryHeadroom(
        {
          readReserveBytes() {
            throw new Error('Current reserve unavailable.');
          },
        },
        root,
        1
      )
    ).toBe(false);
  });
});

describe('telemetry descriptor effects', () => {
  it('exclusively creates owner-only bytes, appends exact buffers and closes before caller removal', async () => {
    const { root } = await fixture();
    const path = join(root, 'traces-1-a.jsonl');
    const handle = await openSegment(path);
    const active = { path, handle, bytes: 0 };
    const first = Buffer.from([0, 255, 128, 10]);
    const second = Buffer.from('a second request\n');
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await telemetrySegmentNeedsClose(active)).toBe(false);
    await appendTelemetrySegment(active, first);
    await appendTelemetrySegment(active, second);
    expect(active.bytes).toBe(first.length + second.length);
    expect(await fs.readFile(path)).toEqual(Buffer.concat([first, second]));
    await closeTelemetrySegment(active);
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    await removeTelemetrySegment(path);
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['existing file', 'existing symlink'] as const)(
    'refuses an %s instead of overwriting or following its bytes',
    async (kind) => {
      const { root } = await fixture();
      const original = join(root, 'original');
      const path = kind === 'existing file' ? original : join(root, 'linked');
      const bytes = Buffer.from('retained bytes');
      await fs.writeFile(original, bytes);
      if (kind === 'existing symlink') await fs.symlink(original, path);
      await expect(createTelemetrySegment(path)).rejects.toThrow();
      expect(await fs.readFile(original)).toEqual(bytes);
    }
  );

  it('refuses a real short append without retrying it or advancing the complete-byte counter', async () => {
    // Operational Telemetry / Built-in Local Sink: abandon a partial append; do not repair its tail.
    const { root } = await fixture();
    const path = join(root, 'traces-1-a.jsonl');
    const handle = await openSegment(path);
    const active = { handle, bytes: 0 };
    const bytes = Buffer.from('complete request\n');
    const write = handle.write.bind(handle);
    const written = vi
      .spyOn(handle, 'write')
      .mockImplementation(((buffer: Buffer) => write(buffer, 0, 2)) as FileHandle['write']);
    await expect(appendTelemetrySegment(active, bytes)).rejects.toThrow();
    expect(written).toHaveBeenCalledOnce();
    expect(active.bytes).toBe(0);
    expect(await fs.readFile(path)).toEqual(bytes.subarray(0, 2));
    await closeTelemetrySegment(active);
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('preserves append refusal and the original counter when no write completes', async () => {
    const { root } = await fixture();
    const path = join(root, 'metrics-1-a.jsonl');
    const handle = await openSegment(path);
    const prefix = Buffer.from('previous complete request\n');
    const active = { handle, bytes: 0 };
    await appendTelemetrySegment(active, prefix);
    const refusal = new Error('Selected descriptor write refusal.');
    vi.spyOn(handle, 'write').mockRejectedValue(refusal);
    await expect(appendTelemetrySegment(active, Buffer.from('unwritten\n'))).rejects.toBe(refusal);
    expect(active.bytes).toBe(prefix.length);
    expect(await fs.readFile(path)).toEqual(prefix);
  });

  it.each(['missing', 'replaced file', 'directory', 'symlink'] as const)(
    'requires close when the active path becomes %s while its original descriptor remains open',
    async (kind) => {
      const { root } = await fixture();
      const path = join(root, 'traces-1-a.jsonl');
      const handle = await openSegment(path);
      const active = { path, handle, bytes: 0 };
      const bytes = Buffer.from('old diagnostic bytes');
      await appendTelemetrySegment(active, bytes);
      const retained = join(root, 'old-segment');
      await fs.rename(path, retained);
      if (kind === 'replaced file') await fs.writeFile(path, 'replacement');
      else if (kind === 'directory') await fs.mkdir(path);
      else if (kind === 'symlink') await fs.symlink(retained, path);
      expect(await telemetrySegmentNeedsClose(active)).toBe(true);
      expect((await handle.stat()).size).toBe(bytes.length);
      expect(await fs.readFile(retained)).toEqual(bytes);
    }
  );

  it('preserves a failed descriptor observation even when the pathname is absent', async () => {
    const { root } = await fixture();
    const path = join(root, 'traces-1-a.jsonl');
    const handle = await openSegment(path);
    await handle.close();
    await fs.unlink(path);
    await expect(telemetrySegmentNeedsClose({ path, handle })).rejects.toMatchObject({
      code: 'EBADF',
    });
  });

  it('contains close failure after releasing the actual descriptor and accepts no active segment', async () => {
    const { root } = await fixture();
    const handle = await openSegment(join(root, 'traces-1-a.jsonl'));
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      throw new Error('Selected close acknowledgement failure.');
    });
    await expect(closeTelemetrySegment({ handle })).resolves.toBeUndefined();
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    await expect(closeTelemetrySegment(undefined)).resolves.toBeUndefined();
  });

  it('unlinks only the selected entry and propagates failed removal', async () => {
    const { root } = await fixture();
    const selected = join(root, 'metrics-1-a.jsonl');
    const retained = join(root, 'canonical');
    await fs.writeFile(selected, 'disposable bytes');
    await fs.writeFile(retained, 'retained bytes');
    await removeTelemetrySegment(selected);
    expect(await fs.readFile(retained, 'utf8')).toBe('retained bytes');
    await expect(removeTelemetrySegment(selected)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
