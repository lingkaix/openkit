import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, constants, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
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
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { bindBootNanoHostAttemptRecovery } from '../bootstrap/nanohost-recovery.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  findNextDispatchableSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
  requireSchedulerExecutionAttemptAdmissionContext,
} from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import {
  type CoreDb,
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openCoreReadDb,
  openWorkspaceDb,
} from '../storage/db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
  testNanoHostRecoveryJoins,
} from '../test-support/admitted-nanohost.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironmentForRoot,
  transitionTestNativeRuntimeTargetFields,
} from '../test-support/native-environment.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import { createTestQueueEntry } from '../test-support/scheduler-admissions.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  markSchedulerAttemptForTerminalTurn,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import {
  acceptSchedulerExecutionObservation,
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  recordSchedulerExecutionOperation,
} from './execution-attempts.js';
import { createExecutionStepJournalReader } from './execution-journal.js';
import type { ExecutionJournalIntent } from './execution-step-journal.js';
import { commandInputHash } from './idempotent-command.js';
import { requireNanoHostExecutionAttempt } from './nanohost-attempt-records.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  runNanoHostAttemptRecoveryMaintenance,
} from './nanohost-attempt-recovery.js';
import {
  createNanoHostEffectRequest,
  nanoHostSandboxIdFromBackendSessionId,
} from './nanohost-effect-identity.js';
import * as harnessRecords from './nanohost-harness.js';
import type { NanoHostHarnessCommand } from './nanohost-harness-records.js';
import {
  createNanoHostSessionDispatch,
  type NanoHostSessionDispatch,
  type NanoHostSessionEffectRequest,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';
import {
  answerPendingRequest,
  raisePendingRequest,
  readPendingRequest,
} from './pending-requests.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from './scheduler-dispatch-loop.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import {
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
} from './worker-control-records.js';
import { registerWorkerControlRoutes } from './worker-control-routes.js';
import * as workerJournal from './worker-governance-turn-executor.js';
import {
  getWorkerStorageBinding,
  getWorkerStorageBindingForSandbox,
} from './worker-storage-binding-records.js';
import { reserveWorkerStorageAttachment } from './worker-storage-bindings.js';
import {
  terminalizeGovernedWorkerTurn,
  workerTurnTerminalPublication,
} from './worker-turn-failure.js';
import { claimIdleWorkspaceCapture } from './workspace-capture-publication.js';
import {
  hasPendingWorkspaceCapture,
  listWorkspaceReconciliationRecords,
} from './workspace-reconciliation-records.js';

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
  exportRoot: string,
  beforeEffect?: (
    kind: NanoHostSessionEffectRequest['kind'],
    request: NanoHostSessionEffectRequest
  ) => Promise<void> | undefined
): NanoHostSessionDispatch {
  return {
    async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      effects.push(request);
      if (beforeEffect) await beforeEffect(request.kind, request);
      switch (request.kind) {
        case 'image.acquire':
          return {
            digest:
              typeof request.input.imageReference === 'string' &&
              request.input.imageReference.startsWith('sha256:')
                ? request.input.imageReference
                : `sha256:${DIGEST}`,
          };
        case 'image.inspect':
          return {
            releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
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
          return { state: 'deleted', sandboxId: request.input.sandboxId };
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

/** Reads one Native record family through the acknowledged NanoHost reader; the Core handle has none of those tables. */
function onNative<Value>(
  coreDb: CoreDb,
  read: (owner: { sqlite: Database.Database }) => Value
): Value {
  return readAdmittedTestNanoHost(coreDb, (sqlite) => read({ sqlite }));
}

/** Composes real scheduler, Core attempt, control routes, private poll/result routes and Turn closeout over the existing external-effect double. */
async function faultFixture({
  alignFixtureWall = false,
  heartbeatClock,
  schedulerFault,
  orderReleaseRefusalRecycle = false,
  useLayoutDeploymentId = false,
  beforeEffect,
}: {
  alignFixtureWall?: boolean;
  heartbeatClock?: () => string;
  schedulerFault?: Promise<never>;
  orderReleaseRefusalRecycle?: boolean;
  useLayoutDeploymentId?: boolean;
  beforeEffect?: Parameters<typeof operationDouble>[3];
} = {}) {
  if (orderReleaseRefusalRecycle) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-first-release-fault-'));
  const requestId = randomUUID();
  const coreDb = openCoreDb(dataRoot);
  // Register before awaited setup so failure cannot remove a live native writer's root.
  let finalizeFixture: (() => Promise<void>) | undefined;
  const cleanup = async () => {
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  };
  onTestFinished(() => (finalizeFixture ?? cleanup)());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  if (alignFixtureWall) {
    const write = store.writeWorkspaceExecutionJournalIntent.bind(store);
    vi.spyOn(store, 'writeWorkspaceExecutionJournalIntent').mockImplementation(async (...args) => {
      const acknowledged = await write(...args);
      // The native journal writer uses real time. Keep the test's virtual time at or past its ACK.
      const admittedMs = Number(acknowledged.clock.admittedUnixNano / 1_000_000n);
      if (Date.now() < admittedMs) vi.setSystemTime(admittedMs);
      return acknowledged;
    });
  }
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const setup = createTestAgentSetup({ requiredCapabilities: ['trusted-worker-inference-relay'] });
  // The fixture joins the admitted NanoHost owner of its root the way the App does (`app.ts`).
  const nanoHostStorage = await admitTestNativeEnvironmentForRoot(coreDb, setup.manifest);
  // A virtual-time case carries its clock to the owner as the caller-supplied `acceptedAt`; the real
  // acknowledged owner still validates and commits every heartbeat.
  const gatewayStorage: typeof nanoHostStorage =
    heartbeatClock && nanoHostStorage.state === 'ready'
      ? {
          ...nanoHostStorage,
          value: {
            ...nanoHostStorage.value,
            owner: {
              ...nanoHostStorage.value.owner,
              workerControlHeartbeat: (input) =>
                nanoHostStorage.value.owner.workerControlHeartbeat({
                  ...input,
                  payload: { ...input.payload, acceptedAt: heartbeatClock() },
                }),
            },
          },
        }
      : nanoHostStorage;
  const gateway = createDefaultWorkerControlGateway(coreDb, undefined, gatewayStorage);
  const effects: NanoHostSessionEffectRequest[] = [];
  const transcript = { events: '' };
  const runtime = createConfiguredWorkerLifecycleRuntime({
    releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    coreDb,
    readRuntimeConfig: () => loadRuntimeConfig(dataRoot),
    env: {},
    store,
    workerControlGateway: gateway,
    nanoHostSessionDispatch: operationDouble(effects, transcript, dataRoot, beforeEffect),
    nanoHostRecovery: testNanoHostRecoveryJoins(nanoHostStorage),
  });
  const target = {
    deploymentId: useLayoutDeploymentId
      ? readDataRootLayoutMarker(dataRoot).deploymentId
      : 'fault-deployment',
    identityId: 'fault-host',
  };
  await transitionTestNativeRuntimeTargetFields('allocate', coreDb, {
    ...target,
    targetId: target.identityId,
    observedAt: NOW,
  });
  const authority = createNanoHostTransportSessionAuthority();
  const app = new Hono<{ Variables: AuthVariables }>();
  registerWorkerControlRoutes({ app, coreDb, workerControlGateway: gateway });
  const dispatchedCommands: { operationId: string; operation: string; sequence: number }[] = [];
  let beforeHarnessCarriage: (() => Promise<void>) | undefined;
  registerNanoHostSessionSemanticRoutes({
    releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    app,
    coreDb,
    nativeStorage: nanoHostStorage,
    nativeHarnessLifecycle: nanoHostStorage.value.owner.harnessTurnLifecycle,
    nanoHostConfig: target,
    dispatch: createNanoHostSessionDispatch({
      coreDb,
      nativeStorage: nanoHostStorage,
      fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
      ...(orderReleaseRefusalRecycle ? { orderReleaseRefusalRecycle: true } : {}),
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
      if (beforeHarnessCarriage) {
        const wait = beforeHarnessCarriage;
        beforeHarnessCarriage = undefined;
        await wait();
      }
      return accepted;
    },
    harnessResultSettled: runtime.acceptNanoHostHarnessResult,
    harnessCommandDeliveryFailed: runtime.failNanoHostHarnessDelivery,
  });
  let admitted = false;
  let dropNextPoll = false;
  let droppedStatus = 200;
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
        expect(response.statusCode).toBe(droppedStatus);
        droppedWire = body;
        if (droppedStatus === 200) {
          droppedCommand = JSON.parse(body) as NanoHostHarnessCommand;
          expect(dispatchedCommands).toContainEqual({
            operationId: droppedCommand.operationId,
            operation: droppedCommand.operation,
            sequence: droppedCommand.sequence,
          });
        }
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
  const post = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    integrationOverride?: string | null,
    sandboxBindingOverride?: string | null
  ) => {
    const bridge = effects.find((effect) => effect.kind === 'bridge.open')?.input;
    const integration =
      integrationOverride === undefined
        ? bridge?.sandboxIntegrationBindingRef
        : integrationOverride;
    const sandboxBinding =
      sandboxBindingOverride === undefined ? bridge?.sandboxBindingRef : sandboxBindingOverride;
    const resetFinishedResponse = finishNextPoll && path === '/worker-control/harness/poll';
    const stream = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
      ...(typeof integration === 'string' ? { 'x-openkit-integration-binding': integration } : {}),
      ...(path === '/worker-control/harness/poll' && typeof sandboxBinding === 'string'
        ? { 'x-openkit-sandbox-binding': sandboxBinding }
        : {}),
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
  await createTestQueueEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'fault-queue',
    requestId,
    requestedAgentId: setup.manifest.id,
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: testEntityId('tu', 'fault-turn'),
    text: 'Exercise a bounded worker fault',
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
    'session.close': enqueueSignal(),
    'turn.interrupt': enqueueSignal(),
  };
  const nextEnqueue = new Map<string, () => void>();
  const queueOperation = harnessRecords.queueNanoHostHarnessOperation;
  // Observe the committed real enqueue, including one that precedes its readiness waiter.
  const enqueueObserver = vi
    .spyOn(harnessRecords, 'queueNanoHostHarnessOperation')
    .mockImplementation(async (db, input, ...admitted) => {
      // Forward the admitted Native lifecycle too; without it the writer falls back to Core.
      const sequence = await queueOperation(db, input, ...admitted);
      if (db === coreDb && input.operation in enqueued) {
        enqueued[input.operation as keyof typeof enqueued].resolve();
        nextEnqueue.get(input.operation)?.();
      }
      return sequence;
    });
  let settled = false;
  let originalTask: ReturnType<typeof runtime.turnExecutor.startTurn> | undefined;
  let originalClaim: ReturnType<typeof runSchedulerDispatchLoop> | undefined;
  const originalEntered = Promise.withResolvers<{
    task: ReturnType<typeof runtime.turnExecutor.startTurn>;
  }>();
  const startOriginal = runtime.turnExecutor.startTurn.bind(runtime.turnExecutor);
  const startObserver = vi
    .spyOn(runtime.turnExecutor, 'startTurn')
    .mockImplementation((...args) => {
      if (!originalTask && args[0] === store && args[1] === testEntityId('tu', 'fault-turn')) {
        // This exact existing claim outlives the public early acknowledgement and executor rejection.
        originalClaim = getSchedulerPreparationClaims(coreDb).get('fault-queue');
        void originalClaim?.catch(() => undefined);
      }
      const task = startOriginal(...args);
      if (!originalTask && args[0] === store && args[1] === testEntityId('tu', 'fault-turn')) {
        originalTask = task;
        originalEntered.resolve({ task });
      }
      return schedulerFault ? Promise.race([task, schedulerFault]) : task;
    });
  const dispatchInput = {
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
  };
  const publicDispatch = runSchedulerDispatchLoop(dispatchInput);
  void publicDispatch.catch(() => undefined);
  // A public submission acknowledgement is not the original executor's terminal join.
  // A pre-start failure or no-start disposition still settles the fixture through its real owner.
  const execution = Promise.race([
    originalEntered.promise.then(({ task }) => task),
    publicDispatch.then(
      () => originalTask,
      (error: unknown) => {
        if (originalTask) return originalTask;
        throw error;
      }
    ),
  ]);
  const running = Promise.allSettled([execution, publicDispatch])
    .then(async ([task, dispatch]) => {
      // Preserve the original full-lifecycle boundary under either public ACK ordering.
      const claim = originalClaim ?? getSchedulerPreparationClaims(coreDb).get('fault-queue');
      if (claim) await claim;
      if (task.status === 'rejected') throw task.reason;
      if (dispatch.status === 'rejected') throw dispatch.reason;
    })
    .finally(() => {
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
    post('/worker-control/harness/poll', {
      schemaVersion: 2,
      releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
      ...(harnesses ? { harnesses } : {}),
    });
  const dispatch = async (operation: keyof typeof enqueued) => {
    await waitQueued(operation);
    const response = await poll();
    expect(response.status, response.body).toBe(200);
    const command = JSON.parse(response.body) as NanoHostHarnessCommand;
    expect(command.operation).toBe(operation);
    return command;
  };
  const result = async (
    command: NanoHostHarnessCommand,
    body: Record<string, unknown>,
    integration?: string
  ) => {
    const response = await post(
      '/worker-control/harness/result',
      {
        schemaVersion: 2,
        harnessInstanceId: command.harnessInstanceId,
        operationId: command.operationId,
        sequence: command.sequence,
        disposition: 'succeeded',
        body,
      },
      undefined,
      integration
    );
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
  let closeTask: Promise<void> | undefined;
  const close = () => {
    closeTask ??= (async () => {
      const errors: unknown[] = [];
      try {
        // Join without rethrowing expected negative-case errors; running retains its raw rejection.
        await Promise.allSettled([running]);
      } finally {
        // Attempt every resource disposal after the full join, even if joining or disposal fails.
        for (const dispose of [
          () => startObserver.mockRestore(),
          () => enqueueObserver.mockRestore(),
          () => client.destroy(),
          () => new Promise<void>((resolve) => server.close(() => resolve())),
          cleanup,
        ]) {
          try {
            await dispose();
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Fault fixture disposal failed.');
    })();
    return closeTask;
  };
  finalizeFixture = close;
  const recovery = {
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
  };
  return {
    coreDb,
    store,
    requestId,
    schedulerClaim: () => originalClaim!,
    nativeOwner: nanoHostStorage.value.owner,
    integration: () => {
      const value = effects.find((effect) => effect.kind === 'bridge.open')?.input
        .sandboxIntegrationBindingRef;
      if (typeof value !== 'string') throw new Error('Fixture Integration binding is missing.');
      return value;
    },
    turnExecutor: runtime.turnExecutor,
    interrupt: (turnId: string) => runtime.turnExecutor.interruptTurn!(store, turnId),
    retireEpoch: async () => {
      const { getNanoHostRuntimeTarget } = await import('./nanohost-runtime-target.js');
      const readTarget = () =>
        onNative(coreDb, (owner) => getNanoHostRuntimeTarget(owner, 'fault-host'))!;
      const target = readTarget();
      expect(target.ready).toBe(true);
      const result = await nanoHostStorage.value.owner.beginEpochRetirement({
        deploymentId: target.deploymentId,
        runtimeTargetId: target.targetId,
        physicalEpoch: target.physicalEpoch!,
        generation: String(target.connectionGeneration),
      });
      expect(result.state).toBe('ready');
      expect(readTarget().ready).toBe(false);
    },
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
    reopenMaintenance: async (workspaceId: string) => {
      await shutdownControlStoreWorkerClient();
      const reopened = openCoreReadDb(dataRoot);
      try {
        const storage = await openAdmittedTestNanoHost(reopened);
        const owner = { kind: 'workspace' as const, workspaceId };
        const { path, contentMount } = nativeProductScope(dataRoot, owner);
        await getControlStoreWorkerClient().open({
          database: `workspace:${path}`,
          path,
          contentMount,
          dataRoot,
          create: false,
          initialize: 'workspace',
          productOwner: owner,
        });
        const lifecycle = createConfiguredWorkerLifecycleRuntime({
          releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
          coreDb: reopened,
          readRuntimeConfig: () => loadRuntimeConfig(dataRoot),
          env: {},
          store: new FsStore({ dataRoot }),
          nanoHostSessionDispatch: operationDouble(effects, transcript, dataRoot, beforeEffect),
          nanoHostRecovery: testNanoHostRecoveryJoins(storage),
        });
        await lifecycle.executionReconciler.runOnce();
      } finally {
        reopened.sqlite.close();
      }
    },
    classifyAfterRestart: async () => {
      const reopened = openCoreDb(coreDb.dataRoot);
      try {
        return await classifyNanoHostAttemptsAfterRestart(reopened, recovery);
      } finally {
        reopened.sqlite.close();
      }
    },
    effects,
    dispatchedCommands,
    running,
    startSuccessor: (attemptId: string, manifest = setup.manifest) =>
      runSchedulerDispatchLoop({
        ...dispatchInput,
        agentManifests: [manifest],
        createAttemptId: () => attemptId,
      }),
    nextEnqueue: (operation: keyof typeof enqueued) =>
      new Promise<void>((resolve) => {
        nextEnqueue.set(operation, resolve);
      }),
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
    holdNextHarnessCarriage: (entered: () => void, release: Promise<void>) => {
      beforeHarnessCarriage = () => {
        entered();
        return release;
      };
    },
    loseNextPoll: (reset = false, finished = false, status = 200) => {
      dropNextPoll = true;
      droppedStatus = status;
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
  ])(
    'T5 preserves original native allowance at actual Factory delivery: $name',
    async ({ name, delivered }) => {
      // Give only the live row delivery slack under host load; negative rows keep their original cap.
      const nativeAllowanceMs = name === 'live parent' ? 10_000 : 1_000;
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
            expiry = new Date(admittedAt + nativeAllowanceMs).toISOString();
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
        expect(Date.parse(expiry) - admittedAt).toBe(nativeAllowanceMs);
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
        expect(native.remainingMs).toBeLessThanOrEqual(nativeAllowanceMs);
        const realTimers =
          await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
        if (name === 'live parent') {
          await realTimers.setTimeout(Math.max(0, admittedAt + nativeAllowanceMs / 2 - Date.now()));
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
          const row = readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
            sqlite
              .prepare(`SELECT harness_instance_id AS harnessInstanceId
          FROM harness_instance_records WHERE operation_id = ?`)
              .get(child.carriage.requestId)
          ) as { harnessInstanceId: string } | undefined;
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
    },
    60_000
  );

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
        readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
          sqlite
            .prepare(`SELECT result_json AS bytes, result_fingerprint AS fingerprint
          FROM harness_instance_records WHERE harness_instance_id = ?`)
            .get(opened.harnessInstanceId)
        ) as { bytes: string; fingerprint: string };
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
  ] as const)(
    'T2/T3 refuses $operation $boundary while the owning Workspace is unavailable',
    async ({ boundary, operation }) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
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
    }
  );

  it.for(['session.open', 'turn.start'] as const)(
    'T2 commits the actual Worker Turn intent before native %s delivery',
    async (operation) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
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
        expect(tables).toEqual([
          { name: 'control_execution_steps' },
          { name: 'control_executions' },
        ]);
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
    }
  );
});

describe('first-release worker faults (real Core crossings)', () => {
  it.each(['delayed', 'cancelled', 'expired'] as const)(
    'bounds committed session.open carriage by its existing parent allowance (%s)',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
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
      const loop = runWorkerHarness({
        releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
        signal: controller.signal,
      }).catch((error: unknown) => error);
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
    },
    60_000
  );

  it('keeps the Native attempt live across multiple heartbeat deadlines while a Pending Request is unanswered', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(vi.getRealSystemTime());
    // This case deliberately advances Main's verification clock. The Worker-control Gateway carries
    // it to the real native owner as each heartbeat's acceptedAt, which the owner validates and commits.
    const f = await faultFixture({
      alignFixtureWall: true,
      heartbeatClock: () => new Date().toISOString(),
    });
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
      const lineage = {
        ...onNative(f.coreDb, (owner) =>
          getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
        )!,
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
      expect(
        onNative(f.coreDb, (owner) => listWorkerControlAcceptedEvents(owner, lineage))
      ).toEqual([]);
      // Include accepted content chunks omitted by canonical-event readers.
      expect(
        readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
          sqlite
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
  }, 60_000);

  // The native runtime is outside this fixture. The real Core lifecycle and H2 routes own recovery and Turn closeout.
  it.each(['lost', 'unfinished-reset', 'finished-reset'] as const)(
    'recovers a lost committed turn.start from the same live Worker sequence proof (%s)',
    async (loss) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
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
        const beforeReplay = readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
          sqlite.prepare('SELECT * FROM harness_instance_records').get()
        );
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
        expect(
          readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
            sqlite.prepare('SELECT * FROM harness_instance_records').get()
          )
        ).toEqual(beforeReplay);
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
    },
    60_000
  );

  it.each([false, true])(
    'fails quickly when a proof-capable Worker dies after turn.start reset (writableFinished: %s)',
    async (finished) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
      try {
        const opened = await f.dispatch('session.open');
        await f.result(opened, {
          ...ready,
          maxActiveTurns: opened.body.maxActiveTurns,
          state: 'open',
        });
        await f.waitQueued('turn.start');
        const lineage = {
          ...onNative(f.coreDb, (owner) =>
            getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
          )!,
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
        const failureTime = performance.now();
        await expect(f.running).rejects.toThrow(/turn.start.*unknown/u);
        expect(performance.now()).toBe(failureTime);
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
        expect(
          onNative(f.coreDb, (owner) => listWorkerControlAcceptedEvents(owner, lineage))
        ).toEqual([]);
        // Include accepted content chunks and other record kinds omitted by canonical-event readers.
        expect(
          readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
            sqlite
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
          )
        ).toEqual({ count: 0 });
        expect(
          onNative(f.coreDb, (owner) => getWorkerControlAcceptedFinalStatus(owner, lineage))
        ).toBeNull();
        expect(
          requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
            .lastWorkerSequence
        ).toBeNull();
      } finally {
        await f.close();
        vi.useRealTimers();
      }
    },
    60_000
  );

  it.each(['missing', 'wrong-instance', 'stale-sequence', 'future-sequence'] as const)(
    'refuses %s non-receipt proof without replay or resurrection',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
      try {
        const opened = await f.dispatch('session.open');
        await f.result(opened, {
          ...ready,
          maxActiveTurns: opened.body.maxActiveTurns,
          state: 'open',
        });
        await f.waitQueued('turn.start');
        const lineage = {
          ...onNative(f.coreDb, (owner) =>
            getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
          )!,
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
        const failureTime = performance.now();
        await expect(f.running).rejects.toThrow(/turn.start.*unknown/u);
        expect(performance.now()).toBe(failureTime);
        expect(f.isSettled()).toBe(true);
        const failedTurn = f.store.getTurnById(testEntityId('tu', 'fault-turn'));
        expect(failedTurn.status).toBe('failed');
        expect([204, 409]).toContain((await f.poll(proof)).status);
        expect(f.store.getTurnById(failedTurn.id)).toEqual(failedTurn);
        expect(
          f.dispatchedCommands.filter((command) => command.operation === 'turn.start')
        ).toHaveLength(1);
        expect(
          onNative(f.coreDb, (owner) => listWorkerControlAcceptedEvents(owner, lineage))
        ).toEqual([]);
        // Include accepted content chunks and other record kinds omitted by canonical-event readers.
        expect(
          readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
            sqlite
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
          )
        ).toEqual({ count: 0 });
        expect(
          onNative(f.coreDb, (owner) => getWorkerControlAcceptedFinalStatus(owner, lineage))
        ).toBeNull();
        expect(
          requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
            .lastWorkerSequence
        ).toBeNull();
      } finally {
        await f.close();
        vi.useRealTimers();
      }
    },
    60_000
  );

  // Real Core setup needs fixture time; virtual time checks prompt failure without waiting on the result budget.
  it.each([false, true])(
    'fails a lost committed turn.start quickly for an older Worker that omits sequence proof (writableFinished: %s)',
    async (finished) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
      try {
        const opened = await f.dispatch('session.open');
        await f.result(opened, {
          ...ready,
          maxActiveTurns: opened.body.maxActiveTurns,
          state: 'open',
        });
        await f.waitQueued('turn.start');
        const lineage = {
          ...onNative(f.coreDb, (owner) =>
            getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
          )!,
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
        // The admitted reader refuses reads while the unknown-delivery failure publication is pending
        // on the virtual clock. The same four Native-evidence reads run after that publication settles
        // below; accepted Worker evidence is append-only, so the settled absence covers this earlier read.
        const expectedFailure = 'NanoHost Harness turn.start delivery incomplete: outcome unknown.';
        await vi.advanceTimersByTimeAsync(100);
        const failureTime = performance.now();
        await expect(f.running).rejects.toThrow(expectedFailure);
        expect(performance.now()).toBe(failureTime);
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
        expect(
          onNative(f.coreDb, (owner) => listWorkerControlAcceptedEvents(owner, lineage))
        ).toEqual([]);
        // Include accepted content chunks and other record kinds omitted by canonical-event readers.
        expect(
          readAdmittedTestNanoHost(f.coreDb, (sqlite) =>
            sqlite
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
          )
        ).toEqual({ count: 0 });
        expect(
          onNative(f.coreDb, (owner) => getWorkerControlAcceptedFinalStatus(owner, lineage))
        ).toBeNull();
        expect(
          requireNanoHostExecutionAttempt(f.coreDb, testEntityId('attempt', 'fault-lease'))
            .lastWorkerSequence
        ).toBeNull();
        expect(
          onNative(f.coreDb, (owner) =>
            getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
          )?.state
        ).toBe('cleaned');
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
    },
    60_000
  );

  it('fails closed when a dispatched session.inspect result is held for the 300-second budget', async () => {
    const { readExecutionJournalRoot } = await import('./execution-journal.js');
    const { NanoHostHarnessOutageError } = await import('./nanohost-runtime-target-records.js');
    const { readStoppedTestNanoHost } = await import('../test-support/admitted-nanohost.js');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(vi.getRealSystemTime());
    const f = await faultFixture({ alignFixtureWall: true });
    try {
      const opened = await f.dispatch('session.open');
      await f.result(opened, {
        ...ready,
        maxActiveTurns: opened.body.maxActiveTurns,
        state: 'open',
      });
      const start = await f.dispatch('turn.start');
      const lineage = {
        ...onNative(f.coreDb, (owner) =>
          getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
        )!,
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
      const readNativeEvidence = (sqlite: Database.Database) => ({
        accepted: getWorkerControlAcceptedFinalStatus({ sqlite }, lineage),
        session: getWorkerBackendSession({ sqlite }, lineage.attemptId),
      });
      const nativeEvidence = readAdmittedTestNanoHost(f.coreDb, readNativeEvidence);
      expect(nativeEvidence.accepted).not.toBeNull();
      expect(nativeEvidence.session).not.toBeNull();
      const oldShim = await f.post('/worker-control/harness/poll', { schemaVersion: 2 });
      expect(oldShim.status).toBe(409);
      expect(JSON.parse(oldShim.body)).toMatchObject({ code: 'worker_release_incompatible' });
      expect(await f.poll()).toEqual({ status: 204, body: '' });
      await vi.advanceTimersByTimeAsync(299_999);
      expect(f.isSettled()).toBe(false);
      const turn = f.store.getTurnById(lineage.turnId);
      expect(turn.status).toBe('running');
      const readAttempt = () => requireSchedulerExecutionAttempt(f.coreDb, lineage.attemptId);
      const attempt = readAttempt();
      expect(attempt.disposition).toBe('accepted');
      const execution = { owner: { kind: 'server' as const }, executionId: attempt.attemptId };
      const readExclusions = () => readExecutionJournalRoot(f.coreDb, execution).exclusionRefs;
      const exclusions = readExclusions();
      expect(exclusions).toContain(`workspace:${lineage.workspaceId}`);
      expect(
        f.store
          .getTurnEvents(testEntityId('tu', 'fault-turn'))
          .filter((event) => event.event === 'turn.completed')
      ).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      // K8b class closure §T3: inspection timeout preserves the durable Turn and exclusions.
      await expect(f.running).rejects.toMatchObject({
        cause: expect.any(NanoHostHarnessOutageError),
      });
      await expect(f.running).rejects.toMatchObject({
        message: 'NanoHost terminal inspection is unavailable.',
        cause: {
          cause: {
            message:
              'NanoHost Harness session.inspect result outage budget expired: dispatched-awaiting-result.',
          },
        },
      });
      await shutdownControlStoreWorkerClient();
      const cold = new FsStore({ dataRoot: f.coreDb.dataRoot });
      expect(cold.getTurnById(turn.id)).toEqual(turn);
      expect(
        cold
          .getTurnEvents(turn.id)
          .filter((event) => event.event === 'turn.completed' || event.event === 'turn.interrupted')
      ).toEqual([]);
      expect(readAttempt()).toEqual(attempt);
      expect(readExclusions()).toEqual(exclusions);
      expect(readStoppedTestNanoHost(f.coreDb, readNativeEvidence)).toEqual(nativeEvidence);
      expect(f.effects.map((effect) => effect.kind)).not.toContain('file.export');
      expect(f.effects.map((effect) => effect.kind)).not.toContain('sandbox.delete');
      expect(inspect.operation).toBe('session.inspect');
      expect(f.coreDb.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it.each([
    ['Epoch retirement', 'NanoHost current physical Epoch authority is unavailable.'],
    ['lost collection ACK', 'NanoHost terminal inspection is unavailable.'],
    [
      'binding close timeout',
      'NanoHost Harness session.close result outage budget expired: dispatched-awaiting-result.',
    ],
    [
      'turnStopSettlement timeout',
      'NanoHost Harness turn.interrupt result outage budget expired: dispatched-awaiting-result.',
    ],
  ] as const)(
    'preserves the accepted final on %s',
    async (fault, expectedCause) => {
      const { readExecutionJournalRoot } = await import('./execution-journal.js');
      const { readStoppedTestNanoHost } = await import('../test-support/admitted-nanohost.js');
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({ alignFixtureWall: true });
      const attemptId = testEntityId('attempt', 'fault-lease');
      const turnId = testEntityId('tu', 'fault-turn');
      let collectionStep: string | undefined;
      let droppedAck: Parameters<FsStore['settleWorkspaceExecutionJournalStep']>[1] | undefined;
      const lostAck = new Error('Collection settlement acknowledgement lost');
      try {
        const open = await f.dispatch('session.open');
        await f.result(open, { ...ready, state: 'open', maxActiveTurns: open.body.maxActiveTurns });
        const start = await f.dispatch('turn.start');
        const lineage = {
          ...onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))!,
          requestId: f.requestId,
        };
        await f.result(start, { ...ready, state: 'started' });
        const control = f.controlClient(start);
        await control.recordHeartbeat({ status: 'starting' });
        await control.recordHeartbeat({ status: 'running' });
        const write = f.store.writeWorkspaceExecutionJournalIntent.bind(f.store);
        f.store.writeWorkspaceExecutionJournalIntent = async (...args) => {
          const ack = await write(...args);
          const proposal = args[1];
          if (proposal.carriage.operation === 'worker.collect.transcript') {
            collectionStep = proposal.stepId;
            if (fault === 'Epoch retirement') await f.retireEpoch();
          }
          return ack;
        };
        if (fault === 'lost collection ACK') {
          const settle = f.store.settleWorkspaceExecutionJournalStep.bind(f.store);
          f.store.settleWorkspaceExecutionJournalStep = async (...args) => {
            const ack = await settle(...args);
            if (
              !droppedAck &&
              args[1].ref.stepId === collectionStep &&
              args[1].state === 'unknown'
            ) {
              droppedAck = args[1];
              throw lostAck;
            }
            return ack;
          };
        }
        const stopping = fault === 'turnStopSettlement timeout';
        const stop = stopping ? f.interrupt(turnId).catch((error: unknown) => error) : null;
        if (stop) await f.dispatch('turn.interrupt');
        f.sealTranscript(start);
        const final = stopping
          ? ({ status: 'cancelled', stopReason: 'aborted' } as const)
          : ({ status: 'completed', stopReason: 'completed' } as const);
        expect(await control.recordFinalStatus({ sequence: 1, ...final })).toMatchObject({
          accepted: true,
        });
        const turn = f.store.getTurnById(turnId);
        expect(turn.status).toBe('running');
        const attempt = requireSchedulerExecutionAttempt(f.coreDb, attemptId);
        const execution = { owner: { kind: 'server' as const }, executionId: attemptId };
        const exclusions = readExecutionJournalRoot(f.coreDb, execution).exclusionRefs;
        expect(exclusions).toContain(`workspace:${lineage.workspaceId}`);
        await vi.advanceTimersByTimeAsync(100);
        if (fault === 'binding close timeout' || fault === 'lost collection ACK') {
          const inspect = await f.dispatch('session.inspect');
          if (fault === 'binding close timeout') {
            await f.result(inspect, {
              state: 'open',
              childState: 'running',
              cleanupState: 'clean',
              nativeHandleState: 'absent',
              nativeHandleDigest: null,
            });
            await f.dispatch('session.close');
          }
        }
        if (fault !== 'Epoch retirement') await vi.advanceTimersByTimeAsync(300_000);
        if (stop) {
          let cause = await stop;
          while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
          expect(cause).toMatchObject({ message: expectedCause });
        }
        const rejected = await f.running.then(
          () => null,
          (error: unknown) => error
        );
        expect(collectionStep).toEqual(expect.any(String));
        await shutdownControlStoreWorkerClient();
        const cold = new FsStore({ dataRoot: f.coreDb.dataRoot });
        // K8b T3 keeps the original Turn until evidence permits publishing its final outcome.
        expect(cold.getTurnById(turnId)).toEqual(turn);
        expect(
          cold
            .getTurnEvents(turnId)
            .filter(
              (event) => event.event === 'turn.completed' || event.event === 'turn.interrupted'
            )
        ).toEqual([]);
        expect(requireSchedulerExecutionAttempt(f.coreDb, attemptId)).toEqual(attempt);
        expect(readExecutionJournalRoot(f.coreDb, execution).exclusionRefs).toEqual(exclusions);
        expect(
          readStoppedTestNanoHost(f.coreDb, (sqlite) =>
            getWorkerControlAcceptedFinalStatus({ sqlite }, lineage)
          )
        ).toMatchObject(final);
        expect(f.effects.map(({ kind }) => kind)).not.toContain('sandbox.delete');
        expect(f.dispatchedCommands.some(({ operation }) => operation === 'session.inspect')).toBe(
          !stopping && fault !== 'Epoch retirement'
        );
        const causes: Error[] = [];
        for (let cause = rejected; cause instanceof Error; cause = cause.cause) causes.push(cause);
        expect(causes.map(({ message }) => message)).toContain(expectedCause);
        if (fault === 'lost collection ACK') {
          expect(droppedAck).toMatchObject({ ref: { stepId: collectionStep }, state: 'unknown' });
          expect(causes.find((cause) => cause instanceof AggregateError)?.errors).toContain(
            lostAck
          );
        }
      } finally {
        if (!f.isSettled()) await vi.advanceTimersByTimeAsync(600_000);
        await f.close();
        vi.useRealTimers();
      }
    },
    60_000
  );

  it.each([
    'Core intake wins',
    'failure close wins',
    'close refused',
    'close times out before commit',
    'close commits but ACK is lost',
    'cancellation final still eligible',
    'intake wins while scheduler closes',
  ] as const)(
    'orders first final with the failure writer when %s',
    async (order) => {
      const records = await import('./worker-control-records.js');
      const { ControlStoreWorkerError } = await import('../storage/control-store-worker-error.js');
      const { hasCoreWorkerFinalIntake } = await import('../storage/core-journal-native.js');
      const { readExecutionJournalRoot } = await import('./execution-journal.js');
      const { markSchedulerExecutionAttemptClosing } = await import('./execution-attempts.js');
      const { readStoppedTestNanoHost } = await import('../test-support/admitted-nanohost.js');
      const intakeWins =
        order === 'Core intake wins' || order === 'intake wins while scheduler closes';
      const failureWins =
        order === 'failure close wins' || order === 'close commits but ACK is lost';
      const schedulerWrites = order === 'intake wins while scheduler closes';
      const cancellation = order === 'cancellation final still eligible';
      const schedulerFault = Promise.withResolvers<never>();
      let unavailable = false;
      let readsRefused = 0;
      const wait = records.waitForWorkerControlFinalStatus;
      const waitSpy = vi
        .spyOn(records, 'waitForWorkerControlFinalStatus')
        .mockImplementation((db, input, read) =>
          wait(db, input, (query) => {
            if (unavailable) {
              unavailable = false;
              readsRefused += 1;
              return { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
            }
            return read!(query);
          })
        );
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(vi.getRealSystemTime());
      const f = await faultFixture({
        alignFixtureWall: true,
        ...(schedulerWrites ? { schedulerFault: schedulerFault.promise } : {}),
      });
      const client = getControlStoreWorkerClient();
      const attemptId = testEntityId('attempt', 'fault-lease');
      const turnId = testEntityId('tu', 'fault-turn');
      const execution = { owner: { kind: 'server' as const }, executionId: attemptId };
      const decide = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const decides = Promise.withResolvers<Awaited<ReturnType<typeof client.executionAttempt>>>();
      const reply = Promise.withResolvers<void>();
      const failurePost = Promise.withResolvers<void>();
      const allowPost = Promise.withResolvers<void>();
      const beforeNativeHold = Promise.withResolvers<void>();
      const allowNative = Promise.withResolvers<void>();
      let closePosts = 0;
      let lateFailurePosts = 0;
      let finalPosts = 0;
      let withholdNative = false;
      const originalClose = client.executionAttempt.bind(client);
      const closeSpy = vi
        .spyOn(client, 'executionAttempt')
        .mockImplementation(async (db, input) => {
          if (
            input.kind !== 'closing' ||
            input.attemptId !== attemptId ||
            input.cause !==
              (schedulerWrites ? 'preparation-or-execution-failed' : 'execution-failed')
          )
            return originalClose(db, input);
          if (++closePosts > 1) return originalClose(db, input);
          entered.resolve();
          await decide.promise;
          if (order === 'close refused') throw new ControlStoreWorkerError('busy', 'not-committed');
          if (order === 'close times out before commit')
            throw new ControlStoreWorkerError('commit-unknown', 'unknown');
          const ack = await originalClose(db, input);
          decides.resolve(ack);
          await reply.promise;
          if (order === 'close commits but ACK is lost')
            throw new ControlStoreWorkerError('commit-unknown', 'unknown');
          return ack;
        });
      const pause = client.pauseForDataRootBackup.bind(client);
      const pauseSpy = vi
        .spyOn(client, 'pauseForDataRootBackup')
        .mockImplementation(async (path) => {
          // Wait before acquiring the Core writer hold for Native settle. Intake has committed.
          if (withholdNative && hasCoreWorkerFinalIntake(f.coreDb, attemptId)) {
            withholdNative = false;
            beforeNativeHold.resolve();
            await allowNative.promise;
          }
          return pause(path);
        });
      type FinalClient = { workerControlFinalStage(...args: unknown[]): Promise<unknown> };
      const stages = client as unknown as FinalClient;
      const finalStage = stages.workerControlFinalStage.bind(stages);
      const finalSpy = vi
        .spyOn(stages, 'workerControlFinalStage')
        .mockImplementation(async (...args) => {
          const stage = args[2] as { kind: string };
          if (stage.kind === 'settle') finalPosts += 1;
          return finalStage(...args);
        });
      // A losing branch cannot clean up an unproved physical state. Keep this refusal independent
      // of Native settle so a mistaken failure post can finish and be detected after reopen.
      const executor = f.turnExecutor as unknown as { cleanupBackendLifecycle(): Promise<void> };
      const cleanup = failureWins
        ? undefined
        : vi
            .spyOn(executor, 'cleanupBackendLifecycle')
            .mockRejectedValue(new Error('Physical cleanup is unavailable in this schedule.'));
      const complete = f.store.completeTurn.bind(f.store);
      f.store.completeTurn = async (...args) => {
        if (args[1]?.status === 'failed' || args[1]?.status === 'interrupted') {
          lateFailurePosts += 1;
          failurePost.resolve();
          await allowPost.promise;
        }
        return complete(...args);
      };
      const running = f.running.catch((error: unknown) => error);
      let final: Promise<unknown> | undefined;
      try {
        const open = await f.dispatch('session.open');
        await f.result(open, { ...ready, state: 'open', maxActiveTurns: open.body.maxActiveTurns });
        const start = await f.dispatch('turn.start');
        const lineage = {
          ...onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))!,
          requestId: f.requestId,
        };
        await f.result(start, { ...ready, state: 'started' });
        const control = f.controlClient(start);
        await control.recordHeartbeat({ status: 'starting' });
        await control.recordHeartbeat({ status: 'running' });
        const turn = f.store.getTurnById(turnId);
        expect(turn.status).toBe('running');
        const exclusions = readExecutionJournalRoot(f.coreDb, execution).exclusionRefs;
        expect(exclusions).toContain(`workspace:${lineage.workspaceId}`);
        expect(hasCoreWorkerFinalIntake(f.coreDb, attemptId)).toBe(false);
        if (cancellation)
          await markSchedulerExecutionAttemptClosing(f.coreDb, {
            attemptId,
            cause: 'turn-cancelled',
          });
        const payload = cancellation
          ? ({ sequence: 1, status: 'cancelled', stopReason: 'aborted' } as const)
          : ({ sequence: 1, status: 'completed', stopReason: 'completed' } as const);
        const failureCaller = schedulerWrites
          ? f.schedulerClaim().catch((error: unknown) => error)
          : running;
        if (schedulerWrites)
          schedulerFault.reject(new Error('Scheduler-side completion observation failed'));
        else {
          unavailable = true;
          await vi.advanceTimersByTimeAsync(200);
        }
        await Promise.race([
          entered.promise,
          failureCaller.then((error) => {
            throw error;
          }),
        ]);
        if (intakeWins) {
          withholdNative = true;
          final = control.recordFinalStatus(payload);
          void final.catch(() => undefined);
          await Promise.race([
            beforeNativeHold.promise,
            final.then(() => {
              throw new Error('Native final was not withheld.');
            }),
          ]);
          expect(hasCoreWorkerFinalIntake(f.coreDb, attemptId)).toBe(true);
          expect(finalPosts).toBe(0);
        }
        decide.resolve();
        if (intakeWins || cancellation || failureWins) {
          const ack = await Promise.race([
            decides.promise,
            failureCaller.then((error) => {
              throw error;
            }),
          ]);
          expect(ack).toMatchObject({
            phase: 'closing',
            terminalCause: intakeWins
              ? 'worker-final-status'
              : cancellation
                ? 'turn-cancelled'
                : 'execution-failed',
          });
          expect(lateFailurePosts).toBe(0);
          if (failureWins) {
            await expect(control.recordFinalStatus(payload)).rejects.toMatchObject({
              code: 'worker_control_lease_not_live',
            });
            expect(hasCoreWorkerFinalIntake(f.coreDb, attemptId)).toBe(false);
            expect(f.store.getTurnById(turnId)).toEqual(turn);
          }
        }
        reply.resolve();
        if (!failureWins) {
          await Promise.race([failurePost.promise, failureCaller]);
          if (!intakeWins)
            expect(requireSchedulerExecutionAttempt(f.coreDb, attemptId).phase).toBe(
              cancellation ? 'closing' : 'open'
            );
          allowNative.resolve();
          expect(await (final ?? control.recordFinalStatus(payload))).toMatchObject({
            accepted: true,
          });
          if (schedulerWrites) {
            unavailable = true;
            await vi.advanceTimersByTimeAsync(200);
          }
        }
        allowPost.resolve();
        const { setTimeout: realDelay } =
          await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
        for (let n = 0; n < 4 && !f.isSettled(); n += 1) {
          await realDelay(100);
          if (failureWins) await vi.advanceTimersByTimeAsync(300_000);
        }
        await running;
        expect(readsRefused).toBe(1);
        await shutdownControlStoreWorkerClient();
        const reopened = new FsStore({ dataRoot: f.coreDb.dataRoot });
        const retained = reopened.getTurnById(turnId);
        const events = reopened
          .getTurnEvents(turnId)
          .filter(
            (event) => event.event === 'turn.completed' || event.event === 'turn.interrupted'
          );
        const accepted = readStoppedTestNanoHost(f.coreDb, (sqlite) =>
          getWorkerControlAcceptedFinalStatus({ sqlite }, lineage)
        );
        if (failureWins) {
          expect(retained.status).toBe('failed');
          expect(events).toHaveLength(1);
          expect(accepted).toBeNull();
        } else {
          expect(retained).toEqual(turn);
          expect(events).toEqual([]);
          expect(accepted).toMatchObject({
            status: payload.status,
            stopReason: payload.stopReason,
          });
          expect(requireSchedulerExecutionAttempt(f.coreDb, attemptId)).toMatchObject({
            phase: 'closing',
            terminalCause: cancellation ? 'turn-cancelled' : 'worker-final-status',
            fenceRef: null,
          });
          expect(readExecutionJournalRoot(f.coreDb, execution).exclusionRefs).toEqual(exclusions);
          expect(cleanup).not.toHaveBeenCalled();
          expect(f.effects.map(({ kind }) => kind)).not.toContain('sandbox.delete');
        }
      } finally {
        decide.resolve();
        reply.resolve();
        allowPost.resolve();
        allowNative.resolve();
        if (!f.isSettled()) await vi.advanceTimersByTimeAsync(600_000);
        await f.close();
        closeSpy.mockRestore();
        finalSpy.mockRestore();
        pauseSpy.mockRestore();
        cleanup?.mockRestore();
        waitSpy.mockRestore();
        vi.useRealTimers();
      }
    },
    60_000
  );
});

// G4: same-schema old/missing identity must never release the pending material-bearing command.
it('refuses incompatible bound polls before readiness or session material, then admits the exact build', async () => {
  const f = await faultFixture();
  let released: NanoHostHarnessCommand | undefined;
  try {
    await f.waitQueued('session.open');
    for (const releaseIdentity of [
      undefined,
      null,
      { sourceCommit: null, releaseTag: null },
      { sourceCommit: 'b'.repeat(40), releaseTag: null },
      { sourceCommit: 'a'.repeat(40), releaseTag: 'private-value-canary' },
    ]) {
      const response = await f.post('/worker-control/harness/poll', {
        schemaVersion: 2,
        releaseIdentity,
      });
      if (response.status === 200) released = JSON.parse(response.body) as NanoHostHarnessCommand;
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        code: 'worker_release_incompatible',
      });
      expect(response.body).not.toContain('private-value-canary');
      expect(f.dispatchedCommands).toEqual([]);
    }
    const response = await f.poll();
    expect(response.status, response.body).toBe(200);
    released = JSON.parse(response.body) as NanoHostHarnessCommand;
    expect(released.operation).toBe('session.open');
    expect(f.dispatchedCommands).toHaveLength(1);
  } finally {
    if (!released) {
      const response = await f.poll();
      if (response.status === 200) released = JSON.parse(response.body) as NanoHostHarnessCommand;
    }
    if (released)
      f.failHarnessDelivery(
        released,
        new Error('Release identity fixture abandoned its addressed open.')
      );
    await f.running.catch(() => undefined);
    await f.close();
  }
});

