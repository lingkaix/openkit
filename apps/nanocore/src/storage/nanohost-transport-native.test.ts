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
import { createCredentialOperationImplementations } from '../auth/credential-operations.js';
import type { Actor } from '../auth/identity.js';
import {
  createNanoHostOperationImplementations,
  revokeAdmittedNanoHostInboundCredential,
} from '../auth/nanohost-operations.js';
import { admitNativeNanoHostTransportConnection } from '../auth/nanohost-transport-admission.js';
import { NANOHOST_TRANSPORT_ADMIN_REFUSAL } from '../auth/nanohost-transport-codecs.js';
import transportRevision from '../auth/nanohost-transport-revision.json' with { type: 'json' };
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { readNanoHostCredentialSlotTokenId } from '../auth/nanohost-transport-sink.js';
import {
  completeNanoHostTransportTokenCutover,
  createNanoHostTransportTokenRecord,
  getNanoHostTransportTokenRecord,
  prepareNanoHostTransportWriter,
  recordNanoHostTransportAudit,
  verifyNanoHostTransportTokenRecord,
} from '../auth/nanohost-transport-token-store.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { createOperationEngine } from '../operation-invocation.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import {
  openAdmittedTestNanoHost,
  reopenAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import type { ControlWorkerReply } from './control-store-worker-protocol.js';
import { openCoreDb, serverStoragePath } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './nanohost-transport-owner.js';
import type { ControlRuntimeTargetInput } from './runtime-target-codecs.js';
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
            message?.operation === 'runtime-target' ||
            message?.operation === 'nanohost-owner') &&
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
            // Count credential stages: Core Audit and the Native owner tuple.
            if (value.operation === 'nanohost-transport' ||
                (value.operation === 'nanohost-owner' && value.mutation && value.mutation.kind === 'transport'))
              Atomics.add(gate, 6, 1);
          });
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
async function fixture(
  options: { enrolled?: boolean; authority?: boolean; useLayoutDeployment?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'nanohost-native-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  const fixtureDeploymentId = options.useLayoutDeployment
    ? readDataRootLayoutMarker(root).deploymentId
    : deploymentId;
  interception.gate = new SharedArrayBuffer(28);
  const gate = new Int32Array(interception.gate);
  db.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, image, created_at, updated_at, kind, last_seen_at)
    VALUES (?, 'Native Administrator', ?, false, NULL, ?, ?, 'human', NULL)`)
    .run(administratorId, `${administratorId}@example.invalid`, Date.now(), Date.now());
  const admin = createOpenKitAccessTokenRecord(db, {
    ownerUserId: administratorId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt,
  });
  // Provision and admit the NanoHost file before the Main mutation denial below, so fixture setup of
  // its Native rows is never counted as a Main write.
  let storage = await openAdmittedTestNanoHost(db);
  const nativePath = serverStoragePath(root, 'nanohost');
  const raw = new Database(nativePath, { fileMustExist: true });
  if (options.enrolled !== false)
    raw
      .prepare(
        `INSERT INTO nanohost_integration_identities
       (identity_id, deployment_id, status, created_at) VALUES (?, ?, 'active', ?)`
      )
      .run(identityId, fixtureDeploymentId, clock.toISOString());
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
    deploymentId: fixtureDeploymentId,
    credentialRef: 'nanohost-transport:primary',
    credentialSlots: slots,
    bind: { host: '127.0.0.1', port: 4318 },
    rendezvousUrl: 'http://127.0.0.1',
  };
  const client = getControlStoreWorkerClient();
  const scope = nativeProductScope(root, { kind: 'server' });
  const database = `core:${scope.path}`;
  const implementations = {
    ...createCredentialOperationImplementations({
      coreDb: db,
      mode: 'server',
      ...(options.authority === false ? {} : { nanoHostSessionAuthority: authority }),
      listNanoHostTransportTokens: (signal) => storage.value.owner.listTransportTokens(signal),
      revokeNanoHostTransportToken: (tokenId, context) =>
        revokeAdmittedNanoHostInboundCredential(
          {
            storage,
            ...(options.authority === false ? {} : { sessionAuthority: authority }),
            commitRevoke: async ({ actor, expected }) => {
              const result = await storage.value.owner.administerTransport({
                kind: 'revoke',
                tokenId: expected.tokenId,
                actor,
              });
              if (result.kind !== 'record' || !result.record)
                return { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
              const record = result.record;
              return {
                state: 'ready',
                value: {
                  record,
                  acknowledgeAudit: () =>
                    recordNanoHostTransportAudit(db, {
                      kind: 'lifecycle-audit',
                      action: 'nanohost.transport.revoke',
                      record,
                      actorUserId: actor.userId,
                    }),
                },
              };
            },
          },
          tokenId,
          context
        ),
    }),
    ...createNanoHostOperationImplementations({
      coreDb: db,
      mode: 'server',
      nanoHostConfig: config,
      ...(options.authority === false ? {} : { sessionAuthority: authority }),
      readNanoHostTarget: storage.value.owner.readRuntimeTarget,
      afterNanoHostTransportAcknowledgement: (read, signal) =>
        storage.value.owner.afterNanoHostTransportAcknowledgement(read, signal),
      nanoHostEnrollment: { storage, commitEnroll: storage.value.enrollTransport },
      // As in App: Core decides Audit, the admitted Native owner decides Token stages.
      administratorTransport: {
        storage,
        async submit(input) {
          if (input.kind === 'lifecycle-audit' || input.kind === 'decommission-audit')
            return (await prepareNanoHostTransportWriter(db)).submit(input);
          return 'actor' in input && input.actor
            ? storage.value.owner.administerTransport(input)
            : storage.value.owner.transport(input);
        },
      },
    }),
  };
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
      const drop =
        'DROP TRIGGER IF EXISTS native_failure; DROP TRIGGER IF EXISTS readiness_refusal;';
      db.sqlite.exec(drop);
      if (raw.open) originalExec.call(raw, drop);
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
      } finally {
        for (const connection of connections) {
          connection.client.destroy();
          (connection.physical as { destroy(): void }).destroy();
          if (connection.server.listening)
            await new Promise<void>((resolve) => connection.server.close(() => resolve()));
        }
      }
    },
    close() {
      raw.close();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
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
    database,
    /** The latest admitted NanoHost storage of this root (replaced by `reopen`). */
    get storage() {
      return storage;
    },
    /** Rejoins the persisted NanoHost owner after the fixture's previous worker generation stopped. */
    async reopen() {
      storage = await reopenAdmittedTestNanoHost(db);
      return storage;
    },
    /** Durable Native rows through a fixture connection; it reads while a Native write is pending. */
    nativeDb: { sqlite: raw },
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
    // Un-spied statements on the NanoHost file: seeded and faulted rows are not Main product writes.
    nativeSql: (sql: string): Database.Statement => originalPrepare.call(raw, sql),
    commits: () => Atomics.load(gate, 2),
  };
}

function release(gate: Int32Array): void {
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  for (const deliver of interception.replies.splice(0)) deliver();
}

afterEach(async () => {
  try {
    if (interception.gate) release(new Int32Array(interception.gate));
    try {
      for (const f of fixtures) await f.joinOperations();
      for (const f of fixtures) await f.closeConnections();
    } finally {
      await shutdownControlStoreWorkerClient();
    }
  } finally {
    // A failed case must still stop its threads and remove its Main mutation denial, or every later
    // case inherits them.
    for (const worker of interception.workers.splice(0)) await worker.terminate();
    vi.restoreAllMocks();
    const writes: number[] = [];
    for (const f of fixtures.splice(0)) {
      writes.push(f.mainWrites());
      f.close();
    }
    interception.gate = undefined;
    interception.lostReply = false;
    for (const count of writes) expect(count).toBe(0);
  }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Arms actual SQL or Main ACK delivery without a product callback. */
function arm(f: Fixture, point: 1 | 2 | 3 | 5, ordinal = f.commits() + 1): void {
  Atomics.store(f.gate, 0, 0);
  Atomics.store(f.gate, 1, 0);
  Atomics.store(f.gate, 3, point);
  Atomics.store(f.gate, 4, ordinal);
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
async function loseReply(worker = interception.workers.at(-1)): Promise<void> {
  expect(worker).toBeDefined();
  interception.lostReply = true;
  await worker!.terminate();
}
function tokens(f: Fixture) {
  return f
    .nativeSql(`SELECT token_id, owner_nanohost_identity_id, deployment_id, status,
    issued_at, expires_at, predecessor_token_id, rotation_overlap_expires_at, revoked_at,
    last_used_at, last_used_channel, last_used_source FROM nanohost_transport_tokens ORDER BY token_id`)
    .all();
}
function identities(f: Fixture) {
  return f
    .nativeSql(
      'SELECT identity_id, deployment_id, status, created_at, decommissioned_at FROM nanohost_integration_identities ORDER BY identity_id'
    )
    .all();
}
function audits(f: Fixture): number {
  return f.db.sqlite.prepare('SELECT count(*) FROM audit_events').pluck().get() as number;
}
function count(f: Fixture): number {
  return f.nativeSql('SELECT count(*) FROM nanohost_transport_tokens').pluck().get() as number;
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
  // The Audit table is Core's; every NanoHost table is in the admitted NanoHost file.
  const create = table === 'audit_events' ? f.fixtureSql : f.nativeSql;
  create(`CREATE TRIGGER native_failure BEFORE ${event} ON ${table} ${condition}
    BEGIN SELECT RAISE(ABORT, 'synthetic native stage refusal'); END`).run();
}
async function issue(f: Fixture) {
  return await createNanoHostTransportTokenRecord(f.storage.value, {
    deploymentId: f.config.deploymentId,
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
  const result = await admitNativeNanoHostTransportConnection(f.storage.value, f.authority, {
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
  f.nativeSql(`INSERT INTO nanohost_integration_identities (identity_id, deployment_id, status, created_at)
    VALUES (?, 'deploy_foreign', 'active', ?)`).run(foreignIdentity, clock.toISOString());
  const token = await createNanoHostTransportTokenRecord(f.storage.value, {
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
/** Commits the original exact readiness tuple on the admitted NanoHost owner. */
async function upsertTarget(
  f: Fixture,
  input: Omit<Extract<ControlRuntimeTargetInput, { kind: 'ready' }>, 'kind'>
) {
  const outcome = await transitionAdmittedNanoHostRuntimeTarget(f.storage.value, {
    kind: 'ready',
    ...input,
  });
  if (outcome.state !== 'ready') throw new Error(`NanoHost RuntimeTarget: ${outcome.reason}`);
  return outcome.value!;
}
/** Whether a message to the control-store worker is the original RuntimeTarget tuple of this kind. */
function runtimeTargetPost(message: unknown, kind: 'allocate' | 'close'): boolean {
  const request = message as {
    operation?: string;
    mutation?: { kind?: string; input?: { input?: { kind?: string } } };
  };
  return (
    request.operation === 'nanohost-owner' &&
    request.mutation?.kind === 'runtime-target' &&
    request.mutation.input?.input?.kind === kind
  );
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
        return runtimeTargetPost(message, 'allocate');
      }).length;
    const admit = () =>
      admitNativeNanoHostTransportConnection(f.storage.value, f.authority, {
        secret: issued.secret,
        physicalConnection: physical,
        transportRevision: String(transportRevision),
      });
    // Token verification commits first; hold the real allocation's covering ACK on Main.
    arm(f, 5, f.commits() + 2);
    const winner = await held(f, admit);
    expect(allocatePosts()).toBe(1);
    expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
    expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)?.connectionGeneration).toBe(1);
    const loser = await f.track(admit());
    // NanoHost Runtime And Transport: a concurrent same-physical loser cannot consume high-water.
    expect(loser).toEqual({ ok: false, reason: 'rejected' });
    expect(allocatePosts()).toBe(1);
    expect(winner.settled()).toBe(false);
    expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)?.connectionGeneration).toBe(1);
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
    const ready = await upsertTarget(f, {
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
    expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toEqual(ready);
    expect(allocatePosts()).toBe(1);
  });

  it.each(['refused', 'unknown'] as const)(
    'requires a fresh physical connection after %s allocation without inventing a session',
    async (kind) => {
      const f = await fixture();
      const issued = await issue(f);
      const physical = await f.physical();
      const admit = (connection: object) =>
        admitNativeNanoHostTransportConnection(f.storage.value, f.authority, {
          secret: issued.secret,
          physicalConnection: connection,
          transportRevision: String(transportRevision),
        });
      if (kind === 'refused') fault(f, 'nanohost_runtime_targets', 'INSERT');
      if (kind === 'unknown') {
        arm(f, 5, f.commits() + 2);
        const pending = await held(f, () => admit(physical));
        expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)?.connectionGeneration).toBe(1);
        expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
        await loseReply();
        const outcome = await pending.result;
        expect(outcome).toEqual({
          ok: true,
          value: { ok: false, reason: 'storage_unavailable' },
        });
        release(f.gate);
        // The native writer owner requires explicit shutdown after host loss; this is no request replay.
        await shutdownControlStoreWorkerClient();
        await f.reopen();
      } else {
        expect(await f.track(admit(physical))).toEqual({
          ok: false,
          reason: 'storage_unavailable',
        });
        expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toBeNull();
        f.nativeSql('DROP TRIGGER native_failure').run();
      }
      expect(f.authority.connectionGeneration(physical)).toBeNull();
      expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
      expect(f.authority.mayCarryWork(physical)).toBe(false);
      const beforeReplay = getNanoHostRuntimeTarget(f.nativeDb, identityId);
      expect(beforeReplay?.connectionGeneration).toBe(kind === 'unknown' ? 1 : undefined);
      expect(await f.track(admit(physical))).toEqual({ ok: false, reason: 'rejected' });
      expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toEqual(beforeReplay);
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
    }
  );

  it('joins the physical close native acknowledgement before shutting down its worker', async () => {
    // Epoch retirement uses the installed deployment, not a synthetic credential-only identity.
    const f = await fixture({ useLayoutDeployment: true });
    const issued = await issue(f);
    const physical = await admitted(f, issued.secret);
    await upsertTarget(f, {
      targetId: identityId,
      identityId,
      deploymentId: f.config.deploymentId,
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
    expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toMatchObject({
      connectionGeneration: 1,
      ready: false,
    });
    const posted = vi.spyOn(interception.workers.at(-1)!, 'postMessage');
    const completions: string[] = [];
    void close.result.then(() => completions.push('close'));
    let stopped = false;
    // Match the process shutdown in index.ts: drain the authority's bound physical
    // closes before handing shutdown to the writer. This must join the original close.
    const shutdown = f
      .track(
        f.authority.closeAllPhysicalConnections().then(() => shutdownControlStoreWorkerClient())
      )
      .then(() => {
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
    expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toMatchObject({
      connectionGeneration: 1,
      ready: false,
    });
  });

  it('issues NanoHost transport credentials with Main Core mutations denied', async () => {
    const f = await fixture({ enrolled: false });
    // The Core opening and the admitted NanoHost owner opening each run their own control-store writer.
    expect(interception.workers).toHaveLength(2);
    const enrolled = await f.op('nanohost.enroll', { targetSlot: 'A', expiresAt });
    expect(f.commits()).toBe(2);
    expect(Atomics.load(f.gate, 5)).toBe(2);
    expect(getNanoHostTransportTokenRecord(f.nativeDb, enrolled.record.tokenId)).toEqual(
      enrolled.record
    );
    const oldSecret = slotSecret(f, 'A');
    expect((await verifyNanoHostTransportTokenRecord(f.storage.value, oldSecret))?.tokenId).toBe(
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
    await completeNanoHostTransportTokenCutover(f.storage.value, enrolled.record.tokenId, {
      now: clock,
    });
    expect((await verifyNanoHostTransportTokenRecord(f.storage.value, oldSecret)) === null).toBe(
      true
    );
    await f.op('credential.revoke', { kind: 'nanohost-transport', id: enrolled.record.tokenId });
    const next = await issueSlot(f);
    const foreign = await foreignAuthority(f);
    const decommissioned = await f.op('nanohost.decommission', {});
    expect(decommissioned.revokedTokenCount).toBe(1);
    expect(getNanoHostTransportTokenRecord(f.nativeDb, next.record.tokenId)?.status).toBe(
      'revoked'
    );
    expect(f.authority.mayCarryWork(foreign.physical)).toBe(true);
    expect(getNanoHostTransportTokenRecord(f.nativeDb, foreign.token.tokenId)?.status).toBe(
      'active'
    );
    expect(slotPresent(f, 'A')).toBe(false);
    expect(slotPresent(f, 'B')).toBe(false);
    expect(audits(f)).toBe(5);
    expect(JSON.stringify(enrolled).includes(oldSecret)).toBe(false);
    expect(f.db.sqlite.prepare('SELECT COUNT(*) FROM idempotency_requests').pluck().get()).toBe(0);
  });

  it.each(['enroll', 'rotate', 'abort', 'decommission'] as const)(
    'rolls back the entire %s tuple on a real later SQL fault',
    async (kind) => {
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
    }
  );

  it.each(['enroll', 'issue', 'verify', 'revoke', 'rotate', 'abort', 'decommission'] as const)(
    'holds %s success and its later effects behind the real FULL COMMIT',
    async (kind) => {
      const f = await fixture({ enrolled: kind !== 'enroll', useLayoutDeployment: true });
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
                admitNativeNanoHostTransportConnection(f.storage.value, f.authority, {
                  secret,
                  physicalConnection: live!,
                  transportRevision: String(transportRevision),
                })
            : kind === 'revoke'
              ? () => f.op('credential.revoke', { kind: 'nanohost-transport', id: predecessor! })
              : kind === 'rotate'
                ? () =>
                    f.op('nanohost.token-rotate', { tokenId: predecessor!, overlapSeconds: 3600 })
                : () => f.op('nanohost.decommission', {});
      }
      const beforeAudit = audits(f);
      const discard = vi.spyOn(f.authority, 'discardPendingSuccessor');
      if (kind === 'decommission') {
        // Main row-6 owner remains separate. This real refusal occurs after process fencing.
        f.nativeSql(
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
      if (kind === 'verify') expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toBeNull();
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
        expect(getNanoHostTransportTokenRecord(f.nativeDb, predecessor!)?.status).toBe('active');
        expect(getNanoHostTransportTokenRecord(f.nativeDb, successor!)?.status).toBe('revoked');
        expect(f.authority.mayCarryWork(live!)).toBe(true);
        expect(discard).not.toHaveBeenCalled();
      }
      if (kind === 'decommission') {
        expect(f.authority.mayCarryWork(live!)).toBe(false);
        expect(slotPresent(f, 'A')).toBe(true);
        expect(slotPresent(f, 'B')).toBe(true);
        expect(audits(f)).toBe(beforeAudit);
      }
    }
  );

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
    if (scenario === 'presented administrator' || scenario === 'derived disabled owner') {
      // The split owner drains Core before its administrator recheck. Park a real Core
      // Audit ACK, not the Native BEGIN (which occurs after this decision).
      arm(f, 2);
      const prior = await held(f, () =>
        recordNanoHostTransportAudit(f.db, {
          kind: 'lifecycle-audit',
          action: 'nanohost.transport.issue',
          record: transport.record,
          actorUserId: administratorId,
        })
      );
      const before = { tokens: tokens(f), audit: audits(f), posts: Atomics.load(f.gate, 6) };
      const joining = Promise.withResolvers<void>();
      const pause = f.client.pauseForDataRootBackup.bind(f.client);
      const coreHold = vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementation((db) => {
        const hold = pause(db);
        if (db === f.database) joining.resolve();
        return hold;
      });
      const currentActor: Actor =
        scenario === 'derived disabled owner'
          ? { kind: 'session', userId: administratorId, adminTokenId: f.admin.tokenId }
          : f.actor;
      const issuing = f
        .op('nanohost.token-issue', { targetSlot: 'A', expiresAt }, currentActor)
        .then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error })
        );
      await Promise.race([joining.promise, issuing]);
      expect(coreHold).toHaveBeenCalledWith(f.database);
      expect(prior.settled()).toBe(false);
      if (scenario === 'presented administrator')
        f.fixtureSql("UPDATE openkit_access_tokens SET status = 'revoked' WHERE token_id = ?").run(
          f.admin.tokenId
        );
      else f.fixtureSql("UPDATE users SET status = 'disabled' WHERE id = ?").run(administratorId);
      release(f.gate);
      expect(await prior.result).toMatchObject({ ok: true });
      expect(await issuing).toMatchObject({
        ok: false,
        error: NANOHOST_TRANSPORT_ADMIN_REFUSAL,
      });
      expect(tokens(f)).toEqual(before.tokens);
      expect(audits(f)).toBe(before.audit);
      expect(Atomics.load(f.gate, 6)).toBe(before.posts);
      expect(slotPresent(f, 'A')).toBe(false);
      expect(slotPresent(f, 'B')).toBe(false);
      return;
    }
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
        ? () => verifyNanoHostTransportTokenRecord(f.storage.value, transport.secret)
        : () => f.op('nanohost.token-issue', { targetSlot: 'A', expiresAt });
      arm(f, 3);
    }
    const pending = await held(f, action);
    if (scenario === 'post-ACK rotation administrator')
      f.fixtureSql("UPDATE openkit_access_tokens SET status = 'revoked' WHERE token_id = ?").run(
        f.admin.tokenId
      );
    if (scenario === 'identity binding')
      f.nativeSql(
        "UPDATE nanohost_integration_identities SET status = 'decommissioned' WHERE identity_id = ?"
      ).run(identityId);
    if (scenario === 'verification revocation')
      f.nativeSql("UPDATE nanohost_transport_tokens SET status = 'revoked' WHERE token_id = ?").run(
        transport.tokenId
      );
    if (scenario === 'verification deadlines')
      f.nativeSql('UPDATE nanohost_transport_tokens SET expires_at = ? WHERE token_id = ?').run(
        new Date(Date.now() - 1).toISOString(),
        transport.tokenId
      );
    release(f.gate);
    const outcome = await pending.result;
    if (scenario.startsWith('verification')) {
      expect(outcome.ok && outcome.value === null).toBe(true);
      expect(getNanoHostTransportTokenRecord(f.nativeDb, transport.tokenId)?.lastUsedAt).toBeNull();
      if (scenario === 'verification deadlines') {
        f.nativeSql(
          "UPDATE nanohost_transport_tokens SET expires_at = ?, status = 'rotated', rotation_overlap_expires_at = ? WHERE token_id = ?"
        ).run(expiresAt, expiresAt, transport.tokenId);
        arm(f, 3);
        const overlap = await held(f, () =>
          verifyNanoHostTransportTokenRecord(f.storage.value, transport.secret)
        );
        f.nativeSql(
          'UPDATE nanohost_transport_tokens SET rotation_overlap_expires_at = ? WHERE token_id = ?'
        ).run(new Date(Date.now() - 1).toISOString(), transport.tokenId);
        release(f.gate);
        const expiredOverlap = await overlap.result;
        expect(expiredOverlap.ok && expiredOverlap.value === null).toBe(true);
        expect(
          getNanoHostTransportTokenRecord(f.nativeDb, transport.tokenId)?.lastUsedAt
        ).toBeNull();
      }
    } else {
      expect(outcome.ok).toBe(false);
      expect(audits(f)).toBe(beforeAudit);
      expect(slotPresent(f, 'B')).toBe(false);
      if (predecessor) {
        expect(getNanoHostTransportTokenRecord(f.nativeDb, predecessor)?.status).toBe('active');
        expect(
          f
            .nativeSql(
              'SELECT status FROM nanohost_transport_tokens WHERE predecessor_token_id = ?'
            )
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
  ] as const)(
    'refuses %s after verification commits and before new work authority',
    async (scenario) => {
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
        admitNativeNanoHostTransportConnection(f.storage.value, authority, {
          secret: token.secret,
          physicalConnection: physical,
          transportRevision:
            scenario === 'wrong revision'
              ? 'unsupported-native-revision'
              : String(transportRevision),
          source: 'first-admission',
        })
      );
      expect(getNanoHostTransportTokenRecord(f.nativeDb, token.tokenId)?.lastUsedAt).not.toBeNull();
      if (scenario === 'revoked Token')
        f.nativeSql(
          "UPDATE nanohost_transport_tokens SET status = 'revoked' WHERE token_id = ?"
        ).run(token.tokenId);
      if (scenario === 'decommissioned identity')
        f.nativeSql(
          "UPDATE nanohost_integration_identities SET status = 'decommissioned' WHERE identity_id = ?"
        ).run(identityId);
      if (scenario === 'closed physical connection') {
        const closed = once(physical as import('node:events').EventEmitter, 'close');
        (physical as { destroy(): void }).destroy();
        await closed;
      }
      if (scenario === 'already admitted connection') {
        expect(getNanoHostTransportTokenRecord(f.nativeDb, token.tokenId)?.lastUsedSource).toBe(
          'first-admission'
        );
        expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toBeNull();
        const second = await admitNativeNanoHostTransportConnection(f.storage.value, authority, {
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
        expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toMatchObject({
          connectionGeneration: 1,
        });
        expect(getNanoHostTransportTokenRecord(f.nativeDb, token.tokenId)?.lastUsedSource).toBe(
          'second-admission'
        );
      }
      reload?.();
      release(f.gate);
      const outcome = await pending.result;
      expect(outcome.ok && !(outcome.value as { ok: boolean }).ok).toBe(true);
      if (scenario === 'already admitted connection') {
        expect(outcome.ok && outcome.value).toMatchObject({ ok: false, reason: 'rejected' });
        expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toMatchObject({
          connectionGeneration: 1,
        });
        expect(authority.authoritativeGeneration(identityId)).toBe(1);
        expect(authority.mayCarryWork(physical)).toBe(true);
        expect(getNanoHostTransportTokenRecord(f.nativeDb, token.tokenId)?.lastUsedSource).toBe(
          'second-admission'
        );
      } else if (scenario === 'restart-required authority')
        expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toMatchObject({
          connectionGeneration: 1,
          ready: false,
        });
      else expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toBeNull();
      expect(authority.connectionGeneration(physical)).toBe(
        scenario === 'already admitted connection' ? 1 : null
      );
    }
  );

  it.each(['enroll', 'issue', 'rotate'] as const)(
    'keeps the actual %s commit unknown after its ACK is lost',
    async (kind) => {
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
        expect(getNanoHostTransportTokenRecord(f.nativeDb, first.record.tokenId)?.status).toBe(
          'rotated'
        );
    }
  );

  it.each(['lifecycle', 'decommission'] as const)(
    'retains completed stages when the separate %s Audit insert refuses',
    async (kind) => {
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
        expect(f.nativeSql('SELECT status FROM nanohost_transport_tokens').pluck().get()).toBe(
          'active'
        );
      if (live) expect(f.authority.mayCarryWork(live)).toBe(false);
    }
  );

  it('returns the exact complete committed row when retained state changes before its ACK', async () => {
    const f = await fixture();
    arm(f, 2);
    const pending = await held(f, () => issue(f));
    const row = f
      .nativeSql('SELECT token_id FROM nanohost_transport_tokens')
      .pluck()
      .get() as string;
    const committed = getNanoHostTransportTokenRecord(f.nativeDb, row)!;
    f.nativeSql(
      "UPDATE nanohost_transport_tokens SET status = 'revoked', last_used_source = 'later-observation' WHERE token_id = ?"
    ).run(row);
    release(f.gate);
    const outcome = await pending.result;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.record).toEqual(committed);
    expect(getNanoHostTransportTokenRecord(f.nativeDb, row)?.status).toBe('revoked');
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

  it('clears only its enrollment slot after the admitted credential transaction rolls back', async () => {
    const f = await fixture({ enrolled: false });
    fault(f, 'nanohost_transport_tokens', 'INSERT');
    // The owner is already open. Hold the original enrollment just before its SQL runs,
    // then refuse the later Token insert inside the real identity-and-Token transaction.
    arm(f, 3);
    const pending = await held(f, () => f.op('nanohost.enroll', { targetSlot: 'A', expiresAt }));
    expect(slotPresent(f, 'A')).toBe(true);
    expect(count(f)).toBe(0);
    expect(identities(f)).toEqual([]);
    expect(audits(f)).toBe(0);
    release(f.gate);
    expect(await pending.result).toMatchObject({
      ok: false,
      error: { code: 'nanohost_enroll_failed', status: 400 },
    });
    expect(count(f)).toBe(0);
    expect(identities(f)).toEqual([]);
    expect(audits(f)).toBe(0);
    expect(existsSync(f.slots.A.secretPath)).toBe(false);
    expect(existsSync(f.slots.A.companionPath)).toBe(false);
    expect(slotPresent(f, 'B')).toBe(false);
  });

  it('keeps live authority and readiness when revocation definitely rolls back', async () => {
    const f = await fixture();
    const issued = await issueSlot(f);
    const live = await admitted(f, slotSecret(f, 'A'));
    const before = {
      tokens: tokens(f),
      target: getNanoHostRuntimeTarget(f.nativeDb, identityId),
      audit: audits(f),
    };
    fault(f, 'nanohost_transport_tokens', 'UPDATE');
    await failed(
      f.op('credential.revoke', { kind: 'nanohost-transport', id: issued.record.tokenId })
    );
    expect(tokens(f)).toEqual(before.tokens);
    expect(f.authority.mayCarryWork(live)).toBe(true);
    expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toEqual(before.target);
    expect(audits(f)).toBe(before.audit);
    await expect(
      f.op('credential.revoke', { kind: 'nanohost-transport', id: allocateEntityId('nhtok') })
    ).rejects.toMatchObject({ code: 'nanohost_transport_token_not_found', status: 404 });
    expect(f.authority.mayCarryWork(live)).toBe(true);
  });

  it.each(['revoke', 'decommission'] as const)(
    'fences only its identity after unknown %s commit without claiming the SQL result',
    async (kind) => {
      const f = await fixture();
      const first = await issueSlot(f);
      if (kind === 'decommission')
        await f.op('nanohost.token-rotate', {
          tokenId: first.record.tokenId,
          overlapSeconds: 3600,
        });
      const live = await admitted(f, slotSecret(f, 'A'));
      const foreign = await foreignAuthority(f);
      const beforeAudit = audits(f);
      if (kind === 'revoke') fault(f, 'nanohost_runtime_targets', 'UPDATE');
      arm(f, 2);
      const pending = await held(f, async () =>
        kind === 'revoke'
          ? f.op('credential.revoke', { kind: 'nanohost-transport', id: first.record.tokenId })
          : f.op('nanohost.decommission', {})
      );
      expect(getNanoHostTransportTokenRecord(f.nativeDb, first.record.tokenId)?.status).toBe(
        'revoked'
      );
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
      expect(getNanoHostTransportTokenRecord(f.nativeDb, foreign.token.tokenId)?.status).toBe(
        'active'
      );
      expect(slotPresent(f, 'A')).toBe(true);
      expect(audits(f)).toBe(beforeAudit);
      if (kind === 'decommission') {
        expect(slotPresent(f, 'B')).toBe(true);
        expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)?.ready).toBe(false);
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
    }
  );

  it.each(['refused', 'unknown'] as const)(
    'preserves an incomplete %s issue compensation after a real sink failure',
    async (kind) => {
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
      expect(f.nativeSql('SELECT status FROM nanohost_transport_tokens').pluck().get()).toBe(
        kind === 'refused' ? 'active' : 'revoked'
      );
      expect(audits(f)).toBe(0);
      expect(Atomics.load(f.gate, 6)).toBe(2);
      expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
      expect(existsSync(f.slots.A.secretPath)).toBe(true);
    }
  );

  it.each(['refused', 'unknown'] as const)(
    'preserves the original suffix after %s rotation-abort compensation',
    async (kind) => {
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
      expect(getNanoHostTransportTokenRecord(f.nativeDb, first.record.tokenId)?.status).toBe(
        kind === 'refused' ? 'rotated' : 'active'
      );
      expect(
        f
          .nativeSql('SELECT status FROM nanohost_transport_tokens WHERE predecessor_token_id = ?')
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
    }
  );

  it('keeps an explicitly revoked predecessor revoked when a late sink failure aborts rotation', async () => {
    const f = await fixture({ useLayoutDeployment: true });
    const first = await issueSlot(f);
    const oldSecret = slotSecret(f, 'A');
    const live = await admitted(f, oldSecret);
    const beforeAudit = audits(f);
    blockSlot(f, 'B');
    const releaseDelivery = Promise.withResolvers<void>();
    const acknowledged = Promise.withResolvers<void>();
    const owner = f.storage.value.owner;
    const administer = owner.administerTransport.bind(owner);
    vi.spyOn(owner, 'administerTransport').mockImplementation(async (input) => {
      const original = await administer(input);
      if (input.kind === 'rotate') {
        // Core authority is released after the genuine rotation ACK; pause only the
        // handler's delivery continuation, not the owner that must admit the revoke.
        acknowledged.resolve();
        await releaseDelivery.promise;
      }
      return original;
    });
    let settled = false;
    const pending = f
      .op('nanohost.token-rotate', {
        tokenId: first.record.tokenId,
        overlapSeconds: 3600,
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
      .finally(() => {
        settled = true;
      });
    try {
      expect(await Promise.race([acknowledged.promise.then(() => 'ack'), pending])).toBe('ack');
      expect(getNanoHostTransportTokenRecord(f.nativeDb, first.record.tokenId)?.status).toBe(
        'rotated'
      );
      const successorId = f
        .nativeSql('SELECT token_id FROM nanohost_transport_tokens WHERE predecessor_token_id = ?')
        .pluck()
        .get(first.record.tokenId) as string;
      expect(getNanoHostTransportTokenRecord(f.nativeDb, successorId)?.status).toBe('active');
      const revoked = await f.op('credential.revoke', {
        kind: 'nanohost-transport',
        id: first.record.tokenId,
      });
      expect(revoked.status).toBe('revoked');
      const revokedAt = getNanoHostTransportTokenRecord(
        f.nativeDb,
        first.record.tokenId
      )?.revokedAt;
      expect(revokedAt).not.toBeNull();
      expect(settled).toBe(false);
      expect(f.authority.mayCarryWork(live)).toBe(false);
      expect(audits(f)).toBe(beforeAudit + 1);
      releaseDelivery.resolve();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok)
        expect(outcome.error).toMatchObject({
          code: 'nanohost_transport_rotate_failed',
          status: 400,
        });
      expect(getNanoHostTransportTokenRecord(f.nativeDb, first.record.tokenId)?.status).toBe(
        'revoked'
      );
      expect(getNanoHostTransportTokenRecord(f.nativeDb, first.record.tokenId)?.revokedAt).toBe(
        revokedAt
      );
      expect(getNanoHostTransportTokenRecord(f.nativeDb, successorId)?.status).toBe('revoked');
      expect(
        f
          .nativeSql(
            "SELECT count(*) FROM nanohost_transport_tokens WHERE status IN ('active', 'rotated')"
          )
          .pluck()
          .get()
      ).toBe(0);
      expect(await verifyNanoHostTransportTokenRecord(f.storage.value, oldSecret)).toBeNull();
      expect(f.authority.mayCarryWork(live)).toBe(false);
      expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
      expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)?.ready).toBe(false);
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
    } finally {
      releaseDelivery.resolve();
    }
  });

  it('preserves a fresh enrollment slot while earlier decommission cleanup is pending', async () => {
    const f = await fixture({ useLayoutDeployment: true });
    const original = await issueSlot(f);
    const live = await admitted(f, slotSecret(f, 'A'));
    const beforeAudit = audits(f);
    expect(slotPresent(f, 'B')).toBe(false);
    expect(f.authority.mayCarryWork(live)).toBe(true);
    const finishing = Promise.withResolvers<void>();
    const acknowledged = Promise.withResolvers<void>();
    const owner = f.storage.value.owner;
    const transition = owner.transitionRuntimeTarget.bind(owner);
    vi.spyOn(owner, 'transitionRuntimeTarget').mockImplementation(async (kernel, input) => {
      const original = await transition(kernel, input);
      if (input.input.kind === 'close' && original.state === 'ready') {
        // Enrollment itself joins any outstanding owner ACK. Hold the old handler
        // after its real fence, before it may clear slots, not the Native owner.
        acknowledged.resolve();
        await finishing.promise;
      }
      return original;
    });
    let decommissionSettled = false;
    const decommission = f
      .op('nanohost.decommission', {})
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
      .finally(() => {
        decommissionSettled = true;
      });
    try {
      expect(await Promise.race([acknowledged.promise.then(() => 'ack'), decommission])).toBe(
        'ack'
      );
      expect(getNanoHostTransportTokenRecord(f.nativeDb, original.record.tokenId)?.status).toBe(
        'revoked'
      );
      expect(identities(f)).toMatchObject([{ status: 'decommissioned' }]);
      expect(slotPresent(f, 'A')).toBe(true);
      expect(f.authority.mayCarryWork(live)).toBe(false);
      arm(f, 1);
      const enrollment = await held(f, () =>
        f.op('nanohost.enroll', { targetSlot: 'B', expiresAt })
      );
      expect(enrollment.settled()).toBe(false);
      expect(decommissionSettled).toBe(false);
      expect(slotPresent(f, 'B')).toBe(true);
      const freshId = readNanoHostCredentialSlotTokenId(f.slots.B)!;
      const freshSecret = readFileSync(f.slots.B.secretPath);
      const freshCompanion = readFileSync(f.slots.B.companionPath);
      expect(freshId).not.toBe(original.record.tokenId);
      expect(getNanoHostTransportTokenRecord(f.nativeDb, freshId)).toBeNull();
      release(f.gate);
      const freshOutcome = await enrollment.result;
      expect(freshOutcome).toMatchObject({ ok: true, value: { record: { tokenId: freshId } } });
      expect(decommissionSettled).toBe(false);
      finishing.resolve();
      expect(await decommission).toMatchObject({
        ok: false,
        error: { message: 'NanoHost credential slot changed before decommission cleanup.' },
      });
      expect(slotPresent(f, 'A')).toBe(false);
      expect(slotPresent(f, 'B')).toBe(true);
      expect(readFileSync(f.slots.B.secretPath).equals(freshSecret)).toBe(true);
      expect(readFileSync(f.slots.B.companionPath).equals(freshCompanion)).toBe(true);
      expect(getNanoHostTransportTokenRecord(f.nativeDb, original.record.tokenId)?.status).toBe(
        'revoked'
      );
      expect(getNanoHostTransportTokenRecord(f.nativeDb, freshId)?.status).toBe('active');
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
    } finally {
      finishing.resolve();
    }
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
    expect(getNanoHostTransportTokenRecord(f.nativeDb, first.record.tokenId)?.status).toBe(
      'rotated'
    );
    expect(
      f
        .nativeSql('SELECT status FROM nanohost_transport_tokens WHERE predecessor_token_id = ?')
        .pluck()
        .get(first.record.tokenId)
    ).toBe('active');
    expect(f.commits()).toBe(before.commits + 1);
    expect(Atomics.load(f.gate, 6) - before.calls).toBe(1);
    expect(audits(f)).toBe(before.audit);
    expect(slotPresent(f, 'A')).toBe(true);
  });

  it.each(['enroll', 'decommission'] as const)(
    'does not undo %s when its later Audit commit ACK is lost',
    async (kind) => {
      const f = await fixture({ enrolled: kind === 'decommission', useLayoutDeployment: true });
      let live: object | undefined;
      if (kind === 'decommission') {
        await rotation(f);
        live = await admitted(f, slotSecret(f, 'A'));
      }
      const before = { audit: audits(f), commits: f.commits() };
      const auditOwners: NativeWorker[] = [];
      for (const worker of interception.workers) {
        const post = worker.postMessage.bind(worker);
        vi.spyOn(worker, 'postMessage').mockImplementation((value, transfers) => {
          const message = value as {
            operation?: string;
            input?: { kind?: string; action?: string };
          };
          if (
            message.operation === 'nanohost-transport' &&
            (kind === 'decommission'
              ? message.input?.kind === 'decommission-audit'
              : message.input?.kind === 'lifecycle-audit' &&
                message.input.action === 'nanohost.transport.enroll')
          ) {
            auditOwners.push(worker);
            arm(f, 2);
          }
          return post(value, transfers);
        });
      }
      // Arm only when the exact Core Audit is posted, after any Native physical close.
      const coveringCommits = kind === 'decommission' ? 3 : 2;
      const pending = await held(f, async () =>
        kind === 'enroll'
          ? f.op('nanohost.enroll', { targetSlot: 'A', expiresAt })
          : f.op('nanohost.decommission', {})
      );
      expect(audits(f)).toBe(before.audit + 1);
      expect(slotPresent(f, 'A')).toBe(kind === 'enroll');
      if (live) expect(f.authority.mayCarryWork(live)).toBe(false);
      expect(auditOwners).toHaveLength(1);
      await loseReply(auditOwners[0]);
      expect((await pending.result).ok).toBe(false);
      expect(f.commits()).toBe(before.commits + coveringCommits);
      expect(identities(f)).toMatchObject([
        { status: kind === 'enroll' ? 'active' : 'decommissioned' },
      ]);
      expect(slotPresent(f, 'A')).toBe(kind === 'enroll');
      expect(slotPresent(f, 'B')).toBe(false);
    }
  );
});

it('joins an allocated admission and its physical-close producer before native shutdown', async () => {
  const f = await fixture();
  const issued = await issue(f);
  const physical = await f.physical();
  const posted = vi.spyOn(interception.workers.at(-1)!, 'postMessage');
  arm(f, 5, f.commits() + 2);
  const admission = await held(f, () =>
    admitNativeNanoHostTransportConnection(f.storage.value, f.authority, {
      secret: issued.secret,
      physicalConnection: physical,
      transportRevision: String(transportRevision),
    })
  );
  // The actual allocation committed, but Main has not received its reply or bound the connection.
  expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)?.connectionGeneration).toBe(1);
  (physical as import('node:http2').Http2Session).destroy();
  const shutdown = f.track(shutdownControlStoreWorkerClient());
  release(f.gate);
  await expect(admission.result).resolves.toMatchObject({
    ok: true,
    value: { ok: false, reason: 'rejected' },
  });
  await shutdown;
  const commands = posted.mock.calls.map(([message]) => message as { operation?: string });
  const closeIndex = commands.findIndex((value) => runtimeTargetPost(value, 'close'));
  const shutdownIndex = commands.findIndex((value) => value.operation === 'shutdown');
  expect(closeIndex).toBeGreaterThanOrEqual(0);
  expect(shutdownIndex).toBeGreaterThan(closeIndex);
  expect(f.authority.authoritativeGeneration(identityId)).toBeNull();
  expect(getNanoHostRuntimeTarget(f.nativeDb, identityId)).toMatchObject({
    connectionGeneration: 1,
    ready: false,
  });
});
