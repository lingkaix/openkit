// openkit-test-platform: posix
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { readPublishedTurnFileRecords } from '../storage/workspace-file-records.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';

it.each([
  'workspace',
  'thread',
  'turn',
] as const)('keeps native Turn authority after redirecting the %s directory', async (boundary) => {
  const root = mkdtempSync(join(tmpdir(), 'recurring-parent-'));
  const outside = mkdtempSync(join(tmpdir(), 'recurring-parent-outside-'));
  try {
    const store = createTestStore({ dataRoot: root });
    const workspace = await store.createWorkspace('Canonical source');
    const thread = await store.createThread(workspace.id, 'Target');
    const turn = await store.createTurn(workspace.id, thread.id, 'Retain exact bytes', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    expect(readPublishedTurnFileRecords(root, workspace.id, thread.id, turn.id)?.turn.id).toBe(
      turn.id
    );
    await shutdownControlStoreWorkerClient();
    const workspacePath = join(root, 'workspaces', workspace.id);
    const threadPath = join(workspacePath, 'threads', thread.id);
    const turnPath = join(threadPath, 'turns', turn.id);
    const source =
      boundary === 'workspace' ? workspacePath : boundary === 'thread' ? threadPath : turnPath;
    const target = join(outside, 'retained');
    if (boundary === 'workspace') renameSync(source, target);
    else {
      mkdirSync(dirname(source), { recursive: true });
      mkdirSync(target);
    }
    const sentinel = join(target, 'outside.json');
    const bytes = JSON.stringify({ ...turn, agentId: 'outside-agent' });
    writeFileSync(sentinel, bytes);
    symlinkSync(target, source, 'dir');
    // SQL scope redirection fails closed; retired Thread/Turn directories grant no authority.
    if (boundary === 'workspace')
      expect(() => readPublishedTurnFileRecords(root, workspace.id, thread.id, turn.id)).toThrow();
    else
      expect(readPublishedTurnFileRecords(root, workspace.id, thread.id, turn.id)?.turn).toEqual(
        turn
      );
    expect(readFileSync(sentinel, 'utf8')).toBe(bytes);
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
