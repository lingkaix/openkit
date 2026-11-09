import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { OperationId } from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  catalogDocumentPath,
  loadWorkspaceResourceCatalog,
  submitWorkspaceSkillCandidate,
} from '../catalog/resource-catalog.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createThread } from '../thread-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getCommandRequestRecordFromDb,
  readCommandRequestRecordsFromSqlite,
  recordCommandRequestRecordInDb,
} from './command-request-records.js';
import { openControlStoreProductReadHandle } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

// L2: Core Storage's ordered multi-commit rule, not a native product atomic tuple.
// Core Protocol owns the original receipt, scope, TTL and current-authority replay.
// This is the published real Worker/SQLite/FULL instrument, with its existing capacity.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  gate: new SharedArrayBuffer(5 * 6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
}));

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = fault.workers.length;
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.receiptSqlModule);
          const originalPrepare = Database.prototype.prepare;
          const originalExec = Database.prototype.exec;
          const gate = workerData.receiptGate;
          const commands = ['thread.create', 'catalog.skill-candidate-submit',
            'catalog.skill-candidate-decide', 'catalog.skill-candidate-withdraw'];
          const pending = new WeakMap();
          function contains(db) {
            if (!Atomics.load(gate, 21)) return false;
            return !!originalPrepare.call(db,
              'SELECT 1 FROM idempotency_requests WHERE request_id=? AND command_name=?').get(
                Buffer.from(workerData.receiptRequest).toString('ascii'),
                commands[Atomics.load(gate, 12)]);
          }
          Database.prototype.prepare = function(sql) {
            const statement = originalPrepare.call(this, sql);
            const insert = /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests\b/i.test(sql);
            const prune = /^\s*DELETE\s+FROM\s+idempotency_requests\b/i.test(sql);
            if (!insert && !prune) return statement;
            const db = this;
            const originalRun = statement.run;
            statement.run = function(...parameters) {
              const before = contains(db);
              if (prune && before && Atomics.load(gate, 12) !== 0) {
                Atomics.add(gate, 17, 1);
                if (!Atomics.load(gate, 22)) Atomics.store(gate, 13, 1);
              }
              const result = originalRun.apply(this, parameters);
              const flags = pending.get(db) || [false, false];
              if (insert && !before && contains(db)) {
                flags[0] = true;
                Atomics.add(gate, 16, 1);
                Atomics.store(gate, 5, 1);
              }
              if (prune && before && Atomics.load(gate, 12) !== 0) {
                flags[1] = true;
                Atomics.store(gate, 11, 1);
              }
              if (flags.some(Boolean)) pending.set(db, flags);
              return result;
            };
            return statement;
          };
          Database.prototype.exec = function(sql) {
            const result = originalExec.call(this, sql);
            if (!/^COMMIT$/i.test(sql) || !pending.has(this)) return result;
            const flags = pending.get(this);
            pending.delete(this);
            for (let stage = 0; stage < 2; stage++) {
              if (!flags[stage] || !contains(this)) continue;
              const base = stage * 6;
              Atomics.add(gate, 14 + stage, 1);
              Atomics.store(gate, 22 + stage, 1);
              Atomics.store(gate, base + 3, this.pragma('synchronous', {simple: true}));
              Atomics.store(gate, base + 4, workerData.receiptWorkerIndex);
              if (Atomics.compareExchange(gate, base + 1, 1, 0) === 1) {
                Atomics.store(gate, base, 1);
                Atomics.notify(gate, base);
                Atomics.wait(gate, base + 2, 0);
              }
            }
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
            ...options?.workerData,
            receiptSqlModule: require.resolve('better-sqlite3'),
            receiptGate: new Int32Array(fault.gate),
            receiptRequest: new Uint8Array(fault.request),
            receiptWorkerIndex: index,
          },
        });
        fault.workers.push(this);
      }
    },
  };
});

