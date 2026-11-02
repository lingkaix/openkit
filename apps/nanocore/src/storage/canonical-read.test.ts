// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  measureCanonicalFile,
  measureCanonicalFileDescriptor,
  readCanonicalFile,
  readCanonicalTextFile,
} from './workspace-file-records.js';

const io = vi.hoisted(() => ({
  path: undefined as string | undefined,
  opened: undefined as number | undefined,
  live: new Set<number>(),
  beforeOpen: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined,
}));

// Real files and reads decide the result. Faults affect only the selected fixture's descriptor.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const afterRead = (descriptor: number) => {
    if (!io.live.has(descriptor)) return;
    const fault = io.afterRead;
    io.afterRead = undefined;
    fault?.();
  };
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const selected = String(args[0]) === io.path;
      if (selected) {
        const fault = io.beforeOpen;
        io.beforeOpen = undefined;
        fault?.();
      }
      const descriptor = actual.openSync(...args);
      if (selected) {
        io.opened = descriptor;
        io.live.add(descriptor);
      }
      return descriptor;
    }) as typeof actual.openSync,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      const count = actual.readSync(...args);
      afterRead(args[0]);
      return count;
    }) as typeof actual.readSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const bytes = actual.readFileSync(...args);
      if (typeof args[0] === 'number') afterRead(args[0]);
      return bytes;
    }) as typeof actual.readFileSync,
    closeSync: (descriptor: number) => {
      actual.closeSync(descriptor);
      io.live.delete(descriptor);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  io.beforeOpen = undefined;
  io.afterRead = undefined;
  for (const descriptor of io.live) closeSync(descriptor);
  io.path = undefined;
  io.opened = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates only the byte owner's real filesystem state. */
function fixture(bytes: Buffer = Buffer.from('original bytes')): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-canonical-read-'));
  roots.push(root);
  const path = join(root, 'file');
  writeFileSync(path, bytes);
  io.path = path;
  return path;
}

/** Observes owned-descriptor cleanup, which a returned byte value cannot prove. */
function expectOwnedDescriptorClosed(): void {
  expect(io.opened).toBeDefined();
  expect(() => fstatSync(io.opened!)).toThrow(/EBADF/);
}

const readers = [readCanonicalFile, readCanonicalTextFile];
const measure = [
  { name: 'path', run: measureCanonicalFile },
  {
    name: 'caller descriptor',
    run: (path: string) => {
      const descriptor = openSync(path, 'r');
      try {
        return measureCanonicalFileDescriptor(descriptor);
      } finally {
        // Success or refusal must preserve caller ownership.
        expect(fstatSync(descriptor).isFile()).toBe(true);
        closeSync(descriptor);
      }
    },
  },
];

describe('canonical byte reads and integrity measurement', () => {
  it('returns exact binary bytes and complete UTF-8 text, then closes owned descriptors', () => {
    const bytes = Buffer.concat([
      Buffer.from('\uFEFFHello\0\r\n\u4e16\u754c'),
      Buffer.from([0xff]),
    ]);
    const path = fixture(bytes);
    // Storage requires exact bytes; text reading keeps the existing UTF-8 decoding contract.
    expect(readCanonicalFile(path)).toEqual(bytes);
    expectOwnedDescriptorClosed();
    expect(readCanonicalTextFile(path)).toBe('\uFEFFHello\0\r\n\u4e16\u754c\uFFFD');
    expectOwnedDescriptorClosed();
  });

  it.each([
    0, 200_003,
  ])('measures every byte of a %i-byte file through both public entries', (size) => {
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => index % 251));
    const path = fixture(bytes);
    const expected = {
      byteLength: size,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
    expect(measureCanonicalFile(path)).toEqual(expected);
    expectOwnedDescriptorClosed();
    const descriptor = openSync(path, 'r');
    try {
      const prefixLength = Math.min(17, size);
      expect(readSync(descriptor, Buffer.alloc(prefixLength), 0, prefixLength, null)).toBe(
        prefixLength
      );
      expect(measureCanonicalFileDescriptor(descriptor)).toEqual(expected);
      expect(readFileSync(descriptor)).toEqual(bytes.subarray(prefixLength));
      expect(fstatSync(descriptor).isFile()).toBe(true);
    } finally {
      closeSync(descriptor);
    }
  });

  it('refuses symbolic links and nonregular files without reading another target', () => {
    const path = fixture();
    const link = `${path}-link`;
    symlinkSync(path, link);
    const directory = `${path}-directory`;
    mkdirSync(directory);
    for (const read of [...readers, measureCanonicalFile]) {
      expect(() => read(link)).toThrow();
      expect(() => read(directory)).toThrow();
    }
    const descriptor = openSync(directory, 'r');
    try {
      expect(() => measureCanonicalFileDescriptor(descriptor)).toThrow();
      expect(fstatSync(descriptor).isDirectory()).toBe(true);
    } finally {
      closeSync(descriptor);
    }
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
  });

  it.each(readers)('%s refuses a link introduced after path validation', (read) => {
    const path = fixture();
    const outside = `${path}-outside`;
    writeFileSync(outside, 'outside bytes');
    io.beforeOpen = () => {
      rmSync(path);
      symlinkSync(outside, path);
    };
    expect(() => read(path)).toThrow(/symbolic link/);
    expect(io.beforeOpen).toBeUndefined();
    expect(readFileSync(outside, 'utf8')).toBe('outside bytes');
  });

  it.each(readers)('%s refuses a nonregular opened descriptor and closes it', (read) => {
    const path = fixture();
    io.beforeOpen = () => {
      rmSync(path);
      mkdirSync(path);
    };
    expect(() => read(path)).toThrow();
    expect(io.beforeOpen).toBeUndefined();
    expectOwnedDescriptorClosed();
  });

  it.each(readers)('%s preserves an unrelated open failure', (read) => {
    const path = fixture();
    const failure = Object.assign(new Error('Injected open refusal.'), { code: 'EACCES' });
    io.beforeOpen = () => {
      throw failure;
    };
    expect(() => read(path)).toThrow(failure);
    expect(io.beforeOpen).toBeUndefined();
  });

  it.each([
    ...readers,
    measureCanonicalFile,
  ])('%s closes an owned descriptor after a read fault', (read) => {
    const path = fixture();
    const failure = new Error('Injected canonical read failure.');
    io.afterRead = () => {
      throw failure;
    };
    expect(() => read(path)).toThrow(failure);
    expect(io.afterRead).toBeUndefined();
    expectOwnedDescriptorClosed();
  });

  it.each(
    measure
  )('refuses same-size mutation during $name measurement, even with preserved mtime', ({ run }) => {
    const path = fixture(Buffer.alloc(200_003, 0x61));
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const before = statSync(path, { bigint: true });
    io.afterRead = () => {
      writeFileSync(path, Buffer.alloc(200_003, 0x62));
      utimesSync(path, 1_700_000_000, 1_700_000_000);
    };
    expect(() => run(path)).toThrow();
    expect(io.afterRead).toBeUndefined();
    const after = statSync(path, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
  });

  it.each(measure)('refuses an incomplete real read during $name measurement', ({ run }) => {
    const path = fixture(Buffer.alloc(200_003, 0x61));
    io.afterRead = () => truncateSync(path, 0);
    expect(() => run(path)).toThrow();
    expect(io.afterRead).toBeUndefined();
  });
});
