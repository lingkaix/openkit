import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { PrepareWorkerEnvironmentResponse } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { FsStore } from '../lib/store.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from '../runtime/nanohost-session-dispatch.js';
import { writeWorkerImageSettlement } from '../runtime/worker-image-settlements.js';
import * as bindings from '../runtime/worker-storage-bindings.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  ensureUserQuickChatWorkspace,
  publishWorkspaceOwnerMembership,
} from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

// Only the original public receipts and their separate maintenance are under test.
// Native Artifact/Turn/image admission/Core purge tuples retain their existing owners.
const faults = vi.hoisted(() => ({
  readonlyMain: false,
  sqliteFault: false,
  workers: [] as NativeWorker[],
  posts: [] as unknown[],
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
}));

vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  const observe = <
    T extends
      | ReturnType<typeof actual.openCoreDb>
      | ReturnType<typeof actual.openUserDb>
      | ReturnType<typeof actual.openWorkspaceDb>,
  >(
    db: T
  ): T => {
    if (faults.readonlyMain) db.sqlite.pragma('query_only = ON');
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    db.sqlite.prepare = ((sql: string) => {
      const statement = prepare(sql);
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        try {
          return run(...args);
        } catch (error) {
          const actualError = error as { code?: string; message?: string };
          if (
            actualError.code?.startsWith('SQLITE_CONSTRAINT') &&
            actualError.message === 'Worker environment receipt fault'
          )
            faults.sqliteFault = true;
          if (actualError.code?.startsWith('SQLITE_READONLY'))
            console.info('Original Main Worker environment receipt SQLite refused', {
              scope: db.scope,
              sqlOperation: /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),
              code: actualError.code,
            });
          throw error;
        }
      };
      return statement;
    }) as typeof db.sqlite.prepare;
    return db;
  };
  return {
    ...actual,
    openCoreDb: (...args: Parameters<typeof actual.openCoreDb>) =>
      observe(actual.openCoreDb(...args)),
    openUserDb: (...args: Parameters<typeof actual.openUserDb>) =>
      observe(actual.openUserDb(...args)),
    openWorkspaceDb: (...args: Parameters<typeof actual.openWorkspaceDb>) =>
      observe(actual.openWorkspaceDb(...args)),
  };
});

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = faults.workers.length;
        const prelude = `
        const { workerData } = require('node:worker_threads');
        const Database = require(workerData.receiptModule);
        const prepare = Database.prototype.prepare;
        const exec = Database.prototype.exec;
        const maintenance = new WeakSet();
        const gate = workerData.receiptGate;
        const requestId = () => Buffer.from(workerData.receiptRequest).toString('ascii');
        const retained = (db) => prepare.call(db, "SELECT 1 FROM idempotency_requests WHERE request_id=? AND command_name IN ('worker_environment.prepare','worker_environment.activate','worker_environment.purge')").get(requestId());
        Database.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          const deletion = /^DELETE\\s+FROM\\s+idempotency_requests/i.test(sql.trim());
          if (deletion || /^INSERT.*INTO\\s+idempotency_requests/i.test(sql.trim())) {
            const db = this;
            const run = statement.run;
            statement.run = function(...args) {
              try {
                const value = run.apply(this, args);
                if (deletion && retained(db)) maintenance.add(db);
                return value;
              } catch (error) {
                if (error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'Worker environment receipt fault') Atomics.store(gate, 3, 1);
                throw error;
              }
            };
          }
          return statement;
        };
        Database.prototype.exec = function(sql) {
          const value = exec.call(this, sql);
          if (!/^COMMIT$/i.test(sql) || !Atomics.load(gate, 1)) return value;
          if (!prepare.call(this, "SELECT 1 FROM sqlite_master WHERE name='idempotency_requests'").get() || !retained(this)) return value;
          const stage = Atomics.load(gate, 1);
          if (((stage === 1 && !maintenance.has(this)) || (stage === 2 && maintenance.has(this))) && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
            Atomics.store(gate, 4, this.pragma('synchronous', {simple:true}));
            Atomics.store(gate, 5, workerData.receiptWorker);
            Atomics.wait(gate, 2, 0);
          }
          return value;
        };
      `;
        super(
          prelude +
            (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
          {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              receiptModule: require.resolve('better-sqlite3'),
              receiptGate: new Int32Array(faults.gate),
              receiptRequest: new Uint8Array(faults.request),
              receiptWorker: index,
            },
          }
        );
        faults.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        faults.posts.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});

