import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId, canonicalJsonText, isEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { disableCanonicalUser, isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { prepareCatalogSkillDecision } from '../catalog/catalog-operations.js';
import {
  exportWorkspaceLightAppDefinition,
  importWorkspaceLightAppDefinition,
  resolveWorkspaceLightAppDefinition,
  selectWorkspaceLightAppDefinitionDefault,
} from '../catalog/light-app-catalog.js';
import { catalogDocumentPath, loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

// L2: real public definition effect -> original standalone historical Audit -> original receipt.
// Core Storage, SQLite Layers / Durable Execution, Commit Rule And Scope Layout, require
// actual covering FULL ACK. Core Evidence preserves original facts, not a renewed grant.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  messages: [] as unknown[],
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
        // Observe successful real INSERT and its real COMMIT; never manufacture a SQL result.
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const originalPrepare = Database.prototype.prepare;
          const originalExec = Database.prototype.exec;
          const gate = workerData.auditGate;
          const actions = ['catalog.skill-candidate-decide.admit',
            'catalog.light-app-import', 'catalog.light-app-history-import',
            'catalog.light-app-select', 'catalog.light-app-pin'];
          const inserted = new WeakMap();
          function contains(db, stage) {
            return !!originalPrepare.call(db,
              'SELECT 1 FROM audit_events WHERE request_id=? AND action=?').get(
                Buffer.from(workerData.auditRequest).toString('ascii'), actions[stage]);
          }
          Database.prototype.prepare = function(sql) {
            const statement = originalPrepare.call(this, sql);
            if (!/^\s*INSERT\s+INTO\s+audit_events\b/i.test(sql)) return statement;
            const db = this;
            const originalRun = statement.run;
            statement.run = function(...parameters) {
              const stages = actions.map((_, stage) => stage).filter(stage =>
                Atomics.load(gate, stage * 6 + 1) === 1 && !contains(db, stage));
              const result = originalRun.apply(this, parameters);
              for (const stage of stages) {
                if (contains(db, stage)) {
                  inserted.set(db, stage);
                  Atomics.store(gate, stage * 6 + 5, 1);
                }
              }
              return result;
            };
            return statement;
          };
          Database.prototype.exec = function(sql) {
            const result = originalExec.call(this, sql);
            if (!/^COMMIT$/i.test(sql) || !inserted.has(this)) return result;
            const stage = inserted.get(this);
            const base = stage * 6;
            inserted.delete(this);
            if (contains(this, stage) && Atomics.compareExchange(gate, base + 1, 1, 0) === 1) {
              Atomics.store(gate, base + 3, this.pragma('synchronous', {simple:true}));
              Atomics.store(gate, base + 4, workerData.auditWorkerIndex);
              Atomics.store(gate, base, 1);
              Atomics.notify(gate, base);
              Atomics.wait(gate, base + 2, 0);
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
            auditSqlModule: require.resolve('better-sqlite3'),
            auditGate: new Int32Array(fault.gate),
            auditRequest: new Uint8Array(fault.request),
            auditWorkerIndex: index,
          },
        });
        fault.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        fault.messages.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});

const cases = [
  { operation: 'catalog.light-app-import', stage: 1, status: 201 },
  { operation: 'catalog.light-app-history-import', stage: 2, status: 201 },
  { operation: 'catalog.light-app-select', stage: 3, status: 200 },
  { operation: 'catalog.light-app-pin', stage: 4, status: 200 },
] as const;
type Case = (typeof cases)[number];

/** Release all actual native holds and cancel pending waiters, including failed-test cleanup. */
function release() {
  const gate = new Int32Array(fault.gate);
  for (let stage = 0; stage < 5; stage++) {
    const base = stage * 6;
    Atomics.store(gate, base + 1, 0);
    Atomics.store(gate, base + 2, 1);
    Atomics.notify(gate, base + 2);
    if (Atomics.compareExchange(gate, base, 0, -1) === 0) Atomics.notify(gate, base);
  }
}

/** Bind the same closed action index to the selected request and armed slot. */
function arm(requestId: string, stage: number) {
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  new Uint8Array(fault.request).set(new TextEncoder().encode(requestId));
  Atomics.store(gate, stage * 6 + 1, 1);
}

