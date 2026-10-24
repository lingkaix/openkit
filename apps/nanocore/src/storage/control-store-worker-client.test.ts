// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import type { JsonOperationId } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { initializeTestCore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  type ControlSqlStatement,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { createDataRootAdminOperationImplementations } from './data-root-admin-operations.js';
import * as dataRootBackup from './data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import {
  coreDbPath,
  ensureLayout,
  ensureUserLayout,
  ensureWorkspaceLayout,
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
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
            function hold() {
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
              if (commit && workerData.point === 'before') hold();
              const result = original.call(this, sql);
              if (commit && workerData.point === 'after') hold();
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
  return { client, root, workspaces, call };
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
  it('distinguishes descriptive row extensions from unsupported native object values', () => {
    const header = { version: CONTROL_WORKER_VERSION, id: 0, status: 'ok', operation: 'write' };
    expect(isControlWorkerReply({ ...header, results: [{ mode: 'get', row: new Date() }] })).toBe(
      false
    );
    expect(
      isControlWorkerReply({ ...header, results: [{ mode: 'get', row: new Uint8Array() }] })
    ).toBe(false);
    expect(
      isControlWorkerReply({
        ...header,
        description: 'ignored descriptive extension',
        results: [
          { mode: 'get', row: { payload: new Uint8Array([1]), futureColumn: 'retained scalar' } },
        ],
      })
    ).toBe(true);
    expect(
      isControlWorkerRequest({
        version: 1,
        id: 0,
        database: 'user',
        operation: 'open',
        path: '/unused.sqlite',
        create: true,
        initialize: 'user',
      })
    ).toBe(false);
  });

  it('shares one host, applies the real native journal, and preserves read-after-ack', async () => {
    const f = await fixture();
    expect(getControlStoreWorkerClient()).toBe(f.client);
    expect(interception.workers).toHaveLength(1);
    const result = await f.client.write('user', metadata('acknowledged'));
    expect(result).toMatchObject([{ mode: 'run', changes: 1 }]);
    expect(count(f.path)).toBe(1);
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      expect(reader.prepare('SELECT schema_version FROM thread_read_receipts').pluck().get()).toBe(
        1
      );
      expect(reader.pragma('auto_vacuum', { simple: true })).toBe(2);
      expect(() => reader.prepare('DELETE FROM thread_read_receipts').run()).toThrow();
    } finally {
      reader.close();
    }
    expect((await f.client.checkpoint('user')).walBytes).toBe(0);
    expect(await f.client.reclaim('user')).toBe(true);
    await f.client.close('user');
    await f.client.open({ database: 'user', path: f.path, create: false, initialize: 'user' });
    expect(count(f.path)).toBe(1);
  });

  it('pins open Workspace databases to four bounded hosts and keeps the server separate', async () => {
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const f = await poolFixture();
    const server = {
      database: `server:${coreDbPath(f.root)}`,
      path: coreDbPath(f.root),
      create: true,
      initialize: 'core' as const,
      productOwner: { kind: 'server' as const },
      dataRoot: f.root,
    };
    await f.client.open(server);
    // DX Write And Space Budget fixes four Workspace workers and one separate server worker.
    expect(interception.workers).toHaveLength(5);
    const originalHosts = Array.from({ length: 4 }, (_, index) => {
      const call = posted.mock.calls.findIndex(
        ([request]) => request.database === f.scope(index).database
      );
      expect(call).toBeGreaterThanOrEqual(0);
      return posted.mock.contexts[call];
    });
    expect(new Set(originalHosts).size).toBe(4);
    const serverCall = posted.mock.calls.findIndex(
      ([request]) => request.database === server.database
    );
    expect(originalHosts).not.toContain(posted.mock.contexts[serverCall]);
    for (let index = 4; index < 9; index += 1) await f.client.open(f.scope(index));
    for (let index = 0; index < 9; index += 1) {
      const { database } = f.scope(index);
      await f.client.write(database, nativeRequest(`scope-${index}`));
      await f.client.checkpoint(database);
      await f.client.reclaim(database);
      await f.client.close(database);
      const hosts = posted.mock.calls.flatMap(([request], call) =>
        request.database === database ? [posted.mock.contexts[call]] : []
      );
      expect(new Set(hosts).size).toBe(1);
      expect(originalHosts).toContain(hosts[0]);
    }
    expect(interception.workers).toHaveLength(5);
  });

  it.each([
    'before',
    'after',
  ] as const)('keeps healthy Workspace ACKs independent of a sibling held %s COMMIT and its lost host', async (point) => {
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
      await expect(f.client.write(healthy.database, nativeRequest('later'))).resolves.toHaveLength(
        1
      );
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
  });

  it.each([
    false,
    true,
  ])('excludes canonical and hardlink aliases process-wide with held fresh ACK = %s', async (held) => {
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
  });

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

  it('shares Material binary admission across four real Workspace workers before posting', async () => {
    interception.gate = new SharedArrayBuffer(12);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1); // Setup remains outside the real COMMIT holds.
    const f = await productPoolFixture();
    const materials = [];
    for (let index = 0; index < 5; index += 1) {
      const workspaceId = f.workspaces[Math.min(index, 3)]!.id;
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
    // Existing process-wide admission is 64 MiB; four maximum-size valid saves fill it exactly.
    expect(CONTROL_WORKER_LIMITS.materialPendingBytes).toBe(67_108_864);
    Atomics.store(gate, 0, 0);
    Atomics.store(gate, 2, 1); // Hold each real host, so no settled reply frees its binary reservation.
    const accepted = Array.from({ length: 4 }, (_, index) => save(index, 'a'.repeat(16_777_216)));
    const settled = Promise.allSettled(accepted);
    try {
      await admitted;
      const materialRequests = posted.mock.calls.flatMap(([request], index) =>
        request.operation === 'material' ? [{ request, host: posted.mock.contexts[index] }] : []
      );
      expect(materialRequests).toHaveLength(4);
      expect(new Set(materialRequests.map(({ host }) => host)).size).toBe(4);
      while (Atomics.load(gate, 0) < 4) await nextTurn();
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
    } finally {
      release(gate);
      await settled;
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(4);
    // The fifth request becomes admissible only after the original reservations settle.
    await expect(save(4, 'x')).resolves.toHaveProperty('revisionId');
    await finishKnowledge();
  });

  it('refuses excess work before postMessage and keeps sibling admission separate', async () => {
    const f = await fixture();
    await f.client.open({
      database: 'sibling',
      path: join(f.root, 'sibling.sqlite'),
      create: true,
      initialize: 'user',
    });
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const sql: ControlSqlStatement[] = [{ mode: 'get', sql: 'SELECT 1 AS value', parameters: [] }];
    const accepted = Array.from({ length: CONTROL_WORKER_LIMITS.pendingTransitions }, () =>
      f.client.write('user', sql)
    );
    const excess = f.client.write('user', sql);
    expect(posted.mock.calls.filter(([message]) => message.operation === 'write')).toHaveLength(
      CONTROL_WORKER_LIMITS.pendingTransitions
    );
    await expect(excess).rejects.toMatchObject({ code: 'busy', commit: 'not-committed' });
    const sibling = f.client.write('sibling', sql);
    await Promise.all(accepted);
    await expect(sibling).resolves.toMatchObject([{ mode: 'get', row: { value: 1n } }]);
    await expect(f.client.write('user', sql)).resolves.toHaveLength(1);
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

  it('refuses shared binary backing before posting while another COMMIT is blocked', async () => {
    const f = await fixture('before');
    const barrier = f.client.write('user', metadata('barrier'));
    await waitForHold(f.gate!);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const bytes = new Uint8Array(new SharedArrayBuffer(4));
    bytes.set([1, 2, 3, 4]);
    const submitted = f.client
      .write('user', [{ mode: 'get', sql: 'SELECT ? AS payload', parameters: [bytes] }])
      .catch((error: unknown) => error);
    bytes[0] = 9;
    release(f.gate);
    await barrier;
    expect(await submitted).toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
    expect(posted).not.toHaveBeenCalled();
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

  it('terminates a transport that cannot decode messages instead of retaining its writer', async () => {
    const f = await fixture('before');
    const write = f.client.write('user', metadata('unreadable')).catch((error: unknown) => error);
    await waitForHold(f.gate!);
    const terminate = vi.spyOn(interception.workers[0]!, 'terminate');
    interception.workers[0]!.emit('messageerror', new Error('fixture unreadable reply'));
    expect(await write).toMatchObject({ commit: 'unknown' });
    expect(terminate).toHaveBeenCalled();
  });

  it('drains accepted work on shutdown and rejects new unposted work', async () => {
    const f = await fixture();
    const accepted = ['one', 'two', 'three'].map((id) => f.client.write('user', metadata(id)));
    const shutdown = f.client.shutdown();
    await expect(f.client.write('user', metadata('late'))).rejects.toMatchObject({
      commit: 'not-committed',
    });
    await Promise.all(accepted);
    await shutdown;
    expect(f.client.isClosed).toBe(true);
    expect(count(f.path)).toBe(3);
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
        const bytes = readFileSync(join(scope.contentMount.root, content.reference.locator.path));
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
