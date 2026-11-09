import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { expect, it, onTestFinished, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { registerUserKnowledgeSource } from '../knowledge/scoped-knowledge-sources.js';
import { registerServerKnowledgeSource } from '../knowledge/server-knowledge-owner.js';
import { FsStore } from '../lib/store.js';
import * as operationContract from '../operation-contract.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import {
  createAppWithLocalIdentity,
  createAppWithWorkspaceAuthority,
} from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import * as membership from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from './db.js';
import { userDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

// Scope-owned command receipt stages, not the already-native Workspace/Core product bodies.
const faults = vi.hoisted(() => ({
  readOnlyMain: false,
  mainPruneTriggerReached: false,
  mainInsertTriggerReached: false,
  workers: [] as NativeWorker[],
  messages: [] as unknown[],
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
  coldPath: new SharedArrayBuffer(4096),
}));
vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  const protect = <T extends { sqlite: { pragma(sql: string): unknown } }>(db: T): T => {
    if (faults.readOnlyMain) db.sqlite.pragma('query_only = ON');
    const sqlite = (db as T & { sqlite: ReturnType<typeof actual.openCoreDb>['sqlite'] }).sqlite;
    const observeReadonly = (method: 'prepare' | 'run' | 'exec', sql: string, error: unknown) => {
      const code = (error as { code?: string }).code;
      if (code?.startsWith('SQLITE_READONLY'))
        console.info('Original Main SQLite refused', {
          scope: (db as { scope?: string }).scope,
          method,
          sqlOperation: /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase() ?? 'unknown',
          code,
        });
    };
    const execute = sqlite.exec.bind(sqlite);
    sqlite.exec = ((sql: string) => {
      try {
        return execute(sql);
      } catch (error) {
        observeReadonly('exec', sql, error);
        throw error;
      }
    }) as typeof sqlite.exec;
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((sql: string) => {
      let statement: ReturnType<typeof prepare>;
      try {
        statement = prepare(sql);
      } catch (error) {
        observeReadonly('prepare', sql, error);
        throw error;
      }
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        try {
          return run(...args);
        } catch (error) {
          observeReadonly('run', sql, error);
          const fault = error as { code?: string; message?: string };
          if (
            fault.code?.startsWith('SQLITE_CONSTRAINT') &&
            fault.message === 'post-product pruning refusal'
          )
            faults.mainPruneTriggerReached = true;
          if (
            fault.code?.startsWith('SQLITE_CONSTRAINT') &&
            fault.message === 'late receipt INSERT refusal'
          )
            faults.mainInsertTriggerReached = true;
          throw error;
        }
      };
      return statement;
    }) as typeof sqlite.prepare;
    return db;
  };
  return {
    ...actual,
    openCoreDb: (...args: Parameters<typeof actual.openCoreDb>) =>
      protect(actual.openCoreDb(...args)),
    openUserDb: (...args: Parameters<typeof actual.openUserDb>) =>
      protect(actual.openUserDb(...args)),
    openWorkspaceDb: (...args: Parameters<typeof actual.openWorkspaceDb>) =>
      protect(actual.openWorkspaceDb(...args)),
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
        const index = faults.workers.length;
        const prelude = `
        const {workerData} = require('node:worker_threads');
        const Database = require(workerData.receiptModule);
        const originalPrepare = Database.prototype.prepare;
        const originalExec = Database.prototype.exec;
        const maintenance = new WeakSet();
        const gate = workerData.receiptGate;
        const hasReceipt = (db) => originalPrepare.call(db, 'SELECT 1 FROM idempotency_requests WHERE request_id=?').get(Buffer.from(workerData.receiptRequest).toString('ascii'));
        Database.prototype.prepare = function(sql) {
          const coldPath = Buffer.from(workerData.receiptColdPath).toString('utf8').split('\\0')[0];
          if (Atomics.load(gate,1) === 3 && this.name === coldPath && Atomics.compareExchange(gate,0,0,1) === 0) Atomics.wait(gate,2,0);
          const statement = originalPrepare.call(this,sql);
          const deletion = /^DELETE\\s+FROM\\s+idempotency_requests/i.test(sql.trim());
          if (deletion || /^INSERT.*INTO\\s+idempotency_requests/i.test(sql.trim())) {
            const db = this;
            const run = statement.run;
            statement.run = function(...args) {
              try {
                const value = run.apply(this,args);
                if (deletion && hasReceipt(db)) maintenance.add(db);
                return value;
              } catch(error) {
                if (deletion && hasReceipt(db) && error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'post-product pruning refusal') Atomics.store(gate,3,1);
                if (args.includes(Buffer.from(workerData.receiptRequest).toString('ascii')) && error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'late receipt INSERT refusal') Atomics.store(gate,3,2);
                throw error;
              }
            };
          }
          return statement;
        };
        Database.prototype.exec = function(sql) {
          const value = originalExec.call(this,sql);
          if (!/^COMMIT$/i.test(sql) || !Atomics.load(gate,1)) return value;
          if (!originalPrepare.call(this,"SELECT 1 FROM sqlite_master WHERE name='idempotency_requests'").get() || !hasReceipt(this)) return value;
          const stage = Atomics.load(gate,1);
          if (((stage === 1 && !maintenance.has(this)) || (stage === 2 && maintenance.has(this))) && Atomics.compareExchange(gate,0,0,1) === 0) {
            Atomics.store(gate,4,this.pragma('synchronous',{simple:true}));
            Atomics.store(gate,5,workerData.receiptWorker);
            Atomics.wait(gate,2,0);
          }
          return value;
        };
      `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            receiptModule: require.resolve('better-sqlite3'),
            receiptGate: new Int32Array(faults.gate),
            receiptRequest: new Uint8Array(faults.request),
            receiptColdPath: new Uint8Array(faults.coldPath),
            receiptWorker: index,
          },
        });
        faults.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        faults.messages.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});
