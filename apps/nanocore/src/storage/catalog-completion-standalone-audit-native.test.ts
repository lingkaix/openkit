import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { isEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../app.js';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  catalogDocumentPath,
  loadWorkspaceResourceCatalog,
  readWorkspaceSkillSnapshot,
  validateCatalogTree,
} from '../catalog/resource-catalog.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

// L2: Skill Catalog, Candidates And Review / Storage, Publication, And Recovery;
// Core Storage, SQLite Layers; Policy current admission is not historical settlement.
// Preserve three original file -> completion Audit -> afterMutation -> receipt stages.
type Action =
  | 'catalog.skill-candidate-submit'
  | 'catalog.skill-candidate-decide'
  | 'catalog.skill-candidate-withdraw';
const actions: readonly Action[] = [
  'catalog.skill-candidate-submit',
  'catalog.skill-candidate-decide',
  'catalog.skill-candidate-withdraw',
];
const fault = vi.hoisted(
  (): {
    workers: NativeWorker[];
    messages: unknown[];
    gate: SharedArrayBuffer;
    request: SharedArrayBuffer;
    actions: string[];
  } => ({
    workers: [],
    messages: [],
    gate: new SharedArrayBuffer(10 * Int32Array.BYTES_PER_ELEMENT),
    request: new SharedArrayBuffer(36),
    actions: [],
  })
);

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = fault.workers.length;
        // Existing admission observer: a row absent before this native savepoint and
        // present after its real RELEASE proves insertion here, not an earlier Main row.
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.auditGate;
          const before = new WeakMap();
          const inserted = new WeakMap();
          function rows(db) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_events' AND type='table'").get()) return [];
            return db.prepare('SELECT action FROM audit_events WHERE request_id=?').all(
              Buffer.from(workerData.auditRequest).toString('ascii'));
          }
          Database.prototype.exec = function(sql) {
            if (sql === 'SAVEPOINT control_transition') before.set(this, rows(this));
            const result = originalExec.call(this, sql);
            if (sql === 'RELEASE control_transition') {
              const old = before.get(this) || [];
              const current = rows(this);
              const prior = inserted.get(this) || [];
              inserted.set(this, workerData.auditActions.map((action, stage) =>
                prior[stage] || (!old.some(row => row.action === action) && current.some(row => row.action === action))));
            }
            if (/^\s*COMMIT\s*;?\s*$/i.test(sql)) {
              const stages = inserted.get(this) || [];
              inserted.delete(this);
              for (let stage = 0; stage < workerData.auditActions.length; stage++) {
                const base = stage * 5;
                if (stages[stage] && Atomics.compareExchange(gate, base + 1, 1, 0) === 1) {
                  Atomics.store(gate, base + 3, this.pragma('synchronous', {simple:true}));
                  Atomics.store(gate, base + 4, workerData.auditWorkerIndex);
                  Atomics.store(gate, base, 1);
                  Atomics.notify(gate, base);
                  Atomics.wait(gate, base + 2, 0);
                }
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
            auditSqlModule: require.resolve('better-sqlite3'),
            auditGate: new Int32Array(fault.gate),
            auditRequest: new Uint8Array(fault.request),
            auditWorkerIndex: index,
            auditActions: fault.actions,
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

const tree: readonly {
  kind: 'file';
  path: string;
  executable: boolean;
  contentBase64: string;
}[] = [
  {
    kind: 'file',
    path: 'SKILL.md',
    executable: false,
    contentBase64: Buffer.from(
      '---\nname: completion-candidate\ndescription: Synthetic completion witness.\n---\nExact instructions.\n'
    ).toString('base64'),
  },
];

/** Release both real native holds and wake a losing wait during cleanup. */
function release(stage: 0 | 1) {
  const gate = new Int32Array(fault.gate);
  const base = stage * 5;
  Atomics.store(gate, base + 1, 0);
  Atomics.store(gate, base + 2, 1);
  Atomics.notify(gate, base + 2);
  if (Atomics.compareExchange(gate, base, 0, -1) === 0) Atomics.notify(gate, base);
}

/** The selected target's array index and armed gate are the same explicit stage. */
function arm(requestId: string, stage: 0 | 1) {
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  new Uint8Array(fault.request).set(new TextEncoder().encode(requestId));
  Atomics.store(gate, stage * 5 + 1, 1);
}

/** OLD must finish a valid real effect before this absent native hold, not time out. */
async function held(
  stage: 0 | 1,
  result: Promise<Response>,
  f: Awaited<ReturnType<typeof fixture>>
) {
  const gate = new Int32Array(fault.gate);
  const base = stage * 5;
  const outcome = await Promise.race([
    Promise.resolve(Atomics.waitAsync(gate, base, 0).value).then(() => 'held'),
    result.then((response) => {
      if (Atomics.load(gate, base) === 1) return 'response after native ACK hold';
      expect(response.status).toBe(f.action === 'catalog.skill-candidate-submit' ? 201 : 200);
      const published = f.catalog();
      expect(published.revision).toBe(f.before.revision + 1);
      expect(f.bytes()).not.toEqual(f.beforeBytes);
      expect(JSON.parse(f.bytes().toString('utf8'))).toEqual(published);
      expect(f.events().filter((event) => event.action === f.action)).toHaveLength(1);
      expect(f.rows().receipts).toHaveLength(1);
      expect(f.reload).toHaveBeenCalledTimes(1);
      return `HTTP ${response.status} after real Catalog revision ${published.revision} before native completion ACK`;
    }),
  ]);
  expect(
    outcome,
    'Real file publication must precede native completion FULL; later work must await its ACK.'
  ).toBe('held');
  expect(Atomics.load(gate, base)).toBe(1);
  expect(Atomics.load(gate, base + 3)).toBe(2);
  return fault.workers[Atomics.load(gate, base + 4)]!;
}

/** Build only through real identity, Workspace, Catalog and public command owners. */
async function fixture(action: Action) {
  release(0);
  release(1);
  fault.actions = [`${action}.admit`, action];
  const dataRoot = mkdtempSync(join(tmpdir(), 'catalog-completion-native-'));
  const coreDb = openCoreDb(dataRoot);
  let pending: Promise<Response> | undefined;
  let reader: ReturnType<typeof openWorkspaceDb> | undefined;
  onTestFinished(async () => {
    release(0);
    release(1);
    await pending?.catch(() => undefined);
    await shutdownControlStoreWorkerClient();
    if (reader?.sqlite.open) reader.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Synthetic completion');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const manager = createRuntimeConfigManager({ dataRoot });
  const app = await createApp({
    coreDb,
    dataRoot,
    store,
    runtimeConfigManager: manager,
    mode: 'server',
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
  });
  const reload = vi.spyOn(manager, 'reload'); // Delegates to the actual runtime owner.
  const catalog = () => loadWorkspaceResourceCatalog(dataRoot, workspace.id);
  const submit = {
    workspaceId: workspace.id,
    skillId: 'completion-candidate',
    expectedRevision: 0,
    baseDigest: null,
    requestId: randomUUID(),
    summary: 'Synthetic completion.',
    tree,
  };
  const headers = { authorization: `Bearer ${token.secret}` };
  const request = (operation: Action, input: unknown) =>
    Promise.resolve(
      app.request(...operationRequest(operation, {}, { headers, body: JSON.stringify(input) }))
    );
  if (action !== 'catalog.skill-candidate-submit') {
    const response = await request('catalog.skill-candidate-submit', submit);
    expect(response.status).toBe(201);
  }
  const before = catalog();
  const candidate = before.skills.candidates[0];
  const input =
    action === 'catalog.skill-candidate-submit'
      ? submit
      : {
          workspaceId: workspace.id,
          requestId: randomUUID(),
          expectedRevision: before.revision,
          candidateId: candidate!.id,
          ...(action === 'catalog.skill-candidate-decide'
            ? { decision: 'promoted', expectedCurrentDigest: null }
            : {}),
        };
  reader = openWorkspaceDb(dataRoot, workspace.id);
  const db = reader;
  const rows = (connection = db) => ({
    audits: connection.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY audit_event_id')
      .all(input.requestId),
    receipts: connection.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(input.requestId),
  });
  const catalogPath = catalogDocumentPath(dataRoot, workspace.id);
  const beforeBytes = existsSync(catalogPath) ? readFileSync(catalogPath) : null;
  reload.mockClear();
  return {
    action,
    coreDb,
    dataRoot,
    workspace,
    token,
    userId,
    store,
    input,
    db,
    rows,
    before,
    beforeBytes,
    catalog,
    reload,
    bytes: () => readFileSync(catalogPath),
    events: () =>
      listWorkspaceAuditEvents(db, workspace.id).filter(
        (event) => event.requestId === input.requestId
      ),
    start(stage: 0 | 1 = 1) {
      arm(input.requestId, stage);
      pending = request(action, input);
      return pending;
    },
    replay: () => request(action, input),
    async cold() {
      await shutdownControlStoreWorkerClient();
      const cold = openWorkspaceDb(dataRoot, workspace.id);
      try {
        cold.sqlite.pragma('query_only = ON');
        expect(cold.sqlite.pragma('query_only', { simple: true })).toBe(1);
        return rows(cold);
      } finally {
        cold.sqlite.close();
      }
    },
  };
}

/** Observe actual retained file bytes and the exact original standalone completion event. */
function completedPrefix(f: Awaited<ReturnType<typeof fixture>>) {
  const catalog = f.catalog();
  expect(catalog.revision).toBe(f.before.revision + 1);
  expect(f.bytes()).not.toEqual(f.beforeBytes);
  expect(JSON.parse(f.bytes().toString('utf8'))).toEqual(catalog);
  const candidate = catalog.skills.candidates[0]!;
  expect(candidate.candidateDigest).toBe(validateCatalogTree(tree).digest);
  expect(candidate.submitter).toEqual({ kind: 'user', id: f.userId });
  expect(candidate.disposition).toBe(
    f.action === 'catalog.skill-candidate-submit'
      ? 'proposed'
      : f.action === 'catalog.skill-candidate-decide'
        ? 'promoted'
        : 'withdrawn'
  );
  expect(
    readWorkspaceSkillSnapshot({
      dataRoot: f.dataRoot,
      workspaceId: f.workspace.id,
      entryId: 'completion-candidate',
      digest: candidate.candidateDigest,
    }).entries[0]?.content?.toString('base64')
  ).toBe(tree[0]!.contentBase64);
  const events = f.events();
  expect(events).toHaveLength(2);
  expect(events.filter((event) => event.action === `${f.action}.admit`)).toHaveLength(1);
  const completion = events.find((event) => event.action === f.action);
  expect(completion).toEqual({
    id: expect.any(String),
    workspaceId: f.workspace.id,
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
    action: f.action,
    resource: `skill-candidate:${candidate.id}`,
    resourceRevision: catalog.revision,
    outcome: 'succeeded',
    severity: 'info',
    summary: 'Skill candidate command completed.',
    errorCode: null,
    createdAt: expect.any(String),
    occurredAt: expect.any(String),
  });
  if (!completion) throw new Error('Original completion event is missing.');
  expect(isEntityId('aud', completion.id)).toBe(true);
  if (typeof completion.createdAt !== 'string' || typeof completion.occurredAt !== 'string')
    throw new Error('Original completion timestamps are missing.');
  expect(Number.isFinite(Date.parse(completion.createdAt))).toBe(true);
  expect(Number.isFinite(Date.parse(completion.occurredAt))).toBe(true);
  expect(f.rows().receipts).toEqual([]);
  expect(f.reload).not.toHaveBeenCalled();
  return { catalog, bytes: f.bytes(), rows: f.rows(), completion };
}

it.each(
  actions
)('%s acknowledges native completion after the real file effect and before reload/receipt/response', async (action) => {
  const f = await fixture(action);
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
  await held(1, result, f);
  expect(settled).toBe(false);
  const prefix = completedPrefix(f);
  release(1);
  const response = await result;
  expect(response.status).toBe(action === 'catalog.skill-candidate-submit' ? 201 : 200);
  const body = await response.json();
  expect(f.reload).toHaveBeenCalledTimes(1);
  expect(f.catalog()).toEqual(prefix.catalog);
  expect(f.bytes()).toEqual(prefix.bytes);
  expect(f.events().find((event) => event.action === action)).toEqual(prefix.completion);
  expect(f.rows().receipts).toHaveLength(1);
  const replay = await f.replay();
  expect(replay.status).toBe(response.status);
  expect(await replay.json()).toEqual(body);
  expect(f.reload).toHaveBeenCalledTimes(1);
  expect(f.events()).toHaveLength(2);
  expect(await f.cold()).toEqual(f.rows());
  expect(f.catalog()).toEqual(prefix.catalog);
});

it.each(
  actions
)('%s retains its cold file/Audit prefix after completion ACK loss without a receipt or automatic repost', async (action) => {
  const f = await fixture(action);
  const result = f.start();
  const worker = await held(1, result, f);
  const prefix = completedPrefix(f);
  const posts = fault.messages.length;
  const workers = fault.workers.length;
  await worker.terminate();
  const response = await result;
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
  expect(fault.messages).toHaveLength(posts);
  expect(fault.workers).toHaveLength(workers);
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.rows()).toEqual(prefix.rows);
  expect(f.bytes()).toEqual(prefix.bytes);
  expect(await f.cold()).toEqual(prefix.rows);
  const retry = await f.replay();
  expect(retry.status).toBe(409);
  await expect(retry.json()).resolves.toMatchObject({ code: 'recovery_required' });
  expect(f.catalog()).toEqual(prefix.catalog);
  expect(f.bytes()).toEqual(prefix.bytes);
  expect(f.rows()).toEqual(prefix.rows);
  expect(f.reload).not.toHaveBeenCalled();
});

it('settles the original actor after completion COMMIT even when its live credential is revoked before ACK', async () => {
  const f = await fixture('catalog.skill-candidate-submit');
  const result = f.start();
  await held(1, result, f);
  const prefix = completedPrefix(f);
  revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
  expect(getOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId)?.status).toBe('revoked');
  release(1);
  const response = await result;
  // Historical settlement completes; the existing final current response check still refuses disclosure.
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: 'catalog_forbidden' });
  expect(f.events().find((event) => event.action === f.action)).toEqual(prefix.completion);
  expect(f.reload).toHaveBeenCalledTimes(1);
  expect(f.rows().receipts).toHaveLength(1);
  expect(f.bytes()).toEqual(prefix.bytes);
  expect(await f.cold()).toEqual(f.rows());
});
