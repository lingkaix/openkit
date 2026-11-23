import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { settlePreparedNanoHostImage } from '../app.js';
import { getLocalUserId } from '../auth/identity.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { readCoreImageAcquisitionRef } from '../storage/core-journal-native.js';
import { openCoreDb, serverStoragePath } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
  reopenAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import { heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  recordTestNativeRuntimeTarget,
  transitionTestNativeRuntimeTargetFields,
} from '../test-support/native-environment.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import {
  createTestServerThread,
  createTestServerWorkStore,
} from '../test-support/server-work-store.js';
import { shutdownTestStoreWorker } from '../test-support/store.js';
import { publishCoreJournal } from './core-journal-owner.js';
import type { ExecutionStepControl } from './execution-step-journal.js';
import { commandInputHash } from './idempotent-command.js';
import {
  createNanoHostSessionDispatch,
  type SettleNanoHostPreparedImage,
} from './nanohost-session-dispatch.js';
import { createWorkerEnvironmentRuntimeEffects } from './worker-environment-runtime-effects.js';
import {
  readAdmittedWorkerImageEnvironment,
  readWorkerImageSettlement,
  type writeWorkerImageSettlement,
} from './worker-image-settlements.js';

// The shared hook preserves the actual Worker and its SQLite COMMIT.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const imageDigest = `sha256:${'d'.repeat(64)}`;
const environment = {
  imageDigest,
  defaultsDigest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  values: {},
};
const identity = {
  authoredArtifactId: 'ar_00000000-0000-7ce7-b2d8-9d02176fb5b5',
  authoredArtifactVersion: 1 as const,
  authoredContentDigest: `sha256:${'a'.repeat(64)}`,
  inputDigest: `sha256:${'b'.repeat(64)}`,
};
const settlement = {
  ...identity,
  requestId: '1'.repeat(64),
  operation: 'image.acquire' as const,
  outcome: { kind: 'success' as const, imageDigest },
};

