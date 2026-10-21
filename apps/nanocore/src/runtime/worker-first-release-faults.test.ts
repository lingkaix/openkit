import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, constants, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerControlClient } from '../../../../packages/worker-shim/src/control-client.js';
import { runWorkerHarness, WorkerHarness } from '../../../../packages/worker-shim/src/harness.js';
import type { SandboxIntegrationClient } from '../../../../packages/worker-shim/src/integration-client.js';
import { createDefaultWorkerControlGateway } from '../app.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { openBootVerifiedWorkspaceDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  markSchedulerAttemptForTerminalTurn,
  requireSchedulerExecutionAttempt,
} from './execution-attempt-records.js';
import { requireNanoHostExecutionAttempt } from './nanohost-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import type { NanoHostHarnessCommand } from './nanohost-harness-records.js';
import * as harnessRecords from './nanohost-harness-records.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  type NanoHostSessionDispatch,
  type NanoHostSessionEffectRequest,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';
import {
  answerPendingRequest,
  raisePendingRequest,
  readPendingRequest,
} from './pending-requests.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import { registerWorkerControlRoutes } from './worker-control-routes.js';

const harnessLoop = vi.hoisted(() => ({ client: null as SandboxIntegrationClient | null }));

vi.mock('../../../../packages/worker-shim/src/integration-client.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../packages/worker-shim/src/integration-client.js')
  >()),
  openSandboxIntegration: async () => {
    if (!harnessLoop.client) throw new Error('Harness carriage fixture is unavailable.');
    return harnessLoop.client;
  },
}));

// Route final-status polling uses timers/promises; bind that delay to the same fake clock as Harness deadlines.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: <T>(milliseconds: number, value: T) =>
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(value), milliseconds);
    }),
}));

