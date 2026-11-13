// openkit-test-platform: posix
/** Storage65: a retiring physical generation excludes later admissions while earlier readers finish. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { KernelCommandContext } from '../generative-kernel/commands.js';
import { createLightApp, createRecord, getRecord } from '../generative-kernel/commands.js';
import { collectionTableName, quoteIdent } from '../generative-kernel/native.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { lightAppDbPath, openExistingAppDb } from './app-db.js';
import {
  commandRequestKey,
  getCommandRequestRecord,
  getCommandRequestRecordFromDb,
} from './command-request-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { inventoryRegularFiles } from './data-root-backup.js';
import { openCoreDb, openWorkspaceReadDb } from './db.js';
import { userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

const observation = vi.hoisted(() => ({
  sequence: 0,
  requests: [] as Array<{
    worker: NativeWorker;
    message: Record<string, unknown>;
    sequence: number;
  }>,
  replies: [] as Array<{
    worker: NativeWorker;
    message: Record<string, unknown>;
    sequence: number;
  }>,
  onDrain: undefined as undefined | ((paths: readonly string[]) => void),
  userPath: '',
  holdUserAck: false,
  releaseUserAck: undefined as undefined | (() => void),
  userAckCaptured: undefined as undefined | (() => void),
  userMain: [] as Array<Database.Database>,
}));
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof Database }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const db = Reflect.construct(target, args, newTarget);
        if (args[0] === observation.userPath) observation.userMain.push(db);
        return db;
      },
    }),
  };
});
vi.mock('./control-store-product-records.js', async (load) => {
  const actual = await load<typeof import('./control-store-product-records.js')>();
  return {
    ...actual,
    drainMainScopeReadHandles: (paths: readonly string[]) => {
      const result = actual.drainMainScopeReadHandles(paths);
      observation.onDrain?.(paths);
      return result;
    },
  };
});
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        observation.requests.push({
          worker: this,
          message: args[0] as Record<string, unknown>,
          sequence: ++observation.sequence,
        });
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0];
        if (event === 'message' && typeof value === 'object' && value !== null) {
          const message = value as Record<string, unknown>;
          const request = observation.requests.find(
            (row) => row.worker === this && row.message.id === message.id
          );
          if (
            observation.holdUserAck &&
            message.operation === 'open' &&
            message.status === 'ok' &&
            request?.message.path === observation.userPath
          ) {
            if (observation.releaseUserAck)
              throw new Error('Original native User OPEN replied twice.');
            observation.releaseUserAck = () => {
              observation.releaseUserAck = undefined;
              observation.holdUserAck = false;
              observation.replies.push({ worker: this, message, sequence: ++observation.sequence });
              super.emit(event, ...args);
            };
            observation.userAckCaptured?.();
            return true;
          }
          observation.replies.push({ worker: this, message, sequence: ++observation.sequence });
        }
        return super.emit(event, ...args);
      }
    },
  };
});
type Client = ReturnType<typeof getControlStoreWorkerClient>;
type OpenInput = Parameters<Client['open']>[0];
type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
const result = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );
const readers = new Set<Database.Database>();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  observation.releaseUserAck?.();
  for (const reader of readers) if (reader.open) reader.close();
  readers.clear();
  for (const close of cleanup.splice(0).reverse()) await close();
  await shutdownControlStoreWorkerClient();
  vi.restoreAllMocks();
  observation.sequence = 0;
  observation.requests = [];
  observation.replies = [];
  observation.onDrain = undefined;
  observation.userPath = '';
  observation.userMain = [];
  observation.holdUserAck = false;
  observation.userAckCaptured = undefined;
});
function command(database: string, preserveOriginalCreate = false): OpenInput {
  const row = observation.requests.findLast(
    (row) => row.message.operation === 'open' && row.message.database === database
  );
  expect(row).toBeDefined();
  const { version: _version, id: _id, operation: _operation, ...value } = row!.message;
  return {
    ...structuredClone(value),
    ...(preserveOriginalCreate ? {} : { create: false }),
  } as unknown as OpenInput;
}
function posted(operation: string, database: string) {
  return observation.requests.filter(
    (row) => row.message.operation === operation && row.message.database === database
  );
}
function acknowledged(operation: string, database: string) {
  return posted(operation, database).flatMap((request) =>
    observation.replies.filter(
      (reply) =>
        reply.worker === request.worker &&
        reply.message.id === request.message.id &&
        reply.message.status === 'ok' &&
        reply.message.operation === operation
    )
  );
}
function expectBusy(value: Outcome<unknown>): void {
  expect(value.status, 'late admission must refuse the retiring generation').toBe('rejected');
  if (value.status !== 'rejected')
    throw new Error('A late admission joined the retiring physical generation.');
  expect(value.reason).toBeInstanceOf(ControlStoreWorkerError);
  expect(value.reason).toMatchObject({ code: 'busy', commit: 'not-committed' });
}
function draining(path: string): Promise<void> {
  return new Promise((resolve) => {
    observation.onDrain = (paths) => {
      if (paths.includes(path)) resolve();
    };
  });
}
function policy(sqlite: Database.Database): void {
  expect(sqlite.open).toBe(true);
  expect(sqlite.readonly).toBe(true);
  expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
}
const schema: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Retirement witness',
  purpose: 'Preserve actual native rows across physical generation retirement.',
  collections: [
    {
      name: 'notes',
      type: 'base',
      description: 'Retained notes.',
      fields: [{ name: 'text', type: 'text', required: true, description: 'Exact text.' }],
      indexes: [],
    },
  ],
};
async function fixture(apps = true, sibling = false) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-opening-retirement-'));
  const core = openCoreDb(root);
  applyMigrations(core);
  const userId = ensureLocalUser(core);
  cleanup.push(async () => {
    if (core.sqlite.open) core.sqlite.close();
    await disposeTestStore(root);
  });
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Retirement ownership witness');
  const client = getControlStoreWorkerClient(),
    path = workspaceDbPath(root, DEMO_WORKSPACE_ID),
    database = `workspace:${path}`;
  const workspaceCommand = command(database),
    workspace = store.getWorkspace(DEMO_WORKSPACE_ID);
  const context: KernelCommandContext = {
    dataRoot: root,
    store,
    inflightCommands: new WeakMap(),
    workspaceId: DEMO_WORKSPACE_ID,
    actor: { kind: 'user', id: userId },
    requestId: randomUUID(),
  };
  async function app(workspaceId = DEMO_WORKSPACE_ID) {
    const input = { ...context, workspaceId, requestId: randomUUID() };
    const definition = await createLightApp(input, schema),
      requestId = randomUUID();
    const record = await createRecord(
      { ...input, requestId },
      definition.appId,
      'notes',
      definition.schemaRevision,
      { text: 'Exact row retained through retirement.\r\n🚀' }
    );
    const appPath = lightAppDbPath(root, workspaceId, definition.appId),
      key = `app:${appPath}`,
      scope = { workspaceId, appId: definition.appId };
    const receipt = getCommandRequestRecord(
      root,
      scope,
      commandRequestKey('kernel.records.create', requestId, scope),
      new Date().toISOString()
    );
    expect(receipt).not.toBeNull();
    expect(
      getRecord(root, workspaceId, definition.appId, 'notes', record.id, definition.schemaRevision)
    ).toEqual(record);
    const table = quoteIdent(collectionTableName(definition.schema!.collections[0]!.id));
    return {
      definition,
      record,
      receipt,
      requestId,
      path: appPath,
      key,
      scope,
      table,
      command: command(key),
    };
  }
  const a = apps ? await app() : undefined,
    b = apps ? await app() : undefined;
  if (b) await client.close(b.key);
  let other: Awaited<ReturnType<typeof app>> | undefined;
  if (sibling) {
    const space = await store.createWorkspace('Independent sibling');
    other = await app(space.id);
    await client.close(other.key);
  }
  return {
    root,
    core,
    userId,
    store,
    thread,
    client,
    path,
    database,
    workspaceCommand,
    workspace,
    a,
    b,
    other,
  };
}
function appReader(
  f: Awaited<ReturnType<typeof fixture>>,
  app: NonNullable<Awaited<ReturnType<typeof fixture>>['a']>
) {
  const db = openExistingAppDb(f.root, app.scope.workspaceId, app.definition.appId);
  readers.add(db.sqlite);
  policy(db.sqlite);
  const row = () => db.sqlite.prepare(`SELECT * FROM ${app.table} WHERE id=?`).get(app.record.id);
  const original = row();
  expect(original).toBeDefined();
  return { db, row, original };
}
function clean(path: string) {
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
}

it('rejects a fresh child OPEN while Workspace close drains an existing App reader and joins duplicate close', async () => {
  const f = await fixture(true, true),
    a = f.a!,
    b = f.b!,
    other = f.other!;
  const held = appReader(f, a),
    entered = draining(a.path);
  const opens = posted('open', b.key).length,
    closesA = posted('close', a.key).length,
    closesW = posted('close', f.database).length;
  let settled = false;
  const closing = f.client.close(f.database).then(() => {
    settled = true;
  });
  const original = result(closing);
  await entered;
  const duplicate = result(f.client.close(f.database));
  const late = await result(f.client.open(b.command));
  try {
    await f.client.open(other.command);
    expect(acknowledged('open', other.key)).toHaveLength(2);
    expect(
      getRecord(
        f.root,
        other.scope.workspaceId,
        other.definition.appId,
        'notes',
        other.record.id,
        other.definition.schemaRevision
      )
    ).toEqual(other.record);
    expect(held.row()).toEqual(held.original);
    expect(held.db.sqlite.open).toBe(true);
    expect(settled).toBe(false);
    expect(posted('close', a.key)).toHaveLength(closesA);
    expect(posted('close', f.database)).toHaveLength(closesW);
    expectBusy(late);
    expect(posted('open', b.key)).toHaveLength(opens);
  } finally {
    held.db.sqlite.close();
    await Promise.allSettled([original, duplicate]);
  }
  expect(await original).toEqual({ status: 'fulfilled', value: undefined });
  expect(await duplicate).toEqual({ status: 'fulfilled', value: undefined });
  expect(acknowledged('close', a.key)).toHaveLength(closesA + 1);
  expect(posted('close', a.key)).toHaveLength(closesA + 1);
  expect(posted('close', f.database)).toHaveLength(closesW + 1);
  clean(a.path);
  clean(f.path);
  await f.client.open(f.workspaceCommand);
  await f.client.open(b.command);
  expect(
    getRecord(
      f.root,
      b.scope.workspaceId,
      b.definition.appId,
      'notes',
      b.record.id,
      b.definition.schemaRevision
    )
  ).toEqual(b.record);
  expect(
    getCommandRequestRecord(
      f.root,
      b.scope,
      commandRequestKey('kernel.records.create', b.requestId, b.scope),
      new Date().toISOString()
    )
  ).toEqual(b.receipt);
  await f.client.close(f.database);
  await f.client.close(other.key);
});

it('refuses late User OPEN and reader acquisition while preserving the earlier actual first-open acquisition', async () => {
  const f = await fixture(false),
    path = userDbPath(f.root, f.userId),
    key = `user:${path}`;
  expect(existsSync(path)).toBe(false);
  observation.userPath = path;
  observation.holdUserAck = true;
  let captured!: () => void;
  const ack = new Promise<void>((resolve) => {
    captured = resolve;
  });
  observation.userAckCaptured = captured;
  let acceptedReader: Awaited<ReturnType<Client['openInitializedUserReadDb']>> | undefined;
  const accepted = f.client.openInitializedUserReadDb(f.root, f.userId);
  await ack;
  const userCommand = command(key, true),
    entered = draining(path),
    closing = result(f.client.close(key));
  await entered;
  let lateOpen: Outcome<void> | undefined,
    lateRead: Outcome<Awaited<ReturnType<Client['openInitializedUserReadDb']>>> | undefined;
  const lateOpening = result(f.client.open(userCommand)).then((value) => {
    lateOpen = value;
    return value;
  });
  const lateReading = result(f.client.openInitializedUserReadDb(f.root, f.userId)).then((value) => {
    lateRead = value;
    return value;
  });
  try {
    await f.client.checkpoint(f.database); // Real sibling native ACK supplies progress while the original User ACK remains held.
    expect(lateOpen).toBeDefined();
    expect(lateRead).toBeDefined();
    expectBusy(lateOpen!);
    expectBusy(lateRead!);
    expect(posted('open', key)).toHaveLength(1);
    expect(observation.userMain).toHaveLength(0);
    expect(posted('close', key)).toHaveLength(0);
    observation.releaseUserAck!();
    acceptedReader = await accepted;
    readers.add(acceptedReader.sqlite);
    policy(acceptedReader.sqlite);
    const journal = JSON.parse(
      (await import('node:fs')).readFileSync(
        new URL('../../drizzle/user/meta/_journal.json', import.meta.url),
        'utf8'
      )
    ) as { entries: Array<{ when: number }> };
    expect(
      acceptedReader.sqlite
        .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
        .pluck()
        .all()
    ).toEqual(journal.entries.map((entry) => entry.when).sort((a, b) => a - b));
    await f.client.checkpoint(f.database);
    expect(posted('close', key)).toHaveLength(0);
    expect(observation.userMain).toHaveLength(1);
  } finally {
    observation.releaseUserAck?.();
    acceptedReader ??= await accepted;
    readers.add(acceptedReader.sqlite);
    const late = await lateReading;
    if (late.status === 'fulfilled') {
      readers.add(late.value.sqlite);
      if (late.value.sqlite.open) late.value.sqlite.close();
    }
    if (acceptedReader.sqlite.open) acceptedReader.sqlite.close();
    await Promise.allSettled([closing, lateOpening]);
  }
  expect(await closing).toEqual({ status: 'fulfilled', value: undefined });
  expect(acknowledged('close', key)).toHaveLength(1);
  clean(path);
});

it('retains failed child close ownership and refuses late admissions until the actual reader closes and retry succeeds', async () => {
  const f = await fixture(),
    a = f.a!,
    b = f.b!;
  let selected: Database.Database | undefined,
    fail = true;
  const failure = new Error('Test-owned actual App reader close failure.'),
    close = Database.prototype.close;
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    if (this === selected && fail) throw failure;
    return close.call(this);
  });
  const held = appReader(f, a);
  selected = held.db.sqlite;
  const entered = draining(a.path),
    closing = result(f.client.close(f.database));
  await entered;
  try {
    expect(() => held.db.sqlite.close()).toThrow(failure);
    expect(await closing).toEqual({ status: 'rejected', reason: failure });
    expect(held.db.sqlite.open).toBe(true);
    expect(held.row()).toEqual(held.original);
    expect(posted('close', a.key)).toHaveLength(0);
    expect(posted('close', f.database)).toHaveLength(0);
    const same = await result(f.client.open(a.command)),
      fresh = await result(f.client.open(b.command));
    expectBusy(same);
    expectBusy(fresh);
    expect(posted('open', b.key)).toHaveLength(1);
    expect(await result(f.client.close(f.database))).toEqual({
      status: 'rejected',
      reason: failure,
    });
    expect(posted('close', a.key)).toHaveLength(0);
  } finally {
    fail = false;
    if (held.db.sqlite.open) held.db.sqlite.close();
  }
  await f.client.close(f.database);
  expect(acknowledged('close', a.key)).toHaveLength(1);
  expect(acknowledged('close', f.database)).toHaveLength(1);
  clean(a.path);
  clean(f.path);
  await f.client.open(f.workspaceCommand);
  await f.client.open(a.command);
  expect(
    getRecord(
      f.root,
      a.scope.workspaceId,
      a.definition.appId,
      'notes',
      a.record.id,
      a.definition.schemaRevision
    )
  ).toEqual(a.record);
  expect(
    getCommandRequestRecord(
      f.root,
      a.scope,
      commandRequestKey('kernel.records.create', a.requestId, a.scope),
      new Date().toISOString()
    )
  ).toEqual(a.receipt);
});

it('retires the exact recovery-seal generation and joins duplicate seal without admitting OPEN or opposite close', async () => {
  const f = await fixture(false),
    reader = openWorkspaceReadDb(f.root, DEMO_WORKSPACE_ID);
  readers.add(reader.sqlite);
  policy(reader.sqlite);
  const row = () =>
    reader.sqlite
      .prepare('SELECT record_json FROM control_workspaces WHERE id=?')
      .pluck()
      .get(DEMO_WORKSPACE_ID);
  const original = row();
  expect(JSON.parse(String(original))).toEqual({
    schemaVersion: 1,
    id: f.workspace.id,
    kind: f.workspace.kind,
    status: f.workspace.status,
    createdAt: f.workspace.createdAt,
    updatedAt: f.workspace.updatedAt,
  });
  const entered = draining(f.path),
    sealing = result(f.client.sealRecovery(f.database));
  await entered;
  const duplicate = result(f.client.sealRecovery(f.database));
  try {
    expectBusy(await result(f.client.open(f.workspaceCommand)));
    expectBusy(await result(f.client.close(f.database)));
    expect(row()).toEqual(original);
    expect(reader.sqlite.open).toBe(true);
    expect(posted('recovery-seal', f.database)).toHaveLength(0);
    expect(posted('close', f.database)).toHaveLength(0);
  } finally {
    reader.sqlite.close();
    await Promise.allSettled([sealing, duplicate]);
  }
  const first = await sealing,
    second = await duplicate;
  expect(first.status).toBe('fulfilled');
  expect(second).toEqual(first);
  if (first.status !== 'fulfilled') throw first.reason;
  const digest = createHash('sha256')
    .update(JSON.stringify(inventoryRegularFiles(join(f.root, 'workspaces', DEMO_WORKSPACE_ID))))
    .digest('hex');
  expect(first.value).toBe(digest);
  expect(acknowledged('recovery-seal', f.database)).toHaveLength(1);
  expect(posted('recovery-seal', f.database)).toHaveLength(1);
  clean(f.path);
  await f.client.open(f.workspaceCommand);
  await f.client.checkpoint(f.database);
});

it('refuses a new valid same-Turn Item publication after Workspace retirement begins without changing earlier acknowledged content', async () => {
  const f = await fixture(),
    a = f.a!;
  const turn = await f.store.createTurn(
    f.a!.scope.workspaceId,
    f.thread.id,
    'Retirement Item witness',
    {
      kind: 'user',
      id: f.userId,
    }
  );
  const publish = (text: string) =>
    f.store.createItem({
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
  const first = await publish('Earlier accepted Item stays exact.\r\n🚀');
  expect(f.store.listThreadItems(a.scope.workspaceId, turn.threadId)).toEqual([first]);
  const initialItemPosts = posted('item', f.database).length;
  expect(acknowledged('item', f.database)).toHaveLength(initialItemPosts);
  const held = appReader(f, a),
    workspaceReader = openWorkspaceReadDb(f.root, a.scope.workspaceId);
  readers.add(workspaceReader.sqlite);
  policy(workspaceReader.sqlite);
  const retained = () =>
    workspaceReader.sqlite
      .prepare(
        "SELECT id, content_json FROM control_product_entries WHERE kind='item' AND turn_id=? ORDER BY sequence"
      )
      .all(turn.id) as Array<{ id: string; content_json: string }>;
  const originalRows = retained();
  expect(originalRows).toHaveLength(1);
  expect(originalRows[0]!.id).toBe(first.id);
  const entered = draining(a.path);
  let closed = false;
  const closing = result(
    f.client.close(f.database).then(() => {
      closed = true;
    })
  );
  await entered;
  const late = await result(publish('A valid later Item must not join this retiring generation.'));
  try {
    expect(closed).toBe(false);
    expect(held.db.sqlite.open).toBe(true);
    expect(held.row()).toEqual(held.original);
    expect(retained().find((row) => row.id === first.id)).toEqual(originalRows[0]);
    expect(
      getCommandRequestRecordFromDb(
        held.db,
        commandRequestKey('kernel.records.create', a.requestId, a.scope),
        new Date().toISOString()
      )
    ).toEqual(a.receipt);
    expect(posted('close', a.key)).toHaveLength(0);
    expect(posted('close', f.database)).toHaveLength(0);
    if (late.status === 'fulfilled') {
      // OLD reachability witness only: this is not an accepted product alternative.
      expect(posted('item', f.database)).toHaveLength(initialItemPosts + 1);
      expect(acknowledged('item', f.database)).toHaveLength(initialItemPosts + 1);
      expect((late.value as { text: string }).text).toBe(
        'A valid later Item must not join this retiring generation.'
      );
      expect(retained().map((row) => row.id)).toEqual([first.id, late.value.id]);
    }
    expectBusy(late);
    expect(posted('item', f.database)).toHaveLength(initialItemPosts);
    expect(retained()).toEqual(originalRows);
  } finally {
    held.db.sqlite.close();
    workspaceReader.sqlite.close();
    await closing;
  }
  expect(await closing).toEqual({ status: 'fulfilled', value: undefined });
  expect(acknowledged('close', a.key)).toHaveLength(1);
  expect(acknowledged('close', f.database)).toHaveLength(1);
  clean(a.path);
  clean(f.path);
  await f.client.open(f.workspaceCommand);
  await f.client.open(a.command);
  expect(f.store.listThreadItems(a.scope.workspaceId, turn.threadId)).toEqual([first]);
  expect(
    getRecord(
      f.root,
      a.scope.workspaceId,
      a.definition.appId,
      'notes',
      a.record.id,
      a.definition.schemaRevision
    )
  ).toEqual(a.record);
  expect(
    getCommandRequestRecord(
      f.root,
      a.scope,
      commandRequestKey('kernel.records.create', a.requestId, a.scope),
      new Date().toISOString()
    )
  ).toEqual(a.receipt);
});