declare global {
  interface Atomics {
    /** Node 24 exposes this API although the package targets the ES2023 library. */
    waitAsync(array: Int32Array, index: number, value: number): { value: string | Promise<string> };
  }
}

/** Wait on the actual native notification without adding a timer or changing the test bound. */
function waiting(gate: Int32Array, index: number) {
  return Promise.resolve(Atomics.waitAsync(gate, index, 0).value);
}

/** Supply the smallest strict reusable definition; there is no live app database. */
function definition(): LightAppSchemaInput {
  return {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Original',
    purpose: 'Synthetic reusable notes.',
    collections: [
      {
        name: 'notes',
        type: 'base',
        description: 'Synthetic notes.',
        indexes: [],
        fields: [{ name: 'body', type: 'text', required: false, description: 'A note.' }],
      },
    ],
  };
}

/** Compose canonical local authority, real file Catalog and original public operation endpoint. */
async function fixture(c: Case = cases[0]) {
  release();
  const dataRoot = mkdtempSync(join(tmpdir(), 'light-app-definition-native-'));
  const coreDb = openCoreDb(dataRoot);
  let pending: Promise<unknown> | undefined;
  let db: ReturnType<typeof openWorkspaceDb> | undefined;
  onTestFinished(async () => {
    release();
    await pending?.catch(() => undefined);
    await shutdownControlStoreWorkerClient();
    if (db?.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Reusable definition only');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const scope = { dataRoot, workspaceId: workspace.id };
  const first = importWorkspaceLightAppDefinition({
    ...scope,
    entryId: 'notes',
    expectedRevision: 0,
    displayName: 'Notes',
    definition: definition(),
    producer: { kind: 'user', id: userId },
    createdAt: '2026-10-17T00:00:00.000Z',
    selectDefault: true,
  }).version;
  const revised: LightAppSchemaInput = { ...JSON.parse(first.definitionJson), title: 'Revised' };
  const second = importWorkspaceLightAppDefinition({
    ...scope,
    entryId: 'notes',
    expectedRevision: 1,
    displayName: 'Notes',
    definition: revised,
    parentDigest: first.digest,
    producer: { kind: 'user', id: userId },
    createdAt: '2026-10-18T00:00:00.000Z',
  }).version;
  const finalDefinition: LightAppSchemaInput = {
    ...JSON.parse(second.definitionJson),
    title: 'Final',
  };
  const definitionJson = canonicalJsonText(finalDefinition);
  const finalDigest = `sha256:${createHash('sha256').update(definitionJson).digest('hex')}`;
  const history = exportWorkspaceLightAppDefinition({ ...scope, entryId: 'notes' });
  const requestId = randomUUID();
  const specific =
    c.stage === 1
      ? {
          entryId: 'notes',
          displayName: 'Notes',
          definition: finalDefinition,
          parentDigest: second.digest,
          selectDefault: true,
        }
      : c.stage === 2
        ? { entryId: 'copy', export: history }
        : c.stage === 3
          ? { entryId: 'notes', digest: second.digest, expectedCurrentDigest: first.digest }
          : { entryId: 'notes', digest: second.digest, expectedPinDigest: null };
  const input = { workspaceId: workspace.id, requestId, expectedRevision: 2, ...specific };
  const app = await createAppWithLocalIdentity({ coreDb, dataRoot, store, mode: 'local' });
  db = openWorkspaceDb(dataRoot, workspace.id);
  const reader = db;
  const catalog = () => loadWorkspaceResourceCatalog(dataRoot, workspace.id);
  const bytes = () => readFileSync(catalogDocumentPath(dataRoot, workspace.id), 'utf8');
  const rows = (connection = reader) => ({
    audits: connection.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY audit_event_id')
      .all(requestId),
    receipts: connection.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(requestId),
  });
  const call = (body: object = input) =>
    Promise.resolve(
      app.request(...operationRequest(c.operation, {}, { body: JSON.stringify(body) }))
    );
  return {
    c,
    coreDb,
    dataRoot,
    userId,
    store,
    workspaceId: workspace.id,
    db: reader,
    first,
    second,
    finalDigest,
    definitionJson,
    input,
    catalog,
    bytes,
    rows,
    call,
    resource: `light-app-definition:${c.stage === 1 ? finalDigest : workspace.id}`,
    events: () =>
      listWorkspaceAuditEvents(reader, workspace.id).filter(
        (event) => event.requestId === requestId
      ),
    start() {
      arm(requestId, c.stage);
      const result = call();
      pending = result;
      return result;
    },
    track<T>(promise: Promise<T>) {
      pending = promise;
      return promise;
    },
    async cold() {
      await shutdownControlStoreWorkerClient();
      const cold = openWorkspaceDb(dataRoot, workspace.id);
      try {
        cold.sqlite.pragma('query_only = ON');
        return rows(cold);
      } finally {
        cold.sqlite.close();
      }
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Inspect physical definition publication independently of native messages or public success. */
function effect(f: Fixture) {
  const catalog = f.catalog();
  expect(catalog.revision).toBe(3);
  expect(JSON.parse(f.bytes()).lightApps).toEqual(catalog.lightApps);
  expect(catalog.lightApps.versions.slice(0, 2)).toEqual([f.first, f.second]);
  expect(catalog.lightApps.entries.find((entry) => entry.id === 'notes')?.currentDigest).toBe(
    f.c.stage === 1 ? f.finalDigest : f.c.stage === 3 ? f.second.digest : f.first.digest
  );
  if (f.c.stage === 1) {
    expect(catalog.lightApps.versions).toHaveLength(3);
    expect(catalog.lightApps.versions[2]).toEqual({
      digest: f.finalDigest,
      definitionJson: f.definitionJson,
      entryId: 'notes',
      parentDigest: f.second.digest,
      producer: { kind: 'user', id: f.userId },
      createdAt: expect.any(String),
    });
  } else if (f.c.stage === 2) {
    expect(catalog.lightApps.versions).toEqual([
      f.first,
      f.second,
      { ...f.first, entryId: 'copy' },
      { ...f.second, entryId: 'copy' },
    ]);
    expect(catalog.lightApps.entries.find((entry) => entry.id === 'copy')).toEqual({
      id: 'copy',
      displayName: 'Notes',
      availability: 'available',
      currentDigest: null,
    });
  } else expect(catalog.lightApps.versions).toEqual([f.first, f.second]);
  expect(catalog.lightApps.pins).toEqual(
    f.c.stage === 4 ? [{ entryId: 'notes', digest: f.second.digest }] : []
  );
  expect(readdirSync(join(f.dataRoot, 'workspaces', f.workspaceId, 'light-apps'))).toEqual([]);
  return catalog;
}

/** Fix every original historical Audit fact; notably resourceRevision was originally null. */
function audit(f: Fixture) {
  const events = f.events();
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    id: expect.any(String),
    workspaceId: f.workspaceId,
    threadId: null,
    turnId: null,
    itemId: null,
    capabilityCallId: null,
    permissionDecisionId: null,
    vaultGrantId: null,
    requestId: f.input.requestId,
    actor: { kind: 'user', id: f.userId },
    subject: null,
    agentId: null,
    agentSessionId: null,
    category: 'system',
    action: f.c.operation,
    resource: f.resource,
    resourceRevision: null,
    outcome: 'succeeded',
    severity: 'info',
    summary: 'Updated a reusable Light App definition without changing live app data.',
    errorCode: null,
    createdAt: expect.any(String),
    occurredAt: expect.any(String),
  });
  const event = events[0]!;
  expect(isEntityId('aud', event.id)).toBe(true);
  if (typeof event.createdAt !== 'string' || typeof event.occurredAt !== 'string')
    throw new Error('Original Audit timestamps must be present strings.');
  expect(Number.isFinite(Date.parse(event.createdAt))).toBe(true);
  expect(Number.isFinite(Date.parse(event.occurredAt))).toBe(true);
  return event;
}

/** Assert the exact original actor-scoped resource pointer through the real receipt owner. */
function receipt(f: Fixture) {
  expect(f.rows().receipts).toHaveLength(1);
  const record = f.store.getCommandRequest(
    f.c.operation,
    f.input.requestId,
    { workspaceId: f.workspaceId, actorId: f.userId },
    f.db
  );
  expect(record?.response).toEqual({
    kind: f.c.stage === 1 ? 'light_app_definition' : 'light_app_catalog',
    id: f.c.stage === 1 ? f.finalDigest : f.workspaceId,
  });
  expect(record?.scope).toEqual({ workspaceId: f.workspaceId, actorId: f.userId });
  return record;
}

/** Preserve the original per-action response rather than inferring success from changed files. */
async function success(f: Fixture, response: Response, revision = 3) {
  expect(response.status, await response.clone().text()).toBe(f.c.status);
  const result = await response.json();
  if (f.c.stage === 1)
    expect(result).toEqual({ revision, version: f.catalog().lightApps.versions[2] });
  else if (f.c.stage === 2)
    expect(result).toEqual({
      revision,
      entry: f.catalog().lightApps.entries.find((entry) => entry.id === 'copy'),
    });
  else expect(result).toEqual({ revision });
}

/** A genuine OLD result and physical effect beat the native wait; timeout is never the deciding RED. */
async function held(f: Fixture, result: Promise<Response>) {
  const gate = new Int32Array(fault.gate);
  const base = f.c.stage * 6;
  const outcome = await Promise.race([
    waiting(gate, base).then(() => 'held'),
    result.then((response) => `HTTP ${response.status} before native completion hold`),
  ]);
  effect(f);
  if (outcome !== 'held') {
    audit(f);
    receipt(f);
    console.info(
      JSON.stringify({
        operation: f.c.operation,
        outcome,
        actualRevision: f.catalog().revision,
        physicalEffect: true,
        audits: f.events().length,
        receipts: f.rows().receipts.length,
        nativeInsert: Atomics.load(gate, base + 5),
        nativeHold: Atomics.load(gate, base),
      })
    );
  }
  expect(
    outcome,
    'Physical publication must precede native completion FULL ACK, then original receipt.'
  ).toBe('held');
  expect(Atomics.load(gate, base)).toBe(1);
  expect(Atomics.load(gate, base + 5)).toBe(1);
  expect(Atomics.load(gate, base + 3)).toBe(2);
  const worker = fault.workers[Atomics.load(gate, base + 4)];
  expect(worker).toBeDefined();
  return worker!;
}

it('admits the actual existing native admission INSERT/FULL/held-Worker observer', async () => {
  const f = await fixture();
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'local', userId: f.userId },
    actorRef: { kind: 'user', id: f.userId },
    scope: { kind: 'workspace', workspaceId: f.workspaceId },
  };
  const connections: ReturnType<typeof openWorkspaceDb>[] = [];
  onTestFinished(() => {
    for (const db of connections) if (db.sqlite.open) db.sqlite.close();
  });
  const dependencies = {
    dataRoot: f.dataRoot,
    coreDb: f.coreDb,
    store: f.store,
    inflightCommands: new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>(),
    repositoryWorkspaceDb(workspaceId: string) {
      const db = openWorkspaceDb(f.dataRoot, workspaceId);
      connections.push(db);
      return db;
    },
  };
  arm(f.input.requestId, 0);
  let settled = false;
  const result = f.track(
    prepareCatalogSkillDecision(
      dependencies,
      {
        operation: 'catalog.skill-candidate-decide',
        decision: 'rejected',
        requestId: f.input.requestId,
        workspaceId: f.workspaceId,
        candidateId: allocateEntityId('cand'),
        expectedRevision: 2,
      },
      context
    )
  );
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const gate = new Int32Array(fault.gate);
  expect(
    await Promise.race([waiting(gate, 0).then(() => 'held'), result.then(() => 'early')])
  ).toBe('held');
  expect(Atomics.load(gate, 0)).toBe(1);
  expect(Atomics.load(gate, 5)).toBe(1);
  expect(Atomics.load(gate, 3)).toBe(2);
  expect(fault.workers[Atomics.load(gate, 4)]).toBeDefined();
  expect(settled).toBe(false);
  const events = f.events();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: 'catalog.skill-candidate-decide.admit',
    requestId: f.input.requestId,
    actor: context.actorRef,
    outcome: 'succeeded',
    resourceRevision: 2,
  });
  expect(f.rows().receipts).toEqual([]);
  const prefix = f.rows();
  release();
  await result;
  expect(settled).toBe(true);
  expect(f.rows()).toEqual(prefix);
  expect(await f.cold()).toEqual(prefix);
});

