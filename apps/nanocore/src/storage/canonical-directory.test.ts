// openkit-test-platform: posix
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertCanonicalDirectory,
  assertCanonicalRegularFile,
  ensureCanonicalDirectory,
  syncCanonicalDirectory,
  syncCanonicalTree,
} from '@openkit/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  paths: new Map<number, string>(),
  events: [] as Array<{ operation: 'mkdir' | 'sync'; path: string }>,
  closed: [] as string[],
  failSync: undefined as string | undefined,
  rejectFile: undefined as string | undefined,
  failure: new Error('Injected canonical sync failure.'),
}));

// Real I/O remains the subject. This seam observes acknowledgement and injects descriptor faults.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: ((...args: Parameters<typeof actual.mkdirSync>) => {
      io.events.push({ operation: 'mkdir', path: String(args[0]) });
      return actual.mkdirSync(...args);
    }) as typeof actual.mkdirSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      io.paths.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof actual.openSync,
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      const metadata = actual.fstatSync(...args);
      if (io.rejectFile !== undefined && io.paths.get(args[0]) === io.rejectFile)
        metadata.isFile = () => false;
      return metadata;
    }) as typeof actual.fstatSync,
    fsyncSync: ((descriptor: number) => {
      const path = io.paths.get(descriptor)!;
      io.events.push({ operation: 'sync', path });
      if (path === io.failSync) throw io.failure;
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    closeSync: ((descriptor: number) => {
      const path = io.paths.get(descriptor)!;
      actual.closeSync(descriptor);
      io.closed.push(path);
      io.paths.delete(descriptor);
    }) as typeof actual.closeSync,
  };
});

const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  for (const descriptor of io.paths.keys()) actual.closeSync(descriptor);
  io.paths.clear();
  io.events.length = 0;
  io.closed.length = 0;
  io.failSync = undefined;
  io.rejectFile = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Supplies an independent real directory without starting any domain publisher. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-canonical-directory-'));
  roots.push(root);
  return root;
}

