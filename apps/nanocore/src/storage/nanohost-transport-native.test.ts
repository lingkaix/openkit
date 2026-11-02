import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type ClientHttp2Session, connect, createServer, type Http2Server } from 'node:http2';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { createNanoHostOperationImplementations } from '../auth/nanohost-operations.js';
import { admitNanoHostTransportConnection } from '../auth/nanohost-transport-admission.js';
import { revokeNanoHostTransportTokenAndFence } from '../auth/nanohost-transport-lifecycle.js';
import transportRevision from '../auth/nanohost-transport-revision.json' with { type: 'json' };
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import {
  deliverNanoHostTransportTokenToNamedSlot,
  readNanoHostCredentialSlotTokenId,
} from '../auth/nanohost-transport-sink.js';
import {
  completeNanoHostTransportTokenCutover,
  createNanoHostTransportTokenRecord,
  getNanoHostTransportTokenRecord,
  verifyNanoHostTransportTokenRecord,
} from '../auth/nanohost-transport-token-store.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { createOperationEngine } from '../operation-invocation.js';
import {
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import type { ControlWorkerReply } from './control-store-worker-protocol.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  replies: [] as Array<() => void>,
  gate: undefined as SharedArrayBuffer | undefined,
  lostReply: false,
}));

// Intercept actual SQLite boundaries in the real native thread, never the product writer.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0] as { operation?: string; status?: string } | undefined;
        const gate = interception.gate && new Int32Array(interception.gate);
        if (
          event === 'message' &&
          (message?.operation === 'nanohost-transport' ||
            message?.operation === 'runtime-target') &&
          message.status === 'ok' &&
          gate &&
          Atomics.load(gate, 3) === 5 &&
          Atomics.load(gate, 2) === Atomics.load(gate, 4) &&
          Atomics.compareExchange(gate, 0, 0, 1) === 0
        ) {
          // Hold only this actual Main delivery; the real Worker can finish a later request.
          interception.replies.push(() => {
            super.emit(event, ...args);
          });
          return true;
        }
        return super.emit(event, ...args);
      }
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const require = createRequire(import.meta.url);
        const prelude = `
          const {workerData, parentPort} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.gate;
          function hold(point, ordinal) {
            if (Atomics.load(gate, 3) === point && Atomics.load(gate, 4) === ordinal &&
                Atomics.compareExchange(gate, 0, 0, 1) === 0)
              Atomics.wait(gate, 1, 0);
          }
          parentPort.on('message', value => {
            if (value.operation === 'nanohost-transport') Atomics.add(gate, 6, 1);
          });
          const originalPost = parentPort.postMessage.bind(parentPort);
          parentPort.postMessage = function(value, ...args) {
            if (value.operation === 'open' && value.status === 'ok') hold(4, 0);
            return originalPost(value, ...args);
          };
          Database.prototype.exec = function(sql) {
            const ordinal = Atomics.load(gate, 2) + 1;
            if (/^BEGIN(?:\\s|$)/i.test(sql)) hold(3, ordinal);
            if (/^COMMIT$/i.test(sql)) {
              Atomics.store(gate, 5, this.pragma('synchronous', {simple: true}));
              hold(1, ordinal);
            }
            const result = originalExec.call(this, sql);
            if (/^COMMIT$/i.test(sql)) {
              Atomics.add(gate, 2, 1);
              hold(2, ordinal);
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
            databaseModule: require.resolve('better-sqlite3'),
            gate: new Int32Array(interception.gate!),
          },
        });
        interception.workers.push(this);
      }
    },
  };
});

const fixtures: Array<{
  close(): void;
  closeConnections(): Promise<void>;
  joinOperations(): Promise<void>;
  mainWrites(): number;
}> = [];
const identityId = 'integration_nanohost_native';
const deploymentId = 'dep_00000000-0000-7bdd-bdc3-910a52eaec87';
const administratorId = 'usr_00000000-0000-768a-8658-44c33d82c1f5';
const clock = new Date('2026-08-08T00:00:00.000Z');
const expiresAt = '2999-01-01T00:00:00.000Z';

/** Real Core owner with retained synthetic setup before Main mutation denial. */
async function fixture(options: { enrolled?: boolean; open?: boolean; authority?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nanohost-native-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  if (options.enrolled !== false)
    db.sqlite
      .prepare(
        `INSERT INTO nanohost_integration_identities
       (identity_id, deployment_id, status, created_at) VALUES (?, ?, 'active', ?)`
      )
      .run(identityId, deploymentId, clock.toISOString());
  db.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, image, created_at, updated_at, kind, last_seen_at)
    VALUES (?, 'Native Administrator', ?, false, NULL, ?, ?, 'human', NULL)`)
    .run(administratorId, administratorId + '@' + 'example.invalid', Date.now(), Date.now());
  const admin = createOpenKitAccessTokenRecord(db, {
    ownerUserId: administratorId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt,
  });
  const actor: Actor = {
    kind: 'token',
    userId: administratorId,
    tokenId: admin.tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
  };
  const authority = createNanoHostTransportSessionAuthority();
  const slots = {
    A: { secretPath: join(root, 'A.token'), companionPath: join(root, 'A.meta') },
    B: { secretPath: join(root, 'B.token'), companionPath: join(root, 'B.meta') },
  };
  const config = {
    identityId,
    deploymentId,
    credentialRef: 'nanohost-transport:primary',
    credentialSlots: slots,
    bind: { host: '127.0.0.1', port: 4318 },
    rendezvousUrl: 'http://127.0.0.1',
  };
  const implementations = createNanoHostOperationImplementations({
    coreDb: db,
    mode: 'server',
    nanoHostConfig: config,
    ...(options.authority === false ? {} : { sessionAuthority: authority }),
  });
  const invoke = createOperationEngine(implementations, { coreDb: db, dataRoot: root });
  const pendingOperations = new Set<Promise<void>>();
  // Join the entire public handler, including later compensation/Audit, on failed assertions.
  function track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined
    );
    pendingOperations.add(settled);
    void settled.then(() => pendingOperations.delete(settled));
    return operation;
  }
  const op = <K extends keyof typeof implementations>(
    id: K,
    value: unknown,
    currentActor: Actor = actor
  ) => track(invoke(id, value, { kind: 'public', actor: currentActor }));
  const connections: Array<{ client: ClientHttp2Session; server: Http2Server; physical: object }> =
    [];
  interception.gate = new SharedArrayBuffer(28);
  const gate = new Int32Array(interception.gate);
  const originalPrepare = Database.prototype.prepare;
  const originalExec = Database.prototype.exec;
  let mainWrites = 0;
  const deny = (sql: string) => {
    if (
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql) &&
      /\b(?:nanohost_transport_tokens|nanohost_integration_identities|audit_events)\b/iu.test(sql)
    ) {
      mainWrites++;
      throw new Error('NanoHost credential mutation executed on Main.');
    }
  };
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    deny(sql);
    return originalPrepare.call(this, sql);
  });
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    deny(sql);
    return originalExec.call(this, sql);
  });
  fixtures.push({
    mainWrites: () => mainWrites,
    async joinOperations() {
      while (pendingOperations.size > 0) await Promise.all([...pendingOperations]);
    },
    async closeConnections() {
      db.sqlite.exec(
        'DROP TRIGGER IF EXISTS native_failure; DROP TRIGGER IF EXISTS readiness_refusal;'
      );
      try {
        await authority.closeAllPhysicalConnections();
      } catch (error) {
        // A deliberately killed native host cannot acknowledge its physical-close publication.
        // Keep that failure observable; only this fixture's explicit lost-reply cut allows it.
        if (!interception.lostReply) throw error;
        expect(error).toBeInstanceOf(AggregateError);
        for (const cause of (error as AggregateError).errors) {
          expect(cause).toBeInstanceOf(ControlStoreWorkerError);
          expect(cause).toMatchObject({ code: 'unavailable', commit: 'not-committed' });
        }
      }
      for (const connection of connections) {
        connection.client.destroy();
        (connection.physical as { destroy(): void }).destroy();
        if (connection.server.listening)
          await new Promise<void>((resolve) => connection.server.close(() => resolve()));
      }
    },
    close() {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  const client = getControlStoreWorkerClient();
  const scope = nativeProductScope(root, { kind: 'server' });
  if (options.open !== false)
    await client.open({
      database: `core:${scope.path}`,
      path: scope.path,
      create: false,
      initialize: 'core',
      dataRoot: root,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
  return {
    db,
    gate,
    root,
    actor,
    admin,
    authority,
    slots,
    op,
    track,
    client,
    config,
    database: `core:${scope.path}`,
    async physical() {
      let accept!: (value: object) => void;
      const accepted = new Promise<object>((resolve) => {
        accept = resolve;
      });
      const server = createServer((request, response) => {
        const physical = readNanoHostPhysicalConnectionContext(request);
        if (!physical) throw new Error('Synthetic native HTTP/2 context was not accepted.');
        accept(physical);
        response.end('ok');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Synthetic listener did not bind.');
      const client = connect(`http://127.0.0.1:${address.port}`);
      const request = client.request({ ':path': '/' });
      request.resume();
      request.end();
      const physical = await accepted;
      await once(request, 'end');
      connections.push({ client, server, physical });
      return physical;
    },
    fixtureSql: (sql: string): Database.Statement => originalPrepare.call(db.sqlite, sql),
    commits: () => Atomics.load(gate, 2),
  };
}

function release(gate: Int32Array): void {
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  for (const deliver of interception.replies.splice(0)) deliver();
}

afterEach(async () => {
  if (interception.gate) release(new Int32Array(interception.gate));
  for (const f of fixtures) await f.joinOperations();
  for (const f of fixtures) await f.closeConnections();
  await shutdownControlStoreWorkerClient();
  for (const worker of interception.workers.splice(0)) await worker.terminate();
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    const writes = f.mainWrites();
    f.close();
    expect(writes).toBe(0);
  }
  interception.gate = undefined;
  interception.lostReply = false;
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Arms actual SQL, open reply, or Main ACK delivery without a product callback. */
function arm(f: Fixture, point: 1 | 2 | 3 | 4 | 5, ordinal = f.commits() + 1): void {
  Atomics.store(f.gate, 0, 0);
  Atomics.store(f.gate, 1, 0);
  Atomics.store(f.gate, 3, point);
  Atomics.store(f.gate, 4, point === 4 ? 0 : ordinal);
}
async function held<T>(f: Fixture, work: () => Promise<T>) {
  let settled = false;
  const result = Promise.resolve()
    .then(work)
    .then(
      (value) => {
        settled = true;
        return { ok: true as const, value };
      },
      (error) => {
        settled = true;
        return { ok: false as const, error };
      }
    );
  f.track(result);
  while (Atomics.load(f.gate, 0) === 0 && !settled) await nextTurn();
  expect(Atomics.load(f.gate, 0)).toBe(1);
  expect(settled).toBe(false);
  return { result, settled: () => settled };
}
async function loseReply(): Promise<void> {
  const worker = interception.workers.at(-1);
  expect(worker).toBeDefined();
  interception.lostReply = true;
  await worker!.terminate();
}
function tokens(f: Fixture) {
  return f.db.sqlite
    .prepare(`SELECT token_id, owner_nanohost_identity_id, deployment_id, status,
    issued_at, expires_at, predecessor_token_id, rotation_overlap_expires_at, revoked_at,
    last_used_at, last_used_channel, last_used_source FROM nanohost_transport_tokens ORDER BY token_id`)
    .all();
}
function identities(f: Fixture) {
  return f.db.sqlite
    .prepare(
      'SELECT identity_id, deployment_id, status, created_at, decommissioned_at FROM nanohost_integration_identities ORDER BY identity_id'
    )
    .all();
}
function audits(f: Fixture): number {
  return f.db.sqlite.prepare('SELECT count(*) FROM audit_events').pluck().get() as number;
}
function count(f: Fixture): number {
  return f.db.sqlite
    .prepare('SELECT count(*) FROM nanohost_transport_tokens')
    .pluck()
    .get() as number;
}
function slotPresent(f: Fixture, slot: 'A' | 'B'): boolean {
  return existsSync(f.slots[slot].secretPath) && existsSync(f.slots[slot].companionPath);
}
function slotSecret(f: Fixture, slot: 'A' | 'B'): string {
  return readFileSync(f.slots[slot].secretPath, 'utf8');
}
function blockSlot(f: Fixture, slot: 'A' | 'B'): void {
  rmSync(f.slots[slot].secretPath, { force: true });
  mkdirSync(f.slots[slot].secretPath);
}
function fault(f: Fixture, table: string, event: string, condition = ''): void {
  // Deliberate owning-table fault after successful real setup; never enters a product command.
  f.fixtureSql(`CREATE TRIGGER native_failure BEFORE ${event} ON ${table} ${condition}
    BEGIN SELECT RAISE(ABORT, 'synthetic native stage refusal'); END`).run();
}
async function issue(f: Fixture) {
  return await createNanoHostTransportTokenRecord(f.db, {
    deploymentId,
    expiresAt,
    now: clock,
    ownerNanoHostIdentityId: identityId,
    responsibleServerAdminActorId: administratorId,
  });
}
async function issueSlot(f: Fixture) {
  return await f.op('nanohost.token-issue', { targetSlot: 'A', expiresAt });
}
async function rotation(f: Fixture) {
  const first = await issueSlot(f);
  const rotated = await f.op('nanohost.token-rotate', {
    tokenId: first.record.tokenId,
    overlapSeconds: 3600,
  });
  return { first, rotated };
}
async function admitted(f: Fixture, secret: string, physical?: object) {
  const connection = physical ?? (await f.physical());
  const result = await admitNanoHostTransportConnection(f.db, f.authority, {
    secret,
    physicalConnection: connection,
    transportRevision: String(transportRevision),
  });
  expect(result.ok).toBe(true);
  expect(f.authority.mayCarryWork(connection)).toBe(true);
  return connection;
}
async function foreignAuthority(f: Fixture) {
  const foreignIdentity = 'integration_nanohost_foreign';
  f.fixtureSql(`INSERT INTO nanohost_integration_identities (identity_id, deployment_id, status, created_at)
    VALUES (?, 'deploy_foreign', 'active', ?)`).run(foreignIdentity, clock.toISOString());
  const token = await createNanoHostTransportTokenRecord(f.db, {
    deploymentId: 'deploy_foreign',
    expiresAt,
    ownerNanoHostIdentityId: foreignIdentity,
    responsibleServerAdminActorId: administratorId,
  });
  const physical = await f.physical();
  // Process-authority negative control: generation 1 is trusted synthetic input at this owner seam.
  // This does not admit a second configured RuntimeTarget or prove durable generation allocation.
  const session = f.authority.admit({
    identityId: foreignIdentity,
    connectionGeneration: 1,
    physicalConnection: physical,
  });
  expect(session.role).toBe('authoritative');
  expect(f.authority.mayCarryWork(physical)).toBe(true);
  return { physical, token };
}
async function failed(work: Promise<unknown>): Promise<void> {
  const outcome = await work.then(
    () => true,
    () => false
  );
  expect(outcome).toBe(false);
}

describe('NanoHost native credential ownership', () => {
  it('allocates once for concurrent admission on the same real physical connection and keeps its winner ready', async () => {
    const f = await fixture();
    const issued = await issue(f);
    const physical = await f.physical();
    const posted = vi.spyOn(interception.workers.at(-1)!, 'postMessage');
    const allocatePosts = () =>
      posted.mock.calls.filter(([message]) => {
        const request = message as { operation?: string; input?: { kind?: string } };
        return request.operation === 'runtime-target' && request.input?.kind === 'allocate';
      }).length;
    const admit = () =>
      admitNanoHostTransportConnection(f.db, f.authority, {
        secret: issued.secret,
        physicalConnection: physical,
        transportRevision: String(transportRevision),
      });
    // Token verification commits first; hold the real allocation's covering ACK on Main.
    arm(f, 5, f.commits() + 2);
    const winner = await held(f, admit);
    expect(allocatePosts()).toBe(1);
    expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
    expect(getNanoHostRuntimeTarget(f.db, identityId)?.connectionGeneration).toBe(1);
    const loser = await f.track(admit());
    // NanoHost Runtime And Transport: a concurrent same-physical loser cannot consume high-water.
    expect(loser).toEqual({ ok: false, reason: 'rejected' });
    expect(allocatePosts()).toBe(1);
    expect(winner.settled()).toBe(false);
    expect(getNanoHostRuntimeTarget(f.db, identityId)?.connectionGeneration).toBe(1);
    release(f.gate);
    const accepted = await winner.result;
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        ok: true,
        connectionGeneration: 1,
        role: 'authoritative',
        mayCarryWork: true,
      },
    });
    expect(f.authority.mayCarryWork(physical)).toBe(true);
    const ready = await upsertNanoHostRuntimeTarget(f.db, {
      targetId: identityId,
      identityId,
      deploymentId,
      connectionGeneration: 1,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      physicalEpoch: 'a'.repeat(64),
      observedAt: new Date().toISOString(),
    });
    expect(ready).toMatchObject({
      connectionGeneration: 1,
      ready: true,
      physicalEpoch: 'a'.repeat(64),
    });
    expect(getNanoHostRuntimeTarget(f.db, identityId)).toEqual(ready);
    expect(allocatePosts()).toBe(1);
  });

  it.each([
    'refused',
    'unknown',
  ] as const)('requires a fresh physical connection after %s allocation without inventing a session', async (kind) => {
    const f = await fixture();
    const issued = await issue(f);
    const physical = await f.physical();
    const admit = (connection: object) =>
      admitNanoHostTransportConnection(f.db, f.authority, {
        secret: issued.secret,
        physicalConnection: connection,
        transportRevision: String(transportRevision),
      });
    if (kind === 'refused') fault(f, 'nanohost_runtime_targets', 'INSERT');
    if (kind === 'unknown') {
      arm(f, 5, f.commits() + 2);
      const pending = await held(f, () => admit(physical));
      expect(getNanoHostRuntimeTarget(f.db, identityId)?.connectionGeneration).toBe(1);
      expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
      await loseReply();
      const outcome = await pending.result;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ commit: 'unknown' });
      release(f.gate);
      // The native writer owner requires explicit shutdown after host loss; this is no request replay.
      await shutdownControlStoreWorkerClient();
    } else {
      await failed(f.track(admit(physical)));
      expect(getNanoHostRuntimeTarget(f.db, identityId)).toBeNull();
      f.fixtureSql('DROP TRIGGER native_failure').run();
    }
    expect(f.authority.connectionGeneration(physical)).toBeNull();
    expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
    expect(f.authority.mayCarryWork(physical)).toBe(false);
    const beforeReplay = getNanoHostRuntimeTarget(f.db, identityId);
    expect(await f.track(admit(physical))).toEqual({ ok: false, reason: 'rejected' });
    expect(getNanoHostRuntimeTarget(f.db, identityId)).toEqual(beforeReplay);
    const fresh = await f.physical();
    expect(fresh).not.toBe(physical);
    expect(await f.track(admit(fresh))).toMatchObject({
      ok: true,
      role: 'authoritative',
      mayCarryWork: true,
      connectionGeneration: kind === 'unknown' ? 2 : 1,
    });
    expect(f.authority.mayCarryWork(physical)).toBe(false);
    expect(f.authority.mayCarryWork(fresh)).toBe(true);
  });

  it('joins the physical close native acknowledgement before shutting down its worker', async () => {
    const f = await fixture();
    const issued = await issue(f);
    const physical = await admitted(f, issued.secret);
    await upsertNanoHostRuntimeTarget(f.db, {
      targetId: identityId,
      identityId,
      deploymentId,
      connectionGeneration: 1,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      physicalEpoch: 'a'.repeat(64),
      observedAt: new Date().toISOString(),
    });
    arm(f, 5);
    const close = await held(f, () =>
      Promise.resolve(f.authority.closePhysicalConnection(physical))
    );
    expect(f.authority.mayCarryWork(physical)).toBe(false);
    expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
    expect(getNanoHostRuntimeTarget(f.db, identityId)).toMatchObject({
      connectionGeneration: 1,
      ready: false,
    });
    const posted = vi.spyOn(interception.workers.at(-1)!, 'postMessage');
    const completions: string[] = [];
    void close.result.then(() => completions.push('close'));
    let stopped = false;
    const shutdown = f.track(shutdownControlStoreWorkerClient()).then(() => {
      stopped = true;
      completions.push('shutdown');
    });
    // The accepted close producer must join before shutdown is posted, not merely before its reply.
    expect(
      posted.mock.calls.some(
        ([message]) => (message as { operation?: string }).operation === 'shutdown'
      )
    ).toBe(false);
    expect(close.settled()).toBe(false);
    expect(stopped).toBe(false);
    release(f.gate);
    expect(await close.result).toMatchObject({
      ok: true,
      value: {
        identityId,
        closedGeneration: 1,
        authoritativeGeneration: null,
      },
    });
    await shutdown;
    expect(stopped).toBe(true);
    expect(completions).toEqual(['close', 'shutdown']);
    expect(getNanoHostRuntimeTarget(f.db, identityId)).toMatchObject({
      connectionGeneration: 1,
      ready: false,
    });
  });

  it('issues NanoHost transport credentials with Main Core mutations denied', async () => {
    const f = await fixture({ enrolled: false });
    expect(interception.workers).toHaveLength(1);
    const enrolled = await f.op('nanohost.enroll', { targetSlot: 'A', expiresAt });
    expect(f.commits()).toBe(2);
    expect(Atomics.load(f.gate, 5)).toBe(2);
    expect(getNanoHostTransportTokenRecord(f.db, enrolled.record.tokenId)).toEqual(enrolled.record);
    const oldSecret = slotSecret(f, 'A');
    expect((await verifyNanoHostTransportTokenRecord(f.db, oldSecret))?.tokenId).toBe(
      enrolled.record.tokenId
    );
    const rotated = await f.op('nanohost.token-rotate', {
      tokenId: enrolled.record.tokenId,
      overlapSeconds: 3600,
    });
    expect(rotated.rotatedRecord.status).toBe('rotated');
    const aborted = await f.op('nanohost.token-rotation-abort', {
      tokenId: rotated.record.tokenId,
    });
    expect(aborted.predecessor.status).toBe('active');
    expect(aborted.successor.status).toBe('revoked');
    expect(slotPresent(f, 'A')).toBe(true);
    expect(slotPresent(f, 'B')).toBe(false);
    await completeNanoHostTransportTokenCutover(f.db, enrolled.record.tokenId, { now: clock });
    expect((await verifyNanoHostTransportTokenRecord(f.db, oldSecret)) === null).toBe(true);
    await f.op('nanohost.token-revoke', { tokenId: enrolled.record.tokenId });
    const next = await issueSlot(f);
    const foreign = await foreignAuthority(f);
    const decommissioned = await f.op('nanohost.decommission', {});
    expect(decommissioned.revokedTokenCount).toBe(1);
    expect(getNanoHostTransportTokenRecord(f.db, next.record.tokenId)?.status).toBe('revoked');
    expect(f.authority.mayCarryWork(foreign.physical)).toBe(true);
    expect(getNanoHostTransportTokenRecord(f.db, foreign.token.tokenId)?.status).toBe('active');
    expect(slotPresent(f, 'A')).toBe(false);
    expect(slotPresent(f, 'B')).toBe(false);
    expect(audits(f)).toBe(5);
    expect(JSON.stringify(enrolled).includes(oldSecret)).toBe(false);
    expect(f.db.sqlite.prepare('SELECT COUNT(*) FROM idempotency_requests').pluck().get()).toBe(0);
  });

  it.each([
    'enroll',
    'rotate',
    'abort',
    'decommission',
  ] as const)('rolls back the entire %s tuple on a real later SQL fault', async (kind) => {
    const f = await fixture({ enrolled: kind !== 'enroll' });
    let action: () => Promise<unknown>;
    if (kind === 'enroll') {
      fault(f, 'nanohost_transport_tokens', 'INSERT');
      action = () => f.op('nanohost.enroll', { targetSlot: 'A', expiresAt });
    } else if (kind === 'rotate') {
      const first = await issueSlot(f);
      fault(f, 'nanohost_transport_tokens', 'INSERT');
      action = () =>
        f.op('nanohost.token-rotate', { tokenId: first.record.tokenId, overlapSeconds: 3600 });
    } else if (kind === 'abort') {
      const { first, rotated } = await rotation(f);
      fault(
        f,
        'nanohost_transport_tokens',
        'UPDATE',
        `WHEN NEW.token_id = '${first.record.tokenId}' AND NEW.status = 'active'`
      );
      action = () => f.op('nanohost.token-rotation-abort', { tokenId: rotated.record.tokenId });
    } else {
      await rotation(f);
      fault(f, 'nanohost_integration_identities', 'UPDATE');
      action = () => f.op('nanohost.decommission', {});
    }
    const before = {
      tokens: tokens(f),
      identities: identities(f),
      audits: audits(f),
      commits: f.commits(),
    };
    const failureReplies: ControlWorkerReply[] = [];
    interception.workers.at(-1)!.on('message', (reply: ControlWorkerReply) => {
      if (reply.status === 'error') failureReplies.push(reply);
    });
    await failed(action());
    expect(failureReplies).toEqual([
      expect.objectContaining({ status: 'error', commit: 'not-committed' }),
    ]);
    expect(tokens(f)).toEqual(before.tokens);
    expect(identities(f)).toEqual(before.identities);
    expect(audits(f)).toBe(before.audits);
    // The command savepoint rolls back; its containing failure batch still commits FULL.
    expect(f.commits()).toBe(before.commits + 1);
    expect(Atomics.load(f.gate, 5)).toBe(2);
    expect(slotPresent(f, 'A')).toBe(kind !== 'enroll');
    expect(slotPresent(f, 'B')).toBe(kind === 'abort' || kind === 'decommission');
  });

  it.each([
    'enroll',
    'issue',
    'verify',
    'revoke',
    'rotate',
    'abort',
    'decommission',
  ] as const)('holds %s success and its later effects behind the real FULL COMMIT', async (kind) => {
    const f = await fixture({ enrolled: kind !== 'enroll' });
    let action: () => Promise<unknown>;
    let live: object | undefined;
    let predecessor: string | undefined;
    let successor: string | undefined;
    if (kind === 'enroll' || kind === 'issue') {
      action = () =>
        f.op(kind === 'enroll' ? 'nanohost.enroll' : 'nanohost.token-issue', {
          targetSlot: 'A',
          expiresAt,
        });
    } else if (kind === 'abort') {
      const pair = await rotation(f);
      predecessor = pair.first.record.tokenId;
      successor = pair.rotated.record.tokenId;
      live = await admitted(f, slotSecret(f, 'A'));
      action = () => f.op('nanohost.token-rotation-abort', { tokenId: successor! });
    } else {
      const first = await issueSlot(f);
      predecessor = first.record.tokenId;
      if (kind === 'decommission')
        await f.op('nanohost.token-rotate', {
          tokenId: first.record.tokenId,
          overlapSeconds: 3600,
        });
      const secret = slotSecret(f, 'A');
      live = kind === 'verify' ? await f.physical() : await admitted(f, secret);
      action =
        kind === 'verify'
          ? () =>
              admitNanoHostTransportConnection(f.db, f.authority, {
                secret,
                physicalConnection: live!,
                transportRevision: String(transportRevision),
              })
          : kind === 'revoke'
            ? () => f.op('nanohost.token-revoke', { tokenId: predecessor! })
            : kind === 'rotate'
              ? () => f.op('nanohost.token-rotate', { tokenId: predecessor!, overlapSeconds: 3600 })
              : () => f.op('nanohost.decommission', {});
    }
    const beforeAudit = audits(f);
    const discard = vi.spyOn(f.authority, 'discardPendingSuccessor');
    if (kind === 'decommission') {
      // Main row-6 owner remains separate. This real refusal occurs after process fencing.
      f.fixtureSql(
        `CREATE TRIGGER readiness_refusal BEFORE UPDATE ON nanohost_runtime_targets BEGIN SELECT RAISE(ABORT, 'synthetic readiness refusal'); END`
      ).run();
    }
    arm(f, 1);
    const pending = await held(f, action);
    expect(Atomics.load(f.gate, 5)).toBe(2);
    expect(audits(f)).toBe(beforeAudit);
    if (kind === 'enroll') {
      expect(count(f)).toBe(0);
      expect(slotPresent(f, 'A')).toBe(true);
    }
    if (kind === 'issue') expect(slotPresent(f, 'A')).toBe(false);
    if (kind === 'verify') expect(getNanoHostRuntimeTarget(f.db, identityId)).toBeNull();
    if (kind === 'rotate') expect(slotPresent(f, 'B')).toBe(false);
    if (kind === 'revoke' || kind === 'decommission')
      expect(f.authority.mayCarryWork(live!)).toBe(true);
    if (kind === 'abort') {
      expect(slotPresent(f, 'B')).toBe(true);
      // Original clear-before-discard suffix must stop on this real clear failure.
      rmSync(f.slots.B.secretPath);
      mkdirSync(f.slots.B.secretPath);
      writeFileSync(join(f.slots.B.secretPath, 'child'), 'inert');
    }
    release(f.gate);
    const outcome = await pending.result;
    expect(outcome.ok).toBe(kind !== 'abort' && kind !== 'decommission');
    if (kind === 'abort') {
      expect(getNanoHostTransportTokenRecord(f.db, predecessor!)?.status).toBe('active');
      expect(getNanoHostTransportTokenRecord(f.db, successor!)?.status).toBe('revoked');
      expect(f.authority.mayCarryWork(live!)).toBe(true);
      expect(discard).not.toHaveBeenCalled();
    }
    if (kind === 'decommission') {
      expect(f.authority.mayCarryWork(live!)).toBe(false);
      expect(slotPresent(f, 'A')).toBe(true);
      expect(slotPresent(f, 'B')).toBe(true);
      expect(audits(f)).toBe(beforeAudit);
    }
  });

  it.each([
    'presented administrator',
    'derived disabled owner',
    'identity binding',
    'verification revocation',
    'verification deadlines',
    'post-ACK rotation administrator',
  ] as const)('rechecks %s after the actual native wait', async (scenario) => {
    const f = await fixture();
    const transport = await issue(f);
    let action: () => Promise<unknown>;
    let beforeAudit = audits(f);
    let predecessor: string | undefined;
    if (scenario === 'post-ACK rotation administrator') {
      const issued = await issueSlot(f);
      predecessor = issued.record.tokenId;
      beforeAudit = audits(f);
      action = () => f.op('nanohost.token-rotate', { tokenId: predecessor!, overlapSeconds: 3600 });
      arm(f, 2);
    } else {
      action = scenario.startsWith('verification')
        ? () => verifyNanoHostTransportTokenRecord(f.db, transport.secret)
        : () =>
            f.op(
              'nanohost.token-issue',
              { targetSlot: 'A', expiresAt },
              scenario === 'derived disabled owner'
                ? { kind: 'session', userId: administratorId, adminTokenId: f.admin.tokenId }
                : f.actor
            );
      arm(f, 3);
    }
    const pending = await held(f, action);
    if (scenario === 'presented administrator' || scenario === 'post-ACK rotation administrator')
      f.fixtureSql("UPDATE openkit_access_tokens SET status = 'revoked' WHERE token_id = ?").run(
        f.admin.tokenId
      );
    if (scenario === 'derived disabled owner')
      f.fixtureSql("UPDATE users SET status = 'disabled' WHERE id = ?").run(administratorId);
    if (scenario === 'identity binding')
      f.fixtureSql(
        "UPDATE nanohost_integration_identities SET status = 'decommissioned' WHERE identity_id = ?"
      ).run(identityId);
    if (scenario === 'verification revocation')
      f.fixtureSql(
        "UPDATE nanohost_transport_tokens SET status = 'revoked' WHERE token_id = ?"
      ).run(transport.tokenId);
    if (scenario === 'verification deadlines')
      f.fixtureSql('UPDATE nanohost_transport_tokens SET expires_at = ? WHERE token_id = ?').run(
        new Date(Date.now() - 1).toISOString(),
        transport.tokenId
      );
    release(f.gate);
    const outcome = await pending.result;
    if (scenario.startsWith('verification')) {
      expect(outcome.ok && outcome.value === null).toBe(true);
      expect(getNanoHostTransportTokenRecord(f.db, transport.tokenId)?.lastUsedAt).toBeNull();
      if (scenario === 'verification deadlines') {
        f.fixtureSql(
          "UPDATE nanohost_transport_tokens SET expires_at = ?, status = 'rotated', rotation_overlap_expires_at = ? WHERE token_id = ?"
        ).run(expiresAt, expiresAt, transport.tokenId);
        arm(f, 3);
        const overlap = await held(f, () =>
          verifyNanoHostTransportTokenRecord(f.db, transport.secret)
        );
        f.fixtureSql(
          'UPDATE nanohost_transport_tokens SET rotation_overlap_expires_at = ? WHERE token_id = ?'
        ).run(new Date(Date.now() - 1).toISOString(), transport.tokenId);
        release(f.gate);
        const expiredOverlap = await overlap.result;
        expect(expiredOverlap.ok && expiredOverlap.value === null).toBe(true);
        expect(getNanoHostTransportTokenRecord(f.db, transport.tokenId)?.lastUsedAt).toBeNull();
      }
    } else {
      expect(outcome.ok).toBe(false);
      expect(audits(f)).toBe(beforeAudit);
      expect(slotPresent(f, 'B')).toBe(false);
      if (predecessor) {
        expect(getNanoHostTransportTokenRecord(f.db, predecessor)?.status).toBe('active');
        expect(
          f.db.sqlite
            .prepare('SELECT status FROM nanohost_transport_tokens WHERE predecessor_token_id = ?')
            .pluck()
            .get(predecessor)
        ).toBe('revoked');
      } else expect(count(f)).toBe(1);
    }
  });

  it.each([
    'revoked Token',
    'decommissioned identity',
    'closed physical connection',
    'already admitted connection',
    'wrong revision',
    'restart-required authority',
  ] as const)('refuses %s after verification commits and before new work authority', async (scenario) => {
    const f = await fixture();
    const token = await issue(f);
    const physical = await f.physical();
    const authority = f.authority;
    let reload: (() => void) | undefined;
    if (scenario === 'restart-required authority') {
      const configPath = join(f.root, 'config', 'server.jsonc');
      mkdirSync(join(f.root, 'config'), { recursive: true });
      const config = { schemaVersion: 1, nanohost: f.config };
      writeFileSync(configPath, JSON.stringify(config));
      const manager = createRuntimeConfigManager({ dataRoot: f.root });
      // Use the real App-owned restart latch and its wrapped authority, never a replacement admit.
      createApp({
        coreDb: f.db,
        dataRoot: f.root,
        mode: 'server',
        runtimeConfigManager: manager,
        nanohostTransportSessionAuthority: authority,
      });
      reload = async () => {
        writeFileSync(
          configPath,
          JSON.stringify({
            ...config,
            nanohost: { ...f.config, bind: { ...f.config.bind, port: 4319 } },
          })
        );
        const result = await manager.reload({ mode: 'safe', dryRun: false });
        expect(
          result.plan.requiresRestart.some((change) => change.path.startsWith('nanohost.'))
        ).toBe(true);
      };
    }
    arm(f, scenario === 'already admitted connection' ? 5 : 2);
    const pending = await held(f, () =>
      admitNanoHostTransportConnection(f.db, authority, {
        secret: token.secret,
        physicalConnection: physical,
        transportRevision:
          scenario === 'wrong revision' ? 'unsupported-native-revision' : String(transportRevision),
        source: 'first-admission',
      })
    );
    expect(getNanoHostTransportTokenRecord(f.db, token.tokenId)?.lastUsedAt).not.toBeNull();
    if (scenario === 'revoked Token')
      f.fixtureSql(
        "UPDATE nanohost_transport_tokens SET status = 'revoked' WHERE token_id = ?"
      ).run(token.tokenId);
    if (scenario === 'decommissioned identity')
      f.fixtureSql(
        "UPDATE nanohost_integration_identities SET status = 'decommissioned' WHERE identity_id = ?"
      ).run(identityId);
    if (scenario === 'closed physical connection') {
      const closed = once(physical as import('node:events').EventEmitter, 'close');
      (physical as { destroy(): void }).destroy();
      await closed;
    }
    if (scenario === 'already admitted connection') {
      expect(getNanoHostTransportTokenRecord(f.db, token.tokenId)?.lastUsedSource).toBe(
        'first-admission'
      );
      expect(getNanoHostRuntimeTarget(f.db, identityId)).toBeNull();
      const second = await admitNanoHostTransportConnection(f.db, authority, {
        secret: token.secret,
        physicalConnection: physical,
        transportRevision: String(transportRevision),
        source: 'second-admission',
      });
      expect(second).toMatchObject({
        ok: true,
        connectionGeneration: 1,
        role: 'authoritative',
        mayCarryWork: true,
      });
      expect(pending.settled()).toBe(false);
      expect(getNanoHostRuntimeTarget(f.db, identityId)).toMatchObject({ connectionGeneration: 1 });
      expect(getNanoHostTransportTokenRecord(f.db, token.tokenId)?.lastUsedSource).toBe(
        'second-admission'
      );
    }
    reload?.();
    release(f.gate);
    const outcome = await pending.result;
    expect(outcome.ok && !(outcome.value as { ok: boolean }).ok).toBe(true);
    if (scenario === 'already admitted connection') {
      expect(outcome.ok && outcome.value).toMatchObject({ ok: false, reason: 'rejected' });
      expect(getNanoHostRuntimeTarget(f.db, identityId)).toMatchObject({ connectionGeneration: 1 });
      expect(authority.authoritativeGeneration(identityId)).toBe(1);
      expect(authority.mayCarryWork(physical)).toBe(true);
      expect(getNanoHostTransportTokenRecord(f.db, token.tokenId)?.lastUsedSource).toBe(
        'second-admission'
      );
    } else if (scenario === 'restart-required authority')
      expect(getNanoHostRuntimeTarget(f.db, identityId)).toMatchObject({
        connectionGeneration: 1,
        ready: false,
      });
    else expect(getNanoHostRuntimeTarget(f.db, identityId)).toBeNull();
    expect(authority.connectionGeneration(physical)).toBe(
      scenario === 'already admitted connection' ? 1 : null
    );
  });

  it.each([
    'enroll',
    'issue',
    'rotate',
  ] as const)('keeps the actual %s commit unknown after its ACK is lost', async (kind) => {
    const f = await fixture({ enrolled: kind !== 'enroll' });
    const first = kind === 'rotate' ? await issueSlot(f) : undefined;
    const before = { audit: audits(f), count: count(f), commits: f.commits() };
    arm(f, 2);
    const pending = await held(f, async () =>
      kind === 'rotate'
        ? f.op('nanohost.token-rotate', { tokenId: first!.record.tokenId, overlapSeconds: 3600 })
        : f.op(kind === 'enroll' ? 'nanohost.enroll' : 'nanohost.token-issue', {
            targetSlot: 'A',
            expiresAt,
          })
    );
    expect(count(f)).toBe(before.count + 1);
    await loseReply();
    expect((await pending.result).ok).toBe(false);
    expect(f.commits()).toBe(before.commits + 1);
    expect(count(f)).toBe(before.count + 1);
    expect(audits(f)).toBe(before.audit);
    expect(slotPresent(f, 'A')).toBe(kind !== 'issue');
    expect(slotPresent(f, 'B')).toBe(false);
    if (first)
      expect(getNanoHostTransportTokenRecord(f.db, first.record.tokenId)?.status).toBe('rotated');
  });

  it.each([
    'lifecycle',
    'decommission',
  ] as const)('retains completed stages when the separate %s Audit insert refuses', async (kind) => {
    const f = await fixture();
    let live: object | undefined;
    if (kind === 'decommission') {
      await rotation(f);
      live = await admitted(f, slotSecret(f, 'A'));
    }
    const beforeAudit = audits(f);
    fault(f, 'audit_events', 'INSERT');
    await failed(
      kind === 'lifecycle'
        ? f.op('nanohost.token-issue', { targetSlot: 'A', expiresAt })
        : f.op('nanohost.decommission', {})
    );
    expect(audits(f)).toBe(beforeAudit);
    expect(identities(f)).toMatchObject([
      { status: kind === 'lifecycle' ? 'active' : 'decommissioned' },
    ]);
    expect(slotPresent(f, 'A')).toBe(kind === 'lifecycle');
    if (kind === 'lifecycle')
      expect(
        f.db.sqlite.prepare('SELECT status FROM nanohost_transport_tokens').pluck().get()
      ).toBe('active');
    if (live) expect(f.authority.mayCarryWork(live)).toBe(false);
  });

  it('returns the exact complete committed row when retained state changes before its ACK', async () => {
    const f = await fixture();
    arm(f, 2);
    const pending = await held(f, () => issue(f));
    const row = f.db.sqlite
      .prepare('SELECT token_id FROM nanohost_transport_tokens')
      .pluck()
      .get() as string;
    const committed = getNanoHostTransportTokenRecord(f.db, row)!;
    f.fixtureSql(
      "UPDATE nanohost_transport_tokens SET status = 'revoked', last_used_source = 'later-observation' WHERE token_id = ?"
    ).run(row);
    release(f.gate);
    const outcome = await pending.result;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.record).toEqual(committed);
    expect(getNanoHostTransportTokenRecord(f.db, row)?.status).toBe('revoked');
  });

  it('refuses a malformed closed family shape before native mutation or Main fallback', async () => {
    const f = await fixture();
    const before = f.commits();
    // Deliberately cross the actual typed client's runtime boundary with invalid owned input.
    await failed(
      f.client.nanoHostTransport(f.database, { kind: 'unrecognized-native-action' } as never)
    );
    expect(f.commits()).toBe(before);
    expect(count(f)).toBe(0);
  });

  it('clears only its enrollment slot when the real open ACK is lost before credential submission', async () => {
    const f = await fixture({ enrolled: false, open: false });
    arm(f, 4);
    const pending = await held(f, () => f.op('nanohost.enroll', { targetSlot: 'A', expiresAt }));
    expect(slotPresent(f, 'A')).toBe(true);
    expect(Atomics.load(f.gate, 6)).toBe(0);
    await loseReply();
    expect((await pending.result).ok).toBe(false);
    expect(Atomics.load(f.gate, 6)).toBe(0);
    expect(count(f)).toBe(0);
    expect(identities(f)).toEqual([]);
    expect(audits(f)).toBe(0);
    expect(slotPresent(f, 'A')).toBe(false);
  });

  it('keeps live authority and readiness when revocation definitely rolls back', async () => {
    const f = await fixture();
    const issued = await issueSlot(f);
    const live = await admitted(f, slotSecret(f, 'A'));
    const before = {
      tokens: tokens(f),
      target: getNanoHostRuntimeTarget(f.db, identityId),
      audit: audits(f),
    };
    fault(f, 'nanohost_transport_tokens', 'UPDATE');
    await failed(f.op('nanohost.token-revoke', { tokenId: issued.record.tokenId }));
    expect(tokens(f)).toEqual(before.tokens);
    expect(f.authority.mayCarryWork(live)).toBe(true);
    expect(getNanoHostRuntimeTarget(f.db, identityId)).toEqual(before.target);
    expect(audits(f)).toBe(before.audit);
    expect(
      await revokeNanoHostTransportTokenAndFence(f.db, f.authority, {
        tokenId: allocateEntityId('nhtok'),
      })
    ).toBeNull();
    expect(f.authority.mayCarryWork(live)).toBe(true);
  });

  it.each([
    'revoke',
    'decommission',
  ] as const)('fences only its identity after unknown %s commit without claiming the SQL result', async (kind) => {
    const f = await fixture();
    const first = await issueSlot(f);
    if (kind === 'decommission')
      await f.op('nanohost.token-rotate', { tokenId: first.record.tokenId, overlapSeconds: 3600 });
    const live = await admitted(f, slotSecret(f, 'A'));
    const foreign = await foreignAuthority(f);
    const beforeAudit = audits(f);
    if (kind === 'revoke') fault(f, 'nanohost_runtime_targets', 'UPDATE');
    arm(f, 2);
    const pending = await held(f, async () =>
      kind === 'revoke'
        ? f.op('nanohost.token-revoke', { tokenId: first.record.tokenId })
        : f.op('nanohost.decommission', {})
    );
    expect(getNanoHostTransportTokenRecord(f.db, first.record.tokenId)?.status).toBe('revoked');
    expect(f.authority.mayCarryWork(live)).toBe(true);
    await loseReply();
    expect((await pending.result).ok).toBe(false);
    const outcome = await pending.result;
    if (!outcome.ok) {
      const causes: unknown[] = [];
      for (
        let cause: unknown = outcome.error;
        cause instanceof Error && !causes.includes(cause);
        cause = cause.cause
      )
        causes.push(cause);
      expect(
        causes
          .filter(
            (cause): cause is ControlStoreWorkerError => cause instanceof ControlStoreWorkerError
          )
          .map((cause) => cause.commit)
      ).toContain('unknown');
    }
    expect(f.authority.mayCarryWork(live)).toBe(false);
    expect(f.authority.mayCarryWork(foreign.physical)).toBe(true);
    expect(getNanoHostTransportTokenRecord(f.db, foreign.token.tokenId)?.status).toBe('active');
    expect(slotPresent(f, 'A')).toBe(true);
    expect(audits(f)).toBe(beforeAudit);
    if (kind === 'decommission') {
      expect(slotPresent(f, 'B')).toBe(true);
      expect(getNanoHostRuntimeTarget(f.db, identityId)?.ready).toBe(false);
    }
    // The real unavailable native close must remain a joined failure, including after
    // destroy emits close. The event adapter reports it instead of leaking rejection.
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closed = once(live as import('node:http2').Http2Session, 'close');
    await expect(f.authority.closeAllPhysicalConnections()).rejects.toMatchObject({
      errors: [{ code: 'unavailable', commit: 'not-committed' }],
    });
    await closed;
    await nextTurn();
    expect(diagnostics).toHaveBeenCalledWith(
      'NanoHost physical close publication failed.',
      expect.objectContaining({ code: 'unavailable', commit: 'not-committed' })
    );
  });

  it.each([
    'refused',
    'unknown',
  ] as const)('preserves an incomplete %s issue compensation after a real sink failure', async (kind) => {
    const f = await fixture();
    blockSlot(f, 'A');
    if (kind === 'refused')
      fault(f, 'nanohost_transport_tokens', 'UPDATE', "WHEN NEW.status = 'revoked'");
    const before = f.commits();
    arm(f, kind === 'refused' ? 3 : 2, before + 2);
    const pending = await held(f, () =>
      f.op('nanohost.token-issue', { targetSlot: 'A', expiresAt })
    );
    expect(count(f)).toBe(1);
    // Original compensation must not acquire a new administrator gate.
    f.fixtureSql("UPDATE openkit_access_tokens SET status = 'revoked' WHERE token_id = ?").run(
      f.admin.tokenId
    );
    if (kind === 'unknown') await loseReply();
    else release(f.gate);
    expect((await pending.result).ok).toBe(false);
    expect(count(f)).toBe(1);
    expect(f.db.sqlite.prepare('SELECT status FROM nanohost_transport_tokens').pluck().get()).toBe(
      kind === 'refused' ? 'active' : 'revoked'
    );
    expect(audits(f)).toBe(0);
    expect(Atomics.load(f.gate, 6)).toBe(2);
    expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
    expect(existsSync(f.slots.A.secretPath)).toBe(true);
  });

  it.each([
    'refused',
    'unknown',
  ] as const)('preserves the original suffix after %s rotation-abort compensation', async (kind) => {
    const f = await fixture();
    const first = await issueSlot(f);
    const live = await admitted(f, slotSecret(f, 'A'));
    const before = { audit: audits(f), commits: f.commits(), calls: Atomics.load(f.gate, 6) };
    const discard = vi.spyOn(f.authority, 'discardPendingSuccessor');
    blockSlot(f, 'B');
    if (kind === 'refused')
      fault(
        f,
        'nanohost_transport_tokens',
        'UPDATE',
        `WHEN NEW.token_id = '${first.record.tokenId}' AND NEW.status = 'active'`
      );
    arm(f, kind === 'refused' ? 3 : 2, before.commits + 2);
    const pending = await held(f, () =>
      f.op('nanohost.token-rotate', { tokenId: first.record.tokenId, overlapSeconds: 3600 })
    );
    expect(count(f)).toBe(2);
    expect(f.authority.mayCarryWork(live)).toBe(true);
    f.fixtureSql("UPDATE openkit_access_tokens SET status = 'revoked' WHERE token_id = ?").run(
      f.admin.tokenId
    );
    if (kind === 'unknown') await loseReply();
    else release(f.gate);
    expect((await pending.result).ok).toBe(false);
    expect(getNanoHostTransportTokenRecord(f.db, first.record.tokenId)?.status).toBe(
      kind === 'refused' ? 'rotated' : 'active'
    );
    expect(
      f.db.sqlite
        .prepare('SELECT status FROM nanohost_transport_tokens WHERE predecessor_token_id = ?')
        .pluck()
        .get(first.record.tokenId)
    ).toBe(kind === 'refused' ? 'active' : 'revoked');
    expect(f.authority.mayCarryWork(live)).toBe(true);
    expect(discard).toHaveBeenCalledTimes(kind === 'refused' ? 0 : 1);
    if (kind === 'unknown') expect(discard).toHaveBeenCalledWith(identityId);
    expect(existsSync(f.slots.B.secretPath)).toBe(true);
    expect(slotPresent(f, 'A')).toBe(true);
    expect(audits(f)).toBe(before.audit);
    expect(Atomics.load(f.gate, 6) - before.calls).toBe(2);
  });

  it('keeps an explicitly revoked predecessor revoked when a late sink failure aborts rotation', async () => {
    const f = await fixture();
    const first = await issueSlot(f);
    const oldSecret = slotSecret(f, 'A');
    const live = await admitted(f, oldSecret);
    const beforeAudit = audits(f);
    blockSlot(f, 'B');
    arm(f, 5);
    const pending = await held(f, () =>
      f.op('nanohost.token-rotate', {
        tokenId: first.record.tokenId,
        overlapSeconds: 3600,
      })
    );
    expect(getNanoHostTransportTokenRecord(f.db, first.record.tokenId)?.status).toBe('rotated');
    const successorId = f.db.sqlite
      .prepare('SELECT token_id FROM nanohost_transport_tokens WHERE predecessor_token_id = ?')
      .pluck()
      .get(first.record.tokenId) as string;
    expect(getNanoHostTransportTokenRecord(f.db, successorId)?.status).toBe('active');
    const revoked = await f.op('nanohost.token-revoke', { tokenId: first.record.tokenId });
    expect(revoked.record.status).toBe('revoked');
    expect(pending.settled()).toBe(false);
    expect(f.authority.mayCarryWork(live)).toBe(false);
    expect(audits(f)).toBe(beforeAudit + 1);
    release(f.gate);
    const outcome = await pending.result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.error).toMatchObject({
        code: 'nanohost_transport_rotate_failed',
        status: 400,
      });
    expect(getNanoHostTransportTokenRecord(f.db, first.record.tokenId)?.status).toBe('revoked');
    expect(getNanoHostTransportTokenRecord(f.db, first.record.tokenId)?.revokedAt).toBe(
      revoked.record.revokedAt
    );
    expect(getNanoHostTransportTokenRecord(f.db, successorId)?.status).toBe('revoked');
    expect(
      f.db.sqlite
        .prepare(
          "SELECT count(*) FROM nanohost_transport_tokens WHERE status IN ('active', 'rotated')"
        )
        .pluck()
        .get()
    ).toBe(0);
    expect(await verifyNanoHostTransportTokenRecord(f.db, oldSecret)).toBeNull();
    expect(f.authority.mayCarryWork(live)).toBe(false);
    expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
    expect(getNanoHostRuntimeTarget(f.db, identityId)?.ready).toBe(false);
    expect(
      f.db.sqlite
        .prepare(
          "SELECT action, outcome FROM audit_events WHERE action = 'nanohost.transport.revoke'"
        )
        .all()
    ).toEqual([{ action: 'nanohost.transport.revoke', outcome: 'succeeded' }]);
    const failedAudits = f.db.sqlite
      .prepare(
        "SELECT action, outcome, error_code, summary FROM audit_events WHERE action = 'nanohost.transport.rotate'"
      )
      .all() as Array<{ action: string; outcome: string; error_code: string; summary: string }>;
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0]).toMatchObject({
      action: 'nanohost.transport.rotate',
      outcome: 'failed',
      error_code: 'nanohost_transport_rotate_failed',
    });
    expect(failedAudits[0]!.summary).toContain(first.record.tokenId);
    expect(failedAudits[0]!.summary).toContain(successorId);
    expect(failedAudits[0]!.summary.match(/\brevoked\b/gu)).toHaveLength(2);
    expect(JSON.stringify(failedAudits).includes(oldSecret)).toBe(false);
    for (const sink of Object.values(f.slots)) {
      expect(JSON.stringify(failedAudits).includes(sink.secretPath)).toBe(false);
      expect(JSON.stringify(failedAudits).includes(sink.companionPath)).toBe(false);
    }
    expect(
      f.db.sqlite
        .prepare(
          "SELECT count(*) FROM audit_events WHERE action = 'nanohost.transport.rotate' AND outcome = 'succeeded'"
        )
        .pluck()
        .get()
    ).toBe(0);
    expect(audits(f)).toBe(beforeAudit + 2);
  });

  it('preserves a fresh enrollment slot while an earlier decommission ACK is pending', async () => {
    const f = await fixture();
    const original = await issueSlot(f);
    const live = await admitted(f, slotSecret(f, 'A'));
    const beforeAudit = audits(f);
    expect(slotPresent(f, 'B')).toBe(false);
    arm(f, 2);
    const decommission = await held(f, () => f.op('nanohost.decommission', {}));
    expect(getNanoHostTransportTokenRecord(f.db, original.record.tokenId)?.status).toBe('revoked');
    expect(identities(f)).toMatchObject([{ status: 'decommissioned' }]);
    expect(slotPresent(f, 'A')).toBe(true);
    expect(f.authority.mayCarryWork(live)).toBe(true);
    const posted = vi.spyOn(interception.workers.at(-1)!, 'postMessage');
    let enrollmentSettled = false;
    const enrollment = f.op('nanohost.enroll', { targetSlot: 'B', expiresAt }).then(
      (value) => {
        enrollmentSettled = true;
        return { ok: true as const, value };
      },
      (error) => {
        enrollmentSettled = true;
        return { ok: false as const, error };
      }
    );
    const enrollmentPosted = () =>
      posted.mock.calls.some(([value]) => {
        const request = value as { operation?: string; input?: { kind?: string } };
        return request.operation === 'nanohost-transport' && request.input?.kind === 'enroll';
      });
    while (!enrollmentPosted() && !enrollmentSettled) await nextTurn();
    expect(enrollmentPosted()).toBe(true);
    expect(enrollmentSettled).toBe(false);
    expect(decommission.settled()).toBe(false);
    expect(slotPresent(f, 'B')).toBe(true);
    const freshId = readNanoHostCredentialSlotTokenId(f.slots.B)!;
    const freshSecret = readFileSync(f.slots.B.secretPath);
    const freshCompanion = readFileSync(f.slots.B.companionPath);
    expect(freshId).not.toBe(original.record.tokenId);
    expect(getNanoHostTransportTokenRecord(f.db, freshId)).toBeNull();
    release(f.gate);
    const staleOutcome = await decommission.result;
    const freshOutcome = await enrollment;
    expect(staleOutcome.ok).toBe(false);
    expect(freshOutcome.ok).toBe(true);
    if (freshOutcome.ok) expect(freshOutcome.value.record.tokenId).toBe(freshId);
    expect(slotPresent(f, 'A')).toBe(false);
    expect(slotPresent(f, 'B')).toBe(true);
    expect(readFileSync(f.slots.B.secretPath).equals(freshSecret)).toBe(true);
    expect(readFileSync(f.slots.B.companionPath).equals(freshCompanion)).toBe(true);
    expect(getNanoHostTransportTokenRecord(f.db, original.record.tokenId)?.status).toBe('revoked');
    expect(getNanoHostTransportTokenRecord(f.db, freshId)?.status).toBe('active');
    expect(identities(f)).toMatchObject([{ status: 'active' }]);
    expect(f.authority.mayCarryWork(live)).toBe(false);
    expect(
      f.db.sqlite
        .prepare(
          "SELECT count(*) FROM audit_events WHERE action = 'nanohost.transport.decommission'"
        )
        .pluck()
        .get()
    ).toBe(0);
    expect(
      f.db.sqlite
        .prepare(
          "SELECT count(*) FROM audit_events WHERE action = 'nanohost.transport.enroll' AND outcome = 'succeeded'"
        )
        .pluck()
        .get()
    ).toBe(1);
    expect(audits(f)).toBe(beforeAudit + 1);
  });

  it('keeps the acknowledged rotation when its real optional session-authority branch is absent', async () => {
    const f = await fixture({ authority: false });
    const first = await issueSlot(f);
    blockSlot(f, 'B');
    const before = { commits: f.commits(), audit: audits(f), calls: Atomics.load(f.gate, 6) };
    await failed(
      f.op('nanohost.token-rotate', { tokenId: first.record.tokenId, overlapSeconds: 3600 })
    );
    expect(count(f)).toBe(2);
    expect(getNanoHostTransportTokenRecord(f.db, first.record.tokenId)?.status).toBe('rotated');
    expect(
      f.db.sqlite
        .prepare('SELECT status FROM nanohost_transport_tokens WHERE predecessor_token_id = ?')
        .pluck()
        .get(first.record.tokenId)
    ).toBe('active');
    expect(f.commits()).toBe(before.commits + 1);
    expect(Atomics.load(f.gate, 6) - before.calls).toBe(1);
    expect(audits(f)).toBe(before.audit);
    expect(slotPresent(f, 'A')).toBe(true);
  });

  it.each([
    'enroll',
    'decommission',
  ] as const)('does not undo %s when its later Audit commit ACK is lost', async (kind) => {
    const f = await fixture({ enrolled: kind === 'decommission' });
    let live: object | undefined;
    if (kind === 'decommission') {
      await rotation(f);
      live = await admitted(f, slotSecret(f, 'A'));
    }
    const before = { audit: audits(f), commits: f.commits() };
    // Decommission now awaits its original physical-close write on the native owner too.
    // Hold the later Audit itself, after that separate close stage, rather than an ordinal on Main.
    const coveringCommits = kind === 'decommission' ? 3 : 2;
    arm(f, 2, before.commits + coveringCommits);
    const pending = await held(f, async () =>
      kind === 'enroll'
        ? f.op('nanohost.enroll', { targetSlot: 'A', expiresAt })
        : f.op('nanohost.decommission', {})
    );
    expect(audits(f)).toBe(before.audit + 1);
    expect(slotPresent(f, 'A')).toBe(kind === 'enroll');
    if (live) expect(f.authority.mayCarryWork(live)).toBe(false);
    await loseReply();
    expect((await pending.result).ok).toBe(false);
    expect(f.commits()).toBe(before.commits + coveringCommits);
    expect(identities(f)).toMatchObject([
      { status: kind === 'enroll' ? 'active' : 'decommissioned' },
    ]);
    expect(slotPresent(f, 'A')).toBe(kind === 'enroll');
    expect(slotPresent(f, 'B')).toBe(false);
  });
});

