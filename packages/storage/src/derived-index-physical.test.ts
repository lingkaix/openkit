// openkit-test-platform: posix
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDerivedIndexDirectory, writeDerivedIndexFile } from './local.js';

const effect = vi.hoisted(() => ({
  root: '',
  removePath: '',
  writePath: '',
  failure: undefined as Error | undefined,
}));

// Retain real Dirents and native effects; interrupt only the selected disposable operation.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync(...args: Parameters<typeof actual.readdirSync>) {
      const entries = actual.readdirSync(...args);
      if (
        String(args[0]) === effect.root &&
        args[1] &&
        typeof args[1] === 'object' &&
        args[1].withFileTypes
      ) {
        // A legal native order makes symlink preflight and sorted deletion observable.
        return [...entries].sort((left, right) =>
          String(left.name) < String(right.name) ? 1 : -1
        );
      }
      return entries;
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      if (String(args[0]) === effect.removePath) throw effect.failure;
      return actual.rmSync(...args);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (String(args[0]) === effect.writePath) {
        actual.writeFileSync(args[0], Buffer.from('native partial\0\r\n'));
        throw effect.failure;
      }
      return actual.writeFileSync(...args);
    },
  };
});

const roots: string[] = [];
const sentinel = Buffer.from([0, 255, 128, 13, 10]);
afterEach(() => {
  effect.root = '';
  effect.removePath = '';
  effect.writePath = '';
  effect.failure = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Own only disposable physical index bytes, with no Workspace or admission authority. */
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'storage-derived-index-'));
  roots.push(parent);
  const root = join(parent, 'indexes');
  effect.root = root;
  return { parent, root };
}

/** Capture the original native failure object rather than only its message. */
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the derived-index operation to fail.');
}