// A fixture can time out before it returns its close handle; do not carry its spy into the next case.
afterEach(() => {
  harnessLoop.client = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const NOW = '2026-10-05T00:00:00.000Z';
const DIGEST = 'a'.repeat(64);

/** Reuses the factory tests' fixed-effect double; native work and host effects are outside this crossing. */
function operationDouble(
  effects: NanoHostSessionEffectRequest[],
  transcript: { events: string },
  exportRoot: string
): NanoHostSessionDispatch {
  return {
    async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      effects.push(request);
      switch (request.kind) {
        case 'image.acquire':
          return { digest: `sha256:${DIGEST}` };
        case 'image.inspect':
          return {
            digest: request.input.imageDigest,
            environmentDefaults: {
              defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
              values: {},
            },
            platform: { architecture: 'amd64', os: 'linux' },
            storageLayout: {
              family: 'openkit-worker',
              gid: 1000,
              uid: 1000,
              version: '1',
              targets: [
                { target: '/openkit/threads' },
                { target: '/sandbox' },
                { target: '/workspace' },
              ],
              workingDirectory: '/tmp/openkit-bootstrap',
            },
          };
        case 'sandbox.create': {
          const storage = request.input.storage as { targets: Record<string, unknown>[] };
          return {
            sandboxId: request.input.sandboxId,
            state: 'created',
            storage: {
              ...storage,
              targets: storage.targets.map((target) => ({ ...target, initialized: true })),
            },
          };
        }
        case 'bridge.open':
          return { accepted: true, integrationReady: true, state: 'open' };
        case 'reference.import':
          return { state: 'imported' };
        case 'workspace.collect':
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        case 'file.export': {
          const bytes = Buffer.from(
            String(request.input.relativePath).endsWith('events.jsonl') ? transcript.events : ''
          );
          const stagingPath = join(mkdtempSync(join(exportRoot, 'export-')), 'body');
          writeFileSync(stagingPath, bytes);
          return {
            stagingPath,
            byteLength: bytes.length,
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          };
        }
        case 'bridge.close':
        case 'sandbox.delete':
          return { state: 'deleted' };
        default:
          throw new Error(`Unexpected fault fixture effect: ${request.kind}`);
      }
    },
    async poll() {
      return null;
    },
    async result() {},
    async fileExportResult() {
      throw new Error('Effects double cannot accept wire exports.');
    },
    async workspaceCollectResult() {
      throw new Error('Effects double cannot accept wire collections.');
    },
    async imageBuildInput() {
      throw new Error('Fault fixture does not build images.');
    },
    async route() {
      throw new Error('Effects double cannot carry semantic requests.');
    },
  };
}

/** Composes real scheduler, Core attempt, control routes, private poll/result routes and Turn closeout over the existing external-effect double. */
async function faultFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-first-release-fault-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const setup = createTestAgentSetup({ requiredCapabilities: ['trusted-worker-inference-relay'] });
  admitTestNativeEnvironment(coreDb, setup.manifest);
  const gateway = createDefaultWorkerControlGateway(coreDb);
  const effects: NanoHostSessionEffectRequest[] = [];
  const transcript = { events: '' };
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb,
    readRuntimeConfig: () => loadRuntimeConfig(dataRoot),
    env: {},
    store,
    workerControlGateway: gateway,
    nanoHostSessionDispatch: operationDouble(effects, transcript, dataRoot),
  });
  const target = { deploymentId: 'fault-deployment', identityId: 'fault-host' };
  allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    ...target,
    targetId: target.identityId,
    observedAt: NOW,
  });
  const authority = createNanoHostTransportSessionAuthority();
  const app = new Hono<{ Variables: AuthVariables }>();
  registerWorkerControlRoutes({ app, coreDb, workerControlGateway: gateway });
  const dispatchedCommands: { operationId: string; operation: string; sequence: number }[] = [];
  registerNanoHostSessionSemanticRoutes({
    app,
    coreDb,
    nanoHostConfig: target,
    dispatch: createNanoHostSessionDispatch({
      coreDb,
      fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
      sessionAuthority: authority,
    }),
    harnessCommandDispatched: (command) => {
      dispatchedCommands.push({
        operationId: command.operationId,
        operation: command.operation,
        sequence: command.sequence,
      });
      return runtime.acceptNanoHostHarnessCommand(command);
    },
    harnessResultSettled: runtime.acceptNanoHostHarnessResult,
    harnessCommandDeliveryFailed: runtime.failNanoHostHarnessDelivery,
  });
  let admitted = false;
  let dropNextPoll = false;
  let resetNextPoll = false;
  let finishNextPoll = false;
  let finishedResetStream: import('node:http2').ClientHttp2Stream | undefined;
  let droppedTransport: { writableFinished: boolean; resetCode: number } | undefined;
  let resolvePeerClosed: (() => void) | undefined;
  let peerClosed: Promise<void> | undefined;
  let droppedCommand: NanoHostHarnessCommand | null = null;
  let droppedWire = '';
  let heldPoll: { entered: () => void; release: Promise<void> } | undefined;
  const listener = getRequestListener(app.fetch);
  const server = createServer((request, response) => {
    if (!admitted) {
      authority.admit({
        connectionGeneration: 1,
        identityId: target.identityId,
        physicalConnection: readNanoHostPhysicalConnectionContext(request)!,
      });
      admitted = true;
    }
    if (heldPoll && request.url === '/worker-control/harness/poll') {
      const hold = heldPoll;
      heldPoll = undefined;
      const writeHead = response.writeHead.bind(response);
      const end = response.end.bind(response);
      let head: Parameters<typeof response.writeHead>;
      response.writeHead = ((...args: Parameters<typeof response.writeHead>) => {
        head = args;
        return response;
      }) as typeof response.writeHead;
      response.end = ((body: string) => {
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(body).operation).toBe('session.open');
        hold.entered();
        void hold.release.then(() => {
          if (!request.stream.destroyed) {
            writeHead(...head);
            end(body);
          }
        });
        return response;
      }) as typeof response.end;
    }
    if (dropNextPoll && request.url === '/worker-control/harness/poll') {
      dropNextPoll = false;
      const finishBeforeReset = finishNextPoll;
      const end = response.end.bind(response);
      if (finishBeforeReset) {
        request.stream.once('close', () => {
          droppedTransport = {
            writableFinished: response.writableFinished,
            resetCode: request.stream.rstCode,
          };
          resolvePeerClosed?.();
        });
      } else {
        response.writeHead = ((statusCode: number) => {
          response.statusCode = statusCode;
          return response;
        }) as typeof response.writeHead;
      }
      // Capture only the actual committed wire body. The finished case uses unmodified native end().
      response.end = ((body: string) => {
        expect(response.statusCode).toBe(200);
        droppedWire = body;
        droppedCommand = JSON.parse(body) as NanoHostHarnessCommand;
        expect(
          coreDb.sqlite.prepare('SELECT operation_state FROM harness_instance_records').get()
        ).toEqual({ operation_state: 'dispatched' });
        if (finishBeforeReset) {
          // The peer cancels after commit, before Core can process RST. Native end() still finishes the local write.
          finishedResetStream!.close(constants.NGHTTP2_CANCEL);
          return end(body);
        }
        request.stream.close(resetNextPoll ? constants.NGHTTP2_CANCEL : constants.NGHTTP2_NO_ERROR);
        return response;
      }) as typeof response.end;
    }
    void listener(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fault fixture address.');
  const client = connect(`http://127.0.0.1:${address.port}`);

  /** Posts on the real authenticated native H2 route; a reset without headers is the injected lost response. */
  const post = async (path: string, body: unknown, signal?: AbortSignal) => {
    const integration = coreDb.sqlite
      .prepare('SELECT sandbox_integration_binding_ref AS ref FROM sandbox_runtime_records')
      .get() as { ref: string } | undefined;
    const resetFinishedResponse = finishNextPoll && path === '/worker-control/harness/poll';
    const stream = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
      ...(integration ? { 'x-openkit-integration-binding': integration.ref } : {}),
    });
    if (resetFinishedResponse) finishedResetStream = stream;
    const abort = () => stream.close(constants.NGHTTP2_CANCEL);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let status: number | undefined;
    stream.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    stream.end(JSON.stringify(body));
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        if (!resetFinishedResponse) chunks.push(Buffer.from(chunk));
      }
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    if (resetFinishedResponse) {
      await peerClosed;
      finishNextPoll = false;
    }
    return { status, body: Buffer.concat(chunks).toString() };
  };
  expect(
    await post('/api/nanohost/transport/session/readiness', { physicalEpoch: DIGEST })
  ).toEqual({ status: 204, body: '' });
  // The real dispatcher requires the exact pending Turn and initiating command receipt (D83).
  store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Exercise a bounded worker fault',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null,
    {
      turnId: testEntityId('tu', 'fault-turn'),
      agentId: setup.manifest.id,
      status: 'pending',
      executorKind: 'worker',
    }
  );
  store.recordCommandRequest({
    command: 'turn.start',
    requestId: 'fault-request',
    scope: {
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    },
    inputHash: 'fault-fixture',
    response: { kind: 'turn', id: testEntityId('tu', 'fault-turn') },
  });
  createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'fault-queue',
    requestId: 'fault-request',
    requestedAgentId: setup.manifest.id,
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: testEntityId('tu', 'fault-turn'),
    turnInput: 'Exercise a bounded worker fault',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  /** Retains enqueue readiness even when preparation finishes before the consumer awaits it. */
  const enqueueSignal = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((ready) => {
      resolve = ready;
    });
    return { promise, resolve };
  };
  const enqueued = {
    'session.open': enqueueSignal(),
    'turn.start': enqueueSignal(),
    'session.inspect': enqueueSignal(),
  };
  const queueOperation = harnessRecords.queueNanoHostHarnessOperation;
  // Observe the committed real enqueue, including one that precedes its readiness waiter.
  const enqueueObserver = vi
    .spyOn(harnessRecords, 'queueNanoHostHarnessOperation')
    .mockImplementation((db, input) => {
      const sequence = queueOperation(db, input);
      if (db === coreDb && input.operation in enqueued) {
        enqueued[input.operation as keyof typeof enqueued].resolve();
      }
      return sequence;
    });
  let settled = false;
  const running = runSchedulerDispatchLoop({
    agentManifests: [setup.manifest],
    coreDb,
    createAgentSessionId: () => testEntityId('as', 'fault-session'),
    createAttemptId: () => testEntityId('attempt', 'fault-lease'),
    executionBackend: runtime.turnExecutor.executionBackend!,
    gatewayConfig: createTestGatewayConfig(),
    maxDispatches: 1,
    store,
    turnExecutor: runtime.turnExecutor,
    providerRegistry: new ProviderRegistry([
      {
        defaultModel: 'openai/gpt-5.2',
        displayName: 'Fault fixture',
        id: 'agent-openrouter',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]),
  }).finally(() => {
    settled = true;
  });
  void running.catch(() => undefined);

  /** Awaits real enqueue without advancing the production clock; Vitest bounds stalled preparation. */
  const waitQueued = async (operation: keyof typeof enqueued) => {
    await Promise.race([
      enqueued[operation].promise,
      running.then(() => {
        throw new Error(`Dispatch loop ended before ${operation} was queued.`);
      }),
    ]);
    const row = coreDb.sqlite
      .prepare('SELECT operation, operation_state FROM harness_instance_records')
      .get();
    expect(row).toEqual({ operation, operation_state: 'queued' });
  };
  const poll = (harnesses?: readonly { harnessInstanceId: string; nextSequence: number }[]) =>
    post('/worker-control/harness/poll', { schemaVersion: 2, ...(harnesses ? { harnesses } : {}) });
  const dispatch = async (operation: keyof typeof enqueued) => {
    await waitQueued(operation);
    const response = await poll();
    expect(response.status, response.body).toBe(200);
    const command = JSON.parse(response.body) as NanoHostHarnessCommand;
    expect(command.operation).toBe(operation);
    return command;
  };
  const result = async (command: NanoHostHarnessCommand, body: Record<string, unknown>) => {
    const response = await post('/worker-control/harness/result', {
      schemaVersion: 2,
      harnessInstanceId: command.harnessInstanceId,
      operationId: command.operationId,
      sequence: command.sequence,
      disposition: 'succeeded',
      body,
    });
    expect(response, response.body).toEqual({ status: 204, body: '' });
  };
  const controlClient = (command: NanoHostHarnessCommand) =>
    new WorkerControlClient({
      baseUrl: 'http://core.test/api/worker-control',
      token: String(command.body.workerControlToken),
      lineage: {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: testEntityId('tu', 'fault-turn'),
        agentSessionId: testEntityId('as', 'fault-session'),
        packageSnapshotId: String(command.body.packageSnapshotId),
        requestId: 'fault-request',
      },
      fetch: async (url, { signal, ...init }) =>
        app.request(url, { ...init, ...(signal ? { signal } : {}) }),
    });
  const close = async () => {
    enqueueObserver.mockRestore();
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  };
  return {
    coreDb,
    store,
    maintenance: () =>
      runNanoHostAttemptRecoveryMaintenance(coreDb, {
        executionBackend: runtime.turnExecutor.executionBackend!,
        cleanupBackendSession: runtime.cleanupBackendSession,
        prepareBackendCleanup: runtime.prepareBackendCleanup,
        restoreBackendSession: runtime.restoreBackendSession,
        reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
        isTurnExecutionActive: runtime.isTurnExecutionActive,
        projectRecoveredTurn: async () => {
          throw new Error('Active worker must retain its original terminal owner.');
        },
      }),
    effects,
    dispatchedCommands,
    running,
    waitQueued,
    dispatch,
    result,
    poll,
    controlClient,
    post,
    holdNextPoll: (entered: () => void, release: Promise<void>) => {
      heldPoll = { entered, release };
    },
    close,
    isSettled: () => settled,
    loseNextPoll: (reset = false, finished = false) => {
      dropNextPoll = true;
      resetNextPoll = reset;
      finishNextPoll = finished;
      if (finished)
        peerClosed = new Promise<void>((resolve) => {
          resolvePeerClosed = resolve;
        });
    },
    droppedTransport: () => droppedTransport,
    droppedCommand: () => droppedCommand,
    droppedWire: () => droppedWire,
    sealTranscript: (command: NanoHostHarnessCommand) => {
      transcript.events = `${JSON.stringify(
        buildWorkerCanonicalTerminalEventRecord({
          lineage: {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: testEntityId('tu', 'fault-turn'),
            agentSessionId: testEntityId('as', 'fault-session'),
            packageSnapshotId: String(command.body.packageSnapshotId),
            requestId: 'fault-request',
          },
          sequence: 1,
          data: { status: 'completed', stopReason: 'completed' },
        })
      )}\n`;
    },
  };
}