const releaseRefusalPoll = '/worker-control/harness/poll';
const mismatchedBuild = {
  schemaVersion: 2,
  releaseIdentity: { sourceCommit: 'b'.repeat(40), releaseTag: null },
};

function reopenReleaseRefusal(coreDb: ReturnType<typeof openCoreDb>) {
  const observed = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import Database from 'better-sqlite3';
         import { openCoreReadDb, serverStoragePath } from ${JSON.stringify(new URL('../storage/db.ts', import.meta.url).href)};
         import { readExecutionJournalInvocation, readExecutionJournalRoot } from ${JSON.stringify(
           new URL('./execution-journal.ts', import.meta.url).href
         )};
         const db = openCoreReadDb(process.argv[1]);
         const native = new Database(serverStoragePath(process.argv[1], 'nanohost'), {
           readonly: true, fileMustExist: true,
         });
         try {
           const rows = db.sqlite.prepare(\`
             SELECT id FROM control_executions
             WHERE definition_version = 'core-sandbox-release-refusal/v1'
           \`).all();
           console.log(JSON.stringify(rows.map(({ id }) => {
             const execution = { owner: { kind: 'server' }, executionId: id };
             const root = readExecutionJournalRoot(db, execution);
             const step = readExecutionJournalInvocation(db, { execution, stepId: 'fence' });
             const binding = step.carriage.bindingRef;
             const resident = native.prepare(
               'SELECT drain_state AS drain FROM sandbox_runtime_records WHERE sandbox_binding_ref=?'
             ).get(binding);
             return { binding, state: step.state, phase: root.phase, drain: resident?.drain };
           })));
         } finally { native.close(); db.sqlite.close(); }`,
      coreDb.dataRoot,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  return JSON.parse(observed);
}

/** End the fixture's original result budget after the refusal observations. */
async function closeReleaseRefusalFixture(f: Awaited<ReturnType<typeof faultFixture>>) {
  await vi.advanceTimersByTimeAsync(harnessRecords.NANO_HOST_HARNESS_RESULT_BUDGET_MS);
  await f.close();
}

it('records one bound release refusal and leaves a foreign Sandbox untouched', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    const binding = onNative(f.coreDb, (owner) =>
      getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
    )!.sandboxBindingRef;
    mutateAdmittedTestNanoHost(f.coreDb, (sqlite) =>
      sqlite
        .prepare(`INSERT INTO sandbox_runtime_records (
      sandbox_runtime_id, runtime_target_id, origin_physical_epoch,
      sandbox_binding_ref, sandbox_integration_binding_ref, sandbox_compatibility_key,
      image_digest, environment_class, max_open_sessions, max_harnesses, max_active_turns,
      lifecycle_state, health_state, drain_state, cleanup_state, created_at, updated_at
    ) SELECT 'other-sandbox', runtime_target_id, ?,
      'other-binding', 'other-integration', sandbox_compatibility_key, image_digest,
      environment_class, max_open_sessions, max_harnesses, max_active_turns,
      lifecycle_state, health_state, drain_state, cleanup_state, created_at, updated_at
      FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?`)
        .run('c'.repeat(64), binding)
    );
    expect((await f.post(releaseRefusalPoll, mismatchedBuild, undefined, null)).status).toBe(409);
    for (const proof of [null, `${binding}, ${binding}`]) {
      expect(
        (await f.post(releaseRefusalPoll, mismatchedBuild, undefined, undefined, proof)).status
      ).toBe(503);
    }
    expect(
      await f.post(
        releaseRefusalPoll,
        {
          schemaVersion: 2,
          releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
        },
        undefined,
        undefined,
        'different-sandbox-binding'
      )
    ).toEqual({ status: 204, body: '' });
    expect(
      onNative(f.coreDb, ({ sqlite }) =>
        sqlite
          .prepare(`SELECT h.operation_state FROM harness_instance_records h
            JOIN sandbox_runtime_records s USING (sandbox_runtime_id)
            WHERE s.sandbox_binding_ref=?`)
          .pluck()
          .all(binding)
      )
    ).toEqual(['queued']);
    expect(
      (
        await f.post(
          releaseRefusalPoll,
          mismatchedBuild,
          undefined,
          'other-integration',
          'other-binding'
        )
      ).status
    ).toBe(503);
    expect(reopenReleaseRefusal(f.coreDb)).toEqual([]);

    const refused = await f.post(releaseRefusalPoll, mismatchedBuild);
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'worker_release_incompatible' });
    expect(f.dispatchedCommands).toEqual([]);
    expect(reopenReleaseRefusal(f.coreDb)).toEqual([
      { binding, state: 'intent', phase: 'open', drain: 'draining' },
    ]);
    const integration = f.effects.find((effect) => effect.kind === 'bridge.open')?.input
      .sandboxIntegrationBindingRef;
    if (typeof integration !== 'string') throw new Error('Fixture Integration binding is missing.');
    await expect(
      f.nativeOwner.harnessTurnLifecycle.dispatch({ sandboxIntegrationBindingRef: integration })
    ).resolves.toBeNull();
    expect(
      onNative(f.coreDb, ({ sqlite }) =>
        sqlite
          .prepare(`SELECT drain_state FROM sandbox_runtime_records
      WHERE sandbox_runtime_id = 'other-sandbox'`)
          .get()
      )
    ).toEqual({ drain_state: 'accepting' });
    expect(f.effects.filter(({ kind }) => kind === 'sandbox.delete')).toEqual([]);
  } finally {
    mutateAdmittedTestNanoHost(f.coreDb, (sqlite) =>
      sqlite
        .prepare(`DELETE FROM sandbox_runtime_records
      WHERE sandbox_runtime_id = 'other-sandbox'`)
        .run()
    );
    await closeReleaseRefusalFixture(f);
  }
});

