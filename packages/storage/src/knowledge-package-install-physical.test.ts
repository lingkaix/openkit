// openkit-test-platform: posix
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installKnowledgePackageFilesSync, removeKnowledgePackageFilesSync } from './local.js';

const fault = vi.hoisted(() => ({
  copy: undefined as string | undefined,
  mkdir: undefined as string | undefined,
  measure: undefined as string | undefined,
  remove: undefined as string | undefined,
  error: undefined as Error | undefined,
}));
// Only selected native faults change; all original bytes and failure residue stay real.
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  return {
    ...fs,
    mkdirSync(...args: Parameters<typeof fs.mkdirSync>) {
      if (String(args[0]) === fault.mkdir) throw fault.error;
      return fs.mkdirSync(...args);
    },
    copyFileSync(...args: Parameters<typeof fs.copyFileSync>) {
      if (String(args[1]) === fault.copy) {
        fs.writeFileSync(args[1], fs.readFileSync(args[0]).subarray(0, 3), { flag: 'wx' });
        throw fault.error;
      }
      return fs.copyFileSync(...args);
    },
    openSync(...args: Parameters<typeof fs.openSync>) {
      if (String(args[0]) === fault.measure) throw fault.error;
      return fs.openSync(...args);
    },
    rmSync(...args: Parameters<typeof fs.rmSync>) {
      if (String(args[0]) === fault.remove) throw fault.error;
      return fs.rmSync(...args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  fault.copy = fault.mkdir = fault.measure = fault.remove = undefined;
  fault.error = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 254]);
/** Real disposable originals and the caller's existing transient progress; no product rows are fabricated. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-knowledge-install-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const source = join(root, 'original');
  writeFileSync(source, bytes);
  const copied: string[] = [];
  const directories = new Set<string>();
  const capacity = {
    recorded: [] as number[],
    recordWritten(count: number) {
      expect(this).toBe(capacity);
      this.recorded.push(count);
    },
    release: vi.fn(),
  };
  return { root, workspace, source, copied, directories, capacity };
}

it('installs ordered exclusive originals with exact modes, shared ancestors and measured accounting', () => {
  const f = fixture();
  chmodSync(f.source, 0o640);
  const existing = join(f.workspace, 'existing');
  mkdirSync(existing, { mode: 0o750 });
  const originalMode = statSync(existing).mode & 0o777;
  const empty = join(f.root, 'empty');
  writeFileSync(empty, '');
  installKnowledgePackageFilesSync(
    f.workspace,
    new Map([
      ['new/deep/one', f.source],
      ['new/deep/two', f.source],
      ['existing/empty', empty],
    ]),
    f.copied,
    f.directories,
    f.capacity
  );
  const first = join(f.workspace, 'new/deep/one');
  expect(f.copied).toEqual([first, join(f.workspace, 'new/deep/two'), join(existing, 'empty')]);
  expect([...f.directories]).toEqual([join(f.workspace, 'new/deep'), join(f.workspace, 'new')]);
  expect(readFileSync(first)).toEqual(bytes);
  expect(readFileSync(f.copied[1]!)).toEqual(bytes);
  expect(readFileSync(f.copied[2]!)).toEqual(Buffer.alloc(0));
  expect(statSync(first).mode & 0o777).toBe(0o640);
  expect(statSync(dirname(first)).mode & 0o777).toBe(0o700 & ~process.umask());
  expect(statSync(existing).mode & 0o777).toBe(originalMode);
  expect(f.capacity.recorded).toEqual([bytes.length, bytes.length, 0]);
  expect(f.capacity.release).not.toHaveBeenCalled();
  expect(readFileSync(f.source)).toEqual(bytes);
});

it('keeps a refused exclusive target and compensates only the preceding copied prefix', () => {
  const f = fixture();
  const collision = join(f.workspace, 'collision');
  writeFileSync(collision, 'existing');
  expect(() =>
    installKnowledgePackageFilesSync(
      f.workspace,
      new Map([
        ['new/one', f.source],
        ['collision', f.source],
        ['later/absent', f.source],
      ]),
      f.copied,
      f.directories,
      f.capacity
    )
  ).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  expect(f.copied).toEqual([join(f.workspace, 'new/one')]);
  expect(f.capacity.recorded).toEqual([bytes.length]);
  expect(readFileSync(collision, 'utf8')).toBe('existing');
  removeKnowledgePackageFilesSync(f.copied, f.directories);
  expect(existsSync(join(f.workspace, 'new'))).toBe(false);
  expect(existsSync(join(f.workspace, 'later'))).toBe(false);
  expect(readFileSync(collision, 'utf8')).toBe('existing');
  expect(f.capacity.release).not.toHaveBeenCalled();
});

it('preserves an unrecorded native partial copy and the original cleanup error precedence', () => {
  const f = fixture();
  const target = join(f.workspace, 'new/deep/one');
  fault.copy = target;
  fault.error = new Error('Injected native partial copy');
  expect(() =>
    installKnowledgePackageFilesSync(
      f.workspace,
      new Map([['new/deep/one', f.source]]),
      f.copied,
      f.directories,
      f.capacity
    )
  ).toThrow(fault.error);
  expect(readFileSync(target)).toEqual(bytes.subarray(0, 3));
  expect(f.copied).toEqual([]);
  expect([...f.directories]).toEqual([dirname(target), join(f.workspace, 'new')]);
  expect(f.capacity.recorded).toEqual([]);
  expect(() => removeKnowledgePackageFilesSync(f.copied, f.directories)).toThrow(
    expect.objectContaining({ code: 'ENOTEMPTY' })
  );
  expect(readFileSync(target)).toEqual(bytes.subarray(0, 3));
  expect(f.capacity.release).not.toHaveBeenCalled();
});

it('keeps the original missing-directory inventory when native creation fails', () => {
  const f = fixture();
  const target = join(f.workspace, 'new/deep/one');
  fault.mkdir = dirname(target);
  fault.error = new Error('Injected native mkdir');
  expect(() =>
    installKnowledgePackageFilesSync(
      f.workspace,
      new Map([['new/deep/one', f.source]]),
      f.copied,
      f.directories,
      f.capacity
    )
  ).toThrow(fault.error);
  expect([...f.directories]).toEqual([dirname(target), join(f.workspace, 'new')]);
  expect(f.copied).toEqual([]);
  expect(f.capacity.recorded).toEqual([]);
  expect(existsSync(join(f.workspace, 'new'))).toBe(false);
});

it.each(['measurement', 'accounting'] as const)(
  'records completed bytes before a later %s failure',
  (kind) => {
    const f = fixture();
    const target = join(f.workspace, 'new/one');
    const error = new Error('Injected post-copy failure');
    if (kind === 'measurement') {
      fault.measure = target;
      fault.error = error;
    } else
      f.capacity.recordWritten = function (count: number) {
        expect(this).toBe(f.capacity);
        this.recorded.push(count);
        throw error;
      };
    expect(() =>
      installKnowledgePackageFilesSync(
        f.workspace,
        new Map([['new/one', f.source]]),
        f.copied,
        f.directories,
        f.capacity
      )
    ).toThrow(error);
    expect(f.copied).toEqual([target]);
    expect(readFileSync(target)).toEqual(bytes);
    expect(f.capacity.recorded).toEqual(kind === 'measurement' ? [] : [bytes.length]);
    fault.measure = undefined;
    removeKnowledgePackageFilesSync(f.copied, f.directories);
    expect(existsSync(join(f.workspace, 'new'))).toBe(false);
    expect(f.capacity.release).not.toHaveBeenCalled();
  }
);

it('removes files then deepest selected directories without removing existing parents or siblings', () => {
  const f = fixture();
  const top = join(f.workspace, 'top');
  const deep = join(top, 'long-child');
  mkdirSync(deep, { recursive: true });
  const a = join(top, 'a');
  const b = join(deep, 'b');
  writeFileSync(a, bytes);
  writeFileSync(b, bytes);
  const sibling = join(f.workspace, 'unselected');
  writeFileSync(sibling, bytes);
  removeKnowledgePackageFilesSync([a, b, join(top, 'already-absent')], new Set([top, deep]));
  expect(existsSync(top)).toBe(false);
  expect(readFileSync(sibling)).toEqual(bytes);
  expect(() => removeKnowledgePackageFilesSync([a, b], new Set([top, deep]))).toThrow(
    expect.objectContaining({ code: 'ENOENT' })
  );
});

it('stops selected cleanup at the first native file-removal failure', () => {
  const f = fixture();
  const first = join(f.workspace, 'first');
  const later = join(f.workspace, 'later');
  writeFileSync(first, bytes);
  writeFileSync(later, bytes);
  fault.remove = first;
  fault.error = new Error('Injected removal');
  expect(() => removeKnowledgePackageFilesSync([first, later], new Set())).toThrow(fault.error);
  expect(readFileSync(first)).toEqual(bytes);
  expect(readFileSync(later)).toEqual(bytes);
});
