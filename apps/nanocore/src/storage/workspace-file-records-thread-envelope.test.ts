// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecordEnvelope } from '@openkit/config-schema';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { FsStore } from '../lib/store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

/** Seeds the recorded User for current private Thread authority checks. */
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

/**
 * Validates one retained fault in a fresh admission lifetime without resetting process state.
 *
 * Copies exact authority, seeds an independent healthy sibling, and checks refusal and preservation.
 * Each copy has a new root identity, so later faults cannot reuse an earlier refusal.
 *
 * @param dataRoot Source fixture containing the injected fault.
 * @param workspaceId Owning Workspace that must be quarantined.
 * @returns Reopened Store and isolated root for additional native readback checks.
 */
function expectLocalWorkspaceRefusal(dataRoot: string, workspaceId: string) {
  const restartRoot = mkdtempSync(join(tmpdir(), 'openkit-local-refusal-'));
  onTestFinished(() => rmSync(restartRoot, { recursive: true, force: true }));
  const seed = new FsStore({ dataRoot: restartRoot });
  const sibling = seed.createWorkspace('Healthy refusal control');
  const siblingThread = seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Records every directory, link target and file byte, including the absence of deleted entries. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else {
          entries[key] = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
        }
      }
    };
    visit(root);
    return entries;
  }

  const refusedRoot = join(restartRoot, 'workspaces', workspaceId);
  const before = snapshot(refusedRoot);
  const reopened = new FsStore({ dataRoot: restartRoot });
  expect(scopeAdmissionFailures(restartRoot)).toContainEqual(
    expect.objectContaining({ scope: 'workspace', id: workspaceId })
  );
  expect(() => reopened.getWorkspace(workspaceId)).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(() => reopened.createThread(workspaceId, 'Must remain refused')).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(reopened.getWorkspace(sibling.id)).toEqual(siblingBefore);
  expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
  const progress = reopened.createThread(sibling.id, 'Healthy sibling progress');
  expect(new FsStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
    progress
  );
  expect(snapshot(refusedRoot)).toEqual(before);
  expect(snapshot(join(dataRoot, 'workspaces', workspaceId))).toEqual(before);
  return { store: reopened, dataRoot: restartRoot };
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
    expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  });

  it('refuses a pre-envelope Thread without rewriting its bytes after the reset boundary', () => {
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

    const bytes = readFileSync(persisted.path, 'utf8');
    expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(readFileSync(persisted.path, 'utf8')).toBe(bytes);
  });
});

/** Removes only visibility-era metadata and recomputes the predecessor envelope digest. */
function predecessorRecord(value: Record<string, unknown>) {
  const predecessor = { ...value };
  delete predecessor.visibility;
  delete predecessor.privateOwnerUserId;
  delete predecessor.threadSource;
  delete predecessor.parentThreadId;
  predecessor.requiredFeatures = ['openkit.thread-entry.v1'];
  const { id, owner, name, preview, status, entryPath, createdAt, updatedAt } = predecessor;
  predecessor.contentDigest = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        id,
        owner,
        name,
        preview,
        status,
        entryPath,
        createdAt,
        updatedAt,
      })
    )
    .digest('hex')}`;
  return predecessor;
}

it('refuses predecessor envelopes for both formal and conversation history without publication', () => {
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
    const bytes = readFileSync(persisted.path, 'utf8');
    expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(readFileSync(persisted.path, 'utf8')).toBe(bytes);
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
    expectLocalWorkspaceRefusal(dataRoot, workspace.id);
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
  expectLocalWorkspaceRefusal(dataRoot, workspace.id);
});

it.each([
  { name: 'malformed Thread ID', field: 'id', value: 'thread_invalid' },
  {
    name: 'wrong-kind parent Thread ID',
    field: 'parentThreadId',
    value: LOCAL_USER_ID,
  },
  { name: 'self-parent Thread', field: 'parentThreadId', value: 'self' },
])('refuses a current record with $name without rewriting its bytes', ({ field, value }) => {
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
      ...persisted.value,
      [field]: value === 'self' ? thread.id : value,
    };
    const bytes = `${JSON.stringify(predecessor)}\n`;
    writeFileSync(persisted.path, bytes);

    expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(readFileSync(persisted.path, 'utf8')).toBe(bytes);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('preserves current administration entry and validates its envelope without rewriting', () => {
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
    const predecessor = persisted.value;
    for (const damage of [
      { contentDigest: `sha256:${'0'.repeat(64)}` },
      {
        lineage: { workspaceId: workspace.id, threadId: 'th_00000000-0000-7000-8000-000000000001' },
      },
    ]) {
      const bytes = `${JSON.stringify({ ...predecessor, ...damage })}\n`;
      writeFileSync(persisted.path, bytes);
      expectLocalWorkspaceRefusal(dataRoot, workspace.id);
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