const cases = [
  { operation: 'catalog.skill-candidate-submit', stage: 1, status: 201 },
  { operation: 'catalog.skill-candidate-decide', stage: 2, status: 200 },
  { operation: 'catalog.skill-candidate-withdraw', stage: 3, status: 200 },
] as const;
type Case = (typeof cases)[number];
let receiptObservationAdmitted = false;

/** Release both original native stage holds and every pending notification on failure. */
function release() {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, 21, 0);
  for (const base of [0, 6]) {
    Atomics.store(gate, base + 1, 0);
    Atomics.store(gate, base + 2, 1);
    Atomics.notify(gate, base + 2);
    if (Atomics.compareExchange(gate, base, 0, -1) === 0) Atomics.notify(gate, base);
  }
}

/** Bind the unchanged request buffer and two existing six-slot gates to one exact command. */
function arm(requestId: string, command: number, hold = false) {
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  new Uint8Array(fault.request).set(new TextEncoder().encode(requestId));
  Atomics.store(gate, 12, command);
  Atomics.store(gate, 21, 1);
  if (hold) {
    Atomics.store(gate, 1, 1);
    if (command !== 0) Atomics.store(gate, 7, 1);
  }
  return gate;
}

/** Resume only the actual selected COMMIT; the later maintenance hold stays separate. */
function resume(stage: number) {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, stage * 6 + 2, 1);
  Atomics.notify(gate, stage * 6 + 2);
}

declare global {
  interface Atomics {
    /** Node24 provides this method while the package library remains ES2023. */
    waitAsync(array: Int32Array, index: number, value: number): { value: string | Promise<string> };
  }
}

/** Use the published native notification, not a scheduling timer or polling bound. */
function waiting(index: number) {
  return Promise.resolve(Atomics.waitAsync(new Int32Array(fault.gate), index, 0).value);
}

/** Produce bounded genuine Skill content through the unchanged public Catalog owner. */
function tree(text: string) {
  return [
    {
      kind: 'file' as const,
      path: 'SKILL.md',
      contentBase64: Buffer.from(
        `---\nname: proof\ndescription: Receipt proof.\n---\n${text}`
      ).toString('base64'),
    },
  ];
}

