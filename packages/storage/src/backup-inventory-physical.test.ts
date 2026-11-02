// openkit-test-platform: posix
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeWorkspaceBackupInventory } from './local.js';

const effect = vi.hoisted(() => ({
  opened: new Map<string, number>(),
  modes: [] as string[],
  limit: undefined as number | undefined,
  writes: [] as number[],
}));

// Observe real descriptor lifetime and simulate only native short writes.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const descriptor = actual.openSync(...args);
      effect.opened.set(String(args[0]), descriptor);
      return descriptor;
    },
    writeSync(
      descriptor: number,
      chunk: Uint8Array,
      offset = 0,
      length = chunk.length - offset,
      position: number | null = null
    ) {
      const written = actual.writeSync(
        descriptor,
        chunk,
        offset,
        Math.min(effect.limit ?? length, length),
        position
      );
      effect.writes.push(written);
      return written;
    },
    chmodSync(...args: Parameters<typeof actual.chmodSync>) {
      const path = String(args[0]);
      const descriptor = effect.opened.get(path);
      expect(descriptor).toBeTypeOf('number');
      expect(() => actual.fstatSync(descriptor!)).toThrowError(
        expect.objectContaining({ code: 'EBADF' })
      );
      effect.modes.push(path);
      return actual.chmodSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const descriptor of new Set(effect.opened.values())) {
    try {
      closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
  effect.opened.clear();
  effect.modes.length = 0;
  effect.limit = undefined;
  effect.writes.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Own private physical destinations without a manifest, identity graph or admission authority. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'storage-backup-inventory-'));
  roots.push(root);
  return root;
}

/** Supply byte chunks only; verified source authority belongs to the unchanged bundle owner. */
async function* chunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

/** Observe that source acquisition follows exclusive open while the destination remains private. */
function expectOpened(path: string) {
  const descriptor = effect.opened.get(path);
  expect(descriptor).toBeTypeOf('number');
  expect(fstatSync(descriptor!).isFile()).toBe(true);
  expect(fstatSync(descriptor!).mode & 0o777).toBe(0o600);
  expect(statSync(path).size).toBe(0);
}

/** The moved loop closes each descriptor on successful consumption and every thrown effect. */
function expectClosed(path: string) {
  expect(() => fstatSync(effect.opened.get(path)!)).toThrowError(
    expect.objectContaining({ code: 'EBADF' })
  );
}