function release() {
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
}
const selectedWorkspace = 'ws_00000000-0000-7000-8000-000000000001';
type Kind = 'create' | 'update';
/** Real canonical local User, Workspace, membership and HTTP operation; setup finishes before readonly faults. */
async function fixture(kind: Kind, coldUser = false) {
  release();
  new Int32Array(faults.gate).fill(0);
  new Uint8Array(faults.coldPath).fill(0);
  faults.readOnlyMain = false;
  faults.mainPruneTriggerReached = false;
  faults.mainInsertTriggerReached = false;
  const dataRoot = mkdtempSync(join(tmpdir(), 'workspace-command-native-'));
  const store = await createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  membership.recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: selectedWorkspace,
    ownerUserId: userId,
  });
  const workspaceDb = openWorkspaceDb(dataRoot, selectedWorkspace);
  applyScopedMigrations(workspaceDb);
  const userDb = coldUser ? undefined : openUserDb(dataRoot, userId);
  if (userDb) applyScopedMigrations(userDb);
  const app = createAppWithWorkspaceAuthority({ coreDb, store });
  const command = kind === 'create' ? 'workspace.create' : 'workspace.update';
  const requestId = randomUUID();
  new Uint8Array(faults.request).set(new TextEncoder().encode(requestId));
  const target = () =>
    kind === 'create' ? openUserDb(dataRoot, userId) : openWorkspaceDb(dataRoot, selectedWorkspace);
  const call = (id = requestId, name = 'Exact command name') =>
    app.request(
      ...operationRequest(command, kind === 'create' ? {} : { workspaceId: selectedWorkspace }, {
        body: JSON.stringify({ requestId: id, name }),
      })
    );
  const rows = (id = requestId) => {
    const db = target();
    try {
      return db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(id);
    } finally {
      db.sqlite.close();
    }
  };
  const queryOnly = () => {
    faults.readOnlyMain = true;
    for (const db of [coreDb, workspaceDb, userDb]) db?.sqlite.pragma('query_only = ON');
  };
  onTestFinished(async () => {
    release();
    faults.readOnlyMain = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    for (const db of [coreDb, workspaceDb, userDb]) if (db?.sqlite.open) db.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    store,
    coreDb,
    userDb,
    workspaceDb,
    userId,
    command,
    app,
    requestId,
    call,
    rows,
    target,
    queryOnly,
  };
}
const observed = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );

it.each(['create', 'update'] as const)(
  'publishes %s with every Main handle readonly and receipts only in its exact User or Workspace owner',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const response = await f.call();
    expect(response.status).toBe(kind === 'create' ? 201 : 200);
    const workspace = await response.json();
    const receipts = f.rows();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      command_name: f.command,
      response_kind: 'workspace',
      response_id: workspace.id,
    });
    expect(JSON.parse((receipts[0] as { scope_json: string }).scope_json)).toEqual(
      kind === 'create' ? { userId: f.userId } : { workspaceId: selectedWorkspace }
    );
    expect(
      f.coreDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(f.requestId)
    ).toEqual([]);
    const other = kind === 'create' ? f.workspaceDb : f.userDb!;
    expect(
      other.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(f.requestId)
    ).toEqual([]);
    if (kind === 'create') {
      const createdDb = openWorkspaceDb(f.dataRoot, workspace.id);
      try {
        expect(
          createdDb.sqlite
            .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
            .all(f.requestId)
        ).toEqual([]);
      } finally {
        createdDb.sqlite.close();
      }
    }
    expect((await f.call()).status).toBe(kind === 'create' ? 201 : 200);
    expect(f.rows()).toEqual(receipts);
  }
);

it.each(['create', 'update'] as const)(
  'retains original %s effects after a genuine late receipt INSERT refusal',
  async (kind) => {
    const f = await fixture(kind);
    let actualWorkspaceId = selectedWorkspace;
    const publish = membership.publishWorkspaceOwnerMembership;
    if (kind === 'create')
      vi.spyOn(membership, 'publishWorkspaceOwnerMembership').mockImplementation(async (input) => {
        await publish(input);
        actualWorkspaceId = input.workspaceId;
      });
    const db = f.target();
    db.sqlite.exec(
      `CREATE TRIGGER refuse_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.command_name='${f.command}' BEGIN SELECT RAISE(ABORT,'late receipt INSERT refusal'); END`
    );
    db.sqlite.close();
    const response = await f.call();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.rows()).toEqual([]);
    expect(
      faults.mainInsertTriggerReached || Atomics.load(new Int32Array(faults.gate), 3) === 2
    ).toBe(true);
    expect(f.store.getWorkspace(actualWorkspaceId).name).toBe('Exact command name');
    expect(
      readFileSync(
        join(f.dataRoot, 'workspaces', actualWorkspaceId, 'config', 'workspace.jsonc'),
        'utf8'
      )
    ).toContain('Exact command name');
    if (kind === 'create')
      expect(
        f.coreDb.sqlite
          .prepare('SELECT status FROM workspace_registry WHERE workspace_id=?')
          .get(actualWorkspaceId)
      ).toMatchObject({ status: 'active' });
    await shutdownControlStoreWorkerClient();
    expect(new FsStore({ dataRoot: f.dataRoot }).getWorkspace(actualWorkspaceId).name).toBe(
      'Exact command name'
    );
    expect(f.rows()).toEqual([]);
  }
);