// Core Storage / SQLite Layers shares byte mechanics without transferring index meaning.
// The authorized Row23 MOVE preserves these exact native bytes and failure prefixes.
describe('derived-index physical operations', () => {
  it('creates an absent root with native defaults and preserves the caller-selected child', () => {
    const { parent, root } = fixture();
    const control = join(parent, 'native-directory');
    mkdirSync(control);

    expect(clearDerivedIndexDirectory(root, 'retained')).toEqual([]);
    expect(statSync(root).mode & 0o777).toBe(statSync(control).mode & 0o777);
    mkdirSync(join(root, 'retained', 'nested'), { recursive: true });
    writeFileSync(join(root, 'retained', 'nested', 'CURRENT'), sentinel);
    mkdirSync(join(root, 'a-stale', 'nested'), { recursive: true });
    writeFileSync(join(root, 'a-stale', 'nested', 'old'), sentinel);
    writeFileSync(join(root, 'z-stale'), sentinel);
    writeFileSync(join(root, 'A-stale'), sentinel);

    expect(clearDerivedIndexDirectory(root, 'retained')).toEqual(['A-stale', 'a-stale', 'z-stale']);
    expect(readdirSync(root)).toEqual(['retained']);
    expect(readFileSync(join(root, 'retained', 'nested', 'CURRENT'))).toEqual(sentinel);
  });

  it('preserves an ordinary file selected as the retained child', () => {
    const { root } = fixture();
    mkdirSync(root);
    writeFileSync(join(root, 'retrieval'), sentinel);
    writeFileSync(join(root, 'stale'), sentinel);

    expect(clearDerivedIndexDirectory(root, 'retrieval')).toEqual(['stale']);
    expect(readFileSync(join(root, 'retrieval'))).toEqual(sentinel);
  });

  it.each([
    'retrieval',
    'a-link',
  ])('refuses the direct link %s before removing any stale entry', (name) => {
    const { parent, root } = fixture();
    mkdirSync(root);
    const outside = join(parent, 'outside');
    writeFileSync(outside, sentinel);
    writeFileSync(join(root, 'z-stale'), sentinel);
    symlinkSync(outside, join(root, name));

    expect(() => clearDerivedIndexDirectory(root, 'retrieval')).toThrow(
      `Canonical directory must not contain a symbolic link: ${join(root, name)}.`
    );

    expect(readFileSync(join(root, 'z-stale'))).toEqual(sentinel);
    expect(readFileSync(outside)).toEqual(sentinel);
    expect(lstatSync(join(root, name)).isSymbolicLink()).toBe(true);
  });

  it('refuses a redirected root and a regular-file root without changing either target', () => {
    const { parent, root } = fixture();
    const outside = join(parent, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), sentinel);
    symlinkSync(outside, root, 'dir');

    expect(() => clearDerivedIndexDirectory(root, 'retrieval')).toThrow(
      `Canonical path must not be a symbolic link: ${root}.`
    );
    expect(readFileSync(join(outside, 'sentinel'))).toEqual(sentinel);
    expect(lstatSync(root).isSymbolicLink()).toBe(true);
    const file = join(parent, 'regular');
    writeFileSync(file, sentinel);
    expect(() => clearDerivedIndexDirectory(file, 'retrieval')).toThrow(
      `Canonical path must be a directory: ${file}.`
    );
    expect(readFileSync(file)).toEqual(sentinel);
  });

  it('leaves the sorted deletion prefix complete and later entries untouched on native refusal', () => {
    const { root } = fixture();
    mkdirSync(root);
    for (const name of ['z-later', 'm-failed', 'a-removed', 'retrieval'])
      writeFileSync(join(root, name), sentinel);
    effect.removePath = join(root, 'm-failed');
    effect.failure = new Error('injected middle derived-index removal failure');

    expect(caught(() => clearDerivedIndexDirectory(root, 'retrieval'))).toBe(effect.failure);

    expect(existsSync(join(root, 'a-removed'))).toBe(false);
    for (const name of ['m-failed', 'z-later', 'retrieval'])
      expect(readFileSync(join(root, name))).toEqual(sentinel);
  });

  it('writes exact caller text with native creation mode and ordinary in-place truncation', () => {
    const { parent } = fixture();
    const path = join(parent, 'derived.json');
    const control = join(parent, 'native-file');
    writeFileSync(control, 'native default');
    const text = ' é\r\n📦\0\n';
    const bytes = Buffer.from([32, 195, 169, 13, 10, 240, 159, 147, 166, 0, 10]);

    writeDerivedIndexFile(path, text);

    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(statSync(control).mode & 0o777);
    chmodSync(path, 0o640);
    const before = statSync(path);
    writeDerivedIndexFile(path, 'x\n');
    const after = statSync(path);
    expect(readFileSync(path)).toEqual(Buffer.from([120, 10]));
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
  });

  it('propagates native write failure with its partial output and siblings still inspectable', () => {
    const { parent } = fixture();
    const path = join(parent, 'derived.json');
    const sibling = join(parent, 'sibling');
    writeFileSync(sibling, sentinel);
    effect.writePath = path;
    effect.failure = new Error('injected partial derived-index write failure');

    expect(caught(() => writeDerivedIndexFile(path, 'uncompleted text'))).toBe(effect.failure);

    expect(readFileSync(path)).toEqual(Buffer.from('native partial\0\r\n'));
    expect(readFileSync(sibling)).toEqual(sentinel);
    expect(readdirSync(parent).sort()).toEqual([basename(path), basename(sibling)].sort());
  });

  it('does not create missing parent directories for either physical operation', () => {
    const { parent } = fixture();
    const missingRoot = join(parent, 'missing', 'indexes');

    expect(caught(() => clearDerivedIndexDirectory(missingRoot, 'retrieval'))).toMatchObject({
      code: 'ENOENT',
    });
    expect(
      caught(() => writeDerivedIndexFile(join(missingRoot, 'index.json'), '{}\n'))
    ).toMatchObject({
      code: 'ENOENT',
    });
    expect(existsSync(dirname(missingRoot))).toBe(false);
  });
});
