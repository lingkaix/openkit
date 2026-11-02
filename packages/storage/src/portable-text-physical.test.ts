// openkit-test-platform: posix
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
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
import { writePortableTextFile } from './local.js';

const fault = vi.hoisted(() => ({
  descriptor: undefined as number | undefined,
  write: undefined as Error | undefined,
  removal: undefined as Error | undefined,
  availability: undefined as Error | undefined,
}));

// Only descriptor-write and removal faults change; files and descriptor checks remain real.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (typeof args[0] === 'number') {
        fault.descriptor = args[0];
        if (fault.write) {
          actual.writeSync(args[0], Buffer.from(String(args[1]), 'utf8').subarray(0, 3));
          throw fault.write;
        }
      }
      return actual.writeFileSync(...args);
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      if (fault.removal) throw fault.removal;
      return actual.rmSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.descriptor = undefined;
  fault.write = undefined;
  fault.removal = undefined;
  fault.availability = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Own only disposable physical text, without a Workspace record or publication receipt. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-portable-text-'));
  roots.push(root);
  return { root, path: join(root, 'retained.txt') };
}

/** Observe the original reservation method boundary without supplying admission authority. */
function reservation(path: string) {
  const value = {
    events: [] as string[],
    written: 0,
    released: 0,
    presentAtRelease: undefined as boolean | undefined,
    recordWritten(count: number) {
      expect(this).toBe(value);
      expect(fault.descriptor).toBeTypeOf('number');
      expect(fstatSync(fault.descriptor!).isFile()).toBe(true);
      this.events.push('record');
      this.written += count;
    },
    assertAvailable() {
      expect(this).toBe(value);
      expect(() => fstatSync(fault.descriptor!)).toThrowError(
        expect.objectContaining({ code: 'EBADF' })
      );
      this.events.push('assert');
      if (fault.availability) throw fault.availability;
    },
    release() {
      expect(this).toBe(value);
      this.events.push('release');
      this.released++;
      this.presentAtRelease = existsSync(path);
    },
  };
  return value;
}

// Core Storage / SQLite Layers shares physical primitives without moving authority.
// S51's exact retained files remain unchanged; this stages text and proves no durable publication.
describe('portable text physical write', () => {
  it('writes exact UTF-8 bytes privately and records before close, then checks and releases', () => {
    const { path, root } = fixture();
    const content = ' \u00e9\r\n\u{1f4e6}\0\n';
    const bytes = Buffer.from([32, 195, 169, 13, 10, 240, 159, 147, 166, 0, 10]);
    const capacity = reservation(path);

    writePortableTextFile(path, content, false, bytes.length, capacity);

    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(['retained.txt']);
    expect(capacity.written).toBe(bytes.length);
    expect(capacity.events).toEqual(['record', 'assert', 'release']);
    expect(capacity.released).toBe(1);
    expect(capacity.presentAtRelease).toBe(true);
  });

  it('truncates an admitted existing file in place without changing its mode', () => {
    const { path } = fixture();
    writeFileSync(path, 'a much longer original text with a retained suffix');
    chmodSync(path, 0o640);
    const before = statSync(path);

    writePortableTextFile(path, 'short\r\n', true, 7);

    const after = statSync(path);
    expect(readFileSync(path)).toEqual(Buffer.from('short\r\n'));
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
  });

  it('refuses exclusive overwrite and a target link without removing or changing retained bytes', () => {
    const { path, root } = fixture();
    const original = Buffer.from([0, 255, 128, 13, 10]);
    writeFileSync(path, original);
    const capacity = reservation(path);

    expect(() => writePortableTextFile(path, 'new', false, 3, capacity)).toThrow();

    expect(readFileSync(path)).toEqual(original);
    expect(capacity.events).toEqual(['release']);
    expect(capacity.presentAtRelease).toBe(true);
    const link = join(root, 'linked.txt');
    symlinkSync(path, link);
    const linkCapacity = reservation(link);

    expect(() => writePortableTextFile(link, 'new', true, 3, linkCapacity)).toThrow();

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(path)).toEqual(original);
    expect(linkCapacity.events).toEqual(['release']);
    expect(linkCapacity.presentAtRelease).toBe(true);
  });

  it('closes a partially written file and removes only that opened output before release', () => {
    const { path, root } = fixture();
    const sibling = join(root, 'retained-sibling');
    writeFileSync(sibling, 'keep');
    const capacity = reservation(path);
    fault.write = new Error('injected partial text write failure');

    expect(() => writePortableTextFile(path, 'partial text', false, 12, capacity)).toThrow(
      fault.write
    );

    expect(() => fstatSync(fault.descriptor!)).toThrowError(
      expect.objectContaining({ code: 'EBADF' })
    );
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(sibling, 'utf8')).toBe('keep');
    expect(capacity.written).toBe(0);
    expect(capacity.events).toEqual(['release']);
    expect(capacity.presentAtRelease).toBe(false);
  });

  it('retains the reservation and inspectable partial bytes when output cleanup fails', () => {
    const { path } = fixture();
    const capacity = reservation(path);
    fault.write = new Error('injected partial text write failure');
    fault.removal = new Error('injected text cleanup failure');

    expect(() => writePortableTextFile(path, 'partial text', false, 12, capacity)).toThrow(
      fault.removal
    );

    expect(readFileSync(path)).toEqual(Buffer.from('par'));
    expect(() => fstatSync(fault.descriptor!)).toThrowError(
      expect.objectContaining({ code: 'EBADF' })
    );
    expect(capacity.written).toBe(0);
    expect(capacity.released).toBe(0);
    expect(capacity.events).toEqual([]);
  });

  it('removes closed output before release when the original availability check refuses', () => {
    const { path } = fixture();
    const capacity = reservation(path);
    fault.availability = new Error('injected capacity refusal');

    expect(() => writePortableTextFile(path, 'exact text', false, 10, capacity)).toThrow(
      fault.availability
    );

    expect(capacity.written).toBe(10);
    expect(capacity.events).toEqual(['record', 'assert', 'release']);
    expect(capacity.released).toBe(1);
    expect(capacity.presentAtRelease).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
