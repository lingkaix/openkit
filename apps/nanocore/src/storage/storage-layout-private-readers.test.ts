// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { StorageLayoutReportResponseSchema } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openUserReadDb } from './db.js';
import { userDbPath } from './fs-layout.js';
import { applyMigrations, listAppliedNativeMigrationIds } from './migrate.js';

const observation = vi.hoisted(() => ({
  path: '',
  root: '',
  armed: false,
  reportContext: undefined as undefined | import('node:async_hooks').AsyncLocalStorage<boolean>,
  failures: [] as Array<{ name: string; message: string; stack: string | undefined }>,
  sourceConstructors: [] as string[],
  activeSources: new Map<
    object,
    { source: string; suffix: string; dev: string; ino: string; bytes: string; sha256: string }
  >(),
  copies: new Map<
    string,
    {
      source: string;
      suffix: string;
      dev: string;
      ino: string;
      bytes: string;
      sha256: string;
      outputDev: string;
      outputIno: string;
    }
  >(),
  removed: [] as string[],
  cleanupFailures: [] as string[],
  failCleanup: false,
  copyReached: undefined as undefined | (() => void),
  copyRelease: undefined as undefined | Promise<void>,
  holdReply: false,
  heldReply: undefined as undefined | (() => void),
  replyReached: undefined as undefined | (() => void),
  restoreFs: undefined as undefined | (() => void),
  handles: [] as Array<{
    path: string;
    readonly: boolean;
    queryOnly: unknown;
    closed: boolean;
    dmlCode: unknown;
    facts: unknown;
  }>,
  posted: [] as Array<{ worker: NativeWorker; message: Record<string, unknown> }>,
  replies: [] as Array<{ worker: NativeWorker; message: Record<string, unknown> }>,
}));
function facts(sqlite: Database.Database) {
  return {
    ledger: sqlite
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='__drizzle_migrations'")
      .get()
      ? sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()
      : null,
    schema: sqlite
      .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
      .all(),
    tables: sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
    receipts: sqlite
      .prepare('SELECT * FROM thread_read_receipts ORDER BY workspace_id,thread_id')
      .all(),
  };
}
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  const filesystem = await import('node:fs');
  const module = await import('node:module');
  const originalOpen = filesystem.promises.open;
  const originalRemove = filesystem.promises.rm;
  const open: typeof originalOpen = async (...args) => {
    const file = await originalOpen(...args);
    if (!observation.armed || !observation.reportContext?.getStore()) return file;
    const metadata = await file.stat({ bigint: true });
    if (!metadata.isFile()) return file;
    const path = readlinkSync(`/proc/self/fd/${file.fd}`);
    const suffix = ['', '-wal', '-journal'].find((value) => path === `${observation.path}${value}`);
    if (suffix !== undefined) {
      const bytes = readFileSync(`/proc/self/fd/${file.fd}`);
      observation.activeSources.set(file, {
        source: path,
        suffix,
        dev: String(metadata.dev),
        ino: String(metadata.ino),
        bytes: String(metadata.size),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const close = file.close.bind(file);
      file.close = async () => {
        try {
          return await close();
        } finally {
          observation.activeSources.delete(file);
        }
      };
    } else if (args[1] === 'wx' && observation.activeSources.size === 1) {
      const source = [...observation.activeSources.values()][0]!;
      const close = file.close.bind(file);
      file.close = async () => {
        const before = await file.stat({ bigint: true });
        await close();
        const current = lstatSync(path, { bigint: true });
        if (
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.size !== before.size ||
          file.fd !== -1
        )
          throw new Error('Observed private copy changed across its actual physical close.');
        const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
        if (String(current.size) !== source.bytes || sha256 !== source.sha256)
          throw new Error(
            'Observed private copy differs from its actual selected source descriptor.'
          );
        observation.copies.set(path, {
          ...source,
          outputDev: String(current.dev),
          outputIno: String(current.ino),
        });
        if (source.suffix === '' && observation.copyReached) {
          observation.copyReached();
          await observation.copyRelease;
        }
      };
    }
    return file;
  };
  const rm: typeof originalRemove = async (...args) => {
    const scratch = String(args[0]);
    const selected = [...observation.copies.entries()].some(
      ([path, copy]) => copy.suffix === '' && dirname(path) === scratch
    );
    if (observation.armed && selected && observation.failCleanup) {
      observation.cleanupFailures.push(scratch);
      throw new Error('Test-owned actual private cleanup refusal.');
    }
    await originalRemove(...args);
    if (observation.armed && selected) observation.removed.push(scratch);
  };
  Reflect.set(filesystem.promises, 'open', open);
  Reflect.set(filesystem.promises, 'rm', rm);
  module.syncBuiltinESMExports();
  observation.restoreFs = () => {
    Reflect.set(filesystem.promises, 'open', originalOpen);
    Reflect.set(filesystem.promises, 'rm', originalRemove);
    module.syncBuiltinESMExports();
  };
  return { ...actual, open, rm };
});
// Attribute observations to the real report's async descendants, not concurrent public work.
vi.mock('./layout-report.js', async (load) => {
  const actual = await load<typeof import('./layout-report.js')>();
  const { AsyncLocalStorage } = await import('node:async_hooks');
  observation.reportContext = new AsyncLocalStorage<boolean>();
  const remember = (error: unknown): never => {
    observation.failures.push(
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: typeof error, message: String(error), stack: undefined }
    );
    throw error;
  };
  return {
    ...actual,
    createStorageLayoutReport: (...args: Parameters<typeof actual.createStorageLayoutReport>) =>
      observation.reportContext!.run(true, () => {
        try {
          const value = actual.createStorageLayoutReport(...args);
          return value instanceof Promise ? value.catch(remember) : value;
        } catch (error) {
          return remember(error);
        }
      }),
  };
});
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof Database }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const db = Reflect.construct(target, args, newTarget);
        if (!observation.armed || !observation.reportContext?.getStore()) return db;
        const source = args[0] === observation.path;
        if (db.name.startsWith(`${observation.root}${sep}`))
          observation.sourceConstructors.push(db.name);
        const copy = observation.copies.get(db.name);
        if (!source && (!copy || copy.suffix !== '')) return db;
        if (copy) {
          const actual = lstatSync(db.name, { bigint: true });
          if (String(actual.dev) !== copy.outputDev || String(actual.ino) !== copy.outputIno)
            throw new Error('Private SQLite does not own the observed copied file.');
        }
        const close = db.close;
        db.close = function () {
          const row = {
            path: this.name,
            readonly: this.readonly,
            queryOnly: this.pragma('query_only', { simple: true }),
            closed: false,
            dmlCode: undefined as unknown,
            facts: facts(this),
          };
          let result: Database.Database;
          try {
            this.exec('SAVEPOINT layout_report_probe');
            try {
              this.prepare("UPDATE thread_read_receipts SET item_ids_json='[]'").run();
            } catch (error) {
              row.dmlCode =
                typeof error === 'object' && error !== null && 'code' in error
                  ? error.code
                  : String(error);
            } finally {
              this.exec('ROLLBACK TO layout_report_probe; RELEASE layout_report_probe');
            }
          } finally {
            result = close.call(this);
            row.closed = !this.open;
            observation.handles.push(row);
          }
          return result;
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
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        observation.posted.push({ worker: this, message: args[0] as Record<string, unknown> });
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (event === 'message' && typeof message === 'object' && message !== null) {
          const reply = message as Record<string, unknown>;
          const request = observation.posted.find(
            (row) => row.worker === this && row.message.id === reply.id
          );
          if (
            observation.holdReply &&
            reply.status === 'ok' &&
            request?.message.operation === 'thread-read-membership' &&
            request.message.database === `user:${observation.path}`
          ) {
            observation.holdReply = false;
            observation.heldReply = () => {
              observation.replies.push({ worker: this, message: reply });
              super.emit(event, ...args);
            };
            observation.replyReached?.();
            return true;
          }
          observation.replies.push({ worker: this, message: reply });
        }
        return super.emit(event, ...args);
      }
    },
  };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  observation.heldReply?.();
  observation.heldReply = undefined;
  observation.armed = false;
  for (const close of cleanup.splice(0).reverse()) await close();
  observation.path = '';
  observation.root = '';
  observation.handles = [];
  observation.posted = [];
  observation.replies = [];
  observation.failures = [];
  observation.sourceConstructors = [];
  observation.activeSources.clear();
  observation.copies.clear();
  observation.removed = [];
  observation.cleanupFailures = [];
  observation.failCleanup = false;
  observation.copyReached = undefined;
  observation.copyRelease = undefined;
  observation.holdReply = false;
  observation.replyReached = undefined;
  vi.restoreAllMocks();
});
afterAll(() => observation.restoreFs?.());
function terminal(operation: string, database?: string) {
  return observation.posted
    .filter(
      (row) =>
        row.message.operation === operation &&
        (database === undefined || row.message.database === database)
    )
    .map((row) => ({
      request: row.message,
      replies: observation.replies
        .filter(
          (reply) =>
            reply.worker === row.worker &&
            reply.message.id === row.message.id &&
            (reply.message.status === 'ok' || reply.message.status === 'error')
        )
        .map((reply) => reply.message),
    }));
}
async function prepare() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-public-layout-cold-user-'));
  const core = openCoreDb(root);
  applyMigrations(core);
  const userId = ensureLocalUser(core);
  cleanup.push(async () => {
    core.sqlite.close();
    await disposeTestStore(root);
  });
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Public layout lifecycle');
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Retained read receipt');
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
    text: 'Exact retained layout receipt.',
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const admin = createOpenKitAccessTokenRecord(core, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  let denied = false;
  let availableLimit: bigint | undefined;
  const available = () => {
    if (denied && observation.reportContext?.getStore()) return 0n;
    if (availableLimit !== undefined) return availableLimit;
    const value = statfsSync(root, { bigint: true });
    return value.bavail * value.bsize;
  };
  const admission = new FileStorageAdmission(root, () => 0n, available);
  const app = createApp({
    coreDb: core,
    dataRoot: root,
    store,
    mode: 'server',
    fileAdmission: admission,
  });
  const headers = { authorization: `Bearer ${admin.secret}` };
  const written = await app.request(
    ...operationRequest(
      'thread.mark-read',
      { workspaceId: workspace.id, threadId: thread.id, itemIds: [item.id] },
      { method: 'POST', headers }
    )
  );
  expect(written.status).toBe(200);
  expect(await written.json()).toEqual({ scope: 'window', acknowledgedItemIds: [item.id] });
  const path = userDbPath(root, userId),
    database = `user:${path}`;
  const reader = openUserReadDb(root, userId);
  let originalFacts: ReturnType<typeof facts>, migrations: string[];
  try {
    originalFacts = facts(reader.sqlite);
    migrations = listAppliedNativeMigrationIds(reader.sqlite, 'user');
  } finally {
    reader.sqlite.close();
  }
  expect(originalFacts.receipts).toEqual([
    expect.objectContaining({
      workspace_id: workspace.id,
      thread_id: thread.id,
      item_ids_json: JSON.stringify([item.id]),
    }),
  ]);
  await getControlStoreWorkerClient().close(database);
  const closed = terminal('close', database);
  expect(closed).toHaveLength(1);
  expect(closed[0]!.replies).toEqual([
    expect.objectContaining({ operation: 'close', status: 'ok' }),
  ]);
  expect({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
  const bytes = readFileSync(path),
    inode = statSync(path).ino;
  return {
    root,
    core,
    userId,
    store,
    workspace,
    thread,
    turn,
    item,
    app,
    headers,
    path,
    database,
    originalFacts,
    migrations,
    bytes,
    inode,
    admission,
    deny: (value: boolean) => {
      denied = value;
    },
    limit: (value: bigint | undefined) => {
      availableLimit = value;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof prepare>>;
function arm(f: Fixture) {
  observation.root = f.root;
  observation.path = f.path;
  observation.armed = true;
}
function assertPrivate(f: Fixture) {
  expect(observation.sourceConstructors).toEqual([]);
  const copies = [...observation.copies.entries()].filter(([, copy]) => copy.suffix === '');
  expect(copies).toHaveLength(1);
  expect(copies[0]![1]).toMatchObject({
    source: f.path,
    bytes: String(f.bytes.byteLength),
    sha256: createHash('sha256').update(f.bytes).digest('hex'),
  });
  expect(observation.handles).toHaveLength(1);
  expect(observation.handles[0]!.path).toBe(copies[0]![0]);
  const scratch = dirname(copies[0]![0]);
  const outside = relative(f.root, scratch);
  expect(
    outside !== '' && (isAbsolute(outside) || outside === '..' || outside.startsWith(`..${sep}`))
  ).toBe(true);
  expect(observation.removed).toEqual([scratch]);
  expect(existsSync(scratch)).toBe(false);
}
async function report(f: Fixture) {
  return f.app.request(...operationRequest('storage.layout-report', {}, { headers: f.headers }));
}
async function finalShutdown() {
  await shutdownControlStoreWorkerClient();
  const shutdown = terminal('shutdown');
  expect(shutdown.length).toBeGreaterThan(0);
  for (const row of shutdown)
    expect(row.replies).toEqual([expect.objectContaining({ operation: 'shutdown', status: 'ok' })]);
}
async function fixture() {
  const f = await prepare();
  const { root, userId, path, database, headers, app, originalFacts, migrations, bytes, inode } = f;
  const userOpensBeforeReport = terminal('open', database).length;
  observation.root = root;
  observation.path = path;
  observation.armed = true;
  const response = await app.request(...operationRequest('storage.layout-report', {}, { headers }));
  expect(
    response.status,
    JSON.stringify({
      failures: observation.failures,
      copies: [...observation.copies.entries()],
      sources: observation.sourceConstructors,
    })
  ).toBe(200);
  const report = StorageLayoutReportResponseSchema.parse(await response.json());
  expect(report.users.find((row) => row.userId === userId)).toEqual({
    userId,
    userDb: { path: relative(root, path), exists: true, appliedMigrations: migrations },
  });
  expect(observation.handles).toHaveLength(1);
  expect(observation.handles[0]!.facts).toEqual(originalFacts);
  expect(observation.handles[0]).toMatchObject({
    readonly: true,
    closed: true,
    dmlCode: 'SQLITE_READONLY',
  });
  expect(statSync(path).ino).toBe(inode);
  expect(readFileSync(path)).toEqual(bytes);
  await shutdownControlStoreWorkerClient();
  const shutdown = terminal('shutdown');
  expect(shutdown.length).toBeGreaterThan(0);
  for (const row of shutdown)
    expect(row.replies).toEqual([expect.objectContaining({ operation: 'shutdown', status: 'ok' })]);
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).ino).toBe(inode);
  const sidecars = { wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) };
  const sizes = {
    wal: sidecars.wal ? statSync(`${path}-wal`).size : null,
    shm: sidecars.shm ? statSync(`${path}-shm`).size : null,
  };
  process.stderr.write(
    `${JSON.stringify({ coldLayoutUser: { policy: observation.handles.map(({ facts: _facts, ...policy }) => policy), sidecars, sizes, sha256: createHash('sha256').update(bytes).digest('hex'), nativeUserOpenRequests: terminal('open', database).length, nativeUserOpenRequestsDuringReport: terminal('open', database).length - userOpensBeforeReport } })}\n`
  );
  return { ...f, policy: observation.handles[0]!, sidecars };
}
it('uses an actual query-only User reader for public cold storage.layout-report', async () => {
  const f = await fixture();
  expect(f.policy.queryOnly).toBe(1);
  assertPrivate(f);
});
it('closes public cold storage.layout-report User files without WAL or SHM after genuine native shutdown', async () => {
  const f = await fixture();
  expect(f.sidecars).toEqual({ wal: false, shm: false });
  assertPrivate(f);
});

/** Deliberate retained-format fixtures run after the actual native close, never through report admission. */
it.each(['missing file', 'missing ledger', 'older known ledger', 'extra unknown ledger'] as const)(
  'preserves original public layout projection for %s without source SQL or migration',
  async (variant) => {
    const f = await prepare();
    let expected: string[] = [];
    let expectedFacts: ReturnType<typeof facts> | undefined;
    if (variant === 'missing file') rmSync(f.path);
    else {
      const setup = new Database(f.path, { fileMustExist: true });
      try {
        if (variant === 'missing ledger') setup.exec('DROP TABLE __drizzle_migrations');
        else if (variant === 'older known ledger')
          setup.exec(
            'DELETE FROM __drizzle_migrations WHERE created_at NOT IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at LIMIT 2)'
          );
        else {
          const max = setup
            .prepare('SELECT MAX(created_at) FROM __drizzle_migrations')
            .pluck()
            .get() as number;
          setup
            .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
            .run('independent-retained-unknown-row', max + 1);
        }
        expected =
          variant === 'missing ledger'
            ? []
            : variant === 'older known ledger'
              ? f.migrations.slice(0, 2)
              : f.migrations;
        expectedFacts = facts(setup);
      } finally {
        setup.close();
      }
    }
    if (variant === 'older known ledger') expect(expectedFacts?.ledger).toHaveLength(2);
    if (variant === 'missing ledger') expect(expectedFacts?.ledger).toBeNull();
    if (variant === 'extra unknown ledger')
      expect(expectedFacts?.ledger).toContainEqual(
        expect.objectContaining({ hash: 'independent-retained-unknown-row' })
      );
    const before = existsSync(f.path) ? readFileSync(f.path) : undefined;
    const inode = existsSync(f.path) ? statSync(f.path).ino : undefined;
    expect(existsSync(`${f.path}-wal`)).toBe(false);
    expect(existsSync(`${f.path}-shm`)).toBe(false);
    arm(f);
    const response = await report(f);
    expect(response.status).toBe(200);
    const value = StorageLayoutReportResponseSchema.parse(await response.json());
    expect(value.users.find((row) => row.userId === f.userId)).toEqual({
      userId: f.userId,
      userDb: {
        path: relative(f.root, f.path),
        exists: variant !== 'missing file',
        appliedMigrations: expected,
      },
    });
    if (before) {
      expect(readFileSync(f.path)).toEqual(before);
      expect(statSync(f.path).ino).toBe(inode);
    }
    expect(observation.sourceConstructors).toEqual([]);
    if (variant === 'missing file') {
      expect(observation.handles).toEqual([]);
      expect(observation.copies.size).toBe(0);
      expect(existsSync(f.path)).toBe(false);
    } else {
      expect(observation.handles).toHaveLength(1);
      expect(observation.handles[0]).toMatchObject({
        readonly: true,
        queryOnly: 1,
        closed: true,
        dmlCode: 'SQLITE_READONLY',
        facts: expectedFacts,
      });
      expect([...observation.copies.values()].filter((copy) => copy.suffix === '')).toHaveLength(1);
      expect(readFileSync(f.path)).toEqual(before);
      expect(statSync(f.path).ino).toBe(inode);
    }
    await finalShutdown();
    expect(existsSync(f.path)).toBe(before !== undefined);
    if (before) expect(readFileSync(f.path)).toEqual(before);
    expect(existsSync(`${f.path}-wal`)).toBe(false);
    expect(existsSync(`${f.path}-shm`)).toBe(false);
  }
);

async function addItem(f: Fixture) {
  return f.store.createItem({
    id: allocateEntityId('it'),
    owner: f.turn.owner,
    threadId: f.thread.id,
    turnId: f.turn.id,
    type: 'assistant-message',
    text: 'Second exact retained reply.',
    status: 'completed',
    createdAt: f.turn.startedAt!,
    completedAt: f.turn.startedAt!,
  });
}
async function markRead(f: Fixture, itemId: string) {
  const response = await f.app.request(
    ...operationRequest(
      'thread.mark-read',
      { workspaceId: f.workspace.id, threadId: f.thread.id, itemIds: [itemId] },
      { method: 'POST', headers: f.headers }
    )
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ scope: 'window', acknowledgedItemIds: [itemId] });
}
function retainedFiles(path: string) {
  return ['', '-wal', '-shm', '-journal'].map((suffix) => {
    const file = `${path}${suffix}`;
    if (!existsSync(file)) return { suffix, exists: false };
    const stat = statSync(file, { bigint: true });
    return {
      suffix,
      exists: true,
      dev: String(stat.dev),
      ino: String(stat.ino),
      bytes: readFileSync(file),
      mtime: String(stat.mtimeNs),
      ctime: String(stat.ctimeNs),
    };
  });
}
it('reports exact genuine committed User WAL through its private cut without changing source files', async () => {
  const f = await prepare();
  const item = await addItem(f);
  await markRead(f, item.id); // Genuine public mutation and covering native ACK leave the live writer's WAL.
  expect(statSync(`${f.path}-wal`).size).toBeGreaterThan(32);
  const reader = openUserReadDb(f.root, f.userId);
  let exact: ReturnType<typeof facts>;
  try {
    exact = facts(reader.sqlite);
  } finally {
    reader.sqlite.close();
  }
  expect(exact.receipts).toEqual([
    expect.objectContaining({ item_ids_json: JSON.stringify([f.item.id, item.id].sort()) }),
  ]);
  const before = retainedFiles(f.path);
  arm(f);
  const response = await report(f);
  expect(response.status).toBe(200);
  const value = StorageLayoutReportResponseSchema.parse(await response.json());
  expect(value.users.find((row) => row.userId === f.userId)?.userDb.appliedMigrations).toEqual(
    f.migrations
  );
  expect(observation.handles).toHaveLength(1);
  expect(observation.handles[0]).toMatchObject({
    readonly: true,
    queryOnly: 1,
    closed: true,
    dmlCode: 'SQLITE_READONLY',
    facts: exact,
  });
  expect(observation.sourceConstructors).toEqual([]);
  expect([...observation.copies.values()].map((copy) => copy.suffix).sort()).toEqual(['', '-wal']);
  expect(retainedFiles(f.path)).toEqual(before);
  await finalShutdown();
  expect(existsSync(`${f.path}-wal`)).toBe(false);
  expect(existsSync(`${f.path}-shm`)).toBe(false);
});

it('acquires the actual report hold only after an original User ACK and releases later native work after its private cut', async () => {
  const f = await prepare();
  const item = await addItem(f);
  observation.path = f.path;
  let ackReady!: () => void;
  const ackReached = new Promise<void>((resolve) => {
    ackReady = resolve;
  });
  observation.replyReached = ackReady;
  observation.holdReply = true;
  const mutation = markRead(f, item.id);
  await ackReached;
  let entered!: () => void;
  const pauseEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = getControlStoreWorkerClient(),
    pause = client.pauseForDataRootBackup.bind(client);
  let acquired = false,
    released = false;
  vi.spyOn(client, 'pauseForDataRootBackup').mockImplementation(async (...args) => {
    const promise = pause(...args);
    entered();
    const resume = await promise;
    acquired = true;
    return () => {
      released = true;
      resume();
    };
  });
  let copied!: () => void, releaseCopy!: () => void;
  const copyReached = new Promise<void>((resolve) => {
    copied = resolve;
  });
  observation.copyReached = copied;
  observation.copyRelease = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  arm(f);
  const reporting = report(f);
  try {
    await pauseEntered;
    await nextTurn();
    expect(acquired).toBe(false);
    expect(observation.copies.size).toBe(0);
    expect(observation.handles).toEqual([]);
    const forward = observation.heldReply;
    expect(forward).toBeDefined();
    observation.heldReply = undefined;
    forward!();
    await mutation;
    await copyReached;
    expect(acquired).toBe(true);
    expect(released).toBe(false);
    const prior = observation.posted.length;
    let settled = false;
    const later = client
      .threadReadMembership(f.database, {
        userId: f.userId,
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        itemIds: [f.item.id, item.id],
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await nextTurn();
    expect(
      observation.posted
        .slice(prior)
        .filter((row) => row.message.operation === 'thread-read-membership')
    ).toEqual([]);
    expect(settled).toBe(false);
    releaseCopy();
    const response = await reporting;
    expect(response.status).toBe(200);
    expect(
      StorageLayoutReportResponseSchema.parse(await response.json()).users.find(
        (row) => row.userId === f.userId
      )?.userDb.appliedMigrations
    ).toEqual(f.migrations);
    expect(await later).toEqual([f.item.id, item.id].sort());
    expect(released).toBe(true);
    expect(observation.sourceConstructors).toEqual([]);
    expect(observation.handles).toHaveLength(1);
    expect(observation.handles[0]).toMatchObject({
      readonly: true,
      queryOnly: 1,
      closed: true,
      dmlCode: 'SQLITE_READONLY',
    });
    expect(observation.handles[0]!.facts).toMatchObject({
      receipts: [
        expect.objectContaining({ item_ids_json: JSON.stringify([f.item.id, item.id].sort()) }),
      ],
    });
    await finalShutdown();
    expect(existsSync(`${f.path}-wal`)).toBe(false);
    expect(existsSync(`${f.path}-shm`)).toBe(false);
  } finally {
    observation.heldReply?.();
    observation.heldReply = undefined;
    releaseCopy();
    await Promise.allSettled([mutation, reporting]);
  }
});

it('refuses configured scratch capacity before private bytes and releases the report hold for an explicit next request', async () => {
  const f = await prepare();
  arm(f);
  const before = retainedFiles(f.path);
  f.deny(true);
  const failed = await report(f);
  expect(failed.status).toBe(507);
  expect(await failed.json()).toMatchObject({ code: 'operation_storage_no_space' });
  expect(observation.copies.size).toBe(0);
  expect(observation.handles).toEqual([]);
  expect(observation.sourceConstructors).toEqual([]);
  expect(retainedFiles(f.path)).toEqual(before);
  f.deny(false);
  const next = await report(f);
  expect(next.status).toBe(200);
  expect(
    StorageLayoutReportResponseSchema.parse(await next.json()).users.find(
      (row) => row.userId === f.userId
    )?.userDb.appliedMigrations
  ).toEqual(f.migrations);
  expect(observation.handles).toHaveLength(1);
  expect(observation.handles[0]).toMatchObject({
    readonly: true,
    queryOnly: 1,
    closed: true,
    dmlCode: 'SQLITE_READONLY',
  });
  const item = await addItem(f);
  await markRead(f, item.id);
  await finalShutdown();
  expect(existsSync(`${f.path}-wal`)).toBe(false);
  expect(existsSync(`${f.path}-shm`)).toBe(false);
});

it('retains the real scratch forecast when actual private cleanup fails and still releases the native hold', async () => {
  const f = await prepare();
  const forecast: Array<{ bytes: bigint; remaining: () => bigint; released: () => number }> = [];
  const forPath = f.admission.forPath.bind(f.admission);
  vi.spyOn(f.admission, 'forPath').mockImplementation((path) => {
    const scoped = forPath(path),
      reserve = scoped.reserve.bind(scoped);
    vi.spyOn(scoped, 'reserve').mockImplementation((writes, priority) => {
      const reservation = reserve(writes, priority);
      if (observation.reportContext?.getStore()) {
        const bytes =
          writes.stagingBytes +
          writes.extractionBytes +
          writes.derivativeBytes +
          writes.publicationBytes;
        let remaining = bytes,
          released = 0;
        const release = reservation.release.bind(reservation),
          record = reservation.recordWritten.bind(reservation),
          reduce = reservation.reduceTo.bind(reservation);
        vi.spyOn(reservation, 'release').mockImplementation(() => {
          release();
          released++;
          remaining = 0n;
        });
        vi.spyOn(reservation, 'recordWritten').mockImplementation((value) => {
          record(value);
          remaining -= BigInt(value);
        });
        vi.spyOn(reservation, 'reduceTo').mockImplementation((value) => {
          reduce(value);
          remaining = value;
        });
        forecast.push({ bytes, remaining: () => remaining, released: () => released });
      }
      return reservation;
    });
    return scoped;
  });
  const before = retainedFiles(f.path);
  arm(f);
  observation.failCleanup = true;
  const failed = await report(f);
  expect(failed.status).toBe(500);
  expect(await failed.text()).toBe('Internal Server Error');
  expect(observation.sourceConstructors).toEqual([]);
  expect(observation.handles).toHaveLength(1);
  expect(observation.handles[0]).toMatchObject({
    readonly: true,
    queryOnly: 1,
    closed: true,
    dmlCode: 'SQLITE_READONLY',
  });
  expect(observation.cleanupFailures).toHaveLength(1);
  expect(existsSync(observation.cleanupFailures[0]!)).toBe(true);
  expect(retainedFiles(f.path)).toEqual(before);
  expect(forecast).toHaveLength(1);
  expect(forecast[0]!.bytes).toBeGreaterThan(0n);
  // All real reservation mutators forward first; existing native-owner budgets cannot mask this charge.
  expect(forecast[0]!.released()).toBe(0);
  expect(forecast[0]!.remaining()).toBeGreaterThan(0n);
  observation.failCleanup = false;
  const item = await addItem(f);
  await markRead(f, item.id);
  await finalShutdown();
  expect(existsSync(`${f.path}-wal`)).toBe(false);
  expect(existsSync(`${f.path}-shm`)).toBe(false);
});
