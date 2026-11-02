// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retireWorkspaceSnapshotBytes } from './local.js';

const effect = vi.hoisted(() => ({
  directories: [] as string[],
  synchronized: [] as string[],
  descriptors: [] as number[],
  observe: undefined as ((path: string) => void) | undefined,
  failurePath: undefined as string | undefined,
  failure: undefined as Error | undefined,
}));

// Identify the actual directory descriptor by inode; only its native sync may fail.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync(descriptor: number) {
      const opened = actual.fstatSync(descriptor);
      const path = effect.directories.find((candidate) => {
        if (!actual.existsSync(candidate)) return false;
        const metadata = actual.statSync(candidate);
        return metadata.dev === opened.dev && metadata.ino === opened.ino;
      });
      if (!path) throw new Error('Unexpected directory synchronization in retirement fixture.');
      effect.synchronized.push(path);
      effect.descriptors.push(descriptor);
      effect.observe?.(path);
      if (path === effect.failurePath) throw effect.failure;
      actual.fsyncSync(descriptor);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  effect.directories.length = 0;
  effect.synchronized.length = 0;
  effect.descriptors.length = 0;
  effect.observe = undefined;
  effect.failurePath = undefined;
  effect.failure = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const generationBytes = Buffer.from([0, 255, 128, 13, 10]);
const sealBytes = Buffer.from('physical seal fixture\n');
const keptBytes = Buffer.from([0, 255, 1]);
const removedBytes = Buffer.from([0, 255, 2]);
const unlistedBytes = Buffer.from([0, 255, 3]);

/** Name real private object bytes independently of the retirement helper. */
function object(objects: string, bytes: Buffer): string {
  const name = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(objects, name), bytes);
  return name;
}

/** Own physical markers and bytes; these are not admitted manifests or retention decisions. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-snapshot-retirement-'));
  roots.push(root);
  const pool = join(root, 'pool');
  const objects = join(pool, 'objects');
  mkdirSync(objects, { recursive: true });
  const ids = ['expired-first', 'expired-second', 'retained'];
  const [first, second, retained] = ids.map((id) => join(pool, id));
  for (const path of [first!, second!, retained!]) {
    mkdirSync(path);
    writeFileSync(join(path, 'seal.json'), sealBytes);
    writeFileSync(join(path, 'payload.bin'), generationBytes);
  }
  const kept = object(objects, keptBytes);
  const removed = object(objects, removedBytes);
  const unlisted = object(objects, unlistedBytes);
  effect.directories.push(pool, objects, first!, second!, retained!);
  return {
    pool,
    objects,
    first: first!,
    second: second!,
    retained: retained!,
    expired: ids.slice(0, 2).map((backupId) => ({ manifest: { backupId } })),
    kept,
    removed,
    unlisted,
    names: [kept, removed],
    keep: new Set([`sha256:${kept}`]),
  };
}

/** Require unchanged error identity rather than matching an injected error's wording. */
function caught(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected snapshot retirement to fail.');
}

/** Native directory synchronization owns descriptor closure even after a sync refusal. */
function expectClosed() {
  for (const descriptor of effect.descriptors) {
    expect(() => fstatSync(descriptor)).toThrowError(expect.objectContaining({ code: 'EBADF' }));
  }
}

