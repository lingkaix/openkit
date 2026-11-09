// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { type AuditEvent, allocateEntityId, isRecord } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createServerMcpOperationImplementations } from '../administration/server-mcp-operations.js';
import { listServerAuditEvents, prepareServerAuditEvent } from '../audit-events.js';
import { createAccessTokenOperationImplementations } from '../auth/access-token-operations.js';
import { listOpenKitAccessTokenRecords } from '../auth/access-token-store.js';
import {
  consumeServerBootstrapToken,
  ensureServerBootstrapToken,
  isServerBootstrapComplete,
  writeServerBootstrapTokenEmission,
} from '../auth/bootstrap-token.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { ControlScalarTextSchema, readControlScalarText } from './control-store-input.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { isControlWorkerRequest } from './control-store-worker-protocol.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { ControlStandaloneAuditInputSchema } from './standalone-audit-codecs.js';

// Node 24 supplies waitAsync; the package intentionally retains its ES2023 lib.
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

type PreparedAudit = AuditEvent & { createdAt: string; occurredAt: string };
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  operations: [] as string[],
  sent: [] as Array<{ id: number; stage: string; event: PreparedAudit }>,
  acks: [] as number[],
  gate: new SharedArrayBuffer(9 * Int32Array.BYTES_PER_ELEMENT),
  target: new SharedArrayBuffer(4096),
}));

// L2: real operation -> existing standalone-Audit variant -> actual Core owner.
// Storage, SQLite Layers, owns FULL/ACK order. Remote Auth Credential Bootstrap,
// Server-mode bootstrap ceremony, owns the earlier atomic consume SQL tuple.
// File clearing happens inside that callback's time, but is not SQLite-atomic.
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
          const { workerData } = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const gate = workerData.auditGate;
          const originalPrepare = Database.prototype.prepare;
          const originalExec = Database.prototype.exec;
          const inserted = new WeakMap();
          const target = () => {
            const raw = Buffer.from(workerData.auditTarget).toString('utf8').replace(/\u0000+$/, '');
            return raw ? JSON.parse(raw) : null;
          };
          const matches = (db, t) => t && db.name === t.path;
          const selected = (db, t) => originalPrepare.call(db,
            'SELECT audit_event_id FROM audit_events WHERE action=? AND request_id IS ? AND outcome=?')
            .all(t.action, t.requestId, t.outcome);
          Database.prototype.prepare = function(sql) {
            const statement = originalPrepare.call(this, sql);
            if (!/^\s*INSERT\s+INTO\s+audit_events\b/i.test(sql)) return statement;
            const run = statement.run.bind(statement);
            statement.run = (...args) => {
              const t = target();
              const chosen = matches(this, t) && args.includes(t.action) && Atomics.load(gate, 1) === 1;
              if (chosen) Atomics.store(gate, 6, selected(this, t).length === 0 ? 1 : -1);
              if (chosen && t.fail && Atomics.compareExchange(gate, 1, 1, 0) === 1) {
                // Ask real SQLite to refuse this INSERT; do not replace its result or ACK.
                const previous = this.pragma('query_only', { simple: true });
                this.pragma('query_only = ON');
                try { return run(...args); }
                finally {
                  this.pragma('query_only = ' + previous);
                  Atomics.store(gate, 8, 1);
                }
              }
              const result = run(...args);
              if (chosen) {
                const rowid = originalPrepare.call(this, 'SELECT last_insert_rowid() AS id').get().id;
                const row = originalPrepare.call(this,
                  'SELECT audit_event_id,action,request_id,outcome FROM audit_events WHERE rowid=?').get(rowid);
                if (row && row.action === t.action && row.request_id === t.requestId && row.outcome === t.outcome) {
                  inserted.set(this, row.audit_event_id);
                  Atomics.add(gate, 5, 1);
                  Atomics.store(gate, 7, selected(this, t).length === 1 ? 1 : -1);
                }
              }
              return result;
            };
            return statement;
          };
          Database.prototype.exec = function(sql) {
            if (/^\s*(BEGIN|ROLLBACK)\b/i.test(sql)) inserted.delete(this);
            const result = originalExec.call(this, sql);
            if (!/^\s*COMMIT\s*;?\s*$/i.test(sql)) return result;
            const t = target();
            const id = inserted.get(this);
            inserted.delete(this);
            if (!matches(this, t) || !id || !selected(this, t).some(row => row.audit_event_id === id)) return result;
            if (Atomics.compareExchange(gate, 1, 1, 0) !== 1) return result;
            Atomics.store(gate, 3, this.pragma('synchronous', { simple: true }));
            Atomics.store(gate, 4, workerData.auditWorkerIndex);
            Atomics.store(gate, 0, 1);
            Atomics.notify(gate, 0);
            Atomics.wait(gate, 2, 0);
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
            auditTarget: new Uint8Array(fault.target),
            auditWorkerIndex: index,
          },
        });
        fault.workers.push(this);
        this.on('message', (reply: unknown) => {
          if (
            isRecord(reply) &&
            reply.operation === 'standalone-audit' &&
            reply.status === 'ok' &&
            reply.result === null &&
            typeof reply.id === 'number'
          )
            fault.acks.push(reply.id);
        });
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const message: unknown = args[0];
        if (isRecord(message) && typeof message.operation === 'string')
          fault.operations.push(message.operation);
        if (isControlWorkerRequest(message) && message.operation === 'standalone-audit') {
          const input = ControlStandaloneAuditInputSchema.parse(
            JSON.parse(
              readControlScalarText(ControlScalarTextSchema.parse(message.input), message.content)
            )
          );
          fault.sent.push({
            id: message.id,
            stage: input.stage,
            event: structuredClone(input.event),
          });
        }
        return super.postMessage(...args);
      }
    },
  };
});

