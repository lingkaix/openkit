// openkit-test-platform: posix
import {
  appendFileSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCanonicalFile } from './local.js';

const fault = vi.hoisted(() => ({
  path: '',
  descriptor: undefined as number | undefined,
  beforeOpen: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined,
  closed: false,
}));

// Files, reads and descriptor lifetime stay real. Only the named race is injected.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  const afterRead = (descriptor: unknown) => {
    if (descriptor !== fault.descriptor || !fault.afterRead) return;
    const inject = fault.afterRead;
    fault.afterRead = undefined;
    inject();
  };
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      if (String(args[0]) === fault.path) {
        const inject = fault.beforeOpen;
        fault.beforeOpen = undefined;
        inject?.();
      }
      const descriptor = actual.openSync(...args);
      if (String(args[0]) === fault.path) fault.descriptor = descriptor;
      return descriptor;
    },
    readSync(...args: Parameters<typeof actual.readSync>) {
      const count = actual.readSync(...args);
      afterRead(args[0]);
      return count;
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      const bytes = actual.readFileSync(...args);
      afterRead(args[0]);
      return bytes;
    },
    closeSync(descriptor: number) {
      actual.closeSync(descriptor);
      if (descriptor === fault.descriptor) fault.closed = true;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.path = '';
  fault.descriptor = undefined;
  fault.beforeOpen = undefined;
  fault.afterRead = undefined;
  fault.closed = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates only disposable bytes, with no domain record or publication authority. */
function fixture(bytes = Buffer.from([0, 255, 10, 65, 66])) {
  const root = mkdtempSync(join(tmpdir(), 'storage-canonical-bounded-'));
  roots.push(root);
  const path = join(root, 'proof.json');
  writeFileSync(path, bytes);
  fault.path = path;
  return { root, path, bytes };
}

/** A failed bounded acquisition must not retain its native descriptor. */
function expectClosed() {
  expect(fault.descriptor).toBeTypeOf('number');
  expect(fault.closed).toBe(true);
  expect(() => fstatSync(fault.descriptor!)).toThrow();
}

describe('canonical exact byte acquisition', () => {
  it.each([
    Buffer.alloc(0),
    Buffer.from([0, 255, 10, 65]),
  ])('keeps one-argument reads and exact-length reads byte-identical for %j', (bytes) => {
    const f = fixture(bytes);
    expect(readCanonicalFile(f.path)).toEqual(bytes);
    expect(readCanonicalFile(f.path, bytes.length)).toEqual(bytes);
    expectClosed();
  });

  it.each([4, 6])('refuses an original length different from declared %i bytes', (expected) => {
    const f = fixture();
    expect(() => readCanonicalFile(f.path, expected)).toThrow();
    expect(readFileSync(f.path)).toEqual(f.bytes);
    expectClosed();
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('refuses an invalid exact byte length %s', (expected) => {
    const f = fixture();
    expect(() => readCanonicalFile(f.path, expected)).toThrow();
    expect(readFileSync(f.path)).toEqual(f.bytes);
  });

  it.each(['link', 'directory'] as const)('refuses a %s without changing its bytes', (kind) => {
    const f = fixture();
    const selected = join(f.root, 'selected');
    if (kind === 'link') symlinkSync(f.path, selected);
    else mkdirSync(selected);
    expect(() => readCanonicalFile(selected, f.bytes.length)).toThrow();
    expect(readFileSync(f.path)).toEqual(f.bytes);
  });

  it('refuses a symlink substituted between path inspection and native open', () => {
    const f = fixture();
    const outside = join(f.root, 'outside');
    const protectedBytes = Buffer.from('outside');
    writeFileSync(outside, protectedBytes);
    let crossed = false;
    fault.beforeOpen = () => {
      crossed = true;
      renameSync(f.path, join(f.root, 'retained'));
      symlinkSync(outside, f.path);
    };
    expect(() => readCanonicalFile(f.path, f.bytes.length)).toThrow();
    expect(crossed).toBe(true);
    expect(readFileSync(outside)).toEqual(protectedBytes);
  });

  it.each([
    'grow',
    'shrink',
    'same-size-write',
    'path-replacement',
  ] as const)('refuses concurrent %s after the actual read and closes the descriptor', (kind) => {
    const f = fixture();
    let crossed = false;
    fault.afterRead = () => {
      crossed = true;
      if (kind === 'grow') appendFileSync(f.path, Buffer.from([99]));
      else if (kind === 'shrink') truncateSync(f.path, 2);
      else {
        if (kind === 'path-replacement') renameSync(f.path, join(f.root, 'retained'));
        writeFileSync(f.path, Buffer.alloc(f.bytes.length, 9));
      }
    };
    expect(() => readCanonicalFile(f.path, f.bytes.length)).toThrow();
    expect(crossed).toBe(true);
    expectClosed();
  });
});