/** Compose real authority, file Catalog, reload and receipt owners with opaque fixture state. */
async function fixture(c: Case = cases[0]) {
  release();
  const dataRoot = mkdtempSync(join(tmpdir(), 'catalog-receipt-native-'));
  const coreDb = openCoreDb(dataRoot);
  let db: ReturnType<typeof openWorkspaceDb> | undefined;
  const pending = new Set<Promise<unknown>>();
  onTestFinished(async () => {
    release();
    vi.useRealTimers();
    await Promise.allSettled([...pending]);
    await shutdownControlStoreWorkerClient();
    vi.restoreAllMocks();
    if (db?.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Original Catalog receipt');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const seed =
    c.stage === 1
      ? undefined
      : submitWorkspaceSkillCandidate({
          dataRoot,
          workspaceId: workspace.id,
          entryId: 'proof',
          expectedRevision: 0,
          baseDigest: null,
          summary: 'Fixture candidate',
          producer: { kind: 'user', id: userId },
          submitter: { kind: 'user', id: userId },
          createdAt: new Date().toISOString(),
          tree: tree('Fixture candidate'),
        });
  const candidateId = seed?.candidate.id;
  const requestId = randomUUID();
  const input = {
    workspaceId: workspace.id,
    requestId,
    expectedRevision: seed ? 1 : 0,
    ...(c.stage === 1
      ? { skillId: 'proof', baseDigest: null, summary: 'Subject receipt', tree: tree('Subject') }
      : { candidateId }),
    ...(c.stage === 2 ? { decision: 'promoted', expectedCurrentDigest: null } : {}),
  };
  const manager = createRuntimeConfigManager({ dataRoot });
  const reload = vi.spyOn(manager, 'reload');
  let app = createAppWithLocalIdentity({
    coreDb,
    dataRoot,
    store,
    mode: 'local',
    runtimeConfigManager: manager,
  });
  db = openWorkspaceDb(dataRoot, workspace.id);
  const reader = db;
  const path = workspaceDbPath(dataRoot, workspace.id);
  const scope = {
    workspaceId: workspace.id,
    actorId: userId,
    ...(candidateId === undefined ? {} : { candidateId }),
  };
  const records = () => {
    const cold = openControlStoreProductReadHandle(path, {
      kind: 'workspace',
      workspaceId: workspace.id,
    });
    try {
      return readCommandRequestRecordsFromSqlite(cold.sqlite);
    } finally {
      cold.close();
    }
  };
  const record = () => records().find((row) => row.requestId === input.requestId);
  const prepare = Database.prototype.prepare;
  // Observe real Main results too: this characterizes both original autocommit prefixes.
  // It never changes an SQL result or writes valid product state for the fixture.
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql);
    const insert = /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests\b/i.test(sql);
    const prune = /^\s*DELETE\s+FROM\s+idempotency_requests\b/i.test(sql);
    if (this.name !== path || (!insert && !prune)) return statement;
    const connection = this;
    const run = statement.run;
    statement.run = function (...args: unknown[]) {
      const gate = new Int32Array(fault.gate);
      const active = Atomics.load(gate, 21) === 1;
      const before = active ? record() : undefined;
      if (active && prune && before) {
        Atomics.add(gate, 26, 1);
        if (!Atomics.load(gate, 22)) Atomics.store(gate, 13, 1);
      }
      const result = Reflect.apply(run, this, args);
      if (active && insert && !before && record()) {
        Atomics.add(gate, 18, 1);
        Atomics.store(gate, 24, connection.inTransaction ? 1 : 0);
        if (!connection.inTransaction) Atomics.store(gate, 22, 1);
      }
      if (active && prune && before) {
        Atomics.add(gate, 19, 1);
        Atomics.store(gate, 25, connection.inTransaction ? 1 : 0);
        if (!connection.inTransaction) Atomics.store(gate, 23, 1);
      }
      return result;
    };
    return statement;
  });
  const call = (body: object = input, operation: OperationId = c.operation) =>
    Promise.resolve(
      app.request(...operationRequest(operation, {}, { body: JSON.stringify(body) }))
    );
  const track = <T>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise)
    );
    return promise;
  };
  return {
    c,
    input,
    candidateId,
    dataRoot,
    workspaceId: workspace.id,
    coreDb,
    userId,
    store,
    db: reader,
    scope,
    path,
    reload,
    call,
    track,
    records,
    record,
    /** Explicit cold host lifetime, without reusing a retired fixture client's default owner. */
    reopen() {
      app = createAppWithLocalIdentity({
        coreDb,
        dataRoot,
        store: new FsStore({ dataRoot }),
        mode: 'local',
        runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
      });
    },
    catalog: () => loadWorkspaceResourceCatalog(dataRoot, workspace.id),
    bytes: () => readFileSync(catalogDocumentPath(dataRoot, workspace.id), 'utf8'),
    events: () =>
      listWorkspaceAuditEvents(reader, workspace.id).filter(
        (event) => event.requestId === input.requestId
      ),
    start(hold = false) {
      const gate = arm(input.requestId, c.stage, hold);
      return { gate, result: track(call()) };
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Inspect the real original file, historical Audit and completed reload before receipt ACK. */
function prefix(f: Fixture) {
  const catalog = f.catalog();
  expect(catalog.revision).toBe(f.input.expectedRevision + 1);
  expect(JSON.parse(f.bytes()).skills).toEqual(catalog.skills);
  const candidate = catalog.skills.candidates.find((item) =>
    f.c.stage === 1 ? item.summary === 'Subject receipt' : item.id === f.candidateId
  );
  expect(candidate).toBeDefined();
  expect(candidate?.disposition).toBe(
    f.c.stage === 1 ? 'proposed' : f.c.stage === 2 ? 'promoted' : 'withdrawn'
  );
  const completion = f.events().filter((event) => event.action === f.c.operation);
  expect(completion).toHaveLength(1);
  expect(completion[0]).toMatchObject({
    actor: { kind: 'user', id: f.userId },
    requestId: f.input.requestId,
    workspaceId: f.workspaceId,
    resource: `skill-candidate:${candidate?.id}`,
    resourceRevision: catalog.revision,
    outcome: 'succeeded',
  });
  expect(f.reload).toHaveBeenCalledWith({ dryRun: false, mode: 'safe' });
  expect(f.reload.mock.results.at(-1)?.type).toBe('return');
  return candidate;
}

/** Assert only original closed receipt metadata, never a saved HTTP result or new lineage. */
function originalReceipt(f: Fixture) {
  const candidate = prefix(f);
  const record = f.record();
  expect(record).toEqual({
    key: commandRequestKey(f.c.operation, f.input.requestId, f.scope),
    command: f.c.operation,
    requestId: f.input.requestId,
    scope: f.scope,
    inputHash: commandInputHash(f.input),
    response: { kind: 'skill_candidate', id: candidate?.id },
    createdAt: expect.any(String),
    expiresAt: expect.any(String),
  });
  if (!record) throw new Error('The original receipt is absent.');
  expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(7 * 24 * 60 * 60 * 1000);
  const admission = f.events().find((event) => event.action === `${f.c.operation}.admit`);
  expect(admission).toBeDefined();
  expect(record.createdAt <= (admission?.createdAt ?? '')).toBe(true);
  return record;
}

/** A real OLD success with its physical receipt is an early-owner RED, never a timeout. */
async function held(f: Fixture, result: Promise<Response>, stage: number) {
  const base = stage * 6;
  const outcome = await Promise.race([
    waiting(base).then(() => ({ point: 'native' as const })),
    result.then((response) => ({ point: 'settled' as const, response })),
  ]);
  if (outcome.point === 'settled') {
    expect(outcome.response.status, await outcome.response.clone().text()).toBe(f.c.status);
    originalReceipt(f);
  }
  expect(
    outcome.point,
    `Original ${f.c.operation} receipt/effect completed before native stage ${stage}.`
  ).toBe('native');
  const gate = new Int32Array(fault.gate);
  expect(Atomics.load(gate, base)).toBe(1);
  expect(Atomics.load(gate, base + 3)).toBe(2);
  expect(fault.workers[Atomics.load(gate, base + 4)]).toBeDefined();
  return gate;
}

it('calibrates the same successful receipt INSERT, actual FULL COMMIT, Worker and covering ACK on published Thread creation', async () => {
  receiptObservationAdmitted = false;
  const f = await fixture();
  const input = {
    workspaceId: f.workspaceId,
    requestId: randomUUID(),
    name: 'Original native receipt control',
    visibility: 'workspace' as const,
  };
  const scope = { actorId: f.userId, workspaceId: f.workspaceId };
  const gate = arm(input.requestId, 0, true);
  let settled = false;
  const result = f.track(
    createThread(input, { store: f.store, inflightCommands: new WeakMap() }, f.userId).then(
      (value) => {
        settled = true;
        return value;
      }
    )
  );
  const point = await Promise.race([waiting(0).then(() => 'native'), result.then(() => 'settled')]);
  expect(point).toBe('native');
  expect(settled).toBe(false);
  expect(Atomics.load(gate, 5)).toBe(1);
  expect(Atomics.load(gate, 3)).toBe(2);
  expect(Atomics.load(gate, 14)).toBe(1);
  expect(fault.workers[Atomics.load(gate, 4)]).toBeDefined();
  const record = f.records().find((row) => row.requestId === input.requestId);
  expect(record).toMatchObject({
    command: 'thread.create',
    key: commandRequestKey('thread.create', input.requestId, scope),
    requestId: input.requestId,
    scope,
    inputHash: commandInputHash(input),
    response: { kind: 'thread' },
  });
  resume(0);
  const thread = await result;
  expect(record?.response.id).toBe(thread.id);
  expect(f.records().find((row) => row.requestId === input.requestId)).toEqual(record);
  receiptObservationAdmitted = true;
}, 30000);

for (const c of cases) {
  it(`awaits distinct original record and maintenance FULL commits for ${c.operation}`, async () => {
    expect(
      receiptObservationAdmitted,
      'UNADMITTED receipt observer: Thread control must pass.'
    ).toBe(true);
    const f = await fixture(c);
    const { gate, result } = f.start(true);
    await held(f, result, 0);
    const record = originalReceipt(f);
    expect(Atomics.load(gate, 13), 'Maintenance ran before the receipt covering COMMIT.').toBe(0);
    expect(Atomics.load(gate, 14)).toBe(1);
    expect(Atomics.load(gate, 15)).toBe(0);
    expect(Atomics.load(gate, 18), 'The retired Main receipt writer ran.').toBe(0);
    const duplicate = f.track(f.call());
    const before = { bytes: f.bytes(), events: f.events(), records: f.records() };
    resume(0);
    await held(f, result, 1);
    expect(Atomics.load(gate, 15)).toBe(1);
    expect(Atomics.load(gate, 11)).toBe(1);
    expect(Atomics.load(gate, 13)).toBe(0);
    expect(Atomics.load(gate, 18)).toBe(0);
    expect(Atomics.load(gate, 19)).toBe(0);
    expect({ bytes: f.bytes(), events: f.events(), records: f.records() }).toEqual(before);
    resume(1);
    const responses = await Promise.all([result, duplicate]);
    expect(responses.map((response) => response.status)).toEqual([c.status, c.status]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect(originalReceipt(f)).toEqual(record);
    expect(f.db.sqlite.open).toBe(true);
    expect(() => recordCommandRequestRecordInDb(f.db, record)).toThrow();
    expect(f.record()).toEqual(record);
    await shutdownControlStoreWorkerClient();
    expect(f.record()).toEqual(record);
  }, 30000);
}

it('retains the real original committed receipt on record ACK loss, without repair, and admits replay only under current permission', async () => {
  expect(receiptObservationAdmitted, 'UNADMITTED receipt observer.').toBe(true);
  const f = await fixture();
  const { gate, result } = f.start(true);
  await held(f, result, 0);
  const record = originalReceipt(f);
  const before = { bytes: f.bytes(), events: f.events(), records: f.records() };
  expect(Atomics.load(gate, 15)).toBe(0);
  await fault.workers[Atomics.load(gate, 4)]!.terminate();
  const lost = await result;
  expect(lost.status).toBe(409);
  expect(await lost.json()).toMatchObject({ code: 'recovery_required' });
  expect({ bytes: f.bytes(), events: f.events(), records: f.records() }).toEqual(before);
  release();
  await shutdownControlStoreWorkerClient();
  expect(f.record()).toEqual(record);
  f.reopen();
  const replay = await f.call();
  expect(replay.status, await replay.clone().text()).toBe(201);
  expect(originalReceipt(f)).toEqual(record);
  expect({ bytes: f.bytes(), events: f.events(), records: f.records() }).toEqual(before);
  const resumeCore = await getControlStoreWorkerClient().pauseForDataRootBackup(
    `core:${f.coreDb.sqlite.name}`
  );
  try {
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
  } finally {
    resumeCore();
  }
  const denied = await f.call();
  expect([401, 403]).toContain(denied.status);
  expect({ bytes: f.bytes(), events: f.events(), records: f.records() }).toEqual(before);
}, 30000);

it('keeps the original record committed when a real expiry DELETE refuses after owner-produced expired state', async () => {
  const f = await fixture();
  // Reuse the published Date-only retention fixture; scheduling timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
  const expiredRequestId = randomUUID();
  const seed = await f.call({
    ...f.input,
    requestId: expiredRequestId,
    skillId: 'expired-proof',
    summary: 'Expired receipt owner setup',
  });
  expect(seed.status, await seed.clone().text()).toBe(201);
  const old = f.records().find((row) => row.requestId === expiredRequestId);
  expect(old).toBeDefined();
  vi.useRealTimers();
  expect((old?.expiresAt ?? '') < new Date().toISOString()).toBe(true);
  f.input.expectedRevision = 1;
  f.reload.mockClear();
  // Rule7: the only raw write is a real Storage fault AFTER valid public setup.
  f.db.sqlite.exec(`CREATE TRIGGER refuse_catalog_receipt_prune BEFORE DELETE ON idempotency_requests
    WHEN OLD.request_id = '${expiredRequestId}' BEGIN SELECT RAISE(ABORT, 'Original receipt prune refused'); END`);
  const { gate, result } = f.start();
  const failed = await result;
  expect(failed.status, await failed.clone().text()).toBe(409);
  expect(await failed.json()).toMatchObject({ code: 'recovery_required' });
  const record = originalReceipt(f);
  expect(Atomics.load(gate, 22), 'No original record commit preceded the failing DELETE.').toBe(1);
  expect(
    Atomics.load(gate, 17) + Atomics.load(gate, 26),
    'The real expiry DELETE was not attempted.'
  ).toBe(1);
  if (Atomics.load(gate, 18)) expect(Atomics.load(gate, 24)).toBe(0);
  expect(Atomics.load(gate, 13), 'The receipt and maintenance were incorrectly merged.').toBe(0);
  expect(f.records().find((row) => row.requestId === expiredRequestId)).toEqual(old);
  const before = { bytes: f.bytes(), events: f.events(), records: f.records() };
  release();
  await shutdownControlStoreWorkerClient();
  expect(f.record()).toEqual(record);
  f.reopen();
  const replay = await f.call();
  expect(replay.status, await replay.clone().text()).toBe(201);
  expect({ bytes: f.bytes(), events: f.events(), records: f.records() }).toEqual(before);
}, 30000);

it('preserves concurrent deduplication, current Catalog replay, mismatch, CAS and Workspace scope without inventing a receipt', async () => {
  const f = await fixture();
  const firstPending = f.track(f.call());
  const duplicatePending = f.track(f.call());
  expect(f.record()).toBeUndefined();
  const responses = await Promise.all([firstPending, duplicatePending]);
  expect(responses.map((response) => response.status)).toEqual([201, 201]);
  const first = await responses[0]!.json();
  expect(await responses[1]!.json()).toEqual(first);
  const record = originalReceipt(f);
  expect(f.catalog().skills.candidates).toHaveLength(1);
  expect(f.events().filter((event) => event.action === f.c.operation)).toHaveLength(1);
  submitWorkspaceSkillCandidate({
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    entryId: 'later-proof',
    expectedRevision: 1,
    baseDigest: null,
    summary: 'Later independent Catalog revision',
    producer: { kind: 'user', id: f.userId },
    createdAt: new Date().toISOString(),
    tree: tree('Later'),
  });
  const before = { bytes: f.bytes(), records: f.records() };
  const replay = await f.call();
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual({ ...first, revision: 2 });
  expect(f.record()).toEqual(record);
  const mismatch = await f.call({ ...f.input, summary: 'Changed semantic input' });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ code: 'idempotency_key_conflict' });
  const stale = await f.call({ ...f.input, requestId: randomUUID() });
  expect(stale.status).toBe(409);
  expect({ bytes: f.bytes(), records: f.records() }).toEqual(before);
  const other = await f.store.createWorkspace('Other real Workspace scope');
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: other.id,
    ownerUserId: f.userId,
  });
  const scoped = await f.call({ ...f.input, workspaceId: other.id });
  expect(scoped.status, await scoped.clone().text()).toBe(201);
  expect((await scoped.json()).candidate.id).not.toBe(first.candidate.id);
  expect(f.record()).toEqual(record);
  expect({ bytes: f.bytes(), records: f.records() }).toEqual(before);
}, 30000);

