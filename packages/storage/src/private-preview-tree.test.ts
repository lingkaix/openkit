// openkit-test-platform: posix
import {
  existsSync,
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
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPrivateTreeSync, removePrivateTreeSync } from './local.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('isolates same-prefix private roots and removes only the selected nested tree', () => {
  // MCP preview scratch must be unique; retained siblings and linked targets are not cleanup targets.
  const parent = mkdtempSync(join(tmpdir(), 'storage-private-preview-'));
  roots.push(parent);
  const first = createPrivateTreeSync(parent, 'preview-');
  const second = createPrivateTreeSync(parent, 'preview-');
  const retained = join(parent, 'retained-catalog');
  mkdirSync(retained);
  const original = Buffer.from([0, 255, 128, 13, 10]);
  writeFileSync(join(retained, 'catalog'), original);

  expect(first).not.toBe(second);
  for (const root of [first, second]) {
    expect(dirname(root)).toBe(parent);
    expect(basename(root).startsWith('preview-')).toBe(true);
    expect(statSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readdirSync(root)).toEqual([]);
  }
  mkdirSync(join(first, 'nested', 'child'), { recursive: true });
  writeFileSync(join(first, 'nested', 'child', 'private'), 'first preview');
  writeFileSync(join(second, 'private'), 'second preview');
  symlinkSync(retained, join(first, 'retained-link'), 'dir');

  removePrivateTreeSync(first);

  expect(existsSync(first)).toBe(false);
  expect(readFileSync(join(second, 'private'), 'utf8')).toBe('second preview');
  expect(readFileSync(join(retained, 'catalog'))).toEqual(original);
  expect(readdirSync(retained)).toEqual(['catalog']);
  removePrivateTreeSync(first);
  expect(readFileSync(join(second, 'private'), 'utf8')).toBe('second preview');
  expect(readFileSync(join(retained, 'catalog'))).toEqual(original);
});
