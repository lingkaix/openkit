import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { OperationId } from '@openkit/app-api-schemas';
import { isEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { loadResourceCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { commandInputHash } from './control-store-input.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

// Node 24 implements Atomics.waitAsync. The package TypeScript lib stops at ES2023.
declare global {
  interface Atomics {
    waitAsync(
      typedArray: Int32Array,
      index: number,
      value: number,
      timeout?: number
    ):
      | { async: false; value: 'not-equal' | 'timed-out' }
      | { async: true; value: Promise<'ok' | 'timed-out'> };
    waitAsync(
      typedArray: BigInt64Array,
      index: number,
      value: bigint,
      timeout?: number
    ):
      | { async: false; value: 'not-equal' | 'timed-out' }
      | { async: true; value: Promise<'ok' | 'timed-out'> };
  }
}

// L2: public operation admission -> original standalone Server MCP Audit stages -> real native FULL COMMIT.
// Core Storage, SQLite Layers, owns physical placement and acknowledgement; Server MCP
// Administration owns the started-before-effect and completed-before-receipt closure. Vault
// server-mcp-* actions and the mcp-discovery-preview Vault alias are a different owner.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  messages: [] as unknown[],
  gate: new SharedArrayBuffer(10 * Int32Array.BYTES_PER_ELEMENT),
  targets: new SharedArrayBuffer(4096),
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
        // Hold only the COMMIT of a transaction that inserted the exact selected Audit row.
        // A later COMMIT that merely observes an independently committed Main row never holds.
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const gate = workerData.auditGate;
          const originalExec = Database.prototype.exec;
          const originalPrepare = Database.prototype.prepare;
          const inserted = new WeakMap();
          const transactionStages = (db) => {
            let stages = inserted.get(db);
            if (!stages) { stages = new Set(); inserted.set(db, stages); }
            return stages;
          };
          const targets = () => {
            const raw = Buffer.from(workerData.auditTargets).toString('utf8').replace(/\u0000+$/, '');
            return raw ? JSON.parse(raw) : [];
          };
          Database.prototype.prepare = function(sql) {
            const statement = originalPrepare.call(this, sql);
            if (!/^\s*INSERT\s+INTO\s+audit_events\b/i.test(sql)) return statement;
            const run = statement.run.bind(statement);
            statement.run = (...args) => {
              const result = run(...args);
              try {
                if (!originalPrepare.call(this,
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events'").get())
                  return result;
                const rowid = originalPrepare.call(this, 'SELECT last_insert_rowid() AS id').get().id;
                const row = originalPrepare.call(this,
                  'SELECT request_id, action, outcome, resource FROM audit_events WHERE rowid=?')
                  .get(rowid);
                if (!row) return result;
                for (const [stage, target] of targets().entries()) {
                  if (row.request_id === target.requestId &&
                      row.action === target.action &&
                      row.outcome === target.outcome &&
                      row.resource === target.resource)
                    transactionStages(this).add(stage);
                }
              } catch {}
              return result;
            };
            return statement;
          };
          Database.prototype.exec = function(sql) {
            if (/^\s*(BEGIN|ROLLBACK)\b/i.test(sql)) transactionStages(this).clear();
            const result = originalExec.call(this, sql);
            if (!/^\s*COMMIT\s*;?\s*$/i.test(sql)) return result;
            const stages = transactionStages(this);
            const selected = targets();
            for (const stage of [...stages]) {
              const target = selected[stage];
              if (!target) continue;
              // A savepoint rollback can remove an inserted row before the outer COMMIT.
              const committed = originalPrepare.call(this,
                'SELECT 1 FROM audit_events WHERE request_id=? AND action=? AND outcome=? AND resource=?')
                .get(target.requestId, target.action, target.outcome, target.resource);
              if (!committed) continue;
              const base = stage * 5;
              if (Atomics.compareExchange(gate, base + 1, 1, 0) !== 1) continue;
              Atomics.store(gate, base + 3, this.pragma('synchronous', {simple:true}));
              Atomics.store(gate, base + 4, workerData.auditWorkerIndex);
              Atomics.store(gate, base, 1);
              Atomics.notify(gate, base);
              Atomics.wait(gate, base + 2, 0);
            }
            stages.clear();
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
            auditTargets: new Uint8Array(fault.targets),
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

const ACTIONS = [
  'administration.server-mcp-create',
  'administration.server-mcp-stage-version',
  'administration.server-mcp-select-version',
  'administration.server-mcp-update-binding',
  'administration.server-mcp-remove',
] as const;
type Action = (typeof ACTIONS)[number];

const DECLARATION = { kind: 'http' as const, endpoint: 'https://mcp.example.test/mcp' };
const NEXT_DECLARATION = {
  kind: 'http' as const,
  endpoint: 'https://mcp.example.test/next',
};
const CREATION = {
  id: 'shared',
  displayName: 'Shared',
  allowedTools: ['echo'],
  declaration: DECLARATION,
  expectedRevision: 0,
};

/** Release one real post-COMMIT hold, including a pending observer during failed-test cleanup. */
function release(stage: 0 | 1) {
  const gate = new Int32Array(fault.gate);
  const base = stage * 5;
  Atomics.store(gate, base + 1, 0);
  Atomics.store(gate, base + 2, 1);
  Atomics.notify(gate, base + 2);
  if (Atomics.compareExchange(gate, base, 0, -1) === 0) Atomics.notify(gate, base);
}

/** Select only the original request's exact started or completed Audit row. */
function arm(
  requestId: string,
  targets: ReadonlyArray<{
    action: string;
    outcome: string;
    resource: string;
  }>,
  stages: readonly (0 | 1)[]
) {
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  const encoded = new Uint8Array(fault.targets);
  encoded.fill(0);
  encoded.set(
    new TextEncoder().encode(JSON.stringify(targets.map((target) => ({ requestId, ...target }))))
  );
  for (const stage of stages) Atomics.store(gate, stage * 5 + 1, 1);
}

/** The original Audit resource is the input-hash marker, not a future codec shape. */
function markerFor(action: Action, userId: string, requestId: string) {
  return `mcp-command:${commandInputHash({
    name: action,
    scope: { actorId: userId, coreId: 'server' },
    requestId,
  })}`;
}

/** An actual early HTTP success wins over waiting for an absent native stage; fail immediately. */
async function hold(
  stage: 0 | 1,
  result: Promise<Response>,
  assertEarlySuccess: (response: Response) => Promise<void>
) {
  const gate = new Int32Array(fault.gate);
  const base = stage * 5;
  const ready: Promise<'held'> = Promise.resolve(Atomics.waitAsync(gate, base, 0).value).then(
    (): 'held' => 'held'
  );
  const early: Promise<{ readonly response: Response }> = result.then(
    async (response): Promise<{ readonly response: Response }> => ({ response })
  );
  const outcome: 'held' | { readonly response: Response } = await Promise.race([ready, early]);
  if (outcome !== 'held') {
    await assertEarlySuccess(outcome.response);
    throw new Error(
      `Public operation returned HTTP ${outcome.response.status} before the native Audit COMMIT hold.`
    );
  }
  expect(Atomics.load(gate, base)).toBe(1);
  expect(Atomics.load(gate, base + 3)).toBe(2); // Actual deciding SQLite connection uses FULL.
  return fault.workers[Atomics.load(gate, base + 4)]!;
}

const signedOutAuth: BetterAuthServer = {
  api: { getSession: async () => null },
  handler: async () => new Response(null, { status: 404 }),
};

/** Compose public HTTP operation admission and the real catalog, Audit and receipt owners. */
async function fixture() {
  release(0);
  release(1);
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-mcp-standalone-audit-'));
  const coreDb = openCoreDb(dataRoot);
  let pending: Promise<Response> | undefined;
  onTestFinished(async () => {
    release(0);
    release(1);
    await pending?.catch(() => undefined);
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const store = new FsStore({ dataRoot });
  const app = await createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    auth: signedOutAuth,
  });
  const headers = { authorization: `Bearer ${admin.secret}` };
  const send = (
    operation: OperationId,
    input: Record<string, unknown>,
    requestId: string
  ): Promise<Response> => {
    const [path, init] = operationRequest(
      operation,
      {},
      {
        headers,
        body: JSON.stringify({ ...input, requestId }),
      }
    );
    const response = Promise.resolve(app.request(path, init));
    pending = response;
    return response;
  };
  const sendOk = async (operation: Action, input: Record<string, unknown>) => {
    const response = await send(operation, input, randomUUID());
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  const audits = (requestId: string) =>
    listServerAuditEvents(coreDb).filter((event) => event.requestId === requestId);
  // Exact Core-handle reads avoid User/Workspace inventory and path-owned migration or pruning.
  const receipts = (requestId: string, receiptDb = coreDb, receiptStore = store) =>
    ACTIONS.flatMap((command) => {
      const receipt = receiptStore.getCommandRequest(
        command,
        requestId,
        { actorId: userId, coreId: 'server' },
        receiptDb
      );
      return receipt ? [receipt] : [];
    });
  const snapshot = () => {
    const catalog = loadResourceCatalog(dataRoot, { kind: 'server' });
    const entry = catalog.mcp.entries.find((item) => item.id === 'shared');
    const binding = catalog.mcp.bindings.find((item) => item.entryId === 'shared');
    return {
      revision: catalog.revision,
      entries: catalog.mcp.entries.length,
      versions: catalog.mcp.versions.filter((version) => version.entryId === 'shared').length,
      currentVersionDigest: entry?.currentVersionDigest ?? null,
      availability: entry?.availability ?? null,
      bindingEnabled: binding?.enabled ?? null,
      allowedTools: binding?.allowedTools ?? null,
    };
  };
  return {
    coreDb,
    dataRoot,
    userId,
    admin,
    store,
    send,
    sendOk,
    audits,
    receipts,
    snapshot,
    async cold(requestId: string) {
      const originals = { audits: audits(requestId), receipts: receipts(requestId) };
      await shutdownControlStoreWorkerClient();
      const coldDb = openCoreDb(dataRoot);
      try {
        coldDb.sqlite.pragma('query_only = ON');
        return {
          audits: listServerAuditEvents(coldDb).filter((event) => event.requestId === requestId),
          receipts: receipts(requestId, coldDb, new FsStore({ dataRoot })),
          originals,
        };
      } finally {
        coldDb.sqlite.close();
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Builds the exact pre-effect state and the action's valid input through public owner operations. */
async function prepare(action: Action, f: Fixture) {
  let stagedDigest: string | undefined;
  let input: Record<string, unknown>;
  switch (action) {
    case 'administration.server-mcp-create':
      input = CREATION;
      break;
    case 'administration.server-mcp-stage-version':
      await f.sendOk('administration.server-mcp-create', CREATION);
      input = {
        ...CREATION,
        mcpId: 'shared',
        declaration: NEXT_DECLARATION,
        expectedRevision: 1,
      };
      break;
    case 'administration.server-mcp-select-version': {
      await f.sendOk('administration.server-mcp-create', CREATION);
      const staged = await f.sendOk('administration.server-mcp-stage-version', {
        ...CREATION,
        mcpId: 'shared',
        declaration: NEXT_DECLARATION,
        expectedRevision: 1,
      });
      stagedDigest = String(staged.versionDigest);
      input = { mcpId: 'shared', digest: stagedDigest, expectedRevision: 2 };
      break;
    }
    case 'administration.server-mcp-update-binding': {
      await f.sendOk('administration.server-mcp-create', CREATION);
      const binding = loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.bindings.find(
        (item) => item.entryId === 'shared'
      )!;
      input = {
        mcpId: 'shared',
        expectedRevision: 1,
        bindingRevision: binding.revision,
        enabled: true,
        allowedTools: ['echo'],
        schemaPolicy: 'tracking',
      };
      break;
    }
    case 'administration.server-mcp-remove':
      await f.sendOk('administration.server-mcp-create', CREATION);
      input = { mcpId: 'shared', expectedRevision: 1 };
      break;
  }
  const before = f.snapshot();
  const assertEffect = () => {
    const after = f.snapshot();
    expect(after.revision).toBe(before.revision + 1);
    switch (action) {
      case 'administration.server-mcp-create':
        expect(after.entries).toBe(1);
        expect(after.versions).toBe(1);
        expect(after.currentVersionDigest).toEqual(expect.any(String));
        expect(after.availability).toBe('available');
        expect(after.bindingEnabled).toBe(false);
        break;
      case 'administration.server-mcp-stage-version':
        expect(after.versions).toBe(2);
        expect(after.currentVersionDigest).toBe(before.currentVersionDigest);
        break;
      case 'administration.server-mcp-select-version':
        expect(after.currentVersionDigest).toBe(stagedDigest);
        break;
      case 'administration.server-mcp-update-binding':
        expect(after.bindingEnabled).toBe(true);
        expect(after.allowedTools).toEqual(['echo']);
        break;
      case 'administration.server-mcp-remove':
        expect(after.availability).toBe('removed');
        expect(after.bindingEnabled).toBe(false);
        break;
    }
  };
  return { input, before, assertEffect };
}

/** The exact original actor, request, action, outcome and resource of one Server MCP Audit. */
function expectOriginal(
  event: ReturnType<Fixture['audits']>[number],
  requestId: string,
  userId: string,
  action: Action,
  outcome: 'unknown' | 'succeeded',
  resource: string
) {
  expect(event).toMatchObject({
    workspaceId: null,
    requestId,
    actor: { kind: 'user', id: userId },
    category: 'system',
    action,
    resource,
    outcome,
    errorCode: null,
  });
  expect(event.vaultGrantId).toBeNull();
  expect(isEntityId('aud', event.id)).toBe(true);
  const createdAt = event.createdAt;
  const occurredAt = event.occurredAt;
  expect(typeof createdAt).toBe('string');
  expect(typeof occurredAt).toBe('string');
  if (typeof createdAt !== 'string' || typeof occurredAt !== 'string') return;
  expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
  expect(Number.isFinite(Date.parse(occurredAt))).toBe(true);
}

it.each(ACTIONS)(
  '%s keeps started Audit FULL-acknowledged before the catalog effect and completion before the original receipt',
  async (action) => {
    const f = await fixture();
    const { input, before, assertEffect } = await prepare(action, f);
    const requestId = randomUUID();
    const marker = markerFor(action, f.userId, requestId);
    arm(
      requestId,
      [
        { action, outcome: 'unknown', resource: marker },
        { action, outcome: 'succeeded', resource: 'catalog_mcp:shared' },
      ],
      [0, 1]
    );
    let settled = false;
    const result = f.send(action, input, requestId);
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await hold(0, result, async (response) => {
      expect(response.status).toBe(200);
      const body = (await response.clone().json()) as Record<string, unknown>;
      expect(body).toMatchObject({ revision: before.revision + 1 });
      assertEffect();
    });
    expect(settled).toBe(false);
    expect(f.snapshot()).toEqual(before);
    expect(f.receipts(requestId)).toEqual([]);
    const started = f.audits(requestId);
    expect(started).toHaveLength(1);
    expectOriginal(started[0]!, requestId, f.userId, action, 'unknown', marker);

    release(0);
    await hold(1, result, async (response) => {
      expect(response.status).toBe(200);
      assertEffect();
    });
    expect(settled).toBe(false);
    assertEffect();
    expect(f.receipts(requestId)).toEqual([]);
    const completed = f.audits(requestId);
    expect(completed).toHaveLength(2);
    expectOriginal(
      completed.find((event) => event.outcome === 'unknown')!,
      requestId,
      f.userId,
      action,
      'unknown',
      marker
    );
    expectOriginal(
      completed.find((event) => event.outcome === 'succeeded')!,
      requestId,
      f.userId,
      action,
      'succeeded',
      'catalog_mcp:shared'
    );

    release(1);
    const response = await result;
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ revision: before.revision + 1 });
    assertEffect();
    const receipts = f.receipts(requestId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      command: action,
      requestId,
      scope: { actorId: f.userId, coreId: 'server' },
      response: { kind: 'catalog_mcp', id: 'shared' },
    });
    expect(receipts[0]!.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const cold = await f.cold(requestId);
    expect({ audits: cold.audits, receipts: cold.receipts }).toEqual(cold.originals);
  }
);

it('keeps a truthful started prefix and no effect, receipt or repost when the first native ACK is lost', async () => {
  const f = await fixture();
  const { input, before } = await prepare('administration.server-mcp-create', f);
  const requestId = randomUUID();
  const action = 'administration.server-mcp-create' as const;
  const marker = markerFor(action, f.userId, requestId);
  arm(requestId, [{ action, outcome: 'unknown', resource: marker }], [0]);
  const result = f.send(action, input, requestId);
  const worker = await hold(0, result, async (response) => {
    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      revision: before.revision + 1,
      versionDigest: expect.any(String),
      entry: { id: 'shared' },
    });
    expect(f.snapshot().revision).toBe(before.revision + 1);
  });
  const prefix = {
    audits: f.audits(requestId),
    receipts: f.receipts(requestId),
    catalog: f.snapshot(),
  };
  expect(prefix.audits).toHaveLength(1);
  expectOriginal(prefix.audits[0]!, requestId, f.userId, action, 'unknown', marker);
  expect(prefix.receipts).toEqual([]);
  expect(prefix.catalog).toEqual(before);

  await worker.terminate(); // Exact owner recorded at the selected real COMMIT, never workers.at(-1).
  const response = await result;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'recovery_required' });
  expect(f.audits(requestId)).toEqual(prefix.audits);
  expect(f.receipts(requestId)).toEqual([]);
  expect(f.snapshot()).toEqual(prefix.catalog);

  // Explicit shutdown ends the failed host lifetime; it does not settle or repost the command.
  await shutdownControlStoreWorkerClient();
  const retry = await f.send(action, input, requestId);
  expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({ code: 'recovery_required' });
  expect(f.audits(requestId)).toEqual(prefix.audits);
  expect(f.receipts(requestId)).toEqual([]);
  expect(f.snapshot()).toEqual(prefix.catalog);
});

it('keeps the catalog effect and completed Audit prefix without a receipt or automatic repost after the second ACK is lost', async () => {
  const f = await fixture();
  const { input, before, assertEffect } = await prepare('administration.server-mcp-create', f);
  const requestId = randomUUID();
  const action = 'administration.server-mcp-create' as const;
  const marker = markerFor(action, f.userId, requestId);
  // Target index is the observer stage. Slot 1 is the succeeded COMMIT; only that slot is held.
  arm(
    requestId,
    [
      { action, outcome: 'unknown', resource: marker },
      { action, outcome: 'succeeded', resource: 'catalog_mcp:shared' },
    ],
    [1]
  );
  const result = f.send(action, input, requestId);
  const worker = await hold(1, result, async (response) => {
    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      revision: before.revision + 1,
      versionDigest: expect.any(String),
      entry: { id: 'shared' },
    });
    assertEffect();
  });
  assertEffect();
  expect(f.receipts(requestId)).toEqual([]);
  const prefix = { audits: f.audits(requestId), receipts: f.receipts(requestId) };
  expect(prefix.audits).toHaveLength(2);
  expectOriginal(
    prefix.audits.find((event) => event.outcome === 'unknown')!,
    requestId,
    f.userId,
    action,
    'unknown',
    marker
  );
  expectOriginal(
    prefix.audits.find((event) => event.outcome === 'succeeded')!,
    requestId,
    f.userId,
    action,
    'succeeded',
    'catalog_mcp:shared'
  );

  await worker.terminate(); // Exact owner recorded at the selected real COMMIT, never workers.at(-1).
  const response = await result;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'recovery_required' });
  expect(f.audits(requestId)).toEqual(prefix.audits);
  expect(f.receipts(requestId)).toEqual([]);
  assertEffect();

  // Explicit shutdown ends the failed host lifetime; it does not settle or repost the command.
  await shutdownControlStoreWorkerClient();
  const retry = await f.send(action, input, requestId);
  expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({ code: 'recovery_required' });
  expect(f.audits(requestId)).toEqual(prefix.audits);
  expect(f.receipts(requestId)).toEqual([]);
  assertEffect();
});

it('refuses a revoked administrator after the first held ACK before any catalog effect', async () => {
  const f = await fixture();
  const { input, before } = await prepare('administration.server-mcp-create', f);
  const requestId = randomUUID();
  const action = 'administration.server-mcp-create' as const;
  const marker = markerFor(action, f.userId, requestId);
  arm(requestId, [{ action, outcome: 'unknown', resource: marker }], [0]);
  const result = f.send(action, input, requestId);
  await hold(0, result, async (response) => {
    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as Record<string, unknown>;
    expect(body).toMatchObject({ revision: before.revision + 1 });
    expect(f.snapshot().revision).toBe(before.revision + 1);
  });
  expect(f.snapshot()).toEqual(before);
  expect(f.receipts(requestId)).toEqual([]);
  const started = f.audits(requestId);
  expect(started).toHaveLength(1);
  expectOriginal(started[0]!, requestId, f.userId, action, 'unknown', marker);

  revokeOpenKitAccessTokenRecord(f.coreDb, f.admin.tokenId);
  release(0);
  const response = await result;
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'deployment_admin_required' });
  expect(f.snapshot()).toEqual(before);
  expect(f.receipts(requestId)).toEqual([]);
  expect(f.audits(requestId)).toEqual(started);
});