type Kind = 'prepare' | 'activate' | 'purge';
const kinds = ['prepare', 'activate', 'purge'] as const;
const agentId = 'agent_codex_host';
const configurationFile = 'agents/codex.agent.jsonc';
const imageDigest = `sha256:${'d'.repeat(64)}`;
const imageInspection = {
  digest: imageDigest,
  platform: { architecture: 'arm64', os: 'linux' },
  storageLayout: {
    family: 'openkit-worker',
    gid: 1000,
    targets: [{ target: '/sandbox' }, { target: '/workspace' }],
    uid: 1000,
    version: '1',
    workingDirectory: '/tmp/openkit-bootstrap',
  },
  environmentDefaults: {
    defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
    values: {},
  },
} as const;
const declaration = {
  kind: 'reference' as const,
  pullPolicy: 'if-not-present' as const,
  ref: 'registry.example.com/openkit/worker:receipt-fixture',
};
const release = () => {
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
};
const observed = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );

/** Enters the actual App owners with a real Core/private Workspace and fixed external host effects. */
async function fixture(kind: Kind) {
  release();
  new Int32Array(faults.gate).fill(0);
  faults.readonlyMain = false;
  faults.sqliteFault = false;
  const dataRoot = mkdtempSync(join(tmpdir(), 'worker-environment-receipt-native-'));
  const store = await createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  await ensureUserQuickChatWorkspace({ coreDb, store, userId });
  const home = await store.ensureQuickChatWorkspace(userId);
  const thread = await store.createThread(
    home.id,
    'Administration',
    testEntityId('th', randomUUID()),
    'administration',
    { visibility: 'private', privateOwnerUserId: userId }
  );
  const workspaceDb = openWorkspaceDb(dataRoot, home.id);
  applyScopedMigrations(workspaceDb);
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  const foreignWorkspace = store.listWorkspaces().find((candidate) => candidate.id !== home.id)!;
  const foreignDb = openWorkspaceDb(dataRoot, foreignWorkspace.id);
  applyScopedMigrations(foreignDb);
  onTestFinished(async () => {
    release();
    faults.readonlyMain = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    for (const db of [foreignDb, workspaceDb, userDb, coreDb])
      if (db.sqlite.open) db.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const effects = vi.fn(async (request: NanoHostSessionEffectRequest) => {
    if (request.kind === 'image.acquire') return { digest: imageDigest };
    if (request.kind === 'image.inspect') return imageInspection;
    if (request.kind === 'storage.purge')
      return { state: 'purged', storageRef: (request.input as { storageRef: string }).storageRef };
    throw new Error('Unexpected external Worker environment effect.');
  });
  // The host effect is external. Its real Core image settlement stays native and durable.
  const dispatch: NanoHostSessionDispatch = {
    async effect(first, second) {
      const request = (second ?? first) as NanoHostSessionEffectRequest;
      const result = await effects(request);
      if (
        request.imageSettlement &&
        (request.kind === 'image.acquire' || request.kind === 'image.build')
      )
        await writeWorkerImageSettlement(coreDb, {
          ...request.imageSettlement,
          requestId: request.requestId,
          operation: request.kind,
          outcome: { kind: 'success', imageDigest: (result as { digest: string }).digest },
        });
      return result;
    },
    async fileExportResult() {},
    async imageBuildInput() {
      throw new Error('Unexpected build input.');
    },
    async poll() {
      return null;
    },
    async result() {},
    async route() {
      throw new Error('Unexpected semantic route.');
    },
  };
  const makeApp = (selectedStore: FsStore) =>
    createAppWithLocalIdentity({
      coreDb,
      dataRoot,
      mode: 'local',
      llmGatewayDispatcher: {
        createResponses: async () => {
          throw new Error('Private administration must not dispatch inference.');
        },
      },
      nanoHostSessionDispatch: dispatch,
      store: selectedStore,
    });
  const app = makeApp(store);
  await publishWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: userId,
    workspaceId: foreignWorkspace.id,
  });
  const foreignRequestId = randomUUID();
  const foreignResult = await app.request(
    ...operationRequest(
      'workspace.update',
      { workspaceId: foreignWorkspace.id },
      {
        body: JSON.stringify({
          requestId: foreignRequestId,
          name: 'Actual other physical Workspace receipt',
        }),
      }
    )
  );
  expect(foreignResult.status).toBe(200);
  const foreignRows = () =>
    foreignDb.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(foreignRequestId);
  const foreignReceipt = foreignRows();
  expect(foreignReceipt).toHaveLength(1);
  const configPath = join(dataRoot, 'config', configurationFile);
  const prepareInput = (requestId: string) => ({
    administrationThreadId: thread.id,
    configuration: {
      expectedRevision: `sha256:${createHash('sha256').update(readFileSync(configPath)).digest('hex')}`,
      fileId: configurationFile,
    },
    declaration,
    replaceNow: null,
    requestId,
    target: { agentId, kind: 'agent' as const },
  });
  const request = (
    selectedApp: typeof app,
    operation:
      | 'worker-environment.prepare'
      | 'worker-environment.activate'
      | 'worker-environment.recover'
      | 'worker-environment.purge',
    body: object,
    workspaceId?: string
  ) =>
    selectedApp.request(
      ...operationRequest(operation, workspaceId ? { workspaceId } : {}, {
        body: JSON.stringify(body),
      })
    );
  const peerId = randomUUID();
  const peerResult = await request(app, 'worker-environment.prepare', prepareInput(peerId));
  expect(peerResult.status).toBe(200);
  const prepared = (await peerResult.json()) as PrepareWorkerEnvironmentResponse;
  let binding: bindings.WorkerStorageBinding | undefined;
  if (kind === 'purge') {
    const target = await recordTestNativeRuntimeTarget(coreDb);
    const reserved = await bindings.createAndReserveWorkerStorageAttachment(coreDb, {
      agentSessionId: testEntityId('as', randomUUID()),
      authorizeContributor: () => true,
      deploymentId: target.deploymentId,
      layout: { ...imageInspection.storageLayout, platform: imageInspection.platform },
      purpose: 'work',
      responsibleUserId: userId,
      runtimeTargetId: target.targetId,
      threadId: thread.id,
      workspaceId: home.id,
    });
    const attached = await bindings.activateWorkerStorageAttachment(coreDb, {
      attachmentGeneration: reserved.attachmentGeneration,
      expectedRevision: reserved.revision,
      sandboxBindingRef: 'receipt_fixture_binding',
      storageRef: reserved.storageRef,
      targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
    });
    binding = await bindings.releaseWorkerStorageAttachment(coreDb, {
      attachmentGeneration: attached.attachmentGeneration,
      cleanupProved: true,
      expectedRevision: attached.revision,
      sandboxBindingRef: 'receipt_fixture_binding',
      storageRef: attached.storageRef,
    });
  }
  const requestId = randomUUID();
  new Uint8Array(faults.request).set(new TextEncoder().encode(requestId));
  const command = `worker_environment.${kind}` as const;
  const body =
    kind === 'prepare'
      ? prepareInput(requestId)
      : kind === 'activate'
        ? {
            affectedStorage: prepared.affectedStorage,
            configuration: prepared.configuration,
            confirmation: prepared.activationConfirmation,
            replaceNow: prepared.replaceNow,
            requestId,
            resolvedCandidate: prepared.resolvedCandidate,
            target: prepared.target,
          }
        : {
            confirmation: `purge-worker-environment:${binding!.storageRef}:${binding!.revision}`,
            expectedRevision: binding!.revision,
            requestId,
            storageRef: binding!.storageRef,
          };
  const operation = `worker-environment.${kind}` as const;
  const call = (selectedApp = app) =>
    request(selectedApp, operation, body, kind === 'purge' ? home.id : undefined);
  const recover = (selectedApp = app) =>
    request(selectedApp, 'worker-environment.recover', {
      administrationThreadId: thread.id,
      recoverFrom: prepared.authoredCandidate,
      requestId,
    });
  const rows = (id = requestId) =>
    workspaceDb.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(id);
  const snapshot = (selectedStore = store) => ({
    // Live insertion and cold inventory hydration have no shared list-order contract.
    artifacts: selectedStore
      .listArtifacts(home.id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    turns: selectedStore.listThreadTurns(home.id, thread.id),
    items: selectedStore.listThreadItems(home.id, thread.id),
    configuration: readFileSync(configPath, 'utf8'),
    foreignReceipt: foreignRows(),
    binding: binding
      ? bindings.getWorkerStorageBinding(coreDb, { storageRef: binding.storageRef })
      : null,
  });
  const queryOnly = () => {
    faults.readonlyMain = true;
    for (const db of [coreDb, userDb, workspaceDb, foreignDb]) {
      db.sqlite.pragma('query_only = ON');
      expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
    }
  };
  const trigger = (event: 'INSERT' | 'DELETE', id = requestId) =>
    workspaceDb.sqlite.exec(
      `CREATE TRIGGER refuse_environment_receipt BEFORE ${event} ON idempotency_requests WHEN ${event === 'INSERT' ? 'NEW' : 'OLD'}.request_id='${id}' BEGIN SELECT RAISE(ABORT, 'Worker environment receipt fault'); END`
    );
  const cold = async () => {
    await shutdownControlStoreWorkerClient();
    const reopened = new FsStore({ dataRoot });
    return { store: reopened, app: makeApp(reopened) };
  };
  return {
    kind,
    dataRoot,
    store,
    coreDb,
    userDb,
    workspaceDb,
    foreignDb,
    foreignReceipt,
    home,
    thread,
    userId,
    requestId,
    command,
    app,
    call,
    recover,
    rows,
    peerId,
    prepared,
    effects,
    snapshot,
    queryOnly,
    trigger,
    cold,
  };
}

/** Observes the actual final product ACK before the separate original receipt. */
function afterProduct(f: Awaited<ReturnType<typeof fixture>>, action: () => void) {
  if (f.kind === 'purge') {
    const settle = bindings.settleWorkerStoragePurge;
    vi.spyOn(bindings, 'settleWorkerStoragePurge').mockImplementation(async (...args) => {
      const result = await settle(...args);
      action();
      return result;
    });
  } else {
    const update = f.store.updateTurn.bind(f.store);
    vi.spyOn(f.store, 'updateTurn').mockImplementation(async (...args) => {
      const result = await update(...args);
      if (args[1].status === 'completed') action();
      return result;
    });
  }
}

it.each(kinds)(
  'retains the original %s effect prefix after a genuine late public receipt INSERT refusal',
  async (kind) => {
    const f = await fixture(kind);
    const before = f.snapshot();
    f.trigger('INSERT');
    const first = await f.call();
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(faults.sqliteFault || Atomics.load(new Int32Array(faults.gate), 3) === 1).toBe(true);
    expect(f.rows()).toEqual([]);
    const retained = f.snapshot();
    expect(retained).not.toEqual(before);
    expect(retained.foreignReceipt).toEqual(before.foreignReceipt);
    if (kind !== 'purge') {
      const results = retained.artifacts.filter(
        (artifact) =>
          artifact.origin.kind === 'turn-output' && artifact.origin.requestId === f.requestId
      );
      expect(results).toHaveLength(kind === 'prepare' ? 2 : 1);
      for (const artifact of results) {
        expect(artifact).toMatchObject({
          version: 1,
          status: 'ready',
          kind: 'report',
          origin: { kind: 'turn-output', requestId: f.requestId, threadId: f.thread.id },
        });
        expect(retained.turns.find((turn) => turn.id === artifact.turnId)).toMatchObject({
          status: 'completed',
        });
      }
    }
    if (kind === 'purge') expect(retained.binding).toMatchObject({ state: 'purged' });
    if (kind === 'activate') expect(retained.configuration).not.toBe(before.configuration);
    f.workspaceDb.sqlite.exec('DROP TRIGGER refuse_environment_receipt');
    const count = f.effects.mock.calls.length;
    const cold = await f.cold();
    expect(f.snapshot(cold.store)).toEqual(retained);
    const replay = await f.call(cold.app);
    if (kind === 'prepare') {
      expect(replay.status).toBe(200);
      expect(f.rows()).toHaveLength(1);
    } else {
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(f.rows()).toEqual([]);
      if (kind === 'activate')
        expect(await replay.json()).toMatchObject({ code: 'recovery_required' });
    }
    expect(f.snapshot(cold.store)).toEqual(retained);
    expect(f.effects).toHaveBeenCalledTimes(count);
  }
);

it.each(kinds)(
  'keeps the original %s receipt committed when its separate post-product prune fails',
  async (kind) => {
    const f = await fixture(kind);
    const peer = f.rows(f.peerId);
    expect(peer).toHaveLength(1);
    const expiry = Date.parse((peer[0] as { expires_at: string }).expires_at);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(expiry - 60_000));
      afterProduct(f, () => {
        f.trigger('DELETE', f.peerId);
        vi.setSystemTime(new Date(expiry + 60_000));
      });
      const result = await f.call();
      const receipt = f.rows();
      expect(receipt).toHaveLength(1);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(faults.sqliteFault || Atomics.load(new Int32Array(faults.gate), 3) === 1).toBe(true);
      expect(f.rows(f.peerId)).toEqual(peer);
      const product = f.snapshot();
      const effects = f.effects.mock.calls.length;
      f.workspaceDb.sqlite.exec('DROP TRIGGER refuse_environment_receipt');
      vi.restoreAllMocks();
      const cold = await f.cold();
      const replay = await f.call(cold.app);
      expect(replay.status).toBe(200);
      expect(f.rows()).toEqual(receipt);
      expect(f.snapshot(cold.store)).toEqual(product);
      expect(f.effects).toHaveBeenCalledTimes(effects);
    } finally {
      vi.useRealTimers();
    }
  }
);