const STAGE = 'auth.bootstrap.consume';

/** Release the SQL continuation and any observer left pending by an early operation result. */
function release() {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
  if (Atomics.compareExchange(gate, 0, 0, -1) === 0) Atomics.notify(gate, 0);
}

/** Select one actual database/action prefix; no absent request id is synthesized. */
function arm(
  coreDb: CoreDb,
  action = STAGE,
  requestId: string | null = null,
  outcome = 'succeeded',
  fail = false
) {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ path: coreDb.sqlite.name, action, requestId, outcome, fail })
  );
  const bytes = new Uint8Array(fault.target);
  if (encoded.length > bytes.length)
    throw new Error('Test target exceeds its existing descriptor.');
  bytes.fill(0);
  bytes.set(encoded);
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  Atomics.store(gate, 1, 1);
}

/** Catch outcomes without allowing credentials or request bodies into diagnostic text. */
function observed<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

/** Build fresh server state through the original bootstrap owner, never inserted fixture rows. */
async function fixture() {
  release();
  await shutdownControlStoreWorkerClient();
  fault.workers.length = 0;
  fault.operations.length = 0;
  fault.sent.length = 0;
  fault.acks.length = 0;
  new Uint8Array(fault.target).fill(0);
  const dataRoot = mkdtempSync(join(tmpdir(), 'bootstrap-lifecycle-native-'));
  const coreDb = openCoreDb(dataRoot);
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    release();
    await Promise.allSettled(pending);
    try {
      await shutdownControlStoreWorkerClient();
    } finally {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
  applyMigrations(coreDb);
  const issue = ensureServerBootstrapToken(coreDb);
  if (!issue) throw new Error('Fresh public bootstrap owner did not issue.');
  const emission = writeServerBootstrapTokenEmission(dataRoot, issue);
  const input = {
    token: issue.token,
    ownerUserId: allocateEntityId('usr'),
    displayName: 'Bootstrap test owner',
    email: ['bootstrap-owner', 'example.test'].join('@'),
    password: randomUUID(),
    tokenExpiresAt: '2999-01-01T00:00:00.000Z',
  };
  const operations = createAccessTokenOperationImplementations({ coreDb, mode: 'server' });
  const consume = () => {
    const result = operations['bootstrap.consume'](input);
    pending.push(result);
    return result;
  };
  const audits = () => listServerAuditEvents(coreDb).filter((event) => event.action === STAGE);
  const track = <T>(promise: Promise<T>) => {
    pending.push(promise);
    return promise;
  };
  const cold = async () => {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    const db = openCoreDb(dataRoot);
    try {
      db.sqlite.pragma('query_only = ON');
      return listServerAuditEvents(db).filter((event) => event.action === STAGE);
    } finally {
      db.sqlite.close();
    }
  };
  // No other producer runs here: observe all fresh Core Audits so an invented
  // ensure lifecycle action cannot hide behind the consume-action selector.
  expect(listServerAuditEvents(coreDb).length).toBe(0);
  expect(ensureServerBootstrapToken(coreDb) === null).toBe(true);
  expect(listServerAuditEvents(coreDb).length).toBe(0);
  return { dataRoot, coreDb, input, emission, consume, audits, track, cold };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Read only counts; account credentials and retained token hashes are never fetched. */
function count(
  coreDb: CoreDb,
  table: 'users' | 'account' | 'openkit_access_tokens' | 'idempotency_requests'
) {
  return (
    coreDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  ).count;
}

/** Prove the original consumed tuple exists before the later standalone Audit acknowledges. */
function consumedFacts(f: Fixture) {
  expect([
    count(f.coreDb, 'users'),
    count(f.coreDb, 'account'),
    count(f.coreDb, 'openkit_access_tokens'),
  ]).toEqual([1, 1, 1]);
  expect(f.coreDb.sqlite.prepare('SELECT id,kind FROM users').all()).toEqual([
    { id: f.input.ownerUserId, kind: 'human' },
  ]);
  expect(f.coreDb.sqlite.prepare('SELECT user_id,provider_id FROM account').all()).toEqual([
    { user_id: f.input.ownerUserId, provider_id: 'credential' },
  ]);
  expect(isServerBootstrapComplete(f.coreDb)).toBe(true);
  expect(readFileSync(f.emission.path, 'utf8').length).toBe(0);
  expect(count(f.coreDb, 'idempotency_requests')).toBe(0);
  const tokens = listOpenKitAccessTokenRecords(f.coreDb);
  expect(tokens.length).toBe(1);
  const token = tokens[0];
  if (!token) throw new Error('Original first token record is missing.');
  expect(token).toMatchObject({
    ownerUserId: f.input.ownerUserId,
    scope: 'server-admin',
    workspaceIds: [],
  });
  return token;
}

/** Validate original historical facts without printing unexpected event values on failure. */
function historical(event: AuditEvent | undefined, f: Fixture, tokenId: string) {
  if (!event) throw new Error('Original historical lifecycle Audit is missing.');
  const text = JSON.stringify(event);
  expect(
    [f.input.token, f.input.password, f.input.email].some((secret) => text.includes(secret))
  ).toBe(false);
  expect(/okt_|tokenHash|token_hash|authorization|password|credential/i.test(text)).toBe(false);
  const expected = {
    workspaceId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    capabilityCallId: null,
    permissionDecisionId: null,
    vaultGrantId: null,
    requestId: null,
    actor: null,
    subject: null,
    agentId: null,
    agentSessionId: null,
    category: 'system',
    action: STAGE,
    resource: `auth-token:${tokenId}`,
    resourceRevision: null,
    outcome: 'succeeded',
    severity: 'info',
    summary: `Bootstrap token consumed for owner ${f.input.ownerUserId}.`,
  };
  for (const [field, value] of Object.entries(expected))
    expect(Reflect.get(event, field) === value, `Historical field ${field} must be exact.`).toBe(
      true
    );
  expect(event.authentication === undefined).toBe(true);
  const prepared = fault.sent.filter((entry) => entry.event.action === STAGE);
  expect(prepared.length).toBe(1);
  const original = prepared[0];
  if (!original) throw new Error('Original native Audit preparation was not observed.');
  // Audit is a JSON projection. Remove only absent optional JS keys, as the
  // original SQL serializer does, while preserving every prepared JSON value.
  expect(
    isDeepStrictEqual(JSON.parse(JSON.stringify(event)), JSON.parse(JSON.stringify(original.event)))
  ).toBe(true);
  expect(original.stage).toBe(STAGE);
  const setting = f.coreDb.sqlite
    .prepare(
      "SELECT json_extract(value,'$.consumedAt') AS consumedAt FROM server_settings WHERE key='auth.bootstrap_token'"
    )
    .get() as { consumedAt: string };
  for (const timestamp of [event.createdAt, event.occurredAt]) {
    expect(typeof timestamp).toBe('string');
    if (typeof timestamp !== 'string') throw new Error('Historical timestamp is missing.');
    expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(Date.parse(setting.consumedAt));
    expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.now());
  }
  // The native consume tuple precedes its separate original lifecycle Audit.
  // Ignore only physical opening, which this observer already allowed.
  expect(
    isDeepStrictEqual(
      fault.operations.filter((operation) => operation !== 'open'),
      ['bootstrap-consume', 'standalone-audit']
    )
  ).toBe(true);
  return original;
}

/** A real early result defeats a missing native hold; neither refusal nor timeout gets credit. */
async function held<T>(
  f: Fixture,
  result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
  bootstrap: boolean
) {
  const gate = new Int32Array(fault.gate);
  const ready = f.track(
    Promise.resolve(Atomics.waitAsync(gate, 0, 0).value).then(() => 'held' as const)
  );
  const winner = await Promise.race([ready, result]);
  if (winner !== 'held') {
    if (winner.ok && bootstrap) {
      consumedFacts(f);
      expect(f.audits().length).toBe(1);
      expect(isRecord(winner.value) && typeof winner.value.token === 'string').toBe(true);
      throw new Error(
        'PUBLIC_OLD_EARLY_SECRET_SUCCESS: original SQL and Main lifecycle Audit completed before a native hold.'
      );
    }
    throw new Error(
      'PUBLIC_STAGE_UNREACHED: operation settled before the selected real native commit.'
    );
  }
  expect(Atomics.load(gate, 0)).toBe(1);
  expect(Atomics.load(gate, 3)).toBe(2);
  expect(Atomics.load(gate, 5)).toBe(1);
  expect(Atomics.load(gate, 6)).toBe(1);
  expect(Atomics.load(gate, 7)).toBe(1);
}

/** An existing user makes a repeat unavailable; it is not request-id replay or Audit recovery. */
async function unavailableRepeat(f: Fixture, expectedAudits: number) {
  const before = f.audits();
  const sent = fault.sent.length;
  const result = await observed(f.consume());
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatchObject({ status: 409, code: 'bootstrap_unavailable' });
  consumedFacts(f);
  expect(f.audits().length).toBe(expectedAudits);
  expect(isDeepStrictEqual(f.audits(), before)).toBe(true);
  expect(fault.sent.length).toBe(sent);
}

it('calibrates the real Core INSERT/FULL/ACK observer through published Server MCP create', async () => {
  const f = await fixture();
  const owner = await consumeServerBootstrapToken(f.coreDb, f.input);
  expect(owner.status === 'consumed').toBe(true);
  if (owner.status !== 'consumed') throw new Error('Public bootstrap control setup failed.');
  const store = new FsStore({ dataRoot: f.dataRoot });
  const implementations = createServerMcpOperationImplementations({
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store,
    inflightCommands: new WeakMap(),
  });
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: {
      kind: 'token',
      userId: f.input.ownerUserId,
      tokenId: owner.record.tokenId,
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
    },
    actorRef: { kind: 'user', id: f.input.ownerUserId },
    scope: { kind: 'server' },
  };
  const requestId = randomUUID();
  arm(f.coreDb, 'administration.server-mcp-create', requestId, 'unknown');
  let finished = false;
  const result = f.track(
    observed(
      implementations['administration.server-mcp-create'](
        {
          requestId,
          id: 'bootstrap-observer-control',
          displayName: 'Published Core control',
          allowedTools: ['echo'],
          declaration: { kind: 'http', endpoint: 'https://mcp.example.test/mcp' },
          expectedRevision: 0,
        },
        context
      )
    ).then((outcome) => {
      finished = true;
      return outcome;
    })
  );
  await held(f, result, false);
  expect(finished).toBe(false);
  const started = fault.sent.find((entry) => entry.event.requestId === requestId);
  if (!started) throw new Error('Published native control preparation is missing.');
  expect(fault.acks.includes(started.id)).toBe(false);
  expect(
    ControlStandaloneAuditInputSchema.safeParse({ stage: started.stage, event: started.event })
      .success
  ).toBe(true);
  expect(
    ControlStandaloneAuditInputSchema.safeParse({
      stage: started.stage,
      event: { ...started.event, actor: null },
    }).success
  ).toBe(false);
  release();
  expect((await result).ok).toBe(true);
  expect(fault.acks.includes(started.id)).toBe(true);
});

