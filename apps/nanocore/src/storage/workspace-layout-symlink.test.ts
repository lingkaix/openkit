import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';

describe('workspace layout symbolic-link boundaries', () => {
  it('rejects a linked workspace before inspecting its external records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-workspace-load-'));
    new FsStore({ dataRoot });
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-workspace-outside-'));
    const workspacesRoot = join(dataRoot, 'users', 'user_local', 'workspaces');

    writeFileSync(join(outsideRoot, 'store.json'), '{"external":true}\n');
    symlinkSync(outsideRoot, join(workspacesRoot, 'ws_linked'), 'dir');

    expect(() => new FsStore({ dataRoot })).toThrow(/symbolic link/i);
    expect(readdirSync(outsideRoot)).toEqual(['store.json']);
  });

  it.each([
    'logs',
    'evidence',
  ] as const)('rejects a linked workspace %s directory without creating outside children', (name) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-workspace-write-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Linked workspace write');
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', workspace.id);
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-linked-layout-outside-'));

    writeFileSync(join(outsideRoot, 'sentinel.txt'), 'untouched');
    rmSync(join(workspaceRoot, name), { recursive: true });
    symlinkSync(outsideRoot, join(workspaceRoot, name), 'dir');

    expect(() => store.updateWorkspace(workspace.id, { name: 'Must not escape' })).toThrow(
      /symbolic link/i
    );
    expect(readdirSync(outsideRoot)).toEqual(['sentinel.txt']);
  });
});