it('uses the original post-effect clock for Worker environment receipt maintenance', async () => {
  const f = await fixture('prepare');
  const peer = f.rows(f.peerId);
  expect(peer).toHaveLength(1);
  const expiry = Date.parse((peer[0] as { expires_at: string }).expires_at);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(expiry - 60_000));
    let completed = false;
    afterProduct(f, () => {
      completed = true;
      vi.setSystemTime(new Date(expiry + 60_000));
    });
    expect((await f.call()).status).toBe(200);
    expect(completed).toBe(true);
    expect(f.rows()).toHaveLength(1);
    expect(f.rows(f.peerId)).toEqual([]);
    expect(f.snapshot().foreignReceipt).toEqual(f.foreignReceipt);
  } finally {
    vi.useRealTimers();
  }
});

it.each(kinds)(
  'publishes %s with every Main database query-only and exact original Workspace receipt provenance',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const result = await f.call();
    expect(result.status).toBe(200);
    const response = await result.json();
    const receipt = f.rows();
    expect(receipt).toHaveLength(1);
    const activationResults =
      kind === 'activate'
        ? f.store
            .listArtifacts(f.home.id)
            .filter(
              (artifact) =>
                artifact.origin.kind === 'turn-output' &&
                artifact.origin.requestId === f.requestId &&
                artifact.kind === 'report'
            )
        : [];
    if (kind === 'activate') {
      expect(activationResults).toHaveLength(1);
      expect(JSON.parse(activationResults[0]!.content.body)).toEqual(response);
    }
    expect(receipt[0]).toMatchObject({
      command_name: f.command,
      response_kind: kind === 'purge' ? 'worker_environment' : 'artifact',
      response_id:
        kind === 'prepare'
          ? response.resolvedCandidate.artifactId
          : kind === 'purge'
            ? response.storageRef
            : activationResults[0]!.id,
    });
    expect(JSON.parse((receipt[0] as { scope_json: string }).scope_json)).toEqual(
      kind === 'purge'
        ? { actorId: f.userId, storageRef: response.storageRef, workspaceId: f.home.id }
        : { actorId: f.userId, threadId: f.thread.id, workspaceId: f.home.id }
    );
    for (const db of [f.coreDb, f.userDb, f.foreignDb])
      expect(
        db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(f.requestId)
      ).toEqual([]);
    const retained = f.snapshot();
    const effects = f.effects.mock.calls.length;
    const posts = faults.posts.length;
    expect((await f.call()).status).toBe(200);
    expect(faults.posts).toHaveLength(posts);
    const cold = await f.cold();
    expect((await f.call(cold.app)).status).toBe(200);
    expect(f.snapshot(cold.store)).toEqual(retained);
    expect(f.rows()).toEqual(receipt);
    expect(f.effects).toHaveBeenCalledTimes(effects);
  }
);

