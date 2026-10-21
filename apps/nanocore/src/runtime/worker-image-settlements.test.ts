import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ensureLocalUser, getLocalUserId } from '../auth/identity.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
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
  it('writes v1 and reopens annotated environment bytes without rewriting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-v1-'));
    let db = openCoreDb(root);
    onTestFinished(() => {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    writeWorkerImageSettlement(db, settlement);
    admitWorkerImageEnvironment(db, identity, environment);
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
    writeWorkerImageSettlement(db, settlement);
    admitWorkerImageEnvironment(db, identity, environment);
    expect(
      db.sqlite
        .prepare('SELECT native_environment_json AS bytes FROM worker_image_settlements')
        .get()
    ).toEqual({ bytes });
  });

  it('refuses an unknown version before malformed environment decode or replay effects', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-image-settlement-version-'));
    const db = openCoreDb(root);
    onTestFinished(() => {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    writeWorkerImageSettlement(db, settlement);
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
    expect(() => writeWorkerImageSettlement(db, settlement)).toThrow(
      'Unsupported retained record format.'
    );
    expect(() => admitWorkerImageEnvironment(db, identity, environment)).toThrow(
      'Unsupported retained record format.'
    );
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
    if (db.sqlite.open) db.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  let dispatch = createNanoHostSessionDispatch({ coreDb: db, sessionAuthority: authority });
  const target = {
    deploymentId: 'independent-preparation',
    identityId: 'independent-host',
    targetId: 'independent-host',
  };
  allocateNanoHostRuntimeTargetConnectionGeneration(db, {
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
    const prepared = f.effects.prepareImage(input);
    void prepared.catch(() => undefined);
    const acquire = await f.dispatch.poll(f.physical, 'image.acquire');
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
    await f.dispatch.result(f.physical, 'image.acquire', result);
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
    await f.reopen();
    expect(readWorkerImageSettlement(f.db, acquire.requestId)).toStrictEqual(original);
    await f.dispatch.result(f.physical, 'image.acquire', result);
    await expect(f.dispatch.poll(f.physical, 'image.acquire')).resolves.toBeNull();
    expect(
      f.db.sqlite.prepare('SELECT * FROM worker_image_settlements ORDER BY request_id').all()
    ).toStrictEqual(originalRows);
    expect(
      readdirSync(f.root, { recursive: true }).filter((path) => String(path).endsWith('.sqlite'))
    ).toEqual([join('server', 'db', 'core.sqlite')]);
  });
});
