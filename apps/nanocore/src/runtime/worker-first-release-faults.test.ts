import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, constants, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { WorkerControlClient } from '../../../../packages/worker-shim/src/control-client.js';
import { createDefaultWorkerControlGateway } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  completeSchedulerLeaseForTerminalTurn,
  createSchedulerAdmissionEntry,
  requireSchedulerSessionLease,
  upsertSchedulerCapacityRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
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
import { runSchedulerLeaseMaintenanceOnce } from './scheduler-lease-maintenance-service.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import { registerWorkerControlRoutes } from './worker-control-routes.js';

// Route final-status polling uses timers/promises; bind that delay to the same fake clock as Harness deadlines.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: <T>(milliseconds: number, value: T) =>
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(value), milliseconds);
    }),
}));

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
              targets: [{ target: '/sandbox' }, { target: '/workspace' }],
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

/** Composes real scheduler, lease, control routes, private poll/result routes and Turn closeout over the existing external-effect double. */
async function faultFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-first-release-fault-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const setup = createTestAgentSetup({ requiredCapabilities: ['trusted-worker-inference-relay'] });
  admitTestNativeEnvironment(coreDb, setup.manifest);
  const gateway = createDefaultWorkerControlGateway(coreDb);
  const effects: NanoHostSessionEffectRequest[] = [];
  const transcript = { events: '' };
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb,
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
  registerNanoHostSessionSemanticRoutes({
    app,
    coreDb,
    nanoHostConfig: target,
    dispatch: createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority }),
    harnessCommandDispatched: runtime.acceptNanoHostHarnessCommand,
    harnessResultSettled: runtime.acceptNanoHostHarnessResult,
    harnessCommandDeliveryFailed: runtime.failNanoHostHarnessDelivery,
  });
  let admitted = false;
  let dropNextPoll = false;
  let resetNextPoll = false;
  let droppedCommand: NanoHostHarnessCommand | null = null;
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
    if (dropNextPoll && request.url === '/worker-control/harness/poll') {
      dropNextPoll = false;
      response.writeHead = ((statusCode: number) => {
        response.statusCode = statusCode;
        return response;
      }) as typeof response.writeHead;
      // Lose the response at the write boundary, after the real route committed dispatch and notified its waiting owner.
      response.end = ((body: string) => {
        expect(response.statusCode).toBe(200);
        droppedCommand = JSON.parse(body) as NanoHostHarnessCommand;
        expect(
          coreDb.sqlite.prepare('SELECT operation_state FROM harness_instance_records').get()
        ).toEqual({ operation_state: 'dispatched' });
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
  const post = async (path: string, body: unknown) => {
    const integration = coreDb.sqlite
      .prepare('SELECT sandbox_integration_binding_ref AS ref FROM sandbox_runtime_records')
      .get() as { ref: string } | undefined;
    const stream = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
      ...(integration ? { 'x-openkit-integration-binding': integration.ref } : {}),
    });
    let status: number | undefined;
    stream.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    stream.end(JSON.stringify(body));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return { status, body: Buffer.concat(chunks).toString() };
  };
  expect(
    await post('/api/nanohost/transport/session/readiness', { physicalEpoch: DIGEST })
  ).toEqual({ status: 204, body: '' });
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 0,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: 1,
    poolId: 'fault-pool',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: NOW,
    poolId: 'fault-pool',
    queueDepth: 0,
    targetId: target.identityId,
  });
  createSchedulerAdmissionEntry(coreDb, {
    priorityClass: 'interactive',
    queueEntryId: 'fault-queue',
    requestId: null,
    requestedAgentId: setup.manifest.id,
    requiredPoolConstraints: ['openshell.local'],
    threadId: 'th_demo',
    turnId: 'fault-turn',
    turnInput: 'Exercise a bounded worker fault',
    triggerActor: { kind: 'user', id: 'user_local' },
    workspaceId: 'ws_demo',
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
      queueOperation(db, input);
      if (db === coreDb && input.operation in enqueued) {
        enqueued[input.operation as keyof typeof enqueued].resolve();
      }
    });
  let settled = false;
  const running = runSchedulerDispatchLoop({
    agentManifests: [setup.manifest],
    coreDb,
    createAgentSessionId: () => 'fault-session',
    createLeaseId: () => 'fault-lease',
    createPlanId: () => 'fault-plan',
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    gatewayConfig: createTestGatewayConfig(),
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    maxDispatches: 1,
    schedulerEpoch: 1,
    startupTimeoutMs: 120_000,
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
  const poll = () => post('/worker-control/harness/poll', { schemaVersion: 2 });
  const dispatch = async (operation: keyof typeof enqueued) => {
    await waitQueued(operation);
    const response = await poll();
    expect(response.status).toBe(200);
    const command = JSON.parse(response.body) as NanoHostHarnessCommand;
    expect(command.operation).toBe(operation);
    return command;
  };
  const result = async (command: NanoHostHarnessCommand, body: Record<string, unknown>) => {
    expect(
      await post('/worker-control/harness/result', {
        schemaVersion: 2,
        harnessInstanceId: command.harnessInstanceId,
        operationId: command.operationId,
        sequence: command.sequence,
        disposition: 'succeeded',
        body,
      })
    ).toEqual({ status: 204, body: '' });
  };
  const controlClient = (command: NanoHostHarnessCommand) =>
    new WorkerControlClient({
      baseUrl: 'http://core.test/api/worker-control',
      token: String(command.body.workerControlToken),
      lineage: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'fault-turn',
        agentSessionId: 'fault-session',
        packageSnapshotId: String(command.body.packageSnapshotId),
        requestId: null,
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
    effects,
    running,
    waitQueued,
    dispatch,
    result,
    poll,
    controlClient,
    close,
    isSettled: () => settled,
    loseNextPoll: (reset = false) => {
      dropNextPoll = true;
      resetNextPoll = reset;
    },
    droppedCommand: () => droppedCommand,
    sealTranscript: (command: NanoHostHarnessCommand) => {
      transcript.events = `${JSON.stringify(
        buildWorkerCanonicalTerminalEventRecord({
          lineage: {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'fault-turn',
            agentSessionId: 'fault-session',
            packageSnapshotId: String(command.body.packageSnapshotId),
            requestId: null,
          },
          sequence: 1,
          data: { status: 'completed', stopReason: 'completed' },
        })
      )}\n`;
    },
  };
}

const ready = { nativeHandleDigest: DIGEST, nativeHandleState: 'ready' };

describe('first-release worker faults (real Core crossings)', () => {
  it('keeps the lease live across multiple heartbeat deadlines while a Pending Request is unanswered', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    const workspaceDb = openWorkspaceDb(f.coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    try {
      await f.result(await f.dispatch('session.open'), {
        ...ready,
        maxActiveTurns: 1,
        state: 'open',
      });
      const start = await f.dispatch('turn.start');
      await f.result(start, { ...ready, state: 'started' });
      const control = f.controlClient(start);
      await control.recordHeartbeat({ status: 'starting' });
      await control.recordHeartbeat({ status: 'running' });
      const firstDeadline = requireSchedulerSessionLease(f.coreDb, 'fault-lease').heartbeatDeadline;
      const request = {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        raisingTurnId: 'fault-turn',
        requestId: 'fault-question',
        requestItemId: 'fault-question-item',
        kind: 'user-input' as const,
        requesterKind: 'worker' as const,
        agentId: f.store.getTurnById('fault-turn').agentId!,
        agentSessionId: 'fault-session',
        responsibleUserId: 'user_local',
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
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'fault-turn',
        type: 'user-input-request',
        status: 'completed',
        userInputRequestId: request.requestId,
        responsibleUserId: 'user_local',
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
        runSchedulerLeaseMaintenanceOnce(f.coreDb, {
          maxTotalLeaseMs: 900_000,
          renewalDurationMs: 900_000,
          renewalLeadMs: 0,
        });
        expect(requireSchedulerSessionLease(f.coreDb, 'fault-lease').status).toBe('active');
        expect(readPendingRequest(workspaceDb.sqlite, request.requestId)).toEqual(pendingRecord);
        expect(f.store.getTurnById('fault-turn').status).toBe('running');
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
          { kind: 'user', id: 'user_local' },
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
      expect(f.store.getTurnById('fault-turn').status).toBe('completed');
      expect(new FsStore({ dataRoot: f.coreDb.dataRoot }).getTurnById('fault-turn').status).toBe(
        'completed'
      );
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

  it.each([
    false,
    true,
  ])('bounds a lost committed turn.start poll response (explicit reset: %s) without redelivery or false success', async (reset) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    try {
      await f.result(await f.dispatch('session.open'), {
        ...ready,
        maxActiveTurns: 1,
        state: 'open',
      });
      await f.waitQueued('turn.start');
      f.loseNextPoll(reset);
      expect(await f.poll()).toEqual({ status: undefined, body: '' });
      expect(f.droppedCommand()?.operation).toBe('turn.start');
      const dispatched = f.coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get();
      const nextPoll = await f.poll();
      if (reset) {
        // Prompt cleanup may already have retired the Integration; neither response may carry work.
        expect([204, 409]).toContain(nextPoll.status);
      } else {
        expect(nextPoll).toEqual({ status: 204, body: '' });
        expect(f.coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get()).toEqual(
          dispatched
        );
      }
      expect(
        f.coreDb.sqlite.prepare('SELECT count(*) AS count FROM worker_control_records').get()
      ).toEqual({ count: 0 });
      const expectedFailure = reset
        ? 'NanoHost Harness turn.start delivery incomplete: outcome unknown.'
        : 'NanoHost Harness turn.start result outage budget expired: dispatched-awaiting-result.';
      if (reset) {
        // Known incomplete delivery must release the waiter into cleanup without spending its budget.
        await vi.advanceTimersByTimeAsync(100);
        expect(f.isSettled()).toBe(true);
      } else {
        await vi.advanceTimersByTimeAsync(299_999);
        expect(f.isSettled()).toBe(false);
        expect(f.store.getTurnById('fault-turn').status).toBe('running');
        await vi.advanceTimersByTimeAsync(1);
      }
      await expect(f.running).rejects.toThrow(expectedFailure);
      const turn = f.store.getTurnById('fault-turn');
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
      completeSchedulerLeaseForTerminalTurn(f.coreDb, turn);
      expect(requireSchedulerSessionLease(f.coreDb, 'fault-lease').status).toBe('failed');
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it('fails closed when a dispatched session.inspect result is held for the 300-second budget', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const f = await faultFixture();
    try {
      await f.result(await f.dispatch('session.open'), {
        ...ready,
        maxActiveTurns: 1,
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
      expect(f.store.getTurnById('fault-turn').status).toBe('running');
      expect(
        f.store.getTurnEvents('fault-turn').filter((event) => event.event === 'turn.completed')
      ).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(f.running).rejects.toThrow(
        'NanoHost Harness session.inspect result outage budget expired: dispatched-awaiting-result.'
      );
      const turn = f.store.getTurnById('fault-turn');
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
      completeSchedulerLeaseForTerminalTurn(f.coreDb, turn);
      expect(requireSchedulerSessionLease(f.coreDb, 'fault-lease').status).toBe('failed');
      expect(f.coreDb.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });
});
