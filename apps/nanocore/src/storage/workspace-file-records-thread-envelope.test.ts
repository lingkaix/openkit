// openkit-test-platform: posix
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';

/** Reads one persisted Thread record from an isolated store. */
function threadRecord(dataRoot: string, workspaceId: string, threadId: string) {
  const path = join(dataRoot, 'workspaces', workspaceId, 'threads', threadId, 'thread.json');
  return {
    path,
    value: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
  };
}

describe('Thread canonical record envelope', () => {
  it('writes entryPath behind its required feature and rejects unsupported Thread semantics', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-envelope-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Envelope workspace');
    const thread = store.createThread(workspace.id, 'Envelope thread', undefined, 'administration');
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);

    expect(persisted.value).toMatchObject({
      entryPath: 'administration',
      id: thread.id,
      ownerScope: 'workspace',
      recordType: 'thread',
      requiredFeatures: ['openkit.thread-entry.v1'],
      schemaVersion: 1,
      workspaceId: workspace.id,
    });
    expect(persisted.value.lineage).toEqual({
      threadId: thread.id,
      workspaceId: workspace.id,
    });

    writeFileSync(
      persisted.path,
      `${JSON.stringify({
        ...persisted.value,
        requiredFeatures: ['openkit.thread-entry.v1', 'workspace.mount.fuse'],
      })}\n`
    );
    expect(() => new FsStore({ dataRoot })).toThrow(
      'Unsupported required feature: workspace.mount.fuse'
    );
  });

  it('classifies a pre-envelope Thread as conversation and rewrites the gated envelope', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-cutover-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Cutover workspace');
    const thread = store.createThread(workspace.id, 'Cutover thread');
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    const legacy = { ...persisted.value };
    for (const field of [
      'contentDigest',
      'entryPath',
      'extensions',
      'lineage',
      'ownerScope',
      'recordType',
      'redactionLevel',
      'requiredFeatures',
      'schemaVersion',
      'sensitivity',
    ]) {
      delete legacy[field];
    }
    writeFileSync(persisted.path, `${JSON.stringify(legacy)}\n`);

    const restarted = new FsStore({ dataRoot });
    expect(restarted.getThread(workspace.id, thread.id).entryPath).toBe('conversation');
    expect(threadRecord(dataRoot, workspace.id, thread.id).value).toMatchObject({
      entryPath: 'conversation',
      requiredFeatures: ['openkit.thread-entry.v1'],
      recordType: 'thread',
    });
  });
});