// Deliberate read-only observation of committed bytes while the owner ACK is held.
function inspectNativeImage<T>(
  db: { dataRoot: string },
  inspect: (owner: { sqlite: Database.Database }) => T
): T {
  const sqlite = new Database(serverStoragePath(db.dataRoot, 'nanohost'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return inspect({ sqlite });
  } finally {
    sqlite.close();
  }
}

const imageRows = (db: { dataRoot: string }) =>
  inspectNativeImage(db, ({ sqlite }) =>
    sqlite.prepare('SELECT * FROM worker_image_settlements ORDER BY request_id').all()
  );
const readSettlement = (db: { dataRoot: string }, requestId: string) =>
  inspectNativeImage(db, (owner) => readWorkerImageSettlement(owner, requestId));
const readEnvironment = (db: { dataRoot: string }, digest: string) =>
  inspectNativeImage(db, (owner) => readAdmittedWorkerImageEnvironment(owner, digest));

/** The standalone format tests exercise the local build receipt, not a Core acquisition journal. */
async function formatWriters(db: ReturnType<typeof openCoreDb>) {
  const target = await recordTestNativeRuntimeTarget(db);
  const {
    value: { owner },
  } = await reopenAdmittedTestNanoHost(db);
  const { deploymentId, identityId, targetId, connectionGeneration, physicalEpoch } = target;
  if (!physicalEpoch) throw new Error('Image format fixture requires a ready physical target.');
  return {
    write: (value: Parameters<typeof writeWorkerImageSettlement>[1]) =>
      owner.settlePreparedImage({
        settlement: value,
        target: { deploymentId, identityId, targetId, connectionGeneration, physicalEpoch },
      }),
    admit: () => owner.workerImage({ kind: 'environment', candidate: identity, environment }),
  };
}

describe('retained worker image settlement format', () => {
  const localSettlement = { ...settlement, operation: 'image.build' as const };

  it('keeps confirmed defaults as a separate native FULL stage on a read-only Main handle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-native-stages-'));
    let db = openCoreDb(root);
    onTestFinished(async () => {
      releaseCommit();
      await shutdownTestStoreWorker();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    let { write, admit } = await formatWriters(db);
    db.sqlite.pragma('query_only = ON');
    const receipt = await heldCommit(1, () => write(localSettlement));
    expect(readSettlement(db, localSettlement.requestId)).toBeNull();
    expect(readEnvironment(db, imageDigest)).toBeNull();
    releaseCommit();
    await receipt.result;
    expect(readSettlement(db, localSettlement.requestId)).toEqual(localSettlement);
    expect(readEnvironment(db, imageDigest)).toBeNull();
    const beforeReplay = imageRows(db);
    await write(localSettlement);
    await expect(
      write({
        ...localSettlement,
        outcome: { kind: 'failure', failureCode: 'effect_failed' },
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(imageRows(db)).toEqual(beforeReplay);
    const defaults = await heldCommit(2, () => admit());
    expect(readEnvironment(db, imageDigest)).toEqual(environment);
    expect(defaults.completed()).toBe(false);
    releaseCommit();
    await defaults.result;
    const before = imageRows(db);
    await admit();
    expect(imageRows(db)).toEqual(before);
    await shutdownTestStoreWorker();
    db.sqlite.close();
    db = openCoreDb(root);
    ({ write, admit } = await formatWriters(db));
    db.sqlite.pragma('query_only = ON');
    expect(readSettlement(db, localSettlement.requestId)).toEqual(localSettlement);
    expect(readEnvironment(db, imageDigest)).toEqual(environment);
    expect(imageRows(db)).toEqual(before);
  });

  it('writes v1 and reopens annotated environment bytes without rewriting them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-v1-'));
    let db = openCoreDb(root);
    onTestFinished(async () => {
      releaseCommit();
      await shutdownTestStoreWorker();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    let { write, admit } = await formatWriters(db);
    await write(localSettlement);
    await admit();
    const bytes = JSON.stringify({ ...environment, note: 'retained description' }, null, 2);
    mutateAdmittedTestNanoHost(db, (sqlite) =>
      sqlite.prepare('UPDATE worker_image_settlements SET native_environment_json = ?').run(bytes)
    );
    expect(
      inspectNativeImage(db, ({ sqlite }) =>
        sqlite.prepare('SELECT schema_version AS schemaVersion FROM worker_image_settlements').get()
      )
    ).toEqual({ schemaVersion: 1 });
    await shutdownTestStoreWorker();
    db.sqlite.close();
    db = openCoreDb(root);
    ({ write, admit } = await formatWriters(db));
    expect(readSettlement(db, localSettlement.requestId)).toEqual(localSettlement);
    expect(readEnvironment(db, imageDigest)).toEqual(environment);
    await write(localSettlement);
    await admit();
    expect(
      inspectNativeImage(db, ({ sqlite }) =>
        sqlite
          .prepare('SELECT native_environment_json AS bytes FROM worker_image_settlements')
          .get()
      )
    ).toEqual({ bytes });
  });

  it('refuses an unknown version before malformed environment decode or replay effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-version-'));
    const db = openCoreDb(root);
    onTestFinished(async () => {
      releaseCommit();
      await shutdownTestStoreWorker();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    const { write, admit } = await formatWriters(db);
    await write(localSettlement);
    mutateAdmittedTestNanoHost(db, (sqlite) =>
      sqlite.exec(
        "UPDATE worker_image_settlements SET schema_version = 2, native_environment_json = '{'"
      )
    );
    const before = inspectNativeImage(db, ({ sqlite }) => sqlite.serialize());
    expect(() => readSettlement(db, localSettlement.requestId)).toThrow(
      'Unsupported retained record format.'
    );
    expect(() => readEnvironment(db, imageDigest)).toThrow('Unsupported retained record format.');
    await expect(async () => await write(localSettlement)).rejects.toThrow(
      'Unsupported retained record format.'
    );
    await expect(async () => await admit()).rejects.toThrow('Unsupported retained record format.');
    expect(inspectNativeImage(db, ({ sqlite }) => sqlite.serialize()).equals(before)).toBe(true);
  });
});

/** Uses real H2 connection identity and native dispatch; only the external Host's result is controlled. */
async function preparationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-preparation-settlement-'));
  let db = openCoreDb(root);
  const authority = createNanoHostTransportSessionAuthority();
  let accept!: (physical: object) => void;
  const connected = new Promise<object>((resolve) => {
    accept = resolve;
  });
  const server = createHttp2Server((request, response) => {
    const physical = readNanoHostPhysicalConnectionContext(request);
    if (physical) accept(physical);
    response.writeHead(204).end();
  });
  let client: ReturnType<typeof connectHttp2> | undefined;
  onTestFinished(async () => {
    client?.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    releaseCommit();
    await shutdownTestStoreWorker();
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  let storage = await openAdmittedTestNanoHost(db);
  let receiptHold: PromiseWithResolvers<Awaited<ReturnType<typeof heldCommit<void>>>> | undefined;
  const settlePreparedImage: SettleNanoHostPreparedImage = (input) => {
    const hold = receiptHold;
    receiptHold = undefined;
    if (!hold) return settlePreparedNanoHostImage(db, storage, input);
    const actual = storage.value.owner;
    return settlePreparedNanoHostImage(
      db,
      {
        ...storage,
        value: {
          ...storage.value,
          owner: {
            ...actual,
            // The Core image-result has already acknowledged. Hold only the following Native FULL.
            async settlePreparedImage(result) {
              try {
                const receipt = await heldCommit(2, () => actual.settlePreparedImage(result));
                hold.resolve(receipt);
                await receipt.result;
              } catch (error) {
                hold.reject(error);
                throw error;
              }
            },
          },
        },
      },
      input
    ).catch((error: unknown) => {
      hold.reject(error);
      throw error;
    });
  };
  const composeDispatch = () =>
    createNanoHostSessionDispatch({
      coreDb: db,
      nativeStorage: storage,
      sessionAuthority: authority,
      settlePreparedImage,
    });
  let dispatch = composeDispatch();
  const target = {
    deploymentId: 'independent-preparation',
    identityId: 'independent-host',
    targetId: 'independent-host',
  };
  await transitionTestNativeRuntimeTargetFields('allocate', db, {
    ...target,
    observedAt: new Date().toISOString(),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing preparation fixture address.');
  client = connectHttp2(`http://127.0.0.1:${address.port}`);
  client.request({ ':method': 'POST', ':path': '/' }).end();
  const physical = await connected;
  authority.admit({
    connectionGeneration: 1,
    identityId: target.identityId,
    physicalConnection: physical,
  });
  await dispatch.readiness!(
    physical,
    Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
    { coreDb: db, ...target, nativeStorage: storage.value }
  );
  return {
    root,
    physical,
    settlePreparedImage,
    target: { ...target, connectionGeneration: 1, physicalEpoch: 'a'.repeat(64) },
    get db() {
      return db;
    },
    get dispatch() {
      return dispatch;
    },
    get effects() {
      return createWorkerEnvironmentRuntimeEffects(dispatch, TEST_WORKER_RELEASE_IDENTITY);
    },
    holdNextNativeReceipt() {
      if (receiptHold) throw new Error('The next image receipt is already held.');
      receiptHold = Promise.withResolvers<Awaited<ReturnType<typeof heldCommit<void>>>>();
      return receiptHold.promise;
    },
    async reopen() {
      await shutdownTestStoreWorker();
      db.sqlite.close();
      db = openCoreDb(root);
      storage = await reopenAdmittedTestNanoHost(db);
      dispatch = composeDispatch();
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        { coreDb: db, ...target, nativeStorage: storage.value }
      );
    },
  };
}

describe('ordinary preparation adapter controls before journal wiring', () => {
  it('commits intent before native image.acquire delivery and preserves receipt controls', async () => {
    const f = await preparationFixture();
    // Bind real caller provenance through Server history without creating a Workspace database.
    const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
    const store = await createTestServerWorkStore(f.db);
    const thread = await createTestServerThread(
      store,
      f.db,
      'Administrative image preparation',
      'conversation'
    );
    const publicationTurn = await store.createServerTurn(
      thread.id,
      'Prepare the authored image.',
      actor
    );
    expect(getLocalUserId(f.db)).toBe(actor.id);
    expect(
      (await createTestServerWorkStore(f.db)).getServerTurn(thread.id, publicationTurn.id)
    ).toMatchObject({
      id: publicationTurn.id,
      owner: { kind: 'server' },
      triggerActor: actor,
    });
    const input = {
      actor,
      workId: publicationTurn.id,
      authorize: () => true,
      candidate: {
        artifactId: identity.authoredArtifactId,
        artifactVersion: 1 as const,
        contentDigest: identity.authoredContentDigest,
      },
      image: { kind: 'reference' as const, pullPolicy: 'never' as const, ref: imageDigest },
    };
    await expect(f.effects.prepareImage({ ...input, authorize: () => false })).rejects.toThrow();
    await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
    expect(imageRows(f.db)).toEqual([]);
    // Core Storage: the native FULL acknowledgement precedes first effect delivery.
    f.db.sqlite.pragma('query_only = ON');
    const intentAck = await heldCommit(2, () => f.effects.prepareImage(input));
    const prepared = intentAck.result;
    expect(f.db.sqlite.prepare('SELECT state FROM control_execution_steps').all()).toEqual([
      { state: 'intent' },
    ]);
    await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
    expect(intentAck.completed()).toBe(false);
    releaseCommit();
    const acquire = await vi.waitFor(
      async () => {
        const command = await f.dispatch.poll(f.physical, 'image.acquire');
        expect(command).not.toBeNull();
        return command;
      },
      { timeout: 5000 }
    );
    expect(acquire).toMatchObject({ imageReference: imageDigest });
    if (!acquire || typeof acquire.requestId !== 'string')
      throw new Error('Native acquisition was not delivered.');
    expect(f.db.sqlite.inTransaction).toBe(false);
    expect(readSettlement(f.db, acquire.requestId)).toBeNull();
    // Read committed native rows at delivery, before the controlled Host returns any result.
    // A soft assertion preserves the independent authorization, receipt and cold-reopen controls below.
    const intents = f.db.sqlite
      .prepare(
        `SELECT s.schema_version AS schemaVersion, s.state, r.definition_version AS definitionVersion,
                json_extract(s.control_json, '$.actor') AS actor,
                json_extract(s.control_json, '$.workId') AS workId, r.work_id AS rootWorkId
         FROM control_execution_steps s JOIN control_executions r ON r.id = s.execution_id
         WHERE json_extract(s.invocation_json, '$.carriage.operation') = 'image.acquire'
           AND json_extract(s.invocation_json, '$.carriage.requestId') = ?`
      )
      .all(acquire.requestId) as Array<{
      schemaVersion: number;
      state: string;
      definitionVersion: string;
      actor: string;
      workId: string;
      rootWorkId: string;
    }>;
    expect
      .soft(
        intents.map(({ actor: recordedActor, ...row }) => ({
          ...row,
          actor: JSON.parse(recordedActor),
        })),
        'Native image.acquire delivery requires its committed journal intent.'
      )
      .toStrictEqual([
        {
          schemaVersion: 1,
          state: 'intent',
          definitionVersion: 'core-image-acquire/v1',
          actor,
          workId: publicationTurn.id,
          rootWorkId: publicationTurn.id,
        },
      ]);
    const result = { requestId: acquire.requestId, digest: imageDigest };
    f.db.sqlite.pragma('query_only = ON');
    const heldReceipt = f.holdNextNativeReceipt();
    const coreReceipt = await heldCommit(2, () =>
      f.dispatch.result(f.physical, 'image.acquire', result)
    );
    expect(readSettlement(f.db, acquire.requestId)).toBeNull();
    await expect(f.dispatch.poll(f.physical, 'image.inspect')).resolves.toBeNull();
    releaseCommit();
    const receiptAck = await heldReceipt;
    expect(readSettlement(f.db, acquire.requestId)).toMatchObject({
      requestId: acquire.requestId,
      outcome: { kind: 'success', imageDigest },
    });
    expect(f.db.sqlite.prepare('SELECT state FROM control_execution_steps').all()).toEqual([
      { state: 'completed' },
    ]);
    // The receipt is now physically committed, but the admitted target is unavailable to
    // dependent inspection until the exact Native acknowledgement is observed.
    await expect(f.dispatch.poll(f.physical, 'image.inspect')).rejects.toMatchObject({
      status: 503,
      message: 'NanoHost RuntimeTarget storage is unavailable.',
    });
    expect(receiptAck.completed()).toBe(false);
    expect(coreReceipt.completed()).toBe(false);
    releaseCommit();
    await coreReceipt.result;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const inspect = await f.dispatch.poll(f.physical, 'image.inspect');
    expect(inspect).toMatchObject({ imageDigest });
    if (!inspect || typeof inspect.requestId !== 'string')
      throw new Error('Native inspection was not delivered.');
    expect(f.db.sqlite.inTransaction).toBe(false);
    await f.dispatch.result(f.physical, 'image.inspect', {
      releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
      requestId: inspect.requestId,
      digest: imageDigest,
      platform: { architecture: 'amd64', os: 'linux' },
      storageLayout: {
        family: 'openkit-worker',
        version: '1',
        uid: 1000,
        gid: 1000,
        workingDirectory: '/tmp/openkit-bootstrap',
        targets: [{ target: '/workspace' }],
      },
    });
    await expect(prepared).resolves.toMatchObject({ imageDigest });
    const original = readSettlement(f.db, acquire.requestId);
    expect(original).toStrictEqual({
      requestId: acquire.requestId,
      operation: 'image.acquire',
      authoredArtifactId: identity.authoredArtifactId,
      authoredArtifactVersion: 1,
      authoredContentDigest: identity.authoredContentDigest,
      inputDigest: commandInputHash(input.image),
      outcome: { kind: 'success', imageDigest },
    });
    const originalJournalRows = {
      roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
      steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
    };
    const originalRows = imageRows(f.db);
    expect(originalRows).toHaveLength(1);
    await f.dispatch.result(f.physical, 'image.acquire', result);
    await expect(
      f.dispatch.result(f.physical, 'image.acquire', {
        ...result,
        digest: `sha256:${'e'.repeat(64)}`,
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(imageRows(f.db)).toStrictEqual(originalRows);
    expect({
      roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
      steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
    }).toStrictEqual(originalJournalRows);
    await f.reopen();
    expect(readSettlement(f.db, acquire.requestId)).toStrictEqual(original);
    await f.dispatch.result(f.physical, 'image.acquire', result);
    await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
    expect(imageRows(f.db)).toStrictEqual(originalRows);
    expect({
      roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
      steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
    }).toStrictEqual(originalJournalRows);
    expect(
      readdirSync(f.root, { recursive: true })
        .filter((path) => String(path).endsWith('.sqlite'))
        .sort()
    ).toEqual(
      [
        join('server', 'db', 'core.sqlite'),
        relative(f.root, serverStoragePath(f.root, 'server-work')),
        relative(f.root, serverStoragePath(f.root, 'nanohost')),
      ].sort()
    );
  });
});

it('rolls back the entire image receipt and journal tuple after a real later journal fault', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = await createTestServerWorkStore(f.db);
  const thread = await createTestServerThread(store, f.db, 'Image tuple rollback', 'conversation');
  const turn = await store.createServerTurn(thread.id, 'Prepare the authored image.', actor);
  const prepared = f.effects.prepareImage({
    actor,
    workId: turn.id,
    authorize: () => true,
    candidate: {
      artifactId: identity.authoredArtifactId,
      artifactVersion: 1,
      contentDigest: identity.authoredContentDigest,
    },
    image: { kind: 'reference', pullPolicy: 'never', ref: imageDigest },
  });
  void prepared.catch(() => undefined);
  const observed: { value: Awaited<ReturnType<typeof f.dispatch.poll>> } = { value: null };
  await vi.waitFor(async () => {
    observed.value = await f.dispatch.poll(f.physical, 'image.acquire');
    expect(observed.value).not.toBeNull();
  });
  const acquire = observed.value;
  if (!acquire || typeof acquire.requestId !== 'string')
    throw new Error('Missing real image acquisition.');
  const before = {
    roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
    steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
  };
  expect(before.steps).toHaveLength(1);
  expect(before.steps[0]).toMatchObject({ state: 'intent' });
  // Deliberate post-setup fault; this trigger executes on the actual native connection.
  f.db.sqlite.exec(`CREATE TRIGGER reject_image_journal_settlement
    BEFORE UPDATE ON control_execution_steps
    BEGIN SELECT RAISE(ABORT, 'injected image journal settlement failure'); END`);
  f.db.sqlite.pragma('query_only = ON');
  await expect(
    f.dispatch.result(f.physical, 'image.acquire', {
      requestId: acquire.requestId,
      digest: imageDigest,
    })
  ).rejects.toMatchObject({ status: 503 });
  await expect(prepared).rejects.toMatchObject({ code: 'recovery_required' });
  expect(readSettlement(f.db, acquire.requestId)).toBeNull();
  expect({
    roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
    steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
  }).toStrictEqual(before);
  await f.reopen();
  expect(readSettlement(f.db, acquire.requestId)).toBeNull();
  expect({
    roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
    steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
  }).toStrictEqual(before);
});

it('refuses image intent after its queued current Core Epoch loses authority', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = await createTestServerWorkStore(f.db);
  const thread = await createTestServerThread(
    store,
    f.db,
    'Queued image authority',
    'conversation'
  );
  const turn = await store.createServerTurn(thread.id, 'Prepare the authored image.', actor);
  const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
    `core:${f.db.sqlite.name}`
  );
  onTestFinished(resume);
  const prepared = f.effects.prepareImage({
    actor,
    workId: turn.id,
    authorize: () => true,
    candidate: {
      artifactId: identity.authoredArtifactId,
      artifactVersion: 1,
      contentDigest: identity.authoredContentDigest,
    },
    image: { kind: 'reference', pullPolicy: 'never', ref: imageDigest },
  });
  void prepared.catch(() => undefined);
  await nextTurn();
  try {
    // The existing native posting hold proves the command cannot already have decided SQL.
    expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual([]);
    // Deliberate post-setup loss of current authority, never a fabricated successful record.
    mutateAdmittedTestNanoHost(f.db, (sqlite) =>
      sqlite.exec(`UPDATE nanohost_runtime_targets
        SET ready = 0, fresh_empty = 0, physical_epoch = NULL`)
    );
    f.db.sqlite.pragma('query_only = ON');
  } finally {
    resume();
  }
  await expect(prepared).rejects.toThrow();
  expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual([]);
  expect(f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all()).toEqual([]);
  expect(imageRows(f.db)).toEqual([]);
  await f.reopen();
  expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual([]);
  expect(f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all()).toEqual([]);
});

it('abandons a cold accepted image natively and preserves unknown bytes through late-result rollback and reopen', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = await createTestServerWorkStore(f.db);
  const thread = await createTestServerThread(store, f.db, 'Cold image exclusion', 'conversation');
  const turn = await store.createServerTurn(thread.id, 'Prepare the authored image.', actor);
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const lateSettlement = {
    ...settlement,
    inputDigest: commandInputHash({ kind: 'reference', pullPolicy: 'never', ref: imageDigest }),
  };
  const request = {
    kind: 'image.acquire' as const,
    requestId: settlement.requestId,
    input: { imageReference: imageDigest },
    imageSettlement: { ...identity, inputDigest: lateSettlement.inputDigest },
    imageExecution: { actor, workId: turn.id, authorize: () => true },
    signal: abort.signal,
  };
  const delivered = f.dispatch.effect(request);
  void delivered.catch(() => undefined);
  const acquire = await vi.waitFor(
    async () => {
      const command = await f.dispatch.poll(f.physical, 'image.acquire');
      expect(command).toMatchObject({ requestId: request.requestId });
      return command;
    },
    { timeout: 5000 }
  );
  expect(acquire).not.toBeNull();
  abort.abort();
  await expect(delivered).rejects.toThrow();
  await f.reopen();
  f.db.sqlite.pragma('query_only = ON');
  // Repeating the public request is result-only: it ends the old intent and refuses contact.
  const unknownAck = await heldCommit(2, () =>
    f.dispatch.effect({ ...request, signal: undefined })
  );
  expect(f.db.sqlite.prepare('SELECT state FROM control_execution_steps').all()).toEqual([
    { state: 'unknown' },
  ]);
  await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
  releaseCommit();
  await expect(unknownAck.result).rejects.toThrow(
    'Image intent already exists; only result reconciliation is permitted.'
  );
  const roots = () => f.db.sqlite.prepare('SELECT * FROM control_executions').all();
  const steps = () =>
    f.db.sqlite.prepare('SELECT * FROM control_execution_steps ORDER BY ordinal').all();
  const originalRoots = roots();
  const originalSteps = steps();
  expect(originalRoots).toHaveLength(1);
  expect(originalRoots[0]).toMatchObject({ phase: 'closing' });
  const exclusion = (originalRoots[0] as { exclusion_refs_json: string }).exclusion_refs_json;
  expect(JSON.parse(exclusion).length).toBeGreaterThan(0);
  await f.reopen();
  expect(roots()).toStrictEqual(originalRoots);
  expect(steps()).toStrictEqual(originalSteps);
  // Fail the last local step after the native receipt and consumption intent were attempted.
  f.db.sqlite.exec(`CREATE TRIGGER reject_late_image_consumption
    BEFORE UPDATE ON control_execution_steps
    WHEN json_extract(NEW.control_json, '$.kind') = 'consume-receipt'
    BEGIN SELECT RAISE(ABORT, 'injected late image consumption failure'); END`);
  f.db.sqlite.pragma('query_only = ON');
  const ref = readCoreImageAcquisitionRef(f.db, request.requestId);
  if (!ref || ref.execution.owner.kind !== 'server')
    throw new Error('Late receipt requires its original Core acquisition.');
  await expect(
    publishCoreJournal(f.db, {
      kind: 'image-result',
      ref: {
        execution: { owner: { kind: 'server' }, executionId: ref.execution.executionId },
        stepId: ref.stepId,
      },
      settlement: lateSettlement,
      target: f.target,
    })
  ).rejects.toMatchObject({
    name: 'ControlStoreWorkerError',
    commit: 'not-committed',
  });
  expect(readSettlement(f.db, settlement.requestId)).toBeNull();
  expect(roots()).toStrictEqual(originalRoots);
  expect(steps()).toStrictEqual(originalSteps);
  await f.reopen();
  expect(readSettlement(f.db, settlement.requestId)).toBeNull();
  expect(roots()).toStrictEqual(originalRoots);
  expect(steps()).toStrictEqual(originalSteps);
  f.db.sqlite.exec('DROP TRIGGER reject_late_image_consumption');
  f.db.sqlite.pragma('query_only = ON');
  const originalResult = { settlement: lateSettlement, target: f.target, originalExecution: ref };
  const heldLateReceipt = f.holdNextNativeReceipt();
  const lateResult = f.settlePreparedImage(originalResult);
  void lateResult.catch(() => undefined);
  const lateAck = await heldLateReceipt;
  expect(readSettlement(f.db, settlement.requestId)).toStrictEqual(lateSettlement);
  expect(steps()[0]).toStrictEqual(originalSteps[0]);
  expect(roots()[0]).toMatchObject({ phase: 'closing', exclusion_refs_json: exclusion });
  expect(steps()).toHaveLength(2);
  expect(steps()[1]).toMatchObject({ state: 'completed' });
  expect(lateAck.completed()).toBe(false);
  releaseCommit();
  await lateResult;
  const lateRoots = roots();
  const lateSteps = steps();
  await f.settlePreparedImage(originalResult);
  await f.reopen();
  expect(readSettlement(f.db, settlement.requestId)).toStrictEqual(lateSettlement);
  expect(roots()).toStrictEqual(lateRoots);
  expect(steps()).toStrictEqual(lateSteps);
  await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
});

it('fences undelivered image cancellation before its native FULL reply and reopens exact cancelled bytes', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = await createTestServerWorkStore(f.db);
  const thread = await createTestServerThread(store, f.db, 'Undelivered image', 'conversation');
  const turn = await store.createServerTurn(thread.id, 'Prepare the authored image.', actor);
  const abort = new AbortController();
  onTestFinished(() => {
    releaseCommit();
    abort.abort();
  });
  f.db.sqlite.pragma('query_only = ON');
  const pending = f.dispatch.effect({
    kind: 'image.acquire',
    requestId: '7'.repeat(64),
    input: { imageReference: imageDigest },
    imageSettlement: identity,
    imageExecution: { actor, workId: turn.id, authorize: () => true },
    signal: abort.signal,
  });
  void pending.catch(() => undefined);
  await vi.waitFor(
    () =>
      expect(f.db.sqlite.prepare('SELECT state FROM control_execution_steps').all()).toEqual([
        { state: 'intent' },
      ]),
    { timeout: 5000 }
  );
  const cancelledAck = await heldCommit(1, () => {
    abort.abort();
    return pending;
  });
  // The deciding transaction is still uncommitted; no command may escape during that wait.
  expect(f.db.sqlite.prepare('SELECT state FROM control_execution_steps').all()).toEqual([
    { state: 'intent' },
  ]);
  await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
  expect(readSettlement(f.db, '7'.repeat(64))).toBeNull();
  expect(cancelledAck.completed()).toBe(false);
  releaseCommit();
  await expect(cancelledAck.result).rejects.toThrow(
    'NanoHost original effect allowance ended; outcome requires inspection.'
  );
  expect(f.db.sqlite.prepare('SELECT state FROM control_execution_steps').all()).toEqual([
    { state: 'cancelled' },
  ]);
  expect(
    f.db.sqlite.prepare('SELECT phase, exclusion_refs_json FROM control_executions').all()
  ).toEqual([{ phase: 'closed', exclusion_refs_json: '[]' }]);
  const retained = {
    roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
    steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
  };
  await f.reopen();
  expect({
    roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
    steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
  }).toStrictEqual(retained);
  await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
});

it('retains one result-only image waiter when two recoveries join native abandonment', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = await createTestServerWorkStore(f.db);
  const thread = await createTestServerThread(
    store,
    f.db,
    'Concurrent image recovery',
    'conversation'
  );
  const turn = await store.createServerTurn(thread.id, 'Prepare the authored image.', actor);
  const abort = new AbortController();
  onTestFinished(() => {
    releaseCommit();
    abort.abort();
  });
  const requestId = '8'.repeat(64);
  const original = f.dispatch.effect({
    kind: 'image.acquire',
    requestId,
    input: { imageReference: imageDigest },
    imageSettlement: identity,
    imageExecution: { actor, workId: turn.id, authorize: () => true },
    signal: abort.signal,
  });
  void original.catch(() => undefined);
  await vi.waitFor(
    async () =>
      expect(await f.dispatch.poll(f.physical, 'image.acquire')).toMatchObject({ requestId }),
    { timeout: 5000 }
  );
  abort.abort();
  await expect(original).rejects.toThrow();
  await f.reopen();
  f.db.sqlite.pragma('query_only = ON');
  const expectations = [{ kind: 'image.acquire' as const, requestId, imageSettlement: identity }];
  const first = await heldCommit(2, () => f.dispatch.expectResultOnly!(expectations));
  const second = f.dispatch.expectResultOnly!(expectations);
  void second.catch(() => undefined);
  releaseCommit();
  await expect(second).rejects.toThrow(
    'NanoHost result-only expectation conflicts with current effect state.'
  );
  expect(first.completed()).toBe(false);
  const unknown = f.db.sqlite
    .prepare('SELECT * FROM control_execution_steps ORDER BY ordinal')
    .all();
  expect(unknown).toHaveLength(1);
  expect(unknown[0]).toMatchObject({ state: 'unknown' });
  await f.dispatch.result(f.physical, 'image.acquire', { requestId, digest: imageDigest });
  // The public waiter strips transport correlation; the retained receipt below keeps the exact key.
  await expect(first.result).resolves.toEqual({
    kind: 'image.acquire',
    result: { digest: imageDigest },
  });
  expect(readSettlement(f.db, requestId)).toMatchObject({ requestId });
  expect(
    f.db.sqlite.prepare('SELECT * FROM control_execution_steps ORDER BY ordinal').all()[0]
  ).toStrictEqual(unknown[0]);
});
