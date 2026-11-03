// openkit-test-platform: posix
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureWorkspaceLayoutRoot } from './fs-layout.js';

const effect = vi.hoisted(() => ({
  mkdirPath: '',
  failure: undefined as Error | undefined,
}));

// Compose the real NanoCore path selector and Storage helper; only the named native mkdir fails.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync(...args: Parameters<typeof actual.mkdirSync>) {
      if (String(args[0]) === effect.mkdirPath) throw effect.failure;
      return actual.mkdirSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  effect.mkdirPath = '';
  effect.failure = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Observe the original native failure through the real public layout boundary. */
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the Workspace layout operation to fail.');
}

// L2 covers the creation failure prefix not covered by the retained Store/layout link checks.
// The authorized physical MOVE keeps NanoCore's existing path selection and error propagation.
it('keeps earlier Workspace directories and never creates later paths after native mkdir refusal', () => {
  const parent = mkdtempSync(join(tmpdir(), 'nanocore-layout-directory-'));
  roots.push(parent);
  const sibling = join(parent, 'retained-sibling');
  const sentinel = Buffer.from([0, 255, 128, 13, 10]);
  writeFileSync(sibling, sentinel);
  const root = join(parent, 'new-parent', 'workspace');
  effect.mkdirPath = join(root, 'logs');
  effect.failure = new Error('injected Workspace logs directory creation refusal');

  expect(caught(() => ensureWorkspaceLayoutRoot(root))).toBe(effect.failure);

  expect(statSync(root).isDirectory()).toBe(true);
  expect(readdirSync(root).sort()).toEqual(['data', 'db', 'files']);
  for (const name of ['data', 'db', 'files']) {
    expect(statSync(join(root, name)).isDirectory()).toBe(true);
    expect(readdirSync(join(root, name))).toEqual([]);
  }
  expect(existsSync(join(root, 'logs'))).toBe(false);
  expect(readFileSync(sibling)).toEqual(sentinel);
  expect(readdirSync(parent).sort()).toEqual(['new-parent', 'retained-sibling']);
});
