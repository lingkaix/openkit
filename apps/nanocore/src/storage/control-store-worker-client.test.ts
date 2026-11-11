// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import type { JsonOperationId, LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId, type Item, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSqliteAuditEvents, prepareAuditEvent } from '../audit-events.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  type KernelCommandContext,
  updateRecord,
} from '../generative-kernel/commands.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { readPermissionDecisionRowV1 } from '../policy/retained-records-v1.js';
import {
  createSchedulerExecutionAttempt,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { readRetainedBodyBytes } from '../test-support/retained-body-observation.js';
import { initializeTestCore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { lightAppDbPath, openExistingAppDb } from './app-db.js';
import { commandRequestKey, getCommandRequestRecord } from './command-request-records.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  CONTROL_WORKER_LIMITS,
  type ControlSqlStatement,
} from './control-store-worker-protocol.js';
import { createDataRootAdminOperationImplementations } from './data-root-admin-operations.js';
import * as dataRootBackup from './data-root-backup.js';
import { bindCoreSqlite, openCoreDb, openUserDb, openUserReadDb, openWorkspaceDb } from './db.js';
import {
  coreDbPath,
  ensureLayout,
  ensureUserLayout,
  ensureWorkspaceLayout,
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
import { applyMigrations, applyScopedMigrations, hasPendingUserMigrations } from './migrate.js';
import { publishSchedulerAdmission } from './scheduler-admission-publication.js';
import { advanceThreadReadReceipt, readThreadReadReceipt } from './thread-read-receipts.js';
import { nativeProductScope } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  gate: undefined as SharedArrayBuffer | undefined,
  point: 'before' as 'before' | 'after' | 'open-ack',
}));