it.each(['success', 'audit-insert-failure', 'lost-ack'] as const)(
  'preserves the original bootstrap SQL prefix across later lifecycle Audit %s',
  async (scenario) => {
    const f = await fixture();
    arm(f.coreDb, STAGE, null, 'succeeded', scenario === 'audit-insert-failure');
    let finished = false;
    let ackBeforeReturn = false;
    const result = f.track(
      observed(f.consume()).then((outcome) => {
        finished = true;
        const original = fault.sent.find((entry) => entry.event.action === STAGE);
        ackBeforeReturn = original !== undefined && fault.acks.includes(original.id);
        return outcome;
      })
    );
    if (scenario === 'audit-insert-failure') {
      const outcome = await result;
      if (outcome.ok) {
        consumedFacts(f);
        expect(f.audits().length).toBe(1);
        throw new Error(
          'PUBLIC_OLD_EARLY_SECRET_SUCCESS: native Audit failure injection was not reached.'
        );
      }
      expect(Atomics.load(new Int32Array(fault.gate), 8)).toBe(1);
      consumedFacts(f);
      expect(f.audits().length).toBe(0);
      expect(fault.sent.filter((entry) => entry.event.action === STAGE).length).toBe(1);
      expect(ackBeforeReturn).toBe(false);
      await unavailableRepeat(f, 0);
      expect((await f.cold()).length).toBe(0);
      return;
    }
    await held(f, result, true);
    expect(finished).toBe(false);
    const token = consumedFacts(f);
    const events = f.audits();
    expect(events.length).toBe(1);
    const original = historical(events[0], f, token.tokenId);
    expect(fault.acks.includes(original.id)).toBe(false);
    if (scenario === 'lost-ack') {
      const index = Atomics.load(new Int32Array(fault.gate), 4);
      const worker = fault.workers[index];
      if (!worker) throw new Error('Actual committed native Worker was not captured.');
      await worker.terminate();
      expect((await result).ok).toBe(false);
      expect(ackBeforeReturn).toBe(false);
      expect(fault.acks.includes(original.id)).toBe(false);
      consumedFacts(f);
      expect(isDeepStrictEqual(f.audits(), events)).toBe(true);
      // Failed-host replacement is allowed only after its explicit shutdown joins.
      await shutdownControlStoreWorkerClient();
    } else {
      release();
      const outcome = await result;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('Bootstrap refused after covering Audit acknowledgement.');
      expect(ackBeforeReturn).toBe(true);
      expect(outcome.value.record.tokenId === token.tokenId).toBe(true);
      expect(
        typeof outcome.value.token === 'string' && outcome.value.token.startsWith('okt_')
      ).toBe(true);
      expect(outcome.value.token === f.input.token).toBe(false);
    }
    await unavailableRepeat(f, 1);
    expect(isDeepStrictEqual(await f.cold(), events)).toBe(true);
  }
);

