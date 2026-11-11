// openkit-test-platform: posix
/** Storage65: genuine Main reader release precedes the actual physical native final close. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker, WorkerOptions } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { lightAppDbPath, openExistingAppDb } from './app-db.js';
import { getWorkspaceProductReadHandle } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openCoreReadDb, openUserReadDb, openWorkspaceReadDb } from './db.js';
import { coreDbPath, ensureLayout, userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

type ObservedWorker = NativeWorker & {
  observe(path: string): Promise<void>;
  releaseOpenAck(): void;
};
const observation = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  selectedPath: '',
  holdOpenAck: false,
  openAckCaptured: undefined as (() => void) | undefined,
  workers: [] as ObservedWorker[],
  paths: new Map<string, ObservedWorker>(),
}));

// The extra messages are test-observer metadata only. Native requests and original replies
// still use the genuine receiver; the driver observation never substitutes an ACK or SQL result.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private observationId = 0;
      private observationPending: { id: number; resolve: () => void } | undefined;
      private opening: { id: number; path: string } | undefined;
      private heldOpenAck: (() => boolean) | undefined;
      constructor(filename: string | URL, options?: WorkerOptions) {
        const require = createRequire(import.meta.url);
        const prelude = `
          const {parentPort, workerData} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const nativeClose = Database.prototype.close;
          let selectedPath = workerData.selectedPath;
          const gate = workerData.gate;
          Database.prototype.close = function(...args) {
            const selected = !this.readonly && this.name === selectedPath;
            const retained = selected && Atomics.load(gate, 0) === 1;
            if (selected) Atomics.add(gate, 1, 1);
            const result = nativeClose.apply(this, args);
            if (selected) {
              Atomics.add(gate, 2, 1);
              if (retained) Atomics.add(gate, 3, 1);
            }
            return result;
          };
          // Wrap the actual receiver registration. An early standalone listener would
          // start MessagePort before the genuine entry is imported.
          const on = parentPort.on;
          parentPort.on = function(event, listener) {
            if (event !== 'message') return on.call(this, event, listener);
            return on.call(this, event, function(value, ...args) {
              if (value?.__openkitReaderCloseObservation === true) {
                selectedPath = value.path;
                parentPort.postMessage({__openkitReaderCloseObservation: true, id: value.id});
                return;
              }
              return listener.call(this, value, ...args);
            });
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        if (!observation.gate)
          throw new Error('Reader close observer was not armed before native setup.');
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            databaseModule: require.resolve('better-sqlite3'),
            gate: new Int32Array(observation.gate),
            selectedPath: observation.selectedPath,
          },
        });
        observation.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        const value = args[0] as { id?: number; operation?: string; path?: string } | undefined;
        if (
          value?.operation === 'open' &&
          typeof value.path === 'string' &&
          typeof value.id === 'number'
        ) {
          observation.paths.set(value.path, this);
          this.opening = { id: value.id, path: value.path };
        }
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0] as
          | {
              id?: number;
              operation?: string;
              status?: string;
              __openkitReaderCloseObservation?: boolean;
            }
          | undefined;
        if (event === 'message' && value?.__openkitReaderCloseObservation === true) {
          const pending = this.observationPending;
          if (!pending || value.id !== pending.id)
            throw new Error('Unmatched native reader observation.');
          this.observationPending = undefined;
          pending.resolve();
          return true;
        }
        if (
          event === 'message' &&
          observation.holdOpenAck &&
          this.opening?.path === observation.selectedPath &&
          value?.id === this.opening.id &&
          value.operation === 'open' &&
          value.status === 'ok'
        ) {
          if (this.heldOpenAck) throw new Error('Original User open replied more than once.');
          this.heldOpenAck = () => super.emit(event, ...args);
          observation.openAckCaptured?.();
          return true;
        }
        return super.emit(event, ...args);
      }
      observe(path: string): Promise<void> {
        if (this.observationPending) throw new Error('Concurrent native reader observation.');
        const id = ++this.observationId;
        return new Promise<void>((resolve) => {
          this.observationPending = { id, resolve };
          super.postMessage({ __openkitReaderCloseObservation: true, id, path });
        });
      }
      releaseOpenAck(): void {
        const forward = this.heldOpenAck;
        if (!forward) throw new Error('No original User open ACK is held.');
        this.heldOpenAck = undefined;
        observation.holdOpenAck = false;
        forward();
      }
    },
  };
});

/** Arms one fixed physical path and four scalar observations for this fixture lifetime. */
function arm(path = ''): Int32Array {
  observation.gate = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  observation.selectedPath = path;
  observation.holdOpenAck = false;
  observation.openAckCaptured = undefined;
  observation.paths.clear();
  observation.workers.length = 0;
  return new Int32Array(observation.gate);
}

