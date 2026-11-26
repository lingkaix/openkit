import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  connect,
  createServer,
  type IncomingHttpHeaders,
} from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import {
  type AgentEnvironmentPackage,
  WORKER_CREDENTIAL_FILE_REQUIREMENT,
  type WorkerCredentialFileBinding,
} from '@openkit/config-schema';
import { Hono } from 'hono';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createApp, settlePreparedNanoHostImage } from '../app.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { createListenerFetches } from '../nanohost-listener.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { transitionAdmittedNanoHostRuntimeTarget } from '../storage/nanohost-transport-owner.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import {
  createTestServerThread,
  createTestServerWorkStore,
} from '../test-support/server-work-store.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import * as workerCredentialAuthority from './agent-environment.js';
import * as executionJournal from './execution-journal.js';
import {
  createNanoHostSessionDispatch,
  createProductionNanoHostSessionDispatch,
  NANO_HOST_EFFECT_OPERATIONS,
  NanoHostEffectNotEnqueuedError,
  type NanoHostSessionEffectRequest,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';
import { prepareRuntimeFileCarriage } from './turn-executor-factory.js';

const EFFECT_PATH = '/api/nanohost/transport/effects/';
const READINESS_PATH = '/api/nanohost/transport/session/readiness';
const PROBE_PATH = '/api/nanohost/transport/fixture';
const EPOCH = 'a'.repeat(64);
const REQUEST_ID = 'b'.repeat(64);
const NEXT_ID = 'c'.repeat(64);
const TEST_ALLOWANCE_MS = 10;

const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const assertFixtureOwner = () => () => {};
const sandboxDelete = (requestId = REQUEST_ID): NanoHostSessionEffectRequest => ({
  kind: 'sandbox.delete',
  input: { sandboxId: 'fixture-sandbox' },
  requestId,
  beforeDelivery: assertFixtureOwner,
});
const pinnedCommands = JSON.parse(
  readFileSync(
    new URL('../../../nanohost/src/core-effect-command-fixture.json', import.meta.url),
    'utf8'
  ),
  (_key, value) => (value?.type === 'Buffer' ? Buffer.from(value.hex, 'hex') : value)
) as Array<NanoHostSessionEffectRequest & { command: Record<string, unknown> }>;

interface NativeWrite {
  readonly kind: string;
  readonly stream: number | undefined;
  readonly generation: number | null;
  readonly wall: number;
  readonly monotonic: bigint;
  readonly stage: 'head' | 'data' | 'end';
  requestId?: string;
}

async function nativeEffects(
  input: { unwind?: () => void; held?: boolean; exposure?: () => boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-effect-carriage-'));
  const coreDb = createTestCoreDb(root);
  if (input.held) ensureLocalUser(coreDb);
  const storage = await openAdmittedTestNanoHost(coreDb);
  const target = {
    coreDb,
    deploymentId: readDataRootLayoutMarker(root).deploymentId,
    identityId: 'fixture',
    targetId: 'fixture',
    nativeStorage: storage.value,
  };
  const authority = createNanoHostTransportSessionAuthority();
  const dispatch = (
    input.held ? createProductionNanoHostSessionDispatch : createNanoHostSessionDispatch
  )({
    coreDb,
    fileAdmission: new FileStorageAdmission(root, () => 0n),
    sessionAuthority: authority,
    settlePreparedImage: (request) => settlePreparedNanoHostImage(coreDb, storage, request),
  });
  const app = input.held
    ? createApp({
        coreDb,
        mode: 'local',
        nanoHostStorage: storage,
        nanoHostSessionDispatch: dispatch,
        nanohostTransportSessionAuthority: authority,
        releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
      })
    : new Hono<{ Variables: AuthVariables }>();
  if (!input.held) {
    app.use('*', async (context, next) => {
      await next();
      if (context.req.path.startsWith(EFFECT_PATH)) input.unwind?.();
    });
    registerNanoHostSessionSemanticRoutes({
      app,
      coreDb,
      dispatch,
      nanoHostConfig: target,
      nativeStorage: storage,
      releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    });
    registerNanoHostSessionEffectRoutes({
      app,
      dispatch,
      ...(input.exposure ? { exposureAvailable: input.exposure } : {}),
    });
  }
  const listener = getRequestListener(createListenerFetches(app.fetch).nanoHostFetch);
  let physicalReady = Promise.withResolvers<object>();
  const writes: NativeWrite[] = [];
  const server = createServer((request, response) => {
    const physical = readNanoHostPhysicalConnectionContext(request)!;
    if (request.url === PROBE_PATH) {
      physicalReady.resolve(physical);
      response.writeHead(204).end();
      return;
    }
    const kind = request.url.slice(EFFECT_PATH.length);
    const stream = request.stream.id;
    let carriesCommand = false;
    let requestId: string | undefined;
    const currentWrites: NativeWrite[] = [];
    const record = (stage: NativeWrite['stage']) => {
      const item = {
        kind,
        stream,
        stage,
        requestId,
        wall: Date.now(),
        monotonic: process.hrtime.bigint(),
        generation: authority.connectionGeneration(physical),
      };
      writes.push(item);
      currentWrites.push(item);
    };
    const data = (chunk: unknown) => {
      if (!carriesCommand || !(typeof chunk === 'string' || chunk instanceof Uint8Array)) return;
      if (!requestId) {
        try {
          requestId = JSON.parse(Buffer.from(chunk).toString()).requestId;
        } catch {
          // The actual raw command identity is in its native headers.
        }
        for (const event of currentWrites) event.requestId = requestId;
      }
      record('data');
    };
    const writeHead = response.writeHead.bind(response);
    const write = response.write.bind(response);
    const end = response.end.bind(response);
    vi.spyOn(response, 'writeHead').mockImplementation((status, headers) => {
      carriesCommand = request.url.startsWith(EFFECT_PATH) && status === 200;
      if (carriesCommand) {
        requestId = (headers as Record<string, string> | undefined)?.['x-openkit-request-id'];
        record('head');
      }
      return Reflect.apply(writeHead, response, [status, headers]);
    });
    vi.spyOn(response, 'write').mockImplementation((chunk, encoding, callback) => {
      data(chunk);
      return Reflect.apply(write, response, [chunk, encoding, callback]);
    });
    vi.spyOn(response, 'end').mockImplementation((chunk, encoding, callback) => {
      if (carriesCommand) {
        data(chunk);
        record('end');
      }
      return Reflect.apply(end, response, [chunk, encoding, callback]);
    });
    void listener(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  const clients = new Set<ClientHttp2Session>();
  let client: ClientHttp2Session;
  let physical: object;
  onTestFinished(async () => {
    for (const openClient of clients) openClient.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeTestStore(root, coreDb);
  });

  const peerInvocations: Array<{ kind: string; requestId: string }> = [];
  const builds = new Map<string, { dockerfileByteLength: number; dockerfileDigest: string }>();
  const request = (path: string, headers: Record<string, string> = {}) => {
    const stream = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
      ...headers,
    });
    stream.on('error', () => {});
    return stream;
  };
  async function receive(stream: ClientHttp2Stream) {
    const [headers] = (await once(stream, 'response')) as [IncomingHttpHeaders];
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return { status: headers[':status'], headers, body: Buffer.concat(chunks) };
  }
  async function openConnection() {
    physicalReady = Promise.withResolvers<object>();
    const allocated = await transitionAdmittedNanoHostRuntimeTarget(storage.value, {
      kind: 'allocate',
      targetId: target.targetId,
      deploymentId: target.deploymentId,
      identityId: target.identityId,
      observedAt: new Date().toISOString(),
    });
    if (allocated.state !== 'ready' || !allocated.value)
      throw new Error('Fixture RuntimeTarget allocation unavailable.');
    const { connectionGeneration } = allocated.value;
    client = connect(`http://127.0.0.1:${address!.port}`);
    clients.add(client);
    request(PROBE_PATH).end('{}');
    physical = await physicalReady.promise;
    authority.admit({
      physicalConnection: physical,
      identityId: target.identityId,
      connectionGeneration,
    });
    if (input.held) {
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: EPOCH })),
        target
      );
    } else {
      const stream = request(READINESS_PATH);
      const received = receive(stream);
      stream.end(JSON.stringify({ physicalEpoch: EPOCH }));
      expect((await received).status).toBe(204);
    }
  }
  await openConnection();

  async function post(kind: string, body: unknown = {}, headers: Record<string, string> = {}) {
    const stream = request(EFFECT_PATH + kind, headers);
    const received = receive(stream);
    stream.end(JSON.stringify(body));
    const reply = await received;
    if (reply.status !== 200) return reply;
    if (kind === 'reference.import') {
      const requestId = String(reply.headers['x-openkit-request-id']);
      if (reply.headers['x-openkit-entry-kind'] === 'directory') {
        expect(reply.body.byteLength).toBe(0);
      } else {
        const prefix = Number(reply.headers['x-openkit-provider-binding-bytes'] ?? '0');
        const content = reply.body.subarray(prefix);
        expect(content.byteLength).toBe(Number(reply.headers['x-openkit-byte-length']));
        expect(digest(content)).toBe(reply.headers['x-openkit-sha256']);
      }
      peerInvocations.push({ kind, requestId });
    } else if (kind === 'image.build/input') {
      const requestId = String(reply.headers['x-openkit-request-id']);
      const original = builds.get(requestId);
      expect(reply.body.byteLength).toBe(original?.dockerfileByteLength);
      expect(digest(reply.body)).toBe(original?.dockerfileDigest);
      expect(reply.headers['x-openkit-sha256']).toBe(original?.dockerfileDigest);
      peerInvocations.push({ kind: 'image.build', requestId });
    } else {
      const command = JSON.parse(reply.body.toString());
      if (kind === 'image.build') builds.set(command.requestId, command);
      else peerInvocations.push({ kind, requestId: command.requestId });
    }
    return reply;
  }
  return {
    authority,
    coreDb,
    dispatch,
    target,
    request,
    receive,
    post,
    writes,
    peerInvocations,
    physical: () => physical,
    async reconnect() {
      await authority.closePhysicalConnection(physical);
      client.destroy();
      await openConnection();
    },
  };
}