it('preserves exact receipt TTL and both real pruning partitions without making expiry replay authority', async () => {
  const f = await fixture();
  const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const legacyInput = {
    workspaceId: f.workspaceId,
    requestId: randomUUID(),
    entryId: 'legacy-one',
    displayName: 'Unrelated Main receipt',
    selectDefault: false,
    definition: {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Main receipt peer',
      purpose: 'Preserve the ordinary receipt pruning partition.',
      references: [],
      collections: [
        {
          name: 'records',
          type: 'base',
          description: 'Main receipt fixture.',
          fields: [{ name: 'value', type: 'text', required: false, description: 'Exact value.' }],
          indexes: [],
        },
      ],
    },
    expectedRevision: 0,
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(past);
  const legacy = await f.call(legacyInput, 'catalog.light-app-import');
  expect(legacy.status, await legacy.clone().text()).toBe(201);
  f.input.expectedRevision = 1;
  const response = await f.call();
  expect(response.status, await response.clone().text()).toBe(201);
  const record = originalReceipt(f);
  const threadInput = {
    workspaceId: f.workspaceId,
    requestId: randomUUID(),
    name: 'Existing native partition',
    visibility: 'workspace' as const,
  };
  await createThread(threadInput, { store: f.store, inflightCommands: new WeakMap() }, f.userId);
  const nativeOther = f.records().find((row) => row.requestId === threadInput.requestId);
  expect(nativeOther).toBeDefined();
  vi.useRealTimers();
  expect(record.expiresAt < new Date().toISOString()).toBe(true);
  const before = f.records();
  const lastEligible = new Date(Date.parse(record.expiresAt) - 1).toISOString();
  expect(getCommandRequestRecordFromDb(f.db, record.key, lastEligible)).toEqual(record);
  expect(getCommandRequestRecordFromDb(f.db, record.key, record.expiresAt)).toBeNull();
  expect(f.records()).toEqual(before);
  // This existing legacy lookup really prunes Main's partition; it must not delete native rows.
  expect(f.store.getCommandRequest('catalog.light-app-import', randomUUID(), f.scope)).toBeNull();
  expect(f.records().find((row) => row.requestId === legacyInput.requestId)).toBeUndefined();
  expect(f.records().find((row) => row.requestId === threadInput.requestId)).toEqual(nativeOther);
  expect(f.record(), 'Main expiry maintenance deleted the moved Catalog receipt.').toEqual(record);

  // Reach another expired Main receipt through its real owner, never by raw expiry SQL.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(past);
  const anotherLegacyInput = {
    ...legacyInput,
    entryId: 'legacy-two',
    requestId: randomUUID(),
    expectedRevision: 2,
  };
  const anotherLegacy = await f.call(anotherLegacyInput, 'catalog.light-app-import');
  expect(anotherLegacy.status, await anotherLegacy.clone().text()).toBe(201);
  const mainOther = f.records().find((row) => row.requestId === anotherLegacyInput.requestId);
  expect(mainOther).toBeDefined();
  vi.useRealTimers();
  const currentThreadInput = {
    ...threadInput,
    requestId: randomUUID(),
    name: 'Current native maintenance',
  };
  await createThread(
    currentThreadInput,
    { store: f.store, inflightCommands: new WeakMap() },
    f.userId
  );
  expect(f.records().find((row) => row.requestId === threadInput.requestId)).toBeUndefined();
  expect(
    f.record(),
    'Existing native maintenance did not prune its activated Catalog partition.'
  ).toBeUndefined();
  expect(f.records().find((row) => row.requestId === anotherLegacyInput.requestId)).toEqual(
    mainOther
  );
  const retained = { bytes: f.bytes(), events: f.events(), records: f.records() };
  const replay = await f.call();
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ code: 'recovery_required' });
  expect({ bytes: f.bytes(), events: f.events(), records: f.records() }).toEqual(retained);
}, 30000);