it('deduplicates racing bound refusals and fences a compatible poll already in carriage', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let compatible: ReturnType<typeof f.poll> | undefined;
  try {
    await f.waitQueued('session.open');
    f.holdNextHarnessCarriage(entered.resolve, release.promise);
    compatible = f.poll();
    await entered.promise;
    const refusals = await Promise.all([
      f.post(releaseRefusalPoll, mismatchedBuild),
      f.post(releaseRefusalPoll, mismatchedBuild),
    ]);
    for (const refused of refusals) {
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'worker_release_incompatible' });
    }
    expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(409);
    expect(reopenReleaseRefusal(f.coreDb)).toHaveLength(1);
    release.resolve();
    const crossed = await compatible;
    expect(crossed.status).toBe(204);
    expect(crossed.body).toBe('');
    expect(await f.poll()).toEqual({ status: 204, body: '' });
  } finally {
    release.resolve();
    await compatible?.catch(() => undefined);
    await closeReleaseRefusalFixture(f);
  }
});

it('reopens the bound release refusal only after its full Core commit if the 409 reply is lost', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    const binding = onNative(f.coreDb, (owner) =>
      getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
    )!.sandboxBindingRef;
    f.coreDb.sqlite.exec(`CREATE TRIGGER test_refusal_precommit BEFORE INSERT ON control_execution_steps
      WHEN json_extract(NEW.invocation_json, '$.carriage.operation') = 'sandbox.release-refusal'
      BEGIN SELECT RAISE(ABORT, 'test refusal before commit'); END`);
    try {
      expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(503);
      expect(reopenReleaseRefusal(f.coreDb)).toEqual([]);
      expect(
        onNative(f.coreDb, ({ sqlite }) =>
          sqlite
            .prepare(`SELECT drain_state FROM sandbox_runtime_records
        WHERE sandbox_binding_ref = ?`)
            .get(binding)
        )
      ).toEqual({ drain_state: 'accepting' });
      expect(f.dispatchedCommands).toEqual([]);
      expect(f.effects.filter(({ kind }) => kind === 'sandbox.delete')).toEqual([]);
    } finally {
      f.coreDb.sqlite.exec('DROP TRIGGER test_refusal_precommit');
    }

    f.loseNextPoll(false, false, 409);
    expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toEqual({
      status: undefined,
      body: '',
    });
    expect(reopenReleaseRefusal(f.coreDb)).toEqual([
      { binding, state: 'intent', phase: 'open', drain: 'draining' },
    ]);
    expect(f.dispatchedCommands).toEqual([]);
    expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(409);
    expect(reopenReleaseRefusal(f.coreDb)).toHaveLength(1);
  } finally {
    await closeReleaseRefusalFixture(f);
  }
});