it.each(cases)(
  'preserves original $operation outcome, current-version replay and CAS refusals',
  async (c) => {
    const f = await fixture(c);
    const before = f.bytes();
    const stale = await f.call({ ...f.input, expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'conflict' });
    expect(f.bytes()).toBe(before);
    expect(f.rows()).toEqual({ audits: [], receipts: [] });
    if (c.stage === 3 || c.stage === 4) {
      const conflict = await f.call({
        ...f.input,
        ...(c.stage === 3
          ? { expectedCurrentDigest: f.second.digest }
          : { expectedPinDigest: f.first.digest }),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'conflict' });
      expect(f.bytes()).toBe(before);
      expect(f.rows()).toEqual({ audits: [], receipts: [] });
    }
    await success(f, await f.call());
    effect(f);
    audit(f);
    receipt(f);
    const original = f.rows();
    const completed = f.bytes();
    const changedInput = await f.call({ ...f.input, expectedRevision: 1 });
    expect(changedInput.status).toBe(409);
    expect(await changedInput.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.rows()).toEqual(original);
    expect(f.bytes()).toBe(completed);
    selectWorkspaceLightAppDefinitionDefault({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      entryId: 'notes',
      expectedRevision: 3,
      digest: f.first.digest,
      expectedCurrentDigest:
        c.stage === 1 ? f.finalDigest : c.stage === 3 ? f.second.digest : f.first.digest,
    });
    const moved = f.bytes();
    await success(f, await f.call(), 4);
    expect(f.rows()).toEqual(original);
    expect(f.bytes()).toBe(moved);
    expect(
      resolveWorkspaceLightAppDefinition({
        dataRoot: f.dataRoot,
        workspaceId: f.workspaceId,
        entryId: 'notes',
      }).version.digest
    ).toBe(c.stage === 4 ? f.second.digest : f.first.digest);
    expect(await f.cold()).toEqual(original);
    expect(f.bytes()).toBe(moved);
  }
);