it.each(['invalid', 'delivery-unavailable', 'sql-failure'] as const)(
  'does not invent a lifecycle Audit for original bootstrap %s',
  async (scenario) => {
    const f = await fixture();
    if (scenario === 'invalid') f.input.token += '-invalid';
    if (scenario === 'delivery-unavailable') {
      rmSync(f.emission.path);
      mkdirSync(f.emission.path);
    }
    if (scenario === 'sql-failure')
      // Fault the real late SQL owner on either thread; Main read-only must succeed after migration.
      f.coreDb.sqlite.exec(`CREATE TRIGGER reject_bootstrap_audit_fixture_token
        BEFORE INSERT ON openkit_access_tokens
        WHEN (SELECT COUNT(*) FROM users) = 1 AND (SELECT COUNT(*) FROM account) = 1
          AND json_extract((SELECT value FROM server_settings WHERE key='auth.bootstrap_token'), '$.consumedAt') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'Synthetic bootstrap Token SQL refusal'); END`);
    const result = await observed(f.consume());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      if (scenario !== 'sql-failure')
        expect(result.error).toMatchObject({
          status: scenario === 'invalid' ? 401 : 409,
          code: scenario === 'invalid' ? 'bootstrap_invalid' : 'bootstrap_unavailable',
        });
    }
    expect([
      count(f.coreDb, 'users'),
      count(f.coreDb, 'account'),
      count(f.coreDb, 'openkit_access_tokens'),
    ]).toEqual([0, 0, 0]);
    expect(isServerBootstrapComplete(f.coreDb)).toBe(false);
    expect(count(f.coreDb, 'idempotency_requests')).toBe(0);
    expect(f.audits().length).toBe(0);
    expect(fault.sent.length).toBe(0);
    if (scenario === 'sql-failure') {
      expect(readFileSync(f.emission.path, 'utf8').length).toBe(0);
    }
  }
);