/** Captures the original refusal so native failures cannot be silently wrapped or swallowed. */
function refusal(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('synchronous canonical directory primitives', () => {
  it.each([undefined, 0o750])('commits recursive parents before children with mode %s', (mode) => {
    const root = fixture();
    const parent = join(root, 'parent');
    const child = join(parent, 'child');
    ensureCanonicalDirectory(child, mode);

    // Storage's trusted Node directory contract commits a parent before creating its child.
    const position = (operation: 'mkdir' | 'sync', path: string) =>
      io.events.findIndex((event) => event.operation === operation && event.path === path);
    expect(position('sync', dirname(root))).toBeGreaterThanOrEqual(0);
    expect(position('mkdir', parent)).toBeGreaterThan(position('sync', dirname(root)));
    expect(position('sync', root)).toBeGreaterThan(position('mkdir', parent));
    expect(position('mkdir', child)).toBeGreaterThan(position('sync', root));
    expect(position('sync', parent)).toBeGreaterThan(position('mkdir', child));
    for (const path of [parent, child]) {
      expect(lstatSync(path).isDirectory()).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe((mode ?? 0o700) & ~process.umask());
    }
    expect(io.paths.size).toBe(0);

    const before = lstatSync(child);
    io.events.length = 0;
    ensureCanonicalDirectory(child, 0o777);
    expect(lstatSync(child).ino).toBe(before.ino);
    expect(lstatSync(child).mode).toBe(before.mode);
    expect(io.events.some((event) => event.operation === 'mkdir')).toBe(false);
    expect(io.events).toContainEqual({ operation: 'sync', path: parent });
    expect(io.paths.size).toBe(0);
  });

  it('refuses links and non-directories without changing an outside sentinel', () => {
    const root = fixture();
    const outside = fixture();
    const sentinel = join(outside, 'sentinel');
    const linkedDirectory = join(root, 'linked-directory');
    const linkedFile = join(root, 'linked-file');
    const regularFile = join(root, 'regular-file');
    writeFileSync(sentinel, 'outside bytes');
    writeFileSync(regularFile, 'local bytes');
    symlinkSync(outside, linkedDirectory, 'dir');
    symlinkSync(sentinel, linkedFile, 'file');
    const tree = join(root, 'tree');
    mkdirSync(tree);
    symlinkSync(outside, join(tree, 'linked-child'), 'dir');
    io.events.length = 0;

    expect(() => assertCanonicalDirectory(root)).not.toThrow();
    expect(() => assertCanonicalRegularFile(regularFile)).not.toThrow();
    expect(() => assertCanonicalDirectory(regularFile)).toThrow(/must be a directory/);
    expect(() => assertCanonicalRegularFile(root)).toThrow(/must be a regular file/);
    expect(() => ensureCanonicalDirectory(regularFile)).toThrow(/must be a directory/);
    expect(() => syncCanonicalDirectory(regularFile)).toThrow(/must be a directory/);
    for (const operation of [
      () => assertCanonicalDirectory(linkedDirectory),
      () => assertCanonicalRegularFile(linkedFile),
      () => ensureCanonicalDirectory(linkedDirectory),
      () => ensureCanonicalDirectory(join(linkedDirectory, 'new-child')),
      () => syncCanonicalDirectory(linkedDirectory),
      () => syncCanonicalTree(linkedDirectory),
      () => syncCanonicalTree(linkedFile),
      () => syncCanonicalTree(tree),
    ]) {
      expect(operation).toThrow(/must not be a symbolic link/);
    }
    expect(readFileSync(sentinel, 'utf8')).toBe('outside bytes');
    expect(readdirSync(outside)).toEqual(['sentinel']);
    expect(readlinkSync(linkedDirectory)).toBe(outside);
    expect(readlinkSync(linkedFile)).toBe(sentinel);
    expect(io.events).toEqual([]);
    expect(io.paths.size).toBe(0);
  });

  it('synchronizes complete tree children before parents and closes every descriptor', () => {
    const root = fixture();
    const child = join(root, 'child');
    const nestedFile = join(child, 'nested');
    const directFile = join(root, 'direct');
    mkdirSync(child);
    writeFileSync(nestedFile, 'nested bytes');
    writeFileSync(directFile, 'direct bytes');
    io.events.length = 0;
    io.closed.length = 0;

    syncCanonicalTree(root);

    const synced = io.events
      .filter((event) => event.operation === 'sync')
      .map((event) => event.path);
    expect([...synced].sort()).toEqual([root, child, nestedFile, directFile].sort());
    expect(synced.indexOf(nestedFile)).toBeLessThan(synced.indexOf(child));
    expect(synced.indexOf(child)).toBeLessThan(synced.indexOf(root));
    expect(synced.indexOf(directFile)).toBeLessThan(synced.indexOf(root));
    expect([...io.closed].sort()).toEqual([...synced].sort());
    expect(io.paths.size).toBe(0);
    expect(readFileSync(nestedFile, 'utf8')).toBe('nested bytes');
    expect(readFileSync(directFile, 'utf8')).toBe('direct bytes');
  });

  it.each([
    'directory',
    'file',
  ] as const)('preserves a %s sync failure and closes its descriptor', (kind) => {
    const root = fixture();
    const target = kind === 'directory' ? root : join(root, 'file');
    if (kind === 'file') writeFileSync(target, 'retained bytes');
    io.failSync = target;
    io.events.length = 0;
    io.closed.length = 0;

    const operation =
      kind === 'directory' ? () => syncCanonicalDirectory(target) : () => syncCanonicalTree(root);
    expect(refusal(operation)).toBe(io.failure);
    expect(io.events).toEqual([{ operation: 'sync', path: target }]);
    expect(io.closed).toEqual([target]);
    expect(io.paths.size).toBe(0);
    if (kind === 'file') expect(readFileSync(target, 'utf8')).toBe('retained bytes');
  });

  it('closes a file descriptor when post-open type verification refuses it', () => {
    const root = fixture();
    const file = join(root, 'file');
    writeFileSync(file, 'retained bytes');
    io.rejectFile = file;
    io.events.length = 0;
    io.closed.length = 0;

    expect(() => syncCanonicalTree(root)).toThrow(/must be a regular file/);
    expect(io.events).toEqual([]);
    expect(io.closed).toEqual([file]);
    expect(io.paths.size).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('retained bytes');
  });
});
