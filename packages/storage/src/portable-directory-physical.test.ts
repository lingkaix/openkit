// openkit-test-platform: posix
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePortableDirectory } from './local.js';

const fault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  error: undefined as Error | undefined,
}));

// Only a named mkdir fails; lookup, canonical checks and all other creation remain real.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync(...args: Parameters<typeof actual.mkdirSync>) {
      if (String(args[0]) === fault.path) throw fault.error;
      return actual.mkdirSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.path = undefined;
  fault.error = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Own a real private root whose admission is already the caller's responsibility. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'storage-portable-directory-'));
  roots.push(root);
  return root;
}

// Core Storage shares physical directory effects; S51 retains export ownership in NanoCore.
// Segments are already validated. This is neither root admission nor durable publication.
describe('portable directory physical resolution', () => {
  it('creates nested prefixes with native default modes and supports export-style prefix reuse', () => {
    const root = fixture();
    const previousUmask = process.umask(0o027);
    try {
      expect(resolvePortableDirectory(root, ['one', 'two', 'three'], true)).toBe(
        join(root, 'one', 'two', 'three')
      );
      for (const path of ['one', 'one/two', 'one/two/three']) {
        expect(statSync(join(root, path)).isDirectory()).toBe(true);
        expect(statSync(join(root, path)).mode & 0o777).toBe(0o750);
      }
      const workspaces = join(root, 'workspaces');
      const workspace = join(workspaces, 'selected');
      expect(resolvePortableDirectory(root, ['workspaces'], true)).toBe(workspaces);
      expect(resolvePortableDirectory(workspaces, ['selected'], true)).toBe(workspace);
      expect(statSync(workspace).mode & 0o777).toBe(0o750);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('resolves existing directories and returns null at a missing prefix without creating it', () => {
    const root = fixture();
    mkdirSync(join(root, 'existing', 'child'), { recursive: true });
    const retained = join(root, 'existing', 'retained');
    const bytes = Buffer.from([0, 255, 128]);
    writeFileSync(retained, bytes);
    const before = statSync(join(root, 'existing'));

    expect(resolvePortableDirectory(root, ['existing', 'child'], false)).toBe(
      join(root, 'existing', 'child')
    );
    expect(resolvePortableDirectory(root, ['existing', 'missing', 'later'], false)).toBeNull();
    expect(resolvePortableDirectory(root, ['absent', 'later'], false)).toBeNull();

    expect(readdirSync(root)).toEqual(['existing']);
    expect(readdirSync(join(root, 'existing')).sort()).toEqual(['child', 'retained']);
    expect(readFileSync(retained)).toEqual(bytes);
    const after = statSync(join(root, 'existing'));
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
  });

  it('refuses a symlink prefix in either mode without traversing or changing its target', () => {
    const root = fixture();
    const target = join(root, 'retained-target');
    mkdirSync(target);
    writeFileSync(join(target, 'original'), 'keep');
    const link = join(root, 'linked');
    symlinkSync(target, link, 'dir');

    for (const create of [false, true]) {
      expect(() => resolvePortableDirectory(root, ['linked', 'later'], create)).toThrow(
        /Canonical path must not be a symbolic link/
      );
    }

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(target)).toEqual(['original']);
    expect(readFileSync(join(target, 'original'), 'utf8')).toBe('keep');
  });

  it('refuses a non-directory prefix in either mode and preserves its bytes', () => {
    const root = fixture();
    const path = join(root, 'not-a-directory');
    const bytes = Buffer.from([0, 255, 4]);
    writeFileSync(path, bytes);

    for (const create of [false, true]) {
      expect(() => resolvePortableDirectory(root, ['not-a-directory', 'later'], create)).toThrow(
        /Canonical path must be a directory/
      );
    }

    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(root)).toEqual(['not-a-directory']);
  });

  it('propagates a later mkdir error unchanged and keeps the already-created prefix', () => {
    const root = fixture();
    fault.path = join(root, 'first', 'second');
    fault.error = new Error('injected second-prefix mkdir failure');
    let failure: unknown;

    try {
      resolvePortableDirectory(root, ['first', 'second', 'later'], true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(fault.error);
    expect(statSync(join(root, 'first')).isDirectory()).toBe(true);
    expect(readdirSync(join(root, 'first'))).toEqual([]);
    expect(existsSync(fault.path)).toBe(false);
  });
});