it.each(['create', 'update'] as const)(
  'retains the original %s receipt when post-product pruning fails, then cold-replays without repeating the product',
  async (kind) => {
    const f = await fixture(kind);
    const peerId = randomUUID();
    let productId = selectedWorkspace;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
      expect((await f.call(peerId, 'Peer before expiry')).status).toBe(
        kind === 'create' ? 201 : 200
      );
      const peer = f.rows(peerId);
      expect(peer).toHaveLength(1);
      const expiry = Date.parse((peer[0] as { expires_at: string }).expires_at);
      vi.setSystemTime(new Date(expiry - 60_000));
      const install = () => {
        const db = f.target();
        try {
          db.sqlite.exec(
            `CREATE TRIGGER refuse_late_prune BEFORE DELETE ON idempotency_requests WHEN OLD.request_id='${peerId}' BEGIN SELECT RAISE(ABORT,'post-product pruning refusal'); END`
          );
        } finally {
          db.sqlite.close();
        }
        vi.setSystemTime(new Date(expiry + 60_000));
      };
      if (kind === 'create') {
        const publish = membership.publishWorkspaceOwnerMembership;
        vi.spyOn(membership, 'publishWorkspaceOwnerMembership').mockImplementation(
          async (input) => {
            await publish(input);
            productId = input.workspaceId;
            install();
          }
        );
      } else {
        const update = f.store.updateWorkspace.bind(f.store);
        vi.spyOn(f.store, 'updateWorkspace').mockImplementation(async (...args) => {
          const result = await update(...args);
          install();
          return result;
        });
      }
      const result = await f.call();
      const receipts = f.rows();
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ command_name: f.command, response_id: productId });
      expect(result.status).toBeGreaterThanOrEqual(400);
      // Only genuine Main or native SQLite DELETE-trigger refusal qualifies this prefix.
      expect(
        faults.mainPruneTriggerReached || Atomics.load(new Int32Array(faults.gate), 3) === 1
      ).toBe(true);
      expect(f.rows(peerId)).toEqual(peer);
      expect(f.store.getWorkspace(productId).name).toBe('Exact command name');
      const db = f.target();
      try {
        db.sqlite.exec('DROP TRIGGER refuse_late_prune');
      } finally {
        db.sqlite.close();
      }
      vi.restoreAllMocks();
      await shutdownControlStoreWorkerClient();
      const coldStore = new FsStore({ dataRoot: f.dataRoot });
      const coldProduct = vi.spyOn(
        coldStore,
        kind === 'create' ? 'createWorkspace' : 'updateWorkspace'
      );
      const coldApp = createAppWithLocalIdentity({ coreDb: f.coreDb, store: coldStore });
      const replay = await coldApp.request(
        ...operationRequest(
          f.command,
          kind === 'create' ? {} : { workspaceId: selectedWorkspace },
          { body: JSON.stringify({ requestId: f.requestId, name: 'Exact command name' }) }
        )
      );
      expect(replay.status).toBe(kind === 'create' ? 201 : 200);
      expect((await replay.json()).id).toBe(productId);
      expect(f.rows()).toEqual(receipts);
      expect(coldProduct).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }
);

it.each(['create', 'update'] as const)(
  'preserves every %s record and maintenance FULL prefix when the real ACK is lost without automatic product repeat',
  async (kind) => {
    for (const stage of [1, 2] as const) {
      const f = await fixture(kind);
      f.queryOnly();
      const product = vi.spyOn(f.store, kind === 'create' ? 'createWorkspace' : 'updateWorkspace');
      const gate = new Int32Array(faults.gate);
      gate.fill(0);
      new Uint8Array(faults.request).set(new TextEncoder().encode(f.requestId));
      Atomics.store(gate, 1, stage);
      let settled = false;
      const result = observed(
        f.call().finally(() => {
          settled = true;
        })
      );
      await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
      expect(Atomics.load(gate, 4)).toBe(2);
      expect(settled).toBe(false);
      const prefix = f.rows();
      expect(prefix).toHaveLength(1);
      expect(product).toHaveBeenCalledTimes(1);
      const posts = faults.messages.length;
      await faults.workers[Atomics.load(gate, 5)]!.terminate();
      const outcome = await result;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw outcome.error;
      expect(outcome.value.status).toBeGreaterThanOrEqual(400);
      expect(faults.messages).toHaveLength(posts);
      expect(product).toHaveBeenCalledTimes(1);
      expect(f.rows()).toEqual(prefix);
      release();
      const warmReplay = await f.call();
      expect(warmReplay.status).toBe(kind === 'create' ? 201 : 200);
      expect((await warmReplay.json()).id).toBe((prefix[0] as { response_id: string }).response_id);
      expect(f.rows()).toEqual(prefix);
      expect(product).toHaveBeenCalledTimes(1);
      expect(faults.messages).toHaveLength(posts);
      await shutdownControlStoreWorkerClient();
      const coldStore = new FsStore({ dataRoot: f.dataRoot });
      const coldProduct = vi.spyOn(
        coldStore,
        kind === 'create' ? 'createWorkspace' : 'updateWorkspace'
      );
      const coldApp = createAppWithLocalIdentity({ coreDb: f.coreDb, store: coldStore });
      const replay = await coldApp.request(
        ...operationRequest(
          f.command,
          kind === 'create' ? {} : { workspaceId: selectedWorkspace },
          { body: JSON.stringify({ requestId: f.requestId, name: 'Exact command name' }) }
        )
      );
      expect(replay.status).toBe(kind === 'create' ? 201 : 200);
      expect(f.rows()).toEqual(prefix);
      expect(product).toHaveBeenCalledTimes(1);
      expect(coldProduct).not.toHaveBeenCalled();
    }
  }
);

