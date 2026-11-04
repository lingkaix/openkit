import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { AppUpdateStatusResponse } from '@openkit/app-api-schemas';
import { type AuditEvent, isEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { AppUpdateHostCommand } from '../app-update/host-request.js';
import type { AppUpdateHostTransport } from '../app-update/host-transport.js';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { STANDALONE_AUDIT_STAGES } from './standalone-audit-codecs.js';

// L2: public operation admission -> original Core Audit stages -> real native FULL COMMIT.
// Core Storage, SQLite Layers, owns physical placement and acknowledgement; App Update
// Delivery, Host Lifecycle And Records, owns Audit-before-contact and the separate host effect.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  messages: [] as unknown[],
  gate: new SharedArrayBuffer(10 * Int32Array.BYTES_PER_ELEMENT),
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
        // Reuse the standalone-Audit observer: execute real COMMIT, then withhold its ACK.
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.auditGate;
          Database.prototype.exec = function(sql) {
            const result = originalExec.call(this, sql);
            if (!/^COMMIT$/i.test(sql) ||
                (Atomics.load(gate, 1) === 0 && Atomics.load(gate, 6) === 0)) return result;
            if (!this.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_events' AND type='table'").get()) return result;
            const request = Buffer.from(workerData.auditRequest).toString('ascii');
            const rows = this.prepare('SELECT action FROM audit_events WHERE request_id=?').all(request);
            const actions = ['app.update.start', 'app.update.start.handoff'];
            for (let stage = 0; stage < actions.length; stage++) {
              const base = stage * 5;
              if (rows.some(row => row.action === actions[stage]) &&
                  Atomics.compareExchange(gate, base + 1, 1, 0) === 1) {
                Atomics.store(gate, base + 3, this.pragma('synchronous', {simple:true}));
                Atomics.store(gate, base + 4, workerData.auditWorkerIndex);
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

const PREPARE_BODY = {
  expectedCurrentImageId: `sha256:${'b'.repeat(64)}`,
  source: {
    appDigest: `sha256:${'b'.repeat(64)}`,
    sourceCommit: 'a'.repeat(40),
    tag: 'v0.1.0',
  },
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

/** Select only the original request's two Audit actions; no future native input shape is assumed. */
function arm(requestId: string, stages: readonly (0 | 1)[]) {
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  new Uint8Array(fault.request).set(new TextEncoder().encode(requestId));
  for (const stage of stages) Atomics.store(gate, stage * 5 + 1, 1);
}

/** An actual early HTTP result wins over waiting for a native stage absent from the old producer. */
async function held(stage: 0 | 1, result: Promise<Response>) {
  const gate = new Int32Array(fault.gate);
  const base = stage * 5;
  const ready = Promise.resolve(Atomics.waitAsync(gate, base, 0).value).then(() => 'held');
  const outcome = await Promise.race([
    ready,
    result.then((response) => `HTTP ${response.status} before native ACK hold`),
  ]);
  expect(
    outcome,
    'The public start must reach its real native Audit COMMIT before returning.'
  ).toBe('held');
  expect(Atomics.load(gate, base)).toBe(1);
  expect(Atomics.load(gate, base + 3)).toBe(2); // Actual deciding SQLite connection uses FULL.
  return fault.workers[Atomics.load(gate, base + 4)]!;
}

/** Compose canonical Core identity and the public operation engine with only the external host doubled. */
async function fixture(options: { server?: boolean; refuseStart?: boolean } = {}) {
  release(0);
  release(1);
  const dataRoot = mkdtempSync(join(tmpdir(), 'app-update-standalone-audit-'));
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
  const admin = options.server
    ? createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: userId,
        scope: 'server-admin',
        workspaceIds: [],
      })
    : undefined;
  const commands: AppUpdateHostCommand[] = [];
  let receipt: AppUpdateStatusResponse | undefined;
  const transport: AppUpdateHostTransport = {
    async invoke(command) {
      commands.push(command);
      if (command.op === 'prepare') {
        const preparedAt = new Date().toISOString();
        receipt = {
          helperSha256: 'c'.repeat(64),
          preparedHelperSha256: 'c'.repeat(64),
          approvalSummary: {
            targetRelease: command.source,
            expectedCurrentImageId: command.expectedCurrentImageId,
            observedCurrentImageId: command.expectedCurrentImageId,
            interruptionScope: 'NanoCore and Web interruption.',
            safetyEvidence: {
              deploymentBindings: true,
              preflight: {
                observedAt: preparedAt,
                workspaceCount: 1,
                state: 'idle',
                counts: {
                  runningTurns: 0,
                  pendingTurns: 0,
                  queuedAdmissions: 0,
                  openAttempts: 0,
                  closingAttempts: 0,
                  inFlightCommands: 0,
                },
              },
            },
            recoveryLimitations: ['No rollback across migrations.'],
          },
          candidateBoot: null,
          candidateImageId: null,
          completedAt: null,
          error: null,
          expectedCurrentImageId: command.expectedCurrentImageId,
          jobId: null,
          outcome: 'prepared',
          predicates: null,
          preparedAt,
          previousAppRestored: null,
          previousBoot: null,
          previousImageId: null,
          requestId: randomUUID(),
          source: command.source,
          stage: 'prepared',
          startedAt: null,
        };
        return { ok: true, status: receipt };
      }
      if (!receipt || command.requestId !== receipt.requestId)
        return {
          ok: false,
          code: 'app_update_recovery_required',
          message: 'App-update receipt is missing.',
        };
      if (command.op === 'start') {
        if (options.refuseStart)
          return {
            ok: false,
            code: 'app_update_busy',
            message: 'An App update is already running.',
          };
        receipt = {
          ...receipt,
          jobId: `job_${receipt.requestId}`,
          outcome: 'running',
          stage: 'launching',
          startedAt: new Date().toISOString(),
        };
      }
      return { ok: true, status: receipt };
    },
  };
  const signedOutAuth: BetterAuthServer = {
    api: { getSession: async () => null },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
  // Await is valid for this published synchronous fixture and Attention's pending async preparation.
  const app = await createApp({
    coreDb,
    dataRoot,
    appUpdateHostTransport: transport,
    ...(options.server ? { mode: 'server' as const, auth: signedOutAuth } : {}),
  });
  const headers = admin ? { authorization: `Bearer ${admin.secret}` } : {};
  const prepared = await app.request(
    ...operationRequest('app-update.prepare', {}, { headers, body: JSON.stringify(PREPARE_BODY) })
  );
  expect(prepared.status).toBe(200);
  const review = (await prepared.json()) as { requestId: string; source: unknown; stage: string };
  expect(review.source).toEqual(PREPARE_BODY.source);
  expect(review.stage).toBe('prepared');
  expect(review.requestId).toBe(receipt!.requestId);
  const requestId = review.requestId;
  const rows = () => ({
    audits: coreDb.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY audit_event_id')
      .all(requestId),
    receipts: coreDb.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(requestId),
  });
  return {
    coreDb,
    userId,
    requestId,
    admin,
    commands,
    rows,
    events: () => listServerAuditEvents(coreDb).filter((event) => event.requestId === requestId),
    start() {
      pending = Promise.resolve(
        app.request(
          ...operationRequest(
            'app-update.start',
            {},
            { headers, body: JSON.stringify({ requestId, maintenanceConsent: true }) }
          )
        )
      );
      return pending;
    },
    async coldRows() {
      await shutdownControlStoreWorkerClient();
      const cold = openCoreDb(dataRoot);
      try {
        cold.sqlite.pragma('query_only = ON');
        expect(cold.sqlite.pragma('query_only', { simple: true })).toBe(1);
        return {
          audits: cold.sqlite
            .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY audit_event_id')
            .all(requestId),
          receipts: cold.sqlite
            .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
            .all(requestId),
        };
      } finally {
        cold.sqlite.close();
      }
    },
  };
}

/** Original Audit values come from the published producer, independently of its future native codec. */
function expectOriginal(
  event: AuditEvent,
  requestId: string,
  userId: string,
  action: 'app.update.start' | 'app.update.start.handoff',
  failed = false
) {
  expect(event).toEqual({
    id: expect.any(String),
    workspaceId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    capabilityCallId: null,
    permissionDecisionId: null,
    vaultGrantId: null,
    requestId,
    actor: { kind: 'user', id: userId },
    subject: null,
    agentId: null,
    agentSessionId: null,
    category: 'system',
    action,
    resource: `app-update:${requestId}`,
    resourceRevision: null,
    outcome: failed ? 'failed' : 'succeeded',
    severity: failed ? 'error' : 'info',
    summary:
      action === 'app.update.start'
        ? 'Authorized App-update start request was accepted.'
        : failed
          ? 'App-update start host handoff did not return a receipt.'
          : 'App-update start host handoff returned a receipt.',
    errorCode: failed ? 'app_update_busy' : null,
    createdAt: expect.any(String),
    occurredAt: expect.any(String),
  });
  expect(isEntityId('aud', event.id)).toBe(true);
  expect(Number.isFinite(Date.parse(event.createdAt))).toBe(true);
  expect(Number.isFinite(Date.parse(event.occurredAt))).toBe(true);
}

it('keeps both original Core stages native and FULL-acknowledged before contact and public success', async () => {
  const f = await fixture();
  f.coreDb.sqlite.pragma('query_only = ON');
  expect(f.coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
  arm(f.requestId, [0, 1]);
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
  await held(0, result);
  expect(settled).toBe(false);
  expect(f.commands.filter((command) => command.op === 'start')).toEqual([]);
  expect(f.events()).toHaveLength(1);
  const admission = f.events()[0]!;
  expectOriginal(admission, f.requestId, f.userId, 'app.update.start');
  expect(f.rows().receipts).toEqual([]);
  release(0);
  await held(1, result);
  expect(settled).toBe(false);
  expect(f.commands.filter((command) => command.op === 'start')).toEqual([
    { op: 'start', requestId: f.requestId, maintenanceConsent: true },
  ]);
  expect(f.events()).toHaveLength(2);
  expect(f.events().find((event) => event.action === 'app.update.start')).toEqual(admission);
  const handoff = f.events().find((event) => event.action === 'app.update.start.handoff')!;
  expectOriginal(handoff, f.requestId, f.userId, 'app.update.start.handoff');
  release(1);
  const response = await result;
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    requestId: f.requestId,
    jobId: `job_${f.requestId}`,
    stage: 'launching',
    outcome: 'running',
  });
  expect(f.commands.filter((command) => command.op === 'start').length).toBe(1);
  const events = f.events();
  expect(events).toEqual(expect.arrayContaining([admission, handoff]));
  expect(new Set(events.map((event) => event.id)).size).toBe(2);
  const original = f.rows();
  expect(original.receipts).toEqual([]); // Both original commits are Audit-only, without a receipt.
  expect(await f.coldRows()).toEqual(original);
  expect([...STANDALONE_AUDIT_STAGES].sort()).toEqual([
    'administration.server-mcp-create',
    'administration.server-mcp-remove',
    'administration.server-mcp-select-version',
    'administration.server-mcp-stage-version',
    'administration.server-mcp-update-binding',
    'app.update.start',
    'app.update.start.handoff',
    'auth.bootstrap.consume',
    'catalog.light-app-history-import',
    'catalog.light-app-import',
    'catalog.light-app-pin',
    'catalog.light-app-select',
    'catalog.mcp-binding',
    'catalog.mcp-create',
    'catalog.mcp-remove',
    'catalog.mcp-select',
    'catalog.mcp-stage-version',
    'catalog.plugin-import',
    'catalog.skill-candidate-decide',
    'catalog.skill-candidate-decide.admit',
    'catalog.skill-candidate-submit',
    'catalog.skill-candidate-submit.admit',
    'catalog.skill-candidate-withdraw',
    'catalog.skill-candidate-withdraw.admit',
    'data_source_catalog.authority.update',
  ]);
});

it.each([
  0, 1,
] as const)('lost original stage %i FULL ACK preserves its prefix without host replay', async (stage) => {
  const f = await fixture({ refuseStart: stage === 1 });
  arm(f.requestId, [stage]);
  const result = f.start();
  const worker = await held(stage, result);
  const prefix = f.rows();
  expect(prefix.audits).toHaveLength(stage + 1);
  expect(prefix.receipts).toEqual([]);
  const events = f.events();
  expectOriginal(
    events.find((event) => event.action === 'app.update.start')!,
    f.requestId,
    f.userId,
    'app.update.start'
  );
  if (stage === 1)
    expectOriginal(
      events.find((event) => event.action === 'app.update.start.handoff')!,
      f.requestId,
      f.userId,
      'app.update.start.handoff',
      true
    );
  expect(f.commands.filter((command) => command.op === 'start').length).toBe(stage);
  const posts = fault.messages.length;
  const workers = fault.workers.length;
  await worker.terminate(); // Exact owner recorded at the selected real COMMIT, never workers.at(-1).
  const response = await result;
  expect(response.status).toBe(500); // Existing HTTP boundary for an unclassified unknown native error.
  expect(f.commands.filter((command) => command.op === 'start').length).toBe(stage);
  expect(fault.messages.length).toBe(posts);
  expect(fault.workers.length).toBe(workers);
  expect(f.rows()).toEqual(prefix);
  expect(await f.coldRows()).toEqual(prefix);
});

it('rechecks the actual administrator token after the first Audit ACK and before host contact', async () => {
  const f = await fixture({ server: true });
  arm(f.requestId, [0]);
  const result = f.start();
  await held(0, result);
  expect(f.events()).toHaveLength(1);
  expectOriginal(f.events()[0]!, f.requestId, f.userId, 'app.update.start');
  const prefix = f.rows();
  expect(prefix.receipts).toEqual([]);
  expect(f.commands.filter((command) => command.op === 'start')).toEqual([]);
  revokeOpenKitAccessTokenRecord(f.coreDb, f.admin!.tokenId);
  expect(getOpenKitAccessTokenRecord(f.coreDb, f.admin!.tokenId)?.status).toBe('revoked');
  const posts = fault.messages.length;
  const workers = fault.workers.length;
  release(0);
  const response = await result;
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: 'deployment_admin_required' });
  expect(f.commands.filter((command) => command.op === 'start')).toEqual([]);
  expect(fault.messages.length).toBe(posts);
  expect(fault.workers.length).toBe(workers);
  expect(f.rows()).toEqual(prefix);
  expect(await f.coldRows()).toEqual(prefix);
});