it('fences cached redelivery after a Core-only release refusal and preserves its first send', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let redelivery: ReturnType<typeof f.poll> | undefined;
  try {
    await f.waitQueued('session.open');
    const progress = onNative(
      f.coreDb,
      ({ sqlite }) =>
        sqlite
          .prepare(`
      SELECT h.harness_instance_id AS harnessInstanceId, h.operation_sequence AS nextSequence
      FROM harness_instance_records h JOIN sandbox_runtime_records s USING (sandbox_runtime_id)
      WHERE s.sandbox_integration_binding_ref=? AND h.operation_state='queued'
    `)
          .all(f.integration()) as { harnessInstanceId: string; nextSequence: number }[]
    );
    expect(progress).toHaveLength(1);
    const first = await f.poll(progress);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ operation: 'session.open' });
    f.holdNextHarnessCarriage(entered.resolve, release.promise);
    redelivery = f.poll(progress);
    await Promise.race([
      entered.promise,
      redelivery.then(() => {
        throw new Error('Cached redelivery missed the handoff barrier.');
      }),
    ]);
    const cut = cutRefusalRequest(nativeRefusalPost, async () => {
      throw new Error('Stopped after Core and before Native drain.');
    });
    try {
      expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(503);
      expect(reopenReleaseRefusal(f.coreDb)).toEqual([
        { binding: expect.any(String), state: 'intent', phase: 'open', drain: 'accepting' },
      ]);
      release.resolve();
      expect(await redelivery).toEqual({ status: 204, body: '' });
      expect(f.dispatchedCommands).toHaveLength(1);
    } finally {
      cut.mockRestore();
    }
  } finally {
    release.resolve();
    await redelivery?.catch(() => undefined);
    await closeReleaseRefusalFixture(f);
  }
});

type RefusalTestRequest = {
  operation: string;
  input?: { kind?: string; stage?: string };
  mutation?: { kind: string; input?: { stage?: string } };
};

/** Cuts receipt delivery without substituting the deciding worker. */
function cutRefusalRequest(
  match: (request: RefusalTestRequest) => boolean,
  cut: (post: () => Promise<unknown>) => Promise<unknown>
) {
  const client = getControlStoreWorkerClient() as unknown as {
    request(request: RefusalTestRequest, ...args: unknown[]): Promise<unknown>;
  };
  const request = client.request.bind(client);
  const spy = vi.spyOn(client, 'request').mockImplementation((input, ...args) => {
    const post = () => request(input, ...args);
    return match(input) ? cut(post) : post();
  });
  return spy;
}

const coreRefusalPost = (request: RefusalTestRequest) =>
  request.operation === 'core-journal' && request.input?.kind === 'sandbox-release-refusal';
const nativeRefusalPost = (request: RefusalTestRequest) =>
  request.operation === 'nanohost-owner' &&
  request.mutation?.kind === 'sandbox-release-refusal-drain';

function releaseRefusalNativeState(f: { coreDb: CoreDb; integration(): string }) {
  return onNative(f.coreDb, ({ sqlite }) =>
    sqlite
      .prepare(`SELECT s.drain_state AS drain,
    h.drain_state AS harnessDrain, h.lifecycle_state AS harnessLife
    FROM sandbox_runtime_records s JOIN harness_instance_records h USING (sandbox_runtime_id)
    WHERE s.sandbox_integration_binding_ref=? ORDER BY h.harness_instance_id`)
      .all(f.integration())
  );
}

function refuseNativeDrain(f: Awaited<ReturnType<typeof faultFixture>>) {
  mutateAdmittedTestNanoHost(f.coreDb, (sqlite) =>
    sqlite.exec(`
    CREATE TRIGGER release_refusal_cut BEFORE UPDATE OF drain_state ON harness_instance_records
    WHEN NEW.drain_state='draining' AND NEW.lifecycle_state='failed'
    BEGIN SELECT RAISE(ABORT, 'Native refused Harness drain'); END
  `)
  );
  return () =>
    mutateAdmittedTestNanoHost(f.coreDb, (sqlite) =>
      sqlite.exec('DROP TRIGGER release_refusal_cut')
    );
}

async function bootRefusalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-release-refusal-boot-'));
  const coreDb = openCoreDb(root);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const {
    value: { owner },
  } = await openAdmittedTestNanoHost(coreDb);
  const target = {
    targetId: 'refusal-boot-host',
    deploymentId: 'refusal-deployment',
    identityId: 'refusal-boot-host',
    physicalEpoch: DIGEST,
    connectionGeneration: 1,
  };
  await transitionTestNativeRuntimeTargetFields('allocate', coreDb, { ...target, observedAt: NOW });
  await transitionTestNativeRuntimeTargetFields('ready', coreDb, {
    ...target,
    observedAt: NOW,
    predecessorFenced: true,
    ready: true,
    freshEmpty: true,
  });
  const createRuntime = (key: string, harness = key) =>
    harnessRecords.createNanoHostHarnessRuntime(owner, {
      adapterId: 'codex',
      adapterVersion: 'fixture',
      harnessBindingRef: `harness-binding-${harness}`,
      harnessCompatibilityKey: createHash('sha256').update(harness).digest('hex'),
      harnessInstanceId: `harness-${harness}`,
      imageDigest: `sha256:${DIGEST}`,
      originPhysicalEpoch: DIGEST,
      runtimeTargetId: target.targetId,
      sandboxBindingRef: `sandbox-binding-${key}`,
      sandboxCompatibilityKey: DIGEST,
      sandboxIntegrationBindingRef: `integration-${key}`,
      sandboxRuntimeId: `sandbox-${key}`,
      timestamp: NOW,
    });
  await createRuntime('original');
  await createRuntime('sibling');
  const integration = () => 'integration-original';
  const record = () =>
    owner.releaseRefusal.record({
      kind: 'sandbox-release-refusal',
      target,
      integrationBindingRef: integration(),
      sandboxBindingRef: 'sandbox-binding-original',
    });
  const reopen = async () => {
    await shutdownControlStoreWorkerClient();
    const storage = await openAdmittedTestNanoHost(coreDb);
    return storage.value.owner;
  };
  return { coreDb, owner, integration, record, reopen, createRuntime };
}

it('resumes a Core-only release refusal on admitted Boot without another poll', async () => {
  const f = await bootRefusalFixture();
  const before = releaseRefusalNativeState(f);
  const cut = cutRefusalRequest(coreRefusalPost, async (post) => {
    await post();
    throw new Error('Core refusal committed but its reply was lost.');
  });
  try {
    await expect(f.record()).rejects.toThrow('reply was lost');
    expect(reopenReleaseRefusal(f.coreDb)).toEqual([
      { binding: 'sandbox-binding-original', state: 'intent', phase: 'open', drain: 'accepting' },
    ]);
    expect(releaseRefusalNativeState(f)).toEqual(before);
    await expect(f.createRuntime('original', 'successor')).rejects.toThrow(
      'not admitting a new Harness'
    );
    await expect(f.createRuntime('sibling', 'healthy')).resolves.toBeUndefined();
    expect(releaseRefusalNativeState(f)).toEqual(before);
  } finally {
    cut.mockRestore();
  }
  const owner = await f.reopen();
  expect(await owner.releaseRefusal.reconcile()).toHaveLength(1);
  expect(reopenReleaseRefusal(f.coreDb)).toEqual([
    { binding: 'sandbox-binding-original', state: 'intent', phase: 'open', drain: 'draining' },
  ]);
  expect(releaseRefusalNativeState(f)).toEqual(
    before.map(() => ({ drain: 'draining', harnessDrain: 'draining', harnessLife: 'failed' }))
  );
});

it.each([false, true])(
  'keeps release refusal at 503 when the Native child rolls back (parent already drained: %s)',
  async (parentDrained) => {
    const f = await faultFixture({ orderReleaseRefusalRecycle: true });
    try {
      await f.waitQueued('session.open');
      const restore = refuseNativeDrain(f);
      try {
        expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(503);
        if (parentDrained) {
          mutateAdmittedTestNanoHost(f.coreDb, (sqlite) =>
            sqlite
              .prepare(
                "UPDATE sandbox_runtime_records SET drain_state='draining' WHERE sandbox_integration_binding_ref=?"
              )
              .run(f.integration())
          );
        }
        expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(503);
        expect(await f.nativeOwner.releaseRefusal.reconcile()).toEqual([]);
        expect(reopenReleaseRefusal(f.coreDb)).toEqual([
          {
            binding: expect.any(String),
            state: 'intent',
            phase: 'open',
            drain: parentDrained ? 'draining' : 'accepting',
          },
        ]);
        expect(
          releaseRefusalNativeState(f).every(
            (row) => (row as { harnessDrain: string }).harnessDrain === 'accepting'
          )
        ).toBe(true);
        expect(
          await f.nativeOwner.harnessTurnLifecycle.dispatch({
            sandboxIntegrationBindingRef: f.integration(),
          })
        ).toBeNull();
        expect(await f.poll()).toEqual({ status: 204, body: '' });
        if (!parentDrained) {
          const { harnessInstanceId, workspaceId } = onNative(
            f.coreDb,
            ({ sqlite }) =>
              sqlite
                .prepare(`SELECT h.harness_instance_id AS harnessInstanceId, b.workspace_id AS workspaceId
              FROM harness_instance_records h JOIN agent_session_runtime_bindings b USING (harness_instance_id)
              JOIN sandbox_runtime_records s USING (sandbox_runtime_id)
              WHERE s.sandbox_integration_binding_ref=?`)
                .get(f.integration()) as {
                harnessInstanceId: string;
                workspaceId: string;
              }
          );
          const nextSession = testEntityId('as', 'release-refusal-next-session');
          await expect(
            f.nativeOwner.harnessLifecycle({
              kind: 'session-binding.open',
              harnessInstanceId,
              workspaceId,
              threadId: testEntityId('th', 'release-refusal-next-thread'),
              agentSessionId: nextSession,
              agentSessionRuntimeBindingId: 'release-refusal-next-binding',
              agentSessionCompatibilityKey: DIGEST,
              effectiveSetupGeneration: 1,
              timestamp: new Date().toISOString(),
            })
          ).rejects.toThrow('not accepting new work');
          expect(
            onNative(f.coreDb, ({ sqlite }) =>
              sqlite
                .prepare('SELECT 1 FROM agent_session_runtime_bindings WHERE agent_session_id=?')
                .get(nextSession)
            )
          ).toBeUndefined();
        }
      } finally {
        restore();
      }
      expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(409);
      expect(releaseRefusalNativeState(f)).toEqual([
        { drain: 'draining', harnessDrain: 'draining', harnessLife: 'failed' },
      ]);
      expect(f.effects.filter(({ kind }) => kind === 'sandbox.delete')).toEqual([]);
    } finally {
      await closeReleaseRefusalFixture(f);
    }
  }
);

