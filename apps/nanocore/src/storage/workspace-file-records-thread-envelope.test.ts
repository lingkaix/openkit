// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRecordEnvelope } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

import { startGoalModeObjective } from '../goal-routes.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

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
      requiredFeatures: ['openkit.thread-entry.v1', 'openkit.thread-visibility.v1'],
      schemaVersion: 1,
      workspaceId: workspace.id,
    });
    expect(() =>
      parseRecordEnvelope(persisted.value, { supportedFeatures: ['openkit.thread-entry.v1'] })
    ).toThrow('Unsupported required feature: openkit.thread-visibility.v1');
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
    const workspace = store.ensureQuickChatWorkspace('user_local');
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
      'visibility',
      'privateOwnerUserId',
    ]) {
      delete legacy[field];
    }
    writeFileSync(persisted.path, `${JSON.stringify(legacy)}\n`);

    const restarted = new FsStore({ dataRoot });
    expect(restarted.getThread(workspace.id, thread.id)).toMatchObject({
      entryPath: 'conversation',
      visibility: 'private',
      privateOwnerUserId: 'user_local',
    });
    expect(threadRecord(dataRoot, workspace.id, thread.id).value).toMatchObject({
      entryPath: 'conversation',
      requiredFeatures: ['openkit.thread-entry.v1', 'openkit.thread-visibility.v1'],
      recordType: 'thread',
    });
  });
});

/** Removes only visibility-era metadata and recomputes the predecessor envelope digest. */
function predecessorRecord(value: Record<string, unknown>) {
  const predecessor = { ...value };
  delete predecessor.visibility;
  delete predecessor.privateOwnerUserId;
  predecessor.requiredFeatures = ['openkit.thread-entry.v1'];
  const { id, workspaceId, name, preview, status, entryPath, createdAt, updatedAt } = predecessor;
  predecessor.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify({ id, workspaceId, name, preview, status, entryPath, createdAt, updatedAt })).digest('hex')}`;
  return predecessor;
}

it('cuts over exclusively formal worker history but never publishes ambiguous project history', () => {
  for (const formal of [true, false]) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-project-cutover-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Cutover');
    const thread = store.createThread(workspace.id, 'Historical conversation');
    const turn = store.createTurn(workspace.id, thread.id, 'Work', {
      kind: 'user',
      id: 'user_local',
    });
    if (formal) store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    writeFileSync(persisted.path, JSON.stringify(predecessorRecord(persisted.value)));
    if (formal) {
      expect(new FsStore({ dataRoot }).getThread(workspace.id, thread.id)).toMatchObject({
        visibility: 'workspace',
      });
      expect(threadRecord(dataRoot, workspace.id, thread.id).value.requiredFeatures).toContain(
        'openkit.thread-visibility.v1'
      );
    } else {
      expect(() => new FsStore({ dataRoot })).toThrow(/ambiguous project history/);
      expect(threadRecord(dataRoot, workspace.id, thread.id).value.visibility).toBeUndefined();
    }
  }
});

it('rejects damaged current visibility instead of reclassifying it at restart', () => {
  for (const damage of [
    { visibility: undefined },
    { privateOwnerUserId: undefined },
    { visibility: 'workspace', privateOwnerUserId: 'user_other' },
  ]) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-damaged-visibility-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.ensureQuickChatWorkspace('user_local');
    const thread = store.createThread(workspace.id, 'Private conversation');
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    writeFileSync(persisted.path, JSON.stringify({ ...persisted.value, ...damage }));
    expect(() => new FsStore({ dataRoot })).toThrow();
  }
});

it('classifies a Goal Main Thread from its durable objective lineage', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-cutover-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Goal cutover');
  const thread = store.createThread(workspace.id, 'Formal Goal');
  try {
    startGoalModeObjective({
      triggerActor: { kind: 'user', id: 'user_local' },
      coreDb,
      assertProjectWorkspace: () => {},
      repositoryWorkspaceDb: (workspaceId) => {
        const db = openWorkspaceDb(dataRoot, workspaceId);
        applyScopedMigrations(db);
        return db;
      },
      store,
      workspaceId: workspace.id,
      threadId: thread.id,
      owningCommand: 'goal.start',
      requestId: '33333333-3333-4333-8333-333333333333',
      objective: 'Complete the formal Goal',
    });
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    writeFileSync(persisted.path, JSON.stringify(predecessorRecord(persisted.value)));
    expect(new FsStore({ dataRoot }).getThread(workspace.id, thread.id)).toMatchObject({
      visibility: 'workspace',
    });
  } finally {
    coreDb.sqlite.close();
  }
});

it('does not infer shared inception when formal and conversation Turns have tied timestamps', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-ambiguous-order-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Ambiguous order');
  const thread = store.createThread(workspace.id, 'Mixed history');
  const formal = store.createTurn(workspace.id, thread.id, 'Formal', {
    kind: 'user',
    id: 'user_local',
  });
  store.updateTurn(formal.id, { agentId: 'agent_codex_host' });
  const conversation = store.createTurn(workspace.id, thread.id, 'Conversation', {
    kind: 'user',
    id: 'user_local',
  });
  const conversationPath = join(
    dataRoot,
    'workspaces',
    workspace.id,
    'threads',
    thread.id,
    'turns',
    conversation.id,
    'turn.json'
  );
  const rawTurn = JSON.parse(readFileSync(conversationPath, 'utf8'));
  writeFileSync(conversationPath, JSON.stringify({ ...rawTurn, startedAt: formal.startedAt }));
  const persisted = threadRecord(dataRoot, workspace.id, thread.id);
  writeFileSync(persisted.path, JSON.stringify(predecessorRecord(persisted.value)));
  expect(() => new FsStore({ dataRoot })).toThrow(/ambiguous project history/);
});
