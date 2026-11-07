// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
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
import { assertContextPackageFileProof, publishContextPackageMember } from './local.js';

const fault = vi.hoisted(() => ({
  limit: undefined as number | undefined,
  stopAfter: undefined as number | undefined,
  written: 0,
  corrupt: false,
  fileSync: undefined as Error | undefined,
  parentSyncFailures: 0,
  removal: undefined as Error | undefined,
  duringWrite: undefined as (() => void) | undefined,
  events: [] as string[],
}));

// Only the named syscall is altered. Files, descriptors, proof reads and cleanup remain real.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync(descriptor: number, bytes: Uint8Array, offset: number, length: number) {
      fault.duringWrite?.();
      if (fault.stopAfter !== undefined && fault.written >= fault.stopAfter) return 0;
      const count = Math.min(length, fault.limit ?? length);
      const input = fault.corrupt ? Uint8Array.from(bytes, (byte) => byte ^ 1) : bytes;
      const written = actual.writeSync(descriptor, input, offset, count);
      fault.written += written;
      return written;
    },
    fsyncSync(descriptor: number) {
      const directory = actual.fstatSync(descriptor).isDirectory();
      if (directory && fault.parentSyncFailures > 0) {
        fault.parentSyncFailures--;
        throw new Error('injected parent synchronization failure');
      }
      if (!directory && fault.fileSync) throw fault.fileSync;
      actual.fsyncSync(descriptor);
      fault.events.push(directory ? 'parent synchronized' : 'file synchronized');
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      if (fault.removal) throw fault.removal;
      return actual.rmSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.limit = undefined;
  fault.stopAfter = undefined;
  fault.written = 0;
  fault.corrupt = false;
  fault.fileSync = undefined;
  fault.parentSyncFailures = 0;
  fault.removal = undefined;
  fault.duringWrite = undefined;
  fault.events.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses private physical bytes without manufacturing a Turn or authority record. */
function fixture(name = 'instructions.md') {
  const root = mkdtempSync(join(tmpdir(), 'storage-context-package-'));
  roots.push(root);
  return { root, path: join(root, name), temporary: join(root, '.package.json.tmp') };
}

/** Retains the caller's receiver and actual byte accounting at the moved boundary. */
function reservation(onRelease?: () => void) {
  const value = {
    written: 0,
    released: 0,
    assertAvailable() {
      expect(this).toBe(value);
      fault.events.push('admitted');
    },
    recordWritten(count: number) {
      expect(this).toBe(value);
      this.written += count;
    },
    release() {
      expect(this).toBe(value);
      onRelease?.();
      this.released++;
      fault.events.push('released');
    },
  };
  return value;
}

/** Derives the proof from independent fixture bytes, never from the measured file. */
function proof(bytes: Uint8Array) {
  return {
    byteLength: bytes.byteLength,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

// Core Storage / Principles and SQLite Layers require durable bytes before acknowledgement.
// S39 / Historical Inspection requires exact retained bytes and explicit corruption refusal.
describe('Context Package physical member publication', () => {
  it.each([0, 131_083])('preserves %i binary bytes, private mode and durable release', (size) => {
    const { path, root } = fixture();
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => index % 256));
    const capacity = reservation(() => {
      expect(readFileSync(path)).toEqual(bytes);
      expect(fault.events.slice(-2)).toEqual(['file synchronized', 'parent synchronized']);
    });

    publishContextPackageMember(path, { path: 'instructions.md', bytes }, capacity);

    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(['instructions.md']);
    expect(capacity.written).toBe(size);
    expect(capacity.released).toBe(1);
    assertContextPackageFileProof(path, proof(bytes));
  });

  it('continues after actual short writes and accounts only bytes written', () => {
    const { path } = fixture();
    const bytes = Buffer.from([0, 255, 128, 13, 10, 1, 2, 3, 4, 5, 6]);
    fault.limit = 3;
    const capacity = reservation();

    publishContextPackageMember(path, { path: 'instructions.md', bytes }, capacity);

    expect(readFileSync(path)).toEqual(bytes);
    expect(capacity.written).toBe(bytes.length);
    expect(capacity.released).toBe(1);
  });

  it.each(['regular', 'symlink', 'hardlink'] as const)(
    'refuses an existing %s destination without changing retained bytes',
    (kind) => {
      const { path, root } = fixture();
      const retained = Buffer.from([0, 255, 42]);
      const target = join(root, 'retained');
      writeFileSync(target, retained);
      if (kind === 'regular') writeFileSync(path, retained);
      else if (kind === 'symlink') symlinkSync(target, path);
      else linkSync(target, path);
      const capacity = reservation();

      expect(() =>
        publishContextPackageMember(
          path,
          { path: 'instructions.md', bytes: Buffer.from('new') },
          capacity
        )
      ).toThrow();

      expect(readFileSync(path)).toEqual(retained);
      expect(readFileSync(target)).toEqual(retained);
      expect(capacity.written).toBe(0);
      expect(capacity.released).toBe(1);
    }
  );

  it('checks current reservation before creating bytes and releases a refused reservation', () => {
    const { path, root } = fixture();
    const capacity = reservation();
    const refused = new Error('caller capacity expired');
    capacity.assertAvailable = () => {
      throw refused;
    };

    expect(() =>
      publishContextPackageMember(
        path,
        { path: 'instructions.md', bytes: Buffer.from('new') },
        capacity
      )
    ).toThrow(refused);

    expect(readdirSync(root)).toEqual([]);
    expect(capacity.released).toBe(1);
  });

  it('keeps the manifest absent until its complete temporary bytes are synchronized', () => {
    const { path, root, temporary } = fixture('package.json');
    const bytes = Buffer.from('{"files":[],"annotation":"exact retained manifest"}\n');
    fault.limit = 7;
    fault.duringWrite = () => {
      expect(existsSync(path)).toBe(false);
      expect(existsSync(temporary)).toBe(true);
    };
    const capacity = reservation(() => {
      expect(readFileSync(path)).toEqual(bytes);
      expect(existsSync(temporary)).toBe(false);
      expect(fault.events.slice(-2)).toEqual(['file synchronized', 'parent synchronized']);
    });

    publishContextPackageMember(path, { path: 'package.json', bytes }, capacity);

    expect(readdirSync(root)).toEqual(['package.json']);
    expect(capacity.written).toBe(bytes.length);
    expect(capacity.released).toBe(1);
  });

  it('refuses an occupied manifest temporary path without deleting it', () => {
    const { path, temporary } = fixture('package.json');
    writeFileSync(temporary, 'other in-flight bytes');
    const capacity = reservation();

    expect(() =>
      publishContextPackageMember(
        path,
        { path: 'package.json', bytes: Buffer.from('{}') },
        capacity
      )
    ).toThrow();

    expect(readFileSync(temporary, 'utf8')).toBe('other in-flight bytes');
    expect(existsSync(path)).toBe(false);
    expect(capacity.released).toBe(1);
  });

  it.each(['no progress', 'payload synchronization', 'digest proof'] as const)(
    'removes partial manifest bytes and synchronizes cleanup after %s failure',
    (failure) => {
      const { path, root, temporary } = fixture('package.json');
      fault.limit = 3;
      if (failure === 'no progress') fault.stopAfter = 3;
      if (failure === 'payload synchronization') fault.fileSync = new Error('payload sync failed');
      if (failure === 'digest proof') fault.corrupt = true;
      const capacity = reservation(() => {
        expect(existsSync(path)).toBe(false);
        expect(existsSync(temporary)).toBe(false);
        expect(fault.events.at(-1)).toBe('parent synchronized');
      });

      expect(() =>
        publishContextPackageMember(
          path,
          { path: 'package.json', bytes: Buffer.from('manifest bytes') },
          capacity
        )
      ).toThrow();

      expect(readdirSync(root)).toEqual([]);
      expect(capacity.written).toBe(failure === 'no progress' ? 3 : 14);
      expect(capacity.released).toBe(1);
    }
  );

  it.each(['removal', 'cleanup synchronization'] as const)(
    'retains capacity when %s cannot prove cleanup',
    (failure) => {
      const { path, temporary } = fixture('package.json');
      fault.fileSync = new Error('payload sync failed');
      if (failure === 'removal') fault.removal = new Error('cleanup removal failed');
      else fault.parentSyncFailures = 1;
      const capacity = reservation();

      expect(() =>
        publishContextPackageMember(
          path,
          { path: 'package.json', bytes: Buffer.from('partial') },
          capacity
        )
      ).toThrow();

      expect(existsSync(path)).toBe(false);
      expect(existsSync(temporary)).toBe(failure === 'removal');
      expect(capacity.written).toBe(7);
      expect(capacity.released).toBe(0);
    }
  );

  it('reports failed manifest acknowledgement while preserving already-renamed bytes', () => {
    const { path, temporary } = fixture('package.json');
    const bytes = Buffer.from('{"files":[]}');
    fault.parentSyncFailures = 1;
    const capacity = reservation(() => {
      expect(readFileSync(path)).toEqual(bytes);
      expect(fault.events.at(-1)).toBe('parent synchronized');
    });

    expect(() =>
      publishContextPackageMember(path, { path: 'package.json', bytes }, capacity)
    ).toThrow('injected parent synchronization failure');

    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(temporary)).toBe(false);
    expect(capacity.released).toBe(1);
    assertContextPackageFileProof(path, proof(bytes));
  });
});

