// openkit-test-platform: posix
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listCanonicalDirectoryNames,
  listCanonicalFileNames,
  removeUnkeptCanonicalDirectories,
} from './local.js';

const effect = vi.hoisted(() => ({
  root: '',
  linksLast: false,
  reverseNames: false,
  failPath: undefined as string | undefined,
  failure: undefined as Error | undefined,
  disappearPath: undefined as string | undefined,
  attempted: [] as string[],
  removed: [] as string[],
}));

// Preserve real Dirents and removals; intervene only at legal native ordering/failure boundaries.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync(...args: Parameters<typeof actual.readdirSync>) {
      const entries = actual.readdirSync(...args);
      const dirents = args[1] && typeof args[1] === 'object' && args[1].withFileTypes;
      if (dirents && String(args[0]) === effect.root) {
        if (effect.linksLast) {
          return [...entries].sort(
            (left, right) => Number(left.isSymbolicLink()) - Number(right.isSymbolicLink())
          );
        }
        if (effect.reverseNames) {
          return [...entries].sort((left, right) =>
            String(left.name) > String(right.name) ? -1 : 1
          );
        }
      }
      return entries;
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      const path = String(args[0]);
      if (dirname(path) === effect.root) {
        effect.attempted.push(basename(path));
        if (path === effect.failPath) throw effect.failure;
        if (path === effect.disappearPath) actual.rmSync(path, { recursive: true });
        actual.rmSync(...args);
        effect.removed.push(basename(path));
        return;
      }
      return actual.rmSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  effect.root = '';
  effect.linksLast = false;
  effect.reverseNames = false;
  effect.failPath = undefined;
  effect.failure = undefined;
  effect.disappearPath = undefined;
  effect.attempted.length = 0;
  effect.removed.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const retainedBytes = Buffer.from([0, 255, 128, 13, 10]);

/** Own private physical children without selecting canonical domain identities or authority. */
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'storage-canonical-inventory-'));
  roots.push(parent);
  const root = join(parent, 'children');
  mkdirSync(root);
  effect.root = root;
  return { parent, root };
}

/** Observe the original concrete Set receiver and native membership checks. */
function selection(names: readonly string[] = []) {
  const keep = new Set(names);
  const examined: string[] = [];
  const has = keep.has;
  keep.has = function (name: string) {
    expect(this).toBe(keep);
    examined.push(name);
    return has.call(this, name);
  };
  return { keep, examined };
}

/** Each caller-selected child contains actual retained bytes, including nested content. */
function child(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(join(path, 'nested'), { recursive: true });
  writeFileSync(join(path, 'nested', 'original'), retainedBytes);
  return path;
}

/** Require unchanged native error identity on a partially completed cleanup. */
function caught(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected canonical child cleanup to fail.');
}