// Core Storage's hold-aware deletion and S51's Online Snapshot Policy leave selection in NanoCore.
// These tests prove only supplied physical retirement, synchronization order and failure residue.
describe('Workspace snapshot physical retirement', () => {
  it('retires selected exposure before objects and preserves kept, unlisted and retained bytes', () => {
    const f = fixture();
    effect.observe = (path) => {
      if (path === f.first || path === f.second) {
        expect(existsSync(join(path, 'seal.json'))).toBe(false);
        expect(readFileSync(join(path, 'payload.bin'))).toEqual(generationBytes);
        expect(readFileSync(join(f.objects, f.removed))).toEqual(removedBytes);
        if (path === f.first) expect(readFileSync(join(f.second, 'seal.json'))).toEqual(sealBytes);
        else expect(existsSync(f.first)).toBe(false);
      } else if (path === f.pool) {
        expect(existsSync(f.first)).toBe(false);
        expect(existsSync(f.second)).toBe(false);
        expect(readFileSync(join(f.objects, f.removed))).toEqual(removedBytes);
      } else if (path === f.objects) {
        expect(existsSync(join(f.objects, f.removed))).toBe(false);
        expect(readFileSync(join(f.objects, f.kept))).toEqual(keptBytes);
        expect(readFileSync(join(f.objects, f.unlisted))).toEqual(unlistedBytes);
      }
    };

    retireWorkspaceSnapshotBytes(f.pool, f.expired, f.objects, f.names, f.keep);

    expect(effect.synchronized).toEqual([f.first, f.second, f.pool, f.objects]);
    expect(readFileSync(join(f.retained, 'seal.json'))).toEqual(sealBytes);
    expect(readFileSync(join(f.retained, 'payload.bin'))).toEqual(generationBytes);
    expectClosed();
  });

  it('synchronizes objects even with no expired generations or supplied object names', () => {
    const f = fixture();

    retireWorkspaceSnapshotBytes(f.pool, [], f.objects, [], f.keep);

    expect(effect.synchronized).toEqual([f.objects]);
    expect(readFileSync(join(f.first, 'seal.json'))).toEqual(sealBytes);
    expect(readFileSync(join(f.second, 'seal.json'))).toEqual(sealBytes);
    expect(readFileSync(join(f.objects, f.removed))).toEqual(removedBytes);
    expectClosed();
  });

  it('leaves an unsealed generation and stops before later deletion when its sync fails', () => {
    const f = fixture();
    effect.failurePath = f.first;
    effect.failure = new Error('injected generation synchronization refusal');

    expect(
      caught(() => retireWorkspaceSnapshotBytes(f.pool, f.expired, f.objects, f.names, f.keep))
    ).toBe(effect.failure);

    expect(effect.synchronized).toEqual([f.first]);
    expect(existsSync(join(f.first, 'seal.json'))).toBe(false);
    expect(readFileSync(join(f.first, 'payload.bin'))).toEqual(generationBytes);
    expect(readFileSync(join(f.second, 'seal.json'))).toEqual(sealBytes);
    expect(readFileSync(join(f.objects, f.removed))).toEqual(removedBytes);
    expectClosed();
  });

  it('keeps all objects after pool sync refusal without restoring deleted generations', () => {
    const f = fixture();
    effect.failurePath = f.pool;
    effect.failure = new Error('injected pool synchronization refusal');

    expect(
      caught(() => retireWorkspaceSnapshotBytes(f.pool, f.expired, f.objects, f.names, f.keep))
    ).toBe(effect.failure);

    expect(effect.synchronized).toEqual([f.first, f.second, f.pool]);
    expect(existsSync(f.first)).toBe(false);
    expect(existsSync(f.second)).toBe(false);
    expect(readFileSync(join(f.objects, f.kept))).toEqual(keptBytes);
    expect(readFileSync(join(f.objects, f.removed))).toEqual(removedBytes);
    expect(readFileSync(join(f.objects, f.unlisted))).toEqual(unlistedBytes);
    expectClosed();
  });

  it('keeps earlier object deletion and stops on a native missing-object error without force', () => {
    const f = fixture();
    const missing = 'f'.repeat(64);

    expect(() =>
      retireWorkspaceSnapshotBytes(f.pool, [], f.objects, [f.removed, missing, f.unlisted], f.keep)
    ).toThrowError(expect.objectContaining({ code: 'ENOENT' }));

    expect(existsSync(join(f.objects, f.removed))).toBe(false);
    expect(readFileSync(join(f.objects, f.unlisted))).toEqual(unlistedBytes);
    expect(readFileSync(join(f.objects, f.kept))).toEqual(keptBytes);
    expect(readFileSync(join(f.first, 'seal.json'))).toEqual(sealBytes);
    expect(effect.synchronized).toEqual([]);
  });

  it('reports final object-sync failure after deletion without manufacturing rollback', () => {
    const f = fixture();
    effect.failurePath = f.objects;
    effect.failure = new Error('injected object synchronization refusal');

    expect(
      caught(() => retireWorkspaceSnapshotBytes(f.pool, f.expired, f.objects, f.names, f.keep))
    ).toBe(effect.failure);

    expect(effect.synchronized).toEqual([f.first, f.second, f.pool, f.objects]);
    expect(existsSync(f.first)).toBe(false);
    expect(existsSync(f.second)).toBe(false);
    expect(existsSync(join(f.objects, f.removed))).toBe(false);
    expect(readFileSync(join(f.objects, f.kept))).toEqual(keptBytes);
    expect(readFileSync(join(f.objects, f.unlisted))).toEqual(unlistedBytes);
    expectClosed();
  });
});
