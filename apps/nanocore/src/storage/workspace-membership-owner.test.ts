import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { armCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  ensureUserQuickChatWorkspace,
  publishWorkspaceOwnerMembership as recordWorkspaceOwnerMembership,
  WorkspaceOwnerMembershipRemovedError,
} from '../workspace-membership.js';
import {
  getWorkspaceMember,
  getWorkspaceRegistryFact,
  resolveWorkspaceMembershipRelation,
} from '../workspace-sharing.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { coreDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const roots: string[] = [];
const handles: CoreDb[] = [];
const blockers: Worker[] = [];

afterEach(async () => {
  releaseCommit();
  vi.restoreAllMocks();
  await Promise.all(blockers.splice(0).map((worker) => worker.terminate()));
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates real identity and storage owners without pre-provisioning membership. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-membership-owner-'));
  roots.push(root);
  const coreDb = openCoreDb(root);
  handles.push(coreDb);
  applyMigrations(coreDb);
  const userId = await ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  return { coreDb, root, store, userId };
}

/** Holds the real Core file with the native Worker's connection policy, releasing off Main. */
async function holdCoreWriter(root: string, holdMs = 250): Promise<Worker> {
  // This independent lock holder is not the product Worker selected by the commit observer.
  const { Worker: CorePolicyWorker } =
    await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads');
  const worker = new CorePolicyWorker(
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
  const f = await fixture();
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

  // Core Storage: the actual native owner must wait; Main cannot write this file.
  f.coreDb.sqlite.pragma('query_only = ON');
  await expect(ensureUserQuickChatWorkspace(f)).resolves.toBeUndefined();
  await expect(released).resolves.toBe('released');
  const workspaceId = quickChatWorkspaceIdForUser(f.userId, f.root);
  expect(resolveWorkspaceMembershipRelation(f.coreDb, workspaceId, f.userId)).toBe('owner');
});

it('returns a safe public storage refusal when Core contention outlasts its bounded wait', async () => {
  const f = await fixture();
  const app = await createAppWithLocalIdentity({ coreDb: f.coreDb, store: f.store });
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
  const f = await fixture();
  if (fault === 'removed membership') await ensureUserQuickChatWorkspace(f);
  const workspaceId = quickChatWorkspaceIdForUser(f.userId, f.root);
  const client = getControlStoreWorkerClient();
  const scope = nativeProductScope(f.root, { kind: 'server' });
  const database = `core:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: f.root,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const prepare = f.store.ensureQuickChatWorkspace.bind(f.store);
  let resume: (() => void) | undefined;
  let ready!: () => void;
  const prepared = new Promise<void>((resolve) => {
    ready = resolve;
  });
  vi.spyOn(f.store, 'ensureQuickChatWorkspace').mockImplementation(async (userId) => {
    const workspace = await prepare(userId);
    resume = await client.pauseForDataRootBackup(database);
    ready();
    return workspace;
  });
  f.coreDb.sqlite.pragma('query_only = ON');
  let settled = false;
  const provisioning = ensureUserQuickChatWorkspace(f);
  const observed = provisioning.then(
    () => {
      settled = true;
      return { reason: undefined };
    },
    (reason: unknown) => {
      settled = true;
      return { reason };
    }
  );
  // This is a real Core posting wait, after real Workspace publication, before deciding reads.
  await Promise.race([
    prepared,
    observed.then(({ reason }) => {
      throw reason ?? new Error('Provisioning completed before preparation.');
    }),
  ]);
  const faultDb = openCoreDb(f.root);
  handles.push(faultDb);
  let registry: ReturnType<typeof getWorkspaceRegistryFact>;
  let member: ReturnType<typeof getWorkspaceMember>;
  let injected = false;
  try {
    await nextTurn();
    expect(settled).toBe(false);
    const userId = f.userId;
    if (fault === 'disabled user') {
      faultDb.sqlite.transaction(() => disableCanonicalUser(faultDb, userId))();
    } else if (fault === 'removed membership') {
      // Deliberate retained corruption after owner setup: ordinary removal forbids the owner.
      faultDb.sqlite.exec('DROP TRIGGER workspace_owner_member_update_guard');
      faultDb.sqlite
        .prepare(
          "UPDATE workspace_members SET status = 'removed', removed_at = ?, revision = revision + 1 WHERE workspace_id = ? AND user_id = ?"
        )
        .run(new Date().toISOString(), workspaceId, userId);
    } else {
      // Deliberate current-binding change after selection; it grants no successor membership.
      faultDb.sqlite
        .prepare('UPDATE users SET personal_workspace_id = ? WHERE id = ?')
        .run(testEntityId('ws', 'changed-personal-owner-binding'), userId);
    }
    registry = getWorkspaceRegistryFact(f.coreDb, workspaceId);
    member = getWorkspaceMember(f.coreDb, workspaceId, f.userId);
    injected = true;
  } finally {
    resume?.();
  }

  // Identity denies disabled authority and implicit tombstone revival; current binding wins.
  if (fault === 'removed membership') {
    await expect(provisioning).rejects.toBeInstanceOf(WorkspaceOwnerMembershipRemovedError);
  } else {
    await expect(provisioning).rejects.toBeInstanceOf(Error);
  }
  await observed;
  expect(injected).toBe(true);
  expect(existsSync(workspaceDbPath(f.root, workspaceId))).toBe(true);
  expect(f.store.getWorkspace(workspaceId).id).toBe(workspaceId);
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

it('rechecks the canonical User after a real reservation wait before filesystem publication', async () => {
  const f = await fixture();
  const client = getControlStoreWorkerClient();
  const scope = nativeProductScope(f.root, { kind: 'server' });
  const database = `core:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: f.root,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const resume = await client.pauseForDataRootBackup(database);
  const publication = vi.spyOn(f.store, 'ensureQuickChatWorkspace');
  const workspaceId = quickChatWorkspaceIdForUser(f.userId, f.root);
  f.coreDb.sqlite.pragma('query_only = ON');
  let settled = false;
  const original = ensureUserQuickChatWorkspace(f).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    }
  );
  try {
    await nextTurn();
    expect(settled).toBe(false);
    expect(publication).not.toHaveBeenCalled();
    const writer = openCoreDb(f.root);
    handles.push(writer);
    writer.sqlite.transaction(() => disableCanonicalUser(writer, f.userId))();
  } finally {
    resume();
  }
  expect(await original).toBeInstanceOf(Error);
  expect(publication).not.toHaveBeenCalled();
  expect(quickChatWorkspaceIdForUser(f.userId, f.root)).toBe(workspaceId);
  expect(getWorkspaceRegistryFact(f.coreDb, workspaceId)).toBeNull();
  expect(existsSync(workspaceDbPath(f.root, workspaceId))).toBe(false);
});

