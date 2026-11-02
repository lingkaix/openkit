// openkit-test-platform: posix
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializePrivateTreeSync } from './local.js';

const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

/** Each fixture owns disposable bytes without a catalog record or publication authority. */
function fixture(): string {
  const parent = mkdtempSync(join(tmpdir(), 'storage-private-materialization-'));
  parents.push(parent);
  return join(parent, 'private');
}

// Characterizes private upload materialization, not immutable snapshot publication.
// NanoCore validates and hashes entries before this trusted physical operation.
describe('private tree materialization', () => {
  it('resets stale contents and preserves directories, exact bytes and executable mode', () => {
    const root = fixture();
    mkdirSync(join(root, 'stale', 'nested'), { recursive: true });
    writeFileSync(join(root, 'stale', 'nested', 'old'), 'discard');
    const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
    const script = Buffer.from('#!/bin/sh\nexit 0\n');

    materializePrivateTreeSync(root, [
      { kind: 0, path: 'empty-directory' },
      { content: binary, kind: 1, path: 'nested/data.bin' },
      { kind: 1, path: 'empty-file' },
      { content: script, kind: 2, path: 'bin/run' },
    ]);

    expect(readdirSync(root).sort()).toEqual(['bin', 'empty-directory', 'empty-file', 'nested']);
    expect(statSync(join(root, 'empty-directory')).isDirectory()).toBe(true);
    expect(readdirSync(join(root, 'empty-directory'))).toEqual([]);
    expect(readFileSync(join(root, 'nested', 'data.bin'))).toEqual(binary);
    expect(readFileSync(join(root, 'empty-file'))).toEqual(Buffer.alloc(0));
    expect(readFileSync(join(root, 'bin', 'run'))).toEqual(script);
    expect(statSync(join(root, 'bin', 'run')).mode & 0o7777).toBe(0o755);
  });

  it('creates missing root ancestors and clears an existing root for an empty tree', () => {
    const root = join(fixture(), 'nested', 'root');
    materializePrivateTreeSync(root, []);
    expect(statSync(root).isDirectory()).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(join(root, 'stale'), 'discard');

    materializePrivateTreeSync(root, []);

    expect(statSync(root).isDirectory()).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses overwrite and leaves partial output for caller-owned cleanup', () => {
    const root = fixture();
    const first = Buffer.from([0, 255, 1]);

    // A deliberate physical collision tests exclusive creation, not catalog validation.
    expect(() =>
      materializePrivateTreeSync(root, [
        { content: first, kind: 1, path: 'partial/file' },
        { content: Buffer.from('replacement'), kind: 1, path: 'partial/file' },
        { content: Buffer.from('late'), kind: 1, path: 'unwritten' },
      ])
    ).toThrowError(expect.objectContaining({ code: 'EEXIST' }));

    expect(statSync(root).isDirectory()).toBe(true);
    expect(readFileSync(join(root, 'partial', 'file'))).toEqual(first);
    expect(() => lstatSync(join(root, 'unwritten'))).toThrowError(
      expect.objectContaining({ code: 'ENOENT' })
    );
    rmSync(root, { recursive: true, force: true });
    expect(() => lstatSync(root)).toThrowError(expect.objectContaining({ code: 'ENOENT' }));
  });
});