// Core Storage owns physical inventory/deletion; FileRecords retains actual expected-name selection.
// These are shallow native inventories and caller-selected cleanup, without a new synchronization claim.
describe('canonical direct-child inventory and retirement', () => {
  it('returns only direct children of the requested type in JavaScript string order', () => {
    const { root } = fixture();
    effect.reverseNames = true;
    for (const name of ['z-dir', 'a-dir', 'A-dir']) child(root, name);
    for (const name of ['z-file', 'a-file', 'A-file'])
      writeFileSync(join(root, name), retainedBytes);

    expect(listCanonicalDirectoryNames(root)).toEqual(['A-dir', 'a-dir', 'z-dir']);
    expect(listCanonicalFileNames(root)).toEqual(['A-file', 'a-file', 'z-file']);
    expect(readFileSync(join(root, 'A-dir', 'nested', 'original'))).toEqual(retainedBytes);
    expect(effect.attempted).toEqual([]);
  });

  it('returns empty inventories and performs no cleanup or creation for an absent parent', () => {
    const { parent } = fixture();
    const missing = join(parent, 'absent');
    const selected = selection();

    expect(listCanonicalDirectoryNames(missing)).toEqual([]);
    expect(listCanonicalFileNames(missing)).toEqual([]);
    removeUnkeptCanonicalDirectories(missing, selected.keep);

    expect(existsSync(missing)).toBe(false);
    expect(selected.examined).toEqual([]);
    expect(effect.attempted).toEqual([]);
  });

  it('keeps canonical parent refusal for a redirected root and a non-directory parent', () => {
    const { parent, root } = fixture();
    const redirected = join(parent, 'redirected');
    symlinkSync(root, redirected, 'dir');
    const file = join(parent, 'regular-parent');
    writeFileSync(file, retainedBytes);

    expect(() => listCanonicalDirectoryNames(redirected)).toThrow(
      /Canonical path must not be a symbolic link/
    );
    expect(() => listCanonicalFileNames(file)).toThrow(/Canonical path must be a directory/);

    expect(lstatSync(redirected).isSymbolicLink()).toBe(true);
    expect(readFileSync(file)).toEqual(retainedBytes);
    expect(effect.attempted).toEqual([]);
  });

  it('refuses any direct symlink before filtering or selecting any child for deletion', () => {
    const { parent, root } = fixture();
    const stale = child(root, 'a-stale');
    const target = join(parent, 'retained-target');
    writeFileSync(target, retainedBytes);
    const link = join(root, 'z-link');
    symlinkSync(target, link);
    const selected = selection();
    // Supply one legal native order with the unsafe entry last, using actual Dirents.
    effect.linksLast = true;

    expect(() => listCanonicalDirectoryNames(root)).toThrow(/must not contain a symbolic link/);
    expect(() => listCanonicalFileNames(root)).toThrow(/must not contain a symbolic link/);
    expect(() => removeUnkeptCanonicalDirectories(root, selected.keep)).toThrow(
      /must not contain a symbolic link/
    );

    expect(selected.examined).toEqual([]);
    expect(effect.attempted).toEqual([]);
    expect(readFileSync(join(stale, 'nested', 'original'))).toEqual(retainedBytes);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(retainedBytes);
  });

  it('queries the concrete keep Set in sorted directory order and removes only unkept trees', () => {
    const { root } = fixture();
    effect.reverseNames = true;
    for (const name of ['z-drop', 'm-keep', 'a-drop']) child(root, name);
    const file = join(root, 'unselected-file');
    writeFileSync(file, retainedBytes);
    const selected = selection(['m-keep']);

    removeUnkeptCanonicalDirectories(root, selected.keep);

    expect(selected.examined).toEqual(['a-drop', 'm-keep', 'z-drop']);
    expect(effect.removed).toEqual(['a-drop', 'z-drop']);
    expect(readdirSync(root).sort()).toEqual(['m-keep', 'unselected-file']);
    expect(readFileSync(join(root, 'm-keep', 'nested', 'original'))).toEqual(retainedBytes);
    expect(readFileSync(file)).toEqual(retainedBytes);
  });

  it('propagates native removal failure after earlier cleanup without touching later children', () => {
    const { root } = fixture();
    effect.reverseNames = true;
    for (const name of ['z-later', 'm-failed', 'a-removed']) child(root, name);
    const selected = selection();
    effect.failPath = join(root, 'm-failed');
    effect.failure = new Error('injected canonical child removal refusal');

    expect(caught(() => removeUnkeptCanonicalDirectories(root, selected.keep))).toBe(
      effect.failure
    );

    expect(selected.examined).toEqual(['a-removed', 'm-failed']);
    expect(effect.attempted).toEqual(['a-removed', 'm-failed']);
    expect(effect.removed).toEqual(['a-removed']);
    expect(existsSync(join(root, 'a-removed'))).toBe(false);
    expect(readFileSync(join(root, 'm-failed', 'nested', 'original'))).toEqual(retainedBytes);
    expect(readFileSync(join(root, 'z-later', 'nested', 'original'))).toEqual(retainedBytes);
  });

  it('preserves native force semantics when a selected child disappears after inventory', () => {
    const { root } = fixture();
    child(root, 'gone');
    const selected = selection();
    effect.disappearPath = join(root, 'gone');

    removeUnkeptCanonicalDirectories(root, selected.keep);

    expect(selected.examined).toEqual(['gone']);
    expect(effect.attempted).toEqual(['gone']);
    expect(effect.removed).toEqual(['gone']);
    expect(readdirSync(root)).toEqual([]);
  });
});