function controlledClock() {
  let wall = Date.now() + 1_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
  onTestFinished(() => clock.mockRestore());
  return {
    now: () => wall,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

function heldOwner() {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    resume: resume.resolve,
    async beforeDelivery() {
      entered.resolve();
      await resume.promise;
      return () => {};
    },
  };
}

it('commits the command on native H2 before middleware advances the clock during unwind', async () => {
  let expire = () => {};
  const fixture = await nativeEffects({ unwind: () => expire() });
  const clock = controlledClock();
  const nativeAt = clock.now();
  expire = () => clock.advance(TEST_ALLOWANCE_MS);
  void fixture.dispatch.effect({
    ...sandboxDelete(),
    deliveryDeadlineUnixMs: nativeAt + TEST_ALLOWANCE_MS,
  });
  const carried = await fixture.post('sandbox.delete');
  expect(carried.status).toBe(200);
  expect(
    fixture.writes.map(({ stage, wall, requestId, generation }) => ({
      stage,
      wall,
      requestId,
      generation,
    }))
  ).toEqual(
    ['head', 'data', 'end'].map((stage) => ({
      stage,
      wall: nativeAt,
      requestId: REQUEST_ID,
      generation: 1,
    }))
  );
  expect(fixture.peerInvocations).toEqual([{ kind: 'sandbox.delete', requestId: REQUEST_ID }]);
});

it('uses the same native first write on all 12 fixed poll routes', async () => {
  const fixture = await nativeEffects();
  for (const kind of NANO_HOST_EFFECT_OPERATIONS) {
    const original = pinnedCommands.find((entry) => entry.kind === kind)!;
    void fixture.dispatch.effect({ ...original, beforeDelivery: assertFixtureOwner });
    expect((await fixture.post(kind)).status, kind).toBe(200);
    const carriage = fixture.writes.filter((event) => event.kind === kind);
    expect(carriage[0]).toMatchObject({
      stage: 'head',
      requestId: original.requestId,
      generation: 1,
    });
    expect(carriage.at(-1)).toMatchObject({
      stage: 'end',
      requestId: original.requestId,
      generation: 1,
    });
    expect(carriage.at(-1)!.monotonic >= carriage[0]!.monotonic).toBe(true);
    if (kind === 'image.build') {
      expect(fixture.peerInvocations.some((call) => call.kind === kind)).toBe(false);
      expect(
        (
          await fixture.post(
            'image.build/input',
            {},
            { 'x-openkit-request-id': original.requestId! }
          )
        ).status
      ).toBe(200);
    }
  }
  expect(fixture.peerInvocations.map(({ kind }) => kind)).toEqual(NANO_HOST_EFFECT_OPERATIONS);
});

it('rechecks the fixed-effect cutoff after the last owner wait even while its timer is delayed', async () => {
  const fixture = await nativeEffects();
  const clock = controlledClock();
  const owner = heldOwner();
  const original = new AbortController();
  void fixture.dispatch.effect({
    ...sandboxDelete(),
    signal: original.signal,
    beforeDelivery: owner.beforeDelivery,
    deliveryDeadlineUnixMs: clock.now() + TEST_ALLOWANCE_MS,
  });
  const polled = fixture.post('sandbox.delete');
  await owner.entered;
  clock.advance(TEST_ALLOWANCE_MS);
  owner.resume();
  const reply = await polled;
  expect(original.signal.aborted).toBe(false);
  expect(fixture.writes).toEqual([]);
  expect(fixture.peerInvocations).toEqual([]);
  expect(reply.status).toBe(204);
  original.abort();
});

it.each(['wall', 'monotonic'] as const)(
  'rechecks the journalled image %s cutoff after the owner wait with the timer delayed',
  async (expiredClock) => {
    const fixture = await nativeEffects();
    const actor = { kind: 'user' as const, id: ensureLocalUser(fixture.coreDb) };
    const store = await createTestServerWorkStore(fixture.coreDb);
    const thread = await createTestServerThread(
      store,
      fixture.coreDb,
      'Image preparation',
      'conversation'
    );
    const turn = await store.createServerTurn(thread.id, 'Prepare the authored image.', actor);
    const clock = controlledClock();
    const owner = heldOwner();
    const originalReader = executionJournal.createExecutionStepJournalReader;
    const read = vi
      .spyOn(executionJournal, 'createExecutionStepJournalReader')
      .mockImplementation((db, scope) => {
        const reader = originalReader(db, scope);
        return {
          ...reader,
          async readInvocation(ref) {
            const invocation = await reader.readInvocation(ref);
            if (invocation.carriage.operation === 'image.acquire') await owner.beforeDelivery();
            return invocation;
          },
        };
      });
    onTestFinished(() => read.mockRestore());
    const pending = fixture.dispatch.effect({
      kind: 'image.acquire',
      requestId: REQUEST_ID,
      input: { imageReference: 'openkit:test' },
      imageExecution: { actor, workId: turn.id, authorize: () => true },
      imageSettlement: {
        authoredArtifactId: testEntityId('ar', 'first_carriage'),
        authoredArtifactVersion: 1,
        authoredContentDigest: `sha256:${'a'.repeat(64)}`,
        inputDigest: `sha256:${'b'.repeat(64)}`,
      },
    });
    const refusal = pending.catch((error: unknown) => error);
    let polled!: ReturnType<typeof fixture.post>;
    await vi.waitFor(async () => {
      polled = fixture.post('image.acquire');
      expect(
        await Promise.race([
          owner.entered.then(() => 'selected'),
          polled.then((reply) => reply.status),
        ])
      ).toBe('selected');
    });
    if (expiredClock === 'wall') clock.advance(900_000);
    else {
      const now = process.hrtime.bigint();
      const monotonic = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(now + 910_000_000_000n);
      onTestFinished(() => monotonic.mockRestore());
    }
    owner.resume();
    const reply = await polled;
    expect(fixture.writes).toEqual([]);
    expect(fixture.peerInvocations).toEqual([]);
    expect(reply.status).toBe(204);
    await expect(refusal).resolves.toMatchObject({
      message: expect.stringContaining('delivery authority'),
    });
  }
);

it('lets one overlapping poll win and prevents the stale waiter from consuming its replacement', async () => {
  const fixture = await nativeEffects();
  const owner = heldOwner();
  let selects = 0;
  const outcome = fixture.dispatch.effect({
    ...sandboxDelete(),
    beforeDelivery: () => (++selects === 1 ? owner.beforeDelivery() : assertFixtureOwner()),
  });
  const stale = fixture.post('sandbox.delete');
  await owner.entered;
  expect((await fixture.post('sandbox.delete')).status).toBe(200);
  expect(
    (
      await fixture.post('sandbox.delete/result', {
        requestId: REQUEST_ID,
        sandboxId: 'fixture-sandbox',
        state: 'deleted',
      })
    ).status
  ).toBe(204);
  await outcome;
  void fixture.dispatch.effect(sandboxDelete(NEXT_ID));
  owner.resume();
  expect((await stale).status).toBe(204);
  expect((await fixture.post('sandbox.delete')).status).toBe(200);
  expect(
    fixture.writes.filter(({ stage }) => stage === 'head').map(({ requestId }) => requestId)
  ).toEqual([REQUEST_ID, NEXT_ID]);
  expect(fixture.peerInvocations.map(({ requestId }) => requestId)).toEqual([REQUEST_ID, NEXT_ID]);
});

it.each(['admission', 'fencing'] as const)(
  'rechecks %s after the deciding owner wait',
  async (revocation) => {
    let exposed = true;
    const fixture = await nativeEffects({ exposure: () => exposed });
    const owner = heldOwner();
    void fixture.dispatch.effect({ ...sandboxDelete(), beforeDelivery: owner.beforeDelivery });
    const originallyAdmitted = fixture.post('sandbox.delete');
    await owner.entered;
    if (revocation === 'admission') exposed = false;
    else fixture.authority.fenceAuthoritative(fixture.target.identityId);
    owner.resume();
    expect((await originallyAdmitted).status).toBe(revocation === 'admission' ? 403 : 409);
    expect(fixture.writes).toEqual([]);
    expect(fixture.peerInvocations).toEqual([]);
  }
);

it('guards a header-only directory import at its native head', async () => {
  const fixture = await nativeEffects();
  const clock = controlledClock();
  const owner = heldOwner();
  const directory = pinnedCommands.find(
    ({ kind, input }) => kind === 'reference.import' && input.entryKind === 'directory'
  )!;
  const original = new AbortController();
  const expired = fixture.dispatch
    .effect({
      ...directory,
      beforeDelivery: owner.beforeDelivery,
      deliveryDeadlineUnixMs: clock.now() + TEST_ALLOWANCE_MS,
      signal: original.signal,
    })
    .catch((error: unknown) => error);
  const polled = fixture.post('reference.import');
  await owner.entered;
  clock.advance(TEST_ALLOWANCE_MS);
  owner.resume();
  const reply = await polled;
  expect(fixture.writes).toEqual([]);
  expect(fixture.peerInvocations).toEqual([]);
  expect(reply).toMatchObject({ status: 204, body: Buffer.alloc(0) });
  original.abort();
  await expired;
  void fixture.dispatch.effect({
    ...directory,
    requestId: NEXT_ID,
    beforeDelivery: assertFixtureOwner,
  });
  expect(await fixture.post('reference.import')).toMatchObject({
    status: 200,
    body: Buffer.alloc(0),
  });
  expect(fixture.writes.map(({ stage, requestId }) => ({ stage, requestId }))).toEqual([
    { stage: 'head', requestId: NEXT_ID },
    { stage: 'end', requestId: NEXT_ID },
  ]);
  expect(fixture.peerInvocations).toEqual([{ kind: 'reference.import', requestId: NEXT_ID }]);
});

it('waits for the exact first file chunk before committing and withholds bytes after cutoff', async () => {
  const fixture = await nativeEffects();
  const clock = controlledClock();
  const sourceRead = heldOwner();
  const body = Buffer.from('file fixture');
  void fixture.dispatch.effect({
    kind: 'reference.import',
    input: {
      sandboxId: 'fixture-sandbox',
      slot: 'worktree',
      relativePath: 'fixture.txt',
      entryKind: 'file',
      executable: false,
      byteLength: body.byteLength,
      sha256: digest(body),
      source: {
        async *open() {
          await sourceRead.beforeDelivery();
          yield body;
        },
      },
    },
    requestId: REQUEST_ID,
    beforeDelivery: assertFixtureOwner,
    deliveryDeadlineUnixMs: clock.now() + TEST_ALLOWANCE_MS,
  });
  const polled = fixture.post('reference.import');
  await sourceRead.entered;
  expect(fixture.writes).toEqual([]);
  clock.advance(TEST_ALLOWANCE_MS);
  sourceRead.resume();
  const reply = await polled;
  expect(fixture.writes).toEqual([]);
  expect(fixture.peerInvocations).toEqual([]);
  expect(reply.status).toBe(204);
});

it('withholds the provider metadata prefix and first file payload when the original grant expires', async () => {
  const fixture = await nativeEffects();
  const clock = controlledClock();
  const owner = heldOwner();
  const body = Buffer.from('fixture');
  const endpoint = {
    binaries: ['/usr/bin/git'],
    host: 'example.test',
    name: 'fixture',
    port: 443,
    rules: [{ method: 'GET', path: '/fixture' }],
  };
  void fixture.dispatch.effect({
    kind: 'reference.import',
    requestId: REQUEST_ID,
    input: {
      sandboxId: 'fixture-sandbox',
      slot: 'runtime-credential',
      relativePath: 'fixture',
      entryKind: 'file',
      executable: false,
      byteLength: body.byteLength,
      sha256: digest(body),
      body,
      providerBinding: {
        declarationId: 'fixture',
        grantId: testEntityId('grant', 'provider_fixture'),
        planId: 'fixture-plan',
        receiptId: 'fixture-receipt',
        vaultReferenceId: testEntityId('vault', 'provider_fixture'),
        materialVersion: 1,
        providerInstanceId: 'fixture-instance',
        providerType: 'fixture-provider',
        credentialKey: 'FIXTURE_VALUE',
        profileId: 'fixture-profile',
        accessShape: {
          id: 'fixture-profile',
          credentialKey: 'FIXTURE_VALUE',
          endpoints: [endpoint],
        },
        deploymentId: 'fixture',
        workspaceId: 'fixture',
        policyIntent: { additionalFilesystemGrants: [], additionalNetworkEndpoints: [endpoint] },
        expiresAtMs: clock.now() + TEST_ALLOWANCE_MS,
      },
    },
    beforeDelivery: owner.beforeDelivery,
  });
  const polled = fixture.post('reference.import');
  await owner.entered;
  clock.advance(TEST_ALLOWANCE_MS);
  owner.resume();
  const reply = await polled;
  expect(fixture.writes).toEqual([]);
  expect(fixture.peerInvocations).toEqual([]);
  expect(reply.status).toBe(204);
});

it.each(['runtime-credential', 'runtime-credential-replace'] as const)(
  'withholds %s headers and DATA when its original runtime-file grant expires',
  async (slot) => {
    const fixture = await nativeEffects();
    const clock = controlledClock();
    const owner = heldOwner();
    const expiry = new Date(clock.now() + TEST_ALLOWANCE_MS).toISOString();
    const grantId = testEntityId('grant', 'file-fixture');
    const referenceId = testEntityId('vault', 'file-fixture');
    const binding: WorkerCredentialFileBinding = {
      declarationId: 'file-fixture',
      planId: 'fixture-plan',
      receiptId: 'fixture-receipt',
      material: { referenceId, version: 1, format: 'utf8' },
      target: { kind: 'file', path: '/sandbox/fixture' },
      access: 'read-only',
      requiredProtection: WORKER_CREDENTIAL_FILE_REQUIREMENT.requiredProtection,
    };
    const environmentPackage = {
      credentials: {
        declarations: [
          {
            id: binding.declarationId,
            visibility: 'runtime-file',
            targetPath: binding.target.path,
            vaultGrantId: grantId,
          },
        ],
      },
    } as AgentEnvironmentPackage;
    let advance = () => {};
    const readGrant = vi
      .spyOn(workerCredentialAuthority, 'assertCurrentWorkerCredentialAuthority')
      .mockImplementation(((_db, _package, now: () => string) => {
        if (now() >= expiry) throw new Error('Synthetic grant expired.');
        advance();
        return {
          grant: { grantId, expiresAt: expiry },
          reference: { referenceId, currentVersion: 1 },
        };
      }) as typeof workerCredentialAuthority.assertCurrentWorkerCredentialAuthority);
    onTestFinished(() => readGrant.mockRestore());
    const carriage = prepareRuntimeFileCarriage(
      fixture.coreDb,
      environmentPackage,
      binding,
      async () => {
        await owner.beforeDelivery();
      }
    );
    // Advance past the grant cutoff after the deciding owner read observes a live grant.
    advance = () => clock.advance(TEST_ALLOWANCE_MS);
    const body = Buffer.from('fixture');
    void fixture.dispatch.effect({
      kind: 'reference.import',
      requestId: REQUEST_ID,
      input: {
        sandboxId: 'fixture-sandbox',
        slot,
        relativePath: 'fixture',
        entryKind: 'file',
        executable: false,
        byteLength: body.byteLength,
        sha256: digest(body),
        body,
      },
      beforeDelivery: carriage.beforeDelivery,
      deliveryDeadlineUnixMs: carriage.deadlineUnixMs,
    });
    const polled = fixture.post('reference.import');
    await owner.entered;
    owner.resume();
    const reply = await polled;
    expect(fixture.writes).toEqual([]);
    expect(fixture.peerInvocations).toEqual([]);
    expect(reply.status).toBe(204);
    expect(readGrant).toHaveBeenCalledTimes(2);
  }
);

it('frees the file slot on cancellation during first source read so a live file verifies once', async () => {
  const fixture = await nativeEffects();
  const sourceRead = heldOwner();
  const cancelled = new AbortController();
  const body = Buffer.from('file fixture');
  const file = {
    sandboxId: 'fixture-sandbox',
    slot: 'worktree',
    relativePath: 'fixture.txt',
    entryKind: 'file',
    executable: false,
    byteLength: body.byteLength,
    sha256: digest(body),
  };
  const aborted = fixture.dispatch
    .effect({
      kind: 'reference.import',
      requestId: REQUEST_ID,
      signal: cancelled.signal,
      input: {
        ...file,
        source: {
          async *open() {
            await sourceRead.beforeDelivery();
            yield body;
          },
        },
      },
      beforeDelivery: assertFixtureOwner,
    })
    .catch((error: unknown) => error);
  const polled = fixture.post('reference.import');
  await sourceRead.entered;
  cancelled.abort();
  await aborted;
  expect((await polled).status).toBe(409);
  expect(fixture.writes).toEqual([]);
  void fixture.dispatch.effect({
    kind: 'reference.import',
    requestId: NEXT_ID,
    input: { ...file, body },
    beforeDelivery: assertFixtureOwner,
  });
  sourceRead.resume();
  expect((await fixture.post('reference.import')).status).toBe(200);
  expect(fixture.peerInvocations).toEqual([{ kind: 'reference.import', requestId: NEXT_ID }]);
});

it('refuses expired accepted build input and leaves the exact build result available', async () => {
  const fixture = await nativeEffects();
  const clock = controlledClock();
  const owner = heldOwner();
  let reads = 0;
  const original = pinnedCommands.find(({ kind }) => kind === 'image.build')!;
  const result = fixture.dispatch
    .effect({
      ...original,
      beforeDelivery: () => (++reads === 1 ? assertFixtureOwner() : owner.beforeDelivery()),
      deliveryDeadlineUnixMs: clock.now() + TEST_ALLOWANCE_MS,
    })
    .catch((error: unknown) => error);
  expect((await fixture.post('image.build')).status).toBe(200);
  const inbound = fixture.post(
    'image.build/input',
    {},
    { 'x-openkit-request-id': original.requestId! }
  );
  await owner.entered;
  clock.advance(TEST_ALLOWANCE_MS);
  owner.resume();
  const reply = await inbound;
  expect(fixture.writes.filter(({ kind }) => kind === 'image.build/input')).toEqual([]);
  expect(fixture.peerInvocations).toEqual([]);
  expect(reply.status).toBe(409);
  expect(
    (
      await fixture.post('image.build/result', {
        requestId: original.requestId,
        failureCode: 'effect_failed',
      })
    ).status
  ).toBe(204);
  await result;
});

it('serves one exact Dockerfile and refuses a duplicate input on the accepted connection', async () => {
  const fixture = await nativeEffects();
  const original = pinnedCommands.find(({ kind }) => kind === 'image.build')!;
  void fixture.dispatch.effect({ ...original, beforeDelivery: assertFixtureOwner });
  expect((await fixture.post('image.build')).status).toBe(200);
  const headers = { 'x-openkit-request-id': original.requestId! };
  expect((await fixture.post('image.build/input', {}, headers)).status).toBe(200);
  expect((await fixture.post('image.build/input', {}, headers)).status).toBe(409);
  expect(
    fixture.writes.filter(({ kind, stage }) => kind === 'image.build/input' && stage === 'head')
  ).toHaveLength(1);
  expect(fixture.peerInvocations).toEqual([{ kind: 'image.build', requestId: original.requestId }]);
});

it('keeps a committed command result-only after loss and never replays it on the successor', async () => {
  const fixture = await nativeEffects();
  const outcome = fixture.dispatch.effect(sandboxDelete());
  expect((await fixture.post('sandbox.delete')).status).toBe(200);
  expect((await fixture.post('sandbox.delete')).status).toBe(204);
  await fixture.reconnect();
  expect(
    (
      await fixture.post('sandbox.delete/result', {
        requestId: NEXT_ID,
        sandboxId: 'fixture-sandbox',
        state: 'deleted',
      })
    ).status
  ).toBe(400);
  expect(
    (
      await fixture.post('sandbox.delete/result', {
        requestId: REQUEST_ID,
        sandboxId: 'fixture-sandbox',
        state: 'deleted',
      })
    ).status
  ).toBe(204);
  await expect(outcome).resolves.toEqual({ sandboxId: 'fixture-sandbox', state: 'deleted' });
  expect((await fixture.post('sandbox.delete')).status).toBe(204);
  expect(fixture.writes.filter(({ stage }) => stage === 'head')).toHaveLength(1);
  expect(fixture.peerInvocations).toEqual([{ kind: 'sandbox.delete', requestId: REQUEST_ID }]);
});

it('refuses the native first write when the original command has no owner proof', async () => {
  const fixture = await nativeEffects();
  const original = new AbortController();
  const pending = fixture.dispatch
    .effect({
      ...sandboxDelete(),
      beforeDelivery: undefined,
      signal: original.signal,
    })
    .catch((error: unknown) => error);
  try {
    const reply = await fixture.post('sandbox.delete');
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body.toString())).toMatchObject({
      message: 'NanoHost effect first-write owner proof is unavailable.',
    });
    expect(fixture.writes).toEqual([]);
    expect(fixture.peerInvocations).toEqual([]);
  } finally {
    original.abort();
    await pending;
  }
});

