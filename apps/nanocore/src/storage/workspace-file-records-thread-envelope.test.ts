// openkit-test-platform: posix
import { cpSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { FsStore } from '../lib/store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
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

/** Reads and explicitly corrupts the native retained Thread payload, never a readable projection. */
function threadRecord(dataRoot: string, workspaceId: string, threadId: string) {
  const read = () => {
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      return (
        db.sqlite.prepare('SELECT record_json FROM control_threads WHERE id=?').get(threadId) as {
          record_json: string;
        }
      ).record_json;
    } finally {
      db.sqlite.close();
    }
  };
  return {
    value: JSON.parse(read()) as Record<string, unknown>,
    read,
    async write(value: Record<string, unknown>) {
      await shutdownControlStoreWorkerClient();
      const db = openWorkspaceDb(dataRoot, workspaceId);
      try {
        db.sqlite
          .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
          .run(JSON.stringify(value), threadId);
      } finally {
        db.sqlite.close();
      }
    },
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
async function expectLocalWorkspaceRefusal(dataRoot: string, workspaceId: string) {
  const restartRoot = mkdtempSync(join(tmpdir(), 'openkit-local-refusal-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    return rmSync(restartRoot, { recursive: true, force: true });
  });
  const seed = createTestStore({ dataRoot: restartRoot });
  const sibling = await seed.createWorkspace('Healthy refusal control');
  const siblingThread = await seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  // Exclude the live native writer before copying its SQLite authority.
  await shutdownControlStoreWorkerClient();
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Preserves raw native SQL schema/values and exact other bytes; WAL/SHM are bookkeeping. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else if (entry.isSymbolicLink()) {
          entries[key] = `link:${readlinkSync(path)}`;
        } else if (key === join('db', 'workspace.sqlite')) {
          const sqlite = new Database(path, { readonly: true, fileMustExist: true });
          try {
            entries[key] = sqlite.transaction(() => {
              const schema = sqlite
                .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
                .all();
              const tables = sqlite
                .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
                .all() as { name: string }[];
              const rows = tables.map(({ name }) => [
                name,
                sqlite
                  .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                  .raw(true)
                  .safeIntegers(true)
                  .all()
                  .map((row) =>
                    JSON.stringify(row, (_key, value) =>
                      typeof value === 'bigint' ? { integer: value.toString() } : value
                    )
                  )
                  .sort(),
              ]);
              return Buffer.from(JSON.stringify({ schema, rows }));
            })();
          } finally {
            sqlite.close();
          }
        } else if (
          key !== join('db', 'workspace.sqlite-wal') &&
          key !== join('db', 'workspace.sqlite-shm')
        ) {
          entries[key] = readFileSync(path);
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
  await expect(reopened.createThread(workspaceId, 'Must remain refused')).rejects.toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(reopened.getWorkspace(sibling.id)).toEqual(siblingBefore);
  expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
  const progress = await reopened.createThread(sibling.id, 'Healthy sibling progress');
  expect(new FsStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
    progress
  );
  expect(snapshot(refusedRoot)).toEqual(before);
  expect(snapshot(join(dataRoot, 'workspaces', workspaceId))).toEqual(before);
  return { store: reopened, dataRoot: restartRoot };
}

describe('Thread canonical record envelope', () => {
  it('retains explicit entry and visibility and rejects unsupported required Thread semantics', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-envelope-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Envelope workspace');
    const thread = await store.createThread(
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
      visibility: 'private',
      privateOwnerUserId: LOCAL_USER_ID,
      schemaVersion: 1,
      owner: { kind: 'workspace', workspaceId: workspace.id },
    });
    await persisted.write({
      ...persisted.value,
      requiredFeatures: ['workspace.mount.fuse'],
    });
    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  });

  it('refuses a pre-envelope Thread without rewriting its bytes after the reset boundary', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-cutover-'));
    const store = createOwnerBoundStore(dataRoot);
    const workspace = await store.ensureQuickChatWorkspace(LOCAL_USER_ID);
    const thread = await store.createThread(
      workspace.id,
      'Cutover thread',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: LOCAL_USER_ID,
      }
    );
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
    await persisted.write(legacy);

    const bytes = persisted.read();
    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(persisted.read()).toBe(bytes);
  });
});

