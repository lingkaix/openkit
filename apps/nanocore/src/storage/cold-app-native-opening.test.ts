// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Worker as NativeWorker, Worker } from 'node:worker_threads';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { KernelCommandContext } from '../generative-kernel/commands.js';
import {
  createLightApp,
  createRecord,
  getRecord,
  updateLightAppSchema,
} from '../generative-kernel/commands.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { lightAppDbPath, lightAppRoot, openExistingAppDb } from './app-db.js';
import {
  FileAdmissionError,
  FileStorageAdmission,
  type FileStorageReservation,
} from './artifacts/file-admission.js';
import { commandRequestKey, getCommandRequestRecord } from './command-request-records.js';
import { CONTROL_STORE_BUDGET } from './control-store.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  CONTROL_WORKER_VERSION,
  ControlPhysicalForecastDecisionSchema,
  ControlPhysicalForecastSchema,
  type ControlWorkerCommand,
  type ControlWorkerReply,
  isControlWorkerReply,
} from './control-store-worker-protocol.js';
import { openCoreDb } from './db.js';
import { ensureUserLayout, readDataRootLayoutMarker, userDbPath } from './fs-layout.js';
import {
  createWorkspaceBackup,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import { withVerifiedWorkspaceBackupBundle } from './workspace-backup-bundle.js';

// Core Storage SQLite Layers: native authority must precede any source SQLite open;
// accepted normal lifecycles retain exact data and close without WAL/SHM at rest.
const observed = vi.hoisted(() => ({
  armed: false,
  path: '',
  sequence: 0,
  main: [] as Array<{ path: string; readonly: boolean }>,
  native: [] as Array<{ path: string; readonly: boolean; closed?: boolean; sequence: number }>,
  requests: [] as Array<{ worker: NativeWorker; message: Record<string, unknown> }>,
  replies: [] as Array<{
    worker: NativeWorker;
    message: Record<string, unknown>;
    sequence: number;
  }>,
  owners: new Map<string, NativeWorker>(),
  cleanupGate: new SharedArrayBuffer(8),
  postInitGate: new SharedArrayBuffer(4),
  copyCloseGate: new SharedArrayBuffer(8),
  copyClosed: undefined as
    | undefined
    | ((value: {
        path: string;
        dev: string;
        ino: string;
        bytes: string;
        sha256: string;
        physicallyClosed: boolean;
      }) => void),
  cleanupReached: undefined as undefined | (() => void),
  cleanupPaths: [] as string[],
  definitionReads: [] as Array<{ path: string; sha256: string }>,
  privateNative: [] as Array<{
    path: string;
    readonly: boolean;
    closed?: boolean;
    queryOnly?: unknown;
  }>,
  postInitEvidence: [] as Array<Record<string, unknown>>,
}));
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof Database }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const db = Reflect.construct(target, args, newTarget);
        if (observed.armed && db.name === observed.path)
          observed.main.push({ path: db.name, readonly: db.readonly });
        return db;
      },
    }),
  };
});
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!String(filename).includes('control-store-worker')) {
          super(filename, options);
          return;
        }
        const prelude = `
        const { parentPort, workerData } = require('node:worker_threads');
        const Module = require('node:module');
        const selected = new Set(), users = new Set();
        const dirname = require('node:path').dirname;
        const cleanupGate = new Int32Array(workerData.cleanupGate);
        const postInitGate = new Int32Array(workerData.postInitGate);
        const copyCloseGate = new Int32Array(workerData.copyCloseGate);
        parentPort.on('message', request => {
          if (request?.operation !== 'open') return;
          if (request.physicalScope?.kind === 'app' || request.initialize === 'user') selected.add(request.path);
          if (request.initialize === 'user') users.add(request.path);
        });
        const fs = require('node:fs'), promises = require('node:fs/promises');
        const readFile = fs.readFileSync;
        fs.readFileSync = function(path, ...args) {
          const result = readFile.call(this, path, ...args);
          if (Atomics.load(cleanupGate, 0) === 1 && typeof path === 'string' &&
              [...selected].some(source => path.startsWith(dirname(source) + '/definitions/'))) {
            parentPort.postMessage({ appDefinitionRead: true, path,
              sha256: require('node:crypto').createHash('sha256').update(result).digest('hex') });
          }
          return result;
        };
        const remove = promises.rm;
        promises.rm = async function(path, ...args) {
          const result = await remove.call(this, path, ...args);
          if (typeof path === 'string' &&
              [...selected].some(source => path.startsWith(dirname(source) + '/.app-open-inspection-')) &&
              Atomics.compareExchange(cleanupGate, 0, 1, 2) === 1) {
            parentPort.postMessage({ appCleanupRemoved: true, path });
            // The original cleanup really completed. Hold only its awaited return.
            while (Atomics.load(cleanupGate, 1) === 0)
              await Atomics.waitAsync(cleanupGate, 1, 0).value;
          }
          return result;
        };
        const openFile = promises.open;
        promises.open = async function(...args) {
          const file = await openFile.apply(this, args);
          if (args[1] !== 'wx' || Atomics.load(copyCloseGate, 0) !== 1) return file;
          const metadata = await file.stat({bigint:true});
          if (!metadata.isFile()) return file;
          // Resolve the descriptor actually returned by the genuine open; no descriptor is guessed.
          const destination = fs.readlinkSync('/proc/self/fd/' + file.fd);
          if (![...selected].some(source => destination.startsWith(dirname(source) + '/') &&
              dirname(destination) !== dirname(source))) return file;
          const close = file.close.bind(file);
          file.close = async function(...closeArgs) {
            const before = await file.stat({bigint:true});
            const bound = fs.lstatSync(destination, {bigint:true});
            if (before.dev !== bound.dev || before.ino !== bound.ino)
              throw new Error('Private copy descriptor binding changed before actual close.');
            const result = await close(...closeArgs);
            if (Atomics.compareExchange(copyCloseGate, 0, 1, 2) === 1) {
              const after = fs.lstatSync(destination, {bigint:true});
              if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size)
                throw new Error('Private copy binding changed across actual close.');
              parentPort.postMessage({ appPrivateCopyPhysicallyClosed: true, path: destination,
                dev:String(before.dev), ino:String(before.ino), bytes:String(before.size),
                sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(destination)).digest('hex'),
                physicallyClosed:file.fd === -1 });
              // Hold only the completed FileHandle.close return, before private SQLite or cleanup.
              while (Atomics.load(copyCloseGate, 1) === 0)
                await Atomics.waitAsync(copyCloseGate, 1, 0).value;
            }
            return result;
          };
          return file;
        };
        Module.syncBuiltinESMExports();
        const entry = workerData.appDriver;
        if (require.cache[entry]) throw new Error('App driver loaded before constructor observer.');
        const load = Module._extensions['.js'];
        let intercepted = false;
        const hook = function(mod, filename) {
          load(mod, filename);
          if (filename !== entry) return;
          const Original = mod.exports;
          mod.exports = new Proxy(Original, {
            construct(target, args, newTarget) {
              const db = Reflect.construct(target, args, newTarget);
              const privateCopy = [...selected].some(source => db.name.startsWith(dirname(source) + '/.app-open-inspection-'));
              if (privateCopy) {
                parentPort.postMessage({ appPrivateConstructor: true, path: db.name, readonly: db.readonly });
                const close = db.close;
                db.close = function() {
                  const queryOnly = this.pragma('query_only', {simple:true});
                  const result = close.call(this);
                  parentPort.postMessage({ appPrivateClosed: true, path: this.name, readonly: this.readonly, queryOnly, closed: !this.open });
                  return result;
                };
              }
              if (users.has(db.name) && !db.readonly) {
                const pragma = db.pragma;
                db.pragma = function(sql, ...args) {
                  const result = pragma.call(this, sql, ...args);
                  if (String(sql).replaceAll(' ', '').toLowerCase() === 'wal_autocheckpoint=0' &&
                      Atomics.compareExchange(postInitGate, 0, 1, 2) === 1) {
                    parentPort.postMessage({ appPostInitFault: true, path: this.name,
                      readonly: this.readonly, inTransaction: this.inTransaction,
                      synchronous: pragma.call(this, 'synchronous', {simple:true}),
                      ledger: this.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all(),
                      tables: this.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() });
                    throw new Error('Injected post-initialization owner fault');
                  }
                  return result;
                };
              }
              if (selected.has(db.name)) {
                parentPort.postMessage({ appOpenConstructor: true, path: db.name, readonly: db.readonly });
                const close = db.close;
                db.close = function() {
                  const result = close.call(this);
                  parentPort.postMessage({ appOpenClosed: true, path: this.name, readonly: this.readonly, closed: !this.open });
                  return result;
                };
              }
              return db;
            }
          });
          intercepted = true;
          if (Module._extensions['.js'] === hook) Module._extensions['.js'] = load;
        };
        Module._extensions['.js'] = hook;
        require(entry);
        if (!intercepted) throw new Error('App constructor observer did not intercept real driver.');
      `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            appDriver: require.resolve('better-sqlite3'),
            cleanupGate: observed.cleanupGate,
            postInitGate: observed.postInitGate,
            copyCloseGate: observed.copyCloseGate,
          },
        });
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        const message = args[0] as Record<string, unknown>;
        if (
          message.operation === 'open' &&
          typeof message.database === 'string' &&
          message.physicalScope
        )
          observed.owners.set(message.database, this);
        if (observed.armed) observed.requests.push({ worker: this, message });
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0] as Record<string, unknown> | undefined;
        if (event === 'message' && message?.appPrivateCopyPhysicallyClosed) {
          observed.copyClosed?.(
            message as unknown as Parameters<NonNullable<typeof observed.copyClosed>>[0]
          );
          return true;
        }
        if (event === 'message' && message?.appCleanupRemoved) {
          observed.cleanupPaths.push(String(message.path));
          observed.cleanupReached?.();
          return true;
        }
        if (event === 'message' && message?.appDefinitionRead) {
          observed.definitionReads.push(message as unknown as { path: string; sha256: string });
          return true;
        }
        if (event === 'message' && message?.appPostInitFault) {
          observed.postInitEvidence.push(message);
          return true;
        }
        if (
          event === 'message' &&
          message &&
          (message.appPrivateConstructor || message.appPrivateClosed)
        ) {
          if (observed.armed)
            observed.privateNative.push(
              message as unknown as {
                path: string;
                readonly: boolean;
                closed?: boolean;
                queryOnly?: unknown;
              }
            );
          return true;
        }
        if (
          event === 'message' &&
          message &&
          (message.appOpenConstructor || message.appOpenClosed)
        ) {
          if (observed.armed && message.path === observed.path)
            observed.native.push({
              ...(message as unknown as { path: string; readonly: boolean; closed?: boolean }),
              sequence: ++observed.sequence,
            });
          return true;
        }
        if (event === 'message' && observed.armed && message)
          observed.replies.push({ worker: this, message, sequence: ++observed.sequence });
        return super.emit(event, ...args);
      }
    },
  };
});

