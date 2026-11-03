// openkit-test-platform: posix
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectSqliteCopy } from './local.js';

const effect = vi.hoisted(() => ({
  temporaryBase: '',
  copySource: '',
  copyFailure: undefined as Error | undefined,
  cleanupFailure: undefined as Error | undefined,
  copyAttempted: [] as string[],
  created: [] as string[],
}));

// All source bytes, temporary directories and copies are real; inject only named native failures.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync(...args: Parameters<typeof actual.mkdtempSync>) {
      const directory = actual.mkdtempSync(...args);
      if (basename(String(args[0])) === 'openkit-sqlite-preflight-')
        effect.created.push(String(directory));
      return directory;
    },
    copyFileSync(...args: Parameters<typeof actual.copyFileSync>) {
      effect.copyAttempted.push(String(args[0]));
      if (String(args[0]) === effect.copySource) {
        actual.writeFileSync(args[1], actual.readFileSync(args[0]).subarray(0, 2));
        throw effect.copyFailure;
      }
      return actual.copyFileSync(...args);
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      if (effect.cleanupFailure && effect.created.includes(String(args[0])))
        throw effect.cleanupFailure;
      return actual.rmSync(...args);
    },
  };
});

vi.mock('node:os', async (load) => {
  const actual = await load<typeof import('node:os')>();
  return {
    ...actual,
    tmpdir: () => effect.temporaryBase || actual.tmpdir(),
  };
});