// This fixture wraps the actual entry, not a fake SQL service or a production fault option.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (interception.gate !== undefined) {
          const prelude = `
            const {parentPort, workerData} = require('node:worker_threads');
            const Database = require(workerData.databaseModule);
            const original = Database.prototype.exec;
            function hold(path, sqlite) {
              if (workerData.gate.length > 3 && Atomics.load(workerData.gate, 3) !== workerData.index) return;
              if (workerData.gate.length > 4) {
                const length = Atomics.load(workerData.gate, 4);
                const selected = String.fromCharCode(...workerData.gate.slice(5, 5 + length));
                if (path !== selected) return;
              }
              if (workerData.gate.length > 4 && Atomics.load(workerData.gate, 2) === 2) {
                let synchronous = -1;
                try { synchronous = Number(sqlite.pragma('synchronous', {simple:true})); } catch {}
                Atomics.store(workerData.gate, workerData.gate.length - 1, synchronous);
              }
              if (workerData.gate.length > 2 && Atomics.load(workerData.gate, 2) === 1) {
                Atomics.add(workerData.gate, 0, 1);
                Atomics.wait(workerData.gate, 1, 0);
              } else if (Atomics.compareExchange(workerData.gate, 0, 0, 1) === 0) {
                Atomics.wait(workerData.gate, 1, 0);
              }
            }
            const post = parentPort.postMessage.bind(parentPort);
            parentPort.postMessage = function(message, ...args) {
              if (workerData.point === 'open-ack' && message.status === 'ok' && message.operation === 'open') hold();
              return post(message, ...args);
            };
            Database.prototype.exec = function(sql) {
              const commit = /^COMMIT$/i.test(sql);
              if (commit && workerData.point === 'before') hold(this.name, this);
              const result = original.call(this, sql);
              if (commit && workerData.point === 'after') hold(this.name, this);
              return result;
            };
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          const require = createRequire(import.meta.url);
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              databaseModule: require.resolve('better-sqlite3'),
              gate: new Int32Array(interception.gate),
              point: interception.point,
              index: interception.workers.length,
            },
          });
        } else {
          super(filename, options);
        }
        interception.workers.push(this);
      }
    },
  };
});

const roots: string[] = [];
let client: ReturnType<typeof getControlStoreWorkerClient> | undefined;
const nativeHandles: (ReturnType<typeof openCoreDb> | ReturnType<typeof openWorkspaceDb>)[] = [];

/** Uses the real worker and current User journal in a private database, never a product fixture default. */
async function fixture(point?: 'before' | 'after', layout: 'private' | 'data-root' = 'private') {
  const root = mkdtempSync(join(tmpdir(), 'control-client-'));
  roots.push(root);
  if (layout === 'data-root') {
    ensureLayout(root);
    ensureUserLayout(root, FIXTURE_LOCAL_USER_ID);
  }
  const path =
    layout === 'data-root' ? userDbPath(root, FIXTURE_LOCAL_USER_ID) : join(root, 'user.sqlite');
  if (point !== undefined) {
    interception.gate = new SharedArrayBuffer(8);
    interception.point = point;
  }
  client = getControlStoreWorkerClient();
  await client.open({ database: 'user', path, create: true, initialize: 'user' });
  return {
    client,
    path,
    root,
    gate: interception.gate === undefined ? undefined : new Int32Array(interception.gate),
  };
}

/** Opens actual scope journals through the public client; the accepted DX reference fixes four Workspace hosts. */
async function poolFixture(size = 4, point?: 'before' | 'after' | 'open-ack') {
  const root = mkdtempSync(join(tmpdir(), 'control-pool-'));
  roots.push(root);
  ensureLayout(root);
  if (point !== undefined) {
    interception.gate = new SharedArrayBuffer(12);
    interception.point = point;
    Atomics.store(new Int32Array(interception.gate), 0, 1); // Leave initialization outside the fault.
  }
  const writer = getControlStoreWorkerClient();
  client = writer;
  const scopes = new Map<
    number,
    {
      database: string;
      path: string;
      create: boolean;
      initialize: 'workspace';
      productOwner: { kind: 'workspace'; workspaceId: string };
      dataRoot: string;
    }
  >();
  const scope = (index: number) => {
    let value = scopes.get(index);
    if (value === undefined) {
      const workspaceId = allocateEntityId('ws');
      ensureWorkspaceLayout(root, workspaceId);
      const path = workspaceDbPath(root, workspaceId);
      value = {
        database: `workspace:${path}`,
        path,
        create: true,
        initialize: 'workspace',
        productOwner: { kind: 'workspace', workspaceId },
        dataRoot: root,
      };
      scopes.set(index, value);
    }
    return value;
  };
  for (let index = 0; index < size; index += 1) await writer.open(scope(index));
  return {
    client: writer,
    root,
    scope,
    gate: interception.gate === undefined ? undefined : new Int32Array(interception.gate),
  };
}

/** Publishes real Workspace and Material commands; no completed receipt or Material row is assembled by the test. */
async function productPoolFixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-product-pool-'));
  roots.push(root);
  initializeTestCore(root);
  const coreDb = openCoreDb(root);
  nativeHandles.push(coreDb);
  const userId = ensureLocalUser(coreDb);
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  const store = new FsStore({ dataRoot: root });
  const workspaces = [];
  client = getControlStoreWorkerClient();
  for (let index = 0; index < 4; index += 1) {
    const workspace = await store.createWorkspace(`Pool ${index}`);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
    await client.open({
      database: `workspace:${scope.path}`,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    workspaces.push(workspace);
  }
  const invoke = createOperationInvocation({
    coreDb,
    store,
    dataRoot: root,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    repositoryWorkspaceDb: (id) => {
      if (!workspaces.some((workspace) => workspace.id === id))
        throw new Error('Fixture Workspace is not admitted.');
      return openWorkspaceDb(root, id);
    },
  });
  const call = <K extends JsonOperationId>(workspaceId: string, id: K, input: object) =>
    invoke(id, { workspaceId, ...input }, { kind: 'public', actor: { kind: 'session', userId } });
  return { client, root, workspaces, call, coreDb, userId, store };
}

/** Reuses the existing native journal receipt table to observe this transport's real COMMIT boundary. */
function nativeRequest(id: string): ControlSqlStatement[] {
  return [
    {
      mode: 'run',
      sql: "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES (?, 'fixture', ?, '{}', 'fixture', 'thread', 'fixture', 'fixture', 'fixture')",
      parameters: [id, id],
      expectChanges: 1,
    },
  ];
}

/** Reads the native request identity without another writer or an outcome guess. */
function nativeRequests(path: string): string[] {
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  try {
    reader.pragma('query_only = ON');
    return reader
      .prepare('SELECT request_id FROM idempotency_requests ORDER BY request_id')
      .pluck()
      .all() as string[];
  } finally {
    reader.close();
  }
}

/** A scalar metadata insert in an already owned native table, not a new product contract. */
function metadata(id: string): ControlSqlStatement[] {
  return [
    {
      mode: 'run',
      sql: "INSERT INTO thread_read_receipts (workspace_id, thread_id, item_ids_json) VALUES ('fixture', ?, '[]')",
      parameters: [id],
      expectChanges: 1,
    },
  ];
}

/** Waits without blocking the main thread or choosing a shorter product deadline. */
async function waitForHold(gate: Int32Array): Promise<void> {
  while (Atomics.load(gate, 0) === 0) await nextTurn();
}

/** Releases only this fixture's native COMMIT gate. */
function release(gate?: Int32Array): void {
  if (gate === undefined) return;
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

/** Inspects committed truth through an independent short read-only connection. */
function count(path: string): number {
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  try {
    reader.pragma('query_only = ON');
    return reader.prepare('SELECT count(*) FROM thread_read_receipts').pluck().get() as number;
  } finally {
    reader.close();
  }
}

afterEach(async () => {
  if (interception.gate !== undefined) release(new Int32Array(interception.gate));
  await client?.shutdown();
  client = undefined;
  for (const db of nativeHandles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  interception.gate = undefined;
  interception.workers.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('control writer parent admission', () => {
  it('seals recovery only after accepted Item publications and hashes the closed tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-recovery-seal-'));
    roots.push(root);
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1);
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Private recovery', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    const tree = join(root, 'workspaces', DEMO_WORKSPACE_ID);
    const publish = (text: string) =>
      store.createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text,
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      });
    Atomics.store(gate, 0, 0);
    const first = publish('Complete immutable recovery content.\n'.repeat(2048));
    await waitForHold(gate);
    const second = publish('Accepted after the first publication, before its acknowledgement.');
    await nextTurn();
    let settled = false;
    const sealing = client.sealRecovery(database).then((digest) => {
      settled = true;
      return digest;
    });
    let settledWhileHeld: boolean;
    try {
      await nextTurn();
      settledWhileHeld = settled;
    } finally {
      release(gate);
    }
    await Promise.allSettled([first, second, sealing]);
    expect(settledWhileHeld).toBe(false);
    const items = await Promise.all([first, second]);
    const digest = await sealing;
    // Same-Deployment Restore seals the complete post-close inventory before placement.
    const expected = createHash('sha256')
      .update(JSON.stringify(dataRootBackup.inventoryRegularFiles(tree)))
      .digest('hex');
    expect(digest).toBe(expected);
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual(items);
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
      create: false,
      initialize: 'workspace',
    });
    const later = await publish('A new explicit opening can publish after the seal.');
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual([...items, later]);
  });

  it('closes only after accepted same-Turn Item publications are durable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-close-publication-'));
    roots.push(root);
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'after';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1);
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Private close', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    const publish = (text: string) =>
      store.createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text,
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      });
    Atomics.store(gate, 0, 0);
    const first = publish('Complete immutable close content.\n'.repeat(2048));
    await waitForHold(gate);
    const second = publish('Accepted after the first publication, before its acknowledgement.');
    await nextTurn();
    let closed = false;
    const closing = client.close(database).then(() => {
      closed = true;
    });
    let closedWhileHeld: boolean;
    try {
      await nextTurn();
      closedWhileHeld = closed;
    } finally {
      release(gate);
    }
    const outcomes = await Promise.allSettled([first, second, closing]);
    expect(closedWhileHeld).toBe(false);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    const items = await Promise.all([first, second]);
    await closing;
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
      create: false,
      initialize: 'workspace',
    });
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual(items);
    const reader = new Database(scope.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      const retained = reader
        .prepare(
          "SELECT content_json FROM control_product_entries WHERE kind='item' AND turn_id=? ORDER BY sequence"
        )
        .pluck()
        .all(turn.id) as string[];
      expect(retained).toHaveLength(items.length);
      expect(
        retained.map((json) => readRetainedBodyBytes(scope.contentMount.root, JSON.parse(json)))
      ).toEqual(items.map((item) => Buffer.from(JSON.stringify(writeRetainedV1(item)), 'utf8')));
    } finally {
      reader.close();
    }
  });

  it('reports a post-close recovery seal refusal and permits an explicit fresh opening', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-recovery-seal-refusal-'));
    roots.push(root);
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Private recovery', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    const tree = join(root, 'workspaces', DEMO_WORKSPACE_ID);
    const before = store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID);
    const inode = statSync(scope.path).ino;
    expect(dataRootBackup.inventoryRegularFiles(tree).length).toBeGreaterThan(0);
    // Fault injection follows valid owner setup; inventory and sealing must refuse this link.
    const link = join(tree, 'forbidden-recovery-link');
    symlinkSync(scope.path, link);
    await expect(client.sealRecovery(database)).resolves.toBeNull();
    expect(statSync(scope.path).ino).toBe(inode);
    rmSync(link);
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
      create: false,
      initialize: 'workspace',
    });
    const item = await store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Explicitly reopened after a seal refusal.',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual([...before, item]);
    expect(statSync(scope.path).ino).toBe(inode);
  });

  it.each(['before', 'after'] as const)(
    'keeps healthy Workspace ACKs independent of a sibling held %s COMMIT and its lost host',
    async (point) => {
      const posted = vi.spyOn(Worker.prototype, 'postMessage');
      const f = await poolFixture(2, point);
      const original = f.scope(0);
      const healthy = f.scope(1);
      Atomics.store(f.gate!, 0, 0);
      const write = f.client
        .write(original.database, nativeRequest('original'))
        .catch((error: unknown) => error);
      try {
        await waitForHold(f.gate!);
        expect(nativeRequests(original.path)).toEqual(point === 'after' ? ['original'] : []);
        // This must finish while the other native thread is still blocked, without a shorter test deadline.
        await expect(
          f.client.write(healthy.database, nativeRequest('healthy'))
        ).resolves.toHaveLength(1);
        expect(nativeRequests(healthy.path)).toEqual(['healthy']);
        expect(Atomics.load(f.gate!, 1)).toBe(0);
        const call = posted.mock.calls.findIndex(
          ([request]) => request.database === original.database && request.operation === 'write'
        );
        const failedHost = posted.mock.contexts[call] as NativeWorker;
        await failedHost.terminate();
        expect(await write).toMatchObject({ code: 'unavailable', commit: 'unknown' });
        await expect(
          f.client.write(original.database, nativeRequest('no-retry'))
        ).rejects.toMatchObject({
          code: 'unavailable',
          commit: 'not-committed',
        });
        await expect(
          f.client.write(healthy.database, nativeRequest('later'))
        ).resolves.toHaveLength(1);
        expect(nativeRequests(original.path)).toEqual(point === 'after' ? ['original'] : []);
        expect(nativeRequests(healthy.path)).toEqual(['healthy', 'later']);
        expect(
          posted.mock.calls.filter(
            ([request]) => request.database === original.database && request.operation === 'write'
          )
        ).toHaveLength(1);
      } finally {
        release(f.gate);
      }
    }
  );

  it.each([false, true])(
    'excludes canonical and hardlink aliases process-wide with held fresh ACK = %s',
    async (held) => {
      const f = await poolFixture(4, held ? 'open-ack' : undefined);
      const original = f.scope(held ? 4 : 0);
      let opening: Promise<unknown> | undefined;
      if (held) {
        Atomics.store(f.gate!, 0, 0);
        opening = f.client.open(original);
        await waitForHold(f.gate!);
      }
      try {
        // In the held case these real initialized bytes exist before the successful open reply is delivered.
        expect(nativeRequests(original.path)).toEqual([]);
        const canonicalAlias = join(f.root, 'canonical-alias.sqlite');
        const hardlink = join(f.root, 'hardlink-alias.sqlite');
        symlinkSync(original.path, canonicalAlias);
        linkSync(original.path, hardlink);
        for (const [index, path] of [original.path, canonicalAlias, hardlink].entries()) {
          await expect(
            f.client.open({
              database: `alias-${index}`,
              path,
              create: false,
              initialize: 'workspace',
            })
          ).rejects.toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
        }
      } finally {
        release(f.gate);
        await opening;
      }
    }
  );

  it('admits only one writer when a fresh target races its pre-existing dangling leaf symlink', async () => {
    const f = await poolFixture(4, 'open-ack');
    const target = f.scope(4);
    const alias = join(f.root, 'dangling.sqlite');
    symlinkSync(target.path, alias);
    expect(existsSync(target.path)).toBe(false);
    Atomics.store(f.gate!, 0, 0);
    const observe = (open: Promise<unknown>) =>
      open.then(
        () => ({ status: 'ok' as const }),
        (error: unknown) => ({ status: 'error' as const, error })
      );
    const resume = await f.client.pauseForDataRootBackup();
    const opens: ReturnType<typeof observe>[] = [];
    try {
      try {
        // Hold posting so both parent admissions see the target absent, regardless of Worker scheduling.
        opens.push(
          observe(
            f.client.open({
              database: 'dangling-alias',
              path: alias,
              create: true,
              initialize: 'workspace',
            })
          ),
          observe(
            f.client.open({
              database: target.database,
              path: target.path,
              create: true,
              initialize: 'workspace',
            })
          )
        );
        expect(existsSync(target.path)).toBe(false);
      } finally {
        resume();
      }
      await waitForHold(f.gate!);
      expect(nativeRequests(target.path)).toEqual([]);
      // The real initialized winner's successful ACK is held; only a truthful loser can settle now.
      expect(await Promise.race(opens)).toMatchObject({
        status: 'error',
        error: { code: 'invalid-request', commit: 'not-committed' },
      });
    } finally {
      release(f.gate);
    }
    const results = await Promise.all(opens);
    expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'error')).toHaveLength(1);
  });

  it('settles an accepted producer and shutdown when its idle host exits before the causal write', async () => {
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const f = await poolFixture(2);
    const original = f.scope(0);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const observe = <T>(value: Promise<T>) =>
      value.then(
        (result) => ({ status: 'ok' as const, result }),
        (error: unknown) => ({ status: 'error' as const, error })
      );
    const producer = observe(
      f.client.runOperation(async () => {
        enter();
        await barrier;
        return f.client.write(original.database, nativeRequest('causal-after-loss'));
      })
    );
    await entered;
    const shutdown = observe(f.client.shutdown());
    try {
      const call = posted.mock.calls.findIndex(
        ([request]) => request.database === original.database && request.operation === 'open'
      );
      await (posted.mock.contexts[call] as NativeWorker).terminate();
    } finally {
      resume();
    }
    const produced = await producer;
    const stopped = await shutdown;
    // This shutdown has settled; do not await the same expected rejection again in afterEach.
    if (f.client.isClosed) client = undefined;
    expect(f.client.isClosed).toBe(true);
    expect(produced).toMatchObject({
      status: 'error',
      error: { code: 'unavailable', commit: 'not-committed' },
    });
    expect(stopped).toMatchObject({ status: 'error', error: expect.any(AggregateError) });
    if (
      produced.status !== 'error' ||
      stopped.status !== 'error' ||
      !(stopped.error instanceof AggregateError)
    )
      throw new Error('Shutdown must report the rejected accepted producer.');
    expect(stopped.error.errors).toHaveLength(1);
    expect(stopped.error.errors[0]).toBe(produced.error);
    expect(nativeRequests(original.path)).toEqual([]);
    expect(
      posted.mock.calls.filter(
        ([request]) => request.database === original.database && request.operation === 'write'
      )
    ).toHaveLength(0);
  });

  it('drains only matching posted ACKs and defers matching posts while a sibling progresses', async () => {
    const f = await poolFixture(2, 'after');
    const target = f.scope(0);
    const sibling = f.scope(1);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const holds: Promise<() => void>[] = [];
    let acquired = false;
    Atomics.store(f.gate!, 0, 0);
    const original = f.client.write(target.database, nativeRequest('before-hold'));
    const originalSettled = Promise.allSettled([original]);
    let deferred: Promise<unknown> | undefined;
    try {
      await waitForHold(f.gate!);
      const pause = f.client.pauseForDataRootBackup(target.database).then((resume) => {
        acquired = true;
        return resume;
      });
      holds.push(pause);
      deferred = f.client.write(target.database, nativeRequest('during-hold'));
      void deferred.catch(() => {});
      await expect(
        f.client.write(sibling.database, nativeRequest('healthy'))
      ).resolves.toHaveLength(1);
      expect(acquired).toBe(false);
      expect(nativeRequests(target.path)).toEqual(['before-hold']);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.database === target.database && request.operation === 'write'
        )
      ).toHaveLength(1);
      release(f.gate);
      await original;
      const resume = await pause;
      expect(acquired).toBe(true);
      expect(nativeRequests(target.path)).toEqual(['before-hold']);
      resume();
      await deferred;

      // Re-arm the same real ACK gate on the sibling; it must not join the target's drain.
      Atomics.store(f.gate!, 0, 0);
      Atomics.store(f.gate!, 1, 0);
      const siblingWrite = f.client.write(sibling.database, nativeRequest('sibling-held'));
      void siblingWrite.catch(() => {});
      try {
        await waitForHold(f.gate!);
        const targetPause = f.client.pauseForDataRootBackup(target.database);
        holds.push(targetPause);
        await targetPause;
        expect(Atomics.load(f.gate!, 1)).toBe(0);
        expect(nativeRequests(sibling.path)).toContain('sibling-held');
      } finally {
        release(f.gate);
        await Promise.allSettled([siblingWrite]);
      }
      await expect(siblingWrite).resolves.toHaveLength(1);
    } finally {
      release(f.gate);
      for (const hold of holds) (await hold)();
      await originalSettled;
      await Promise.allSettled(deferred === undefined ? [] : [deferred]);
    }
  });

  it('refuses a scoped hold on a failed channel without replaying posted or deferred writes', async () => {
    const f = await poolFixture(2, 'after');
    const target = f.scope(0);
    const sibling = f.scope(1);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    Atomics.store(f.gate!, 0, 0);
    const original = f.client
      .write(target.database, nativeRequest('committed-before-loss'))
      .catch((error: unknown) => error);
    let pause: Promise<unknown> | undefined;
    let deferred: Promise<unknown> | undefined;
    try {
      await waitForHold(f.gate!);
      pause = f.client.pauseForDataRootBackup(target.database).catch((error: unknown) => error);
      deferred = f.client
        .write(target.database, nativeRequest('never-posted'))
        .catch((error: unknown) => error);
      const call = posted.mock.calls.findIndex(
        ([request]) => request.database === target.database && request.operation === 'write'
      );
      await (posted.mock.contexts[call] as NativeWorker).terminate();
      expect(await original).toMatchObject({ code: 'unavailable', commit: 'unknown' });
      expect(await pause).toMatchObject({ code: 'unavailable' });
      expect(await deferred).toMatchObject({ code: 'unavailable', commit: 'not-committed' });
      await expect(f.client.pauseForDataRootBackup(target.database)).rejects.toMatchObject({
        code: 'unavailable',
      });
      await expect(
        f.client.write(sibling.database, nativeRequest('healthy-after-loss'))
      ).resolves.toHaveLength(1);
      expect(nativeRequests(target.path)).toEqual(['committed-before-loss']);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.database === target.database && request.operation === 'write'
        )
      ).toHaveLength(1);
      expect(getControlStoreWorkerClient()).toBe(f.client);
    } finally {
      release(f.gate);
      const held = await pause;
      if (typeof held === 'function') held();
      await Promise.allSettled(deferred === undefined ? [original] : [original, deferred]);
    }
  });

  it('orders same-database holds FIFO and excludes later holds behind the global backup', async () => {
    const f = await poolFixture(3);
    const target = f.scope(0);
    const sibling = f.scope(1);
    const other = f.scope(2);
    const holds: Promise<() => void>[] = [];
    const queued: Promise<unknown>[] = [];
    const first = f.client.pauseForDataRootBackup(target.database);
    holds.push(first);
    const releaseFirst = await first;
    let secondAcquired = false;
    let globalAcquired = false;
    let laterTargetAcquired = false;
    let laterSiblingAcquired = false;
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      const second = f.client.pauseForDataRootBackup(target.database).then((resume) => {
        secondAcquired = true;
        return resume;
      });
      holds.push(second);
      const independent = f.client.pauseForDataRootBackup(sibling.database);
      holds.push(independent);
      const releaseIndependent = await independent;
      expect(secondAcquired).toBe(false);
      const global = f.client.pauseForDataRootBackup().then((resume) => {
        globalAcquired = true;
        return resume;
      });
      holds.push(global);
      const laterTarget = f.client.pauseForDataRootBackup(target.database).then((resume) => {
        laterTargetAcquired = true;
        return resume;
      });
      holds.push(laterTarget);
      const laterSibling = f.client.pauseForDataRootBackup(sibling.database).then((resume) => {
        laterSiblingAcquired = true;
        return resume;
      });
      holds.push(laterSibling);
      const otherWrite = f.client.write(other.database, nativeRequest('after-global'));
      queued.push(otherWrite);
      void otherWrite.catch(() => {});
      releaseFirst();
      const releaseSecond = await second;
      expect(globalAcquired).toBe(false);
      // Calling the old release twice must not release its current same-database successor.
      releaseFirst();
      const targetWrite = f.client.write(target.database, nativeRequest('after-local'));
      queued.push(targetWrite);
      void targetWrite.catch(() => {});
      await nextTurn();
      expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(
        0
      );
      releaseSecond();
      await nextTurn();
      expect(globalAcquired).toBe(false);
      releaseIndependent();
      const resumeGlobal = await global;
      expect(laterTargetAcquired).toBe(false);
      expect(laterSiblingAcquired).toBe(false);
      expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(
        0
      );
      resumeGlobal();
      await Promise.all([laterTarget, laterSibling]);
      await expect(otherWrite).resolves.toHaveLength(1);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.database === target.database && request.operation === 'write'
        )
      ).toHaveLength(0);
    } finally {
      // Creation order is safe on assertion failure: each release lets its queued successor settle.
      for (const hold of holds) (await hold)();
      await Promise.allSettled(queued);
    }
    await expect(Promise.all(queued)).resolves.toHaveLength(2);
    expect(nativeRequests(target.path)).toEqual(['after-local']);
    expect(nativeRequests(other.path)).toEqual(['after-global']);
  });

  it('pauses every routed Workspace and server host during a global backup capture', async () => {
    const f = await productPoolFixture();
    roots.push(`${f.root}.backups`);
    const scopes = f.workspaces.map((workspace) => ({
      database: `workspace:${workspaceDbPath(f.root, workspace.id)}`,
      path: workspaceDbPath(f.root, workspace.id),
    }));
    const server = {
      database: `server:${coreDbPath(f.root)}`,
      path: coreDbPath(f.root),
      create: false,
      initialize: 'core' as const,
      productOwner: { kind: 'server' as const },
      dataRoot: f.root,
    };
    await f.client.open(server);
    scopes.push(server);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    const waiting: Promise<unknown>[] = [];
    let during = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      for (const scope of scopes)
        waiting.push(
          f.client.write(scope.database, [
            {
              mode: 'get',
              sql: 'SELECT 1 AS value',
              parameters: [],
            },
          ])
        );
      during = posted.mock.calls.filter(([request]) => request.operation === 'write').length;
      return capture(input);
    });
    await createDataRootAdminOperationImplementations(f.root)['backup.create']();
    await expect(Promise.all(waiting)).resolves.toHaveLength(5);
    expect(during).toBe(0);
    const hosts = posted.mock.calls.flatMap(([request], index) =>
      request.operation === 'write' ? [posted.mock.contexts[index]] : []
    );
    expect(hosts).toHaveLength(5);
    expect(new Set(hosts).size).toBe(5);
  });

  it('bounds Material binary admission per database before posting and preserves sibling service', async () => {
    interception.gate = new SharedArrayBuffer(16);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1); // Setup remains outside the real COMMIT holds.
    Atomics.store(gate, 3, -1); // Select the actual target host only after its scope is open.
    const f = await productPoolFixture();
    const materials = [];
    for (let index = 0; index < 5; index += 1) {
      const workspaceId = f.workspaces[0]!.id;
      const { materialId } = await f.call(workspaceId, 'material.create', {
        requestId: `create-${index}`,
        title: `Material ${index}`,
        kind: 'text',
        sensitivity: 'internal',
      });
      materials.push({ workspaceId, materialId });
    }
    const knowledgeWorkspaceId = f.workspaces[0]!.id;
    const knowledgeDatabase = `workspace:${
      nativeProductScope(f.root, {
        kind: 'workspace',
        workspaceId: knowledgeWorkspaceId,
      }).path
    }`;
    const knowledgeCall = await f.client.capability(knowledgeDatabase, {
      kind: 'admit',
      workspaceId: knowledgeWorkspaceId,
      now: new Date().toISOString(),
      context: {
        authorityActor: null,
        family: 'knowledge',
        operation: 'knowledge.ask',
        capabilityId: 'knowledge.ask',
        redactionClass: 'metadata-only',
      },
    });
    if (!knowledgeCall || typeof knowledgeCall !== 'object' || !('context' in knowledgeCall))
      throw new Error('Native Knowledge admission did not return its original Call.');
    const finishKnowledge = () =>
      f.client.capability(knowledgeDatabase, {
        kind: 'usage-finish',
        workspaceId: knowledgeWorkspaceId,
        call: knowledgeCall,
        finish: {
          status: 'succeeded',
          deliveredKnowledgeAnswer: 'x',
          now: new Date().toISOString(),
        },
      });
    const save = (index: number, content: string) => {
      const { workspaceId, materialId } = materials[index]!;
      return f.call(workspaceId, 'material.revision-save', {
        requestId: `save-${index}`,
        materialId,
        expectedRevisionId: null,
        content,
        contentDigest: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
      });
    };
    const post = Worker.prototype.postMessage;
    const targetPost = vi.spyOn(Worker.prototype, 'postMessage');
    await f.client.write(knowledgeDatabase, [
      { mode: 'get', sql: 'SELECT 1 AS value', parameters: [] },
    ]);
    const targetCall = targetPost.mock.calls.findIndex(
      ([request]) => request.database === knowledgeDatabase
    );
    const targetHost = interception.workers.indexOf(
      targetPost.mock.contexts[targetCall] as NativeWorker
    );
    expect(targetHost).toBeGreaterThanOrEqual(0);
    Atomics.store(gate, 3, targetHost);
    targetPost.mockRestore();
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let materialPosts = 0;
    const posted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: NativeWorker,
      ...args: Parameters<NativeWorker['postMessage']>
    ) {
      post.apply(this, args);
      if (args[0]?.operation === 'material' && ++materialPosts === 4) admit();
    });
    // The accepted per-database binary budget is 64 MiB; four valid 16 MiB saves fill it exactly.
    expect(CONTROL_WORKER_LIMITS.materialPendingBytes).toBe(67_108_864);
    Atomics.store(gate, 0, 0);
    Atomics.store(gate, 2, 1); // Hold the target COMMIT so no reply frees its binary reservation.
    const accepted = Array.from({ length: 4 }, (_, index) => save(index, 'a'.repeat(16_777_216)));
    const settled = Promise.allSettled(accepted);
    try {
      await admitted;
      const materialRequests = posted.mock.calls.filter(
        ([request]) => request.operation === 'material'
      );
      expect(materialRequests).toHaveLength(4);
      await waitForHold(gate);
      await expect(save(4, 'x')).rejects.toMatchObject({ code: 'busy', commit: 'not-committed' });
      const capabilityPosts = posted.mock.calls.filter(
        ([request]) => request.operation === 'capability'
      ).length;
      await expect(finishKnowledge()).rejects.toMatchObject({
        code: 'busy',
        commit: 'not-committed',
      });
      expect(
        posted.mock.calls.filter(([request]) => request.operation === 'capability')
      ).toHaveLength(capabilityPosts);
      expect(
        posted.mock.calls.filter(([request]) => request.operation === 'material')
      ).toHaveLength(4);
      const siblingDatabase = `workspace:${workspaceDbPath(f.root, f.workspaces[1]!.id)}`;
      await expect(
        f.client.write(siblingDatabase, [{ mode: 'get', sql: 'SELECT 1 AS value', parameters: [] }])
      ).resolves.toMatchObject([{ mode: 'get', row: { value: 1n } }]);
      expect(Atomics.load(gate, 1)).toBe(0);
    } finally {
      release(gate);
      await settled;
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(4);
    // The fifth request becomes admissible only after the original reservations settle.
    await expect(save(4, 'x')).resolves.toHaveProperty('revisionId');
    await finishKnowledge();
  });

  // COORD21:55 r2-FIX-3 P1: eight TOTAL pending per physical database/Turn, including preparation.
  it('bounds a physical Turn before preparation while peer Turns and effect admission keep service', async () => {
    const f = await productPoolFixture();
    const database = `workspace:${workspaceDbPath(f.root, f.workspaces[0]!.id)}`;
    const sibling = `workspace:${workspaceDbPath(f.root, f.workspaces[1]!.id)}`;
    const aliasPath = join(f.root, 'publication-alias.sqlite');
    symlinkSync(workspaceDbPath(f.root, f.workspaces[0]!.id), aliasPath);
    const alias = `workspace:${aliasPath}`;
    const turn = allocateEntityId('tu');
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const prepare = vi.fn(async (input: { id: string }) => {
      if (input.id === 'hot-0') {
        entered();
        await held;
      }
      return f.client.write(database, nativeRequest(input.id));
    });
    const accepted = [f.client.runTurnPublication(database, [turn], { id: 'hot-0' }, prepare)];
    const settled: Promise<unknown>[] = [Promise.allSettled(accepted)];
    let excess: Promise<unknown> | undefined;
    try {
      await preparing;
      for (let index = 1; index < 8; index += 1)
        accepted.push(
          f.client.runTurnPublication(
            index % 2 ? alias : database,
            [turn],
            { id: `hot-${index}` },
            prepare
          )
        );
      settled.push(Promise.allSettled(accepted));
      const rejectedPrepare = vi.fn(async () => f.client.write(database, nativeRequest('excess')));
      excess = f.client.runTurnPublication(alias, [turn], {}, rejectedPrepare).then(
        () => ({ code: 'unexpected-accept' }),
        (error: unknown) => error
      );
      const disposition = await Promise.race([
        excess,
        nextTurn().then(() => ({ code: 'still-pending' })),
      ]);
      expect.soft(disposition).toMatchObject({ code: 'busy', commit: 'not-committed' });
      expect.soft(rejectedPrepare).not.toHaveBeenCalled();
      expect.soft(prepare).toHaveBeenCalledTimes(1);
      await f.client.runTurnPublication(
        database,
        [allocateEntityId('tu')],
        { id: 'peer' },
        prepare
      );
      await f.client.runTurnPublication(sibling, [turn], {}, () =>
        f.client.write(sibling, nativeRequest('sibling'))
      );
      const workspaceId = f.workspaces[0]!.id;
      const call = await f.client.capability(database, {
        kind: 'admit',
        workspaceId,
        now: new Date().toISOString(),
        context: {
          authorityActor: null,
          family: 'knowledge',
          operation: 'knowledge.ask',
          capabilityId: 'knowledge.ask',
          redactionClass: 'metadata-only',
        },
      });
      expect(call).toHaveProperty('context');
      expect(nativeRequests(database.slice('workspace:'.length))).toEqual(['peer']);
      expect(nativeRequests(sibling.slice('workspace:'.length))).toEqual(['sibling']);
    } finally {
      resume();
      await Promise.all(settled);
      await excess;
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(8);
    expect.soft(nativeRequests(database.slice('workspace:'.length))).not.toContain('excess');
    // Refusal must not install a rejected tail that poisons later valid work.
    await expect(
      f.client.runTurnPublication(database, [turn], { id: 'later' }, prepare)
    ).resolves.toHaveLength(1);
    expect(nativeRequests(database.slice('workspace:'.length))).toContain('later');
  });

  // P1 checks distinct affected Turns atomically; a refused tuple cannot consume or poison its free selector.
  it('admits distinct multi-Turn selectors atomically without double charging repeated selectors', async () => {
    const f = await poolFixture(1);
    const database = f.scope(0).database;
    const hot = allocateEntityId('tu'),
      cold = allocateEntityId('tu');
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const hotPrepare = vi.fn(async (id: string) => {
      await held;
      return f.client.write(database, nativeRequest(id));
    });
    const hotWork = Array.from({ length: 8 }, (_, index) =>
      f.client.runTurnPublication(database, [hot], `hot-${index}`, hotPrepare)
    );
    const hotSettled = Promise.allSettled(hotWork);
    const rejectedPrepare = vi.fn(async () => {
      throw new Error('A refused tuple must not prepare.');
    });
    const candidate = f.client.runTurnPublication(database, [cold, hot], {}, rejectedPrepare).then(
      () => ({ code: 'unexpected-accept' }),
      (error: unknown) => error
    );
    const coldPrepare = vi.fn(async (id: string) => {
      await held;
      return f.client.write(database, nativeRequest(id));
    });
    const coldWork = Array.from({ length: 8 }, (_, index) =>
      f.client.runTurnPublication(database, [cold, cold], `cold-${index}`, coldPrepare)
    );
    const coldSettled = Promise.allSettled(coldWork);
    const overflowPrepare = vi.fn(async () => f.client.write(database, nativeRequest('overflow')));
    const overflow = f.client.runTurnPublication(database, [cold], {}, overflowPrepare).then(
      () => ({ code: 'unexpected-accept' }),
      (error: unknown) => error
    );
    try {
      expect
        .soft(await Promise.race([candidate, nextTurn().then(() => ({ code: 'still-pending' }))]))
        .toMatchObject({ code: 'busy', commit: 'not-committed' });
      expect
        .soft(await Promise.race([overflow, nextTurn().then(() => ({ code: 'still-pending' }))]))
        .toMatchObject({ code: 'busy', commit: 'not-committed' });
      expect.soft(hotPrepare).toHaveBeenCalledTimes(1);
      expect.soft(coldPrepare).toHaveBeenCalledTimes(1);
      expect.soft(rejectedPrepare).not.toHaveBeenCalled();
      expect.soft(overflowPrepare).not.toHaveBeenCalled();
    } finally {
      resume();
      await Promise.all([hotSettled, coldSettled, candidate, overflow]);
    }
    expect((await hotSettled).map((result) => result.status)).toEqual(Array(8).fill('fulfilled'));
    expect((await coldSettled).map((result) => result.status)).toEqual(Array(8).fill('fulfilled'));
    expect(nativeRequests(f.scope(0).path)).toHaveLength(16);
  });

  it('never acknowledges a write held before COMMIT', async () => {
    const f = await fixture('before');
    let acknowledged = false;
    const write = f.client.write('user', metadata('held')).then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await waitForHold(f.gate!);
      expect(acknowledged).toBe(false);
      expect(count(f.path)).toBe(0);
    } finally {
      release(f.gate);
    }
    await write;
    expect(count(f.path)).toBe(1);
  });

  it('reports a lost reply as unknown even when the original receipt committed', async () => {
    const f = await fixture('after');
    const write = f.client
      .write('user', [
        {
          mode: 'run',
          sql: "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES ('original-key', 'fixture', 'original-request', '{}', 'original-hash', 'thread', 'fixture', 'fixture', 'fixture')",
          parameters: [],
        },
      ])
      .catch((error: unknown) => error);
    await waitForHold(f.gate!);
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      expect(
        reader
          .prepare('SELECT input_hash FROM idempotency_requests WHERE request_key = ?')
          .pluck()
          .get('original-key')
      ).toBe('original-hash');
    } finally {
      reader.close();
    }
    await interception.workers[0]!.terminate();
    expect(await write).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(getControlStoreWorkerClient()).toBe(f.client);
    await expect(f.client.write('user', metadata('not-replayed'))).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(interception.workers).toHaveLength(1);
  });

  it('reopens and exactly replays an execution-attempt transition after its FULL reply is lost', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-attempt-lost-ack-'));
    roots.push(root);
    ensureLayout(root);
    const coreDb = openCoreDb(root);
    nativeHandles.push(coreDb);
    applyMigrations(coreDb);
    const ownerUserId = ensureLocalUser(coreDb);
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue-attempt-lost-ack',
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: ownerUserId },
      workspaceId,
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
      turnInput: 'Retain one exact attempt transition across a lost FULL reply.',
      requestedAgentId: 'agent_worker',
    });
    const attempt = createSchedulerExecutionAttempt(coreDb, {
      entry,
      attemptId: 'attempt_00000000-0000-7000-8000-000000000001',
      preparationInput: { admission: entry },
      now: () => '2026-11-01T00:05:00.000Z',
    });
    const scope = nativeProductScope(root, { kind: 'server' });
    const database = `core:${scope.path}`;
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'after';
    const gate = new Int32Array(interception.gate);
    client = getControlStoreWorkerClient();
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const command = {
      kind: 'bind-session' as const,
      attemptId: attempt.attemptId,
      agentSessionId: 'as_00000000-0000-7000-8000-000000000001',
      observedAt: '2026-11-01T00:05:01.000Z',
    };
    const original = client.executionAttempt(database, command).catch((error: unknown) => error);
    await waitForHold(gate);
    const committed = requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    expect(committed).toMatchObject({
      agentSessionId: command.agentSessionId,
      updatedAt: command.observedAt,
    });
    await interception.workers[0]!.terminate();
    await expect(original).resolves.toMatchObject({ code: 'unavailable', commit: 'unknown' });

    interception.gate = undefined;
    await shutdownControlStoreWorkerClient();
    client = getControlStoreWorkerClient();
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    await expect(client.executionAttempt(database, command)).resolves.toEqual(committed);
    expect(requireSchedulerExecutionAttempt(coreDb, attempt.attemptId)).toEqual(committed);
  });

  it('fails closed on an unsupported reply rather than satisfying a pending command', async () => {
    const f = await fixture('before');
    const write = f.client.write('user', metadata('unknown')).catch((error: unknown) => error);
    await waitForHold(f.gate!);
    interception.workers[0]!.emit('message', {
      version: 99,
      id: 1,
      status: 'ok',
      operation: 'write',
      results: [],
    });
    expect(await write).toMatchObject({ commit: 'unknown' });
    expect(getControlStoreWorkerClient()).toBe(f.client);
  });

  it('holds backup copying until native acknowledgement and captures the complete Item closure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-backup-'));
    roots.push(root, `${root}.backups`);
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1); // Setup commits are outside the controlled publication.
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      DEMO_THREAD_ID,
      'Capture the acknowledged result.',
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID }
    );
    const capture = vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    Atomics.store(gate, 0, 0);
    let acknowledged = false;
    const publication = store
      .createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Exact immutable backup bytes.\n',
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      })
      .then((item) => {
        acknowledged = true;
        return item;
      });
    await waitForHold(gate);
    expect(posted).toHaveBeenCalled();
    expect(acknowledged).toBe(false);
    const operations = createDataRootAdminOperationImplementations(root);
    const backup = operations['backup.create']();
    let copiesWhileHeld = -1;
    let destinationWhileHeld = true;
    try {
      await nextTurn();
      copiesWhileHeld = capture.mock.calls.length;
      destinationWhileHeld = existsSync(`${root}.backups`);
    } finally {
      release(gate);
    }
    // Settle both real owners so a failed ordering check leaves no in-flight request.
    await Promise.allSettled([publication, backup]);
    expect(copiesWhileHeld).toBe(0);
    expect(destinationWhileHeld).toBe(false);
    const item = await publication;
    const result = await backup;
    expect(acknowledged).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const backupRoot = join(`${root}.backups`, result.backupId);
    const verified = dataRootBackup.verifyDataRootBackupManifest({ backupRoot });
    expect(verified.manifest).toEqual(result.manifest);
    expect(operations['backup.verify']({ backupId: result.backupId }).manifest).toEqual(
      result.manifest
    );
    expect(
      new FsStore({ dataRoot: backupRoot }).listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)
    ).toEqual([item]);
    for (const path of [coreDbPath(backupRoot), workspaceDbPath(backupRoot, DEMO_WORKSPACE_ID)]) {
      const reader = new Database(path, { readonly: true, fileMustExist: true });
      try {
        expect(reader.pragma('quick_check', { simple: true })).toBe('ok');
      } finally {
        reader.close();
      }
    }
    const reader = new Database(workspaceDbPath(backupRoot, DEMO_WORKSPACE_ID), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const entries = reader
        .prepare('SELECT content_json FROM control_product_entries ORDER BY sequence')
        .pluck()
        .all() as string[];
      expect(entries.length).toBeGreaterThan(0);
      const scope = nativeProductScope(backupRoot, turn.owner);
      for (const json of entries) {
        const content = JSON.parse(json);
        const bytes = readRetainedBodyBytes(scope.contentMount.root, content);
        expect(bytes.length).toBe(content.byteLength);
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
          content.reference.contentDigest
        );
      }
    } finally {
      reader.close();
    }
  });

  it('bounds capture waiters before posting and commits them only after backup resumes', async () => {
    const f = await fixture(undefined, 'data-root');
    roots.push(`${f.root}.backups`);
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    const operations = createDataRootAdminOperationImplementations(f.root);
    const accepted: Promise<unknown>[] = [];
    let excess: Promise<unknown> | undefined;
    let postedDuringCapture = -1;
    let rowsDuringCapture = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      accepted.push(f.client.write('user', metadata('after-capture')));
      for (let index = 1; index < CONTROL_WORKER_LIMITS.pendingTransitions; index += 1) {
        accepted.push(
          f.client.write('user', [{ mode: 'get', sql: 'SELECT 1 AS value', parameters: [] }])
        );
      }
      excess = f.client.write('user', metadata('excess')).catch((error: unknown) => error);
      postedDuringCapture = posted.mock.calls.length;
      rowsDuringCapture = count(f.path);
      return capture(input);
    });
    const result = await operations['backup.create']();
    await Promise.all(accepted);
    expect(postedDuringCapture).toBe(0);
    expect(rowsDuringCapture).toBe(0);
    expect(await excess).toMatchObject({ code: 'busy', commit: 'not-committed' });
    expect(
      count(userDbPath(join(`${f.root}.backups`, result.backupId), FIXTURE_LOCAL_USER_ID))
    ).toBe(0);
    expect(count(f.path)).toBe(1);
    expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(
      CONTROL_WORKER_LIMITS.pendingTransitions
    );
    expect(interception.workers).toHaveLength(1);
  });

  it('resumes native commands after a real backup capture failure', async () => {
    const f = await fixture(undefined, 'data-root');
    roots.push(`${f.root}.backups`);
    writeFileSync(`${f.root}.backups`, 'The private backup destination is a file.');
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    let waiting: Promise<unknown> | undefined;
    let postedDuringCapture = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      waiting = f.client.write('user', metadata('resumed'));
      postedDuringCapture = posted.mock.calls.length;
      return capture(input);
    });
    await expect(
      createDataRootAdminOperationImplementations(f.root)['backup.create']()
    ).rejects.toMatchObject({ code: 'data_root_backup_failed', status: 400 });
    expect(await waiting).toMatchObject([{ mode: 'run', changes: 1 }]);
    expect(postedDuringCapture).toBe(0);
    await expect(f.client.write('user', metadata('later'))).resolves.toMatchObject([
      { mode: 'run', changes: 1 },
    ]);
    expect(count(f.path)).toBe(2);
  });

  it('keeps posted loss unknown and unposted backup waiters not committed without replay', async () => {
    const f = await fixture('after', 'data-root');
    roots.push(`${f.root}.backups`);
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const original = f.client
      .write('user', metadata('committed-before-lost-ack'))
      .catch((error: unknown) => error);
    await waitForHold(f.gate!);
    expect(count(f.path)).toBe(1);
    const capture = vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
    const backup = createDataRootAdminOperationImplementations(f.root)
      ['backup.create']()
      .catch((error: unknown) => error);
    const waiting = f.client
      .write('user', metadata('never-posted'))
      .catch((error: unknown) => error);
    await interception.workers[0]!.terminate();
    expect(await original).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(await waiting).toMatchObject({ code: 'unavailable', commit: 'not-committed' });
    expect(await backup).toMatchObject({ code: 'data_root_backup_failed', status: 400 });
    expect(capture).not.toHaveBeenCalled();
    expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(1);
    expect(count(f.path)).toBe(1);
    expect(getControlStoreWorkerClient()).toBe(f.client);
    await expect(f.client.write('user', metadata('no-retry'))).rejects.toMatchObject({
      code: 'unavailable',
      commit: 'not-committed',
    });
    expect(interception.workers).toHaveLength(1);
  });

  it('retains closed initialization errors without exposing native diagnostic data', async () => {
    const f = await fixture();
    const bad = join(f.root, 'bad.sqlite');
    writeFileSync(bad, 'private invalid database marker');
    await expect(
      f.client.open({ database: 'bad', path: bad, create: false, initialize: 'user' })
    ).rejects.toMatchObject({ code: 'integrity' });
    await expect(
      f.client.open({
        database: 'bad-scope',
        path: join(f.root, 'unopened.sqlite'),
        create: true,
        initialize: 'app' as never,
      })
    ).rejects.toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
    await expect(f.client.write('user', metadata('healthy'))).resolves.toHaveLength(1);
  });
});

// Core Storage / Snapshot Cut And Capture Protection: a drain alone cannot authorize a moving cut.
// These tests qualify the native Core/User/Workspace/App SQL join, not mutable file-owner closure.
describe('typed global capture cut across native physical owners', () => {
  it.each(['Core', 'User', 'Workspace'] as const)(
    'captures one exact typed cut after the held %s FULL ACK and excludes later native mutations',
    async (heldScope) => {
      // Extra test-owned slots select an exact physical DB even when User and Workspace share a host.
      interception.gate = new SharedArrayBuffer(4 * (5 + 4096));
      interception.point = 'before';
      const gate = new Int32Array(interception.gate);
      Atomics.store(gate, 0, 1);
      Atomics.store(gate, 3, -1); // No setup host is selected for a COMMIT hold.
      const f = await productPoolFixture();
      roots.push(`${f.root}.backups`);
      const workspace = f.workspaces[0]!;
      const actor = { kind: 'user' as const, id: f.userId };
      const turns: Array<Awaited<ReturnType<FsStore['createTurn']>>> = [];
      for (const name of [
        'First queued work',
        'Later queued work',
        'Read membership',
        'Item publication',
      ]) {
        const thread = await f.store.createThread(workspace.id, name);
        turns.push(await f.store.createTurn(workspace.id, thread.id, name, actor));
      }
      const userTurn = turns[2]!;
      const itemTurn = turns[3]!;
      const stamp = new Date().toISOString();
      const message = (
        turn: (typeof turns)[number],
        text: string
      ): Extract<Item, { type: 'assistant-message' }> => ({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text,
        createdAt: stamp,
        completedAt: stamp,
      });
      const eligible = [
        message(userTurn, 'Actually displayed first reply.\r\n'),
        message(userTurn, 'Actually displayed later reply. 🚀'),
      ];
      for (const item of eligible) await f.store.createItem(item);
      const workspaceItems = [
        message(itemTurn, 'Included native Item bytes.\r\n'),
        message(itemTurn, 'Later native Item bytes. 🚀'),
      ];
      const coreScope = nativeProductScope(f.root, { kind: 'server' });
      const coreDatabase = `core:${coreScope.path}`;
      await f.client.open({
        database: coreDatabase,
        path: coreScope.path,
        dataRoot: f.root,
        create: false,
        initialize: 'core',
        productOwner: coreScope.owner,
        contentMount: coreScope.contentMount,
      });
      const userDb = await f.client.openInitializedUserReadDb(f.root, f.userId);
      const coreCommands = turns.slice(0, 2).map((turn, index) => ({
        mode: 'create' as const,
        entry: {
          backendId: 'nanohost',
          queueEntryId: `typed-capture-${index}-${randomUUID()}`,
          requestId: randomUUID(),
          requestedAgentId: 'agent_worker',
          timestamp: stamp,
          triggerActor: actor,
          workspaceId: workspace.id,
          threadId: turn.threadId,
          turnId: turn.id,
          turnInput:
            index === 0
              ? 'Include this original Core admission.\r\n'
              : 'Exclude this later Core admission. 🚀',
        },
      }));
      const userDatabase = `user:${userDbPath(f.root, f.userId)}`;
      const workspaceDatabase = `workspace:${workspaceDbPath(f.root, workspace.id)}`;
      const selectors = {
        Core: { operation: 'scheduler-admission', database: coreDatabase },
        User: { operation: 'thread-read-membership', database: userDatabase },
        Workspace: { operation: 'item', database: workspaceDatabase },
      };
      f.coreDb.sqlite.pragma('query_only = ON');
      const initialPosted = Promise.withResolvers<void>();
      const captureEntered = Promise.withResolvers<void>();
      const releaseCapture = Promise.withResolvers<void>();
      const initialRoles = new Set<string>();
      const frames: Array<{ operation: string; database: string; id: number }> = [];
      let initialPhase = true;
      let armed = false;
      const originalPost = Worker.prototype.postMessage;
      vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        ...args
      ) {
        const request = args[0] as { operation?: string; database?: string; id?: number };
        for (const [role, selector] of Object.entries(selectors)) {
          if (request.operation !== selector.operation || request.database !== selector.database)
            continue;
          if (typeof request.id !== 'number')
            throw new Error('Typed native frame has no request identity.');
          frames.push({ operation: request.operation, database: request.database, id: request.id });
          if (initialPhase) {
            initialRoles.add(role);
            if (role === heldScope && !armed) {
              const index = interception.workers.indexOf(this);
              if (index < 0) throw new Error('Typed mutation used an unobserved native host.');
              const selectedPath = realpathSync(
                {
                  Core: coreScope.path,
                  User: userDbPath(f.root, f.userId),
                  Workspace: workspaceDbPath(f.root, workspace.id),
                }[heldScope]
              );
              if (selectedPath.length > gate.length - 5)
                throw new Error('Owned test path does not fit its COMMIT selector.');
              for (let position = 0; position < selectedPath.length; position++)
                Atomics.store(gate, 5 + position, selectedPath.charCodeAt(position));
              Atomics.store(gate, 4, selectedPath.length);
              Atomics.store(gate, 3, index); // Exact actual host and DB, including shared-host routing.
              Atomics.store(gate, 0, 0);
              armed = true;
            }
            if (initialRoles.size === 3) initialPosted.resolve();
          }
        }
        return Reflect.apply(originalPost, this, args);
      });
      const pauseEntered = Promise.withResolvers<void>();
      let actualPauseAcquired = false;
      const pause = f.client.pauseForDataRootBackup.bind(f.client);
      vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementationOnce(async (...args) => {
        const acquiring = pause(...args);
        pauseEntered.resolve(); // The original global pause was called while the native gate is held.
        const resume = await acquiring;
        actualPauseAcquired = true; // Genuine original drain and global hold already own the cut.
        captureEntered.resolve();
        await releaseCapture.promise;
        return resume; // Exact original release; no copy/manifest result is substituted.
      });
      vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
      const tracked: Promise<unknown>[] = [];
      const track = <T>(promise: Promise<T>) => {
        tracked.push(promise);
        void promise.catch(() => {}); // Observe early failures without replacing the original result.
        return promise;
      };
      let userClosed = false;
      let backupRoot: string | undefined;
      try {
        const initialCore = track(publishSchedulerAdmission(f.coreDb, coreCommands[0]!));
        const initialUser = track(
          advanceThreadReadReceipt(userDb, workspace.id, userTurn.threadId, [eligible[0]!.id])
        );
        const initialWorkspace = track(f.store.createItem(workspaceItems[0]!));
        void Promise.all([initialCore, initialUser, initialWorkspace]).catch(initialPosted.reject);
        await initialPosted.promise; // All three actual typed frames are posted before the capture request.
        await waitForHold(gate);
        expect(armed).toBe(true);
        expect(initialRoles).toEqual(new Set(['Core', 'User', 'Workspace']));
        const settled = new Set<string>();
        for (const [name, pending] of [
          ['Core', initialCore],
          ['User', initialUser],
          ['Workspace', initialWorkspace],
        ] as const)
          void pending.then(
            () => {
              settled.add(name);
            },
            () => {}
          );
        expect(settled.has(heldScope)).toBe(false);
        if (heldScope === 'Core')
          expect(() =>
            requireSchedulerAdmissionEntry(f.coreDb, coreCommands[0]!.entry.queueEntryId)
          ).toThrow();
        if (heldScope === 'User')
          expect(readThreadReadReceipt(userDb, workspace.id, userTurn.threadId)).toEqual([]);
        if (heldScope === 'Workspace')
          expect(f.store.listThreadItems(workspace.id, itemTurn.threadId)).toEqual([]);
        const operations = createDataRootAdminOperationImplementations(f.root);
        const backup = track(operations['backup.create']());
        await Promise.race([
          pauseEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed the actual global pause entry.');
          }),
        ]);
        await nextTurn();
        expect(actualPauseAcquired).toBe(false); // Independent of the wrapper's later copy barrier.
        expect(vi.mocked(dataRootBackup.writeHotDataRootBackup)).not.toHaveBeenCalled();
        expect(existsSync(`${f.root}.backups`)).toBe(false);
        release(gate);
        await Promise.race([
          captureEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed its actual copy boundary.');
          }),
        ]);
        expect(actualPauseAcquired).toBe(true);
        const queue = await initialCore;
        expect(queue.kind).toBe('queue');
        if (queue.kind !== 'queue')
          throw new Error('Core typed admission did not retain its queue entry.');
        expect(await initialUser).toEqual([eligible[0]!.id]);
        expect(await initialWorkspace).toEqual(workspaceItems[0]);
        expect(
          requireSchedulerAdmissionEntry(f.coreDb, coreCommands[0]!.entry.queueEntryId)
        ).toEqual(queue.entry);
        expect(readThreadReadReceipt(userDb, workspace.id, userTurn.threadId)).toEqual([
          eligible[0]!.id,
        ]);
        expect(f.store.listThreadItems(workspace.id, itemTurn.threadId)).toEqual([
          workspaceItems[0],
        ]);
        initialPhase = false;
        const firstFrames = frames.slice();
        expect(firstFrames).toHaveLength(3);
        expect(new Set(firstFrames.map((frame) => frame.id)).size).toBe(3);
        const lateEntered = new Set<string>();
        const allLateEntered = Promise.withResolvers<void>();
        const entered = (name: string) => {
          lateEntered.add(name);
          if (lateEntered.size === 3) allLateEntered.resolve();
        };
        const schedulerAdmission = f.client.schedulerAdmission.bind(f.client);
        vi.spyOn(f.client, 'schedulerAdmission').mockImplementation((...args) => {
          const result = schedulerAdmission(...args);
          entered('Core');
          return result;
        });
        const membership = f.client.threadReadMembership.bind(f.client);
        vi.spyOn(f.client, 'threadReadMembership').mockImplementation((...args) => {
          const result = membership(...args);
          entered('User');
          return result;
        });
        const append = f.client.appendItem.bind(f.client);
        vi.spyOn(f.client, 'appendItem').mockImplementation((...args) => {
          const result = append(...args);
          entered('Workspace');
          return result;
        });
        let laterAcknowledged = 0;
        const laterCore = track(
          publishSchedulerAdmission(f.coreDb, coreCommands[1]!).then((value) => {
            laterAcknowledged++;
            return value;
          })
        );
        const laterUser = track(
          advanceThreadReadReceipt(userDb, workspace.id, userTurn.threadId, [eligible[1]!.id]).then(
            (value) => {
              laterAcknowledged++;
              return value;
            }
          )
        );
        const laterWorkspace = track(
          f.store.createItem(workspaceItems[1]!).then((value) => {
            laterAcknowledged++;
            return value;
          })
        );
        void Promise.all([laterCore, laterUser, laterWorkspace]).catch(allLateEntered.reject);
        await allLateEntered.promise; // Original request functions ran; a pending Promise alone is not the oracle.
        expect(laterAcknowledged).toBe(0);
        expect(frames).toEqual(firstFrames);
        expect(readThreadReadReceipt(userDb, workspace.id, userTurn.threadId)).toEqual([
          eligible[0]!.id,
        ]);
        expect(f.store.listThreadItems(workspace.id, itemTurn.threadId)).toEqual([
          workspaceItems[0],
        ]);
        expect(() =>
          requireSchedulerAdmissionEntry(f.coreDb, coreCommands[1]!.entry.queueEntryId)
        ).toThrow();
        releaseCapture.resolve();
        const captured = await backup;
        backupRoot = join(`${f.root}.backups`, captured.backupId);
        const verified = dataRootBackup.verifyDataRootBackupManifest({ backupRoot });
        expect(verified.manifest).toEqual(captured.manifest);
        const reader = new Database(coreDbPath(backupRoot), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const core = bindCoreSqlite(reader, backupRoot);
          expect(requireSchedulerAdmissionEntry(core, queue.entry.queueEntryId)).toEqual(
            queue.entry
          );
          expect(() =>
            requireSchedulerAdmissionEntry(core, coreCommands[1]!.entry.queueEntryId)
          ).toThrow();
        } finally {
          reader.close();
        }
        const capturedUser = openUserReadDb(backupRoot, f.userId);
        try {
          expect(hasPendingUserMigrations(capturedUser.sqlite)).toBe(false);
          expect(readThreadReadReceipt(capturedUser, workspace.id, userTurn.threadId)).toEqual([
            eligible[0]!.id,
          ]);
        } finally {
          capturedUser.sqlite.close();
        }
        expect(
          new FsStore({ dataRoot: backupRoot }).listThreadItems(workspace.id, itemTurn.threadId)
        ).toEqual([workspaceItems[0]]);
        const laterQueue = await laterCore;
        expect(laterQueue.kind).toBe('queue');
        if (laterQueue.kind !== 'queue')
          throw new Error('Later Core admission failed after capture release.');
        expect(await laterUser).toEqual(eligible.map((item) => item.id).sort());
        expect(await laterWorkspace).toEqual(workspaceItems[1]);
        expect(laterAcknowledged).toBe(3);
        expect(frames).toHaveLength(6);
        expect(new Set(frames.map((frame) => frame.id)).size).toBe(6);
        userDb.sqlite.close();
        userClosed = true;
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(f.root);
        const cold = new FsStore({ dataRoot: f.root });
        expect(cold.listThreadItems(workspace.id, itemTurn.threadId)).toEqual(workspaceItems);
        const liveCoreReader = new Database(coreDbPath(f.root), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const core = bindCoreSqlite(liveCoreReader, f.root);
          expect(requireSchedulerAdmissionEntry(core, queue.entry.queueEntryId)).toEqual(
            queue.entry
          );
          expect(requireSchedulerAdmissionEntry(core, laterQueue.entry.queueEntryId)).toEqual(
            laterQueue.entry
          );
        } finally {
          liveCoreReader.close();
        }
        const coldUser = openUserReadDb(f.root, f.userId);
        try {
          expect(readThreadReadReceipt(coldUser, workspace.id, userTurn.threadId)).toEqual(
            eligible.map((item) => item.id).sort()
          );
        } finally {
          coldUser.sqlite.close();
        }
      } finally {
        release(gate);
        releaseCapture.resolve();
        await Promise.allSettled(tracked);
        if (!userClosed) userDb.sqlite.close();
        closeWorkspaceProductReadHandles(f.root);
        if (backupRoot) closeWorkspaceProductReadHandles(backupRoot);
      }
    }
  );

  it('keeps a genuinely first User opening outside the captured cut until the global hold releases', async () => {
    const f = await productPoolFixture();
    roots.push(`${f.root}.backups`);
    const workspace = f.workspaces[0]!;
    const thread = await f.store.createThread(workspace.id, 'First User during capture');
    const turn = await f.store.createTurn(workspace.id, thread.id, 'Original unread reply', {
      kind: 'user',
      id: f.userId,
    });
    const item = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Read only after the original native opening ACK.\r\n',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    const path = userDbPath(f.root, f.userId);
    expect(existsSync(path)).toBe(false); // Canonical User authority and directories exist; its DB genuinely does not.
    const captureEntered = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const openEntered = Promise.withResolvers<void>();
    const pause = f.client.pauseForDataRootBackup.bind(f.client);
    vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementationOnce(async (...args) => {
      const resume = await pause(...args);
      captureEntered.resolve();
      await releaseCapture.promise;
      return resume;
    });
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const nativeOpen = f.client.open.bind(f.client);
    vi.spyOn(f.client, 'open').mockImplementation((...args) => {
      const result = nativeOpen(...args);
      if (args[0].path === path) openEntered.resolve();
      return result; // Same native request, binding, original Promise and failure.
    });
    const operations = createDataRootAdminOperationImplementations(f.root);
    const backup = operations['backup.create']();
    void backup.catch(() => {});
    let firstUser: Promise<string[]> | undefined;
    let backupRoot: string | undefined;
    let acknowledged = false;
    try {
      await Promise.race([
        captureEntered.promise,
        backup.then(() => {
          throw new Error('Backup bypassed its actual copy boundary.');
        }),
      ]);
      firstUser = f.client.openInitializedUserReadDb(f.root, f.userId).then(async (reader) => {
        acknowledged = true;
        try {
          return await advanceThreadReadReceipt(reader, workspace.id, thread.id, [item.id]);
        } finally {
          reader.sqlite.close();
        }
      });
      void firstUser.catch(() => {});
      await Promise.race([
        openEntered.promise,
        firstUser.then(() => {
          throw new Error('User mutation bypassed its native first opening.');
        }),
      ]);
      expect(acknowledged).toBe(false);
      expect(existsSync(path)).toBe(false);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.operation === 'open' && request.path === path
        )
      ).toEqual([]);
      releaseCapture.resolve();
      const captured = await backup;
      backupRoot = join(`${f.root}.backups`, captured.backupId);
      expect(dataRootBackup.verifyDataRootBackupManifest({ backupRoot }).manifest).toEqual(
        captured.manifest
      );
      expect(existsSync(userDbPath(backupRoot, f.userId))).toBe(false);
      expect(
        captured.manifest.contentInventory.some(
          (entry) => entry.path === `users/${f.userId}/db/user.sqlite`
        )
      ).toBe(false);
      expect(await firstUser).toEqual([item.id]);
      expect(acknowledged).toBe(true);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.operation === 'open' && request.path === path
        )
      ).toHaveLength(1);
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(f.root);
      const coldUser = openUserReadDb(f.root, f.userId);
      try {
        expect(hasPendingUserMigrations(coldUser.sqlite)).toBe(false);
        expect(readThreadReadReceipt(coldUser, workspace.id, thread.id)).toEqual([item.id]);
      } finally {
        coldUser.sqlite.close();
      }
      expect(new FsStore({ dataRoot: f.root }).listThreadItems(workspace.id, thread.id)).toEqual([
        item,
      ]);
    } finally {
      releaseCapture.resolve();
      await Promise.allSettled(firstUser ? [backup, firstUser] : [backup]);
      closeWorkspaceProductReadHandles(f.root);
      if (backupRoot) closeWorkspaceProductReadHandles(backupRoot);
    }
  });

  it.each(['before', 'after'] as const)(
    'captures the physical App tuple only after its original native reply held %s COMMIT and blocks later App publication',
    async (point) => {
      // Reuse the same bounded physical-path gate; mode2 samples actual FULL in its last slot.
      interception.gate = new SharedArrayBuffer(4 * (5 + 4096));
      interception.point = point;
      const gate = new Int32Array(interception.gate);
      Atomics.store(gate, 0, 1);
      Atomics.store(gate, 3, -1);
      const f = await productPoolFixture();
      roots.push(`${f.root}.backups`);
      const workspace = f.workspaces[0]!;
      const context: KernelCommandContext = {
        store: f.store,
        inflightCommands: new WeakMap(),
        dataRoot: f.root,
        workspaceId: workspace.id,
        actor: { kind: 'user', id: f.userId },
        requestId: randomUUID(),
      };
      const schema: LightAppSchemaInput = {
        format: 'openkit.light-app',
        schemaVersion: 1,
        title: 'Physical App capture',
        purpose:
          'Retain a real App record, Audit and original command receipt across a global SQL cut.',
        collections: [
          {
            name: 'entries',
            type: 'base',
            description: 'Captured entries.',
            fields: [
              { name: 'note', type: 'text', required: true, description: 'Retained exact text.' },
            ],
            indexes: [],
          },
        ],
      };
      const app = await createLightApp(context, schema);
      const seed = await createRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'entries',
        app.schemaRevision,
        { note: 'Original published App record.\r\n' }
      );
      const path = lightAppDbPath(f.root, workspace.id, app.appId);
      const physicalPath = realpathSync(path);
      const database = `app:${path}`;
      expect(existsSync(path)).toBe(true);
      const initialRequestId = randomUUID(),
        laterRequestId = randomUUID();
      const scope = { workspaceId: workspace.id, appId: app.appId };
      const firstData = { note: 'Included exact App value.\r\n' };
      const laterData = { note: 'Excluded from capture; later live value. 🚀' };
      const recordAt = (root: string) =>
        getRecord(root, workspace.id, app.appId, 'entries', seed.id, app.schemaRevision);
      const receiptAt = (root: string, requestId: string) =>
        getCommandRequestRecord(
          root,
          scope,
          commandRequestKey('kernel.records.update', requestId, scope),
          new Date().toISOString()
        );
      const auditsAt = (root: string, requestId: string) => {
        const reader = openExistingAppDb(root, workspace.id, app.appId);
        try {
          expect(reader.sqlite.readonly).toBe(true);
          expect(reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
          return listSqliteAuditEvents(reader.sqlite).filter(
            (event) => event.requestId === requestId
          );
        } finally {
          reader.sqlite.close();
        }
      };
      expect(recordAt(f.root)).toEqual(seed);
      expect(receiptAt(f.root, initialRequestId)).toBeNull();
      expect(receiptAt(f.root, laterRequestId)).toBeNull();
      f.coreDb.sqlite.pragma('query_only = ON'); // Legitimate setup-handle counterfactual; no serving Main claim.
      Atomics.store(gate, 2, 2);
      const frames: Array<{ worker: number; id: number; operation: string; database: string }> = [];
      const replies: Array<{ worker: number; id: number; operation: string; status: string }> = [];
      const removeListeners: Array<() => void> = [];
      const observedWorkers = new WeakSet<Worker>();
      let armed = false;
      const initialPosted = Promise.withResolvers<void>();
      const originalPost = Worker.prototype.postMessage;
      vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        ...args
      ) {
        const request = args[0] as { operation?: string; database?: string; id?: number };
        if (request.operation === 'app-kernel' && request.database === database) {
          const worker = interception.workers.indexOf(this);
          if (worker < 0 || typeof request.id !== 'number')
            throw new Error('App frame has no actual native host/identity.');
          frames.push({ worker, id: request.id, operation: request.operation, database });
          if (!observedWorkers.has(this)) {
            observedWorkers.add(this);
            const onReply = (value: unknown) => {
              if (value === null || typeof value !== 'object') return;
              const reply = value as { id?: number; operation?: string; status?: string };
              if (
                reply.operation === 'app-kernel' &&
                typeof reply.id === 'number' &&
                (reply.status === 'ok' || reply.status === 'error') &&
                frames.some((frame) => frame.worker === worker && frame.id === reply.id)
              )
                replies.push({
                  worker,
                  id: reply.id,
                  operation: reply.operation,
                  status: reply.status,
                });
            };
            this.on('message', onReply);
            removeListeners.push(() => this.off('message', onReply));
          }
          if (!armed) {
            if (physicalPath.length > gate.length - 6)
              throw new Error('App path leaves no bounded FULL sample slot.');
            for (let position = 0; position < physicalPath.length; position++)
              Atomics.store(gate, 5 + position, physicalPath.charCodeAt(position));
            Atomics.store(gate, 4, physicalPath.length);
            Atomics.store(gate, 3, worker);
            Atomics.store(gate, 0, 0);
            armed = true;
            initialPosted.resolve();
          }
        }
        return Reflect.apply(originalPost, this, args);
      });
      const captureEntered = Promise.withResolvers<void>();
      const releaseCapture = Promise.withResolvers<void>();
      const pauseEntered = Promise.withResolvers<void>();
      let actualPauseAcquired = false;
      const pause = f.client.pauseForDataRootBackup.bind(f.client);
      vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementationOnce(async (...args) => {
        expect(args).toEqual([]); // The actual capture uses the global hold, not an App-only hold.
        const acquiring = pause(...args);
        pauseEntered.resolve(); // The original global pause was called while the native gate is held.
        const resume = await acquiring;
        actualPauseAcquired = true;
        captureEntered.resolve();
        await releaseCapture.promise;
        return resume;
      });
      vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
      const tracked: Promise<unknown>[] = [];
      const track = <T>(promise: Promise<T>) => {
        tracked.push(promise);
        void promise.catch(() => {});
        return promise;
      };
      let initialAcknowledged = false,
        laterAcknowledged = false;
      let backupRoot: string | undefined;
      try {
        const initial = track(
          updateRecord({ ...context, requestId: initialRequestId }, app.appId, 'entries', seed.id, {
            schemaRevision: app.schemaRevision,
            expectedRecordRevision: seed.revision,
            data: firstData,
          }).then((value) => {
            initialAcknowledged = true;
            return value;
          })
        );
        await Promise.race([
          initialPosted.promise,
          initial.then(() => {
            throw new Error('App mutation returned without its actual native posting boundary.');
          }),
        ]);
        await Promise.race([
          waitForHold(gate),
          initial.then(() => {
            throw new Error('App mutation returned before its held native COMMIT boundary.');
          }),
        ]);
        expect(armed).toBe(true);
        expect(Atomics.load(gate, gate.length - 1)).toBe(2); // Actual selected native App connection is FULL.
        expect(initialAcknowledged).toBe(false);
        expect(frames).toHaveLength(1);
        expect(replies).toEqual([]);
        const heldRecord = recordAt(f.root);
        const heldReceipt = receiptAt(f.root, initialRequestId);
        const heldAudits = auditsAt(f.root, initialRequestId);
        if (point === 'before') {
          expect(heldRecord).toEqual(seed);
          expect(heldReceipt).toBeNull();
          expect(heldAudits).toEqual([]);
        } else {
          expect(heldRecord.data).toEqual(firstData);
          expect(heldRecord.revision).toBe(seed.revision + 1);
          expect(heldReceipt).toMatchObject({
            command: 'kernel.records.update',
            requestId: initialRequestId,
            response: { kind: 'light_app_record', id: seed.id },
          });
          expect(heldAudits).toHaveLength(1);
        }
        const operations = createDataRootAdminOperationImplementations(f.root);
        const backup = track(operations['backup.create']());
        await Promise.race([
          pauseEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed the actual global pause entry.');
          }),
        ]);
        await nextTurn();
        expect(actualPauseAcquired).toBe(false); // Independent of the wrapper's later copy barrier.
        expect(vi.mocked(dataRootBackup.writeHotDataRootBackup)).not.toHaveBeenCalled();
        expect(existsSync(`${f.root}.backups`)).toBe(false);
        expect(initialAcknowledged).toBe(false);
        expect(replies).toEqual([]);
        release(gate);
        await Promise.race([
          captureEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed the actual global App drain/copy boundary.');
          }),
        ]);
        expect(actualPauseAcquired).toBe(true);
        const originalRecord = await initial;
        expect(initialAcknowledged).toBe(true);
        expect(recordAt(f.root)).toEqual(originalRecord);
        expect(originalRecord.data).toEqual(firstData);
        expect(originalRecord.revision).toBe(seed.revision + 1);
        const originalReceipt = receiptAt(f.root, initialRequestId);
        expect(originalReceipt).toMatchObject({
          command: 'kernel.records.update',
          requestId: initialRequestId,
          response: { kind: 'light_app_record', id: seed.id },
        });
        const originalAudits = auditsAt(f.root, initialRequestId);
        expect(originalAudits).toHaveLength(1);
        expect(originalAudits[0]).toMatchObject({
          action: 'kernel.records.update',
          outcome: 'succeeded',
          requestId: initialRequestId,
        });
        if (point === 'after') {
          expect(originalRecord).toEqual(heldRecord);
          expect(originalReceipt).toEqual(heldReceipt);
          expect(originalAudits).toEqual(heldAudits);
        }
        expect(replies).toEqual([
          { worker: frames[0]!.worker, id: frames[0]!.id, operation: 'app-kernel', status: 'ok' },
        ]);
        const committedApp = getLightApp(f.root, workspace.id, app.appId);
        const firstFrames = frames.slice();
        const lateEntered = Promise.withResolvers<void>();
        const open = f.client.open.bind(f.client);
        vi.spyOn(f.client, 'open').mockImplementation((...args) => {
          const result = open(...args);
          if (args[0].path === path) lateEntered.resolve();
          return result;
        });
        const later = track(
          updateRecord({ ...context, requestId: laterRequestId }, app.appId, 'entries', seed.id, {
            schemaRevision: app.schemaRevision,
            expectedRecordRevision: originalRecord.revision,
            data: laterData,
          }).then((value) => {
            laterAcknowledged = true;
            return value;
          })
        );
        void later.catch(lateEntered.reject);
        await lateEntered.promise; // The real public producer entered its existing App native opening path.
        await nextTurn();
        expect(laterAcknowledged).toBe(false);
        expect(frames).toEqual(firstFrames);
        expect(replies).toHaveLength(1);
        expect(recordAt(f.root)).toEqual(originalRecord);
        expect(receiptAt(f.root, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(f.root, laterRequestId)).toBeNull();
        expect(auditsAt(f.root, initialRequestId)).toEqual(originalAudits);
        expect(auditsAt(f.root, laterRequestId)).toEqual([]);
        releaseCapture.resolve();
        const captured = await backup;
        backupRoot = join(`${f.root}.backups`, captured.backupId);
        expect(dataRootBackup.verifyDataRootBackupManifest({ backupRoot }).manifest).toEqual(
          captured.manifest
        );
        expect(
          captured.manifest.contentInventory.some(
            (entry) =>
              entry.path === `workspaces/${workspace.id}/light-apps/${app.appId}/data.sqlite`
          )
        ).toBe(true);
        expect(getLightApp(backupRoot, workspace.id, app.appId)).toEqual(committedApp);
        expect(recordAt(backupRoot)).toEqual(originalRecord);
        expect(receiptAt(backupRoot, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(backupRoot, laterRequestId)).toBeNull();
        expect(auditsAt(backupRoot, initialRequestId)).toEqual(originalAudits);
        expect(auditsAt(backupRoot, laterRequestId)).toEqual([]);
        const laterRecord = await later;
        expect(laterAcknowledged).toBe(true);
        expect(laterRecord.data).toEqual(laterData);
        expect(laterRecord.revision).toBe(originalRecord.revision + 1);
        expect(frames).toHaveLength(2);
        expect(new Set(frames.map((frame) => frame.id)).size).toBe(2);
        expect(replies).toEqual(
          frames.map((frame) => ({
            worker: frame.worker,
            id: frame.id,
            operation: 'app-kernel',
            status: 'ok',
          }))
        );
        const laterReceipt = receiptAt(f.root, laterRequestId);
        expect(laterReceipt).toMatchObject({
          command: 'kernel.records.update',
          requestId: laterRequestId,
          response: { kind: 'light_app_record', id: seed.id },
        });
        const laterAudits = auditsAt(f.root, laterRequestId);
        expect(laterAudits).toHaveLength(1);
        expect(laterAudits[0]).toMatchObject({
          action: 'kernel.records.update',
          outcome: 'succeeded',
          requestId: laterRequestId,
        });
        f.coreDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(f.root);
        expect(recordAt(f.root)).toEqual(laterRecord);
        expect(receiptAt(f.root, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(f.root, laterRequestId)).toEqual(laterReceipt);
        expect(auditsAt(f.root, initialRequestId)).toEqual(originalAudits);
        expect(auditsAt(f.root, laterRequestId)).toEqual(laterAudits);
        expect(recordAt(backupRoot)).toEqual(originalRecord);
        expect(receiptAt(backupRoot, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(backupRoot, laterRequestId)).toBeNull();
      } finally {
        release(gate);
        releaseCapture.resolve();
        await Promise.allSettled(tracked);
        for (const remove of removeListeners) remove();
        if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
        closeWorkspaceProductReadHandles(f.root);
        if (backupRoot) closeWorkspaceProductReadHandles(backupRoot);
      }
    }
  );
});

// A real native COMMIT hold decides User publication timing; awaiting a promise alone cannot prove it.
describe('User Policy covering FULL acknowledgement', () => {
  it.each(['before', 'after'] as const)(
    'holds the User decision tuple and participant Audit return %s their covering COMMIT',
    async (point) => {
      const root = mkdtempSync(join(tmpdir(), 'control-user-policy-full-'));
      roots.push(root);
      const userId = FIXTURE_LOCAL_USER_ID;
      const userDb = openUserDb(root, userId);
      try {
        applyScopedMigrations(userDb);
        userDb.sqlite.pragma('query_only = ON');
        interception.gate = new SharedArrayBuffer(8);
        interception.point = point;
        const gate = new Int32Array(interception.gate);
        Atomics.store(gate, 0, 1); // Open and initialization stay outside the measured COMMIT.
        client = getControlStoreWorkerClient();
        const database = `user:${userDbPath(root, userId)}`;
        await client.open({
          database,
          path: userDbPath(root, userId),
          create: false,
          initialize: 'user',
        });
        // SQLite value 2 is FULL on the actual native writer connection, not this Main reader.
        await expect(
          client.write(database, [
            {
              mode: 'get',
              sql: 'SELECT synchronous AS synchronization FROM pragma_synchronous',
              parameters: [],
            },
          ])
        ).resolves.toMatchObject([{ mode: 'get', row: { synchronization: 2n } }]);
        const decisionId = allocateEntityId('pd');
        const digest = `sha256:${'a'.repeat(64)}`;
        const actor = { kind: 'user' as const, id: userId };
        const event = prepareAuditEvent({
          workspaceId: null,
          action: 'policy.participant',
          category: 'approval',
          outcome: 'succeeded',
          summary: 'Completed User Policy observation.',
          actor,
          policyInvocation: {
            binding: { id: 'user-observer', digest },
            operation: 'vault.binding-replace',
            stage: 'completed',
            mode: 'observe',
            policyRevision: digest,
            authorizationRevision: digest,
            proposalDigest: digest,
            subject: {
              principal: { kind: 'human', id: userId },
              onBehalfOf: null,
              actor,
              process: null,
              credentialKind: 'local',
              responsibleHumanId: userId,
            },
            participant: { id: 'test', version: digest },
            inputDigest: digest,
            outputDigest: digest,
            outcome: 'completed',
            startedAt: '2026-10-18T00:00:00Z',
            completedAt: '2026-10-18T00:00:01Z',
            capabilityCallId: null,
          },
          now: new Date('2026-10-18T00:00:01Z'),
        });
        for (const kind of ['decision', 'participant'] as const) {
          Atomics.store(gate, 1, 0);
          Atomics.store(gate, 0, 0);
          let returned = false;
          const pending = Promise.resolve()
            .then(() =>
              kind === 'decision'
                ? recordProductPermissionDecision({
                    userDb,
                    decisionId,
                    ownerScope: 'user',
                    workspaceId: null,
                    policyEngineVersion: 'nanocore-policy:v1',
                    policySnapshotId: digest,
                    subjectSummary: { kind: 'human', id: userId },
                    action: 'vault.use',
                    resourceSummary: {
                      kind: 'container',
                      container: { kind: 'user', id: userId, owner: { kind: 'user', userId } },
                    },
                    contextSummary: {},
                    result: 'allow',
                    reasonCode: 'granted',
                    enforcementPoint: 'vault.binding-replace@decide',
                    auditActor: actor,
                  })
                : client!.userCapability(userDb, { kind: 'user-participant-audit', userId, event })
            )
            .then((value) => {
              returned = true;
              return value;
            });
          try {
            await Promise.race([
              waitForHold(gate),
              pending.then(() => {
                throw new Error('User publication returned before the real native COMMIT hold.');
              }),
            ]);
            await nextTurn();
            expect(returned).toBe(false);
            expect(Atomics.load(gate, 1)).toBe(0);
            const reader = new Database(userDbPath(root, userId), {
              readonly: true,
              fileMustExist: true,
            });
            try {
              reader.pragma('query_only = ON');
              const rows = reader
                .prepare('SELECT * FROM permission_decisions')
                .all()
                .map(readPermissionDecisionRowV1);
              const events = listSqliteAuditEvents(reader);
              expect(rows).toHaveLength(kind === 'decision' && point === 'before' ? 0 : 1);
              expect(events).toHaveLength(
                (kind === 'participant' ? 1 : 0) + (point === 'after' ? 1 : 0)
              );
              if (rows.length)
                expect(events.find((value) => value.id === rows[0]!.auditEventId)).toMatchObject({
                  permissionDecisionId: decisionId,
                  workspaceId: null,
                });
              if (kind === 'participant' && point === 'after')
                expect(events.find((value) => value.id === event.id)).toEqual(event);
            } finally {
              reader.close();
            }
          } finally {
            release(gate);
            await Promise.allSettled([pending]);
          }
          await pending;
          expect(returned).toBe(true);
        }
        const rows = userDb.sqlite
          .prepare('SELECT * FROM permission_decisions')
          .all()
          .map(readPermissionDecisionRowV1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ decisionId, ownerScope: 'user', workspaceId: null });
        const events = listSqliteAuditEvents(userDb.sqlite);
        expect(events).toHaveLength(2);
        expect(events.find((value) => value.id === rows[0]!.auditEventId)).toMatchObject({
          permissionDecisionId: decisionId,
          outcome: 'succeeded',
          workspaceId: null,
        });
        expect(events.find((value) => value.id === event.id)).toEqual(event);
      } finally {
        if (interception.gate !== undefined) release(new Int32Array(interception.gate));
        userDb.sqlite.close();
      }
    }
  );
});