it('rejoins the same release refusal after the Native drain ACK is lost', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    const cut = cutRefusalRequest(nativeRefusalPost, async (post) => {
      await post();
      throw new Error('Native refusal drain committed but its reply was lost.');
    });
    try {
      expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(503);
      expect(reopenReleaseRefusal(f.coreDb)).toEqual([
        { binding: expect.any(String), state: 'intent', phase: 'open', drain: 'draining' },
      ]);
    } finally {
      cut.mockRestore();
    }
    expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(409);
    expect(reopenReleaseRefusal(f.coreDb)).toHaveLength(1);
    expect(f.effects.filter(({ kind }) => kind === 'sandbox.delete')).toEqual([]);
  } finally {
    await closeReleaseRefusalFixture(f);
  }
});

it('lets an ordinary drain dispatch without assigning it a release refusal', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    mutateAdmittedTestNanoHost(f.coreDb, (sqlite) =>
      sqlite
        .prepare(
          "UPDATE sandbox_runtime_records SET drain_state='draining' WHERE sandbox_integration_binding_ref=?"
        )
        .run(f.integration())
    );
    expect(
      await f.nativeOwner.harnessTurnLifecycle.dispatch({
        sandboxIntegrationBindingRef: f.integration(),
      })
    ).toMatchObject({ operation: 'session.open' });
    expect(reopenReleaseRefusal(f.coreDb)).toEqual([]);
  } finally {
    await closeReleaseRefusalFixture(f);
  }
});

it('holds compatible carriage while an original Core refusal post is unresolved', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  const begun = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const abort = new AbortController();
  let pending: ReturnType<typeof f.post> | undefined;
  const cut = cutRefusalRequest(coreRefusalPost, async (post) => {
    begun.resolve();
    await resume.promise;
    return post();
  });
  try {
    await f.waitQueued('session.open');
    pending = f.post(releaseRefusalPoll, mismatchedBuild, abort.signal);
    await begun.promise;
    abort.abort(new Error('Caller stopped waiting for its original refusal'));
    await expect(pending).rejects.toThrow('Caller stopped waiting');
    expect(reopenReleaseRefusal(f.coreDb)).toEqual([]);
    expect(await f.poll()).toEqual({ status: 204, body: '' });
    expect(f.dispatchedCommands).toEqual([]);
    resume.resolve();
    cut.mockRestore();
    expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(409);
    expect(reopenReleaseRefusal(f.coreDb)).toHaveLength(1);
  } finally {
    resume.resolve();
    cut.mockRestore();
    await pending?.catch(() => undefined);
    await closeReleaseRefusalFixture(f);
  }
});

it('keeps the original release refusal held when its resident has disappeared', async () => {
  const f = await bootRefusalFixture();
  const cut = cutRefusalRequest(nativeRefusalPost, async () => {
    throw new Error('Stopped before posting Native drain.');
  });
  try {
    await expect(f.record()).rejects.toThrow('Stopped before posting Native drain');
  } finally {
    cut.mockRestore();
  }
  mutateAdmittedTestNanoHost(f.coreDb, (sqlite) => {
    sqlite
      .prepare('DELETE FROM sandbox_runtime_records WHERE sandbox_integration_binding_ref=?')
      .run(f.integration());
  });
  const owner = await f.reopen();
  expect(await owner.releaseRefusal.reconcile()).toEqual([]);
  expect(reopenReleaseRefusal(f.coreDb)).toEqual([
    { binding: 'sandbox-binding-original', state: 'intent', phase: 'open' },
  ]);
  expect(releaseRefusalNativeState({ ...f, integration: () => 'integration-sibling' })).toEqual([
    { drain: 'accepting', harnessDrain: 'accepting', harnessLife: 'open' },
  ]);
});

it('keeps a delayed predecessor refusal from draining a same-Epoch replacement', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let delayed: ReturnType<typeof f.post> | undefined;
  try {
    await f.waitQueued('session.open');
    const integration = f.integration();
    const predecessor = onNative(f.coreDb, (owner) =>
      getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
    )!.sandboxBindingRef;
    const { runtimeId, targetId } = onNative(
      f.coreDb,
      ({ sqlite }) =>
        sqlite
          .prepare(`SELECT sandbox_runtime_id AS runtimeId, runtime_target_id AS targetId
          FROM sandbox_runtime_records WHERE sandbox_binding_ref=?`)
          .get(predecessor) as { runtimeId: string; targetId: string }
    );
    expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(409);
    const original = { binding: predecessor, state: 'intent', phase: 'open' };
    expect(reopenReleaseRefusal(f.coreDb)).toEqual([{ ...original, drain: 'draining' }]);

    const record = f.nativeOwner.releaseRefusal.record;
    const barrier = vi
      .spyOn(f.nativeOwner.releaseRefusal, 'record')
      .mockImplementationOnce(async (input) => {
        entered.resolve();
        await resume.promise;
        return record(input);
      });
    try {
      delayed = f.post(releaseRefusalPoll, mismatchedBuild);
      await Promise.race([
        entered.promise,
        delayed.then(() => {
          throw new Error('The predecessor poll missed the Core decision barrier.');
        }),
      ]);
      // Model proved retirement at its projection boundary. Both replacement writes run through
      // the admitted Native writer, while the old poll is still waiting to post to Core.
      await harnessRecords.removeNanoHostSandboxRuntimeByBinding(f.nativeOwner, predecessor);
      const successor = 'sandbox-binding-refusal-successor';
      await harnessRecords.createNanoHostHarnessRuntime(f.nativeOwner, {
        adapterId: 'codex',
        adapterVersion: 'fixture',
        harnessBindingRef: 'harness-binding-refusal-successor',
        harnessCompatibilityKey: DIGEST,
        harnessInstanceId: 'harness-refusal-successor',
        imageDigest: `sha256:${DIGEST}`,
        originPhysicalEpoch: DIGEST,
        runtimeTargetId: targetId,
        sandboxBindingRef: successor,
        sandboxCompatibilityKey: DIGEST,
        sandboxIntegrationBindingRef: integration,
        sandboxRuntimeId: runtimeId,
        timestamp: new Date().toISOString(),
      });
      const accepting = [{ drain: 'accepting', harnessDrain: 'accepting', harnessLife: 'open' }];
      expect(releaseRefusalNativeState(f)).toEqual(accepting);
      // Count committed successor drain writes alongside the reopened state.
      mutateAdmittedTestNanoHost(f.coreDb, (sqlite) => {
        sqlite.exec(`
          CREATE TABLE test_successor_drains (binding TEXT);
          CREATE TRIGGER test_successor_drain AFTER UPDATE OF drain_state ON sandbox_runtime_records
            WHEN OLD.sandbox_binding_ref='sandbox-binding-refusal-successor'
            BEGIN INSERT INTO test_successor_drains VALUES (OLD.sandbox_binding_ref); END;
        `);
      });
      resume.resolve();
      const response = await delayed;
      expect({
        orders: reopenReleaseRefusal(f.coreDb),
        successor: releaseRefusalNativeState(f),
        writes: onNative(f.coreDb, ({ sqlite }) =>
          sqlite.prepare('SELECT binding FROM test_successor_drains').pluck().all()
        ),
        deletes: f.effects.filter(({ kind }) => kind === 'sandbox.delete'),
      }).toEqual({ orders: [original], successor: accepting, writes: [], deletes: [] });
      expect(response.status).toBe(503);
    } finally {
      barrier.mockRestore();
    }
  } finally {
    resume.resolve();
    await delayed?.catch(() => undefined);
    await closeReleaseRefusalFixture(f);
  }
});

it('does not drain from a conflicting release refusal step under the original root', async () => {
  const f = await bootRefusalFixture();
  const cut = cutRefusalRequest(nativeRefusalPost, async () => {
    throw new Error('Stopped before posting Native drain.');
  });
  try {
    await expect(f.record()).rejects.toThrow('Stopped before posting Native drain');
  } finally {
    cut.mockRestore();
  }
  f.coreDb.sqlite.exec(`
    DROP TRIGGER control_execution_steps_settle_once;
    UPDATE control_execution_steps
    SET invocation_json = json_replace(invocation_json, '$.carriage.operation', 'sandbox.other')
    WHERE step_id='fence'
      AND json_extract(invocation_json, '$.carriage.operation')='sandbox.release-refusal';
  `);
  const owner = await f.reopen();
  expect(await owner.releaseRefusal.reconcile()).toEqual([]);
  expect(releaseRefusalNativeState(f)).toEqual([
    { drain: 'accepting', harnessDrain: 'accepting', harnessLife: 'open' },
  ]);
});

it.each(['refusal', 'submission'] as const)(
  'keeps the winning Core decision when %s commits first',
  async (first) => {
    const f = await faultFixture({ orderReleaseRefusalRecycle: true });
    try {
      await f.waitQueued('session.open');
      const attemptId = testEntityId('attempt', 'fault-lease');
      const original = requireSchedulerExecutionAttempt(f.coreDb, attemptId);
      expect(original).toMatchObject({ phase: 'open', deadline: null });
      // Finish the preparation observation while the Harness remains behind its poll boundary.
      const prepared = await acceptSchedulerExecutionObservation(f.coreDb, {
        ...schedulerExecutionCorrelation(original),
        disposition: 'accepted',
        execution: 'pending',
        outcomeRef: null,
        fenceRef: null,
      });
      expect(prepared?.disposition).toBe('accepted');
      const submit = () =>
        recordSchedulerExecutionOperation(f.coreDb, {
          attemptId,
          operationId: commandInputHash([attemptId, 'test-submit-intent']),
          submission: true,
        });
      const submitted = first === 'submission' ? await submit() : null;
      if (submitted) expect(submitted.deadline).not.toBeNull();

      expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
      expect(reopenReleaseRefusal(f.coreDb)).toHaveLength(1);
      expect(f.dispatchedCommands).toEqual([]);
      if (!submitted) await expect(submit()).rejects.toThrow(/authority was revoked/);
      const reopened = openCoreReadDb(f.coreDb.dataRoot);
      try {
        expect(requireSchedulerExecutionAttempt(reopened, attemptId)).toMatchObject(
          submitted
            ? { phase: 'open', deadline: submitted.deadline, operationId: submitted.operationId }
            : {
                phase: 'closing',
                deadline: null,
                operationId: original.operationId,
                terminalCause: 'sandbox-release-refusal',
              }
        );
        const order = reopened.sqlite
          .prepare(
            "SELECT id FROM control_executions WHERE definition_version = 'core-sandbox-release-refusal/v1'"
          )
          .get() as { id: string };
        const owner = { kind: 'server' as const };
        const invocation = await createExecutionStepJournalReader(reopened, owner).readInvocation({
          execution: { owner, executionId: order.id },
          stepId: 'fence',
        });
        expect(invocation.control.attemptId).toBe(submitted ? null : attemptId);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      await closeReleaseRefusalFixture(f);
    }
  }
);

it.each(['refusal', 'first-final'] as const)(
  'keeps the native final decision when %s commits first',
  async (first) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(vi.getRealSystemTime());
    const f = await faultFixture({ orderReleaseRefusalRecycle: true, alignFixtureWall: true });
    try {
      await f.waitQueued('session.open');
      const attemptId = testEntityId('attempt', 'fault-lease');
      const anchor = onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))!;
      const {
        workspaceId,
        threadId,
        turnId,
        agentSessionId,
        packageSnapshotId,
        sandboxBindingRef,
      } = anchor;
      const lineage = {
        workspaceId,
        threadId,
        turnId,
        agentSessionId,
        packageSnapshotId,
        requestId: f.requestId,
      };
      const delivered = first === 'first-final' ? 2 : 0;
      if (first === 'first-final') {
        const opened = await f.dispatch('session.open');
        await f.result(opened, {
          ...ready,
          state: 'open',
          maxActiveTurns: opened.body.maxActiveTurns,
        });
        const start = await f.dispatch('turn.start');
        await f.result(start, { ...ready, state: 'started' });
        const control = f.controlClient(start);
        await control.recordHeartbeat({ status: 'starting' });
        await control.recordHeartbeat({ status: 'running' });
        f.sealTranscript(start);
        await expect(
          control.recordFinalStatus({
            sequence: 1,
            status: 'completed',
            stopReason: 'completed',
          })
        ).resolves.toMatchObject({ accepted: true });
      }
      const original = requireSchedulerExecutionAttempt(f.coreDb, attemptId);
      expect(f.dispatchedCommands).toHaveLength(delivered);
      expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
      if (first === 'refusal') {
        // An unsubmitted attempt has no retained Worker token. Its exact lineage must
        // refuse at Core intake before any Native final or Core observation can exist.
        const timestamp = new Date().toISOString();
        await expect(
          f.nativeOwner.workerControlFinalStatus({
            lineage,
            sandboxBindingRef,
            tokenHash: '1'.repeat(64),
            payload: {
              terminalData: {
                status: 'completed',
                stopReason: 'completed',
                evidenceManifestDigests: {},
              },
              sequence: 1,
              acceptedAt: timestamp,
              eventAcceptedAt: timestamp,
            },
          })
        ).rejects.toMatchObject({
          commit: 'not-committed',
          domain: { code: 'worker_control_unauthorized', status: 401 },
        });
      }
      const reopened = openCoreReadDb(f.coreDb.dataRoot);
      try {
        const accepted = onNative(reopened, (owner) =>
          getWorkerControlAcceptedFinalStatus(owner, lineage)
        );
        const intake = reopened.sqlite
          .prepare(`SELECT 1 FROM control_execution_steps
          WHERE step_id='worker-final-intake' AND json_extract(control_json, '$.attemptId')=?`)
          .get(attemptId);
        if (first === 'refusal') {
          expect(accepted).toBeNull();
          expect(intake).toBeUndefined();
        } else {
          expect(accepted).toMatchObject({ status: 'completed' });
          expect(intake).toBeDefined();
        }
        const orderId = reopened.sqlite
          .prepare(
            "SELECT id FROM control_executions WHERE definition_version='core-sandbox-release-refusal/v1'"
          )
          .pluck()
          .get() as string;
        const owner = { kind: 'server' as const };
        const order = await createExecutionStepJournalReader(reopened, owner).readInvocation({
          execution: { owner, executionId: orderId },
          stepId: 'fence',
        });
        expect(order.control.attemptId).toBe(first === 'refusal' ? attemptId : null);
        expect(requireSchedulerExecutionAttempt(reopened, attemptId)).toMatchObject({
          deadline: original.deadline,
          terminalCause: first === 'refusal' ? 'sandbox-release-refusal' : 'worker-final-status',
        });
        expect(f.effects.filter(({ kind }) => kind === 'sandbox.create')).toHaveLength(1);
        expect(f.dispatchedCommands).toHaveLength(delivered);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      await vi.advanceTimersByTimeAsync(100);
      await closeReleaseRefusalFixture(f);
      vi.useRealTimers();
    }
  }
);

it('keeps the original running Turn when the refused predecessor waiter ends', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    const turnId = testEntityId('tu', 'fault-turn');
    const attemptId = testEntityId('attempt', 'fault-lease');
    const session = onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId));
    expect(session).not.toBeNull();
    const before = f.store.getTurnById(turnId);
    expect(before.status).toBe('running');
    expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(harnessRecords.NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    await f.running.catch(() => undefined);

    const reopened = new FsStore({ dataRoot: f.coreDb.dataRoot });
    expect(reopened.getTurnById(turnId)).toMatchObject({
      agentSessionId: before.agentSessionId,
      completedAt: null,
      status: 'running',
    });
    expect(reopened.getTurnEvents(turnId).some(({ event }) => event === 'turn.completed')).toBe(
      false
    );
    expect(f.dispatchedCommands).toEqual([]);
    expect(f.effects.filter(({ kind }) => kind === 'sandbox.delete')).toEqual([]);
    await expect(f.classifyAfterRestart()).resolves.toEqual({ failedAttemptIds: [] });
    expect(onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))).toEqual(
      session
    );
  } finally {
    await closeReleaseRefusalFixture(f);
  }
});

