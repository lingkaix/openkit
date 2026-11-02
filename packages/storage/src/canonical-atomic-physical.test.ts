// openkit-test-platform: posix
import {
  closeSync,
  existsSync,
  fstatSync,
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
import { CanonicalPublicationError, writeCanonicalFileAtomic } from './local.js';

const effect = vi.hoisted(() => ({
  parent: '',
  temporary: undefined as string | undefined,
  fileDescriptor: undefined as number | undefined,
  fileClosed: false,
  published: false,
  collideOpen: false,
  expectedMode: undefined as number | undefined,
  opened: new Map<number, string>(),
  events: [] as string[],
  writeFailure: undefined as Error | undefined,
  cleanupFailure: undefined as Error | undefined,
  closeFailure: undefined as Error | undefined,
  parentSyncFailure: undefined as Error | undefined,
  accountingFailure: undefined as Error | undefined,
  availabilityFailure: undefined as Error | undefined,
}));

const unownedBytes = Buffer.from([9, 0, 255]);

// Native operations remain real; faults occur only at named physical boundaries.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const writing = typeof args[1] === 'number' && (args[1] & actual.constants.O_CREAT) !== 0;
      if (writing) {
        effect.temporary = String(args[0]);
        if (effect.collideOpen) {
          effect.collideOpen = false;
          actual.writeFileSync(args[0], Buffer.from([9, 0, 255]), { flag: 'wx', mode: 0o640 });
          actual.chmodSync(args[0], 0o640);
        }
      }
      const descriptor = actual.openSync(...args);
      effect.opened.set(descriptor, String(args[0]));
      if (writing) effect.fileDescriptor = descriptor;
      return descriptor;
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (typeof args[0] === 'number' && effect.writeFailure) {
        const bytes =
          typeof args[1] === 'string' ? Buffer.from(args[1]) : Buffer.from(args[1] as Uint8Array);
        actual.writeSync(args[0], bytes.subarray(0, 3));
        throw effect.writeFailure;
      }
      return actual.writeFileSync(...args);
    },
    fsyncSync(descriptor: number) {
      if (actual.fstatSync(descriptor).isFile()) {
        if (effect.expectedMode !== undefined) {
          expect(actual.fstatSync(descriptor).mode & 0o777).toBe(effect.expectedMode);
        }
        effect.events.push('file sync');
      } else if (effect.opened.get(descriptor) === effect.parent && effect.published) {
        effect.events.push('parent sync');
        if (effect.parentSyncFailure) throw effect.parentSyncFailure;
      } else {
        effect.events.push('prepare sync');
      }
      return actual.fsyncSync(descriptor);
    },
    closeSync(descriptor: number) {
      actual.closeSync(descriptor);
      if (descriptor === effect.fileDescriptor) {
        effect.fileClosed = true;
        if (effect.closeFailure) {
          const failure = effect.closeFailure;
          effect.closeFailure = undefined;
          throw failure;
        }
      }
    },
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      expect(effect.fileClosed).toBe(true);
      expect(() => actual.fstatSync(effect.fileDescriptor!)).toThrowError(
        expect.objectContaining({ code: 'EBADF' })
      );
      actual.renameSync(...args);
      effect.published = true;
      effect.events.push('rename');
    },
    linkSync(...args: Parameters<typeof actual.linkSync>) {
      expect(effect.fileClosed).toBe(true);
      expect(() => actual.fstatSync(effect.fileDescriptor!)).toThrowError(
        expect.objectContaining({ code: 'EBADF' })
      );
      actual.linkSync(...args);
      effect.published = true;
      effect.events.push('link');
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      if (String(args[0]) === effect.temporary && effect.cleanupFailure)
        throw effect.cleanupFailure;
      actual.rmSync(...args);
      if (String(args[0]) === effect.temporary) {
        expect(actual.existsSync(args[0])).toBe(false);
        effect.events.push('temporary absent');
      }
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  effect.writeFailure = undefined;
  effect.cleanupFailure = undefined;
  effect.closeFailure = undefined;
  effect.parentSyncFailure = undefined;
  effect.accountingFailure = undefined;
  effect.availabilityFailure = undefined;
  for (const descriptor of effect.opened.keys()) {
    try {
      closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
  effect.parent = '';
  effect.temporary = undefined;
  effect.fileDescriptor = undefined;
  effect.fileClosed = false;
  effect.published = false;
  effect.collideOpen = false;
  effect.expectedMode = undefined;
  effect.opened.clear();
  effect.events.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const oldBytes = Buffer.from([4, 3, 2, 0]);
const newBytes = Buffer.from([0, 255, 128, 13, 10]);

/** Own private publication paths without constructing a canonical domain record. */
function fixture(prior = true) {
  const root = mkdtempSync(join(tmpdir(), 'storage-canonical-atomic-'));
  roots.push(root);
  const parent = join(root, 'published');
  mkdirSync(parent, { mode: 0o700 });
  const path = join(parent, 'record');
  if (prior) writeFileSync(path, oldBytes, { mode: 0o640 });
  effect.parent = parent;
  return { root, parent, path };
}

/** Observe original concrete reservation methods without modeling current admission. */
function reservation() {
  const value = {
    written: [] as number[],
    available: 0,
    released: 0,
    temporaryAtRelease: undefined as boolean | undefined,
    recordWritten(count: number) {
      expect(this).toBe(value);
      expect(fstatSync(effect.fileDescriptor!).isFile()).toBe(true);
      this.written.push(count);
      effect.events.push('record');
      if (effect.accountingFailure) throw effect.accountingFailure;
    },
    assertAvailable() {
      expect(this).toBe(value);
      expect(effect.fileClosed).toBe(true);
      expect(effect.events.at(-1)).toBe('parent sync');
      this.available++;
      effect.events.push('available');
      if (effect.availabilityFailure) throw effect.availabilityFailure;
    },
    release() {
      expect(this).toBe(value);
      this.released++;
      this.temporaryAtRelease = effect.temporary !== undefined && existsSync(effect.temporary);
      effect.events.push('release');
    },
  };
  return value;
}

/** Compare thrown object identity without deriving an expected error from the candidate. */
function caught(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected atomic publication to fail.');
}

/** Failed publication must not leak its real temporary descriptor. */
function expectClosed() {
  expect(effect.fileClosed).toBe(true);
  expect(() => fstatSync(effect.fileDescriptor!)).toThrowError(
    expect.objectContaining({ code: 'EBADF' })
  );
}

// Core Storage's immutable-content and acknowledgement boundaries require ordered durable publication.
// Capacity admission and byte measurement remain NanoCore; these tests preserve the original native lifetime.
describe('canonical atomic physical write', () => {
  it('replaces exact UTF-8 bytes with the private default and releases after durable publication', () => {
    const f = fixture();
    const capacity = reservation();
    const content = ' \u00e9\n';
    const bytes = Buffer.from([32, 195, 169, 10]);
    const before = statSync(f.path);

    const previousUmask = process.umask(0o027);
    try {
      writeCanonicalFileAtomic(f.path, content, bytes.length, capacity, undefined, 'replace');
    } finally {
      process.umask(previousUmask);
    }

    expect(readFileSync(f.path)).toEqual(bytes);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(statSync(f.path).ino).not.toBe(before.ino);
    expect(readdirSync(f.parent)).toEqual(['record']);
    expect(capacity.written).toEqual([bytes.length]);
    expect(capacity.available).toBe(1);
    expect(capacity.released).toBe(1);
    expect(capacity.temporaryAtRelease).toBe(false);
    expect(effect.events).toEqual([
      'prepare sync',
      'record',
      'file sync',
      'rename',
      'parent sync',
      'available',
      'release',
    ]);
    expectClosed();
  });

  it('creates exact binary bytes by link with absent reservation and exact supplied mode', () => {
    const f = fixture(false);
    effect.expectedMode = 0o754;
    const previousUmask = process.umask(0o077);
    try {
      writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, undefined, 0o754, 'create');
    } finally {
      process.umask(previousUmask);
    }

    expect(readFileSync(f.path)).toEqual(newBytes);
    expect(statSync(f.path).mode & 0o777).toBe(0o754);
    expect(readdirSync(f.parent)).toEqual(['record']);
    expect(effect.events).toEqual([
      'prepare sync',
      'file sync',
      'link',
      'temporary absent',
      'parent sync',
    ]);
    expectClosed();
  });

  it('preserves a create-mode winner and releases only after removing its owned temporary', () => {
    const f = fixture();
    const capacity = reservation();
    const before = statSync(f.path);

    expect(() =>
      writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'create')
    ).toThrowError(expect.objectContaining({ code: 'EEXIST' }));

    expect(readFileSync(f.path)).toEqual(oldBytes);
    expect(statSync(f.path).ino).toBe(before.ino);
    expect(readdirSync(f.parent)).toEqual(['record']);
    expect(capacity.written).toEqual([newBytes.length]);
    expect(capacity.available).toBe(0);
    expect(capacity.released).toBe(1);
    expect(capacity.temporaryAtRelease).toBe(false);
    expectClosed();
  });

  it('releases a pre-open symbolic-link refusal without changing linked target bytes', () => {
    const f = fixture(false);
    const retained = join(f.root, 'retained');
    writeFileSync(retained, oldBytes);
    symlinkSync(retained, f.path);
    const capacity = reservation();

    expect(() =>
      writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'replace')
    ).toThrow(/symbolic link/);

    expect(readFileSync(retained)).toEqual(oldBytes);
    expect(effect.temporary).toBeUndefined();
    expect(capacity.written).toEqual([]);
    expect(capacity.released).toBe(1);
    expect(capacity.temporaryAtRelease).toBe(false);
  });

  it('retains capacity and unowned bytes when exclusive temporary open fails', () => {
    const f = fixture();
    const capacity = reservation();
    effect.collideOpen = true;

    expect(() =>
      writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'replace')
    ).toThrowError(expect.objectContaining({ code: 'EEXIST' }));

    expect(readFileSync(f.path)).toEqual(oldBytes);
    expect(readFileSync(effect.temporary!)).toEqual(unownedBytes);
    expect(statSync(effect.temporary!).mode & 0o777).toBe(0o640);
    expect(effect.fileDescriptor).toBeUndefined();
    expect(capacity.written).toEqual([]);
    expect(capacity.available).toBe(0);
    expect(capacity.released).toBe(0);
  });

  it('retains owned partial evidence and capacity when cleanup supersedes a write failure', () => {
    const f = fixture();
    const capacity = reservation();
    effect.writeFailure = new Error('injected partial write refusal');
    effect.cleanupFailure = new Error('injected owned cleanup refusal');

    expect(
      caught(() =>
        writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'replace')
      )
    ).toBe(effect.cleanupFailure);

    expect(readFileSync(f.path)).toEqual(oldBytes);
    expect(readFileSync(effect.temporary!)).toEqual(newBytes.subarray(0, 3));
    expect(capacity.written).toEqual([]);
    expect(capacity.released).toBe(0);
    expectClosed();
  });

  it('cleans owned output and releases after a concrete accounting-method failure', () => {
    const f = fixture();
    const capacity = reservation();
    effect.accountingFailure = new Error('injected accounting refusal');

    expect(
      caught(() =>
        writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'replace')
      )
    ).toBe(effect.accountingFailure);

    expect(readFileSync(f.path)).toEqual(oldBytes);
    expect(readdirSync(f.parent)).toEqual(['record']);
    expect(capacity.written).toEqual([newBytes.length]);
    expect(capacity.available).toBe(0);
    expect(capacity.released).toBe(1);
    expect(capacity.temporaryAtRelease).toBe(false);
    expect(effect.events).not.toContain('file sync');
    expectClosed();
  });

  it('preserves published bytes after availability refusal and releases after absent-temp cleanup', () => {
    const f = fixture();
    const capacity = reservation();
    effect.availabilityFailure = new Error('injected post-publication availability refusal');

    expect(
      caught(() =>
        writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'replace')
      )
    ).toBe(effect.availabilityFailure);

    expect(readFileSync(f.path)).toEqual(newBytes);
    expect(readdirSync(f.parent)).toEqual(['record']);
    expect(capacity.available).toBe(1);
    expect(capacity.released).toBe(1);
    expect(capacity.temporaryAtRelease).toBe(false);
    expect(effect.events.slice(-3)).toEqual(['available', 'temporary absent', 'release']);
    expectClosed();
  });

  it('reports post-link parent-sync uncertainty with the original cause and visible target', () => {
    const f = fixture(false);
    const capacity = reservation();
    effect.parentSyncFailure = new Error('injected publication parent synchronization refusal');

    const error = caught(() =>
      writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'create')
    );

    expect(error).toBeInstanceOf(CanonicalPublicationError);
    expect(error).toMatchObject({
      code: 'recovery_required',
      status: 409,
      cause: effect.parentSyncFailure,
    });
    expect((error as Error).cause).toBe(effect.parentSyncFailure);
    expect((error as Error).message).toContain(
      'Directory sync after link failed during publication acknowledgement'
    );
    expect(readFileSync(f.path)).toEqual(newBytes);
    expect(readdirSync(f.parent)).toEqual(['record']);
    expect(capacity.available).toBe(0);
    expect(capacity.released).toBe(1);
    expect(capacity.temporaryAtRelease).toBe(false);
    expectClosed();
  });

  it('preserves close-error precedence over a write failure and releases after owned cleanup', () => {
    const f = fixture();
    const capacity = reservation();
    effect.writeFailure = new Error('injected partial write refusal');
    const closeFailure = new Error('injected close acknowledgement refusal');
    effect.closeFailure = closeFailure;

    expect(
      caught(() =>
        writeCanonicalFileAtomic(f.path, newBytes, newBytes.length, capacity, undefined, 'replace')
      )
    ).toBe(closeFailure);

    expect(readFileSync(f.path)).toEqual(oldBytes);
    expect(readdirSync(f.parent)).toEqual(['record']);
    expect(capacity.written).toEqual([]);
    expect(capacity.released).toBe(1);
    expect(capacity.temporaryAtRelease).toBe(false);
    expectClosed();
  });
});
