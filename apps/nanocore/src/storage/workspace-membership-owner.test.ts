import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  ensureUserQuickChatWorkspace,
  resolveWorkspaceMembershipRelation,
  WorkspaceOwnerMembershipRemovedError,
} from '../workspace-membership.js';
import { getWorkspaceMember, getWorkspaceRegistryFact } from '../workspace-sharing.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { coreDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

const roots: string[] = [];
const handles: CoreDb[] = [];
const blockers: Worker[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(blockers.splice(0).map((worker) => worker.terminate()));
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates real identity and storage owners without pre-provisioning membership. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-membership-owner-'));
  roots.push(root);
  const coreDb = openCoreDb(root);
  handles.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  return { coreDb, root, store, userId };
}

/** Holds the real Core file with the native Worker's connection policy, releasing off Main. */
async function holdCoreWriter(root: string, holdMs = 250): Promise<Worker> {
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const Database = require(workerData.module);
     const db = new Database(workerData.path, { fileMustExist: true });
     db.pragma('secure_delete = ON');
     db.pragma('journal_mode = WAL');
     db.pragma('synchronous = FULL');
     db.pragma('foreign_keys = ON');
     db.exec('BEGIN IMMEDIATE');
     parentPort.once('message', () => {
       setTimeout(() => {
         db.exec('COMMIT');
         db.close();
         parentPort.postMessage('released');
         parentPort.close();
       }, workerData.holdMs);
     });
     parentPort.postMessage('locked');`,
    {
      eval: true,
      workerData: {
        module: createRequire(import.meta.url).resolve('better-sqlite3'),
        path: coreDbPath(root),
        holdMs,
      },
    }
  );
  blockers.push(worker);
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message) => {
      if (message === 'locked') resolve();
      else reject(new Error('Core writer did not acquire its transaction.'));
    });
  });
  return worker;
}

it('provisions owner membership after a concurrent native-policy Core writer releases its lock', async () => {
  const f = fixture();
  const prepare = f.store.ensureQuickChatWorkspace.bind(f.store);
  let released: Promise<unknown> | undefined;
  vi.spyOn(f.store, 'ensureQuickChatWorkspace').mockImplementation(async (userId) => {
    const workspace = await prepare(userId);
    const blocker = await holdCoreWriter(f.root);
    released = new Promise((resolve, reject) => {
      blocker.once('message', resolve);
      blocker.once('error', reject);
    });
    // Release uses the independent Worker timer even if Main blocks inside SQLite.
    blocker.postMessage('release');
    return workspace;
  });

  // QA091's authorized bounded-wait fallback must tolerate an independently released lock.
  // The old Main 5 ms connection fails here with SQLITE_BUSY before this release.
  await expect(ensureUserQuickChatWorkspace(f)).resolves.toBeUndefined();
  await expect(released).resolves.toBe('released');
  const workspaceId = quickChatWorkspaceIdForUser(f.userId, f.root);
  expect(resolveWorkspaceMembershipRelation(f.coreDb, workspaceId, f.userId)).toBe('owner');
});

it('returns a safe public storage refusal when Core contention outlasts its bounded wait', async () => {
  const f = fixture();
  const app = createAppWithLocalIdentity({ coreDb: f.coreDb, store: f.store });
  const create = f.store.createWorkspace.bind(f.store);
  let reachedMembership = false;
  let released: Promise<unknown> | undefined;
  vi.spyOn(f.store, 'createWorkspace').mockImplementation(async (...args) => {
    const workspace = await create(...args);
    const blocker = await holdCoreWriter(f.root, 6_000);
    released = new Promise((resolve, reject) => {
      blocker.once('message', resolve);
      blocker.once('error', reject);
    });
    reachedMembership = true;
    blocker.postMessage('release');
    return workspace;
  });
  const requestId = randomUUID();
  const response = await app.request(
    ...operationRequest(
      'workspace.create',
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Contended owner Workspace', requestId }),
      }
    )
  );
  const text = await response.text();
  expect(reachedMembership).toBe(true);
  // Durable Execution: native BUSY/LOCKED shares the transport-neutral operation error owner.
  expect(response.status, text).toBe(503);
  const failure = JSON.parse(text) as { code: string; message: string };
  expect(failure.code).toBe('operation_storage_unavailable');
  expect(failure.message).toMatch(/inspect.*original.*request.*outcome.*before.*retry/i);
  expect(text).not.toMatch(/SQLITE|INSERT|DELETE|SELECT|workspace_members|workspace_registry/i);
  expect(text).not.toMatch(/not.committed|rolled.back|permission|forbidden/i);
  expect(text).not.toContain(f.root);
  await expect(released).resolves.toBe('released');
  // The real Workspace was prepared before membership; this refusal promises no cross-store rollback.
  // A six-second lock exceeds the authorized five-second wait; retain the standard 30-second case bound.
}, 30_000);

it.each([
  'disabled user',
  'removed membership',
  'changed binding',
] as const)('refuses a %s introduced during real personal Workspace preparation without partial membership', async (fault) => {
  const f = fixture();
  if (fault === 'removed membership') await ensureUserQuickChatWorkspace(f);
  const workspaceId = quickChatWorkspaceIdForUser(f.userId, f.root);
  const prepare = f.store.ensureQuickChatWorkspace.bind(f.store);
  let registry: ReturnType<typeof getWorkspaceRegistryFact>;
  let member: ReturnType<typeof getWorkspaceMember>;
  let injected = false;
  vi.spyOn(f.store, 'ensureQuickChatWorkspace').mockImplementation(async (userId) => {
    const workspace = await prepare(userId);
    if (fault === 'disabled user') {
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, userId))();
    } else if (fault === 'removed membership') {
      // Deliberate retained corruption after owner setup: ordinary removal forbids the owner.
      f.coreDb.sqlite.exec('DROP TRIGGER workspace_owner_member_update_guard');
      f.coreDb.sqlite
        .prepare(
          "UPDATE workspace_members SET status = 'removed', removed_at = ?, revision = revision + 1 WHERE workspace_id = ? AND user_id = ?"
        )
        .run(new Date().toISOString(), workspaceId, userId);
    } else {
      // Deliberate current-binding change after selection; it grants no successor membership.
      f.coreDb.sqlite
        .prepare('UPDATE users SET personal_workspace_id = ? WHERE id = ?')
        .run(testEntityId('ws', 'changed-personal-owner-binding'), userId);
    }
    registry = getWorkspaceRegistryFact(f.coreDb, workspaceId);
    member = getWorkspaceMember(f.coreDb, workspaceId, f.userId);
    injected = true;
    return workspace;
  });

  // Identity denies disabled authority and implicit tombstone revival; current binding wins.
  const provisioning = ensureUserQuickChatWorkspace(f);
  if (fault === 'removed membership') {
    await expect(provisioning).rejects.toBeInstanceOf(WorkspaceOwnerMembershipRemovedError);
  } else {
    await expect(provisioning).rejects.toBeInstanceOf(Error);
  }
  expect(injected).toBe(true);
  expect(getWorkspaceRegistryFact(f.coreDb, workspaceId)).toEqual(registry!);
  expect(getWorkspaceMember(f.coreDb, workspaceId, f.userId)).toEqual(member!);
  if (fault !== 'removed membership') {
    expect(getWorkspaceRegistryFact(f.coreDb, workspaceId)).toBeNull();
    expect(getWorkspaceMember(f.coreDb, workspaceId, f.userId)).toBeNull();
    if (fault === 'changed binding') {
      const successorId = quickChatWorkspaceIdForUser(f.userId, f.root);
      expect(getWorkspaceRegistryFact(f.coreDb, successorId)).toBeNull();
      expect(getWorkspaceMember(f.coreDb, successorId, f.userId)).toBeNull();
    }
  } else {
    expect(resolveWorkspaceMembershipRelation(f.coreDb, workspaceId, f.userId)).toBeNull();
  }
});