it.each(['create', 'update'] as const)(
  'keeps the %s historical receipt but withholds current Workspace disclosure after real receipt ACK crosses User disable',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const gate = new Int32Array(faults.gate);
    gate.fill(0);
    new Uint8Array(faults.request).set(new TextEncoder().encode(f.requestId));
    Atomics.store(gate, 1, 1);
    const response = f.call();
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
    expect(Atomics.load(gate, 4)).toBe(2);
    const prefix = f.rows();
    expect(prefix).toHaveLength(1);
    const revoker = openCoreDb(f.dataRoot);
    revoker.sqlite.pragma('query_only = OFF');
    try {
      revoker.sqlite.transaction(() => disableCanonicalUser(revoker, f.userId))();
    } finally {
      revoker.sqlite.close();
    }
    release();
    const result = await response;
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await result.json()).not.toHaveProperty('name');
    expect(f.rows()).toEqual(prefix);
  }
);

it.each([false, true])(
  'creates from actual User layout without a database and reuses that same native User opening for Memory (readonly Main=%s)',
  async (readonly) => {
    const f = await fixture('create', true);
    expect(existsSync(userDbPath(f.dataRoot, f.userId))).toBe(false);
    if (readonly) f.queryOnly();
    const created = await f.call();
    expect(created.status).toBe(201);
    expect(existsSync(userDbPath(f.dataRoot, f.userId))).toBe(true);
    expect(f.rows()).toHaveLength(1);
    const body = serializeKnowledgePageFixture(
      {
        title: 'Cold User followup',
        content: 'Exact personal fact.',
        sourceReferences: [],
        createdAt: '2026-11-09T00:00:00.000Z',
        updatedAt: '2026-11-09T00:00:00.000Z',
      },
      { kind: 'user', userId: f.userId }
    );
    const followup = await f.app.request(
      ...operationRequest(
        'memory.create',
        {},
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            baseRevision: null,
            pageId: 'cold-user',
            content: body,
            summary: 'Original User family after Workspace creation',
          }),
        }
      )
    );
    expect(followup.status).toBe(200);
  }
);

