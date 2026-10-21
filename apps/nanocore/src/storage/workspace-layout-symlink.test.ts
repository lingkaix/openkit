// openkit-test-platform: posix
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { ensureWorkspaceLayout } from './fs-layout.js';

const roots: string[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace layout symbolic-link boundaries', () => {
  it('rejects a linked workspace before inspecting its external records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-workspace-load-'));
    roots.push(dataRoot);
    createTestStore({ dataRoot });
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-workspace-outside-'));
    roots.push(outsideRoot);
    const workspacesRoot = join(dataRoot, 'workspaces');

    writeFileSync(join(outsideRoot, 'store.json'), '{"external":true}\n');
    symlinkSync(
      outsideRoot,
      join(workspacesRoot, 'ws_00000000-0000-7e1c-a673-731dfd2cab6a'),
      'dir'
    );

    expect(() => new FsStore({ dataRoot })).toThrow(/symbolic link/i);
    expect(readdirSync(outsideRoot)).toEqual(['store.json']);
    expect(readFileSync(join(outsideRoot, 'store.json'), 'utf8')).toBe('{"external":true}\n');
  });

  it.each([
    'logs',
    'evidence',
  ] as const)('rejects a linked workspace %s directory without creating outside children', async (name) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-workspace-write-'));
    roots.push(dataRoot);
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Linked workspace write');
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-layout-outside-'));
    roots.push(outsideRoot);

    writeFileSync(join(outsideRoot, 'sentinel.txt'), 'untouched');
    rmSync(join(workspaceRoot, name), { recursive: true });
    symlinkSync(outsideRoot, join(workspaceRoot, name), 'dir');

    // Layout creation owns the logs/evidence child writes; native Workspace metadata no longer does.
    expect(() => ensureWorkspaceLayout(dataRoot, workspace.id)).toThrow(/symbolic link/i);
    expect(readdirSync(outsideRoot)).toEqual(['sentinel.txt']);
    expect(readFileSync(join(outsideRoot, 'sentinel.txt'), 'utf8')).toBe('untouched');
  });
});
