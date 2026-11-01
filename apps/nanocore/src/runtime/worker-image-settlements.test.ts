import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ensureLocalUser, getLocalUserId } from '../auth/identity.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { FsStore } from '../lib/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import type { ExecutionStepControl } from './execution-step-journal.js';
import { commandInputHash } from './idempotent-command.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import { createNanoHostSessionDispatch } from './nanohost-session-dispatch.js';
import { createWorkerEnvironmentRuntimeEffects } from './worker-environment-runtime-effects.js';
import {
  admitWorkerImageEnvironment,
  readAdmittedWorkerImageEnvironment,
  readWorkerImageSettlement,
  writeWorkerImageSettlement,
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

describe('retained worker image settlement format', () => {
  it('keeps confirmed defaults as a separate native FULL stage on a read-only Main handle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-native-stages-'));
    let db = openCoreDb(root);
    onTestFinished(async () => {
      releaseCommit();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    db.sqlite.pragma('query_only = ON');
    const receipt = await heldCommit(1, () => writeWorkerImageSettlement(db, settlement));
    expect(readWorkerImageSettlement(db, settlement.requestId)).toBeNull();
    expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
    releaseCommit();
    await receipt.result;
    expect(readWorkerImageSettlement(db, settlement.requestId)).toEqual(settlement);
    expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toBeNull();
    const beforeReplay = db.sqlite.prepare('SELECT * FROM worker_image_settlements').all();
    await writeWorkerImageSettlement(db, settlement);
    await expect(
      writeWorkerImageSettlement(db, {
        ...settlement,
        outcome: { kind: 'failure', failureCode: 'effect_failed' },
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.sqlite.prepare('SELECT * FROM worker_image_settlements').all()).toEqual(beforeReplay);
    const defaults = await heldCommit(2, () =>
      admitWorkerImageEnvironment(db, identity, environment)
    );
    expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toEqual(environment);
    expect(defaults.completed()).toBe(false);
    releaseCommit();
    await defaults.result;
    const before = db.sqlite.prepare('SELECT * FROM worker_image_settlements').all();
    await admitWorkerImageEnvironment(db, identity, environment);
    expect(db.sqlite.prepare('SELECT * FROM worker_image_settlements').all()).toEqual(before);
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    db = openCoreDb(root);
    db.sqlite.pragma('query_only = ON');
    expect(readWorkerImageSettlement(db, settlement.requestId)).toEqual(settlement);
    expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toEqual(environment);
    expect(db.sqlite.prepare('SELECT * FROM worker_image_settlements').all()).toEqual(before);
  });

  it('writes v1 and reopens annotated environment bytes without rewriting them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-v1-'));
    let db = openCoreDb(root);
    onTestFinished(async () => {
      releaseCommit();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    await writeWorkerImageSettlement(db, settlement);
    await admitWorkerImageEnvironment(db, identity, environment);
    const bytes = JSON.stringify({ ...environment, note: 'retained description' }, null, 2);
    db.sqlite.prepare('UPDATE worker_image_settlements SET native_environment_json = ?').run(bytes);
    expect(
      db.sqlite
        .prepare('SELECT schema_version AS schemaVersion FROM worker_image_settlements')
        .get()
    ).toEqual({ schemaVersion: 1 });
    db.sqlite.close();
    db = openCoreDb(root);
    expect(readWorkerImageSettlement(db, settlement.requestId)).toEqual(settlement);
    expect(readAdmittedWorkerImageEnvironment(db, imageDigest)).toEqual(environment);
    await writeWorkerImageSettlement(db, settlement);
    await admitWorkerImageEnvironment(db, identity, environment);
    expect(
      db.sqlite
        .prepare('SELECT native_environment_json AS bytes FROM worker_image_settlements')
        .get()
    ).toEqual({ bytes });
  });

  it('refuses an unknown version before malformed environment decode or replay effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-version-'));
    const db = openCoreDb(root);
    onTestFinished(async () => {
      releaseCommit();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    await writeWorkerImageSettlement(db, settlement);
    db.sqlite.exec(
      "UPDATE worker_image_settlements SET schema_version = 2, native_environment_json = '{'"
    );
    const before = db.sqlite.serialize();
    expect(() => readWorkerImageSettlement(db, settlement.requestId)).toThrow(
      'Unsupported retained record format.'
    );
    expect(() => readAdmittedWorkerImageEnvironment(db, imageDigest)).toThrow(
      'Unsupported retained record format.'
    );
    await expect(async () => await writeWorkerImageSettlement(db, settlement)).rejects.toThrow(
      'Unsupported retained record format.'
    );
    await expect(
      async () => await admitWorkerImageEnvironment(db, identity, environment)
    ).rejects.toThrow('Unsupported retained record format.');
    expect(db.sqlite.serialize().equals(before)).toBe(true);
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
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  let dispatch = createNanoHostSessionDispatch({ coreDb: db, sessionAuthority: authority });
  const target = {
    deploymentId: 'independent-preparation',
    identityId: 'independent-host',
    targetId: 'independent-host',
  };
  await allocateNanoHostRuntimeTargetConnectionGeneration(db, {
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
    { coreDb: db, ...target }
  );
  return {
    root,
    physical,
    get db() {
      return db;
    },
    get dispatch() {
      return dispatch;
    },
    get effects() {
      return createWorkerEnvironmentRuntimeEffects(dispatch);
    },
    async reopen() {
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      db = openCoreDb(root);
      dispatch = createNanoHostSessionDispatch({ coreDb: db, sessionAuthority: authority });
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        { coreDb: db, ...target }
      );
    },
  };
}

describe('ordinary preparation adapter controls before journal wiring', () => {
  it('commits intent before native image.acquire delivery and preserves receipt controls', async () => {
    const f = await preparationFixture();
    // Bind real caller provenance through Server history without creating a Workspace database.
    const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
    const store = new FsStore({ dataRoot: f.root });
    const thread = await store.createServerThread(
      'Administrative image preparation',
      undefined,
      'conversation'
    );
    const publicationTurn = await store.createServerTurn(
      thread.id,
      'Prepare the authored image.',
      actor
    );
    expect(getLocalUserId(f.db)).toBe(actor.id);
    expect(
      new FsStore({ dataRoot: f.root }).getServerTurn(thread.id, publicationTurn.id)
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
    expect(f.db.sqlite.prepare('SELECT * FROM worker_image_settlements').all()).toEqual([]);
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
    expect(readWorkerImageSettlement(f.db, acquire.requestId)).toBeNull();
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
    const receiptAck = await heldCommit(2, () =>
      f.dispatch.result(f.physical, 'image.acquire', result)
    );
    expect(readWorkerImageSettlement(f.db, acquire.requestId)).toMatchObject({
      requestId: acquire.requestId,
      outcome: { kind: 'success', imageDigest },
    });
    expect(f.db.sqlite.prepare('SELECT state FROM control_execution_steps').all()).toEqual([
      { state: 'completed' },
    ]);
    // The real receipt and journal are committed, but delivery and dependent inspection still await ACK.
    await expect(f.dispatch.poll(f.physical, 'image.inspect')).resolves.toBeNull();
    expect(receiptAck.completed()).toBe(false);
    releaseCommit();
    await receiptAck.result;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const inspect = await f.dispatch.poll(f.physical, 'image.inspect');
    expect(inspect).toMatchObject({ imageDigest });
    if (!inspect || typeof inspect.requestId !== 'string')
      throw new Error('Native inspection was not delivered.');
    expect(f.db.sqlite.inTransaction).toBe(false);
    await f.dispatch.result(f.physical, 'image.inspect', {
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
    const original = readWorkerImageSettlement(f.db, acquire.requestId);
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
    const originalRows = f.db.sqlite
      .prepare('SELECT * FROM worker_image_settlements ORDER BY request_id')
      .all();
    expect(originalRows).toHaveLength(1);
    await f.dispatch.result(f.physical, 'image.acquire', result);
    await expect(
      f.dispatch.result(f.physical, 'image.acquire', {
        ...result,
        digest: `sha256:${'e'.repeat(64)}`,
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.db.sqlite.prepare('SELECT * FROM worker_image_settlements ORDER BY request_id').all()
    ).toStrictEqual(originalRows);
    expect({
      roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
      steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
    }).toStrictEqual(originalJournalRows);
    await f.reopen();
    expect(readWorkerImageSettlement(f.db, acquire.requestId)).toStrictEqual(original);
    await f.dispatch.result(f.physical, 'image.acquire', result);
    await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
    expect(
      f.db.sqlite.prepare('SELECT * FROM worker_image_settlements ORDER BY request_id').all()
    ).toStrictEqual(originalRows);
    expect({
      roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
      steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
    }).toStrictEqual(originalJournalRows);
    expect(
      readdirSync(f.root, { recursive: true }).filter((path) => String(path).endsWith('.sqlite'))
    ).toEqual([join('server', 'db', 'core.sqlite')]);
  });
});

it('rolls back the entire image receipt and journal tuple after a real later journal fault', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = new FsStore({ dataRoot: f.root });
  const thread = await store.createServerThread('Image tuple rollback', undefined, 'conversation');
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
  expect(readWorkerImageSettlement(f.db, acquire.requestId)).toBeNull();
  expect({
    roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
    steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
  }).toStrictEqual(before);
  await f.reopen();
  expect(readWorkerImageSettlement(f.db, acquire.requestId)).toBeNull();
  expect({
    roots: f.db.sqlite.prepare('SELECT * FROM control_executions').all(),
    steps: f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all(),
  }).toStrictEqual(before);
});

it('refuses image intent after its queued current Core Epoch loses authority', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = new FsStore({ dataRoot: f.root });
  const thread = await store.createServerThread(
    'Queued image authority',
    undefined,
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
    f.db.sqlite.exec(`UPDATE nanohost_runtime_targets
      SET ready = 0, fresh_empty = 0, physical_epoch = NULL`);
    f.db.sqlite.pragma('query_only = ON');
  } finally {
    resume();
  }
  await expect(prepared).rejects.toThrow();
  expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual([]);
  expect(f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all()).toEqual([]);
  expect(f.db.sqlite.prepare('SELECT * FROM worker_image_settlements').all()).toEqual([]);
  await f.reopen();
  expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual([]);
  expect(f.db.sqlite.prepare('SELECT * FROM control_execution_steps').all()).toEqual([]);
});

it('abandons a cold accepted image natively and preserves unknown bytes through late-result rollback and reopen', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = new FsStore({ dataRoot: f.root });
  const thread = await store.createServerThread('Cold image exclusion', undefined, 'conversation');
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
  await expect(writeWorkerImageSettlement(f.db, lateSettlement)).rejects.toMatchObject({
    name: 'ControlStoreWorkerError',
    commit: 'not-committed',
  });
  expect(readWorkerImageSettlement(f.db, settlement.requestId)).toBeNull();
  expect(roots()).toStrictEqual(originalRoots);
  expect(steps()).toStrictEqual(originalSteps);
  await f.reopen();
  expect(readWorkerImageSettlement(f.db, settlement.requestId)).toBeNull();
  expect(roots()).toStrictEqual(originalRoots);
  expect(steps()).toStrictEqual(originalSteps);
  f.db.sqlite.exec('DROP TRIGGER reject_late_image_consumption');
  f.db.sqlite.pragma('query_only = ON');
  const lateAck = await heldCommit(2, () => writeWorkerImageSettlement(f.db, lateSettlement));
  expect(readWorkerImageSettlement(f.db, settlement.requestId)).toStrictEqual(lateSettlement);
  expect(steps()[0]).toStrictEqual(originalSteps[0]);
  expect(roots()[0]).toMatchObject({ phase: 'closing', exclusion_refs_json: exclusion });
  expect(steps()).toHaveLength(2);
  expect(steps()[1]).toMatchObject({ state: 'completed' });
  expect(lateAck.completed()).toBe(false);
  releaseCommit();
  await lateAck.result;
  const lateRoots = roots();
  const lateSteps = steps();
  await writeWorkerImageSettlement(f.db, lateSettlement);
  await f.reopen();
  expect(readWorkerImageSettlement(f.db, settlement.requestId)).toStrictEqual(lateSettlement);
  expect(roots()).toStrictEqual(lateRoots);
  expect(steps()).toStrictEqual(lateSteps);
  await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
});

it('fences undelivered image cancellation before its native FULL reply and reopens exact cancelled bytes', async () => {
  const f = await preparationFixture();
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(f.db) };
  const store = new FsStore({ dataRoot: f.root });
  const thread = await store.createServerThread('Undelivered image', undefined, 'conversation');
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
  expect(readWorkerImageSettlement(f.db, '7'.repeat(64))).toBeNull();
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
  const store = new FsStore({ dataRoot: f.root });
  const thread = await store.createServerThread(
    'Concurrent image recovery',
    undefined,
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
  expect(readWorkerImageSettlement(f.db, requestId)).toMatchObject({ requestId });
  expect(
    f.db.sqlite.prepare('SELECT * FROM control_execution_steps ORDER BY ordinal').all()[0]
  ).toStrictEqual(unknown[0]);
});
