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
import { executeGoalOperation, readGoalView } from './runtime/goal-owner.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import { installPendingRequestAdmission } from './runtime/pending-request-flow.js';
import { pendingRequestItemId, readPendingRequest } from './runtime/pending-requests.js';
import { openControlStoreProductReadHandle } from './storage/control-store-products.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { testGoalDomainProposal } from './test-support/goal-domain.js';
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

it.each([
  'before',
  'after',
  'stale-source',
  'stale-census',
  'freeze-abort',
  'receipt-abort',
] as const)('admits the exact ready Goal outcome with the complete Plan tuple: %s', async (boundary) => {
  const held = boundary === 'before' || boundary === 'after';
  if (held) {
    commitBoundary.gate = new SharedArrayBuffer(16);
    commitBoundary.point = boundary;
  }
  const f = await productFixture();
  const context = { actor: { kind: 'local' as const, userId: f.userId } };
  const services = { coreDb: f.coreDb };
  const created = await executeGoalOperation(
    'goal.create',
    { workspaceId: f.workspace.id, requestId: randomUUID(), intent: 'Review an exact design' },
    context,
    f.store,
    f.db,
    services
  );
  const goal = created.goal!;
  const scope = { workspaceId: f.workspace.id, threadId: goal.threadId, goalId: goal.goalId };
  const raising = await f.store.createTurn(
    scope.workspaceId,
    scope.threadId,
    'Propose the design',
    { kind: 'user', id: f.userId },
    null,
    { executorKind: 'coordinator', agentId: 'goal-coordinator' }
  );
  const commitment = {
    intentBasis: { revision: goal.intentRevision, intent: goal.intent },
    cards: [],
    permittedAdjustments: 'Clarify the design without deployment',
    completionEvidence: ['Reviewed design'],
    boundaries: 'No deployment',
  };
  const proposed = await executeGoalOperation(
    'goal.plan.propose',
    {
      ...scope,
      requestId: randomUUID(),
      expectedRevision: goal.changeRevision,
      commitment,
      goalDomain: testGoalDomainProposal(scope.workspaceId, scope.goalId),
    },
    { ...context, coordinatorTurnId: raising.id },
    f.store,
    f.db,
    services
  );
  const prior = proposed.versions[0]!;
  await executeGoalOperation(
    'goal.plan.approve',
    {
      ...scope,
      requestId: randomUUID(),
      pendingRequestId: prior.pendingRequestId,
      decision: 'denied',
    },
    context,
    f.store,
    f.db,
    services
  );
  await f.store.updateTurn(raising.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  const ready = readPendingRequest(f.db.sqlite, prior.pendingRequestId)!;
  expect(ready).toMatchObject({
    requesterKind: 'coordinator',
    resolution: 'denied',
    delivery: 'undelivered',
    publicationTurnId: null,
    deliveryTurnId: null,
  });
  // These are actual retained Goal decisions. Install the ordinary admission hooks before the next command.
  installPendingRequestAdmission(f.store, {
    coreDb: f.coreDb,
    openWorkspace: (id) => openWorkspaceDb(f.dataRoot, id),
  });
  const beforeView = readGoalView(f.store, f.db, scope.goalId);
  const input = {
    ...scope,
    requestId: randomUUID(),
    expectedRevision: beforeView.goal!.changeRevision,
    commitment: { ...commitment, boundaries: 'No deployment; review the revised design' },
    goalDomain: testGoalDomainProposal(scope.workspaceId, scope.goalId),
  };
  const newPendingId = `ap_${input.requestId}`;
  const newPlanId = `gp_${input.requestId}`;
  const tables = [
    'goals',
    'goal_plan_versions',
    'pending_requests',
    'control_workspaces',
    'control_threads',
    'control_turns',
    'control_product_entries',
    'idempotency_requests',
  ];
  const before = Object.fromEntries(
    tables.map((table) => [
      table,
      f.db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ])
  );
  const cached = structuredClone(f.store.getApproval(prior.pendingRequestId));
  const cacheCreate = vi.spyOn(f.store, 'createApproval');
  const cacheUpdate = vi.spyOn(f.store, 'updateApproval');
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
      /\b(goals|goal_plan_versions|pending_requests|control_\w+|idempotency_requests)\b/.test(sql)
    ) {
      const run = statement.run;
      statement.run = function (...parameters: unknown[]) {
        mainWrites.push(sql);
        return Reflect.apply(run, this, parameters);
      };
    }
    return statement;
  });
  if (boundary === 'stale-source') {
    // Change the real source after native preparation, inside the proposal's transaction.
    f.db.sqlite.exec(`CREATE TRIGGER change_ready_source AFTER INSERT ON control_turns
      WHEN NEW.thread_id='${scope.threadId}'
      BEGIN UPDATE pending_requests SET updated_at='2000-01-01T00:00:00.000Z'
        WHERE request_id='${ready.requestId}'; END`);
  } else if (boundary === 'stale-census') {
    const prepareAdmission = f.store.prepareNativeTurnPendingAdmission.bind(f.store);
    vi.spyOn(f.store, 'prepareNativeTurnPendingAdmission').mockImplementationOnce(
      async (...args) => {
        const admission = await prepareAdmission(...args);
        expect(admission.pending).toEqual([
          expect.objectContaining({
            action: 'freeze',
            expectedSelection: [ready.requestId],
            expectedThreadCensus: [ready.requestId],
          }),
        ]);
        // Model an older census that missed this real row; native sources, Items and deciding body stay real.
        return {
          ...admission,
          pending: admission.pending.map((command) =>
            command.action === 'freeze' ? { ...command, expectedThreadCensus: [] } : command
          ),
        };
      }
    );
  } else if (boundary === 'freeze-abort') {
    f.db.sqlite.exec(`CREATE TRIGGER refuse_ready_freeze BEFORE UPDATE OF delivery ON pending_requests
      WHEN NEW.request_id='${ready.requestId}' AND NEW.delivery='frozen'
      BEGIN SELECT RAISE(ABORT, 'private freeze fault'); END`);
  } else if (boundary === 'receipt-abort') {
    f.db.sqlite.exec(`CREATE TRIGGER refuse_plan_receipt BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name='goal.plan.propose' AND NEW.request_id='${input.requestId}'
      BEGIN SELECT RAISE(ABORT, 'private final receipt fault'); END`);
  }
  const gate = held ? new Int32Array(commitBoundary.gate!) : undefined;
  if (gate) Atomics.store(gate, 0, 1);
  let settled = false;
  let committedItems: unknown;
  const command = executeGoalOperation('goal.plan.propose', input, context, f.store, f.db, services)
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    )
    .finally(() => {
      settled = true;
    });
  if (gate) {
    while (!settled && Atomics.load(gate, 1) === 0) await nextTurn();
    expect(Atomics.load(gate, 1), 'the real Goal tuple must reach the native COMMIT gate').toBe(1);
    expect(Atomics.load(gate, 3)).toBe(2);
    expect(settled).toBe(false);
    expect(mainWrites).toEqual([]);
    expect(cacheCreate).not.toHaveBeenCalled();
    expect(cacheUpdate).not.toHaveBeenCalled();
    expect(f.store.getApproval(prior.pendingRequestId)).toEqual(cached);
    expect(() => f.store.getApproval(newPendingId)).toThrow();
    if (boundary === 'before') {
      expect(
        Object.fromEntries(
          tables.map((table) => [
            table,
            f.db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          ])
        )
      ).toEqual(before);
    } else {
      const committed = readGoalView(f.store, f.db, scope.goalId);
      expect(committed.goal?.proposedPlanVersionId).toBe(newPlanId);
      expect(committed.versions).toEqual([
        prior,
        expect.objectContaining({
          planVersionId: newPlanId,
          pendingRequestId: newPendingId,
          commitment: input.commitment,
        }),
      ]);
      const carried = readPendingRequest(f.db.sqlite, ready.requestId)!;
      expect(carried.delivery).toBe('frozen');
      const admitted = f.store.getTurnById(carried.deliveryTurnId!);
      expect(admitted.status).toBe('running');
      expect(admitted.items.map((item) => item.type)).toEqual([
        'approval-decision',
        'approval-request',
      ]);
      committedItems = structuredClone(admitted.items);
      expect(readPendingRequest(f.db.sqlite, newPendingId)).toMatchObject({
        raisingTurnId: admitted.id,
        state: 'pending',
        governedIntent: { goalId: goal.goalId, planVersionId: newPlanId },
      });
      expect(
        f.db.sqlite
          .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
          .all(input.requestId)
      ).toEqual([{ request_id: input.requestId }]);
    }
    Atomics.store(gate, 0, 0);
    Atomics.store(gate, 2, 1);
    Atomics.notify(gate, 2);
  }
  const outcome = await command;
  let accepted = outcome.value;
  if (!held) {
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).toMatchObject({ commit: 'not-committed' });
    if (boundary.endsWith('abort')) expect(outcome.error).toMatchObject({ code: 'constraint' });
    expect(outcome.value).toBeUndefined();
    expect(cacheCreate).not.toHaveBeenCalled();
    expect(cacheUpdate).not.toHaveBeenCalled();
    expect(mainWrites).toEqual([]);
    expect(f.store.getApproval(prior.pendingRequestId)).toEqual(cached);
    expect(() => f.store.getApproval(newPendingId)).toThrow();
    expect(
      Object.fromEntries(
        tables.map((table) => [
          table,
          f.db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ])
      )
    ).toEqual(before);
    expect(readGoalView(f.store, f.db, scope.goalId)).toEqual(beforeView);
    await getControlStoreWorkerClient().shutdown();
    expect(readGoalView(new FsStore({ dataRoot: f.dataRoot }), f.db, scope.goalId)).toEqual(
      beforeView
    );
    f.db.sqlite.exec(
      'DROP TRIGGER IF EXISTS change_ready_source; DROP TRIGGER IF EXISTS refuse_ready_freeze; DROP TRIGGER IF EXISTS refuse_plan_receipt'
    );
    accepted = await executeGoalOperation(
      'goal.plan.propose',
      input,
      context,
      f.store,
      f.db,
      services
    );
  } else expect(outcome.error).toBeUndefined();
  expect(accepted?.goal?.proposedPlanVersionId).toBe(newPlanId);
  expect(accepted?.versions).toHaveLength(2);
  expect(accepted?.requests).toHaveLength(2);
  expect(f.store.getApproval(newPendingId)).toMatchObject({ id: newPendingId });
  expect(mainWrites).toEqual([]);
  const frozen = readPendingRequest(f.db.sqlite, ready.requestId)!;
  const next = readPendingRequest(f.db.sqlite, newPendingId)!;
  expect(frozen).toMatchObject({
    ...ready,
    delivery: 'frozen',
    deliveryTurnId: expect.any(String),
    publicationTurnId: expect.any(String),
    deliveryCause: 'carried',
    updatedAt: expect.any(String),
  });
  expect(frozen.deliveryTurnId).not.toBe(raising.id);
  expect(frozen.publicationTurnId).toBe(frozen.deliveryTurnId);
  expect(next).toMatchObject({
    raisingTurnId: frozen.deliveryTurnId,
    state: 'pending',
    governedIntent: { goalId: goal.goalId, planVersionId: newPlanId },
  });
  const turn = f.store.getTurnById(frozen.deliveryTurnId!);
  expect(turn).toMatchObject({
    threadId: goal.threadId,
    agentId: 'goal-coordinator',
    status: 'completed',
  });
  expect(turn.items.map((item) => item.type)).toEqual(['approval-decision', 'approval-request']);
  if (boundary === 'after') expect(turn.items).toEqual(committedItems);
  expect(turn.items[0]).toEqual({
    id: pendingRequestItemId(ready.requestId, 'decision'),
    owner: { kind: 'workspace', workspaceId: scope.workspaceId },
    threadId: scope.threadId,
    turnId: turn.id,
    type: 'approval-decision',
    actor: { kind: 'user', id: f.userId },
    causationId: ready.requestItemId,
    approvalRequestId: ready.requestId,
    decision: 'denied',
    decidedAt: ready.decidedAt,
    status: 'completed',
    createdAt: frozen.updatedAt,
    completedAt: frozen.updatedAt,
  });
  const receipt = f.db.sqlite
    .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
    .get(input.requestId) as { scope_json: string };
  expect(receipt).toMatchObject({
    command_name: 'goal.plan.propose',
    request_id: input.requestId,
    input_hash: commandInputHash(input),
    response_kind: 'goal',
    response_id: goal.goalId,
  });
  expect(JSON.parse(receipt.scope_json)).toEqual({
    actorId: f.userId,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
  });
  await getControlStoreWorkerClient().shutdown();
  const reopened = new FsStore({ dataRoot: f.dataRoot });
  expect(reopened.getTurnById(turn.id)).toEqual(turn);
  expect(readGoalView(reopened, f.db, scope.goalId)).toEqual(accepted);
  expect(readPendingRequest(f.db.sqlite, ready.requestId)).toEqual(frozen);
  expect(
    f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(input.requestId)
  ).toEqual([receipt]);
});