describe('Context Package retained file proof', () => {
  it.each(['length', 'digest', 'same-length changed bytes'] as const)(
    'refuses a %s mismatch without modifying retained bytes',
    (kind) => {
      const { path } = fixture();
      const bytes = Buffer.from([0, 255, 128, 13, 10]);
      const expected = proof(bytes);
      const retained =
        kind === 'same-length changed bytes' ? Buffer.from([1, 255, 128, 13, 10]) : bytes;
      writeFileSync(path, retained);
      if (kind === 'length') expected.byteLength++;
      if (kind === 'digest') expected.contentDigest = `sha256:${'0'.repeat(64)}`;

      expect(() => assertContextPackageFileProof(path, expected)).toThrow();

      expect(readFileSync(path)).toEqual(retained);
    }
  );

  it.each(['missing', 'directory', 'symlink', 'hardlink'] as const)(
    'refuses a %s instead of proving a unique regular file',
    (kind) => {
      const { path, root } = fixture();
      const target = join(root, 'target');
      const bytes = Buffer.from([0, 255, 128]);
      writeFileSync(target, bytes);
      if (kind === 'directory') mkdirSync(path);
      if (kind === 'symlink') symlinkSync(target, path);
      if (kind === 'hardlink') linkSync(target, path);

      expect(() => assertContextPackageFileProof(path, proof(bytes))).toThrow();

      expect(readFileSync(target)).toEqual(bytes);
      expect(existsSync(path)).toBe(kind !== 'missing');
    }
  );
});
