// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  fstatSync,
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
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyRetainedEvidenceTree,
  createPrivateRetainedTreeRoot,
  prepareRetainedPrivateDirectory,
  syncRetainedDirectory,
  writeRetainedPrivateFile,
} from './local.js';

const physical = vi.hoisted(() => ({
  descriptors: new Map<number, string>(),
  events: [] as { operation: string; path: string }[],
  closed: [] as number[],
  failurePath: '',
  writeFailure: undefined as Error | undefined,
  syncFailure: undefined as Error | undefined,
  closeFailure: undefined as Error | undefined,
}));

// Preserve real files, writes, descriptor lifetimes and syncs. Inject only the
// selected native failure, after a real partial write or real close where named.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const descriptor = actual.openSync(...args);
      physical.descriptors.set(descriptor, String(args[0]));
      return descriptor;
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (
        typeof args[0] === 'number' &&
        physical.descriptors.get(args[0]) === physical.failurePath &&
        physical.writeFailure
      ) {
        const bytes =
          typeof args[1] === 'string' ? Buffer.from(args[1]) : Buffer.from(args[1] as Uint8Array);
        actual.writeSync(args[0], bytes.subarray(0, 3));
        throw physical.writeFailure;
      }
      return actual.writeFileSync(...args);
    },
    fsyncSync(descriptor: number) {
      const path = physical.descriptors.get(descriptor)!;
      physical.events.push({ operation: 'sync', path });
      if (path === physical.failurePath && physical.syncFailure) throw physical.syncFailure;
      actual.fsyncSync(descriptor);
    },
    closeSync(descriptor: number) {
      const path = physical.descriptors.get(descriptor)!;
      actual.closeSync(descriptor);
      physical.closed.push(descriptor);
      physical.descriptors.delete(descriptor);
      physical.events.push({ operation: 'close', path });
      if (path === physical.failurePath && physical.closeFailure) throw physical.closeFailure;
    },
    chmodSync(...args: Parameters<typeof actual.chmodSync>) {
      actual.chmodSync(...args);
      physical.events.push({ operation: 'chmod', path: String(args[0]) });
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  physical.failurePath = '';
  physical.writeFailure = undefined;
  physical.syncFailure = undefined;
  physical.closeFailure = undefined;
  physical.events.length = 0;
  physical.closed.length = 0;
  // A leaked descriptor is a failure even when fixture removal would hide it.
  try {
    expect([...physical.descriptors.values()]).toEqual([]);
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

/** Create a private retained-byte fixture, without domain identity or authority. */
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'storage-retained-closure-'));
  roots.push(parent);
  return parent;
}

const bytes = Buffer.from([0, 255, 128, 13, 10, 1, 254]);