it.each(kinds)(
  'preserves every %s public receipt and maintenance FULL prefix under genuine lost ACK without effect repeat',
  async (kind) => {
    for (const stage of [1, 2] as const) {
      const f = await fixture(kind);
      f.queryOnly();
      const gate = new Int32Array(faults.gate);
      Atomics.store(gate, 1, stage);
      let finished = false;
      const pending = observed(
        f.call().finally(() => {
          finished = true;
        })
      );
      await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
      expect(finished).toBe(false);
      expect(Atomics.load(gate, 4)).toBe(2);
      const receipt = f.rows();
      expect(receipt).toHaveLength(1);
      const product = f.snapshot();
      const effects = f.effects.mock.calls.length;
      const posts = faults.posts.length;
      await faults.workers[Atomics.load(gate, 5)]!.terminate();
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw outcome.error;
      expect(outcome.value.status).toBeGreaterThanOrEqual(400);
      expect(faults.posts).toHaveLength(posts);
      expect(f.rows()).toEqual(receipt);
      release();
      const warm = await f.call();
      expect(warm.status).toBe(200);
      expect(faults.posts).toHaveLength(posts);
      expect(f.rows()).toEqual(receipt);
      expect(f.snapshot()).toEqual(product);
      expect(f.effects).toHaveBeenCalledTimes(effects);
      const cold = await f.cold();
      expect((await f.call(cold.app)).status).toBe(200);
      expect(f.rows()).toEqual(receipt);
      expect(f.snapshot(cold.store)).toEqual(product);
      expect(f.effects).toHaveBeenCalledTimes(effects);
    }
  }
);