it('awaits initial owner FULL before the separate User receipt and rolls back a late member failure', async () => {
  const f = await fixture();
  const app = await createAppWithLocalIdentity({ coreDb: f.coreDb, store: f.store });
  const requestId = randomUUID();
  const create = f.store.createWorkspace.bind(f.store);
  let workspaceId!: string;
  let gate: Int32Array | undefined;
  vi.spyOn(f.store, 'createWorkspace').mockImplementation(async (...args) => {
    const workspace = await create(...args);
    workspaceId = workspace.id;
    gate = armCommit(2);
    return workspace;
  });
  f.coreDb.sqlite.pragma('query_only = ON');
  let completed = false;
  const response = app
    .request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          body: JSON.stringify({ name: 'Exact owner registration', requestId }),
        }
      )
    )
    .finally(() => {
      completed = true;
    });
  try {
    await vi.waitFor(() => expect(gate && Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
    await nextTurn();
    expect(completed).toBe(false);
    expect(Atomics.load(gate!, 5)).toBe(2);
    expect(resolveWorkspaceMembershipRelation(f.coreDb, workspaceId, f.userId)).toBe('owner');
    expect(
      f.store.getCommandRequest('workspace.create', requestId, { userId: f.userId })
    ).toBeNull();
  } finally {
    releaseCommit();
  }
  expect((await response).status).toBe(201);
  expect(
    f.store.getCommandRequest('workspace.create', requestId, { userId: f.userId })
  ).toMatchObject({ response: { kind: 'workspace', id: workspaceId } });
  vi.mocked(f.store.createWorkspace).mockRestore();
  const workspace = f.store.getWorkspace(workspaceId);
  const input = { coreDb: f.coreDb, workspaceId, ownerUserId: f.userId };
  const registry = getWorkspaceRegistryFact(f.coreDb, workspace.id);
  const member = getWorkspaceMember(f.coreDb, workspace.id, f.userId);
  await recordWorkspaceOwnerMembership({ ...input, now: new Date('2099-01-01T00:00:00Z') });
  expect(getWorkspaceRegistryFact(f.coreDb, workspace.id)).toEqual(registry);
  expect(getWorkspaceMember(f.coreDb, workspace.id, f.userId)).toEqual(member);
  const failed = await f.store.createWorkspace('Interrupted owner registration');
  const faultDb = openCoreDb(f.root);
  handles.push(faultDb);
  // Deliberate failure after the first INSERT proves the original two-row rollback obligation.
  faultDb.sqlite.exec(`CREATE TRIGGER refuse_fixture_initial_member BEFORE INSERT ON workspace_members
    WHEN NEW.workspace_id = '${failed.id}' BEGIN SELECT RAISE(ABORT, 'injected late member failure'); END`);
  await expect(
    Promise.resolve().then(() =>
      recordWorkspaceOwnerMembership({
        ...input,
        workspaceId: failed.id,
      })
    )
  ).rejects.toBeInstanceOf(Error);
  expect(getWorkspaceRegistryFact(f.coreDb, failed.id)).toBeNull();
  expect(getWorkspaceMember(f.coreDb, failed.id, f.userId)).toBeNull();
  expect(f.store.getWorkspace(failed.id).id).toBe(failed.id);
  faultDb.sqlite.exec('DROP TRIGGER refuse_fixture_initial_member');
  await recordWorkspaceOwnerMembership({ ...input, workspaceId: failed.id });
  expect(resolveWorkspaceMembershipRelation(f.coreDb, failed.id, f.userId)).toBe('owner');
});