it.each(cases)(
  'awaits actual native $operation completion before original receipt and public success',
  async (c) => {
    const f = await fixture(c);
    let settled = false;
    const result = f.start();
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await held(f, result);
    expect(settled).toBe(false);
    const event = audit(f);
    expect(f.rows().receipts).toEqual([]);
    const bytes = f.bytes();
    release();
    await success(f, await result);
    receipt(f);
    expect(audit(f)).toEqual(event);
    const prefix = f.rows();
    await success(f, await f.call());
    expect(f.rows()).toEqual(prefix);
    expect(f.bytes()).toBe(bytes);
    expect(await f.cold()).toEqual(prefix);
    expect(f.bytes()).toBe(bytes);
  }
);

it.each(cases)(
  'retains actual $operation effect and historical Audit after lost completion ACK without receipt or repost',
  async (c) => {
    const f = await fixture(c);
    const result = f.start();
    const worker = await held(f, result);
    audit(f);
    expect(f.rows().receipts).toEqual([]);
    const prefix = f.rows();
    const bytes = f.bytes();
    const posts = fault.messages.length;
    const workers = fault.workers.length;
    await worker.terminate();
    const response = await result;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'recovery_required',
      message:
        'Definition publication completed but its command outcome is unavailable. Inspect the catalog before a new request.',
    });
    expect(fault.messages).toHaveLength(posts);
    expect(fault.workers).toHaveLength(workers);
    expect(f.rows()).toEqual(prefix);
    expect(f.bytes()).toBe(bytes);
    expect(await f.cold()).toEqual(prefix); // Explicit shutdown is required before a new native host.
    const replay = await f.call();
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'conflict' });
    expect(f.rows()).toEqual(prefix);
    expect(f.bytes()).toBe(bytes);
    expect(await f.cold()).toEqual(prefix);
  }
);

it.each(cases)(
  'keeps original $operation historical actor and receipt before final revoked-authority refusal',
  async (c) => {
    const f = await fixture(c);
    const result = f.start();
    await held(f, result);
    const event = audit(f);
    expect(f.rows().receipts).toEqual([]);
    const bytes = f.bytes();
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
    expect(isCanonicalUserActive(f.coreDb, f.userId)).toBe(false);
    release();
    const response = await result;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'catalog_forbidden' });
    receipt(f);
    expect(audit(f)).toEqual(event);
    expect(f.bytes()).toBe(bytes);
    const prefix = f.rows();
    expect(await f.cold()).toEqual(prefix);
    expect(f.bytes()).toBe(bytes);
  }
);