const ready = { nativeHandleDigest: DIGEST, nativeHandleState: 'ready' };

describe('Workspace execution journal producer boundaries', () => {
  it.each([
    { boundary: 'delivery', operation: 'session.open' },
    { boundary: 'result', operation: 'session.open' },
    { boundary: 'delivery', operation: 'turn.start' },
    { boundary: 'result', operation: 'turn.start' },
  ] as const)('T2/T3 refuses $operation $boundary while the owning Workspace is unavailable', async ({
    boundary,
    operation,
  }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspaceRoot = dirname(dirname(workspaceDbPath(f.coreDb.dataRoot, workspaceId)));
    const heldRoot = join(f.coreDb.dataRoot, 'unavailable-workspace');
    let moved = false;
    let writerBlock: ReturnType<typeof openBootVerifiedWorkspaceDb> | undefined;
    let acknowledgedStart: NanoHostHarnessCommand | null = null;
    try {
      if (operation === 'turn.start') {
        const opened = await f.dispatch('session.open');
        await f.result(opened, {
          ...ready,
          state: 'open',
          maxActiveTurns: opened.body.maxActiveTurns,
        });
      }
      await f.waitQueued(operation);
      const available = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
      available.sqlite.close();
      const command = boundary === 'result' ? await f.dispatch(operation) : null;
      const originalTurn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
      expect(originalTurn.triggerActor).toEqual({
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      });
      // Hold the real database's writer lock: renaming alone cannot stop an already-open native handle.
      writerBlock = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
      const contender = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
      try {
        writerBlock.sqlite.exec('BEGIN IMMEDIATE');
        contender.sqlite.pragma('busy_timeout = 0');
        expect(() => contender.sqlite.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
      } finally {
        contender.sqlite.close();
      }
      // Move the complete private Workspace and sidecars as well; never synthesize a replacement.
      renameSync(workspaceRoot, heldRoot);
      moved = true;
      expect(() => openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId)).toThrow();
      const response = command
        ? await f.post('/worker-control/harness/result', {
            schemaVersion: 2,
            harnessInstanceId: command.harnessInstanceId,
            operationId: command.operationId,
            sequence: command.sequence,
            disposition: 'succeeded',
            body: {
              ...ready,
              state: operation === 'turn.start' ? 'started' : 'open',
              maxActiveTurns: command.body.maxActiveTurns,
            },
          })
        : await f.poll();
      if (operation === 'turn.start' && command && response.status === 204) {
        acknowledgedStart = command;
      }
      // A Core receipt alone cannot acknowledge an unconsumed Workspace outcome. Do not print credential-bearing wire bodies.
      expect
        .soft({
          delivered: boundary === 'delivery' && response.status === 200,
          acknowledged: boundary === 'result' && response.status === 204,
        })
        .toEqual({ delivered: false, acknowledged: false });
      expect
        .soft(
          existsSync(workspaceDbPath(f.coreDb.dataRoot, workspaceId)),
          'unavailable canonical database must not be recreated'
        )
        .toBe(false);
    } finally {
      if (writerBlock?.sqlite.open) {
        if (writerBlock.sqlite.inTransaction) writerBlock.sqlite.exec('ROLLBACK');
        writerBlock.sqlite.close();
      }
      if (moved) {
        if (existsSync(workspaceRoot))
          renameSync(workspaceRoot, join(f.coreDb.dataRoot, 'unexpected-workspace'));
        renameSync(heldRoot, workspaceRoot);
      }
      if (acknowledgedStart && !f.isSettled()) {
        // Finish the controlled Worker only after the fault assertions; advancing time before its monitor exists can strand teardown.
        f.sealTranscript(acknowledgedStart);
        expect(
          await f.controlClient(acknowledgedStart).recordFinalStatus({
            sequence: 1,
            status: 'completed',
            stopReason: 'completed',
          })
        ).toMatchObject({ accepted: true });
        // Let the existing completion poll consume the final status before waiting for inspection.
        await vi.advanceTimersByTimeAsync(100);
        await f.waitQueued('session.inspect').then(
          async () => {
            await f.result(await f.dispatch('session.inspect'), {
              ...ready,
              state: 'open',
              childState: 'running',
              cleanupState: 'clean',
            });
          },
          (error: unknown) => {
            if (!f.isSettled()) throw error;
          }
        );
      }
      await vi.advanceTimersByTimeAsync(600_000);
      await f.running.catch(() => undefined);
      await f.close();
    }
  });

  it.for([
    'session.open',
    'turn.start',
  ] as const)('T2 commits the actual Worker Turn intent before native %s delivery', async (operation, {
    skip,
  }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspace = openWorkspaceDb(f.coreDb.dataRoot, workspaceId);
    try {
      if (operation === 'turn.start') {
        const opened = await f.dispatch('session.open');
        await f.result(opened, {
          ...ready,
          state: 'open',
          maxActiveTurns: opened.body.maxActiveTurns,
        });
      }
      await f.waitQueued(operation);
      const tables = workspace.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('control_executions', 'control_execution_steps') ORDER BY name"
        )
        .all();
      if (
        tables.length === 0 &&
        !existsSync(new URL('../../drizzle/workspace/0012_execution_journal.sql', import.meta.url))
      ) {
        skip('schema-pending: Workspace0012 execution journal');
      }
      expect(tables).toEqual([{ name: 'control_execution_steps' }, { name: 'control_executions' }]);
      // Read at the completed real enqueue, before the first poll can deliver the command.
      const queued = workspace.sqlite
        .prepare(`
        SELECT s.control_json AS control, s.invocation_json AS invocation,
               r.owner_json AS owner, r.work_id AS workId, r.definition_version AS definitionVersion
        FROM control_execution_steps s JOIN control_executions r ON r.id = s.execution_id
        WHERE s.state = 'intent' AND json_extract(s.control_json, '$.kind') = ?
          AND json_extract(s.invocation_json, '$.carriage.operation') = ?
          AND r.work_id = ?
      `)
        .all(
          operation === 'session.open' ? 'open-session' : 'deliver-start',
          operation,
          testEntityId('tu', 'fault-turn')
        ) as {
        control: string;
        invocation: string;
        owner: string;
        workId: string;
        definitionVersion: string;
      }[];
      expect
        .soft(
          queued.map((row) => ({
            owner: JSON.parse(row.owner),
            workId: row.workId,
            definitionVersion: row.definitionVersion,
            actor: JSON.parse(row.control).actor,
            attemptId: JSON.parse(row.control).attemptId,
          }))
        )
        .toEqual([
          {
            owner: { kind: 'workspace', workspaceId },
            workId: testEntityId('tu', 'fault-turn'),
            definitionVersion: 'workspace-worker-turn/v1',
            actor: f.store.getTurnById(testEntityId('tu', 'fault-turn')).triggerActor,
            attemptId: testEntityId('attempt', 'fault-lease'),
          },
        ]);
      const command = await f.dispatch(operation);
      expect(
        queued.map((row) => {
          const carriage = JSON.parse(row.invocation).carriage;
          return {
            operation: carriage.operation,
            requestId: carriage.requestId,
            sequence: carriage.sequence,
          };
        })
      ).toEqual([{ operation, requestId: command.operationId, sequence: command.sequence }]);
    } finally {
      workspace.sqlite.close();
      await vi.advanceTimersByTimeAsync(600_000);
      await f.running.catch(() => undefined);
      await f.close();
    }
  });
});