it('admits only the exact historical bootstrap null-actor standalone exception', async () => {
  const f = await fixture();
  const owner = await consumeServerBootstrapToken(f.coreDb, f.input);
  if (owner.status !== 'consumed') throw new Error('Public bootstrap schema setup failed.');
  const event = prepareServerAuditEvent({
    coreDb: f.coreDb,
    action: STAGE,
    actor: null,
    category: 'system',
    outcome: 'succeeded',
    severity: 'info',
    resource: `auth-token:${owner.record.tokenId}`,
    summary: `Bootstrap token consumed for owner ${f.input.ownerUserId}.`,
  });
  expect(
    ControlStandaloneAuditInputSchema.safeParse({ stage: STAGE, event }).success,
    'PUBLIC_OLD_STAGE_ENUM_UNREACHED: the closed public codec does not yet admit bootstrap lifecycle Audit.'
  ).toBe(true);
  const workspaceId = allocateEntityId('ws');
  const mutants: unknown[] = [
    { stage: STAGE, event: { ...event, actor: { kind: 'user', id: f.input.ownerUserId } } },
    { stage: STAGE, workspaceId, event: { ...event, workspaceId } },
    { stage: STAGE, event: { ...event, threadId: allocateEntityId('th') } },
    { stage: STAGE, event: { ...event, turnId: allocateEntityId('tu') } },
    { stage: STAGE, event: { ...event, requestId: randomUUID() } },
    { stage: STAGE, event: { ...event, resourceRevision: 1 } },
    { stage: STAGE, event: { ...event, category: 'approval' } },
    { stage: STAGE, event: { ...event, outcome: 'failed' } },
    { stage: STAGE, event: { ...event, severity: 'warning' } },
    { stage: STAGE, event: { ...event, resource: `catalog_mcp:${owner.record.tokenId}` } },
    { stage: STAGE, event: { ...event, action: 'auth.token.issue' } },
    { stage: 'auth.bootstrap.ensure', event: { ...event, action: 'auth.bootstrap.ensure' } },
    {
      stage: STAGE,
      event: {
        ...event,
        authentication: { credentialKind: 'token', credentialId: owner.record.tokenId },
      },
    },
  ];
  expect(mutants.length).toBe(13);
  for (const [index, mutant] of mutants.entries())
    expect(
      ControlStandaloneAuditInputSchema.safeParse(mutant).success,
      `Closed bootstrap near-miss ${index}`
    ).toBe(false);
  expect(f.audits().length).toBe(0);
});
