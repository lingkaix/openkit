// openkit-test-platform: posix
/** Storage65 and User-owned Read Receipts: current public admission and physical lifetime survive a real cold OPEN wait. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker, WorkerOptions } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { userDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import type { ThreadTimelineSnapshot } from './workspace-file-records.js';

type Frame = { worker: NativeWorker; message: Record<string, unknown>; order: number };
type ObservedWorker = NativeWorker & { observe(path: string): Promise<void> };
const seen = vi.hoisted(() => ({
  path: '',
  order: 0,
  readers: [] as Database.Database[],
  posts: [] as Frame[],
  replies: [] as Frame[],
  holdOpen: false,
  openCaptured: undefined as (() => void) | undefined,
  releaseOpen: undefined as (() => void) | undefined,
  gate: undefined as SharedArrayBuffer | undefined,
  pauseThread: '',
  admissions: 0,
  admissionCaptured: undefined as (() => void) | undefined,
  admissionRelease: undefined as Promise<void> | undefined,
  releaseAdmission: undefined as (() => void) | undefined,
}));

// Call through to genuine SQLite. No connection policy, SQL result or close is replaced.
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof Database }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const sqlite = Reflect.construct(target, args, newTarget) as Database.Database;
        if (args[0] === seen.path) seen.readers.push(sqlite);
        return sqlite;
      },
    }),
  };
});

// Delay only return from the second actual admission. Its original credential, scope and
// Thread checks execute unchanged first; no authority or result is fabricated.
vi.mock('../operation-resolvers.js', async (load) => {
  const actual = await load<typeof import('../operation-resolvers.js')>();
  const { OPERATION_DEFINITIONS } = await import('@openkit/app-api-schemas');
  return {
    ...actual,
    admitOperation: async (...args: Parameters<typeof actual.admitOperation>) => {
      const admitted = await actual.admitOperation(...args);
      if (
        seen.pauseThread &&
        args[0] === OPERATION_DEFINITIONS['thread.timeline'] &&
        (args[1] as { threadId?: string }).threadId === seen.pauseThread &&
        ++seen.admissions === 2
      ) {
        seen.admissionCaptured?.();
        await seen.admissionRelease;
      }
      return admitted;
    },
  };
});

// Original native requests and successful OPEN replies are forwarded unchanged. The
// optional physical-close observer is the existing reader-native-close-lifetime device,
// scoped to one actual User path. Its private messages supply no product acknowledgement.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private observationId = 0;
      private observationPending: { id: number; resolve: () => void } | undefined;
      constructor(filename: string | URL, options?: WorkerOptions) {
        if (!seen.gate) {
          super(filename, options);
          return;
        }
        const require = createRequire(import.meta.url);
        const prelude = `
          const {parentPort, workerData} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const nativeClose = Database.prototype.close;
          let selectedPath = '';
          const gate = workerData.gate;
          Database.prototype.close = function(...args) {
            const selected = selectedPath !== '' && !this.readonly && this.name === selectedPath;
            const retained = selected && Atomics.load(gate, 0) === 1;
            if (selected) Atomics.add(gate, 1, 1);
            const result = nativeClose.apply(this, args);
            if (selected) {
              Atomics.add(gate, 2, 1);
              if (retained) Atomics.add(gate, 3, 1);
            }
            return result;
          };
          // Register no early listener: wrap the genuine receiver registration.
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
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            databaseModule: require.resolve('better-sqlite3'),
            gate: new Int32Array(seen.gate),
          },
        });
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        seen.posts.push({
          worker: this,
          message: args[0] as Record<string, unknown>,
          order: ++seen.order,
        });
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0] as Record<string, unknown> | undefined;
        if (event === 'message' && value?.__openkitReaderCloseObservation === true) {
          const pending = this.observationPending;
          if (!pending || value.id !== pending.id)
            throw new Error('Unmatched native reader observation.');
          this.observationPending = undefined;
          pending.resolve();
          return true;
        }
        if (event === 'message' && typeof value === 'object' && value !== null) {
          const request = seen.posts.find(
            (row) => row.worker === this && row.message.id === value.id
          );
          const record = () =>
            seen.replies.push({ worker: this, message: value, order: ++seen.order });
          if (
            seen.holdOpen &&
            request?.message.path === seen.path &&
            value.operation === 'open' &&
            value.status === 'ok'
          ) {
            if (seen.releaseOpen) throw new Error('Original User OPEN replied twice.');
            seen.releaseOpen = () => {
              seen.releaseOpen = undefined;
              seen.holdOpen = false;
              record();
              super.emit(event, ...args);
            };
            seen.openCaptured?.();
            return true;
          }
          record();
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
    },
  };
});

const pending: Promise<unknown>[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  seen.releaseOpen?.();
  seen.releaseAdmission?.();
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  try {
    for (const finish of cleanup.splice(0).reverse()) await finish();
  } finally {
    seen.path = '';
    seen.order = 0;
    seen.readers = [];
    seen.posts = [];
    seen.replies = [];
    seen.holdOpen = false;
    seen.openCaptured = undefined;
    seen.releaseOpen = undefined;
    seen.gate = undefined;
    seen.pauseThread = '';
    seen.admissions = 0;
    seen.admissionCaptured = undefined;
    seen.admissionRelease = undefined;
    seen.releaseAdmission = undefined;
  }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function posts(operation: string, database?: string) {
  return seen.posts.filter(
    (row) =>
      row.message.operation === operation &&
      (database === undefined || row.message.database === database)
  );
}
function acks(operation: string, database?: string) {
  return posts(operation, database).flatMap((request) =>
    seen.replies.filter(
      (reply) =>
        reply.worker === request.worker &&
        reply.message.id === request.message.id &&
        reply.message.operation === operation &&
        reply.message.status === 'ok'
    )
  );
}
function clean(path: string) {
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
}
function source(path: string) {
  const metadata = statSync(path);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    bytes: metadata.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
async function reached(boundary: Promise<void>, request: Promise<unknown>, label: string) {
  await Promise.race([
    boundary,
    request.then(() => {
      throw new Error(`Public Timeline settled before ${label}.`);
    }),
  ]);
}
function report(name: string, facts: Record<string, unknown>) {
  process.stderr.write(`${JSON.stringify({ userTimelineTemporal: { name, ...facts } })}\n`);
}

// Same owner setup as owned-user-timeline-read: real Core/local User, Store Workspace,
// membership, Thread, Turn and message. A public mark-read creates the original User
// receipt; its real acknowledged close makes the supported existing User genuinely cold.
async function fixture(server = false) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-timeline-temporal-'));
  const coreDb = openCoreDb(root);
  cleanup.push(() => disposeTestStore(root, coreDb));
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Temporal Timeline');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Retained temporal reply');
  const turn = await store.createTurn(workspace.id, thread.id, 'Original input', {
    kind: 'user',
    id: userId,
  });
  const message = 'This retained reply must not escape revoked Timeline admission.';
  const item = await store.createItem({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    type: 'assistant-message',
    status: 'completed',
    text: message,
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
  const administrator = server
    ? createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      })
    : undefined;
  const app = createApp({
    coreDb,
    dataRoot: root,
    store,
    ...(server ? { mode: 'server' as const } : {}),
  });
  const request = async (
    name: Parameters<typeof operationRequest>[0],
    input: Record<string, unknown>,
    secret = token?.secret
  ): Promise<Response> =>
    app.request(
      ...operationRequest(name, input, {
        headers: {
          'x-openkit-request-id': randomUUID(),
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
      })
    );
  const selectors = { workspaceId: workspace.id, threadId: thread.id };
  const marked = await request('thread.mark-read', { ...selectors, itemIds: [item.id] });
  expect(marked.status).toBe(200);
  expect(await marked.json()).toEqual({ scope: 'window', acknowledgedItemIds: [item.id] });
  const path = userDbPath(root, userId);
  const database = `user:${path}`;
  const client = getControlStoreWorkerClient();
  expect(acks('thread-read-membership', database)).toHaveLength(1);
  const warm = await request('thread.timeline', { ...selectors, anchor: { kind: 'catch-up' } });
  expect(warm.status).toBe(200);
  const originalBody = await warm.json();
  expect(originalBody.catchUpAnchor).toEqual({ turnId: turn.id, itemId: item.id });
  expect(originalBody.runs.map((run: { id: string }) => run.id)).toEqual([turn.id]);
  await client.close(database);
  expect(acks('close', database)).toHaveLength(1);
  clean(path);
  const originalSource = source(path);
  seen.path = path;
  return {
    root,
    store,
    item,
    message,
    thread,
    request,
    selectors,
    token,
    administrator,
    client,
    path,
    database,
    originalBody,
    originalSource,
  };
}
function holdOriginalOpen() {
  const captured = deferred();
  seen.holdOpen = true;
  seen.openCaptured = captured.resolve;
  return captured.promise;
}

it('repeats actual public Timeline admission after its original cold User OPEN wait and refuses a publicly revoked bearer without disclosure', async () => {
  const f = await fixture(true);
  const openBefore = acks('open', f.database).length;
  const captured = holdOriginalOpen();
  const reading = f.request('thread.timeline', { ...f.selectors, anchor: { kind: 'catch-up' } });
  pending.push(reading);
  await reached(captured, reading, 'the genuine successful User OPEN reply');
  expect(acks('open', f.database)).toHaveLength(openBefore);
  expect(posts('open', f.database).at(-1)!.message).toMatchObject({
    path: f.path,
    create: false,
    initialize: 'user',
  });
  expect(seen.readers).toHaveLength(0);
  // This is the real public native Token revoke and its original later Audit, not a
  // raw SQL edit, cached actor mutation, fabricated denial or direct revoke helper.
  const revokeBefore = acks('access-token-lifecycle').length;
  const revoked = await f.request(
    'token.revoke',
    { tokenId: f.token!.tokenId },
    f.administrator!.secret
  );
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({
    record: { tokenId: f.token!.tokenId, status: 'revoked' },
  });
  expect(acks('access-token-lifecycle')).toHaveLength(revokeBefore + 1);
  expect(acks('open', f.database)).toHaveLength(openBefore);
  expect(seen.readers).toHaveLength(0);
  seen.releaseOpen!();
  const response = await reading;
  const body = await response.json();
  report('revoked-after-original-open-wait', {
    selectedOriginalOpen: true,
    deliveredOriginalAck: acks('open', f.database).length === openBefore + 1,
    revokeStatus: revoked.status,
    timelineStatus: response.status,
    refusalCode: body.code ?? null,
    mainReaders: seen.readers.length,
    allReadersClosed: seen.readers.every((reader) => !reader.open),
  });
  expect(response.status).toBe(403);
  expect(body).toMatchObject({ code: 'workspace_access_denied' });
  expect(JSON.stringify(body)).not.toContain(f.item.id);
  expect(JSON.stringify(body)).not.toContain(f.message);
  expect(acks('open', f.database)).toHaveLength(openBefore + 1);
  expect(seen.readers.length).toBeGreaterThan(0);
  for (const reader of seen.readers) {
    expect(reader.readonly).toBe(true);
    expect(reader.open).toBe(false);
  }
  await f.client.close(f.database);
  clean(f.path);
  expect(source(f.path)).toEqual(f.originalSource);
});

it('retains the actual User reader through Timeline current-admission continuation and projection while real native final close remains excluded', async () => {
  seen.gate = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const gate = new Int32Array(seen.gate);
  const f = await fixture();
  const captured = holdOriginalOpen();
  const admission = deferred();
  const release = deferred();
  seen.pauseThread = f.thread.id;
  seen.admissionCaptured = admission.resolve;
  seen.admissionRelease = release.promise;
  seen.releaseAdmission = release.resolve;
  const reading = f.request('thread.timeline', { ...f.selectors, anchor: { kind: 'catch-up' } });
  pending.push(reading);
  await reached(captured, reading, 'the genuine successful User OPEN reply');
  expect(seen.readers).toHaveLength(0);
  const native = posts('open', f.database).at(-1)!.worker as ObservedWorker;
  await native.observe(f.path); // The actual selected native receiver is live after its real OPEN.
  seen.releaseOpen!();
  await reached(admission.promise, reading, 'return from the actual second Timeline admission');
  expect(seen.admissions).toBeGreaterThan(1);
  const liveReaders = seen.readers.filter((reader) => reader.open);
  report('reader-at-real-admission-continuation', {
    selectedOriginalOpen: true,
    actualAdmissionCount: seen.admissions,
    actualReaderOpen: liveReaders.length > 0,
    actualMainReaders: seen.readers.length,
  });
  expect(liveReaders.length).toBeGreaterThan(0);
  const retained = liveReaders[0]!;
  expect(retained.open).toBe(true);
  expect(retained.readonly).toBe(true);
  expect(retained.pragma('query_only', { simple: true })).toBe(1);
  Atomics.store(gate, 0, 1);
  const originalClose = retained.close.bind(retained);
  vi.spyOn(retained, 'close').mockImplementation(() => {
    const result = originalClose();
    if (!retained.open) Atomics.store(gate, 0, 0); // Observe actual raw close, not request completion.
    return result;
  });
  let projections = 0;
  const originalSnapshot = f.store.readThreadTimelineSnapshot.bind(f.store);
  vi.spyOn(f.store, 'readThreadTimelineSnapshot').mockImplementation(
    <T>(
      workspaceId: string,
      threadId: string,
      read: (snapshot: ThreadTimelineSnapshot) => T
    ): T => {
      projections++;
      expect(retained.open).toBe(true);
      expect(Atomics.load(gate, 2)).toBe(0);
      const result = originalSnapshot(workspaceId, threadId, read);
      expect(retained.open).toBe(true);
      expect(Atomics.load(gate, 2)).toBe(0);
      return result;
    }
  );
  const closeBefore = acks('close', f.database).length;
  const closing = f.client.close(f.database);
  pending.push(closing);
  await native.observe(f.path); // Genuine same-owner progress while its physical close is pending.
  expect(retained.open).toBe(true);
  expect(Atomics.load(gate, 1)).toBe(0);
  expect(Atomics.load(gate, 2)).toBe(0);
  expect(acks('close', f.database)).toHaveLength(closeBefore);
  release.resolve();
  const response = await reading;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(f.originalBody);
  await closing;
  expect(projections).toBeGreaterThan(0);
  expect(retained.open).toBe(false);
  expect(acks('close', f.database)).toHaveLength(closeBefore + 1);
  expect(Atomics.load(gate, 0)).toBe(0);
  expect(Atomics.load(gate, 1)).toBe(1);
  expect(Atomics.load(gate, 2)).toBe(1);
  expect(Atomics.load(gate, 3)).toBe(0);
  expect(seen.readers.every((reader) => reader.readonly && !reader.open)).toBe(true);
  clean(f.path);
  expect(source(f.path)).toEqual(f.originalSource);
  report('physical-close-after-timeline-continuation', {
    actualAdmissionCount: seen.admissions,
    actualProjections: projections,
    nativeCloseCalls: Atomics.load(gate, 1),
    nativePhysicalCloses: Atomics.load(gate, 2),
    nativeCloseWhileReaderRetained: Atomics.load(gate, 3),
    allReadersClosed: seen.readers.every((reader) => !reader.open),
    sidecarsAbsent: !existsSync(`${f.path}-wal`) && !existsSync(`${f.path}-shm`),
  });
});