// Core Storage shares byte effects; the backup owner retains verification and callback lifetime.
// This materialization is close-only private output, with outer validation/publication unchanged.
describe('Workspace backup inventory physical materialization', () => {
  it('preserves nested binary and empty bytes, concrete receivers and modes only after close', async () => {
    const root = fixture();
    const first = Uint8Array.from([0, 255, 128]);
    const second = Uint8Array.from([13, 10, 0, 254]);
    const inventory = [
      { path: 'nested/original.bin', mode: 0o440 },
      { path: 'empty', mode: 0o751 },
    ];
    const bundle = {
      calls: [] as string[],
      readFile(path: string) {
        expect(this).toBe(bundle);
        expectOpened(join(root, path));
        this.calls.push(path);
        return chunks(path === inventory[0]!.path ? [first, second] : []);
      },
    };
    const reserved = {
      counts: [] as number[],
      recordWritten(count: number) {
        expect(this).toBe(reserved);
        expect(fstatSync(effect.opened.get(join(root, inventory[0]!.path))!).isFile()).toBe(true);
        this.counts.push(count);
      },
    };

    await materializeWorkspaceBackupInventory(root, inventory, bundle, reserved);

    expect(readFileSync(join(root, inventory[0]!.path))).toEqual(
      Buffer.from([0, 255, 128, 13, 10, 0, 254])
    );
    expect(readFileSync(join(root, 'empty'))).toEqual(Buffer.alloc(0));
    expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, inventory[0]!.path)).mode & 0o777).toBe(0o440);
    expect(statSync(join(root, 'empty')).mode & 0o777).toBe(0o751);
    expect(bundle.calls).toEqual(inventory.map((entry) => entry.path));
    expect(reserved.counts).toEqual([first.length, second.length]);
    expect(effect.modes).toEqual(inventory.map((entry) => join(root, entry.path)));
    for (const entry of inventory) expectClosed(join(root, entry.path));
  });

  it('refuses exclusive overwrite before invoking the reader or accounting and preserves old bytes', async () => {
    const root = fixture();
    const path = join(root, 'existing');
    const retained = Buffer.from([0, 255, 9]);
    writeFileSync(path, retained);
    const before = statSync(path);
    const bundle = {
      calls: 0,
      readFile() {
        this.calls++;
        throw new Error('Reader must not be acquired before exclusive open.');
      },
    };
    const reserved = {
      counts: [] as number[],
      recordWritten(count: number) {
        this.counts.push(count);
      },
    };

    await expect(
      materializeWorkspaceBackupInventory(
        root,
        [
          { path: 'existing', mode: 0o600 },
          { path: 'later', mode: 0o600 },
        ],
        bundle,
        reserved
      )
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(readFileSync(path)).toEqual(retained);
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mode).toBe(before.mode);
    expect(bundle.calls).toBe(0);
    expect(reserved.counts).toEqual([]);
    expect(effect.modes).toEqual([]);
    expect(existsSync(join(root, 'later'))).toBe(false);
  });

  it('retains exact partial private output and closes without chmod when the reader fails', async () => {
    const root = fixture();
    const path = join(root, 'partial');
    const bytes = Uint8Array.from([0, 255, 128]);
    const failure = new Error('injected source iteration failure');
    const bundle = {
      calls: [] as string[],
      closed: 0,
      readFile(relative: string) {
        expect(this).toBe(bundle);
        expectOpened(join(root, relative));
        this.calls.push(relative);
        return (async function* () {
          try {
            yield bytes;
            throw failure;
          } finally {
            bundle.closed++;
          }
        })();
      },
    };
    const reserved = {
      counts: [] as number[],
      recordWritten(count: number) {
        this.counts.push(count);
      },
    };

    await expect(
      materializeWorkspaceBackupInventory(
        root,
        [
          { path: 'partial', mode: 0o755 },
          { path: 'later', mode: 0o600 },
        ],
        bundle,
        reserved
      )
    ).rejects.toBe(failure);

    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(bundle.calls).toEqual(['partial']);
    expect(bundle.closed).toBe(1);
    expect(reserved.counts).toEqual([bytes.length]);
    expect(effect.modes).toEqual([]);
    expect(existsSync(join(root, 'later'))).toBe(false);
    expectClosed(path);
  });

  it('closes the iterator and descriptor but keeps written bytes when accounting fails', async () => {
    const root = fixture();
    const path = join(root, 'accounted');
    const bytes = Uint8Array.from([0, 255, 4]);
    const failure = new Error('injected accounting failure');
    const bundle = {
      closed: 0,
      readFile(relative: string) {
        expect(this).toBe(bundle);
        expectOpened(join(root, relative));
        return (async function* () {
          try {
            yield bytes;
            yield Uint8Array.from([99]);
          } finally {
            bundle.closed++;
          }
        })();
      },
    };
    const reserved = {
      counts: [] as number[],
      recordWritten(count: number) {
        expect(this).toBe(reserved);
        expect(readFileSync(path)).toEqual(Buffer.from(bytes));
        expect(fstatSync(effect.opened.get(path)!).isFile()).toBe(true);
        this.counts.push(count);
        throw failure;
      },
    };

    await expect(
      materializeWorkspaceBackupInventory(
        root,
        [{ path: 'accounted', mode: 0o755 }],
        bundle,
        reserved
      )
    ).rejects.toBe(failure);

    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(reserved.counts).toEqual([bytes.length]);
    expect(bundle.closed).toBe(1);
    expect(effect.modes).toEqual([]);
    expectClosed(path);
  });

  it('finishes native short writes before accounting each complete chunk once', async () => {
    const root = fixture();
    const path = join(root, 'short-writes');
    const source = [Uint8Array.from([0, 255, 128, 13, 10]), Uint8Array.from([0, 254, 1])];
    effect.limit = 2;
    const bundle = {
      readFile(relative: string) {
        expect(this).toBe(bundle);
        expectOpened(join(root, relative));
        return chunks(source);
      },
    };
    const reserved = {
      counts: [] as number[],
      recordWritten(count: number) {
        expect(this).toBe(reserved);
        const completed = source
          .slice(0, this.counts.length + 1)
          .map((chunk) => Buffer.from(chunk));
        expect(readFileSync(path)).toEqual(Buffer.concat(completed));
        this.counts.push(count);
      },
    };

    await materializeWorkspaceBackupInventory(
      root,
      [{ path: 'short-writes', mode: 0o640 }],
      bundle,
      reserved
    );

    expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128, 13, 10, 0, 254, 1]));
    expect(reserved.counts).toEqual([5, 3]);
    expect(effect.writes.length).toBeGreaterThan(source.length);
    expect(effect.writes.every((count) => count > 0 && count <= 2)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expectClosed(path);
  });
});