/** A public App producer is needed only for the real physical App family. */
async function fixture(kind: 'core' | 'user' | 'workspace' | 'app') {
  const root = mkdtempSync(join(tmpdir(), 'openkit-reader-native-close-'));
  const gate = arm();
  const coreDb = openCoreDb(root);
  let held: Database.Database | undefined;
  onTestFinished(async () => {
    if (held?.open) held.close();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const client = getControlStoreWorkerClient();
  let appId: string | undefined;
  if (kind === 'app') {
    const app = createApp({ coreDb, dataRoot: root, store });
    const request = (
      operation: Parameters<typeof operationRequest>[0],
      input: Record<string, unknown>
    ) =>
      app.request(
        ...operationRequest(operation, input, { headers: { 'x-openkit-request-id': randomUUID() } })
      );
    const created = await request('kernel.apps.create', {
      workspaceId: DEMO_WORKSPACE_ID,
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Reader close fixture',
      purpose: 'Preserve actual native publication through reader close.',
      collections: [
        {
          name: 'notes',
          type: 'base',
          description: 'Retained notes.',
          fields: [{ name: 'text', type: 'text', required: true, description: 'Original text.' }],
          indexes: [],
        },
      ],
    });
    expect(created.status).toBe(201);
    const definition = await created.json();
    appId = definition.appId;
    const published = await request('kernel.records.create', {
      workspaceId: DEMO_WORKSPACE_ID,
      appId,
      collection: 'notes',
      schemaRevision: definition.schemaRevision,
      data: { text: 'Original reader-close record.' },
    });
    expect(published.status).toBe(200);
    const record = await published.json();
    const read = await request('kernel.records.list', {
      workspaceId: DEMO_WORKSPACE_ID,
      appId,
      collection: 'notes',
      schemaRevision: definition.schemaRevision,
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      completeResult: true,
      totalItems: 1,
      items: [record],
    });
  }
  if (kind === 'core') {
    const scope = nativeProductScope(root, { kind: 'server' });
    await client.open({
      database: `core:${scope.path}`,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
  }
  if (kind === 'user') {
    const initialized = await client.openInitializedUserReadDb(root, userId);
    initialized.sqlite.close();
  }
  const path =
    kind === 'core'
      ? coreDbPath(root)
      : kind === 'user'
        ? userDbPath(root, userId)
        : kind === 'workspace'
          ? workspaceDbPath(root, DEMO_WORKSPACE_ID)
          : lightAppDbPath(root, DEMO_WORKSPACE_ID, appId!);
  const worker = observation.paths.get(path);
  expect(worker).toBeDefined();
  await worker!.observe(path);
  await client.checkpoint(`${kind}:${path}`);
  coreDb.sqlite.close();
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  const open = () => {
    held = (
      kind === 'core'
        ? openCoreReadDb(root)
        : kind === 'user'
          ? openUserReadDb(root, userId)
          : kind === 'workspace'
            ? openWorkspaceReadDb(root, DEMO_WORKSPACE_ID)
            : openExistingAppDb(root, DEMO_WORKSPACE_ID, appId!)
    ).sqlite;
    Atomics.store(gate, 0, 1);
    return held;
  };
  return { root, gate, client, path, worker: worker!, before, open };
}

/** Proves the actual selected handle's policy with a protected genuine DML attempt. */
function assertReader(sqlite: Database.Database): void {
  expect(sqlite.readonly).toBe(true);
  expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
  const table = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1"
    )
    .pluck()
    .get() as string;
  expect(typeof table).toBe('string');
  expect(() =>
    sqlite.prepare(`DELETE FROM "${table.replaceAll('"', '""')}" WHERE 0`).run()
  ).toThrow(/readonly/);
}

it.each(['core', 'user', 'workspace', 'app'] as const)(
  'releases an actual held Main %s reader before successful physical native shutdown',
  async (kind) => {
    const f = await fixture(kind);
    const reader = f.open();
    assertReader(reader);
    const shuttingDown = f.client.shutdown();
    const outcome = shuttingDown.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );
    try {
      await nextTurn();
      // A genuine native observation barrier establishes worker progress. If the actual
      // shutdown already settled, that original outcome is sufficient progress instead.
      await Promise.race([f.worker.observe(f.path), outcome]);
      expect(reader.open).toBe(true);
      expect(
        Atomics.load(f.gate, 2),
        'actual native physical close while caller still retains its reader'
      ).toBe(0);
    } finally {
      if (reader.open) reader.close();
      Atomics.store(f.gate, 0, 0);
      await outcome;
    }
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(Atomics.load(f.gate, 1)).toBe(1);
    expect(Atomics.load(f.gate, 2)).toBe(1);
    expect(Atomics.load(f.gate, 3)).toBe(0);
    expect(existsSync(`${f.path}-wal`)).toBe(false);
    expect(existsSync(`${f.path}-shm`)).toBe(false);
    expect(createHash('sha256').update(readFileSync(f.path)).digest('hex')).toBe(f.before);
  },
  30_000
);

it('joins an accepted first User open ACK and the actual future Main reader before physical close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-first-reader-close-'));
  ensureLayout(root);
  const path = userDbPath(root, FIXTURE_LOCAL_USER_ID);
  expect(existsSync(path)).toBe(false);
  const gate = arm(path);
  Atomics.store(gate, 0, 1); // Accepted acquisition remains live before any Main reader exists.
  observation.holdOpenAck = true;
  let captured!: () => void;
  const capturedAck = new Promise<void>((resolve) => {
    captured = resolve;
  });
  observation.openAckCaptured = captured;
  const client = getControlStoreWorkerClient();
  let reader: Awaited<ReturnType<typeof client.openInitializedUserReadDb>> | undefined;
  let close: Promise<void> | undefined;
  onTestFinished(async () => {
    observation.holdOpenAck = false;
    if (reader?.sqlite.open) reader.sqlite.close();
    Atomics.store(gate, 0, 0);
    await close?.catch(() => {});
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
  });
  const opening = client.openInitializedUserReadDb(root, FIXTURE_LOCAL_USER_ID);
  await capturedAck;
  const worker = observation.paths.get(path)!;
  expect(worker).toBeDefined();
  close = client.close(`user:${path}`);
  const outcome = close.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  );
  try {
    await nextTurn();
    await Promise.race([worker.observe(path), outcome]);
    expect(
      Atomics.load(gate, 2),
      'accepted future User reader before original open ACK delivery'
    ).toBe(0);
    worker.releaseOpenAck();
    reader = await opening;
    assertReader(reader.sqlite);
    await nextTurn();
    await Promise.race([worker.observe(path), outcome]);
    expect(reader.sqlite.open).toBe(true);
    expect(
      Atomics.load(gate, 2),
      'actual future User reader after original open ACK delivery'
    ).toBe(0);
  } finally {
    if (observation.holdOpenAck) worker.releaseOpenAck();
    reader ??= await opening;
    if (reader.sqlite.open) reader.sqlite.close();
    Atomics.store(gate, 0, 0);
    await outcome;
  }
  await expect(close).resolves.toBeUndefined();
  expect(Atomics.load(gate, 1)).toBe(1);
  expect(Atomics.load(gate, 2)).toBe(1);
  expect(Atomics.load(gate, 3)).toBe(0);
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
}, 30_000);

