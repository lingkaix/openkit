import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker, WorkerOptions } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  setDefaultServerAdminTokenId,
} from './auth/access-token-store.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { openControlStoreProductReadHandle } from './storage/control-store-products.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { createThread, updateThread } from './thread-routes.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const commitBoundary = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  point: 'before' as 'before' | 'after',
  workers: [] as NativeWorker[],
}));

vi.mock('node:worker_threads', async (load) => {
  const native = await load<typeof import('node:worker_threads')>();
  return {
    ...native,
    /** Holds the real native COMMIT; no SQL, worker handler or acknowledgement is replaced. */
    Worker: class extends native.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        if (commitBoundary.gate) {
          const prelude = `
            const {workerData}=require('node:worker_threads');
            const Database=require(workerData.databaseModule);
            const exec=Database.prototype.exec;
            Database.prototype.exec=function(sql) {
              const held=/^COMMIT$/i.test(sql) && Atomics.load(workerData.gate,0)===1;
              const hold=()=> {
                Atomics.store(workerData.gate,3,this.pragma('synchronous',{simple:true}));
                Atomics.store(workerData.gate,1,1);
                Atomics.wait(workerData.gate,2,0);
              };
              if(held && workerData.point==='before') hold();
              const result=exec.call(this,sql);
              if(held && workerData.point==='after') hold();
              return result;
            };
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
              gate: new Int32Array(commitBoundary.gate),
              point: commitBoundary.point,
            },
          });
        } else super(filename, options);
        commitBoundary.workers.push(this);
      }
    },
  };
});

it('admits Server history only with current Server authority and never through a Workspace selector', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-thread-api-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  onTestFinished(async () => {
    await getControlStoreWorkerClient().shutdown();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Ordinary Workspace');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createServerThread('Private Server maintenance');
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const member = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const app = createApp({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    auth: {
      api: { getSession: async () => ({ user: { id: userId } }) },
      handler: async () => new Response(),
    },
  });
  const read = (secret: string, body: Record<string, unknown> = { threadId: thread.id }) =>
    app.request(
      ...operationRequest(
        'thread.server.read',
        {},
        { headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }
      )
    );
  const allowed = await read(admin.secret);
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({
    thread: { id: thread.id, owner: { kind: 'server' }, visibility: 'server' },
    turns: [],
  });
  const denied = await read(member.secret);
  expect(denied.status).toBe(403);
  expect(JSON.stringify(await denied.json())).not.toContain('Private Server maintenance');
  expect(store.listThreads(workspace.id)).toEqual([]);
  expect(setDefaultServerAdminTokenId(coreDb, userId, admin.tokenId)).toBe(true);
  const invoke = createOperationInvocation({
    coreDb,
    store,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
  const session = { kind: 'public' as const, actor: { kind: 'session' as const, userId } };
  expect(await invoke('thread.server.read', { threadId: thread.id }, session)).toMatchObject({
    thread: { id: thread.id, owner: { kind: 'server' } },
  });
  const browserRead = () =>
    app.request(...operationRequest('thread.server.read', { threadId: thread.id }));
  expect((await browserRead()).status).toBe(200);
  const deniedTell = await app.request(
    ...operationRequest(
      'knowledge.server.tell',
      {},
      {
        headers: { authorization: `Bearer ${member.secret}` },
        body: JSON.stringify({
          requestId: randomUUID(),
          content: 'Workspace authority cannot write Server Knowledge.',
          sources: [],
        }),
      }
    )
  );
  expect(deniedTell.status).toBe(403);
  expect(store.listServerThreadTurns(thread.id)).toEqual([]);

  expect(
    (await read(admin.secret, { threadId: thread.id, workspaceId: workspace.id })).status
  ).toBe(400);
  revokeOpenKitAccessTokenRecord(coreDb, admin.tokenId);
  await expect(
    invoke('thread.server.read', { threadId: thread.id }, session)
  ).rejects.toMatchObject({ code: 'deployment_admin_required', status: 403 });
  expect((await browserRead()).status).toBe(403);
  expect((await read(admin.secret)).status).toBe(401);
});

/** Uses public Thread commands and real scoped databases; the test owns no product transaction. */
async function productFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'product-authority-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Product authority');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    if (commitBoundary.gate) {
      const gate = new Int32Array(commitBoundary.gate);
      Atomics.store(gate, 0, 0);
      Atomics.store(gate, 2, 1);
      Atomics.notify(gate, 2);
    }
    vi.restoreAllMocks();
    await getControlStoreWorkerClient().shutdown();
    commitBoundary.gate = undefined;
    commitBoundary.workers = [];
    if (db.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const dependencies = { store, inflightCommands: new WeakMap() };
  const input = {
    workspaceId: workspace.id,
    requestId: randomUUID(),
    name: 'Original',
    visibility: 'workspace' as const,
  };
  return { dataRoot, coreDb, db, store, workspace, userId, dependencies, input };
}

it('rolls back the public Thread change and Audit when its native receipt insert fails', async () => {
  const f = await productFixture();
  const thread = await createThread(f.input, f.dependencies, f.userId);
  const requestId = randomUUID();
  const beforeAudit = f.db.sqlite
    .prepare('SELECT * FROM audit_events ORDER BY audit_event_id')
    .all();
  f.db.sqlite.exec(`CREATE TRIGGER refuse_receipt BEFORE INSERT ON idempotency_requests
    WHEN NEW.request_id = '${requestId}'
    BEGIN SELECT RAISE(ABORT, 'receipt fault'); END`);
  await expect(
    updateThread(
      { workspaceId: f.workspace.id, threadId: thread.id, requestId, name: 'Uncommitted' },
      f.dependencies
    )
  ).rejects.toThrow();
  f.db.sqlite.exec('DROP TRIGGER refuse_receipt');
  await getControlStoreWorkerClient().shutdown();
  const reopened = new FsStore({ dataRoot: f.dataRoot });
  expect(reopened.getThread(f.workspace.id, thread.id).name).toBe('Original');
  expect(
    f.db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(requestId)
  ).toEqual([]);
  expect(f.db.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all()).toEqual(
    beforeAudit
  );
});

it('rolls back Server maintenance history when its native receipt insert fails', async () => {
  const f = await productFixture();
  const requestId = randomUUID();
  const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: f.store });
  const beforeAudit = f.coreDb.sqlite
    .prepare('SELECT * FROM audit_events ORDER BY audit_event_id')
    .all();
  f.coreDb.sqlite.exec(`CREATE TRIGGER refuse_server_receipt BEFORE INSERT ON idempotency_requests
    WHEN NEW.request_id = '${requestId}'
    BEGIN SELECT RAISE(ABORT, 'server receipt fault'); END`);
  const response = await app.request(
    ...operationRequest(
      'knowledge.server.maintain',
      {},
      {
        body: JSON.stringify({ requestId, instruction: 'Inspect existing Server Knowledge.' }),
      }
    )
  );
  expect(response.status).toBeGreaterThanOrEqual(500);
  f.coreDb.sqlite.exec('DROP TRIGGER refuse_server_receipt');
  await getControlStoreWorkerClient().shutdown();
  expect(new FsStore({ dataRoot: f.dataRoot }).listServerThreads()).toEqual([]);
  expect(
    f.coreDb.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(requestId)
  ).toEqual([]);
  expect(
    f.coreDb.sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all()
  ).toEqual(beforeAudit);
});

it('publishes the public event cache and notification only after outer FULL COMMIT', async () => {
  commitBoundary.gate = new SharedArrayBuffer(16);
  commitBoundary.point = 'before';
  const gate = new Int32Array(commitBoundary.gate);
  const f = await productFixture();
  const thread = await createThread(f.input, f.dependencies, f.userId);
  const turn = await f.store.createTurn(f.workspace.id, thread.id, 'Work', {
    kind: 'user',
    id: f.userId,
  });
  const notices: unknown[] = [];
  const unsubscribe = f.store.addTurnListener(turn.id, (event) => notices.push(event));
  onTestFinished(unsubscribe);
  Atomics.store(gate, 0, 1);
  let settled = false;
  const publication = (async () => {
    const envelope = await f.store.persistTurnEvent(turn.id, {
      event: 'error',
      workspaceId: f.workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'error', code: 'fixture', message: 'Recorded event' },
    });
    f.store.emitTurnEvent(turn.id, envelope);
  })().finally(() => {
    settled = true;
  });
  while (!settled && Atomics.load(gate, 1) === 0) await nextTurn();
  expect(Atomics.load(gate, 1), 'the public producer must await its native outer COMMIT').toBe(1);
  expect(Atomics.load(gate, 3)).toBe(2);
  expect(settled).toBe(false);
  expect(notices).toEqual([]);
  expect(f.store.getTurnEvents(turn.id)).toEqual([]);
  expect(
    f.db.sqlite
      .prepare('SELECT * FROM control_product_entries WHERE turn_id=? AND kind=?')
      .all(turn.id, 'event')
  ).toEqual([]);
  Atomics.store(gate, 0, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
  await publication;
  expect(notices).toHaveLength(1);
  expect(f.store.getTurnEvents(turn.id)).toEqual(notices);
  await getControlStoreWorkerClient().shutdown();
  expect(new FsStore({ dataRoot: f.dataRoot }).getTurnEvents(turn.id)).toEqual(notices);
});

it.each([
  'before',
  'after',
] as const)('inspects the original public request after writer loss %s outer COMMIT without replay', async (point) => {
  commitBoundary.gate = new SharedArrayBuffer(16);
  commitBoundary.point = point;
  const gate = new Int32Array(commitBoundary.gate);
  const f = await productFixture();
  const thread = await createThread(f.input, f.dependencies, f.userId);
  const requestId = randomUUID();
  Atomics.store(gate, 0, 1);
  let settled = false;
  const command = updateThread(
    {
      workspaceId: f.workspace.id,
      threadId: thread.id,
      requestId,
      name: 'Committed candidate',
    },
    f.dependencies
  )
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    )
    .finally(() => {
      settled = true;
    });
  while (!settled && Atomics.load(gate, 1) === 0) await nextTurn();
  expect(Atomics.load(gate, 1), 'the public command must reach its native COMMIT boundary').toBe(1);
  expect(settled).toBe(false);
  expect(Atomics.load(gate, 3)).toBe(2);
  await commitBoundary.workers.at(-1)!.terminate();
  const outcome = await command;
  expect(outcome.value).toBeUndefined();
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.error).not.toMatchObject({ commit: 'not-committed' });
  expect(commitBoundary.workers).toHaveLength(1);
  await getControlStoreWorkerClient().shutdown();
  f.db.sqlite.close();
  const reopened = new FsStore({ dataRoot: f.dataRoot });
  const inspection = openWorkspaceDb(f.dataRoot, f.workspace.id);
  try {
    expect(reopened.getThread(f.workspace.id, thread.id).name).toBe(
      point === 'before' ? 'Original' : 'Committed candidate'
    );
    const receipts = inspection.sqlite
      .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
      .all(requestId);
    const audits = inspection.sqlite
      .prepare('SELECT request_id FROM audit_events WHERE request_id=?')
      .all(requestId);
    expect(receipts).toEqual(point === 'before' ? [] : [{ request_id: requestId }]);
    expect(audits).toEqual(receipts);
    const row = inspection.sqlite
      .prepare('SELECT record_json FROM control_threads WHERE id=?')
      .get(thread.id) as { record_json: string };
    expect(JSON.parse(row.record_json).name).toBe(
      point === 'before' ? 'Original' : 'Committed candidate'
    );
  } finally {
    inspection.sqlite.close();
  }
});

it('keeps the original public receipt on exact replay and rejects changed input after reopen', async () => {
  const f = await productFixture();
  const original = await createThread(f.input, f.dependencies, f.userId);
  const receipt = f.db.sqlite
    .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
    .get(f.input.requestId);
  await getControlStoreWorkerClient().shutdown();
  const reopened = new FsStore({ dataRoot: f.dataRoot });
  const dependencies = { store: reopened, inflightCommands: new WeakMap() };
  expect(await createThread(f.input, dependencies, f.userId)).toEqual(original);
  await expect(
    createThread({ ...f.input, name: 'Changed' }, dependencies, f.userId)
  ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  expect(
    f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .get(f.input.requestId)
  ).toEqual(receipt);
  expect(f.db.sqlite.prepare('SELECT id FROM control_threads').all()).toEqual([
    { id: original.id },
  ]);
  expect(
    f.db.sqlite.prepare('SELECT request_id FROM audit_events WHERE action=?').all('thread.create')
  ).toEqual([{ request_id: f.input.requestId }]);
});

it('isolates a failed public transition from its concurrently offered sibling', async () => {
  const f = await productFixture();
  const failed = { ...f.input, requestId: randomUUID(), name: 'Refused sibling' };
  f.db.sqlite.exec(`CREATE TRIGGER refuse_sibling BEFORE INSERT ON idempotency_requests
    WHEN NEW.request_id = '${failed.requestId}'
    BEGIN SELECT RAISE(ABORT, 'sibling receipt fault'); END`);
  const results = await Promise.allSettled([
    createThread(failed, f.dependencies, f.userId),
    createThread(f.input, f.dependencies, f.userId),
  ]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
  f.db.sqlite.exec('DROP TRIGGER refuse_sibling');
  await getControlStoreWorkerClient().shutdown();
  const reopened = new FsStore({ dataRoot: f.dataRoot });
  expect(reopened.listThreads(f.workspace.id).map((thread) => thread.name)).toEqual(['Original']);
  expect(f.db.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()).toEqual([
    { request_id: f.input.requestId },
  ]);
  expect(
    f.db.sqlite.prepare('SELECT request_id FROM audit_events WHERE action=?').all('thread.create')
  ).toEqual([{ request_id: f.input.requestId }]);
});

it('reads public committed products synchronously through a separate readonly query-only handle', async () => {
  const f = await productFixture();
  const thread = await createThread(f.input, f.dependencies, f.userId);
  const reader = openControlStoreProductReadHandle(f.db.sqlite.name, {
    kind: 'workspace',
    workspaceId: f.workspace.id,
  });
  try {
    expect(reader.sqlite.readonly).toBe(true);
    expect(reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(() => reader.sqlite.prepare('DELETE FROM control_threads').run()).toThrow();
    expect(() =>
      reader.sqlite.exec('CREATE TEMP TABLE query_only_probe (value INTEGER)')
    ).toThrow();
    reader.sqlite.pragma('query_only = OFF');
    reader.sqlite.exec('CREATE TEMP TABLE query_only_probe (value INTEGER)');
    reader.sqlite.exec('DROP TABLE query_only_probe');
    expect(() => reader.sqlite.prepare('DELETE FROM control_threads').run()).toThrow();
    reader.sqlite.pragma('query_only = ON');
    const product = reader.get('thread', thread.id);
    expect(product).not.toBeInstanceOf(Promise);
    expect(reader.sqlite.inTransaction).toBe(false);
    expect(f.store.getThread(f.workspace.id, thread.id)).not.toBeInstanceOf(Promise);
    expect(f.db.sqlite.readonly).toBe(false);
    expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(0);
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace',
      workspaceIds: [f.workspace.id],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    revokeOpenKitAccessTokenRecord(f.coreDb, token.tokenId);
    expect(
      f.coreDb.sqlite
        .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id=?')
        .get(f.workspace.id)
    ).toEqual({ owner_user_id: f.userId });
    expect(product?.record).toMatchObject(thread);
  } finally {
    reader.close();
  }
});

it('keeps product receipt insertion and pruning off the main writable connection', async () => {
  const f = await productFixture();
  const priorInput = { ...f.input, requestId: randomUUID(), name: 'Prior receipt' };
  await createThread(priorInput, f.dependencies, f.userId);
  const expired = [
    f.store.getCommandRequest('thread.create', priorInput.requestId, {
      actorId: f.userId,
      workspaceId: f.workspace.id,
    })!,
    f.store.recordCommandRequest({
      command: 'artifact.import',
      requestId: randomUUID(),
      scope: { actorId: f.userId, workspaceId: f.workspace.id },
      inputHash: `sha256:${'b'.repeat(64)}`,
      response: { kind: 'artifact', id: allocateEntityId('ar') },
    }),
  ];
  for (const receipt of expired) {
    f.db.sqlite
      .prepare(
        "UPDATE idempotency_requests SET created_at='2000-01-01T00:00:00.000Z', expires_at='2001-01-01T00:00:00.000Z' WHERE request_key=?"
      )
      .run(receipt.key);
  }
  const mainOwned = f.db.sqlite
    .prepare('SELECT * FROM idempotency_requests WHERE request_key=?')
    .get(expired[1]!.key);
  const mainWrites: string[] = [];
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql);
    if (
      this.name === f.db.sqlite.name &&
      !statement.readonly &&
      /\b(control_\w+|idempotency_requests|audit_events)\b/.test(sql)
    ) {
      const run = statement.run;
      statement.run = function (...parameters: unknown[]) {
        mainWrites.push(sql);
        return Reflect.apply(run, this, parameters);
      };
    }
    return statement;
  });
  const created = await createThread(f.input, f.dependencies, f.userId);
  f.store.getCommandRequest('thread.create', f.input.requestId, {
    actorId: f.userId,
    workspaceId: f.workspace.id,
  });
  expect(f.store.getThread(f.workspace.id, created.id)).toEqual(created);
  expect(new FsStore({ dataRoot: f.dataRoot }).getThread(f.workspace.id, created.id)).toEqual(
    created
  );
  expect(mainWrites).toEqual([]);
  expect(
    f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_key=?')
      .get(expired[0]!.key)
  ).toBeUndefined();
  expect(
    f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_key=?')
      .get(expired[1]!.key)
  ).toEqual(mainOwned);
  expect(f.db.sqlite.prepare('SELECT id FROM control_threads WHERE id=?').get(created.id)).toEqual({
    id: created.id,
  });
  vi.restoreAllMocks();
  expect(
    f.store.getCommandRequest('artifact.import', expired[1]!.requestId, expired[1]!.scope)
  ).toBeNull();
  expect(
    f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_key=?')
      .get(expired[1]!.key)
  ).toBeUndefined();
});