describe('first-release worker faults (real Core crossings)', () => {
  it.each([
    'delayed',
    'cancelled',
    'expired',
  ] as const)('bounds committed session.open carriage by its existing parent allowance (%s)', async (mode) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const responseEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const responseRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.holdNextPoll(entered, responseRelease);
    const signals: AbortSignal[] = [];
    let pollCount = 0;
    const results: string[] = [];
    // Native execution is outside this crossing. Only a received command may reach this double.
    const handle = vi
      .spyOn(WorkerHarness.prototype, 'handle')
      .mockImplementation(async (command) => ({
        schemaVersion: 2,
        harnessInstanceId: command.harnessInstanceId,
        operationId: command.operationId,
        sequence: command.sequence,
        disposition: 'succeeded',
        body: { ...ready, state: 'open', maxActiveTurns: command.body.maxActiveTurns },
      }));
    harnessLoop.client = {
      ready: Promise.resolve(),
      close: async () => undefined,
      harnessControlFetch: async (path, init) => {
        if (path.endsWith('/poll')) {
          if (++pollCount > 1) return { ok: false, status: 404, text: async () => '' };
          signals.push(init.signal!);
        } else results.push(init.body);
        const response = await f.post(path, JSON.parse(init.body), init.signal);
        return {
          ok: response.status === 200 || response.status === 204,
          status: response.status!,
          text: async () => response.body,
        };
      },
    } as SandboxIntegrationClient;
    await f.waitQueued('session.open');
    const loop = runWorkerHarness({ signal: controller.signal }).catch((error: unknown) => error);
    try {
      await responseEntered;
      await vi.advanceTimersByTimeAsync(1_250);
      if (mode === 'delayed') {
        if (signals[0]?.aborted) {
          // Record the baseline Core failure before the survival oracle reports RED.
          release();
          await loop;
          await vi.advanceTimersByTimeAsync(250);
          await expect(f.running).rejects.toThrow(
            'NanoHost Harness session.open delivery incomplete: outcome unknown.'
          );
        }
        expect(
          signals[0]?.aborted,
          'an admitted response must survive the fresh one-second header ceiling'
        ).toBe(false);
        expect(f.isSettled()).toBe(false);
        expect(handle).not.toHaveBeenCalled();
        release();
        expect(await loop).toMatchObject({ message: 'Harness poll failed with HTTP 404.' });
        expect(handle).toHaveBeenCalledOnce();
        expect(pollCount).toBe(2);
        expect(results).toHaveLength(1);
        const opened = JSON.parse(results[0]!) as { operationId: string; sequence: number };
        expect(f.dispatchedCommands).toEqual([
          expect.objectContaining({
            operation: 'session.open',
            operationId: opened.operationId,
            sequence: opened.sequence,
          }),
        ]);
        // The exact receipt unlocks the next operation, without executing or dispatching open twice.
        const start = await f.dispatch('turn.start');
        expect(start.sequence).toBe(opened.sequence + 1);
        await f.result(start, { ...ready, state: 'started' });
        const control = f.controlClient(start);
        await control.recordHeartbeat({ status: 'starting' });
        await control.recordHeartbeat({ status: 'running' });
        f.sealTranscript(start);
        await control.recordFinalStatus({
          sequence: 1,
          status: 'completed',
          stopReason: 'completed',
        });
        await vi.advanceTimersByTimeAsync(100);
        await f.result(await f.dispatch('session.inspect'), {
          ...ready,
          state: 'open',
          childState: 'running',
          cleanupState: 'clean',
        });
        await f.running;
        expect(f.store.getTurnById(testEntityId('tu', 'fault-turn')).status).toBe('completed');
      } else {
        if (mode === 'cancelled') controller.abort(new Error('genuine Harness cancellation'));
        else await vi.advanceTimersByTimeAsync(300_000 - 1_250);
        expect(await loop).toBeInstanceOf(Error);
        expect(signals[0]?.aborted).toBe(true);
        release();
        await vi.advanceTimersByTimeAsync(250);
        await expect(f.running).rejects.toThrow(
          mode === 'cancelled'
            ? 'NanoHost Harness session.open delivery incomplete: outcome unknown.'
            : /session.open.*(?:budget expired|outcome unknown)/u
        );
        expect(handle).not.toHaveBeenCalled();
        expect(results).toEqual([]);
        expect(f.store.getTurnById(testEntityId('tu', 'fault-turn')).status).toBe('failed');
      }
    } finally {
      controller.abort(new Error('fixture-complete'));
      release();
      await loop;
      await vi.advanceTimersByTimeAsync(300_000);
      await f.running.catch(() => undefined);
      await f.close();
    }
  }, 60_000);

  it('keeps the Native attempt live across multiple heartbeat deadlines while a Pending Request is unanswered', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    const workspaceDb = openWorkspaceDb(
      f.coreDb.dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    applyScopedMigrations(workspaceDb);
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      const start = await f.dispatch('turn.start');
      await f.result(start, { ...ready, state: 'started' });
      const control = f.controlClient(start);
      await control.recordHeartbeat({ status: 'starting' });
      await control.recordHeartbeat({ status: 'running' });
      const firstDeadline = requireNanoHostExecutionAttempt(
        f.coreDb,
        testEntityId('attempt', 'fault-lease')
      ).heartbeatDeadline;
      const request = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        raisingTurnId: testEntityId('tu', 'fault-turn'),
        requestId: 'fault-question',
        requestItemId: testEntityId('it', 'fault-question-item'),
        kind: 'user-input' as const,
        requesterKind: 'worker' as const,
        agentId: f.store.getTurnById(testEntityId('tu', 'fault-turn')).agentId!,
        agentSessionId: testEntityId('as', 'fault-session'),
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        questions: [
          {
            id: 'continue',
            header: 'Continue',
            question: 'Continue work?',
            options: [],
            isOther: true,
            isSecret: false,
          },
        ],
        now: NOW,
      };
      f.store.createItem({
        id: request.requestItemId,
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: testEntityId('tu', 'fault-turn'),
        type: 'user-input-request',
        status: 'completed',
        userInputRequestId: request.requestId,
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        prompt: 'Continue work?',
        questions: request.questions,
        createdAt: NOW,
        completedAt: NOW,
      });
      raisePendingRequest(workspaceDb.sqlite, request);
      const pendingRecord = readPendingRequest(workspaceDb.sqlite, request.requestId);
      for (let interval = 0; interval < 8; interval += 1) {
        await vi.advanceTimersByTimeAsync(10_000);
        await control.recordHeartbeat({ status: 'running' });
        await f.maintenance();
        expect(
          requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease')).phase
        ).toBe('open');
        expect(readPendingRequest(workspaceDb.sqlite, request.requestId)).toEqual(pendingRecord);
        expect(f.store.getTurnById(testEntityId('tu', 'fault-turn')).status).toBe('running');
      }
      expect(new Date().toISOString()).toBe('2026-10-05T00:01:20.000Z');
      expect(new Date().toISOString() > firstDeadline).toBe(true);
      expect(
        f.coreDb.sqlite
          .prepare(
            "SELECT count(*) AS count FROM worker_control_records WHERE operation = 'event_append'"
          )
          .get()
      ).toEqual({ count: 0 });
      expect(
        answerPendingRequest(
          workspaceDb.sqlite,
          request.requestId,
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          { continue: ['yes'] },
          new Date().toISOString()
        )
      ).toMatchObject({ state: 'resolved', resolution: 'answered' });
      f.sealTranscript(start);
      expect(
        await control.recordFinalStatus({
          sequence: 1,
          status: 'completed',
          stopReason: 'completed',
        })
      ).toMatchObject({ accepted: true });
      await vi.advanceTimersByTimeAsync(100);
      await f.result(await f.dispatch('session.inspect'), {
        ...ready,
        state: 'open',
        childState: 'running',
        cleanupState: 'clean',
      });
      await f.running;
      expect(f.store.getTurnById(testEntityId('tu', 'fault-turn')).status).toBe('completed');
      expect(
        new FsStore({ dataRoot: f.coreDb.dataRoot }).getTurnById(testEntityId('tu', 'fault-turn'))
          .status
      ).toBe('completed');
      expect(f.coreDb.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
      expect(workspaceDb.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      workspaceDb.sqlite.close();
      await f.close();
      vi.useRealTimers();
    }
  });

  // The native runtime is outside this fixture. The real Core lifecycle and H2 routes own recovery and Turn closeout.
  it.each([
    'lost',
    'unfinished-reset',
    'finished-reset',
  ] as const)('recovers a lost committed turn.start from the same live Worker sequence proof (%s)', async (loss) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      const proof = [
        { harnessInstanceId: opened.harnessInstanceId, nextSequence: opened.sequence + 1 },
      ];
      f.loseNextPoll(loss !== 'lost', loss === 'finished-reset');
      expect(await f.poll(proof)).toEqual({ status: undefined, body: '' });
      expect(f.droppedCommand()?.operation).toBe('turn.start');
      if (loss === 'finished-reset')
        expect(f.droppedTransport()).toEqual({
          writableFinished: true,
          resetCode: constants.NGHTTP2_CANCEL,
        });
      const beforeReplay = f.coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get();
      await vi.advanceTimersByTimeAsync(250);
      const recovered = await f.poll(proof);
      expect(
        recovered.status,
        'the same live Worker proves that the dispatched sequence was not received'
      ).toBe(200);
      // Compare bytes through a boolean so a failed assertion cannot print route credentials.
      expect(
        recovered.body === f.droppedWire(),
        'redelivery must retain every original wire byte'
      ).toBe(true);
      expect(f.coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get()).toEqual(
        beforeReplay
      );
      expect(
        f.dispatchedCommands.filter((command) => command.operation === 'turn.start')
      ).toHaveLength(1);
      const start = JSON.parse(recovered.body) as NanoHostHarnessCommand;
      expect(start.sequence).toBe(proof[0]!.nextSequence);
      await f.result(start, { ...ready, state: 'started' });
      const control = f.controlClient(start);
      await control.recordHeartbeat({ status: 'starting' });
      await control.recordHeartbeat({ status: 'running' });
      f.sealTranscript(start);
      expect(
        await control.recordFinalStatus({
          sequence: 1,
          status: 'completed',
          stopReason: 'completed',
        })
      ).toMatchObject({ accepted: true });
      await vi.advanceTimersByTimeAsync(100);
      await f.result(await f.dispatch('session.inspect'), {
        ...ready,
        state: 'open',
        childState: 'running',
        cleanupState: 'clean',
      });
      await f.running;
      const turn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
      expect(turn.status).toBe('completed');
      expect(new FsStore({ dataRoot: f.coreDb.dataRoot }).getTurnById(turn.id)).toEqual(turn);
      expect(
        f.store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      expect(f.coreDb.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  }, 60_000);

  it.each([
    false,
    true,
  ])('fails quickly when a proof-capable Worker dies after turn.start reset (writableFinished: %s)', async (finished) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      f.loseNextPoll(true, finished);
      expect(
        await f.poll([
          { harnessInstanceId: opened.harnessInstanceId, nextSequence: opened.sequence + 1 },
        ])
      ).toEqual({ status: undefined, body: '' });
      if (finished)
        expect(f.droppedTransport()).toEqual({
          writableFinished: true,
          resetCode: constants.NGHTTP2_CANCEL,
        });
      // No successor poll: the Worker died. One poll interval plus the header bound fits within this independent ceiling.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        f.isSettled(),
        'missing non-receipt proof must fail within seconds, not the 300-second result budget'
      ).toBe(true);
      await expect(f.running).rejects.toThrow(/turn.start.*unknown/u);
      const failedTurn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
      expect(failedTurn.status).toBe('failed');
      const delayed = await f.poll([
        { harnessInstanceId: opened.harnessInstanceId, nextSequence: opened.sequence + 1 },
      ]);
      expect([204, 409]).toContain(delayed.status);
      expect(f.store.getTurnById(failedTurn.id)).toEqual(failedTurn);
      expect(
        f.dispatchedCommands.filter((command) => command.operation === 'turn.start')
      ).toHaveLength(1);
      expect(
        f.coreDb.sqlite.prepare('SELECT count(*) AS count FROM worker_control_records').get()
      ).toEqual({ count: 0 });
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  }, 60_000);

  it.each([
    'missing',
    'wrong-instance',
    'stale-sequence',
    'future-sequence',
  ] as const)('refuses %s non-receipt proof without replay or resurrection', async (kind) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      const proof = [
        { harnessInstanceId: opened.harnessInstanceId, nextSequence: opened.sequence + 1 },
      ];
      f.loseNextPoll(true);
      expect(await f.poll(proof)).toEqual({ status: undefined, body: '' });
      const invalid =
        kind === 'missing'
          ? undefined
          : [
              {
                harnessInstanceId:
                  kind === 'wrong-instance' ? 'another-live-harness' : opened.harnessInstanceId,
                nextSequence:
                  kind === 'stale-sequence'
                    ? opened.sequence
                    : kind === 'future-sequence'
                      ? opened.sequence + 2
                      : opened.sequence + 1,
              },
            ];
      expect([204, 409]).toContain((await f.poll(invalid)).status);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.isSettled()).toBe(true);
      await expect(f.running).rejects.toThrow(/turn.start.*unknown/u);
      const failedTurn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
      expect(failedTurn.status).toBe('failed');
      expect([204, 409]).toContain((await f.poll(proof)).status);
      expect(f.store.getTurnById(failedTurn.id)).toEqual(failedTurn);
      expect(
        f.dispatchedCommands.filter((command) => command.operation === 'turn.start')
      ).toHaveLength(1);
      expect(
        f.coreDb.sqlite.prepare('SELECT count(*) AS count FROM worker_control_records').get()
      ).toEqual({ count: 0 });
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  }, 60_000);

  // Real Core setup needs fixture time; virtual time checks prompt failure without waiting on the result budget.
  it.each([
    false,
    true,
  ])('fails a lost committed turn.start quickly for an older Worker that omits sequence proof (writableFinished: %s)', async (finished) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      f.loseNextPoll(true, finished);
      expect(await f.poll()).toEqual({ status: undefined, body: '' });
      expect(f.droppedCommand()?.operation).toBe('turn.start');
      if (finished)
        expect(f.droppedTransport()).toEqual({
          writableFinished: true,
          resetCode: constants.NGHTTP2_CANCEL,
        });
      const nextPoll = await f.poll();
      // Prompt cleanup may already have retired the Integration; neither response may carry work.
      expect([204, 409]).toContain(nextPoll.status);
      expect(
        f.coreDb.sqlite.prepare('SELECT count(*) AS count FROM worker_control_records').get()
      ).toEqual({ count: 0 });
      const expectedFailure = 'NanoHost Harness turn.start delivery incomplete: outcome unknown.';
      await vi.advanceTimersByTimeAsync(100);
      expect(f.isSettled()).toBe(true);
      await expect(f.running).rejects.toThrow(expectedFailure);
      const turn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
      expect(turn.status).toBe('failed');
      expect(turn.error?.message).toContain(expectedFailure);
      expect(
        f.store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'turn-completed',
            stopReason: 'error',
            turn: expect.objectContaining({ status: 'failed' }),
          }),
        }),
      ]);
      expect(new FsStore({ dataRoot: f.coreDb.dataRoot }).getTurnById(turn.id)).toEqual(turn);
      expect(
        f.coreDb.sqlite.prepare('SELECT count(*) AS count FROM worker_control_records').get()
      ).toEqual({ count: 0 });
      expect(f.coreDb.sqlite.prepare('SELECT state FROM worker_backend_sessions').get()).toEqual({
        state: 'cleaned',
      });
      expect(f.effects.map((effect) => effect.kind)).toContain('sandbox.delete');
      expect(f.coreDb.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
      markSchedulerAttemptForTerminalTurn(f.coreDb, turn);
      // D97/D111: terminal failure and physical cleanup cannot prove unread output or evidence.
      expect(
        requireSchedulerExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
      ).toMatchObject({
        phase: 'closing',
        disposition: 'unknown',
        operationId: expect.any(String),
        fenceRef: null,
      });
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  }, 60_000);

  it('fails closed when a dispatched session.inspect result is held for the 300-second budget', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      const start = await f.dispatch('turn.start');
      await f.result(start, { ...ready, state: 'started' });
      const control = f.controlClient(start);
      await control.recordHeartbeat({ status: 'starting' });
      await control.recordHeartbeat({ status: 'running' });
      await control.recordFinalStatus({
        sequence: 1,
        status: 'completed',
        stopReason: 'completed',
      });
      await vi.advanceTimersByTimeAsync(100);
      const inspect = await f.dispatch('session.inspect');
      const accepted = f.coreDb.sqlite
        .prepare("SELECT * FROM worker_control_records WHERE operation = 'final_status'")
        .all();
      expect(accepted).toHaveLength(1);
      expect(await f.poll()).toEqual({ status: 204, body: '' });
      await vi.advanceTimersByTimeAsync(299_999);
      expect(f.isSettled()).toBe(false);
      expect(f.store.getTurnById(testEntityId('tu', 'fault-turn')).status).toBe('running');
      expect(
        f.store
          .getTurnEvents(testEntityId('tu', 'fault-turn'))
          .filter((event) => event.event === 'turn.completed')
      ).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(f.running).rejects.toThrow(
        'NanoHost Harness session.inspect result outage budget expired: dispatched-awaiting-result.'
      );
      const turn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
      expect(turn.status).toBe('failed');
      expect(turn.error?.message).toContain(
        'NanoHost Harness session.inspect result outage budget expired: dispatched-awaiting-result.'
      );
      expect(
        f.coreDb.sqlite
          .prepare("SELECT * FROM worker_control_records WHERE operation = 'final_status'")
          .all()
      ).toEqual(accepted);
      expect(f.effects.map((effect) => effect.kind)).not.toContain('file.export');
      expect(f.effects.map((effect) => effect.kind)).toContain('sandbox.delete');
      expect(inspect.operation).toBe('session.inspect');
      expect(
        f.store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'turn-completed',
            stopReason: 'error',
            turn: expect.objectContaining({ status: 'failed' }),
          }),
        }),
      ]);
      expect(new FsStore({ dataRoot: f.coreDb.dataRoot }).getTurnById(turn.id)).toEqual(turn);
      expect(f.coreDb.sqlite.prepare('SELECT state FROM worker_backend_sessions').get()).toEqual({
        state: 'cleaned',
      });
      markSchedulerAttemptForTerminalTurn(f.coreDb, turn);
      // Submission was accepted, but held inspection leaves collection/evidence unproved.
      expect(
        requireSchedulerExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
      ).toMatchObject({
        phase: 'closing',
        disposition: 'accepted',
        operationId: expect.any(String),
        fenceRef: null,
      });
      expect(f.coreDb.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });
});
