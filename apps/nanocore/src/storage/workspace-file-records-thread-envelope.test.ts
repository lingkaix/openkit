// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRecordEnvelope } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

/** Seeds the recorded User that the predecessor audience classifier must resolve. */
function createOwnerBoundStore(dataRoot: string): FsStore {
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
  } finally {
    coreDb.sqlite.close();
  }
  return new FsStore({ dataRoot });
}

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
    const thread = store.createThread(
      workspace.id,
      'Envelope thread',
      undefined,
      'administration',
      { visibility: 'private', privateOwnerUserId: LOCAL_USER_ID }
    );
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
    const store = createOwnerBoundStore(dataRoot);
    const workspace = store.ensureQuickChatWorkspace(LOCAL_USER_ID);
    const thread = store.createThread(workspace.id, 'Cutover thread', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: LOCAL_USER_ID,
    });
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
      privateOwnerUserId: LOCAL_USER_ID,
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
      id: LOCAL_USER_ID,
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
    { visibility: 'workspace', privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
  ]) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-damaged-visibility-'));
    const store = createOwnerBoundStore(dataRoot);
    const workspace = store.ensureQuickChatWorkspace(LOCAL_USER_ID);
    const thread = store.createThread(
      workspace.id,
      'Private conversation',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: LOCAL_USER_ID,
      }
    );
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    writeFileSync(persisted.path, JSON.stringify({ ...persisted.value, ...damage }));
    expect(() => new FsStore({ dataRoot })).toThrow();
  }
});

it('does not infer shared inception when formal and conversation Turns have tied timestamps', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-ambiguous-order-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Ambiguous order');
  const thread = store.createThread(workspace.id, 'Mixed history');
  const formal = store.createTurn(workspace.id, thread.id, 'Formal', {
    kind: 'user',
    id: LOCAL_USER_ID,
  });
  store.updateTurn(formal.id, { agentId: 'agent_codex_host' });
  const conversation = store.createTurn(workspace.id, thread.id, 'Conversation', {
    kind: 'user',
    id: LOCAL_USER_ID,
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

it.each([
  { name: 'malformed Thread ID', field: 'id', value: 'thread_invalid' },
  {
    name: 'wrong-kind parent Thread ID',
    field: 'parentThreadId',
    value: LOCAL_USER_ID,
  },
  { name: 'self-parent Thread', field: 'parentThreadId', value: 'self' },
])('refuses a predecessor with $name without rewriting its bytes', ({ field, value }) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-invalid-thread-predecessor-'));
  try {
    const store = createOwnerBoundStore(dataRoot);
    const workspace = store.ensureQuickChatWorkspace(LOCAL_USER_ID);
    const thread = store.createThread(
      workspace.id,
      'Invalid predecessor',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: LOCAL_USER_ID,
      }
    );
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    const predecessor = {
      id: thread.id,
      workspaceId: workspace.id,
      name: thread.name,
      preview: thread.preview,
      status: thread.status,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      [field]: value === 'self' ? thread.id : value,
    };
    const bytes = `${JSON.stringify(predecessor)}\n`;
    writeFileSync(persisted.path, bytes);

    expect(() => new FsStore({ dataRoot })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ path: [field] })]),
      })
    );
    expect(readFileSync(persisted.path, 'utf8')).toBe(bytes);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('preserves predecessor administration entry and validates its original envelope before cutover', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-admin-thread-predecessor-'));
  try {
    const store = createOwnerBoundStore(dataRoot);
    const userId = LOCAL_USER_ID;
    const workspace = store.ensureQuickChatWorkspace(userId);
    const thread = store.createThread(
      workspace.id,
      'Administration predecessor',
      undefined,
      'administration',
      {
        visibility: 'private',
        privateOwnerUserId: userId,
      }
    );
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    const predecessor = predecessorRecord(persisted.value);
    for (const damage of [
      { contentDigest: `sha256:${'0'.repeat(64)}` },
      {
        lineage: { workspaceId: workspace.id, threadId: 'th_00000000-0000-7000-8000-000000000001' },
      },
    ]) {
      const bytes = `${JSON.stringify({ ...predecessor, ...damage })}\n`;
      writeFileSync(persisted.path, bytes);
      expect(() => new FsStore({ dataRoot })).toThrow(
        /content digest does not match|invalid ownership or lineage/
      );
      expect(readFileSync(persisted.path, 'utf8')).toBe(bytes);
    }
    writeFileSync(persisted.path, `${JSON.stringify(predecessor)}\n`);
    expect(new FsStore({ dataRoot }).getThread(workspace.id, thread.id)).toMatchObject({
      entryPath: 'administration',
      visibility: 'private',
      privateOwnerUserId: userId,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
