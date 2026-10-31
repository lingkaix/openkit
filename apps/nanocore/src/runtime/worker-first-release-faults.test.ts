import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, constants, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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
import { commandRequestExpiresAt, commandRequestKey, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
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
import { createExecutionStepJournalReader } from './execution-journal.js';
import type { ExecutionJournalIntent } from './execution-step-journal.js';
import { commandInputHash } from './idempotent-command.js';
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
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import {
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
} from './worker-control-records.js';
import { registerWorkerControlRoutes } from './worker-control-routes.js';
import * as workerJournal from './worker-governance-turn-executor.js';

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
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
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
  const requestId = randomUUID();
  const coreDb = openCoreDb(dataRoot);
  // Register before awaited setup so failure cannot remove a live native writer's root.
  const cleanup = async () => {
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  };
  onTestFinished(cleanup);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
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
    harnessCommandDispatched: async (command) => {
      // Physical delivery starts only after the real Factory accepts its native invocation proof.
      const accepted = await runtime.acceptNanoHostHarnessCommand(command);
      // Cached redelivery repeats the proof gate; only a distinct operation is a new dispatch.
      if (
        !dispatchedCommands.some(
          (previous) =>
            previous.operationId === accepted.operationId &&
            previous.sequence === accepted.sequence &&
            previous.operation === accepted.operation
        )
      )
        dispatchedCommands.push({
          operationId: accepted.operationId,
          operation: accepted.operation,
          sequence: accepted.sequence,
        });
      return accepted;
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
        expect(dispatchedCommands).toContainEqual({
          operationId: droppedCommand.operationId,
          operation: droppedCommand.operation,
          sequence: droppedCommand.sequence,
        });
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
    const integration = effects.find((effect) => effect.kind === 'bridge.open')?.input
      .sandboxIntegrationBindingRef;
    const resetFinishedResponse = finishNextPoll && path === '/worker-control/harness/poll';
    const stream = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
      ...(typeof integration === 'string' ? { 'x-openkit-integration-binding': integration } : {}),
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
  // The real dispatcher requires the exact pending Turn and initiating native command receipt.
  const createdAt = new Date().toISOString();
  const scope = {
    actorId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
  };
  await store.createTurn(
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
      commandReceipt: {
        key: commandRequestKey('turn.start', requestId, scope),
        command: 'turn.start',
        requestId,
        scope,
        inputHash: commandInputHash({ input: 'Exercise a bounded worker fault' }),
        responseKind: 'turn',
        createdAt,
        expiresAt: commandRequestExpiresAt(createdAt),
      },
    }
  );
  createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'fault-queue',
    requestId,
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
        requestId,
      },
      fetch: async (url, { signal, ...init }) =>
        app.request(url, { ...init, ...(signal ? { signal } : {}) }),
    });
  const close = async () => {
    enqueueObserver.mockRestore();
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  };
  return {
    coreDb,
    store,
    requestId,
    maintenance: () =>
      runNanoHostAttemptRecoveryMaintenance(coreDb, {
        executionBackend: runtime.turnExecutor.executionBackend!,
        cleanupBackendSession: runtime.cleanupBackendSession,
        reconcileExecutions: () => runtime.executionReconciler.runOnce(),
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
    failHarnessDelivery: runtime.failNanoHostHarnessDelivery,
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
            requestId,
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
    { name: 'live parent', delivered: true },
    { name: 'expired parent', delivered: false },
    { name: 'clock rollback', delivered: false },
    { name: 'fresh native process witness', delivered: false },
  ])('T5 preserves original native allowance at actual Factory delivery: $name', async ({
    name,
    delivered,
  }) => {
    // Actual caller wall time and the native Worker's wall/monotonic clocks remain real at admission.
    const begin = workerJournal.beginWorkerTurnJournalStep;
    let parent: ExecutionJournalIntent | undefined;
    let child: ExecutionJournalIntent | undefined;
    let admittedAt = 0;
    let expiry = '';
    const admission = vi
      .spyOn(workerJournal, 'beginWorkerTurnJournalStep')
      .mockImplementation(async (...args) => {
        const [store, db, turnId, kind, carriage, correlation] = args;
        if (carriage?.operation === 'worker.turn.start.wait' && !parent) {
          if (!correlation)
            throw new Error('Clock fixture requires the actual original parent input.');
          admittedAt = Date.now();
          expiry = new Date(admittedAt + 1_000).toISOString();
          parent = await begin(store, db, turnId, kind, carriage, {
            ...correlation,
            deadline: expiry,
          });
          return parent;
        }
        if (
          parent &&
          correlation?.parent?.stepId === parent.stepId &&
          carriage?.operation === 'turn.start'
        ) {
          // Observe the producer's actual child input; only production can inherit the original cap.
          child = await begin(...args);
          return child;
        }
        return begin(...args);
      });
    const f = await faultFixture();
    let command: NanoHostHarnessCommand | null = null;
    let completed = false;
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        state: 'open',
        maxActiveTurns: opened.body.maxActiveTurns,
      });
      await f.waitQueued('turn.start');
      admission.mockRestore();
      if (!parent || !child)
        throw new Error('Clock fixture requires real parent and exact native child admission.');
      expect(Date.parse(expiry) - admittedAt).toBe(1_000);
      expect(parent.control.deadlineUnixNano).toBe(BigInt(Date.parse(expiry)) * 1_000_000n);
      expect(child.control.deadlineUnixNano).toBe(parent.control.deadlineUnixNano);
      expect(child.parent).toEqual({
        ref: { execution: parent.execution.ref, stepId: parent.stepId },
        deadlineUnixNano: parent.control.deadlineUnixNano,
      });
      // Scheduler authority is immutable Turn input; the native command cap controls delivery.
      // DX Effect And Deadline Semantics keeps operation expiry out of JSON fingerprints.
      const executionDeadline = requireSchedulerExecutionAttempt(
        f.coreDb,
        testEntityId('attempt', 'fault-lease')
      ).deadline;
      expect(executionDeadline).not.toBeNull();
      expect(Date.parse(executionDeadline!)).toBeGreaterThan(Date.parse(expiry));
      const native = await f.store.writeWorkspaceExecutionJournalIntent(
        'ws_00000000-0000-7000-8000-000000000001',
        child
      );
      expect(native.remainingMs).toBeGreaterThan(0);
      expect(native.remainingMs).toBeLessThanOrEqual(1_000);
      const realTimers =
        await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
      if (name === 'live parent') {
        await realTimers.setTimeout(Math.max(0, admittedAt + 500 - Date.now()));
      } else if (name === 'expired parent') {
        await realTimers.setTimeout(Math.max(0, Date.parse(expiry) - Date.now() + 1));
        // The real outage timer can already have ended this child; inspect instead of re-admitting it.
        const workspace = openWorkspaceDb(
          f.coreDb.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001'
        );
        try {
          const expired = await createExecutionStepJournalReader(
            workspace,
            child.execution.ref.owner
          ).readInvocation({ execution: child.execution.ref, stepId: child.stepId });
          expect(expired.remainingMs).toBe(0);
        } finally {
          workspace.sqlite.close();
        }
      } else if (name === 'clock rollback') {
        // Deliberate caller clock uncertainty after genuine native setup; the Worker's clock stays real.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(admittedAt - 1_000);
      } else {
        // A fresh actual native Worker must not adopt the retired owner's process witness.
        await shutdownControlStoreWorkerClient();
        const cold = await f.store.writeWorkspaceExecutionJournalIntent(
          'ws_00000000-0000-7000-8000-000000000001',
          child
        );
        // Successful real admission/read is the fixture check; startup/import failure proves no refusal.
        expect(Date.now()).toBeLessThan(Date.parse(expiry));
        expect(cold.clock).toEqual(native.clock);
        expect(cold.remainingMs).toBe(0);
      }
      const response = await f.poll();
      command =
        response.status === 200 ? (JSON.parse(response.body) as NanoHostHarnessCommand) : null;
      // Core redacted dispatch is not delivery. This response follows the real async Factory proof gate.
      expect(command !== null).toBe(delivered);
      if (command) expect(command.body.deadline).toBe(executionDeadline);
      if (name === 'clock rollback') vi.useRealTimers();
      if (command) {
        await f.result(command, { ...ready, state: 'started' });
        const control = f.controlClient(command);
        await control.recordHeartbeat({ status: 'starting' });
        await control.recordHeartbeat({ status: 'running' });
        f.sealTranscript(command);
        await control.recordFinalStatus({
          sequence: 1,
          status: 'completed',
          stopReason: 'completed',
        });
        await f.result(await f.dispatch('session.inspect'), {
          ...ready,
          state: 'open',
          childState: 'running',
          cleanupState: 'clean',
        });
        await f.running;
        completed = true;
      } else {
        await f.running.catch(() => undefined);
      }
    } finally {
      vi.useRealTimers();
      admission.mockRestore();
      if (!completed && !f.isSettled() && child) {
        // Abandon only the actual addressed command through the existing live failure owner.
        if (!command) {
          const response = await f.poll();
          if (response.status === 200)
            command = JSON.parse(response.body) as NanoHostHarnessCommand;
        }
        const row = f.coreDb.sqlite
          .prepare(`SELECT harness_instance_id AS harnessInstanceId
          FROM harness_instance_records WHERE operation_id = ?`)
          .get(child.carriage.requestId) as { harnessInstanceId: string } | undefined;
        if (row)
          f.failHarnessDelivery(
            {
              harnessInstanceId: row.harnessInstanceId,
              operationId: child.carriage.requestId,
            },
            new Error('Native clock fixture command abandoned.')
          );
        await f.running.catch(() => undefined);
      }
      await f.close();
    }
  }, 60_000);

  it('T3 rolls back an outcome when exact receipt consumption cannot commit, then awaits replay consumption ACK', async () => {
    // Keep wall and monotonic clocks real; virtualize only existing teardown timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await faultFixture();
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspace = openWorkspaceDb(f.coreDb.dataRoot, workspaceId);
    let releaseAck = () => {};
    let replay: ReturnType<typeof f.post> | undefined;
    let ackObserver: { mockRestore(): void } | undefined;
    try {
      const opened = await f.dispatch('session.open');
      const result = {
        schemaVersion: 2,
        harnessInstanceId: opened.harnessInstanceId,
        operationId: opened.operationId,
        sequence: opened.sequence,
        disposition: 'succeeded',
        body: { ...ready, state: 'open', maxActiveTurns: opened.body.maxActiveTurns },
      };
      const originals = workspace.sqlite
        .prepare(`SELECT execution_id AS executionId, step_id AS stepId, state
          FROM control_execution_steps
          WHERE json_extract(invocation_json, '$.carriage.requestId') = ?
            AND json_extract(invocation_json, '$.carriage.sequence') = ?
            AND json_extract(control_json, '$.kind') = 'open-session'`)
        .all(opened.operationId, opened.sequence) as {
        executionId: string;
        stepId: string;
        state: string;
      }[];
      expect(originals).toHaveLength(1);
      const original = originals[0]!;
      expect(original.state).toBe('intent');
      const readOriginal = () =>
        workspace.sqlite
          .prepare('SELECT * FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
          .get(original.executionId, original.stepId);
      const readRoot = () =>
        workspace.sqlite
          .prepare('SELECT * FROM control_executions WHERE id = ?')
          .get(original.executionId);
      const readConsumption = () =>
        workspace.sqlite
          .prepare(`SELECT execution_id AS executionId, inspected_execution_id AS inspectedExecutionId,
          inspected_step_id AS inspectedStepId, state
          FROM control_execution_steps WHERE json_extract(control_json, '$.kind') = 'consume-receipt'
            AND inspected_execution_id = ? AND inspected_step_id = ?`)
          .all(original.executionId, original.stepId);
      const readReceipt = () =>
        f.coreDb.sqlite
          .prepare(`SELECT result_json AS bytes, result_fingerprint AS fingerprint
          FROM harness_instance_records WHERE harness_instance_id = ?`)
          .get(opened.harnessInstanceId) as { bytes: string; fingerprint: string };
      const beforeStep = readOriginal();
      const beforeRoot = readRoot();
      expect(readConsumption()).toEqual([]);
      const executionSql = `'${original.executionId.replaceAll("'", "''")}'`;
      const stepSql = `'${original.stepId.replaceAll("'", "''")}'`;
      // Fault only the second member of the real outcome/consumption tuple after valid native setup.
      workspace.sqlite.exec(`CREATE TRIGGER refuse_exact_harness_consumption
        BEFORE INSERT ON control_execution_steps
        WHEN json_extract(NEW.control_json, '$.kind') = 'consume-receipt'
          AND NEW.inspected_execution_id = ${executionSql} AND NEW.inspected_step_id = ${stepSql}
        BEGIN SELECT RAISE(ABORT, 'exact Harness consumption refused'); END`);
      const refused = await f.post('/worker-control/harness/result', result);
      expect(refused.status).not.toBe(204);
      // Commit Rule: failing consumption must not leave an independently committed outcome.
      expect(readOriginal()).toEqual(beforeStep);
      expect(readRoot()).toEqual(beforeRoot);
      expect(readConsumption()).toEqual([]);
      const receipt = readReceipt();
      expect(JSON.parse(receipt.bytes)).toEqual(result);
      expect(receipt.fingerprint).toBe(createHash('sha256').update(receipt.bytes).digest('hex'));
      expect((await f.poll()).status === 200).toBe(false);
      expect(readReceipt()).toEqual(receipt);
      expect(
        f.dispatchedCommands.filter((command) => command.operation === 'session.open')
      ).toHaveLength(1);
      workspace.sqlite.exec('DROP TRIGGER refuse_exact_harness_consumption');

      let enteredAck!: () => void;
      const ackEntered = new Promise<void>((resolve) => {
        enteredAck = resolve;
      });
      const ackRelease = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      const client = getControlStoreWorkerClient();
      const journal = client.journal.bind(client);
      // Hold only delivery of the real completed native call to its actual Factory consumer.
      ackObserver = vi.spyOn(client, 'journal').mockImplementation(async (database, input) => {
        const reply = await journal(database, input);
        if (input.kind === 'settle' && input.consumeIntentJson) {
          const settlement = JSON.parse(input.inputJson) as { ref: { stepId: string } };
          if (settlement.ref.stepId === original.stepId) {
            enteredAck();
            await ackRelease;
          }
        }
        return reply;
      });
      let responded = false;
      replay = f.post('/worker-control/harness/result', result).finally(() => {
        responded = true;
      });
      await Promise.race([
        ackEntered,
        replay.then(() => {
          throw new Error('Harness result returned before covering native consumption ACK.');
        }),
      ]);
      expect(responded).toBe(false);
      expect(readOriginal()).toMatchObject({ state: 'completed' });
      expect(readConsumption()).toEqual([
        {
          executionId: original.executionId,
          inspectedExecutionId: original.executionId,
          inspectedStepId: original.stepId,
          state: 'intent',
        },
      ]);
      expect(readReceipt()).toEqual(receipt);
      expect((await f.poll()).status === 200).toBe(false);
      expect(responded).toBe(false);
      releaseAck();
      expect(await replay).toEqual({ status: 204, body: '' });
      ackObserver.mockRestore();
      ackObserver = undefined;
      expect(readConsumption()).toHaveLength(1);
      // DX Physical Receipt Consumption: exact HTTP replay reuses the durable ACK; changed core refuses.
      const consumedReceipt = readReceipt();
      const consumedOriginal = readOriginal();
      expect(await f.post('/worker-control/harness/result', result)).toEqual({
        status: 204,
        body: '',
      });
      expect(readReceipt()).toEqual(consumedReceipt);
      expect(
        (
          await f.post('/worker-control/harness/result', {
            ...result,
            body: { ...result.body, maxActiveTurns: Number(opened.body.maxActiveTurns) + 1 },
          })
        ).status
      ).toBe(409);
      expect(readReceipt()).toEqual(consumedReceipt);
      expect(readOriginal()).toEqual(consumedOriginal);
      expect(readConsumption()).toHaveLength(1);
      const start = await f.dispatch('turn.start');
      expect(start.sequence).toBe(opened.sequence + 1);
      expect(
        f.dispatchedCommands.filter((command) => command.operation === 'session.open')
      ).toHaveLength(1);
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
    } finally {
      releaseAck();
      if (replay) await replay.catch(() => undefined);
      ackObserver?.mockRestore();
      workspace.sqlite.exec('DROP TRIGGER IF EXISTS refuse_exact_harness_consumption');
      workspace.sqlite.close();
      if (!f.isSettled()) {
        await vi.advanceTimersByTimeAsync(600_000);
        await f.running.catch(() => undefined);
      }
      await f.close();
      vi.useRealTimers();
    }
  }, 60_000);

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
    vi.setSystemTime(vi.getRealSystemTime());
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
  ] as const)('T2 commits the actual Worker Turn intent before native %s delivery', async (operation) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(vi.getRealSystemTime());
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
    vi.setSystemTime(vi.getRealSystemTime());
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
    vi.setSystemTime(vi.getRealSystemTime());
    const f = await faultFixture();
    const workspaceDb = openWorkspaceDb(
      f.coreDb.dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      const start = await f.dispatch('turn.start');
      const lineage = {
        ...getWorkerBackendSession(f.coreDb, testEntityId('attempt', 'fault-lease'))!,
        requestId: f.requestId,
      };
      await f.result(start, { ...ready, state: 'started' });
      const control = f.controlClient(start);
      await control.recordHeartbeat({ status: 'starting' });
      await control.recordHeartbeat({ status: 'running' });
      const heartbeatStartedAt = Date.now();
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
      await f.store.createItem({
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
      expect(new Date().toISOString()).toBe(new Date(heartbeatStartedAt + 80_000).toISOString());
      expect(new Date().toISOString() > firstDeadline).toBe(true);
      expect(listWorkerControlAcceptedEvents(f.coreDb, lineage)).toEqual([]);
      // Include accepted content chunks omitted by canonical-event readers.
      expect(
        f.coreDb.sqlite
          .prepare(`SELECT count(*) AS count FROM worker_control_records
          WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
            AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ? AND operation = 'event_append'`)
          .get(
            lineage.workspaceId,
            lineage.threadId,
            lineage.turnId,
            lineage.agentSessionId,
            lineage.packageSnapshotId,
            lineage.requestId ?? null
          )
      ).toEqual({ count: 0 });
      expect(
        requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
          .lastWorkerSequence
      ).toBe(9);
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
    vi.setSystemTime(vi.getRealSystemTime());
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
    vi.setSystemTime(vi.getRealSystemTime());
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      const lineage = {
        ...getWorkerBackendSession(f.coreDb, testEntityId('attempt', 'fault-lease'))!,
        requestId: f.requestId,
      };
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
      // Join native failure publication without advancing the original virtual deadline.
      const failureTime = Date.now();
      await expect(f.running).rejects.toThrow(/turn.start.*unknown/u);
      expect(Date.now()).toBe(failureTime);
      expect(
        f.isSettled(),
        'missing non-receipt proof must fail within seconds, not the 300-second result budget'
      ).toBe(true);
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
      expect(listWorkerControlAcceptedEvents(f.coreDb, lineage)).toEqual([]);
      // Include accepted content chunks and other record kinds omitted by canonical-event readers.
      expect(
        f.coreDb.sqlite
          .prepare(`SELECT count(*) AS count FROM worker_control_records
          WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
            AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?`)
          .get(
            lineage.workspaceId,
            lineage.threadId,
            lineage.turnId,
            lineage.agentSessionId,
            lineage.packageSnapshotId,
            lineage.requestId ?? null
          )
      ).toEqual({ count: 0 });
      expect(getWorkerControlAcceptedFinalStatus(f.coreDb, lineage)).toBeNull();
      expect(
        requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
          .lastWorkerSequence
      ).toBeNull();
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
    vi.setSystemTime(vi.getRealSystemTime());
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      const lineage = {
        ...getWorkerBackendSession(f.coreDb, testEntityId('attempt', 'fault-lease'))!,
        requestId: f.requestId,
      };
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
      const failureTime = Date.now();
      await expect(f.running).rejects.toThrow(/turn.start.*unknown/u);
      expect(Date.now()).toBe(failureTime);
      expect(f.isSettled()).toBe(true);
      const failedTurn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
      expect(failedTurn.status).toBe('failed');
      expect([204, 409]).toContain((await f.poll(proof)).status);
      expect(f.store.getTurnById(failedTurn.id)).toEqual(failedTurn);
      expect(
        f.dispatchedCommands.filter((command) => command.operation === 'turn.start')
      ).toHaveLength(1);
      expect(listWorkerControlAcceptedEvents(f.coreDb, lineage)).toEqual([]);
      // Include accepted content chunks and other record kinds omitted by canonical-event readers.
      expect(
        f.coreDb.sqlite
          .prepare(`SELECT count(*) AS count FROM worker_control_records
          WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
            AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?`)
          .get(
            lineage.workspaceId,
            lineage.threadId,
            lineage.turnId,
            lineage.agentSessionId,
            lineage.packageSnapshotId,
            lineage.requestId ?? null
          )
      ).toEqual({ count: 0 });
      expect(getWorkerControlAcceptedFinalStatus(f.coreDb, lineage)).toBeNull();
      expect(
        requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
          .lastWorkerSequence
      ).toBeNull();
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
    vi.setSystemTime(vi.getRealSystemTime());
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      const lineage = {
        ...getWorkerBackendSession(f.coreDb, testEntityId('attempt', 'fault-lease'))!,
        requestId: f.requestId,
      };
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
      expect(listWorkerControlAcceptedEvents(f.coreDb, lineage)).toEqual([]);
      // Include accepted content chunks and other record kinds omitted by canonical-event readers.
      expect(
        f.coreDb.sqlite
          .prepare(`SELECT count(*) AS count FROM worker_control_records
          WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
            AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?`)
          .get(
            lineage.workspaceId,
            lineage.threadId,
            lineage.turnId,
            lineage.agentSessionId,
            lineage.packageSnapshotId,
            lineage.requestId ?? null
          )
      ).toEqual({ count: 0 });
      expect(getWorkerControlAcceptedFinalStatus(f.coreDb, lineage)).toBeNull();
      expect(
        requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
          .lastWorkerSequence
      ).toBeNull();
      const expectedFailure = 'NanoHost Harness turn.start delivery incomplete: outcome unknown.';
      await vi.advanceTimersByTimeAsync(100);
      const failureTime = Date.now();
      await expect(f.running).rejects.toThrow(expectedFailure);
      expect(Date.now()).toBe(failureTime);
      expect(f.isSettled()).toBe(true);
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
      expect(listWorkerControlAcceptedEvents(f.coreDb, lineage)).toEqual([]);
      // Include accepted content chunks and other record kinds omitted by canonical-event readers.
      expect(
        f.coreDb.sqlite
          .prepare(`SELECT count(*) AS count FROM worker_control_records
          WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
            AND agent_session_id = ? AND package_snapshot_id = ? AND request_id IS ?`)
          .get(
            lineage.workspaceId,
            lineage.threadId,
            lineage.turnId,
            lineage.agentSessionId,
            lineage.packageSnapshotId,
            lineage.requestId ?? null
          )
      ).toEqual({ count: 0 });
      expect(getWorkerControlAcceptedFinalStatus(f.coreDb, lineage)).toBeNull();
      expect(
        requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
          .lastWorkerSequence
      ).toBeNull();
      expect(getWorkerBackendSession(f.coreDb, testEntityId('attempt', 'fault-lease'))?.state).toBe(
        'cleaned'
      );
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
    vi.setSystemTime(vi.getRealSystemTime());
    const f = await faultFixture();
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      const start = await f.dispatch('turn.start');
      const lineage = {
        ...getWorkerBackendSession(f.coreDb, testEntityId('attempt', 'fault-lease'))!,
        requestId: f.requestId,
      };
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
      const accepted = getWorkerControlAcceptedFinalStatus(f.coreDb, lineage);
      expect(accepted).not.toBeNull();
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
      expect(getWorkerControlAcceptedFinalStatus(f.coreDb, lineage)).toEqual(accepted);
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
      expect(getWorkerBackendSession(f.coreDb, testEntityId('attempt', 'fault-lease'))?.state).toBe(
        'cleaned'
      );
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