it('holds production first sends and build input while retaining bounded ownership and result inspection', async () => {
  const fixture = await nativeEffects({ held: true });
  const original = new AbortController();
  const bounded = AbortSignal.any([original.signal, AbortSignal.timeout(30_000)]);
  const queued = fixture.dispatch
    .effect({
      ...sandboxDelete(),
      signal: bounded,
      deliveryDeadlineUnixMs: Date.now() + 30_000,
    })
    .catch((error: unknown) => error);
  expect((await fixture.post('sandbox.delete')).status).toBe(204);
  expect(
    (await fixture.post('image.build/input', {}, { 'x-openkit-request-id': REQUEST_ID })).status
  ).toBe(503);
  await expect(
    fixture.dispatch.effect({
      kind: 'image.inspect',
      input: { imageDigest: `sha256:${'d'.repeat(64)}` },
      requestId: NEXT_ID,
    })
  ).rejects.toBeInstanceOf(NanoHostEffectNotEnqueuedError);
  const retained = fixture.dispatch.expectResultOnly!([
    { kind: 'bridge.close', requestId: NEXT_ID, originPhysicalEpoch: EPOCH },
  ]);
  expect(
    (await fixture.post('bridge.close/result', { requestId: NEXT_ID, state: 'deleted' })).status
  ).toBe(204);
  await expect(retained).resolves.toEqual({ kind: 'bridge.close', result: { state: 'deleted' } });
  expect(fixture.writes).toEqual([]);
  expect(fixture.peerInvocations).toEqual([]);
  original.abort();
  await expect(queued).resolves.toMatchObject({
    message: expect.stringContaining('allowance ended'),
  });
});