const roots: string[] = [];
const rawCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  Atomics.store(new Int32Array(observed.cleanupGate), 1, 1);
  Atomics.notify(new Int32Array(observed.cleanupGate), 1);
  for (const close of rawCleanups.splice(0).reverse()) await close();
  observed.armed = false;
  for (const root of roots.splice(0)) await disposeTestStore(root);
  observed.path = '';
  observed.main = [];
  observed.native = [];
  observed.requests = [];
  observed.replies = [];
  observed.owners.clear();
  observed.cleanupGate = new SharedArrayBuffer(8);
  observed.postInitGate = new SharedArrayBuffer(4);
  observed.copyCloseGate = new SharedArrayBuffer(8);
  observed.copyClosed = undefined;
  observed.cleanupReached = undefined;
  observed.cleanupPaths = [];
  observed.definitionReads = [];
  observed.privateNative = [];
  observed.postInitEvidence = [];
});
const schema: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Cold authority stage',
  purpose: 'Retain actual native App authority and command results.',
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
/** Only fixture-owned regular files are inventoried; includes definitions, snapshots and sidecars. */
function inventory(root: string) {
  const files: Array<{
    path: string;
    sha256: string;
    dev: string;
    ino: string;
    bytes: string;
    mtime: string;
    ctime: string;
  }> = [];
  const directories: string[] = [];
  function visit(path: string) {
    const metadata = lstatSync(path, { bigint: true });
    expect(metadata.isSymbolicLink()).toBe(false);
    if (metadata.isDirectory()) {
      directories.push(relative(root, path));
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else {
      expect(metadata.isFile()).toBe(true);
      files.push({
        path: relative(root, path),
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        dev: String(metadata.dev),
        ino: String(metadata.ino),
        bytes: String(metadata.size),
        mtime: String(metadata.mtimeNs),
        ctime: String(metadata.ctimeNs),
      });
    }
  }
  visit(root);
  return { files, directories };
}
function replies(operation: string, database?: string) {
  const selected = observed.requests.filter(
    (row) =>
      row.message.operation === operation &&
      (database === undefined || row.message.database === database)
  );
  return selected.map((request) => ({
    request,
    replies: observed.replies.filter(
      (row) =>
        row.worker === request.worker &&
        row.message.id === request.message.id &&
        (row.message.status === 'ok' || row.message.status === 'error')
    ),
  }));
}
function expectOneAck(operation: string, database?: string) {
  const rows = replies(operation, database);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.replies).toHaveLength(1);
  expect(rows[0]!.replies[0]!.message).toMatchObject({ operation, status: 'ok' });
}
function arm(path: string) {
  observed.path = path;
  observed.sequence = 0;
  observed.main = [];
  observed.native = [];
  observed.requests = [];
  observed.replies = [];
  observed.armed = true;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-cold-app-native-'));
  roots.push(root);
  const context: KernelCommandContext = {
    dataRoot: root,
    store: await createDemoStore({ dataRoot: root }),
    inflightCommands: new WeakMap(),
    workspaceId: DEMO_WORKSPACE_ID,
    actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
    requestId: randomUUID(),
  };
  const first = await createLightApp(context, schema);
  const { appId: _appId, schemaRevision: _revision, ...proposal } = first.schema!;
  const app = await updateLightAppSchema(
    { ...context, requestId: randomUUID() },
    first.appId,
    first.appRevision,
    first.schemaRevision,
    { ...proposal, title: 'Current retained definition' }
  );
  const recordRequestId = randomUUID();
  const record = await createRecord(
    { ...context, requestId: recordRequestId },
    app.appId,
    'notes',
    app.schemaRevision,
    { text: 'Exact retained App row.\r\n🚀' }
  );
  const path = lightAppDbPath(root, context.workspaceId, app.appId),
    appRoot = lightAppRoot(root, context.workspaceId, app.appId),
    database = `app:${path}`;
  expect(
    getRecord(root, context.workspaceId, app.appId, 'notes', record.id, app.schemaRevision)
  ).toEqual(record);
  const scope = { workspaceId: context.workspaceId, appId: app.appId };
  const receipt = getCommandRequestRecord(
    root,
    scope,
    commandRequestKey('kernel.records.create', recordRequestId, scope),
    new Date().toISOString()
  );
  expect(receipt).not.toBeNull();
  expect(readdirSync(join(appRoot, 'snapshots')).some((name) => name.endsWith('.sqlite'))).toBe(
    true
  );
  arm(path);
  await getControlStoreWorkerClient().close(database);
  expectOneAck('close', database);
  observed.armed = false;
  expect({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
  return {
    root,
    context,
    app,
    record,
    recordRequestId,
    receipt,
    path,
    appRoot,
    database,
    scope,
    opening: {
      database,
      path,
      create: false,
      dataRoot: root,
      physicalScope: { kind: 'app' as const, ...scope },
    },
  };
}

const faults = [
  'foreign identity',
  'missing definition',
  'mismatched definition',
  'unknown format',
  'unsafe schema',
  'future ledger',
] as const;
it.each(faults)(
  'refuses cold App %s before every source SQLite constructor and preserves all retained files',
  async (fault) => {
    const f = await fixture();
    if (fault === 'missing definition')
      rmSync(join(f.appRoot, 'definitions', `${f.app.schemaDigest.slice('sha256:'.length)}.json`));
    else if (fault === 'mismatched definition') {
      const definition = join(
        f.appRoot,
        'definitions',
        `${f.app.schemaDigest.slice('sha256:'.length)}.json`
      );
      writeFileSync(definition, Buffer.concat([readFileSync(definition), Buffer.from('\n')]));
    } else {
      // Deliberate retained-authority fault after a genuine business tuple and original close ACK.
      const sqlite = new Database(f.path, { fileMustExist: true });
      try {
        if (fault === 'foreign identity')
          sqlite.prepare('UPDATE app_metadata SET app_id=?').run(randomUUID());
        else if (fault === 'unknown format') {
          // Deliberate retained future-marker fault, outside the current writer's CHECK.
          sqlite.pragma('ignore_check_constraints = ON');
          sqlite.exec('UPDATE app_metadata SET kernel_format_version=999');
        } else if (fault === 'unsafe schema')
          sqlite.exec(
            "CREATE TRIGGER unsafe_app_open BEFORE UPDATE ON app_metadata BEGIN SELECT RAISE(ROLLBACK, 'Unsafe App schema fixture'); END"
          );
        else {
          const journal = JSON.parse(
            readFileSync(new URL('../../drizzle/app/meta/_journal.json', import.meta.url), 'utf8')
          ).entries as Array<{ when: number }>;
          sqlite
            .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
            .run('independent-future-app-ledger', journal.at(-1)!.when + 1);
        }
      } finally {
        sqlite.close();
      }
    }
    const before = inventory(f.appRoot);
    arm(f.path);
    let failure: unknown;
    try {
      await getControlStoreWorkerClient().open(f.opening);
    } catch (error) {
      failure = error;
    }
    const sourceConstructors = {
      main: observed.main,
      native: observed.native.filter((row) => row.closed === undefined),
    };
    expect(
      sourceConstructors,
      `Selected source constructors before refusal: ${JSON.stringify(sourceConstructors)}`
    ).toEqual({ main: [], native: [] });
    expect(failure).toBeInstanceOf(ControlStoreWorkerError);
    expect(failure).toMatchObject({
      code: fault === 'future ledger' ? 'migration_unsupported_app' : 'sql-failed',
      commit: 'not-committed',
    });
    const answers = replies('open', f.database);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.replies).toHaveLength(1);
    expect(answers[0]!.replies[0]!.message).toMatchObject({
      status: 'error',
      code: fault === 'future ledger' ? 'migration_unsupported_app' : 'sql-failed',
      commit: 'not-committed',
    });
    expect(inventory(f.appRoot)).toEqual(before);
    await shutdownControlStoreWorkerClient();
    expect(inventory(f.appRoot)).toEqual(before);
  }
);

it('admits a valid cold current App through its actual OPEN ACK and closes exact rows and original receipt at rest', async () => {
  const f = await fixture();
  const retained = inventory(f.appRoot);
  arm(f.path);
  await getControlStoreWorkerClient().open(f.opening);
  expectOneAck('open', f.database);
  expect(
    getRecord(
      f.root,
      f.context.workspaceId,
      f.app.appId,
      'notes',
      f.record.id,
      f.app.schemaRevision
    )
  ).toEqual(f.record);
  expect(
    getCommandRequestRecord(
      f.root,
      f.scope,
      commandRequestKey('kernel.records.create', f.recordRequestId, f.scope),
      new Date().toISOString()
    )
  ).toEqual(f.receipt);
  expect(observed.native.filter((row) => row.closed === undefined && !row.readonly)).toHaveLength(
    1
  );
  expect(observed.main.every((row) => row.readonly)).toBe(true);
  await getControlStoreWorkerClient().close(f.database);
  expectOneAck('close', f.database);
  expect(observed.native.filter((row) => row.closed === true && !row.readonly)).toHaveLength(1);
  await shutdownControlStoreWorkerClient();
  expect({ wal: existsSync(`${f.path}-wal`), shm: existsSync(`${f.path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
  expect(inventory(f.appRoot)).toEqual(retained);
});

it('admits genuine committed App WAL after acknowledged business work and retains the exact tuple through actual last close', async () => {
  const f = await fixture();
  const dirtyRequestId = randomUUID();
  arm(f.path);
  await getControlStoreWorkerClient().open(f.opening);
  expectOneAck('open', f.database);
  const pin = openExistingAppDb(f.root, f.context.workspaceId, f.app.appId);
  let dirty: Awaited<ReturnType<typeof createRecord>>;
  let dirtyReceipt: ReturnType<typeof getCommandRequestRecord>;
  try {
    // Test-owned crash retention: this actual readonly snapshot pins the prior WAL endmark.
    // It is not a serving transaction or an alternative normal-close lifecycle.
    expect(pin.sqlite.readonly).toBe(true);
    expect(pin.sqlite.pragma('query_only', { simple: true })).toBe(1);
    pin.sqlite.exec('BEGIN');
    expect(pin.sqlite.prepare('SELECT app_revision FROM app_metadata').get()).toBeDefined();
    dirty = await createRecord(
      { ...f.context, requestId: dirtyRequestId },
      f.app.appId,
      'notes',
      f.app.schemaRevision,
      { text: 'Committed WAL row after original close ACK.' }
    );
    expectOneAck('app-kernel', f.database);
    dirtyReceipt = getCommandRequestRecord(
      f.root,
      f.scope,
      commandRequestKey('kernel.records.create', dirtyRequestId, f.scope),
      new Date().toISOString()
    );
    expect(dirtyReceipt).not.toBeNull();
    expect(existsSync(`${f.path}-wal`)).toBe(true);
    expect(lstatSync(`${f.path}-wal`).size).toBeGreaterThan(32);
    const owner = observed.owners.get(f.database);
    expect(owner).toBeDefined();
    // The original business ACK already arrived. Real host termination cannot checkpoint
    // later committed frames while the earlier readonly snapshot remains held.
    await owner!.terminate();
  } finally {
    if (pin.sqlite.inTransaction) pin.sqlite.exec('COMMIT');
    if (pin.sqlite.open) pin.sqlite.close();
  }
  await shutdownControlStoreWorkerClient();
  expect(existsSync(`${f.path}-wal`)).toBe(true);
  expect(lstatSync(`${f.path}-wal`).size).toBeGreaterThan(32);
  const before = inventory(f.appRoot);
  arm(f.path);
  await getControlStoreWorkerClient().open(f.opening);
  expectOneAck('open', f.database);
  expect(
    getRecord(
      f.root,
      f.context.workspaceId,
      f.app.appId,
      'notes',
      f.record.id,
      f.app.schemaRevision
    )
  ).toEqual(f.record);
  expect(
    getRecord(f.root, f.context.workspaceId, f.app.appId, 'notes', dirty.id, f.app.schemaRevision)
  ).toEqual(dirty);
  expect(
    getCommandRequestRecord(
      f.root,
      f.scope,
      commandRequestKey('kernel.records.create', dirtyRequestId, f.scope),
      new Date().toISOString()
    )
  ).toEqual(dirtyReceipt);
  await getControlStoreWorkerClient().close(f.database);
  expectOneAck('close', f.database);
  await shutdownControlStoreWorkerClient();
  expect({ wal: existsSync(`${f.path}-wal`), shm: existsSync(`${f.path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
  const after = inventory(f.appRoot);
  expect(
    after.files.filter(
      (row) => row.path.startsWith('definitions/') || row.path.startsWith('snapshots/')
    )
  ).toEqual(
    before.files.filter(
      (row) => row.path.startsWith('definitions/') || row.path.startsWith('snapshots/')
    )
  );
  expect(after.directories).toEqual(before.directories);
});

it('retains UNKNOWN after real native User initialization commits and the pre-ACK owner setup fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-open-unknown-'));
  roots.push(root);
  ensureUserLayout(root, FIXTURE_LOCAL_USER_ID);
  const path = userDbPath(root, FIXTURE_LOCAL_USER_ID),
    database = `user:${path}`;
  expect(existsSync(path)).toBe(false);
  arm(path);
  Atomics.store(new Int32Array(observed.postInitGate), 0, 1);
  let failure: unknown;
  try {
    await getControlStoreWorkerClient().open({ database, path, create: true, initialize: 'user' });
  } catch (error) {
    failure = error;
  }
  const journal = (
    JSON.parse(
      readFileSync(new URL('../../drizzle/user/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: Array<{ when: number }> }
  ).entries;
  expect(Atomics.load(new Int32Array(observed.postInitGate), 0)).toBe(2);
  expect(observed.postInitEvidence).toHaveLength(1);
  expect(observed.postInitEvidence[0]).toMatchObject({
    path,
    readonly: false,
    inTransaction: false,
    synchronous: 2,
  });
  expect(observed.postInitEvidence[0]!.ledger).toEqual(
    journal.map((entry) => ({ created_at: entry.when }))
  );
  expect(observed.postInitEvidence[0]!.tables).toEqual(
    expect.arrayContaining([
      { name: 'idempotency_requests' },
      { name: '__drizzle_migrations' },
      { name: 'thread_read_receipts' },
    ])
  );
  expect(observed.native.filter((row) => row.closed === undefined && !row.readonly)).toHaveLength(
    1
  );
  expect(observed.native.filter((row) => row.closed === true && !row.readonly)).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
  expect({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
  const retainedBytes = readFileSync(path);
  expect(retainedBytes.byteLength).toBeGreaterThan(0);
  // A test-owned unpublished copy proves cold retained format without opening canonical
  // source SQLite after the failed native lifetime and introducing observer sidecars there.
  const copy = join(root, 'post-init-cold-observation.sqlite');
  copyFileSync(path, copy);
  const cold = new Database(copy, { readonly: true, fileMustExist: true });
  try {
    expect(
      cold.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all()
    ).toEqual(journal.map((entry) => ({ created_at: entry.when })));
    expect(
      cold.prepare("SELECT name FROM sqlite_schema WHERE name='idempotency_requests'").get()
    ).toEqual({ name: 'idempotency_requests' });
    expect(cold.prepare('SELECT COUNT(*) AS count FROM idempotency_requests').get()).toEqual({
      count: 0,
    });
  } finally {
    cold.close();
  }
  expect(readFileSync(path)).toEqual(retainedBytes);
  // This is not a proved rollback: genuine initialization is already retained.
  expect(failure).toBeInstanceOf(ControlStoreWorkerError);
  expect(failure).toMatchObject({ code: 'unavailable', commit: 'unknown' });
  expect((failure as Error).message).not.toContain('Injected post-initialization owner fault');
  const answers = replies('open', database);
  expect(answers).toHaveLength(1);
  expect(answers[0]!.replies).toHaveLength(1);
  expect(answers[0]!.replies[0]!.message).toMatchObject({
    status: 'error',
    code: 'unavailable',
    commit: 'unknown',
  });
  await shutdownControlStoreWorkerClient();
  expect(
    observed.requests.filter(
      (row) => row.message.operation === 'open' && row.message.database === database
    )
  ).toHaveLength(1);
  expect(readFileSync(path)).toEqual(retainedBytes);
  expect({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
});

it.each(['removed', 'replaced'] as const)(
  'refuses a canonical App definition %s while awaited private cleanup finishes before any source SQLite constructor',
  async (change) => {
    const f = await fixture();
    const definition = join(
      f.appRoot,
      'definitions',
      `${f.app.schemaDigest.slice('sha256:'.length)}.json`
    );
    const definitionBytes = readFileSync(definition);
    const originalInventory = inventory(f.appRoot);
    const sourceFiles = originalInventory.files.filter(
      (entry) => entry.path === 'data.sqlite' || entry.path.startsWith('data.sqlite-')
    );
    expect(sourceFiles.some((entry) => entry.path === 'data.sqlite')).toBe(true);
    arm(f.path);
    let reached!: () => void;
    const cleanupReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    observed.cleanupReached = reached;
    const gate = new Int32Array(observed.cleanupGate);
    Atomics.store(gate, 0, 1);
    const opening = getControlStoreWorkerClient()
      .open(f.opening)
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
    try {
      await Promise.race([
        cleanupReached,
        opening.then((outcome) => {
          throw new Error(
            `OPEN settled before the genuine held cleanup boundary: ${JSON.stringify(outcome)}`
          );
        }),
      ]);
      expect(Atomics.load(gate, 0)).toBe(2);
      expect(observed.cleanupPaths).toHaveLength(1);
      const scratch = observed.cleanupPaths[0]!;
      expect(scratch.startsWith(`${f.appRoot}/.app-open-inspection-`)).toBe(true);
      expect(existsSync(scratch)).toBe(false); // Original rm completed; its awaited return is held.
      expect(observed.definitionReads.filter((entry) => entry.path === definition)).toEqual([
        expect.objectContaining({
          path: definition,
          sha256: f.app.schemaDigest.slice('sha256:'.length),
        }),
      ]);
      const privateConstructed = observed.privateNative.filter(
        (row) => dirname(row.path) === scratch && row.closed === undefined
      );
      expect(privateConstructed).toHaveLength(1);
      expect(privateConstructed[0]).toMatchObject({ readonly: true });
      const privateClosed = observed.privateNative.filter(
        (row) => row.path === privateConstructed[0]!.path && row.closed === true
      );
      expect(privateClosed).toHaveLength(1);
      expect(privateClosed[0]).toMatchObject({ readonly: true, queryOnly: 1, closed: true });
      expect(observed.main).toEqual([]);
      expect(observed.native.filter((row) => row.closed === undefined)).toEqual([]);
      if (change === 'removed') rmSync(definition);
      else writeFileSync(definition, Buffer.concat([definitionBytes, Buffer.from('\n')]));
      const expectedAfterFault = inventory(f.appRoot);
      expect(
        expectedAfterFault.files.filter(
          (entry) => entry.path === 'data.sqlite' || entry.path.startsWith('data.sqlite-')
        )
      ).toEqual(sourceFiles);
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      const outcome = await opening;
      expect({
        main: observed.main,
        native: observed.native.filter((row) => row.closed === undefined),
      }).toEqual({ main: [], native: [] });
      expect(outcome.ok).toBe(false);
      if (outcome.ok)
        throw new Error('Invalidated definition unexpectedly admitted source SQLite.');
      expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
      expect(outcome.error).toMatchObject({ code: 'sql-failed', commit: 'not-committed' });
      const answers = replies('open', f.database);
      expect(answers).toHaveLength(1);
      expect(answers[0]!.replies).toHaveLength(1);
      expect(answers[0]!.replies[0]!.message).toMatchObject({
        status: 'error',
        code: 'sql-failed',
        commit: 'not-committed',
      });
      expect(inventory(f.appRoot)).toEqual(expectedAfterFault);
      await shutdownControlStoreWorkerClient();
      expect(inventory(f.appRoot)).toEqual(expectedAfterFault);
      expect(
        inventory(f.appRoot).files.filter(
          (entry) => entry.path === 'data.sqlite' || entry.path.startsWith('data.sqlite-')
        )
      ).toEqual(sourceFiles);
    } finally {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      await opening;
      observed.cleanupReached = undefined;
    }
  }
);

/** The existing bundle-owner raw protocol fixture pattern, using this invocation's real entry.
 * Capacity comes from the real FileStorageAdmission, never an invented admitted reply.
 */
async function rawAppScope(f: Awaited<ReturnType<typeof fixture>>) {
  await shutdownControlStoreWorkerClient();
  arm(f.path);
  let denyCapacity = false;
  const availableBytes = () => {
    if (denyCapacity) return 0n;
    const current = statfsSync(f.appRoot, { bigint: true });
    return current.bavail * current.bsize;
  };
  const admission = new FileStorageAdmission(f.root, () => 1_000_000_000n, availableBytes);
  const worker = new Worker(
    pathToFileURL(join(tmpdir(), 'nanocore-worker', 'dist', 'storage', 'control-store-worker.mjs'))
  );
  type Forecast = ReturnType<typeof ControlPhysicalForecastSchema.parse>;
  type Pending = {
    resolve: (reply: ControlWorkerReply) => void;
    reject: (error: Error) => void;
    forecast: (value: Forecast) => void;
    reservations: FileStorageReservation[];
  };
  const pending = new Map<number, Pending>();
  const terminalCounts = new Map<number, number>();
  const errors: Error[] = [];
  let nextId = 0;
  const allReservations = new Set<FileStorageReservation>();
  const release = (values: readonly FileStorageReservation[]) => {
    for (const value of values) {
      value.release();
      allReservations.delete(value);
    }
  };
  const fail = (error: Error) => {
    errors.push(error);
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  };
  worker.on('message', (value: unknown) => {
    try {
      if (
        typeof value === 'object' &&
        value !== null &&
        'status' in value &&
        value.status === 'physical-forecast'
      ) {
        const forecast = ControlPhysicalForecastSchema.parse(value);
        const operation = pending.get(forecast.id);
        if (!operation || forecast.database !== f.database)
          throw new Error('Uncorrelated actual raw OPEN forecast.');
        operation.forecast(forecast);
        return;
      }
      if (!isControlWorkerReply(value)) throw new Error('Invalid actual raw native reply.');
      const operation = pending.get(value.id);
      terminalCounts.set(value.id, (terminalCounts.get(value.id) ?? 0) + 1);
      if (!operation) throw new Error('Unexpected or duplicate actual raw terminal reply.');
      pending.delete(value.id);
      release(operation.reservations);
      operation.resolve(value);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  worker.on('error', fail);
  const exited = new Promise<number>((resolve) => {
    worker.on('exit', (code) => {
      if (pending.size)
        fail(new Error(`Actual raw native Worker exited ${code} with accepted requests pending.`));
      resolve(code);
    });
  });
  rawCleanups.push(async () => {
    await worker.terminate(); // Only this test-owned dedicated Worker; retains unknown on a failed case.
    release([...allReservations]);
  });
  function post(body: ControlWorkerCommand) {
    const id = nextId++;
    const reservations: FileStorageReservation[] = [];
    if (body.operation === 'open') {
      const wal = admission.forPath(f.path).reserve({
        stagingBytes: 0n,
        extractionBytes: 0n,
        derivativeBytes: 0n,
        publicationBytes: BigInt(CONTROL_STORE_BUDGET.maxWalBytes),
      });
      reservations.push(wal);
      allReservations.add(wal);
    }
    let markForecast!: (value: Forecast) => void;
    const physicalForecast = new Promise<Forecast>((resolve) => {
      markForecast = resolve;
    });
    const reply = new Promise<ControlWorkerReply>((resolve, reject) => {
      pending.set(id, { resolve, reject, forecast: markForecast, reservations });
      try {
        worker.postMessage({ version: CONTROL_WORKER_VERSION, id, ...body });
      } catch (error) {
        pending.delete(id);
        release(reservations);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      id,
      reply,
      forecast: () =>
        Promise.race([
          physicalForecast,
          reply.then((value) => {
            throw new Error(
              `Original native request settled before its required physical forecast: ${JSON.stringify(value)}`
            );
          }),
        ]),
    };
  }
  function decide(forecast: Forecast) {
    const operation = pending.get(forecast.id);
    if (!operation || forecast.database !== f.database)
      throw new Error('Forecast no longer belongs to the original raw request.');
    let decision: 'admitted' | 'no-space' = 'admitted';
    const reserved: FileStorageReservation[] = [];
    let refusal: unknown;
    try {
      for (const file of forecast.files) {
        expect(file.path).toBe(f.appRoot);
        const actual = admission.forPath(file.path).reserve({
          stagingBytes: 0n,
          extractionBytes: 0n,
          derivativeBytes: 0n,
          publicationBytes: BigInt(file.publicationBytes),
        });
        reserved.push(actual);
      }
      operation.reservations.push(...reserved);
      for (const value of reserved) allReservations.add(value);
    } catch (error) {
      release(reserved);
      if (!(error instanceof FileAdmissionError)) throw error;
      refusal = error;
      decision = 'no-space';
    }
    worker.postMessage(
      ControlPhysicalForecastDecisionSchema.parse({
        version: CONTROL_WORKER_VERSION,
        operation: 'physical-forecast',
        id: forecast.id,
        database: forecast.database,
        decision,
      })
    );
    return { decision, refusal };
  }
  return {
    worker,
    post,
    decide,
    pending,
    terminalCounts,
    errors,
    exited,
    deny: (value: boolean) => {
      denyCapacity = value;
    },
  };
}

it('refuses the real cold App physical forecast before source SQLite and admits one explicit next OPEN after cleanup', async () => {
  const f = await fixture();
  const raw = await rawAppScope(f);
  const before = inventory(f.appRoot);
  const first = raw.post({ ...f.opening, operation: 'open' });
  const forecast = await first.forecast();
  expect(inventory(f.appRoot)).toEqual(before);
  expect({
    main: observed.main,
    native: observed.native.filter((row) => row.closed === undefined),
  }).toEqual({ main: [], native: [] });
  raw.deny(true);
  const refused = raw.decide(forecast);
  expect(refused.decision).toBe('no-space');
  expect(refused.refusal).toBeInstanceOf(FileAdmissionError);
  expect(refused.refusal).toMatchObject({ code: 'storage_capacity_unavailable' });
  expect(await first.reply).toMatchObject({
    id: first.id,
    status: 'error',
    code: 'no-space',
    commit: 'not-committed',
  });
  expect(raw.terminalCounts.get(first.id)).toBe(1);
  expect(raw.pending.size).toBe(0);
  expect({
    main: observed.main,
    native: observed.native.filter((row) => row.closed === undefined),
  }).toEqual({ main: [], native: [] });
  expect(inventory(f.appRoot)).toEqual(before);
  raw.deny(false);
  const next = raw.post({ ...f.opening, operation: 'open' });
  expect(next.id).not.toBe(first.id);
  const nextForecast = await next.forecast();
  expect(raw.decide(nextForecast)).toEqual({ decision: 'admitted', refusal: undefined });
  expect(await next.reply).toMatchObject({ id: next.id, status: 'ok', operation: 'open' });
  expect(raw.terminalCounts.get(next.id)).toBe(1);
  expect(
    getRecord(
      f.root,
      f.context.workspaceId,
      f.app.appId,
      'notes',
      f.record.id,
      f.app.schemaRevision
    )
  ).toEqual(f.record);
  expect(
    getCommandRequestRecord(
      f.root,
      f.scope,
      commandRequestKey('kernel.records.create', f.recordRequestId, f.scope),
      new Date().toISOString()
    )
  ).toEqual(f.receipt);
  const close = raw.post({ operation: 'close', database: f.database });
  expect(await close.reply).toMatchObject({ id: close.id, status: 'ok', operation: 'close' });
  const shutdown = raw.post({ operation: 'shutdown' });
  expect(await shutdown.reply).toMatchObject({
    id: shutdown.id,
    status: 'ok',
    operation: 'shutdown',
  });
  expect(raw.pending.size).toBe(0);
  expect(await raw.exited).toBe(0);
  expect(raw.errors).toEqual([]);
  expect(inventory(f.appRoot)).toEqual(before);
  expect({ wal: existsSync(`${f.path}-wal`), shm: existsSync(`${f.path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
});

it('joins an accepted raw native App OPEN across its real held forecast before physical close and SHUTDOWN ACK', async () => {
  const f = await fixture();
  const raw = await rawAppScope(f);
  const before = inventory(f.appRoot);
  const open = raw.post({ ...f.opening, operation: 'open' });
  const forecast = await open.forecast();
  expect(raw.terminalCounts.has(open.id)).toBe(false);
  expect(inventory(f.appRoot)).toEqual(before);
  expect({
    main: observed.main,
    native: observed.native.filter((row) => row.closed === undefined),
  }).toEqual({ main: [], native: [] });
  // Same genuine MessagePort: native shutdown is posted before the original forecast decision.
  // The positive OPEN/physical-close/shutdown ordering cannot be supplied by client.shutdown.
  const shutdown = raw.post({ operation: 'shutdown' });
  expect(raw.decide(forecast)).toEqual({ decision: 'admitted', refusal: undefined });
  const [opened, stopped] = await Promise.all([open.reply, shutdown.reply]);
  expect(opened).toMatchObject({ id: open.id, status: 'ok', operation: 'open' });
  expect(stopped).toMatchObject({ id: shutdown.id, status: 'ok', operation: 'shutdown' });
  expect(raw.terminalCounts.get(open.id)).toBe(1);
  expect(raw.terminalCounts.get(shutdown.id)).toBe(1);
  expect(raw.pending.size).toBe(0);
  const sourceConstructors = observed.native.filter(
    (row) => !row.readonly && row.closed === undefined
  );
  const sourceClosed = observed.native.filter((row) => !row.readonly && row.closed === true);
  expect(sourceConstructors).toHaveLength(1);
  expect(sourceClosed).toHaveLength(1);
  const openAck = observed.replies.filter(
    (row) => row.worker === raw.worker && row.message.id === open.id && row.message.status === 'ok'
  );
  const shutdownAck = observed.replies.filter(
    (row) =>
      row.worker === raw.worker && row.message.id === shutdown.id && row.message.status === 'ok'
  );
  expect(openAck).toHaveLength(1);
  expect(shutdownAck).toHaveLength(1);
  expect(sourceConstructors[0]!.sequence).toBeLessThan(openAck[0]!.sequence);
  expect(openAck[0]!.sequence).toBeLessThan(sourceClosed[0]!.sequence);
  expect(sourceClosed[0]!.sequence).toBeLessThan(shutdownAck[0]!.sequence);
  expect(await raw.exited).toBe(0);
  expect(raw.errors).toEqual([]);
  expect(inventory(f.appRoot)).toEqual(before);
  expect({ wal: existsSync(`${f.path}-wal`), shm: existsSync(`${f.path}-shm`) }).toEqual({
    wal: false,
    shm: false,
  });
});

it('keeps a stopped Workspace fully capturable after a genuine App inspection Worker dies with a physically closed private copy', async () => {
  const f = await fixture();
  // Match the mature stopped-capture fixture's real canonical account and membership prerequisites.
  const coreDb = openCoreDb(f.root);
  try {
    const ownerId = ensureLocalUser(coreDb);
    expect(ownerId).toBe(FIXTURE_LOCAL_USER_ID);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: f.context.workspaceId,
      ownerUserId: ownerId,
    });
  } finally {
    coreDb.sqlite.close();
  }
  const raw = await rawAppScope(f);
  const original = inventory(f.appRoot);
  const originalDb = original.files.find((file) => file.path === relative(f.appRoot, f.path));
  expect(originalDb).toBeDefined();
  const copied = new Promise<Parameters<NonNullable<typeof observed.copyClosed>>[0]>((resolve) => {
    observed.copyClosed = resolve;
  });
  Atomics.store(new Int32Array(observed.copyCloseGate), 0, 1);
  const opening = raw.post({ ...f.opening, operation: 'open' });
  // Observe the original request's real terminal state even if a later assertion fails.
  const openingOutcome = opening.reply.then(
    (reply) => ({ kind: 'reply' as const, reply }),
    (error) => ({ kind: 'unknown' as const, error })
  );
  const forecast = await opening.forecast();
  expect(raw.decide(forecast)).toEqual({ decision: 'admitted', refusal: undefined });
  const copy = await copied;
  expect(copy.physicallyClosed).toBe(true);
  expect(copy.bytes).toBe(originalDb!.bytes);
  expect(copy.sha256).toBe(originalDb!.sha256);
  const actualCopy = lstatSync(copy.path, { bigint: true });
  expect({
    dev: String(actualCopy.dev),
    ino: String(actualCopy.ino),
    bytes: String(actualCopy.size),
  }).toEqual({ dev: copy.dev, ino: copy.ino, bytes: copy.bytes });
  expect(dirname(dirname(copy.path))).toBe(f.appRoot);
  expect(copy.path).not.toBe(f.path);
  expect(observed.privateNative).toEqual([]);
  expect(observed.main).toEqual([]);
  expect(observed.native).toEqual([]);
  expect(raw.terminalCounts.has(opening.id)).toBe(false);
  const terminated = await raw.worker.terminate();
  expect(await raw.exited).toBe(terminated);
  expect(terminated).not.toBe(0);
  const unknown = await openingOutcome;
  expect(unknown.kind).toBe('unknown');
  if (unknown.kind !== 'unknown')
    throw new Error('Terminated original OPEN unexpectedly acknowledged.');
  expect(unknown.error).toBeInstanceOf(Error);
  expect(String(unknown.error)).toContain('with accepted requests pending');
  expect(raw.terminalCounts.has(opening.id)).toBe(false);
  expect(raw.pending.size).toBe(0);
  expect(raw.errors).toHaveLength(1);
  expect(observed.privateNative).toEqual([]);
  expect(observed.main).toEqual([]);
  expect(observed.native).toEqual([]);
  const scratch = dirname(copy.path);
  const scratchRelative = relative(f.appRoot, scratch);
  const retained = inventory(f.appRoot);
  expect({
    files: retained.files.filter((file) => !file.path.startsWith(`${scratchRelative}/`)),
    directories: retained.directories.filter(
      (path) => path !== scratchRelative && !path.startsWith(`${scratchRelative}/`)
    ),
  }).toEqual(original);
  expect(retained.files.filter((file) => file.path.startsWith(`${scratchRelative}/`))).toHaveLength(
    1
  );
  expect(readFileSync(copy.path)).toEqual(readFileSync(f.path));
  await shutdownControlStoreWorkerClient();
  // These are deliberate crash artifacts. Retain the original and clone; no oracle removes scratch.
  const rootIndex = roots.indexOf(f.root);
  expect(rootIndex).not.toBe(-1);
  roots.splice(rootIndex, 1);
  const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-app-inspection-crash-capture-'));
  const stoppedRoot = join(captureRoot, 'stopped-source');
  cpSync(f.root, stoppedRoot, { recursive: true });
  const clonedAppRoot = lightAppRoot(stoppedRoot, f.context.workspaceId, f.app.appId);
  expect(
    inventory(clonedAppRoot).files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
  ).toEqual(retained.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })));
  expect(inventory(f.appRoot)).toEqual(retained);
  const stagingParent = join(captureRoot, 'staging');
  mkdirSync(stagingParent);
  const expectedRelease = {
    version: '0.1.0-app-crash-oracle',
    buildId: 'independent-native-preparation-crash',
  };
  const policy = {
    ...WORKSPACE_BACKUP_POLICY,
    stagingParent,
    admission: new FileStorageAdmission(captureRoot, () => 0n),
    expectedRelease,
  };
  const backupId = allocateEntityId('wsbak');
  const bundleRoot = join(captureRoot, 'bundle');
  const crashEvidence = {
    originalRoot: f.root,
    stoppedRoot,
    scratch: copy.path,
    copy,
    originalOpenId: opening.id,
    originalOpenOutcome: 'unknown',
    actualWorkerExit: terminated,
  };
  process.stderr.write(`${JSON.stringify({ appInspectionCrash: crashEvidence })}\n`);
  const captured = await createWorkspaceBackup({
    ...policy,
    source: { kind: 'stopped-data-root', dataRoot: stoppedRoot },
    expectedSourceDeploymentId: readDataRootLayoutMarker(stoppedRoot).deploymentId,
    workspaceId: f.context.workspaceId,
    backupId,
    purpose: 'backup',
    bundleRoot,
  });
  expect(captured.disposition).toBe('sealed');
  expect(captured.manifest.backupId).toBe(backupId);
  const staged = await stageWorkspaceBackup({
    ...policy,
    bundleRoot,
    candidateRoot: join(captureRoot, 'complete-verified-candidate'),
    expectedWorkspaceId: f.context.workspaceId,
    expectedSourceDeploymentId: captured.manifest.sourceDeploymentId,
    purpose: 'backup',
  });
  expect(staged.disposition).toBe('staged');
  expect(staged.report.manifestDigest).toBe(captured.report.manifestDigest);
  const readbackRoot = join(captureRoot, 'verified-readback');
  const readbackWorkspace = join(readbackRoot, 'workspaces', f.context.workspaceId);
  await withVerifiedWorkspaceBackupBundle({ ...policy, bundleRoot }, async (bundle) => {
    expect(bundle.seal?.backupId).toBe(backupId);
    expect(bundle.manifestDigest).toBe(captured.report.manifestDigest);
    for (const file of bundle.manifest.inventory) {
      const chunks: Buffer[] = [];
      for await (const chunk of bundle.readFile(file.path)) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(file.sha256);
      const path = join(readbackWorkspace, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  });
  expect(
    getRecord(
      readbackRoot,
      f.context.workspaceId,
      f.app.appId,
      'notes',
      f.record.id,
      f.app.schemaRevision
    )
  ).toEqual(f.record);
  expect(
    getCommandRequestRecord(
      readbackRoot,
      f.scope,
      commandRequestKey('kernel.records.create', f.recordRequestId, f.scope),
      new Date().toISOString()
    )
  ).toEqual(f.receipt);
  expect(readFileSync(join(clonedAppRoot, relative(f.appRoot, copy.path)))).toEqual(
    readFileSync(copy.path)
  );
  expect(inventory(f.appRoot)).toEqual(retained);
});