it('prunes real User Source and Workspace-create receipts in both directions while retaining the Core Source partition', async () => {
  const f = await fixture('create');
  const input = {
    coreDb: f.coreDb,
    store: f.store,
    actor: { kind: 'local' as const, userId: f.userId },
    inflightCommands: new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>(),
  };
  const sourceRequest = {
    requestId: randomUUID(),
    kind: 'document' as const,
    title: 'Actual Source peer',
    content: 'Retain exact physical receipt ownership.',
  };
  const read = (db: typeof f.coreDb | NonNullable<typeof f.userDb>, requestId: string) =>
    db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(requestId);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    await registerUserKnowledgeSource({ ...input, userDb: f.userDb! }, sourceRequest);
    await registerServerKnowledgeSource(input, sourceRequest);
    const userSource = read(f.userDb!, sourceRequest.requestId);
    const coreSource = read(f.coreDb, sourceRequest.requestId);
    expect(userSource).toHaveLength(1);
    expect(coreSource).toHaveLength(1);
    expect(JSON.parse((userSource[0] as { scope_json: string }).scope_json)).toEqual({
      userId: f.userId,
      actorId: f.userId,
    });
    expect(JSON.parse((coreSource[0] as { scope_json: string }).scope_json)).toEqual({
      coreId: 'server',
      actorId: f.userId,
    });
    f.queryOnly();
    vi.setSystemTime(
      new Date(Date.parse((userSource[0] as { expires_at: string }).expires_at) + 60_000)
    );
    const created = await f.call();
    expect(created.status).toBe(201);
    const workspaceReceipt = f.rows();
    expect(workspaceReceipt).toHaveLength(1);
    expect(read(f.userDb!, sourceRequest.requestId)).toEqual([]);
    expect(read(f.coreDb, sourceRequest.requestId)).toEqual(coreSource);
    vi.setSystemTime(
      new Date(Date.parse((workspaceReceipt[0] as { expires_at: string }).expires_at) + 60_000)
    );
    const nextSource = {
      ...sourceRequest,
      requestId: randomUUID(),
      title: 'Later actual User Source',
    };
    await registerUserKnowledgeSource({ ...input, userDb: f.userDb! }, nextSource);
    expect(read(f.userDb!, nextSource.requestId)).toHaveLength(1);
    expect(f.rows()).toEqual([]);
    expect(read(f.coreDb, sourceRequest.requestId)).toEqual(coreSource);
    expect(read(f.coreDb, f.requestId)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it('joins concurrent public Workspace creation while its actual cold User file exists before native schema admission', async () => {
  const f = await fixture('create', true);
  const path = userDbPath(f.dataRoot, f.userId);
  expect(existsSync(path)).toBe(false);
  new Uint8Array(faults.coldPath).set(new TextEncoder().encode(path));
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 3);
  f.queryOnly();
  const first = observed(f.call());
  await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
  expect(existsSync(path)).toBe(true);
  const secondId = randomUUID();
  const lookupFailures: Array<{ code: string | undefined; message: string | undefined }> = [];
  const get = f.store.getCommandRequest.bind(f.store);
  vi.spyOn(f.store, 'getCommandRequest').mockImplementation((...args) => {
    try {
      return get(...args);
    } catch (error) {
      if (args[0] === 'workspace.create' && args[1] === secondId) {
        const actual = error as { code?: string; message?: string };
        lookupFailures.push({ code: actual.code, message: actual.message });
        console.info('Concurrent cold User original receipt lookup refused', {
          scope: 'user',
          sqlOperation: 'SELECT',
          code: actual.code,
        });
      }
      throw error;
    }
  });
  let entered!: () => void;
  const secondOwnerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const actor = operationContract.publicOperationActor;
  vi.spyOn(operationContract, 'publicOperationActor').mockImplementation((context) => {
    const current = actor(context);
    entered();
    return current;
  });
  const second = observed(f.call(secondId, 'Concurrent cold User command'));
  // This original synchronous actor read precedes runIdempotentCommand. Its waiter runs
  // after the second request's synchronous lookup, or releases a lawful async opening join.
  await secondOwnerEntered;
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(lookupFailures).toEqual([]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  if (!a.ok) throw a.error;
  if (!b.ok) throw b.error;
  expect(a.value.status).toBe(201);
  expect(b.value.status).toBe(201);
  expect(f.rows()).toHaveLength(1);
  expect(f.rows(secondId)).toHaveLength(1);
  expect((await a.value.json()).id).not.toBe((await b.value.json()).id);
});