/** Removes required native visibility metadata without inventing a replacement audience. */
function predecessorRecord(value: Record<string, unknown>) {
  const predecessor = { ...value };
  delete predecessor.visibility;
  delete predecessor.privateOwnerUserId;
  return predecessor;
}

it('refuses predecessor envelopes for both formal and conversation history without publication', async () => {
  for (const formal of [true, false]) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-project-cutover-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Cutover');
    const thread = await store.createThread(workspace.id, 'Historical conversation');
    const turn = await store.createTurn(workspace.id, thread.id, 'Work', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    if (formal) await store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    const persisted = threadRecord(dataRoot, workspace.id, thread.id);
    await persisted.write(predecessorRecord(persisted.value));
    const bytes = persisted.read();
    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(persisted.read()).toBe(bytes);
  }
});

it('rejects damaged current visibility instead of reclassifying it at restart', async () => {
  for (const damage of [
    { visibility: undefined },
    { privateOwnerUserId: undefined },
    { visibility: 'workspace', privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
  ]) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-damaged-visibility-'));
    const store = createOwnerBoundStore(dataRoot);
    const workspace = await store.ensureQuickChatWorkspace(LOCAL_USER_ID);
    const thread = await store.createThread(
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
    await persisted.write({ ...persisted.value, ...damage });
    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  }
});

it('does not infer shared inception when formal and conversation Turns have tied timestamps', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-ambiguous-order-'));
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Ambiguous order');
  const thread = await store.createThread(workspace.id, 'Mixed history');
  const formal = await store.createTurn(workspace.id, thread.id, 'Formal', {
    kind: 'user',
    id: LOCAL_USER_ID,
  });
  await store.updateTurn(formal.id, { agentId: 'agent_codex_host' });
  await store.completeTurn(formal.id, { status: 'completed', completedAt: formal.startedAt });
  const conversation = await store.createTurn(workspace.id, thread.id, 'Conversation', {
    kind: 'user',
    id: LOCAL_USER_ID,
  });
  await shutdownControlStoreWorkerClient();
  const db = openWorkspaceDb(dataRoot, workspace.id);
  try {
    const row = db.sqlite
      .prepare('SELECT record_json FROM control_turns WHERE id=?')
      .get(conversation.id) as { record_json: string };
    db.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(
        JSON.stringify({ ...JSON.parse(row.record_json), startedAt: formal.startedAt }),
        conversation.id
      );
  } finally {
    db.sqlite.close();
  }
  const persisted = threadRecord(dataRoot, workspace.id, thread.id);
  await persisted.write(predecessorRecord(persisted.value));
  await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
});

it.each([
  { name: 'malformed Thread ID', field: 'id', value: 'thread_invalid' },
  {
    name: 'wrong-kind parent Thread ID',
    field: 'parentThreadId',
    value: LOCAL_USER_ID,
  },
  { name: 'self-parent Thread', field: 'parentThreadId', value: 'self' },
])('refuses a current record with $name without rewriting its bytes', async ({ field, value }) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-invalid-thread-predecessor-'));
  try {
    const store = createOwnerBoundStore(dataRoot);
    const workspace = await store.ensureQuickChatWorkspace(LOCAL_USER_ID);
    const thread = await store.createThread(
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
    await persisted.write(predecessor);
    const bytes = persisted.read();

    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(persisted.read()).toBe(bytes);
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('preserves current administration entry and validates its envelope without rewriting', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-admin-thread-predecessor-'));
  try {
    const store = createOwnerBoundStore(dataRoot);
    const userId = LOCAL_USER_ID;
    const workspace = await store.ensureQuickChatWorkspace(userId);
    const thread = await store.createThread(
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
      { schemaVersion: 2 },
      { id: 'th_00000000-0000-7000-8000-000000000001' },
    ]) {
      await persisted.write({ ...predecessor, ...damage });
      const bytes = persisted.read();
      await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
      expect(persisted.read()).toBe(bytes);
    }
    await persisted.write(predecessor);
    expect(new FsStore({ dataRoot }).getThread(workspace.id, thread.id)).toMatchObject({
      entryPath: 'administration',
      visibility: 'private',
      privateOwnerUserId: userId,
    });
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
