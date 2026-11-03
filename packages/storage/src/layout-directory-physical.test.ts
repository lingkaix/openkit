// openkit-test-platform: posix
import {
  chmodSync,
  type Dirent,
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
import { ensureLayoutDirectory, readLayoutDirectory } from './local.js';

const effect = vi.hoisted(() => ({
  root: '',
  mkdirPath: '',
  removeAfterMkdirPath: '',
  removeAfterProbePath: '',
  failure: undefined as Error | undefined,
}));

// Keep real paths, metadata and Dirents; alter only a named native order or failure boundary.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync(...args: Parameters<typeof actual.lstatSync>) {
      const metadata = actual.lstatSync(...args);
      if (metadata && String(args[0]) === effect.removeAfterProbePath) {
        effect.removeAfterProbePath = '';
        actual.rmSync(args[0], { recursive: true });
      }
      return metadata;
    },
    mkdirSync(...args: Parameters<typeof actual.mkdirSync>) {
      if (String(args[0]) === effect.mkdirPath) {
        effect.mkdirPath = '';
        throw effect.failure;
      }
      const result = actual.mkdirSync(...args);
      if (String(args[0]) === effect.removeAfterMkdirPath)
        actual.rmSync(args[0], { recursive: true });
      return result;
    },
    readdirSync(...args: Parameters<typeof actual.readdirSync>) {
      const entries = actual.readdirSync(...args);
      if (
        String(args[0]) === effect.root &&
        args[1] &&
        typeof args[1] === 'object' &&
        args[1].withFileTypes
      ) {
        return [...entries].sort((left, right) =>
          String(left.name) < String(right.name) ? 1 : -1
        );
      }
      return entries;
    },
  };
});

const roots: string[] = [];
const sentinel = Buffer.from([0, 255, 128, 13, 10]);
afterEach(() => {
  effect.root = '';
  effect.mkdirPath = '';
  effect.removeAfterMkdirPath = '';
  effect.removeAfterProbePath = '';
  effect.failure = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Own disposable addressed directories without assigning a User or Workspace scope. */
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'storage-layout-directory-'));
  roots.push(parent);
  return { parent, root: join(parent, 'layout') };
}

/** Observe the original native exception object rather than a matching message. */
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the layout directory operation to fail.');
}

// Core Storage / SQLite Layers shares byte mechanics; NanoCore retains scope paths and traversal.
// The authorized MOVE preserves the existing DATA_ROOT errors, native defaults and second checks.
describe('layout directory physical operations', () => {
  it('uses native creation defaults and preserves existing directory mode and bytes', () => {
    const { parent, root } = fixture();
    const control = join(parent, 'native-control');
    mkdirSync(control);

    ensureLayoutDirectory(root);

    expect(statSync(root).mode & 0o777).toBe(statSync(control).mode & 0o777);
    chmodSync(root, 0o750);
    writeFileSync(join(root, 'retained'), sentinel);
    const before = statSync(root);
    ensureLayoutDirectory(root);
    const after = statSync(root);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o750);
    expect(readFileSync(join(root, 'retained'))).toEqual(sentinel);
  });

  it('creates missing ancestors only when the caller supplies recursive true', () => {
    const { parent } = fixture();
    const missing = join(parent, 'missing', 'layout');

    expect(caught(() => ensureLayoutDirectory(missing))).toMatchObject({ code: 'ENOENT' });
    expect(existsSync(join(parent, 'missing'))).toBe(false);

    ensureLayoutDirectory(missing, true);

    expect(statSync(missing).isDirectory()).toBe(true);
    expect(readdirSync(missing)).toEqual([]);
  });

  it.each([
    'link',
    'file',
  ] as const)('keeps the exact addressed-root %s refusal for ensure and read', (kind) => {
    const { parent, root } = fixture();
    const outside = join(parent, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), sentinel);
    if (kind === 'link') symlinkSync(outside, root, 'dir');
    else writeFileSync(root, sentinel);
    const message =
      kind === 'link'
        ? `DATA_ROOT layout directory must not be a symbolic link: ${root}`
        : `DATA_ROOT layout path must be a directory: ${root}`;

    expect(() => ensureLayoutDirectory(root)).toThrow(message);
    expect(() => readLayoutDirectory(root)).toThrow(message);

    expect(readFileSync(join(outside, 'sentinel'))).toEqual(sentinel);
    expect(readdirSync(outside)).toEqual(['sentinel']);
    if (kind === 'link') expect(lstatSync(root).isSymbolicLink()).toBe(true);
    else expect(readFileSync(root)).toEqual(sentinel);
  });

  it('returns absence without creation and preserves unsorted real entries for caller judgment', () => {
    const { parent, root } = fixture();

    expect(readLayoutDirectory(root)).toEqual([]);
    expect(existsSync(root)).toBe(false);
    mkdirSync(root);
    mkdirSync(join(root, 'a-directory'));
    writeFileSync(join(root, 'm-file'), sentinel);
    const outside = join(parent, 'outside');
    writeFileSync(outside, sentinel);
    symlinkSync(outside, join(root, 'z-link'));
    effect.root = root;

    const entries: Dirent[] = readLayoutDirectory(root);

    expect(entries.map((entry) => entry.name)).toEqual(['z-link', 'm-file', 'a-directory']);
    expect(
      entries.map((entry) => [entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()])
    ).toEqual([
      [false, false, true],
      [false, true, false],
      [true, false, false],
    ]);
    expect(readFileSync(outside)).toEqual(sentinel);
    expect(readFileSync(join(root, 'm-file'))).toEqual(sentinel);
  });

  it('rechecks existence after native creation and after a successful reader probe', () => {
    const { root } = fixture();
    effect.removeAfterMkdirPath = root;

    expect(() => ensureLayoutDirectory(root)).toThrow(
      `DATA_ROOT layout directory is missing: ${root}`
    );

    effect.removeAfterMkdirPath = '';
    mkdirSync(root);
    effect.removeAfterProbePath = root;

    expect(() => readLayoutDirectory(root)).toThrow(
      `DATA_ROOT layout directory is missing: ${root}`
    );
    expect(existsSync(root)).toBe(false);
  });

  it('propagates the original native creation refusal without retry or residual creation', () => {
    const { root } = fixture();
    effect.mkdirPath = root;
    effect.failure = new Error('injected layout directory creation refusal');

    expect(caught(() => ensureLayoutDirectory(root))).toBe(effect.failure);

    expect(existsSync(root)).toBe(false);
  });
});