it('starts exact predecessor retirement in maintenance without another Shim poll', async () => {
  const deleteStarted = Promise.withResolvers<void>();
  const releaseDelete = Promise.withResolvers<void>();
  const f = await faultFixture({
    orderReleaseRefusalRecycle: true,
    beforeEffect: (kind) => {
      if (kind !== 'sandbox.delete') return;
      deleteStarted.resolve();
      return releaseDelete.promise;
    },
  });
  let maintenance: Promise<void> | undefined;
  try {
    await f.waitQueued('session.open');
    const attemptId = testEntityId('attempt', 'fault-lease');
    const session = onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))!;
    const { sandboxBindingRef } = session;
    const storage = onNative(f.coreDb, (owner) =>
      getWorkerStorageBindingForSandbox(owner, { sandboxBindingRef })
    )!;
    expect(storage.state).toBe('attached');
    const sandboxId = f.effects.find(({ kind }) => kind === 'sandbox.create')?.input.sandboxId;
    expect(sandboxId).toEqual(expect.any(String));
    expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
    expect(f.isSettled()).toBe(false);
    maintenance = f.maintenance();
    await Promise.race([
      deleteStarted.promise,
      maintenance.then(() => {
        throw new Error('Maintenance returned before attempting the original Delete.');
      }),
    ]);
    const reopened = openCoreReadDb(f.coreDb.dataRoot);
    try {
      expect(onNative(reopened, (owner) => getWorkerStorageBinding(owner, storage))).toEqual(
        storage
      );
      expect(requireSchedulerExecutionAttempt(reopened, attemptId).phase).toBe('closing');
      expect(requireSchedulerAdmissionEntry(reopened, 'fault-queue').status).toBe('admitted');
    } finally {
      reopened.sqlite.close();
    }
    releaseDelete.resolve();
    await maintenance;
    const deletes = f.effects.filter(({ kind }) => kind === 'sandbox.delete');
    expect(deletes).toMatchObject([
      createNanoHostEffectRequest(session, attemptId, 'sandbox.delete', { attemptId, sandboxId }),
    ]);
    expect(f.effects.filter(({ kind }) => kind === 'sandbox.create')).toHaveLength(1);
    expect(f.dispatchedCommands).toEqual([]);
    expect(onNative(f.coreDb, (owner) => getWorkerStorageBinding(owner, storage))).toMatchObject({
      state: 'idle',
      attachmentGeneration: storage.attachmentGeneration,
      currentSandboxBindingRef: null,
    });
  } finally {
    releaseDelete.resolve();
    await maintenance?.catch(() => undefined);
    await closeReleaseRefusalFixture(f);
  }
});

it('refuses a predecessor terminal writer holding a stale Workspace root revision', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    const turnId = testEntityId('tu', 'fault-turn');
    const predecessorAgentSessionId = f.store.getTurnById(turnId).agentSessionId!;
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspace = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
    let publication: Awaited<ReturnType<typeof workerTurnTerminalPublication>>;
    try {
      publication = await workerTurnTerminalPublication(
        workspace,
        turnId,
        'failed',
        testEntityId('attempt', 'fault-lease')
      );
    } finally {
      workspace.sqlite.close();
    }
    expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
    await f.maintenance();

    const lateFailure = {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: {
        code: 'test-predecessor-late-publication',
        message: 'Old failure after handoff.',
      },
    } as const;
    await expect(f.store.completeTurn(turnId, lateFailure, publication)).rejects.toThrow();
    const prepared = publication.execution!;
    const owner = { kind: 'workspace' as const, workspaceId };
    const execution = { owner, executionId: prepared.executionId };
    const ref = { execution, stepId: prepared.terminalStepId };
    const reopened = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
    try {
      const journal = createExecutionStepJournalReader(reopened, owner);
      const root = await journal.readExecution(execution);
      expect(root.phase).toBe('open');
      expect(root.revision).toBeGreaterThan(prepared.expectedRevision);
      expect(await journal.readInvocation(ref)).toMatchObject({
        state: 'cancelled',
        control: {
          attemptId: testEntityId('attempt', 'fault-lease'),
          outputRefs: [expect.stringMatching(/^sandbox-release-refusal:sha256:[a-f0-9]{64}$/)],
        },
      });
      await expect(
        f.store.completeTurn(turnId, lateFailure, {
          ...publication,
          execution: { ...prepared, expectedRevision: root.revision },
        })
      ).rejects.toThrow();
    } finally {
      reopened.sqlite.close();
    }
    const store = new FsStore({ dataRoot: f.coreDb.dataRoot });
    const turn = store.getTurnById(turnId);
    expect(turn).toMatchObject({ status: 'running', completedAt: null });
    expect(store.getTurnEvents(turnId).some(({ event }) => event === 'turn.completed')).toBe(false);
    const retained = store.getAgentSession(predecessorAgentSessionId).retainedStorage!;
    const core = openCoreReadDb(f.coreDb.dataRoot);
    try {
      expect(
        onNative(core, (owner) =>
          getWorkerStorageBinding(owner, { storageRef: retained.storageRef })
        )
      ).toMatchObject({
        state: 'idle',
        attachmentGeneration: retained.attachmentGeneration,
        currentSandboxBindingRef: null,
      });
    } finally {
      core.sqlite.close();
    }
  } finally {
    await closeReleaseRefusalFixture(f);
  }
});

it('reopens the original admission as queued only after the exact predecessor release', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    const attemptId = testEntityId('attempt', 'fault-lease');
    const turnId = testEntityId('tu', 'fault-turn');
    const original = requireSchedulerAdmissionEntry(f.coreDb, 'fault-queue');
    expect(original).toMatchObject({ turnId, status: 'admitted' });
    expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
    await f.maintenance();

    const reopened = openCoreReadDb(f.coreDb.dataRoot);
    try {
      expect(requireSchedulerExecutionAttempt(reopened, attemptId)).toMatchObject({
        phase: 'closed',
        terminalCause: 'sandbox-release-refusal',
        fenceRef: expect.any(String),
        deadline: null,
      });
      expect(requireSchedulerAdmissionEntry(reopened, original.queueEntryId)).toEqual({
        ...original,
        status: 'queued',
      });
    } finally {
      reopened.sqlite.close();
    }
    expect(new FsStore({ dataRoot: f.coreDb.dataRoot }).getTurnById(turnId).status).toBe('running');
    await f.maintenance();
    expect(f.effects.filter(({ kind }) => kind === 'sandbox.delete')).toHaveLength(1);
  } finally {
    await closeReleaseRefusalFixture(f);
  }
});

it('replays the coupled refusal detach after Native FULL and requeues only once across reopen', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  const coreHandoff = cutRefusalRequest(
    (request) =>
      request.operation === 'core-journal' &&
      request.input?.kind === 'sandbox-release-refusal-handoff',
    () => Promise.reject(new Error('Stopped after Native FULL before Core handoff.'))
  );
  try {
    await f.waitQueued('session.open');
    const attemptId = testEntityId('attempt', 'fault-lease');
    const anchor = onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))!;
    const attached = onNative(f.coreDb, (owner) =>
      getWorkerStorageBindingForSandbox(owner, anchor)
    )!;
    expect(attached.state).toBe('attached');
    expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });

    // A refusal on the second Native write must roll the first write back with it.
    mutateAdmittedTestNanoHost(f.coreDb, (sqlite) =>
      sqlite.exec(`
      CREATE TRIGGER row5_cut BEFORE UPDATE OF state ON worker_backend_sessions
        WHEN NEW.state='cleaned'
        BEGIN SELECT RAISE(ABORT, 'Row 5 cut before terminal backend mark'); END
    `)
    );
    await expect(f.maintenance()).rejects.toBeInstanceOf(AggregateError);
    expect(onNative(f.coreDb, (owner) => getWorkerStorageBinding(owner, attached))).toEqual(
      attached
    );
    expect(onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))).toEqual(
      anchor
    );
    expect(requireSchedulerAdmissionEntry(f.coreDb, 'fault-queue').status).toBe('admitted');
    mutateAdmittedTestNanoHost(f.coreDb, (sqlite) => sqlite.exec('DROP TRIGGER row5_cut'));

    await expect(f.maintenance()).rejects.toBeInstanceOf(AggregateError);
    const detached = onNative(f.coreDb, (owner) => getWorkerStorageBinding(owner, attached));
    expect(detached).toMatchObject({
      state: 'idle',
      revision: attached.revision + 1,
      attachmentGeneration: attached.attachmentGeneration,
      currentWorkSlotRef: null,
      currentSandboxBindingRef: null,
    });
    expect(coreHandoff).toHaveBeenCalled();
    expect(onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))).toMatchObject({
      state: 'cleaned',
      physicalCleanedAt: expect.any(String),
    });
    expect(requireSchedulerExecutionAttempt(f.coreDb, attemptId).phase).toBe('closing');
    expect(requireSchedulerAdmissionEntry(f.coreDb, 'fault-queue').status).toBe('admitted');

    await vi.advanceTimersByTimeAsync(harnessRecords.NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    await f.running.catch(() => undefined);
    coreHandoff.mockRestore();
    for (let restart = 0; restart < 2; restart += 1) {
      await f.reopenMaintenance(anchor.workspaceId);
      const reopened = openCoreReadDb(f.coreDb.dataRoot);
      try {
        expect(requireSchedulerExecutionAttempt(reopened, attemptId)).toMatchObject({
          phase: 'closed',
          terminalCause: 'sandbox-release-refusal',
          fenceRef: expect.stringMatching(/^sandbox-release-refusal:sha256:/),
        });
        expect(requireSchedulerAdmissionEntry(reopened, 'fault-queue').status).toBe('queued');
        expect(onNative(reopened, (owner) => getWorkerStorageBinding(owner, attached))).toEqual(
          detached
        );
        expect(
          reopened.sqlite
            .prepare(`SELECT count(*) FROM control_execution_steps
          WHERE execution_id=? AND json_extract(control_json, '$.kind')='release'`)
            .pluck()
            .get(`scheduler-lifecycle:${attemptId}`)
        ).toBe(1);
      } finally {
        reopened.sqlite.close();
      }
    }
    expect(f.effects.filter(({ kind }) => kind === 'sandbox.delete')).toHaveLength(1);
    expect(f.dispatchedCommands).toEqual([]);
  } finally {
    coreHandoff.mockRestore();
    await closeReleaseRefusalFixture(f);
  }
});

it.each(['before link', 'after link'])(
  'refuses to requeue when ordinary backend finish races %s without coupled detach',
  async (order) => {
    const f = await faultFixture({ orderReleaseRefusalRecycle: true });
    try {
      await f.waitQueued('session.open');
      const attemptId = testEntityId('attempt', 'fault-lease');
      const backend = onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))!;
      const attached = onNative(f.coreDb, (owner) =>
        getWorkerStorageBindingForSandbox(owner, backend)
      )!;
      // Ordinary release can produce the same idle generation. Its separate backend
      // callback has no coupled detach proof.
      const cleared = await f.nativeOwner.workerStorageBinding({
        kind: 'release',
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: backend.sandboxBindingRef,
        storageRef: attached.storageRef,
      });
      expect(cleared).toMatchObject({
        state: 'idle',
        attachmentGeneration: attached.attachmentGeneration,
      });
      const observedAt = new Date().toISOString();
      await f.nativeOwner.backendSession({
        kind: 'transition',
        attemptId,
        fromState: backend.state,
        toState: 'cleanup-pending',
        observedAt,
      });
      await f.nativeOwner.backendSession({
        kind: 'transition',
        attemptId,
        fromState: 'cleanup-pending',
        toState: 'physical-cleaned',
        observedAt,
      });
      const finish = () =>
        f.nativeOwner.backendSession({
          kind: 'transition',
          attemptId,
          fromState: 'physical-cleaned',
          toState: 'cleaned',
          observedAt,
        });
      if (order === 'before link') await finish();
      expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
      if (order === 'after link') {
        await finish().catch(() => undefined);
        await f.maintenance().catch((error: unknown) => {
          expect(error).toBeInstanceOf(AggregateError);
        });
      } else await f.maintenance();
      expect(requireSchedulerAdmissionEntry(f.coreDb, 'fault-queue').status).toBe('admitted');
      expect(onNative(f.coreDb, (owner) => getWorkerStorageBinding(owner, attached))).toEqual(
        cleared
      );
      expect(requireSchedulerExecutionAttempt(f.coreDb, attemptId).phase).toBe(
        order === 'before link' ? 'open' : 'closing'
      );
      expect(onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, attemptId))?.state).toBe(
        order === 'before link' ? 'cleaned' : 'physical-cleaned'
      );
    } finally {
      await closeReleaseRefusalFixture(f);
    }
  }
);

it('keeps the original Turn and attachment lineage when existing writers refuse successor binding', async () => {
  const f = await faultFixture({ orderReleaseRefusalRecycle: true });
  try {
    await f.waitQueued('session.open');
    const turnId = testEntityId('tu', 'fault-turn');
    expect(await f.post(releaseRefusalPoll, mismatchedBuild)).toMatchObject({ status: 409 });
    await f.maintenance();
    const original = new FsStore({ dataRoot: f.coreDb.dataRoot });
    const turn = original.getTurnById(turnId);
    const session = original.getAgentSession(turn.agentSessionId!);
    expect(turn.status).toBe('running');
    const retained = session.retainedStorage!;
    expect(retained.attachmentGeneration).toEqual(expect.any(Number));
    await expect(
      original.updateAgentSession(session.id, { status: 'closed' })
    ).rejects.toMatchObject({ commit: 'not-committed' });
    await expect(original.updateTurn(turnId, { agentSessionId: null })).rejects.toMatchObject({
      commit: 'not-committed',
    });
    await expect(
      original.updateAgentSession(session.id, {
        retainedStorage: { ...retained, attachmentGeneration: retained.attachmentGeneration! + 1 },
      })
    ).rejects.toThrow('AgentSession retained-storage attachment cannot change.');
    const reopened = new FsStore({ dataRoot: f.coreDb.dataRoot });
    expect(reopened.getTurnById(turnId)).toEqual(turn);
    expect(reopened.getAgentSession(session.id)).toEqual(session);
  } finally {
    await closeReleaseRefusalFixture(f);
  }
});

const undeliveredRecoveryCuts = [
  'before Native FULL',
  'absent completion',
  'different binding',
  'missing contributor',
  'conflicting contributor',
  'Native ACK lost, idle',
  'Native ACK lost, reused',
  'Native ACK lost, reused then released',
  'Workspace before Core, idle',
  'Workspace before Core, reused',
  'conflicting Turn outcome',
  'Core ACK lost',
] as const;