it('retains failed cached physical reader close as a failure on explicit scoped retry', async () => {
  let selected: Database.Database | undefined;
  let fail = true;
  const failure = new Error('Injected actual cached-reader driver close failure.');
  const originalClose = Database.prototype.close;
  const injected = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
    this: Database.Database
  ) {
    if (this === selected && fail) throw failure;
    return originalClose.call(this);
  });
  const f = await fixture('workspace');
  const cached = getWorkspaceProductReadHandle(f.path, {
    kind: 'workspace',
    workspaceId: DEMO_WORKSPACE_ID,
  });
  selected = cached.sqlite;
  assertReader(selected);
  Atomics.store(f.gate, 0, 1);
  try {
    await expect(f.client.close(`workspace:${f.path}`)).rejects.toBe(failure);
    expect(selected.open).toBe(true);
    expect(Atomics.load(f.gate, 2)).toBe(0);
    // This is a new explicit lifecycle call, not a replay of a business mutation.
    await expect(f.client.close(`workspace:${f.path}`)).rejects.toBe(failure);
    expect(selected.open).toBe(true);
    expect(Atomics.load(f.gate, 2)).toBe(0);
  } finally {
    fail = false;
    if (selected.open) selected.close();
    Atomics.store(f.gate, 0, 0);
    injected.mockRestore();
  }
  await expect(f.client.close(`workspace:${f.path}`)).resolves.toBeUndefined();
  expect(Atomics.load(f.gate, 2)).toBe(1);
  expect(Atomics.load(f.gate, 3)).toBe(0);
  expect(existsSync(`${f.path}-wal`)).toBe(false);
  expect(existsSync(`${f.path}-shm`)).toBe(false);
}, 30_000);

