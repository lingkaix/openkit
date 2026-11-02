// openkit-test-platform: posix
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyBackupTree } from './local.js';

const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) {
    // Read-only source and restored destination directories remain caller-owned fixtures.
    for (const root of ['source', 'new/backup']) {
      const path = join(parent, root);
      if (existsSync(path) && lstatSync(path).isDirectory()) {
        chmodSync(path, 0o700);
        const nested = join(path, 'nested');
        if (existsSync(nested)) chmodSync(nested, 0o700);
      }
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

/** Use private temporary bytes, without a manifest, seal or publication authority. */
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'storage-backup-tree-'));
  parents.push(parent);
  const source = join(parent, 'source');
  const destination = join(parent, 'new', 'backup');
  mkdirSync(source);
  return { parent, source, destination };
}

// Storage Core's immutable-content boundary and Backup And Restore's whole-server
// boundary require unchanged retained bytes. Modes, options and failure residue
// characterize the existing physical copy; this is not snapshot or restore acceptance.
describe('backup tree physical copy', () => {
  it('copies exact binary bytes and empty directories, restoring read-only modes and opted-in times', () => {
    const { source, destination } = fixture();
    const nested = join(source, 'nested');
    const empty = join(nested, 'empty');
    const file = join(nested, 'original.bin');
    const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 1, 254]);
    mkdirSync(empty, { recursive: true });
    writeFileSync(file, bytes);
    chmodSync(file, 0o440);
    chmodSync(empty, 0o711);
    chmodSync(nested, 0o555);
    chmodSync(source, 0o550);
    const atime = new Date('2001-02-03T04:05:06.000Z');
    const mtime = new Date('2002-03-04T05:06:07.000Z');
    for (const path of [source, nested, empty, file]) utimesSync(path, atime, mtime);

    copyBackupTree(source, destination, {
      preserveTimestamps: true,
      filter: () => {
        // The copy must populate read-only source directories through private writable output.
        expect(statSync(destination).mode & 0o777).toBe(0o700);
        expect(statSync(join(destination, 'nested')).mode & 0o777).toBe(0o700);
        return true;
      },
    });

    for (const [path, mode] of [
      ['', 0o550],
      ['nested', 0o555],
      ['nested/empty', 0o711],
      ['nested/original.bin', 0o440],
    ] as const) {
      const copied = statSync(join(destination, path));
      expect(copied.mode & 0o7777).toBe(mode);
      expect(copied.atimeMs).toBe(atime.getTime());
      expect(copied.mtimeMs).toBe(mtime.getTime());
      expect(statSync(join(source, path)).mode & 0o7777).toBe(mode);
    }
    expect(readdirSync(join(destination, 'nested')).sort()).toEqual(['empty', 'original.bin']);
    expect(readdirSync(join(destination, 'nested', 'empty'))).toEqual([]);
    expect(readFileSync(join(destination, 'nested', 'original.bin'))).toEqual(bytes);
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('filters only regular files with their absolute source path and the original options receiver', () => {
    const { parent, source, destination } = fixture();
    mkdirSync(join(source, 'runtime', 'empty'), { recursive: true });
    const omitted = join(source, 'runtime', 'nanocore.lock');
    const kept = join(source, 'runtime', 'retained.bin');
    const bytes = Buffer.from([0, 255, 192, 10]);
    writeFileSync(omitted, 'active source lock');
    writeFileSync(kept, bytes);
    const seen: string[] = [];
    const options = {
      filter(this: unknown, path: string) {
        expect(this).toBe(options);
        seen.push(path);
        return path !== omitted;
      },
    };

    copyBackupTree(join(parent, 'source', '.'), destination, options);

    expect(seen.sort()).toEqual([omitted, kept].sort());
    expect(seen.every((path) => path === resolve(path))).toBe(true);
    expect(existsSync(join(destination, 'runtime', 'nanocore.lock'))).toBe(false);
    expect(readFileSync(join(destination, 'runtime', 'retained.bin'))).toEqual(bytes);
    expect(readdirSync(join(destination, 'runtime', 'empty'))).toEqual([]);
    expect(readFileSync(omitted, 'utf8')).toBe('active source lock');
    expect(readFileSync(kept)).toEqual(bytes);
  });

  it('refuses an existing destination unchanged, then resets it when existence refusal is omitted', () => {
    const { source, destination } = fixture();
    const bytes = Buffer.from([0, 255, 128, 4]);
    const original = join(source, 'original.bin');
    writeFileSync(original, bytes);
    const oldTime = new Date('2000-01-02T03:04:05.000Z');
    utimesSync(original, oldTime, oldTime);
    mkdirSync(join(destination, 'stale'), { recursive: true });
    writeFileSync(join(destination, 'stale', 'retained'), 'prior destination');

    expect(() => copyBackupTree(source, destination, { errorOnExist: true })).toThrow();

    expect(readdirSync(destination)).toEqual(['stale']);
    expect(readFileSync(join(destination, 'stale', 'retained'), 'utf8')).toBe('prior destination');
    expect(readFileSync(original)).toEqual(bytes);

    copyBackupTree(source, destination);

    expect(readdirSync(destination)).toEqual(['original.bin']);
    expect(readFileSync(join(destination, 'original.bin'))).toEqual(bytes);
    expect(statSync(join(destination, 'original.bin')).mtimeMs).not.toBe(oldTime.getTime());
    expect(readFileSync(original)).toEqual(bytes);
    expect(statSync(original).mtimeMs).toBe(oldTime.getTime());
  });

  it('refuses a symlink or regular-file source root before changing an existing destination', () => {
    const { parent, source, destination } = fixture();
    const bytes = Buffer.from([0, 255, 3]);
    writeFileSync(join(source, 'original'), bytes);
    const link = join(parent, 'source-link');
    const file = join(parent, 'source-file');
    symlinkSync(source, link, 'dir');
    writeFileSync(file, bytes);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'retained'), 'prior destination');

    for (const invalid of [link, file]) {
      expect(() => copyBackupTree(invalid, destination)).toThrow();
      expect(readdirSync(destination)).toEqual(['retained']);
      expect(readFileSync(join(destination, 'retained'), 'utf8')).toBe('prior destination');
    }
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(file)).toEqual(bytes);
    expect(readFileSync(join(source, 'original'))).toEqual(bytes);
  });

  it('refuses a nested symlink even when all files are filtered out and leaves cleanup to the caller', () => {
    const { parent, source, destination } = fixture();
    const target = join(parent, 'retained-target');
    const bytes = Buffer.from([0, 255, 6]);
    writeFileSync(target, bytes);
    const link = join(source, 'linked-file');
    symlinkSync(target, link);

    expect(() => copyBackupTree(source, destination, { filter: () => false })).toThrow();

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(bytes);
    expect(statSync(destination).isDirectory()).toBe(true);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
    expect(readdirSync(destination)).toEqual([]);
    rmSync(destination, { recursive: true });
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(target)).toEqual(bytes);
  });

  it('refuses a real Unix socket before the file filter can admit it', async () => {
    // AF_UNIX paths have a small fixed limit; the run's nested TMPDIR can exceed it.
    const parent = mkdtempSync('/tmp/storage-backup-socket-');
    parents.push(parent);
    const source = join(parent, 'source');
    const destination = join(parent, 'new', 'backup');
    mkdirSync(source, { mode: 0o700 });
    const socket = join(source, 'unsupported.sock');
    const server = createServer();
    server.listen(socket);
    await once(server, 'listening');
    try {
      expect(lstatSync(socket).isSocket()).toBe(true);

      expect(() => copyBackupTree(source, destination, { filter: () => false })).toThrow();

      expect(lstatSync(socket).isSocket()).toBe(true);
      expect(statSync(destination).isDirectory()).toBe(true);
      expect(statSync(destination).mode & 0o777).toBe(0o700);
      expect(readdirSync(destination)).toEqual([]);
    } finally {
      await new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
      });
    }
  });
});