async function exerciseUndeliveredRecovery(cut: (typeof undeliveredRecoveryCuts)[number]) {
  const createAccepted = Promise.withResolvers<NanoHostSessionEffectRequest>();
  const stopOriginal = Promise.withResolvers<void>();
  void stopOriginal.promise.catch(() => undefined);
  let withholdCreate = false;
  const f = await faultFixture({
    orderReleaseRefusalRecycle: true,
    useLayoutDeploymentId: true,
    beforeEffect: (kind, request) => {
      if (kind !== 'sandbox.create' || !withholdCreate) return;
      createAccepted.resolve(request);
      return stopOriginal.promise;
    },
  });
  let successor: ReturnType<typeof runSchedulerDispatchLoop> | undefined;
  let successorClaim: Promise<unknown> | undefined;
  let cold: ReturnType<typeof openCoreDb> | undefined;
  let replayDb: ReturnType<typeof openCoreDb> | undefined;
  let coldServer: ReturnType<typeof createServer> | undefined;
  let coldClient: ReturnType<typeof connect> | undefined;
  try {
    await f.waitQueued('session.open');
    const predecessor = onNative(f.coreDb, (owner) =>
      getWorkerBackendSession(owner, testEntityId('attempt', 'fault-lease'))
    )!;
    const writer = onNative(f.coreDb, (owner) =>
      getWorkerStorageBindingForSandbox(owner, predecessor)
    )!;
    expect((await f.post(releaseRefusalPoll, mismatchedBuild)).status).toBe(409);
    await f.maintenance();
    await vi.advanceTimersByTimeAsync(harnessRecords.NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    await f.running.catch(() => undefined);

    const { manifest } = createTestAgentSetup({
      imageRef: `sha256:${'b'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    await admitTestNativeEnvironmentForRoot(f.coreDb, manifest);
    const successorId = testEntityId('attempt', 'fault-successor');
    withholdCreate = true;
    successor = f.startSuccessor(successorId, manifest);
    void successor.catch(() => undefined);
    const request = await Promise.race([
      createAccepted.promise,
      successor.then(() => {
        throw new Error('Successor did not reach Create.');
      }),
    ]);
    successorClaim = getSchedulerPreparationClaims(f.coreDb).get('fault-queue');
    void successorClaim?.catch(() => undefined);

    const db = openCoreDb(f.coreDb.dataRoot);
    cold = db;
    let store = new FsStore({ dataRoot: db.dataRoot });
    const { turnId, agentSessionId } = predecessor;
    const retainedStorage = store.getAgentSession(agentSessionId).retainedStorage;
    const attempt = requireSchedulerExecutionAttempt(db, successorId);
    const session = onNative(db, (owner) => getWorkerBackendSession(owner, successorId))!;
    const originalHold = onNative(db, (owner) => getWorkerStorageBinding(owner, writer));
    expect(attempt).toMatchObject({ phase: 'open', operationId: request.requestId });
    expect(session).toMatchObject({ state: 'materializing', workspaceHandoffState: 'pending' });
    expect(requireSchedulerAdmissionEntry(db, attempt.queueEntryId).status).toBe('admitted');
    expect(originalHold).toMatchObject({
      state: 'reserved',
      storageRef: writer.storageRef,
      currentWorkSlotRef: writer.currentWorkSlotRef,
      currentSandboxBindingRef: null,
      attachmentGeneration: writer.attachmentGeneration + 1,
    });
    expect(f.dispatchedCommands).toEqual([]);

    const nanoHostStorage = await openAdmittedTestNanoHost(db);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({
      coreDb: db,
      sessionAuthority: authority,
      nativeStorage: nanoHostStorage,
    });
    const registrations = vi.spyOn(dispatch, 'expectResultOnly');
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: db,
      env: {},
      nanoHostSessionDispatch: dispatch,
      readRuntimeConfig: () => loadRuntimeConfig(db.dataRoot),
      releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
      store,
      workerControlGateway: createDefaultWorkerControlGateway(db, undefined, nanoHostStorage),
      nanoHostRecovery: testNanoHostRecoveryJoins(nanoHostStorage),
    });
    const recovery = {
      admittedNanoHostRecovery: {
        state: 'ready' as const,
        value: bindBootNanoHostAttemptRecovery(nanoHostStorage.value.owner, {
          coreDb: db,
          reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
        }),
      },
      executionBackend: runtime.turnExecutor.executionBackend!,
      cleanupBackendSession: runtime.cleanupBackendSession,
      awaitPreparedBackendCleanup: runtime.awaitPreparedBackendCleanup,
      reconcileExecutions: () => runtime.executionReconciler.runOnce(),
      prepareBackendCleanup: runtime.prepareBackendCleanup,
      restoreBackendSession: runtime.restoreBackendSession,
      reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
      isTurnExecutionActive: runtime.isTurnExecutionActive,
      store,
      projectRecoveredTurn: async (subject: {
        attemptId: string;
        agentSessionId: string | null;
        turnId: string;
      }) => {
        const admission = requireSchedulerExecutionAttemptAdmissionContext(db, subject.attemptId);
        const result = await terminalizeGovernedWorkerTurn({
          agentSessionId: subject.agentSessionId,
          completedAt: new Date().toISOString(),
          errorCode: 'worker_governance_restart_recovery',
          message: 'Worker execution was interrupted during scheduler recovery.',
          outcome: 'interrupted',
          requestId: admission.requestId,
          store,
          turnId: subject.turnId,
        });
        if (result.status !== 'interrupted')
          throw new Error(`Recovery projection returned ${result.status}.`);
        return { status: result.status };
      },
    };
    expect(await classifyNanoHostAttemptsAfterRestart(db, recovery)).toEqual({
      failedAttemptIds: [],
    });
    expect(requireSchedulerExecutionAttempt(db, successorId)).toMatchObject({
      phase: 'closing',
      terminalCause: 'restart-native-recovery',
    });
    expect(onNative(db, (owner) => getWorkerBackendSession(owner, successorId))?.state).toBe(
      'cleanup-pending'
    );
    expect(registrations.mock.calls.flatMap(([group]) => group.map(({ kind }) => kind))).toEqual([
      'bridge.close',
      'sandbox.delete',
    ]);

    const target = {
      deploymentId: session.deploymentId,
      identityId: session.runtimeTargetId,
      targetId: session.runtimeTargetId,
    };
    const app = new Hono<{ Variables: AuthVariables }>();
    registerNanoHostSessionEffectRoutes({ app, dispatch });
    registerNanoHostSessionSemanticRoutes({
      app,
      coreDb: db,
      dispatch,
      nanoHostConfig: target,
      nativeStorage: nanoHostStorage,
      sessionAuthority: authority,
    });
    const listener = getRequestListener(app.fetch);
    let physical: object | null = null;
    let generation = 0;
    coldServer = createServer((request, response) => {
      const connection = readNanoHostPhysicalConnectionContext(request)!;
      if (physical !== connection) {
        physical = connection;
        authority.admit({
          connectionGeneration: generation,
          identityId: target.identityId,
          physicalConnection: connection,
        });
      }
      void listener(request, response);
    });
    coldServer.listen(0, '127.0.0.1');
    await once(coldServer, 'listening');
    const address = coldServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing cold fixture address.');
    const post = async (path: string, payload: unknown) => {
      const stream = coldClient!.request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/json',
      });
      const response = once(stream, 'response');
      stream.end(JSON.stringify(payload));
      const [headers] = await response;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return { status: Number(headers[':status']), body: Buffer.concat(chunks).toString() };
    };
    const connectEpoch = async (physicalEpoch: string, beforeReadiness?: () => Promise<void>) => {
      if (physical) {
        await authority.closePhysicalConnection(physical);
        coldClient?.destroy();
        const allocated = await transitionTestNativeRuntimeTargetFields('allocate', db, {
          ...target,
          observedAt: new Date().toISOString(),
        });
        generation = allocated.connectionGeneration;
      } else {
        // An already admitted original reply can reach this new dispatcher. Do not allocate
        // a second Vault generation for the same Epoch just to present those delayed bytes.
        const current = nanoHostStorage.value.owner.readRuntimeTarget(target.targetId);
        if (
          current.state !== 'ready' ||
          !current.value ||
          current.value.physicalEpoch !== physicalEpoch
        )
          throw new Error('Missing original admitted RuntimeTarget.');
        generation = current.value.connectionGeneration;
      }
      coldClient = connect(`http://127.0.0.1:${address.port}`);
      await beforeReadiness?.();
      expect(await post('/api/nanohost/transport/session/readiness', { physicalEpoch })).toEqual({
        status: 204,
        body: '',
      });
    };
    await connectEpoch(session.originPhysicalEpoch);

    const storage = request.input.storage as { targets: Record<string, unknown>[] };
    const lateReply = {
      requestId: request.requestId,
      sandboxId: request.input.sandboxId,
      state: 'created',
      storage: {
        ...storage,
        targets: storage.targets.map((target) => ({ ...target, initialized: true })),
      },
    };
    const refusal = await post('/api/nanohost/transport/effects/sandbox.create/result', lateReply);
    expect(refusal.status).toBe(409);
    expect(refusal.body).toContain('NanoHost effect result does not match a pending request.');
    expect(onNative(db, (owner) => getWorkerStorageBinding(owner, writer))).toEqual(originalHold);
    expect(store.getAgentSession(agentSessionId).retainedStorage).toEqual(retainedStorage);
    await expect(
      nanoHostStorage.value.owner.recoverUndeliveredSuccessor(attempt, 'teardown')
    ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
    expect(onNative(db, (owner) => getWorkerStorageBinding(owner, writer))).toEqual(originalHold);

    // The 409 ends the original Host epoch. Model the supervised fresh-empty epoch
    // after the provider has removed the old Sandbox, without inventing a Delete receipt.
    await connectEpoch('c'.repeat(64), async () => {
      if (cut !== 'before Native FULL') return;
      await expect(
        nanoHostStorage.value.owner.recoverUndeliveredSuccessor(attempt, 'teardown')
      ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
      expect(onNative(db, (owner) => getWorkerStorageBinding(owner, writer))).toEqual(originalHold);
      expect(store.getTurnById(turnId).status).toBe('running');
    });
    expect(await post('/api/nanohost/transport/effects/sandbox.delete', {})).toEqual({
      status: 204,
      body: '',
    });
    // The old receipt wait observes the epoch change on the first pass. Maintenance then
    // settles the same attempt with the fresh-empty proof.
    await expect(runNanoHostAttemptRecoveryMaintenance(db, recovery)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some(
          (cause) =>
            cause instanceof Error &&
            cause.message ===
              'NanoHost cleanup result-only origin physical Epoch is absent from the current coordinator.'
        )
    );
    expect(onNative(db, (owner) => getWorkerBackendSession(owner, successorId))?.state).toBe(
      'cleanup-failed'
    );
    const nativeOwner = nanoHostStorage.value.owner;
    const readVolume = () => onNative(db, (owner) => getWorkerStorageBinding(owner, writer))!;
    const readBackend = () => onNative(db, (owner) => getWorkerBackendSession(owner, successorId))!;
    const restart = () => {
      replayDb?.sqlite.close();
      const core = openCoreDb(db.dataRoot);
      replayDb = core;
      store = new FsStore({ dataRoot: core.dataRoot });
      const admitted = bindBootNanoHostAttemptRecovery(nativeOwner, {
        coreDb: core,
        reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
      });
      return {
        core,
        run: () =>
          runNanoHostAttemptRecoveryMaintenance(core, {
            ...recovery,
            store,
            admittedNanoHostRecovery: { state: 'ready', value: admitted },
          }),
      };
    };
    const reserveForAnotherThread = async () => {
      const idle = readVolume();
      const { workspaceId } = idle;
      const thread = await store.createThread(workspaceId, 'Later Volume user');
      const now = new Date().toISOString();
      const originalAdmission = requireSchedulerExecutionAttemptAdmissionContext(db, successorId);
      const sibling = await store.createAgentSession({
        id: testEntityId('as', 'fault-volume-sibling'),
        workspaceId,
        threadId: thread.id,
        agentId: originalAdmission.requestedAgentId,
        status: 'idle',
        message: null,
        createdAt: now,
        updatedAt: now,
      });
      if (originalAdmission.triggerActor.kind !== 'user') throw new Error('Missing fixture User.');
      const responsibleUserId = originalAdmission.triggerActor.id;
      const text = 'Reserve the released Volume for a later Thread.';
      const turn = await store.createTurn(
        workspaceId,
        thread.id,
        text,
        originalAdmission.triggerActor,
        null,
        {
          status: 'pending',
          executorKind: 'worker',
          agentId: originalAdmission.requestedAgentId,
        }
      );
      const admission = await createTestQueueEntry(db, {
        backendId: 'nanohost',
        workspaceId,
        threadId: thread.id,
        turnId: turn.id,
        queueEntryId: 'fault-volume-reuse',
        triggerActor: originalAdmission.triggerActor,
        requestedAgentId: originalAdmission.requestedAgentId,
        text,
      });
      const claim = await createSchedulerExecutionAttempt(db, {
        entry: admission,
        preparationInput: { admission },
      });
      await bindSchedulerExecutionAttemptSession(db, {
        attemptId: claim.attemptId,
        agentSessionId: sibling.id,
      });
      const authorizeContributor = (contributor: (typeof idle.contributors)[number]) =>
        contributor.workspaceId === workspaceId &&
        contributor.responsibleUserId === responsibleUserId &&
        store.getThread(workspaceId, contributor.threadId).visibility === 'workspace' &&
        currentSchedulerAdmissionWorkspaceAuthority(db, admission, 'runtime.launch', true) !== null;
      const placed = nativeOwner.readRuntimeTarget(target.targetId);
      if (placed.state !== 'ready' || !placed.value) throw new Error('Missing admitted target.');
      // Reserve through the Native writer under the separate, admitted Thread claim.
      // The fixture does not submit a Worker on that claim.
      const reserved = await reserveWorkerStorageAttachment(
        db,
        {
          storageRef: idle.storageRef,
          expectedRevision: idle.revision,
          agentSessionId: sibling.id,
          runtimeTargetId: target.targetId,
          layout: idle.layout,
          workspaceId,
          threadId: thread.id,
          responsibleUserId,
          purpose: 'work',
          authorizeContributor,
        },
        {
          attemptId: claim.attemptId,
          target: placed.value,
          write: nativeOwner.writeStorageAttachment,
          read: nativeOwner.read,
          authorizeContributor,
          isCurrentAttempt: () => {
            const current = requireSchedulerExecutionAttempt(db, claim.attemptId);
            return current.phase === 'open' && current.agentSessionId === sibling.id;
          },
        }
      );
      expect(reserved).toMatchObject({
        state: 'reserved',
        attachmentGeneration: writer.attachmentGeneration + 2,
        revision: idle.revision + 1,
        currentAgentSessionId: sibling.id,
        currentThreadId: thread.id,
        currentWorkSlotRef: expect.any(String),
      });
      expect(readVolume()).toEqual(reserved);
      return reserved;
    };
    const releaseReservation = (volume: ReturnType<typeof readVolume>) =>
      nativeOwner.workerStorageBinding({
        kind: 'release',
        storageRef: volume.storageRef,
        attachmentGeneration: volume.attachmentGeneration,
        expectedRevision: volume.revision,
        cleanupProved: true,
      });
    const runToCut = async (
      match: Parameters<typeof cutRefusalRequest>[0],
      afterCommit: boolean
    ) => {
      const stopped = new Error('Recovery cut at the owner reply.');
      const hook = cutRefusalRequest(match, async (post) => {
        if (afterCommit) await post();
        throw stopped;
      });
      try {
        await expect(runNanoHostAttemptRecoveryMaintenance(db, recovery)).rejects.toSatisfy(
          (error: unknown) => error instanceof AggregateError && error.errors.includes(stopped)
        );
      } finally {
        hook.mockRestore();
      }
    };
    const terminalEvents = () =>
      store.getTurnEvents(turnId).filter((event) => event.event === 'turn.completed');
    const expectHeld = (core: typeof db) => {
      expect(store.getTurnById(turnId).status).toBe('running');
      expect(requireSchedulerExecutionAttempt(core, successorId).phase).toBe('closing');
      expect(terminalEvents()).toHaveLength(0);
    };
    const checkHoldAfterRestart = async () => {
      const anchor = readBackend();
      const volume = readVolume();
      const reopened = restart();
      await expect(reopened.run()).rejects.toBeInstanceOf(AggregateError);
      expectHeld(reopened.core);
      expect(readVolume()).toEqual(volume);
      expect(readBackend()).toEqual(anchor);
    };
    const assertNoFurtherEffects = async () => {
      expect(f.effects.filter(({ kind }) => kind === 'sandbox.create')).toHaveLength(2);
      expect(f.dispatchedCommands).toEqual([]);
      expect(await post('/api/nanohost/transport/effects/sandbox.create', {})).toEqual({
        status: 204,
        body: '',
      });
    };

    if (cut === 'before Native FULL') {
      mutateAdmittedTestNanoHost(db, (sqlite) =>
        sqlite.exec(`CREATE TRIGGER row7_cut BEFORE UPDATE OF state ON worker_backend_sessions
          WHEN NEW.state='cleaned'
          BEGIN SELECT RAISE(ABORT, 'Row 7 cut before coupled backend completion'); END`)
      );
      await checkHoldAfterRestart();
      expect(readVolume()).toEqual(originalHold);
      expect(readBackend().state).toBe('cleanup-failed');
      mutateAdmittedTestNanoHost(db, (sqlite) => sqlite.exec('DROP TRIGGER row7_cut'));
      await restart().run();
      expect(readVolume().revision).toBe(originalHold!.revision + 1);
    } else if (cut === 'absent completion') {
      const released = await releaseReservation(readVolume());
      expect(released.state).toBe('idle');
      await checkHoldAfterRestart();
      await reserveForAnotherThread();
      await checkHoldAfterRestart();
      expect(readBackend().state).toBe('cleanup-failed');
      await assertNoFurtherEffects();
      return;
    } else if (cut.startsWith('Workspace before Core') || cut === 'Core ACK lost') {
      await runToCut(
        (request) =>
          request.operation === 'core-journal' &&
          request.input?.kind === 'undelivered-refusal-successor' &&
          request.input.stage === 'release',
        cut === 'Core ACK lost'
      );
      expect(store.getTurnById(turnId).status).toBe('interrupted');
      expect(terminalEvents()).toHaveLength(1);
      expect(requireSchedulerExecutionAttempt(db, successorId).phase).toBe(
        cut === 'Core ACK lost' ? 'closed' : 'closing'
      );
      if (cut === 'Workspace before Core, reused') await reserveForAnotherThread();
    } else {
      await runToCut(
        (request) =>
          request.operation === 'nanohost-owner' &&
          request.mutation?.kind === 'undelivered-refusal-successor' &&
          request.mutation.input?.stage === 'teardown',
        true
      );
      expectHeld(db);
      expect(readVolume()).toMatchObject({
        state: 'idle',
        attachmentGeneration: writer.attachmentGeneration + 1,
        revision: originalHold!.revision + 1,
      });
      expect(readBackend()).toMatchObject({
        state: 'cleaned',
        workspaceHandoffState: 'complete',
        physicalCleanedAt: expect.any(String),
      });
      if (cut.includes('reused') || cut.endsWith('contributor') || cut === 'different binding') {
        const later = await reserveForAnotherThread();
        if (cut === 'Native ACK lost, reused then released') {
          await releaseReservation(later);
        } else if (cut.endsWith('contributor') || cut === 'different binding') {
          const exactBackend = readBackend();
          // Withhold only one original proof. Keep the later writer intact.
          mutateAdmittedTestNanoHost(db, (sqlite) => {
            const changed =
              cut === 'different binding'
                ? sqlite
                    .prepare(
                      'UPDATE worker_backend_sessions SET sandbox_binding_ref=? WHERE attempt_id=?'
                    )
                    .run(`sha256:${'e'.repeat(64)}`, successorId)
                : cut === 'missing contributor'
                  ? sqlite
                      .prepare(
                        'DELETE FROM worker_storage_contributors WHERE storage_ref=? AND attachment_generation=?'
                      )
                      .run(writer.storageRef, originalHold!.attachmentGeneration)
                  : sqlite
                      .prepare(
                        'UPDATE worker_storage_contributors SET work_slot_ref=? WHERE storage_ref=? AND attachment_generation=?'
                      )
                      .run(
                        later.currentWorkSlotRef,
                        writer.storageRef,
                        originalHold!.attachmentGeneration
                      );
            expect(changed.changes).toBe(1);
          });
          expect(readBackend()).toEqual(
            cut === 'different binding'
              ? { ...exactBackend, sandboxBindingRef: `sha256:${'e'.repeat(64)}` }
              : exactBackend
          );
          expect(readVolume()).toEqual({ ...later, contributors: expect.any(Array) });
          expect(readVolume().contributors.at(-1)).toEqual(later.contributors.at(-1));
          await checkHoldAfterRestart();
          await checkHoldAfterRestart();
          await assertNoFurtherEffects();
          return;
        }
      }
      if (cut === 'conflicting Turn outcome') {
        const admission = requireSchedulerExecutionAttemptAdmissionContext(db, successorId);
        const conflict = await terminalizeGovernedWorkerTurn({
          agentSessionId,
          completedAt: new Date().toISOString(),
          errorCode: 'worker_governance_restart_recovery',
          message: 'Turn completed through a different decision.',
          outcome: 'cancelled',
          requestId: admission.requestId,
          store,
          turnId,
        });
        expect(conflict.status).toBe('cancelled');
        const volume = readVolume();
        for (let pass = 0; pass < 2; pass += 1) {
          const reopened = restart();
          await expect(reopened.run()).rejects.toBeInstanceOf(AggregateError);
          expect(store.getTurnById(turnId)).toEqual(conflict);
          expect(requireSchedulerExecutionAttempt(reopened.core, successorId).phase).toBe(
            'closing'
          );
          expect(terminalEvents()).toHaveLength(1);
          expect(readVolume()).toEqual(volume);
        }
        await assertNoFurtherEffects();
        return;
      }
    }

    const detached = readVolume();
    const backend = readBackend();
    const beforeReplay = store.getTurnById(turnId);
    const replayErrors: unknown[] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const reopened = restart();
      await reopened.run().catch((error: unknown) => replayErrors.push(error));
      expect(readVolume()).toEqual(detached);
      expect(readBackend()).toEqual(backend);
    }
    const originalTurn = store.getTurnById(turnId);
    const finalAttempt = requireSchedulerExecutionAttempt(replayDb!, successorId);
    expect({ status: originalTurn.status, phase: finalAttempt.phase }).toEqual({
      status: 'interrupted',
      phase: 'closed',
    });
    expect(replayErrors).toEqual([]);
    expect(finalAttempt).toMatchObject({
      terminalCause: 'restart-native-recovery',
      operationId: request.requestId,
      outcomeRef: `turn:${turnId}:interrupted`,
    });
    expect(detached.attachmentGeneration).toBe(
      writer.attachmentGeneration + (cut.includes('reused') ? 2 : 1)
    );
    expect(originalTurn.error?.code).toBe('worker_governance_restart_recovery');
    if (beforeReplay.status === 'interrupted') expect(originalTurn).toEqual(beforeReplay);
    expect(store.getAgentSession(agentSessionId).retainedStorage).toEqual(retainedStorage);
    expect(terminalEvents()).toHaveLength(1);
    expect(requireSchedulerAdmissionEntry(replayDb!, attempt.queueEntryId).status).toBe('admitted');
    expect(findNextDispatchableSchedulerAdmissionEntry(replayDb!)).toBeNull();
    expect(
      replayDb!.sqlite
        .prepare(`SELECT count(*) FROM control_execution_steps
          WHERE execution_id=? AND json_extract(control_json, '$.kind')='release'`)
        .pluck()
        .get(`scheduler-lifecycle:${successorId}`)
    ).toBe(1);
    await assertNoFurtherEffects();
  } finally {
    stopOriginal.reject(
      new Error('Test ended the pre-reopen producer without delivering its reply.')
    );
    await vi.advanceTimersByTimeAsync(harnessRecords.NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    await successor?.catch(() => undefined);
    await successorClaim?.catch(() => undefined);
    coldClient?.destroy();
    if (coldServer?.listening)
      await new Promise<void>((resolve) => coldServer!.close(() => resolve()));
    replayDb?.sqlite.close();
    cold?.sqlite.close();
    await closeReleaseRefusalFixture(f);
  }
}

it('settles an undelivered successor after Core reopens with its Create reply withheld', async () => {
  await exerciseUndeliveredRecovery('before Native FULL');
}, 60_000);

it.each(undeliveredRecoveryCuts.slice(1))(
  'recovers the undelivered successor at the %s cut',
  exerciseUndeliveredRecovery,
  60_000
);

it('dispatches the same running Turn after exact release', async () => {
  const marker = Buffer.from('retained predecessor work');
  let mountMarkers: ((request: NanoHostSessionEffectRequest) => Buffer | undefined) | undefined;
  let observedMarker: Buffer | undefined;
  const f = await faultFixture({
    orderReleaseRefusalRecycle: true,
    beforeEffect: (kind, request) => {
      if (kind === 'sandbox.create' && mountMarkers) observedMarker = mountMarkers(request);
    },
  });
  let successor: ReturnType<typeof runSchedulerDispatchLoop> | undefined;
  try {
    await f.waitQueued('session.open');
    const predecessorId = testEntityId('attempt', 'fault-lease');
    const successorId = testEntityId('attempt', 'fault-successor');
    const predecessor = onNative(f.coreDb, (owner) =>
      getWorkerBackendSession(owner, predecessorId)
    )!;
    const { turnId, workspaceId } = predecessor;
    const original = f.store.getAgentSession(predecessor.agentSessionId);
    const originalTurn = f.store.getTurnById(turnId);
    const originalAdmission = requireSchedulerAdmissionEntry(f.coreDb, 'fault-queue');
    const firstWriter = onNative(f.coreDb, (owner) =>
      getWorkerStorageBindingForSandbox(owner, predecessor)
    )!;
    const volume = firstWriter.targets.find(
      ({ target }) => target === '/openkit/threads'
    )!.volumeRef;
    writeFileSync(join(f.coreDb.dataRoot, volume), marker);
    mountMarkers = (request) => {
      const storage = request.input.storage as { targets: { target: string; volumeRef: string }[] };
      const target = storage.targets.find(({ target }) => target === '/openkit/threads');
      const path = join(f.coreDb.dataRoot, target!.volumeRef);
      return existsSync(path) ? readFileSync(path) : undefined;
    };
    const originalIntegration = String(
      f.effects.find(({ kind }) => kind === 'bridge.open')!.input.sandboxIntegrationBindingRef
    );
    const ws = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
    let terminal: Awaited<ReturnType<typeof workerTurnTerminalPublication>>;
    try {
      terminal = await workerTurnTerminalPublication(ws, turnId, 'failed', predecessorId);
    } finally {
      ws.sqlite.close();
    }

    const refusal = await f.post(releaseRefusalPoll, mismatchedBuild);
    expect(refusal.status).toBe(409);
    expect(JSON.parse(refusal.body)).toMatchObject({ code: 'worker_release_incompatible' });
    expect(f.dispatchedCommands).toEqual([]);
    await f.maintenance();
    await vi.advanceTimersByTimeAsync(harnessRecords.NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    await f.running.catch(() => undefined);

    const nextImage = `sha256:${'b'.repeat(64)}`;
    const { manifest } = createTestAgentSetup({
      imageRef: nextImage,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    await admitTestNativeEnvironmentForRoot(f.coreDb, manifest);
    const opening = f.nextEnqueue('session.open');
    successor = f.startSuccessor(successorId, manifest);
    const wait = (queued: Promise<void>) =>
      Promise.race([
        queued,
        successor!.then((result) => {
          throw new Error(
            `Dispatch ended before successor enqueue: ${result.terminalResult.status}.`
          );
        }),
      ]);
    await wait(opening);
    expect(observedMarker).toEqual(marker);
    const reopened = openCoreReadDb(f.coreDb.dataRoot);
    let successorBinding: NonNullable<ReturnType<typeof getWorkerBackendSession>>;
    try {
      successorBinding = onNative(reopened, (owner) =>
        getWorkerBackendSession(owner, successorId)
      )!;
      expect(successorBinding).toMatchObject({ agentSessionId: original.id, turnId });
      expect(requireSchedulerAdmissionEntry(reopened, 'fault-queue')).toEqual(originalAdmission);
      expect(successorBinding.sandboxBindingRef).not.toBe(predecessor.sandboxBindingRef);
      expect(successorBinding.packageSnapshotId).not.toBe(predecessor.packageSnapshotId);
      expect(
        onNative(reopened, (owner) => getWorkerStorageBinding(owner, firstWriter))
      ).toMatchObject({
        state: 'attached',
        storageRef: firstWriter.storageRef,
        currentSandboxBindingRef: successorBinding.sandboxBindingRef,
        currentWorkSlotRef: firstWriter.currentWorkSlotRef,
        attachmentGeneration: firstWriter.attachmentGeneration + 1,
        targets: firstWriter.targets,
      });
      expect(
        reopened.sqlite
          .prepare(
            "SELECT count(*) AS count FROM control_executions WHERE definition_version='core-sandbox-release-refusal/v1'"
          )
          .get()
      ).toEqual({ count: 1 });
    } finally {
      reopened.sqlite.close();
    }
    expect(
      f.effects
        .filter(({ kind }) => kind === 'sandbox.create')
        .map(({ input }) => input.imageDigest)
    ).toEqual([`sha256:${DIGEST}`, nextImage]);
    const successorIntegration = String(
      f.effects.filter(({ kind }) => kind === 'bridge.open').at(-1)!.input
        .sandboxIntegrationBindingRef
    );
    expect(successorIntegration).not.toBe(originalIntegration);
    const poll = async (integration: string) =>
      f.post(
        releaseRefusalPoll,
        {
          schemaVersion: 2,
          releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
        },
        undefined,
        integration,
        integration === originalIntegration
          ? predecessor.sandboxBindingRef
          : successorBinding.sandboxBindingRef
      );
    const command = async (operation: 'session.open' | 'turn.start' | 'session.inspect') => {
      const response = await poll(successorIntegration);
      expect(response.status, response.body).toBe(200);
      const value = JSON.parse(response.body) as NanoHostHarnessCommand;
      expect(value.operation).toBe(operation);
      return value;
    };
    const assertStalePoll = async () => {
      const replay = await poll(originalIntegration);
      expect(replay).toEqual({ status: 204, body: '' });
    };
    await assertStalePoll();
    const opened = await command('session.open');
    const starting = f.nextEnqueue('turn.start');
    await f.result(
      opened,
      { ...ready, state: 'open', maxActiveTurns: opened.body.maxActiveTurns },
      successorIntegration
    );
    await wait(starting);
    const delivered = await command('turn.start');
    const { agentSessionId, leaseId, packageSnapshotId } = delivered.body;
    expect({ agentSessionId, leaseId, packageSnapshotId }).toEqual({
      agentSessionId: original.id,
      leaseId: successorId,
      packageSnapshotId: successorBinding.packageSnapshotId,
    });

    await expect(
      f.store.completeTurn(
        turnId,
        {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: { code: 'test-late-predecessor', message: 'Prior attempt must stay fenced.' },
        },
        terminal
      )
    ).rejects.toThrow();
    await expect(
      f.nativeOwner.releaseIdleSandboxStorage({
        kind: 'release',
        attachmentGeneration: firstWriter.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: firstWriter.revision,
        sandboxBindingRef: predecessor.sandboxBindingRef,
        storageRef: firstWriter.storageRef,
      })
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    await assertStalePoll();
    expect(f.dispatchedCommands.filter(({ operation }) => operation === 'turn.start')).toHaveLength(
      1
    );
    const readback = new FsStore({ dataRoot: f.coreDb.dataRoot });
    expect(readback.getTurnById(turnId)).toMatchObject({
      status: 'running',
      agentSessionId: original.id,
      items: originalTurn.items,
      startedAt: originalTurn.startedAt,
    });
    expect(
      readback.getTurnEvents(turnId).filter(({ event }) => event === 'turn.started')
    ).toHaveLength(1);
    expect(readback.getAgentSession(original.id).retainedStorage).toEqual(original.retainedStorage);
    const workspace = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
    try {
      expect(
        workspace.sqlite.prepare('SELECT id FROM control_executions WHERE work_id=?').all(turnId)
      ).toEqual([{ id: terminal.execution!.executionId }]);
    } finally {
      workspace.sqlite.close();
    }
    expect(
      onNative(f.coreDb, (owner) => getWorkerStorageBinding(owner, firstWriter))
    ).toMatchObject({
      state: 'attached',
      currentSandboxBindingRef: successorBinding.sandboxBindingRef,
      attachmentGeneration: firstWriter.attachmentGeneration + 1,
    });

    await f.result(delivered, { ...ready, state: 'started' }, successorIntegration);
    const joined = getSchedulerPreparationClaims(f.coreDb).get('fault-queue');
    const control = f.controlClient(delivered);
    await control.recordHeartbeat({ status: 'starting' });
    await control.recordHeartbeat({ status: 'running' });
    f.sealTranscript(delivered);
    const inspecting = f.nextEnqueue('session.inspect');
    await control.recordFinalStatus({ sequence: 1, status: 'completed', stopReason: 'completed' });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.race([
      inspecting,
      joined!.then(() => {
        throw new Error('Successor ended before the inspection enqueue.');
      }),
    ]);
    await f.result(
      await command('session.inspect'),
      {
        ...ready,
        state: 'open',
        childState: 'running',
        cleanupState: 'clean',
      },
      successorIntegration
    );
    await joined;
    expect(readback.getTurnById(turnId).status).toBe('completed');
    const idle = openBootVerifiedWorkspaceDb(f.coreDb.dataRoot, workspaceId);
    try {
      const anchor = onNative(f.coreDb, (owner) => getWorkerBackendSession(owner, successorId))!;
      expect(requireSchedulerExecutionAttempt(f.coreDb, successorId).phase).toBe('closed');
      const identity = {
        workspaceId,
        threadId: anchor.threadId,
        turnId,
        agentSessionId: anchor.agentSessionId,
        packageSnapshotId: anchor.packageSnapshotId,
        storageRef: firstWriter.storageRef,
        scopeDigest: firstWriter.scopeDigest,
        sandboxId: nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId),
        workSlot: firstWriter.currentWorkSlotRef!,
        attachmentGeneration: firstWriter.attachmentGeneration + 1,
        collectionId: `release-${createHash('sha256').update(anchor.packageSnapshotId).digest('hex')}`,
      };
      await expect(
        claimIdleWorkspaceCapture(idle, anchor, {
          ...identity,
          attachmentGeneration: firstWriter.attachmentGeneration,
        })
      ).rejects.toThrow('Idle capture lacks its original attachment generation.');
      await claimIdleWorkspaceCapture(idle, anchor, identity);
      expect(listWorkspaceReconciliationRecords(idle, workspaceId)).toEqual([
        expect.objectContaining({
          backendHandleSummary: expect.objectContaining({ identity, candidateDigest: null }),
        }),
      ]);
      await expect(hasPendingWorkspaceCapture(f.coreDb, idle, anchor)).resolves.toBe(true);
    } finally {
      idle.sqlite.close();
    }
  } finally {
    await vi.advanceTimersByTimeAsync(harnessRecords.NANO_HOST_HARNESS_RESULT_BUDGET_MS);
    await successor?.catch(() => undefined);
    await closeReleaseRefusalFixture(f);
  }
}, 60_000);