// Audit/Usage/Evidence Records, Workspace Deletion Closure: retained bytes are
// exact, output is private and exclusive, and sync precedes acknowledgement.
// Fault residue and error precedence characterize the original physical owner.
describe('retained deletion closure physical construction', () => {
  it('creates the four caller-admitted roots privately and commits ancestor entries in order', () => {
    const parent = fixture();
    const family = join(parent, 'family');
    const owner = join(family, 'owner');
    const root = join(owner, 'closure');

    createPrivateRetainedTreeRoot(parent, family, owner, root);

    for (const path of [family, owner, root]) expect(lstatSync(path).mode & 0o777).toBe(0o700);
    expect(
      physical.events.filter(({ operation }) => operation === 'sync').map(({ path }) => path)
    ).toEqual([parent, family, owner]);
    writeFileSync(join(root, 'retained'), bytes);
    expect(() => createPrivateRetainedTreeRoot(parent, family, owner, root)).toThrow(
      expect.objectContaining({ code: 'EEXIST' })
    );
    expect(readFileSync(join(root, 'retained'))).toEqual(bytes);
  });

  it('prepares nested private directories and restores an existing directory to 0700', () => {
    const parent = fixture();
    const nested = join(parent, 'nested', 'empty');
    prepareRetainedPrivateDirectory(nested);
    chmodSync(nested, 0o755);
    prepareRetainedPrivateDirectory(nested);
    expect(lstatSync(nested).mode & 0o777).toBe(0o700);
    expect(readdirSync(nested)).toEqual([]);
  });

  it('refuses file and linked private directory selections without modifying the target', () => {
    const parent = fixture();
    const file = join(parent, 'file');
    writeFileSync(file, bytes);
    expect(() => prepareRetainedPrivateDirectory(file)).toThrow();
    const target = join(parent, 'target');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    const link = join(parent, 'link');
    symlinkSync(target, link);
    expect(() => prepareRetainedPrivateDirectory(link)).toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
  });

  it.each(['text', 'binary'] as const)(
    'writes exact %s bytes privately, syncs and closes before acknowledging the parent',
    (kind) => {
      const parent = fixture();
      const path = join(parent, 'nested', 'record');
      const value = kind === 'text' ? 'retained \u2603\n' : bytes;
      writeRetainedPrivateFile(path, value);
      expect(readFileSync(path)).toEqual(Buffer.from(value));
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(
        physical.events.filter((event) => event.path === path || event.operation === 'sync')
      ).toEqual([
        { operation: 'sync', path },
        { operation: 'close', path },
        { operation: 'chmod', path },
        { operation: 'sync', path: dirname(path) },
      ]);
      expect(() => writeRetainedPrivateFile(path, 'replacement')).toThrow(
        expect.objectContaining({ code: 'EEXIST' })
      );
      expect(readFileSync(path)).toEqual(Buffer.from(value));
    }
  );

  it('copies nested and empty evidence directories with exact bytes and private output modes', () => {
    const parent = fixture();
    const source = join(parent, 'source');
    const target = join(parent, 'target');
    mkdirSync(join(source, 'nested', 'empty'), { recursive: true });
    writeFileSync(join(source, 'nested', 'content'), bytes);
    chmodSync(join(source, 'nested', 'content'), 0o644);
    chmodSync(join(source, 'nested'), 0o755);
    copyRetainedEvidenceTree(source, target);
    expect(readFileSync(join(target, 'nested', 'content'))).toEqual(bytes);
    expect(readFileSync(join(source, 'nested', 'content'))).toEqual(bytes);
    expect(lstatSync(join(source, 'nested', 'content')).mode & 0o777).toBe(0o644);
    for (const path of [target, join(target, 'nested'), join(target, 'nested', 'empty')])
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(target, 'nested', 'content')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(target, 'nested', 'empty'))).toEqual([]);
    const syncs = physical.events
      .filter(({ operation }) => operation === 'sync')
      .map(({ path }) => path);
    expect(syncs.indexOf(join(target, 'nested', 'content'))).toBeLessThan(
      syncs.lastIndexOf(join(target, 'nested'))
    );
    expect(syncs.indexOf(join(target, 'nested', 'empty'))).toBeLessThan(
      syncs.lastIndexOf(join(target, 'nested'))
    );
    expect(syncs.lastIndexOf(join(target, 'nested'))).toBeLessThan(syncs.lastIndexOf(target));
    expect(() => copyRetainedEvidenceTree(source, target)).toThrow(
      expect.objectContaining({ code: 'EEXIST' })
    );
    expect(readFileSync(join(target, 'nested', 'content'))).toEqual(bytes);
  });

  it('refuses a missing or linked evidence root before creating a destination', () => {
    const parent = fixture();
    const target = join(parent, 'target');
    expect(() => copyRetainedEvidenceTree(join(parent, 'absent'), target)).toThrow(
      'Retained evidence bytes are missing.'
    );
    const source = join(parent, 'source');
    mkdirSync(source);
    symlinkSync(source, join(parent, 'link'));
    expect(() => copyRetainedEvidenceTree(join(parent, 'link'), target)).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it.each(['link', 'fifo'] as const)(
    'refuses a retained %s member and preserves external bytes',
    (kind) => {
      const parent = fixture();
      const source = join(parent, 'source');
      const target = join(parent, 'target');
      mkdirSync(source);
      const outside = join(parent, 'outside');
      writeFileSync(outside, bytes);
      const member = join(source, 'unsupported');
      if (kind === 'link') symlinkSync(outside, member);
      else execFileSync('mkfifo', [member]);
      expect(() => copyRetainedEvidenceTree(source, target)).toThrow(
        kind === 'link'
          ? 'Retained evidence cannot contain symbolic links.'
          : 'Retained evidence must contain only regular files and directories.'
      );
      expect(readFileSync(outside)).toEqual(bytes);
      expect(readdirSync(target)).toEqual([]);
    }
  );

  it('leaves real partial output for its caller to clean and closes the failed writer', () => {
    const parent = fixture();
    const path = join(parent, 'record');
    const failure = new Error('injected retained write failure');
    physical.failurePath = path;
    physical.writeFailure = failure;
    expect(() => writeRetainedPrivateFile(path, bytes)).toThrow(failure);
    expect(readFileSync(path)).toEqual(bytes.subarray(0, 3));
    expect(physical.events.filter(({ operation }) => operation === 'sync')).toEqual([]);
    expect(physical.closed).toHaveLength(1);
    expect(() => fstatSync(physical.closed[0]!)).toThrow(
      expect.objectContaining({ code: 'EBADF' })
    );
  });

  it('does not acknowledge the parent after file synchronization fails', () => {
    const parent = fixture();
    const path = join(parent, 'record');
    const failure = new Error('injected retained sync failure');
    physical.failurePath = path;
    physical.syncFailure = failure;
    expect(() => writeRetainedPrivateFile(path, bytes)).toThrow(failure);
    expect(readFileSync(path)).toEqual(bytes);
    expect(physical.events).toEqual([
      { operation: 'chmod', path: parent },
      { operation: 'sync', path },
      { operation: 'close', path },
    ]);
  });

  it.each(['write', 'sync'] as const)(
    'retains original close-failure precedence after a %s failure',
    (stage) => {
      const parent = fixture();
      const path = join(parent, 'record');
      const failure = new Error(`injected ${stage} failure`);
      const closeFailure = new Error('injected retained close failure');
      physical.failurePath = path;
      if (stage === 'write') physical.writeFailure = failure;
      else physical.syncFailure = failure;
      physical.closeFailure = closeFailure;
      expect(() => writeRetainedPrivateFile(path, bytes)).toThrow(closeFailure);
      expect(physical.closed).toHaveLength(1);
      expect(
        physical.events.some(
          ({ operation, path: selected }) => operation === 'sync' && selected === parent
        )
      ).toBe(false);
    }
  );

  it('synchronizes the selected directory and closes it when synchronization fails', () => {
    const parent = fixture();
    syncRetainedDirectory(parent);
    expect(physical.events).toEqual([
      { operation: 'sync', path: parent },
      { operation: 'close', path: parent },
    ]);
    const failure = new Error('injected directory sync failure');
    physical.failurePath = parent;
    physical.syncFailure = failure;
    expect(() => syncRetainedDirectory(parent)).toThrow(failure);
    physical.closeFailure = new Error('injected directory close failure');
    expect(() => syncRetainedDirectory(parent)).toThrow(physical.closeFailure);
  });
});
