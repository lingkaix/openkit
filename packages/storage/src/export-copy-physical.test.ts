// openkit-test-platform: posix
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPortableOriginalFile } from './local.js';

const fault = vi.hoisted(() => ({
  copy: undefined as Error | undefined,
  removal: undefined as Error | undefined,
  record: undefined as Error | undefined,
}));

// Only the native copy and removal fault sites change; bytes and paths remain real.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    copyFileSync(...args: Parameters<typeof actual.copyFileSync>) {
      if (fault.copy) {
        actual.writeFileSync(args[1], actual.readFileSync(args[0]).subarray(0, 3), { flag: 'wx' });
        throw fault.copy;
      }
      return actual.copyFileSync(...args);
    },
    rmSync(...args: Parameters<typeof actual.rmSync>) {
      if (fault.removal) throw fault.removal;
      return actual.rmSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.copy = undefined;
  fault.removal = undefined;
  fault.record = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const original = Buffer.from([0, 255, 128, 13, 10, 0, 254]);

/** Own disposable source and unpublished export bytes without a manifest or authority record. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-export-copy-'));
  roots.push(root);
  const source = join(root, 'original.bin');
  const target = join(root, 'export.bin');
  writeFileSync(source, original);
  return { root, source, target };
}

/** Observe the concrete method receiver and output lifetime without modeling capacity admission. */
function reservation(target: string) {
  const value = {
    events: [] as string[],
    recorded: [] as number[],
    presentAtRelease: undefined as boolean | undefined,
    recordWritten(count: number) {
      expect(this).toBe(value);
      expect(readFileSync(target)).toEqual(original);
      this.events.push('record');
      this.recorded.push(count);
      if (fault.record) throw fault.record;
    },
    release() {
      expect(this).toBe(value);
      this.events.push('release');
      this.presentAtRelease = existsSync(target);
    },
  };
  return value;
}

// S51 / File Payload And Representation Coverage requires exact original bytes.
// Failure residue characterizes copyPortableOriginal's caller-owned unpublished export only.
describe('portable original physical copy', () => {
  it('copies exact binary bytes before accounting and release, with an optional reservation', () => {
    const { root, source, target } = fixture();
    const capacity = reservation(target);

    copyPortableOriginalFile(source, target, original.length, capacity);
    const unreserved = join(root, 'unreserved.bin');
    copyPortableOriginalFile(source, unreserved, original.length);

    expect(readFileSync(target)).toEqual(original);
    expect(readFileSync(unreserved)).toEqual(original);
    expect(readFileSync(source)).toEqual(original);
    expect(capacity.events).toEqual(['record', 'release']);
    expect(capacity.recorded).toEqual([original.length]);
    expect(capacity.presentAtRelease).toBe(true);
  });

  it('retains the native exclusive-copy error and removes the existing unpublished target before release', () => {
    const { source, target } = fixture();
    writeFileSync(target, 'old unpublished output');
    const capacity = reservation(target);

    // The original catch removes the target even when exclusive copy never opened it.
    expect(() => copyPortableOriginalFile(source, target, original.length, capacity)).toThrowError(
      expect.objectContaining({ code: 'EEXIST' })
    );

    expect(readFileSync(source)).toEqual(original);
    expect(existsSync(target)).toBe(false);
    expect(capacity.recorded).toEqual([]);
    expect(capacity.events).toEqual(['release']);
    expect(capacity.presentAtRelease).toBe(false);
  });

  it('removes a partial native-copy output before release and preserves unrelated bytes', () => {
    const { root, source, target } = fixture();
    const sibling = join(root, 'retained-sibling');
    writeFileSync(sibling, 'keep');
    const capacity = reservation(target);
    fault.copy = new Error('injected incomplete native copy');

    expect(() => copyPortableOriginalFile(source, target, original.length, capacity)).toThrow(
      fault.copy
    );

    expect(readdirSync(root).sort()).toEqual(['original.bin', 'retained-sibling']);
    expect(readFileSync(sibling, 'utf8')).toBe('keep');
    expect(readFileSync(source)).toEqual(original);
    expect(capacity.recorded).toEqual([]);
    expect(capacity.events).toEqual(['release']);
    expect(capacity.presentAtRelease).toBe(false);
  });

  it('retains partial evidence and reservation when cleanup fails, exposing the cleanup error', () => {
    const { source, target } = fixture();
    const capacity = reservation(target);
    fault.copy = new Error('injected incomplete native copy');
    fault.removal = new Error('injected cleanup refusal');

    expect(() => copyPortableOriginalFile(source, target, original.length, capacity)).toThrow(
      fault.removal
    );

    expect(readFileSync(target)).toEqual(Buffer.from([0, 255, 128]));
    expect(readFileSync(source)).toEqual(original);
    expect(capacity.recorded).toEqual([]);
    expect(capacity.events).toEqual([]);
    expect(capacity.presentAtRelease).toBeUndefined();
  });

  it('removes completed output before release when the original accounting method fails', () => {
    const { source, target } = fixture();
    const capacity = reservation(target);
    fault.record = new Error('injected accounting refusal');

    expect(() => copyPortableOriginalFile(source, target, original.length, capacity)).toThrow(
      fault.record
    );

    expect(readFileSync(source)).toEqual(original);
    expect(existsSync(target)).toBe(false);
    expect(capacity.recorded).toEqual([original.length]);
    expect(capacity.events).toEqual(['record', 'release']);
    expect(capacity.presentAtRelease).toBe(false);
  });
});