it('joins an actual App reader opened through a different logical root alias before native close', async () => {
  const f = await fixture('app');
  const parent = mkdtempSync(join(tmpdir(), 'openkit-reader-parent-alias-'));
  const aliasRoot = join(parent, 'data-root-alias');
  symlinkSync(f.root, aliasRoot, 'dir');
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  const appId = basename(dirname(f.path));
  const reader = openExistingAppDb(aliasRoot, DEMO_WORKSPACE_ID, appId);
  assertReader(reader.sqlite);
  expect(reader.sqlite.name).toBe(lightAppDbPath(aliasRoot, DEMO_WORKSPACE_ID, appId));
  expect(reader.sqlite.name).not.toBe(f.path);
  const main = (
    reader.sqlite.pragma('database_list') as Array<{ name: string; file: string }>
  ).find((database) => database.name === 'main');
  expect(main?.file).toBe(f.path); // Installed POSIX SQLite VFS reports the actual opened canonical filename.
  Atomics.store(f.gate, 0, 1);
  const shuttingDown = f.client.shutdown();
  const outcome = shuttingDown.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  );
  try {
    await nextTurn();
    await Promise.race([f.worker.observe(f.path), outcome]);
    expect(reader.sqlite.open).toBe(true);
    expect(
      Atomics.load(f.gate, 2),
      'actual native physical App close while its alias-root Main reader remains open'
    ).toBe(0);
  } finally {
    if (reader.sqlite.open) reader.sqlite.close();
    Atomics.store(f.gate, 0, 0);
    await outcome;
  }
  await expect(shuttingDown).resolves.toBeUndefined();
  expect(Atomics.load(f.gate, 1)).toBe(1);
  expect(Atomics.load(f.gate, 2)).toBe(1);
  expect(Atomics.load(f.gate, 3)).toBe(0);
  expect(existsSync(`${f.path}-wal`)).toBe(false);
  expect(existsSync(`${f.path}-shm`)).toBe(false);
  expect(createHash('sha256').update(readFileSync(f.path)).digest('hex')).toBe(f.before);
}, 30_000);