const roots: string[] = [];
const baseBytes = Buffer.from([0, 255, 128, 13, 10]);
const walBytes = Buffer.from([1, 254, 129, 10, 13]);
const journalBytes = Buffer.from([2, 253, 130, 0]);
const shmBytes = Buffer.from([3, 252, 131]);
afterEach(() => {
  effect.temporaryBase = '';
  effect.copySource = '';
  effect.copyFailure = undefined;
  effect.cleanupFailure = undefined;
  effect.copyAttempted.length = 0;
  for (const directory of effect.created.splice(0))
    rmSync(directory, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Own physical predecessor bytes, not SQLite records, opening policy or SQL authority. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-sqlite-inspection-'));
  roots.push(root);
  const dataRoot = join(root, 'predecessor');
  mkdirSync(dataRoot);
  const path = join(dataRoot, 'source.sqlite');
  writeFileSync(path, baseBytes);
  return { root, dataRoot, path };
}

/** Capture native and callback error identity without assuming an Error-shaped exception. */
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected private SQLite inspection to fail.');
}

/** Observe every actual predecessor byte without interpreting a database format. */
function inventory(root: string): Array<[string, Buffer]> {
  return readdirSync(root)
    .sort()
    .map((name) => [name, readFileSync(join(root, name))]);
}

// Core Storage shares the existing private byte lifetime; NanoCore retains every SQLite operation.
// The authorized MOVE preserves synchronous callback/finally behavior and native failure precedence.
describe('private SQLite inspection copy physical lifetime', () => {
  it('copies exact base, WAL and journal bytes, omits SHM, and cleans after the original result', () => {
    const { dataRoot, path } = fixture();
    writeFileSync(`${path}-wal`, walBytes);
    writeFileSync(`${path}-journal`, journalBytes);
    writeFileSync(`${path}-shm`, shmBytes);
    const before = inventory(dataRoot);
    const result = { inspected: true };
    let inspectedDirectory = '';

    const actual = inspectSqliteCopy(dataRoot, path, (copy: string) => {
      inspectedDirectory = dirname(copy);
      expect(dirname(inspectedDirectory)).toBe(realpathSync(tmpdir()));
      expect(basename(inspectedDirectory).startsWith('openkit-sqlite-preflight-')).toBe(true);
      expect(basename(copy)).toBe('database.sqlite');
      expect(statSync(inspectedDirectory).mode & 0o777).toBe(0o700);
      expect(readdirSync(inspectedDirectory).sort()).toEqual([
        'database.sqlite',
        'database.sqlite-journal',
        'database.sqlite-wal',
      ]);
      expect(readFileSync(copy)).toEqual(baseBytes);
      expect(readFileSync(`${copy}-wal`)).toEqual(walBytes);
      expect(readFileSync(`${copy}-journal`)).toEqual(journalBytes);
      expect(existsSync(`${copy}-shm`)).toBe(false);
      return result;
    });

    expect(actual).toBe(result);
    expect(effect.copyAttempted).toEqual([path, `${path}-wal`, `${path}-journal`]);
    expect(inspectedDirectory).not.toBe('');
    expect(existsSync(inspectedDirectory)).toBe(false);
    expect(inventory(dataRoot)).toEqual(before);
  });

  it('skips absent optional sidecars and removes callback-created scratch after a thrown value', () => {
    const { dataRoot, path } = fixture();
    const before = inventory(dataRoot);
    const failure = { cause: 'original inspection refusal' };
    let inspectedDirectory = '';

    expect(
      caught(() =>
        inspectSqliteCopy(dataRoot, path, (copy: string) => {
          inspectedDirectory = dirname(copy);
          expect(readdirSync(inspectedDirectory)).toEqual(['database.sqlite']);
          expect(readFileSync(copy)).toEqual(baseBytes);
          writeFileSync(join(inspectedDirectory, 'callback-scratch'), shmBytes);
          throw failure;
        })
      )
    ).toBe(failure);

    expect(inspectedDirectory).not.toBe('');
    expect(existsSync(inspectedDirectory)).toBe(false);
    expect(inventory(dataRoot)).toEqual(before);
  });

  it.each([
    'missing-base',
    'linked-base',
    'linked-wal',
    'directory-journal',
  ] as const)('refuses %s without inspection and cleans its private directory', (kind) => {
    const { root, dataRoot, path } = fixture();
    const outside = join(root, 'outside');
    writeFileSync(outside, shmBytes);
    if (kind === 'missing-base') rmSync(path);
    if (kind === 'linked-base') {
      rmSync(path);
      symlinkSync(outside, path);
    }
    if (kind === 'linked-wal') symlinkSync(outside, `${path}-wal`);
    if (kind === 'directory-journal') mkdirSync(`${path}-journal`);
    const namesBefore = readdirSync(dataRoot).sort();
    const inspect = vi.fn();

    expect(() => inspectSqliteCopy(dataRoot, path, inspect)).toThrow(
      'SQLite preflight input must be a regular file.'
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(effect.created).toHaveLength(1);
    expect(existsSync(effect.created[0]!)).toBe(false);
    expect(readFileSync(outside)).toEqual(shmBytes);
    expect(readdirSync(dataRoot).sort()).toEqual(namesBefore);
    if (kind === 'linked-base') expect(lstatSync(path).isSymbolicLink()).toBe(true);
    if (kind === 'linked-wal') expect(lstatSync(`${path}-wal`).isSymbolicLink()).toBe(true);
    if (kind === 'directory-journal') expect(lstatSync(`${path}-journal`).isDirectory()).toBe(true);
    if (kind !== 'missing-base' && kind !== 'linked-base')
      expect(readFileSync(path)).toEqual(baseBytes);
  });

  it('cleans a real partial WAL copy and propagates the original native copy failure', () => {
    const { dataRoot, path } = fixture();
    writeFileSync(`${path}-wal`, walBytes);
    writeFileSync(`${path}-journal`, journalBytes);
    const before = inventory(dataRoot);
    effect.copySource = `${path}-wal`;
    effect.copyFailure = new Error('injected partial WAL copy refusal');
    const inspect = vi.fn();

    expect(caught(() => inspectSqliteCopy(dataRoot, path, inspect))).toBe(effect.copyFailure);

    expect(inspect).not.toHaveBeenCalled();
    expect(effect.copyAttempted).toEqual([path, `${path}-wal`]);
    expect(effect.created).toHaveLength(1);
    expect(existsSync(effect.created[0]!)).toBe(false);
    expect(inventory(dataRoot)).toEqual(before);
  });

  it.each([
    'return',
    'throw',
  ] as const)('keeps cleanup failure precedence over callback %s and leaves private residue inspectable', (outcome) => {
    const { dataRoot, path } = fixture();
    const before = inventory(dataRoot);
    const original = new Error('original callback refusal');
    effect.cleanupFailure = new Error('injected private-copy cleanup refusal');
    let inspectedDirectory = '';

    expect(
      caught(() =>
        inspectSqliteCopy(dataRoot, path, (copy: string) => {
          inspectedDirectory = dirname(copy);
          expect(readFileSync(copy)).toEqual(baseBytes);
          if (outcome === 'throw') throw original;
          return { inspected: true };
        })
      )
    ).toBe(effect.cleanupFailure);

    expect(inspectedDirectory).not.toBe('');
    expect(readdirSync(inspectedDirectory)).toEqual(['database.sqlite']);
    expect(readFileSync(join(inspectedDirectory, 'database.sqlite'))).toEqual(baseBytes);
    expect(inventory(dataRoot)).toEqual(before);
  });

  it.each([
    'equal',
    'descendant',
  ] as const)('refuses a canonical temporary base %s to the predecessor before allocating a copy', (relation) => {
    const { dataRoot, path } = fixture();
    const before = inventory(dataRoot);
    const temporaryBase = relation === 'equal' ? dataRoot : join(dataRoot, 'temporary');
    if (relation === 'descendant') mkdirSync(temporaryBase);
    effect.temporaryBase = temporaryBase;
    const inspect = vi.fn();

    expect(() => inspectSqliteCopy(dataRoot, path, inspect)).toThrow(
      'SQLite preflight temporary storage must be outside the predecessor root.'
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(effect.created).toEqual([]);
    expect(readFileSync(path)).toEqual(baseBytes);
    expect(readdirSync(dataRoot).sort()).toEqual(
      [...before.map(([name]) => name), ...(relation === 'descendant' ? ['temporary'] : [])].sort()
    );
    if (relation === 'descendant') expect(readdirSync(temporaryBase)).toEqual([]);
  });

  it('admits an outside temporary sibling whose name shares the predecessor prefix', () => {
    const { root, dataRoot, path } = fixture();
    const temporaryBase = join(root, 'predecessor-sibling');
    mkdirSync(temporaryBase);
    effect.temporaryBase = temporaryBase;
    const before = inventory(dataRoot);
    const result = { inspected: true };

    expect(
      inspectSqliteCopy(dataRoot, path, (copy: string) => {
        expect(dirname(dirname(copy))).toBe(realpathSync(temporaryBase));
        expect(readFileSync(copy)).toEqual(baseBytes);
        return result;
      })
    ).toBe(result);

    expect(readdirSync(temporaryBase)).toEqual([]);
    expect(inventory(dataRoot)).toEqual(before);
  });
});