it.each(kinds)(
  'retains the %s receipt but refuses response disclosure after a real maintenance ACK crosses administrator loss',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const gate = new Int32Array(faults.gate);
    Atomics.store(gate, 1, 2);
    const result = observed(f.call());
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
    expect(Atomics.load(gate, 4)).toBe(2);
    const receipt = f.rows();
    expect(receipt).toHaveLength(1);
    const retained = f.snapshot();
    const revoker = openCoreDb(f.dataRoot);
    revoker.sqlite.pragma('query_only = OFF');
    try {
      revoker.sqlite.transaction(() => disableCanonicalUser(revoker, f.userId))();
    } finally {
      revoker.sqlite.close();
    }
    release();
    const response = await result;
    expect(response.ok).toBe(true);
    if (!response.ok) throw response.error;
    expect(response.value.status).toBeGreaterThanOrEqual(400);
    const refusal = await response.value.json();
    expect(refusal).not.toHaveProperty('resolvedCandidate');
    expect(refusal).not.toHaveProperty(
      kind === 'purge' ? 'environment' : kind === 'activate' ? 'configuration' : 'authoredCandidate'
    );
    expect(f.rows()).toEqual(receipt);
    expect(f.snapshot()).toEqual(retained);
  }
);

it('admits the original running activation Turn and status Item before its real configuration update', async () => {
  const f = await fixture('activate');
  const update = RuntimeConfigFileService.prototype.updateFile;
  let observedAdmission = false;
  vi.spyOn(RuntimeConfigFileService.prototype, 'updateFile').mockImplementation(async function (
    ...args
  ) {
    const turns = f.store.listThreadTurns(f.home.id, f.thread.id);
    const running = turns.filter((turn) => turn.status === 'running');
    expect(running).toHaveLength(1);
    expect(
      f.store
        .listThreadItems(f.home.id, f.thread.id)
        .some(
          (item) =>
            item.turnId === running[0]!.id &&
            item.type === 'status' &&
            item.title === 'Activating Worker environment'
        )
    ).toBe(true);
    expect(f.rows()).toEqual([]);
    observedAdmission = true;
    return update.apply(this, args);
  });
  expect((await f.call()).status).toBe(200);
  expect(observedAdmission).toBe(true);
  expect(f.rows()).toHaveLength(1);
});

it('repairs an original recovery receipt from the retained candidate pair after a genuine late INSERT fault without recovering or acquiring an image again', async () => {
  const f = await fixture('prepare');
  const retained = f.snapshot();
  const effects = f.effects.mock.calls.length;
  f.trigger('INSERT');
  const first = await f.recover();
  expect(first.status).toBeGreaterThanOrEqual(400);
  expect(faults.sqliteFault || Atomics.load(new Int32Array(faults.gate), 3) === 1).toBe(true);
  expect(f.rows()).toEqual([]);
  expect(f.snapshot()).toEqual(retained);
  f.workspaceDb.sqlite.exec('DROP TRIGGER refuse_environment_receipt');
  const cold = await f.cold();
  const response = await f.recover(cold.app);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    requestId: f.requestId,
    authoredCandidate: f.prepared.authoredCandidate,
    resolvedCandidate: f.prepared.resolvedCandidate,
  });
  expect(f.rows()).toHaveLength(1);
  expect(f.snapshot(cold.store)).toEqual(retained);
  expect(f.effects).toHaveBeenCalledTimes(effects);
});