it('joins an allocated admission and its physical-close producer before native shutdown', async () => {
  const f = await fixture();
  const issued = await issue(f);
  const physical = await f.physical();
  const posted = vi.spyOn(interception.workers.at(-1)!, 'postMessage');
  arm(f, 5, f.commits() + 2);
  const admission = await held(f, () =>
    admitNanoHostTransportConnection(f.db, f.authority, {
      secret: issued.secret,
      physicalConnection: physical,
      transportRevision: String(transportRevision),
    })
  );
  // The actual allocation committed, but Main has not received its reply or bound the connection.
  expect(getNanoHostRuntimeTarget(f.db, identityId)?.connectionGeneration).toBe(1);
  (physical as import('node:http2').Http2Session).destroy();
  const shutdown = f.track(shutdownControlStoreWorkerClient());
  release(f.gate);
  await expect(admission.result).resolves.toMatchObject({
    ok: true,
    value: { ok: false, reason: 'rejected' },
  });
  await shutdown;
  const commands = posted.mock.calls.map(
    ([message]) => message as { operation?: string; input?: { kind?: string } }
  );
  const closeIndex = commands.findIndex(
    (value) => value.operation === 'runtime-target' && value.input?.kind === 'close'
  );
  const shutdownIndex = commands.findIndex((value) => value.operation === 'shutdown');
  expect(closeIndex).toBeGreaterThanOrEqual(0);
  expect(shutdownIndex).toBeGreaterThan(closeIndex);
  expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
  expect(getNanoHostRuntimeTarget(f.db, identityId)).toMatchObject({
    connectionGeneration: 1,
    ready: false,
  });
});
