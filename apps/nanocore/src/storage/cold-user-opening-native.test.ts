/** Cold User admission through actual public owners; all Main User handles are physically query_only. */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { registerUserKnowledgeSource } from '../knowledge/scoped-knowledge-sources.js';
import { scanUserMemoryMaintenance } from '../knowledge/user-memory-schedule.js';
import * as operationContract from '../operation-contract.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { createApp } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openUserDb, openUserReadDb } from './db.js';
import { userDbPath, userMemoryRoot } from './fs-layout.js';
import {
  applyMigrations,
  applyNativeScopeMigrations,
  applyScopedMigrations,
  listAppliedNativeMigrationIds,
} from './migrate.js';
import { readThreadReadReceipt } from './thread-read-receipts.js';

const fault = vi.hoisted(() => ({
  userPath: '',
  observeMain: undefined as undefined | ((db: unknown) => void),
  observeNative: undefined as
    | undefined
    | ((event: 'posted' | 'reply', worker: NativeWorker, value: unknown) => void),
  fence: false,
  gate: new SharedArrayBuffer(8),
  handles: [] as Array<{ open: boolean; readonly: boolean }>,
  createdOnMain: 0,
  nativeOpened: 0,
  sqlErrors: [] as Array<{ code: string; operation: string }>,
  reached: undefined as undefined | (() => void),
  holdOpenAck: false,
  userOpenIds: new Set<number>(),
  heldOpen: undefined as NativeWorker | undefined,
  userHost: undefined as NativeWorker | undefined,
  ackReached: undefined as undefined | (() => void),
}));
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof import('better-sqlite3') }>();
  const { existsSync } = await import('node:fs');
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const selected = fault.fence && args[0] === fault.userPath;
        const absent = selected && !existsSync(fault.userPath);
        const db = Reflect.construct(target, args, newTarget);
        fault.observeMain?.(db);
        if (!selected) return db;
        if (absent) fault.createdOnMain++;
        fault.handles.push(db);
        db.pragma('query_only = ON');
        const remember = (error: unknown, sql: unknown) => {
          if (typeof error === 'object' && error !== null && 'code' in error) {
            const code = String(error.code),
              operation = String(sql).trim().split(/\s+/, 1)[0]!;
            fault.sqlErrors.push({ code, operation });
            console.info('Cold User actual Main SQLite refusal', { code, operation });
          }
        };
        const pragma = db.pragma;
        db.pragma = function (...args: unknown[]) {
          try {
            return Reflect.apply(pragma, this, args);
          } catch (error) {
            remember(error, 'PRAGMA');
            throw error;
          }
        };
        const exec = db.exec;
        db.exec = function (...args: unknown[]) {
          try {
            return Reflect.apply(exec, this, args);
          } catch (error) {
            remember(error, args[0]);
            throw error;
          }
        };
        const prepare = db.prepare;
        db.prepare = function (...args: unknown[]) {
          let statement: import('better-sqlite3').Statement;
          try {
            statement = Reflect.apply(prepare, this, args) as import('better-sqlite3').Statement;
          } catch (error) {
            remember(error, args[0]);
            throw error;
          }
          const run = statement.run;
          statement.run = function (...values: unknown[]) {
            try {
              return Reflect.apply(run, this, values);
            } catch (error) {
              remember(error, args[0]);
              throw error;
            }
          };
          return statement;
        };
        return db;
      },
    }),
  };
});
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private booted = false;
      private queued: Array<Parameters<NativeWorker['postMessage']>> = [];
      private instrumented = false;
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!String(filename).includes('control-store-worker')) {
          super(filename, options);
          return;
        }
        const bootstrap = `
        (async () => {
          const { parentPort, workerData } = require('node:worker_threads');
          const { createRequire } = require('node:module');
          const load = createRequire(workerData.requireFrom);
          const Original = load('better-sqlite3');
          const { realpathSync } = require('node:fs');
          const { dirname, basename, join } = require('node:path');
          const gate = new Int32Array(workerData.gate), selectedPaths = new Set(), seen = new WeakSet();
          // Observe the unchanged real open before the original receiver. User filenames are canonicalized by that owner.
          parentPort.on('message', request => {
            if (request?.operation === 'open' && request.initialize === 'user' && typeof request.path === 'string') {
              selectedPaths.add(join(realpathSync(dirname(request.path)), basename(request.path)));
            }
          });
          const prepare = Original.prototype.prepare;
          Original.prototype.prepare = function (...args) {
            // Count and hold the real writable User owner before migration SQL, not its readonly preflight.
            if (selectedPaths.has(this.name) && this.readonly === false && !seen.has(this)) {
              seen.add(this);
              parentPort.postMessage({ coldUserFixture: 'opened' });
              if (Atomics.compareExchange(gate, 0, 1, 2) === 1) {
                parentPort.postMessage({ coldUserFixture: 'before-DDL' });
                while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);
              }
            }
            return Reflect.apply(prepare, this, args);
          };
          await import(workerData.entry);
          parentPort.postMessage({ coldUserFixture: 'booted' });
        })().catch(error => { setImmediate(() => { throw error; }); });`;
        super(bootstrap, {
          ...options,
          eval: true,
          workerData: {
            entry: filename instanceof URL ? filename.href : new URL(`file://${filename}`).href,
            userPath: fault.userPath,
            gate: fault.gate,
            requireFrom: fileURLToPath(new URL('../../package.json', import.meta.url)),
          },
        });
        this.instrumented = true;
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        if (this.instrumented && !this.booted) {
          this.queued.push(args);
          return;
        }
        const request = args[0] as { id?: number; operation?: string; path?: string };
        if (
          request.operation === 'open' &&
          request.path === fault.userPath &&
          request.id !== undefined
        )
          fault.userOpenIds.add(request.id);
        fault.observeNative?.('posted', this, request);
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0] as
          | { coldUserFixture?: string; id?: number; operation?: string; status?: string }
          | undefined;
        if (
          event === 'message' &&
          fault.holdOpenAck &&
          value?.operation === 'open' &&
          value.status === 'ok' &&
          value.id !== undefined &&
          fault.userOpenIds.has(value.id)
        ) {
          fault.heldOpen = this;
          fault.ackReached?.();
          return true;
        }
        if (event === 'message' && value?.coldUserFixture) {
          if (value.coldUserFixture === 'opened') {
            fault.nativeOpened++;
            fault.userHost = this;
          }
          if (value.coldUserFixture === 'before-DDL') fault.reached?.();
          if (value.coldUserFixture === 'booted') {
            this.booted = true;
            for (const args of this.queued.splice(0)) this.postMessage(...args);
          }
          return true;
        }
        if (event === 'message') fault.observeNative?.('reply', this, value);
        return super.emit(event, ...args);
      }
    },
  };
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<void>> = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  // A failed assertion must not leave the genuine initialization ACK withheld from cleanup.
  const heldOpen = fault.heldOpen;
  fault.holdOpenAck = false;
  fault.heldOpen = undefined;
  if (heldOpen) await heldOpen.terminate();
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  await closeRetrievalServices();
  for (const close of cleanup.splice(0).reverse()) await close();
  fault.observeMain = undefined;
  fault.observeNative = undefined;
  fault.userPath = '';
  fault.fence = false;
  fault.gate = new SharedArrayBuffer(8);
  fault.handles.length = 0;
  fault.sqlErrors.length = 0;
  fault.createdOnMain = 0;
  fault.nativeOpened = 0;
  fault.reached = undefined;
  fault.holdOpenAck = false;
  fault.userOpenIds.clear();
  fault.heldOpen = undefined;
  fault.userHost = undefined;
  fault.ackReached = undefined;
});
async function fixture(server = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'cold-user-public-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  fault.userPath = userDbPath(dataRoot, userId);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Cold User fixture');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Genuine unread conversation');
  const turn = await store.createTurn(workspace.id, thread.id, 'Prompt', {
    kind: 'user',
    id: userId,
  });
  const item = await store.createItem({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'assistant-message',
    text: 'Exact unread reply.',
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const token = server
    ? createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: userId,
        scope: 'workspace',
        workspaceIds: [workspace.id],
        expiresAt: '2999-01-01T00:00:00.000Z',
      })
    : undefined;
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    ...(server ? { mode: 'server' as const } : {}),
  });
  cleanup.push(async () => {
    coreDb.sqlite.close();
    await disposeTestStore(dataRoot);
  });
  expect(existsSync(fault.userPath)).toBe(false); // Do not warm this scope in setup.
  expect(fault.nativeOpened).toBe(0);
  const call = async (operation: string, input: Record<string, unknown> = {}) => {
    const { requestId, ...body } = input;
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        ...(token ? { authorization: `Bearer ${token.secret}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const bodyIsJson = contentType.includes('application/json') || contentType.includes('+json');
    return {
      status: response.status,
      body: bodyIsJson ? await response.json() : await response.text(),
    };
  };
  return {
    dataRoot,
    coreDb,
    userId,
    store,
    workspace,
    thread,
    turn,
    item,
    call,
    token,
    owner: { workspaceId: workspace.id, threadId: thread.id },
  };
}
function assertNativeOpening() {
  expect(fault.nativeOpened).toBe(1);
  expect(fault.createdOnMain).toBe(0);
  expect(fault.sqlErrors).toEqual([]);
  expect(fault.handles.length).toBeGreaterThan(0);
  expect(fault.handles.every((db) => db.readonly && !db.open)).toBe(true);
  expect(existsSync(fault.userPath)).toBe(true);
}
for (const operation of [
  'memory.create',
  'thread.read-state',
  'thread.mark-read',
  'conversation.navigation',
] as const) {
  it(`natively admits a genuinely absent User DB before public ${operation} with Main query_only`, async () => {
    const f = await fixture();
    fault.fence = true;
    let input: Record<string, unknown> = f.owner;
    const content = serializeKnowledgePageFixture(
      {
        title: 'My preference',
        content: 'Keep this exact cold preference.\r\n',
        sourceReferences: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId: f.userId }
    );
    if (operation === 'memory.create')
      input = {
        requestId: randomUUID(),
        baseRevision: null,
        pageId: 'preferences',
        content,
        summary: 'First public save',
      };
    if (operation === 'thread.mark-read') input = { ...f.owner, itemIds: [f.item.id] };
    if (operation === 'conversation.navigation') input = { workspaceId: f.workspace.id };
    const result = await f.call(operation, input);
    expect(result.status).toBe(200);
    if (operation === 'thread.read-state')
      expect(result.body).toEqual({ readItemIds: [], unreadItemIds: [f.item.id] });
    if (operation === 'thread.mark-read')
      expect(result.body).toEqual({ readItemIds: [f.item.id], unreadItemIds: [] });
    if (operation === 'conversation.navigation')
      expect(
        result.body.items.find((row: { thread: { id: string } }) => row.thread.id === f.thread.id)
      ).toMatchObject({ unreadCount: 1 });
    if (operation === 'memory.create')
      expect(await f.call('memory.read', { pageId: 'preferences' })).toMatchObject({
        status: 200,
        body: { page: { content } },
      });
    assertNativeOpening();
    const reader = openUserReadDb(f.dataRoot, f.userId);
    try {
      expect(readThreadReadReceipt(reader, f.workspace.id, f.thread.id)).toEqual(
        operation === 'thread.mark-read' ? [f.item.id] : []
      );
    } finally {
      reader.sqlite.close();
    }
  });
}
it('native User opening precedes the scheduled Memory dependency-preparation boundary', async () => {
  const f = await fixture();
  const dependencies = vi.fn((db: { sqlite: { open: boolean; readonly: boolean } }) => {
    expect(db.sqlite.open).toBe(true);
    expect(db.sqlite.readonly).toBe(true);
    throw new Error('Synthetic dependency factory stop after genuine User admission.');
  });
  const runtimeConfigManager = {
    current: () => ({
      userConfigs: [
        {
          userId: f.userId,
          config: {
            knowledgeMaintenance: {
              enabled: true,
              schedule: { enabled: true },
              reviewRequiredPageIds: [],
            },
          },
        },
      ],
    }),
  } as unknown as RuntimeConfigManager;
  fault.fence = true;
  await scanUserMemoryMaintenance({
    now: '2026-10-18T00:00:00.000Z',
    coreDb: f.coreDb,
    store: f.store,
    runtimeConfigManager,
    localUserId: f.userId,
    dependencies,
  });
  expect(dependencies).toHaveBeenCalledTimes(1);
  assertNativeOpening(); // Only owner prefix qualified here; no Provider/Turn/inference success claim.
});
it('joins the exact pending first-create before a second public owner can read the User schema', async () => {
  const f = await fixture();
  fault.fence = true;
  const gate = new Int32Array(fault.gate),
    held = deferred(),
    secondEntered = deferred();
  fault.reached = held.resolve;
  Atomics.store(gate, 0, 1);
  const first = f.call('thread.read-state', f.owner);
  pending.push(first);
  await Promise.race([
    held.promise,
    first.then(() => {
      throw new Error('First public call bypassed genuine native constructor hold');
    }),
  ]);
  expect(existsSync(fault.userPath)).toBe(true);
  expect(fault.handles).toEqual([]); // Native file exists but its schema has not yet been admitted.
  const originalActor = operationContract.publicOperationActor;
  vi.spyOn(operationContract, 'publicOperationActor').mockImplementation((...args) => {
    const actor = originalActor(...args);
    secondEntered.resolve();
    return actor;
  });
  const second = f.call('conversation.navigation', { workspaceId: f.workspace.id });
  pending.push(second);
  await secondEntered.promise; // Genuine source admission before any possible native-opening join.
  expect(fault.handles).toEqual([]);
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  expect(await first).toEqual({
    status: 200,
    body: { readItemIds: [], unreadItemIds: [f.item.id] },
  });
  expect((await second).status).toBe(200);
  assertNativeOpening();
});
it('rechecks a genuinely revoked credential after native User initialization before mark-read publication', async () => {
  const f = await fixture(true);
  fault.fence = true;
  const gate = new Int32Array(fault.gate),
    held = deferred();
  fault.reached = held.resolve;
  Atomics.store(gate, 0, 1);
  const first = f.call('thread.mark-read', { ...f.owner, itemIds: [f.item.id] });
  pending.push(first);
  await Promise.race([
    held.promise,
    first.then(() => {
      throw new Error('Mark-read bypassed genuine native constructor hold');
    }),
  ]);
  expect(fault.handles).toEqual([]);
  const revoked = revokeOpenKitAccessTokenRecord(f.coreDb, f.token!.tokenId);
  expect(revoked).toMatchObject({ status: 'revoked' });
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  const result = await first;
  // Already-admitted rechecks retain the existing Workspace denial; initial HTTP authentication separately returns401.
  expect(result.status).toBe(403);
  expect(result.body).toMatchObject({ code: 'workspace_access_denied' });
  expect(JSON.stringify(result.body)).not.toContain(f.item.id);
  const reader = openUserReadDb(f.dataRoot, f.userId);
  try {
    expect(readThreadReadReceipt(reader, f.workspace.id, f.thread.id)).toEqual([]);
  } finally {
    reader.sqlite.close();
  }
  expect(fault.createdOnMain).toBe(0);
  expect(fault.nativeOpened).toBe(1);
  expect(fault.sqlErrors).toEqual([]);
});
/** Exact surviving synthetic fixture bytes, keyed by canonical relative pathname. */
function retainedTree(root: string): Array<[string, Buffer]> {
  if (!existsSync(root)) return [];
  const rows: Array<[string, Buffer]> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) rows.push([relative(root, path), readFileSync(path)]);
      else
        throw new Error(
          'Synthetic surviving authority tree must contain only ordinary files/directories.'
        );
    }
  };
  visit(root);
  return rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
for (const survivor of ['Notebook', 'Source', 'default-KB-binding'] as const) {
  it(`refuses to initialize a missing established User DB when only its ${survivor} proof survives`, async () => {
    const f = await fixture();
    const content = serializeKnowledgePageFixture(
      {
        title: 'Established preference',
        content: 'Keep this original preference.\r\n',
        sourceReferences: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId: f.userId }
    );
    const first = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'preferences',
      content,
      summary: 'Original first save',
    });
    expect(first.status).toBe(200);
    const memoryRoot = userMemoryRoot(f.dataRoot, f.userId);
    const userRoot = dirname(memoryRoot),
      sourcesRoot = join(memoryRoot, 'raw', 'sources'),
      config = join(userRoot, 'config', 'user.jsonc');
    if (survivor === 'Source') {
      const userDb = openUserReadDb(f.dataRoot, f.userId);
      try {
        const source = await registerUserKnowledgeSource(
          {
            coreDb: f.coreDb,
            userDb,
            store: f.store,
            actor: { kind: 'local', userId: f.userId },
            inflightCommands: new WeakMap(),
          },
          {
            requestId: randomUUID(),
            kind: 'document',
            title: 'Exact retained source metadata',
            content: 'Synthetic literal source.\r\n',
          }
        );
        expect(source.id).toBeTruthy();
        expect(readFileSync(join(sourcesRoot, source.id, 'original'), 'utf8')).toBe(
          'Synthetic literal source.\r\n'
        );
      } finally {
        userDb.sqlite.close();
      }
      expect(existsSync(sourcesRoot)).toBe(true);
    }
    // Loss injection starts only after genuine owner publication and full writer/reader shutdown.
    await closeRetrievalServices();
    await shutdownControlStoreWorkerClient();
    for (const path of [fault.userPath, `${fault.userPath}-wal`, `${fault.userPath}-shm`])
      rmSync(path, { force: true });
    if (survivor === 'Source') {
      // Genuine managed Source bytes live inside the Notebook root; retain only their original raw subtree.
      for (const entry of readdirSync(memoryRoot))
        if (entry !== 'raw') rmSync(join(memoryRoot, entry), { recursive: true, force: true });
      for (const entry of readdirSync(join(memoryRoot, 'raw')))
        if (entry !== 'sources')
          rmSync(join(memoryRoot, 'raw', entry), { recursive: true, force: true });
      expect(existsSync(join(memoryRoot, 'notebook.git'))).toBe(false);
    } else if (survivor !== 'Notebook') rmSync(memoryRoot, { recursive: true, force: true });
    if (survivor !== 'Source') rmSync(sourcesRoot, { recursive: true, force: true });
    if (survivor !== 'default-KB-binding') rmSync(config, { force: true });
    const keptRoot =
      survivor === 'Notebook' ? memoryRoot : survivor === 'Source' ? sourcesRoot : dirname(config);
    const before = retainedTree(keptRoot);
    expect(before.length).toBeGreaterThan(0);
    expect(existsSync(fault.userPath)).toBe(false);
    expect(existsSync(memoryRoot)).toBe(survivor === 'Notebook' || survivor === 'Source');
    expect(existsSync(sourcesRoot)).toBe(survivor === 'Source');
    expect(existsSync(config)).toBe(survivor === 'default-KB-binding');
    fault.nativeOpened = 0;
    fault.handles.length = 0;
    fault.fence = true;
    const refused = await f.call('memory.create', {
      requestId: randomUUID(),
      baseRevision: null,
      pageId: 'replacement',
      content,
      summary: 'Must not replace lost established authority',
    });
    expect(refused).toMatchObject({ status: 503, body: { code: 'recovery_required' } });
    expect(existsSync(fault.userPath)).toBe(false);
    expect(fault.createdOnMain).toBe(0);
    expect(fault.nativeOpened).toBe(0);
    expect(fault.handles).toEqual([]);
    expect(retainedTree(keptRoot)).toEqual(before);
  });
}
it('retains native User initialization after a genuinely lost opening ACK without replacement or automatic repost', async () => {
  const f = await fixture();
  fault.fence = true;
  const ack = deferred();
  fault.holdOpenAck = true;
  fault.ackReached = ack.resolve;
  const client = getControlStoreWorkerClient(),
    original = client.open.bind(client);
  const errors: unknown[] = [];
  vi.spyOn(client, 'open').mockImplementation((...args) => {
    const result = original(...args);
    if (args[0].path === fault.userPath)
      void result.catch((error) => {
        errors.push(error);
      });
    return result; // Original promise/result/error unchanged.
  });
  const first = f.call('thread.mark-read', { ...f.owner, itemIds: [f.item.id] });
  pending.push(first);
  await Promise.race([
    ack.promise,
    first.then(() => {
      throw new Error('Public mark-read settled before the genuine User opening ACK');
    }),
  ]);
  expect(fault.nativeOpened).toBe(1);
  expect(fault.userOpenIds.size).toBe(1);
  expect(fault.handles).toEqual([]);
  const inode = statSync(fault.userPath).ino;
  const retained = openUserReadDb(f.dataRoot, f.userId);
  let migrations: string[];
  try {
    migrations = listAppliedNativeMigrationIds(retained.sqlite, 'user');
    expect(migrations.length).toBeGreaterThan(0);
    expect(readThreadReadReceipt(retained, f.workspace.id, f.thread.id)).toEqual([]);
  } finally {
    retained.sqlite.close();
  }
  // Drop only the actual ACK by terminating/joining its owning native host, never fabricate an error.
  await fault.heldOpen!.terminate();
  expect((await first).status).toBe(500);
  expect(errors).toContainEqual(expect.any(ControlStoreWorkerError));
  expect(errors).toContainEqual(
    expect.objectContaining({ code: 'unavailable', commit: 'unknown' })
  );
  const retry = await f.call('thread.mark-read', { ...f.owner, itemIds: [f.item.id] });
  expect(retry.status).toBe(500);
  expect(fault.userOpenIds.size).toBe(1);
  expect(fault.nativeOpened).toBe(1);
  expect(statSync(fault.userPath).ino).toBe(inode);
  const cold = openUserReadDb(f.dataRoot, f.userId);
  try {
    expect(listAppliedNativeMigrationIds(cold.sqlite, 'user')).toEqual(migrations);
    expect(readThreadReadReceipt(cold, f.workspace.id, f.thread.id)).toEqual([]);
  } finally {
    cold.sqlite.close();
  }
  expect(fault.createdOnMain).toBe(0);
  expect(fault.sqlErrors).toEqual([]);
});
it('natively upgrades an authentic original User journal prefix before readonly public mark-read', async () => {
  const f = await fixture();
  const originalRoot = fileURLToPath(new URL('../../drizzle/user/', import.meta.url));
  const journal = JSON.parse(readFileSync(join(originalRoot, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const prefix = join(f.dataRoot, 'isolated-original-user-journal');
  mkdirSync(join(prefix, 'meta'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(prefix, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) })
  );
  copyFileSync(
    join(originalRoot, `${journal.entries[0]!.tag}.sql`),
    join(prefix, `${journal.entries[0]!.tag}.sql`)
  );
  // Explicit isolated setup uses the original owner+original SQL, not hand-authored historical tables/rows.
  const old = openUserDb(f.dataRoot, f.userId);
  let before: unknown[];
  try {
    applyNativeScopeMigrations(old.sqlite, 'user', prefix);
    before = old.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
    expect(listAppliedNativeMigrationIds(old.sqlite, 'user')).toEqual([
      `user_${journal.entries[0]!.tag}`,
    ]);
  } finally {
    old.sqlite.close();
  }
  const inode = statSync(fault.userPath).ino;
  fault.fence = true;
  expect(await f.call('thread.mark-read', { ...f.owner, itemIds: [f.item.id] })).toEqual({
    status: 200,
    body: { readItemIds: [f.item.id], unreadItemIds: [] },
  });
  assertNativeOpening();
  const reader = openUserReadDb(f.dataRoot, f.userId);
  try {
    expect(listAppliedNativeMigrationIds(reader.sqlite, 'user')).toEqual(
      journal.entries.map((entry) => `user_${entry.tag}`).sort()
    );
    expect(
      reader.sqlite
        .prepare('SELECT * FROM __drizzle_migrations ORDER BY id')
        .all()
        .slice(0, before.length)
    ).toEqual(before);
    expect(readThreadReadReceipt(reader, f.workspace.id, f.thread.id)).toEqual([f.item.id]);
  } finally {
    reader.sqlite.close();
  }
  expect(statSync(fault.userPath).ino).toBe(inode);
});
it('keeps acknowledged User receipts readable after their native host later dies', async () => {
  const f = await fixture();
  // Actual owner admission settles first; this differs from a lost first-initialization ACK.
  expect(await f.call('thread.mark-read', { ...f.owner, itemIds: [f.item.id] })).toEqual({
    status: 200,
    body: { readItemIds: [f.item.id], unreadItemIds: [] },
  });
  const host = fault.userHost;
  expect(host).toBeDefined();
  const count = fault.userOpenIds.size,
    inode = statSync(fault.userPath).ino;
  await host!.terminate();
  fault.fence = true;
  fault.handles.length = 0;
  expect(await f.call('thread.read-state', f.owner)).toEqual({
    status: 200,
    body: { readItemIds: [f.item.id], unreadItemIds: [] },
  });
  const navigation = await f.call('conversation.navigation', { workspaceId: f.workspace.id });
  expect(navigation.status).toBe(200);
  expect(
    navigation.body.items.find((row: { thread: { id: string } }) => row.thread.id === f.thread.id)
  ).toMatchObject({ unreadCount: 0 });
  expect(fault.userOpenIds.size).toBe(count);
  expect(statSync(fault.userPath).ino).toBe(inode);
  expect(fault.createdOnMain).toBe(0);
  expect(fault.sqlErrors).toEqual([]);
  expect(fault.handles.every((db) => db.readonly && !db.open)).toBe(true);
});
it('keeps original unsupported predecessor-ledger refusal when native User journal is otherwise current', async () => {
  const f = await fixture();
  const setup = openUserDb(f.dataRoot, f.userId);
  let before: string[];
  try {
    applyScopedMigrations(setup);
    before = listAppliedNativeMigrationIds(setup.sqlite, 'user');
    expect(before.length).toBeGreaterThan(0);
    // Deliberate retained-format fault, not an authoritative product/receipt seed.
    setup.sqlite.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)');
  } finally {
    setup.sqlite.close();
  }
  fault.fence = true;
  expect((await f.call('thread.read-state', f.owner)).status).toBe(500);
  // Inspect the deliberate retained-format fault without invoking ordinary serving admission again.
  const reader = {
    scope: 'user' as const,
    dataRoot: f.dataRoot,
    userId: f.userId,
    sqlite: new Database(fault.userPath, { readonly: true, fileMustExist: true }),
  };
  try {
    expect(listAppliedNativeMigrationIds(reader.sqlite, 'user')).toEqual(before);
    expect(
      reader.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get()
    ).toEqual({ name: 'schema_migrations' });
    expect(readThreadReadReceipt(reader, f.workspace.id, f.thread.id)).toEqual([]);
  } finally {
    reader.sqlite.close();
  }
  expect(fault.nativeOpened).toBe(0);
  expect(fault.createdOnMain).toBe(0);
});

it('acknowledges the existing native User owner before returning a cold current reader and closes at rest', async () => {
  const f = await fixture();
  const exactReceipt = { status: 200, body: { readItemIds: [f.item.id], unreadItemIds: [] } };
  expect(await f.call('thread.mark-read', { ...f.owner, itemIds: [f.item.id] })).toEqual(
    exactReceipt
  );
  const setup = openUserReadDb(f.dataRoot, f.userId);
  let journal: unknown[];
  let schema: unknown[];
  try {
    journal = setup.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
    schema = setup.sqlite
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
      )
      .all();
    expect(journal.length).toBeGreaterThan(0);
    expect(readThreadReadReceipt(setup, f.workspace.id, f.thread.id)).toEqual([f.item.id]);
  } finally {
    setup.sqlite.close();
  }
  const identity = statSync(fault.userPath);
  const client = getControlStoreWorkerClient();
  const database = `user:${fault.userPath}`;
  let sequence = 0;
  let phase = 'initial-close';
  type Command = {
    id: number;
    operation: string;
    path?: string;
    create?: boolean;
    initialize?: string;
    phase: string;
    posted: number;
  };
  const requests = new Map<NativeWorker, Map<number, Command>>();
  const acks: Array<Command & { acknowledged: number }> = [];
  const errors: Command[] = [];
  const constructors = new Map<
    Database.Database,
    {
      constructed: number;
      readonly: boolean;
      closeCalls: number;
      closeQueryOnly?: unknown;
      closed?: boolean;
      closedAt?: number;
    }
  >();
  fault.observeNative = (event, worker, value) => {
    if (typeof value !== 'object' || value === null) return;
    const message = value as {
      id?: number;
      operation?: string;
      database?: string;
      path?: string;
      create?: boolean;
      initialize?: string;
      status?: string;
    };
    if (typeof message.id !== 'number') return;
    if (event === 'posted') {
      if (
        message.database !== database &&
        !(message.operation === 'shutdown' && requests.has(worker))
      )
        return;
      if (!message.operation) return;
      if (!requests.has(worker)) requests.set(worker, new Map());
      requests.get(worker)!.set(message.id, {
        id: message.id,
        operation: message.operation,
        path: message.path,
        create: message.create,
        initialize: message.initialize,
        phase,
        posted: ++sequence,
      });
      return;
    }
    const command = requests.get(worker)?.get(message.id);
    if (!command) return;
    requests.get(worker)!.delete(message.id);
    if (message.status === 'ok') acks.push({ ...command, acknowledged: ++sequence });
    else errors.push(command);
  };
  let reader: Awaited<ReturnType<typeof client.openInitializedUserReadDb>> | undefined;
  try {
    await client.close(database);
    expect(acks.some((row) => row.phase === 'initial-close' && row.operation === 'close')).toBe(
      true
    );
    expect({
      wal: existsSync(`${fault.userPath}-wal`),
      shm: existsSync(`${fault.userPath}-shm`),
    }).toEqual({ wal: false, shm: false });
    expect(fault.fence).toBe(false); // This lane observes real query policy; it never injects query_only.
    fault.observeMain = (value) => {
      const sqlite = value as Database.Database;
      if (sqlite.name !== fault.userPath) return;
      const row = { constructed: ++sequence, readonly: sqlite.readonly, closeCalls: 0 } as {
        constructed: number;
        readonly: boolean;
        closeCalls: number;
        closeQueryOnly?: unknown;
        closed?: boolean;
        closedAt?: number;
      };
      constructors.set(sqlite, row);
      const close = sqlite.close;
      sqlite.close = function () {
        row.closeQueryOnly = this.pragma('query_only', { simple: true });
        try {
          return close.call(this);
        } finally {
          row.closeCalls++;
          row.closed = !this.open;
          row.closedAt = ++sequence;
        }
      };
    };
    phase = 'reopen';
    reader = await client.openInitializedUserReadDb(f.dataRoot, f.userId);
    const returnedAt = ++sequence;
    expect(reader.sqlite.readonly).toBe(true);
    expect(reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(readThreadReadReceipt(reader, f.workspace.id, f.thread.id)).toEqual([f.item.id]);
    expect(reader.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(
      journal
    );
    expect(
      reader.sqlite
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
        )
        .all()
    ).toEqual(schema);
    expect({ dev: statSync(fault.userPath).dev, ino: statSync(fault.userPath).ino }).toEqual({
      dev: identity.dev,
      ino: identity.ino,
    });
    const admitted = acks.filter((row) => row.phase === 'reopen' && row.operation === 'open');
    expect(
      admitted,
      `Actual matching native owner acknowledgements: ${JSON.stringify(acks)}`
    ).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ path: fault.userPath, create: false, initialize: 'user' });
    const actualConstructor = constructors.get(reader.sqlite);
    expect(actualConstructor).toBeDefined();
    expect(actualConstructor!.readonly).toBe(true);
    expect(actualConstructor!.constructed).toBeGreaterThan(admitted[0]!.acknowledged);
    expect(returnedAt).toBeGreaterThan(admitted[0]!.acknowledged);
    let code: string | undefined;
    reader.sqlite.exec('SAVEPOINT cold_current_user_read_challenge');
    try {
      reader.sqlite
        .prepare(
          'DELETE FROM __drizzle_migrations WHERE id = (SELECT id FROM __drizzle_migrations ORDER BY id LIMIT 1)'
        )
        .run();
    } catch (error) {
      code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'UNCLASSIFIED';
    } finally {
      reader.sqlite.exec('ROLLBACK TO cold_current_user_read_challenge');
      reader.sqlite.exec('RELEASE cold_current_user_read_challenge');
    }
    expect(code).toBe('SQLITE_READONLY');
    expect(reader.sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(
      journal
    );
    expect(await f.call('thread.read-state', f.owner)).toEqual(exactReceipt);
    reader.sqlite.close();
    expect(constructors.size).toBeGreaterThan(0);
    for (const [sqlite, row] of constructors) {
      expect(row.readonly).toBe(true);
      expect(row.closeQueryOnly).toBe(1);
      expect(row.closeCalls).toBe(1);
      expect(row.closed).toBe(true);
      expect(sqlite.open).toBe(false);
    }
    phase = 'final-user-close';
    await client.close(database);
    const closed = acks.filter(
      (row) => row.phase === 'final-user-close' && row.operation === 'close'
    );
    expect(closed).toHaveLength(1);
    for (const row of constructors.values())
      expect(row.closedAt!).toBeLessThan(closed[0]!.acknowledged);
    expect({
      wal: existsSync(`${fault.userPath}-wal`),
      shm: existsSync(`${fault.userPath}-shm`),
    }).toEqual({ wal: false, shm: false });
    phase = 'shutdown';
    await shutdownControlStoreWorkerClient();
    expect(acks.some((row) => row.phase === 'shutdown' && row.operation === 'shutdown')).toBe(true);
    expect(errors).toEqual([]);
    expect([...requests.values()].every((pending) => pending.size === 0)).toBe(true);
    expect({
      wal: existsSync(`${fault.userPath}-wal`),
      shm: existsSync(`${fault.userPath}-shm`),
    }).toEqual({ wal: false, shm: false });
    expect({ dev: statSync(fault.userPath).dev, ino: statSync(fault.userPath).ino }).toEqual({
      dev: identity.dev,
      ino: identity.ino,
    });
  } finally {
    if (reader?.sqlite.open) reader.sqlite.close();
    fault.observeMain = undefined;
    fault.observeNative = undefined;
  }
});
