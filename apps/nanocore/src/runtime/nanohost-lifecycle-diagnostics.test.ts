import { EventEmitter, once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { connect, constants, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as nextLoop } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { runWorkerHarness, WorkerHarness } from '../../../../packages/worker-shim/src/harness.js';
import type { SandboxIntegrationClient } from '../../../../packages/worker-shim/src/integration-client.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  createNanoHostHarnessRuntime,
  markNanoHostHarnessOperationUnknown,
  type NanoHostHarnessCommand,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';

// Use Node's real sampler and observe sample arrival rather than guessing a sleep duration.
vi.mock('node:perf_hooks', async (original) => {
  const actual = await original<typeof import('node:perf_hooks')>();
  const histogram = actual.monitorEventLoopDelay({ resolution: 10 });
  return { ...actual, monitorEventLoopDelay: () => histogram };
});
const delayHistogram = monitorEventLoopDelay({ resolution: 10 });
delayHistogram.enable();

/** Joins an actual sampler observation, with a bounded failure rather than a fixed sleep. */
async function nextDelaySample(previousCount: number): Promise<void> {
  const deadline = performance.now() + 2000;
  while (delayHistogram.count <= previousCount) {
    if (performance.now() >= deadline) throw new Error('Event-loop delay sampler did not run.');
    await nextLoop();
  }
}

const transport = vi.hoisted(() => ({ client: null as SandboxIntegrationClient | null }));
vi.mock('../../../../packages/worker-shim/src/integration-client.js', async (original) => ({
  ...(await original<object>()),
  openSandboxIntegration: async () => transport.client!,
}));

/** Explicit gate observation; elapsed wall time cannot stand in for request entry. */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Harness delivery localization through real Core and shim owners', () => {
  it.each([
    'cancel-before-dispatch',
    'request-aborted',
    'stream-destroyed',
    'stream-reset',
    'cancel-command',
    'cancel-ended-command',
    'timed-cancel-ended-command',
    'result-before-reset',
    'withhold-result',
    'sampled-event-loop-block',
    'sampled-event-loop-control',
    'sampled-event-loop-before-sample',
  ] as const)('distinguishes %s without redelivery or invented result certainty', async (scenario) => {
    const shape =
      scenario === 'timed-cancel-ended-command' || scenario === 'result-before-reset'
        ? 'cancel-ended-command'
        : scenario;
    const sampledDelay = scenario.startsWith('sampled-event-loop-');
    let coreClock = 100;
    const clock =
      scenario === 'timed-cancel-ended-command'
        ? vi.spyOn(performance, 'now').mockImplementation(() => coreClock)
        : undefined;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = process.stdout.write.bind(process.stdout);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string) =>
        chunk === 'OPENKIT_WORKER_SHIM_ENTRY_V1\n'
          ? true
          : write(chunk)) as typeof process.stdout.write);
    const handle = vi.spyOn(WorkerHarness.prototype, 'handle');
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-lifecycle-diag-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const target = { deploymentId: 'diag', identityId: 'diag', targetId: 'diag' };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: new Date().toISOString(),
    });
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const app = new Hono<{ Variables: AuthVariables }>();
    const knownCancellation = ['request-aborted', 'stream-destroyed', 'stream-reset'].includes(
      scenario
    );
    let injectedCancellation = false;
    let pollIncoming: import('node:http2').Http2ServerRequest | undefined;
    let restoreCancellation: (() => void) | undefined;
    const pollEntered = gate();
    const releasePoll = gate();
    const pollCompleted = gate();
    const route = dispatch.route.bind(dispatch);
    let firstPoll = true;
    let injectedDelayedSample = false;
    vi.spyOn(dispatch, 'route').mockImplementation(async (connection, request) => {
      await route(connection, request);
      if (request.path.endsWith('/poll') && knownCancellation && !injectedCancellation) {
        // Inject after body collection so each signal reaches the dispatch guard independently.
        injectedCancellation = true;
        const target = scenario === 'request-aborted' ? pollIncoming! : pollIncoming!.stream;
        const field =
          scenario === 'request-aborted'
            ? 'aborted'
            : scenario === 'stream-destroyed'
              ? 'destroyed'
              : 'rstCode';
        const descriptor = Object.getOwnPropertyDescriptor(target, field);
        Object.defineProperty(target, field, {
          configurable: true,
          value: scenario === 'stream-reset' ? constants.NGHTTP2_CANCEL : true,
        });
        restoreCancellation = () => {
          if (descriptor) Object.defineProperty(target, field, descriptor);
          else Reflect.deleteProperty(target, field);
        };
      }
      if (request.path.endsWith('/poll') && firstPoll) {
        firstPoll = false;
        if (shape === 'cancel-before-dispatch') {
          pollEntered.resolve();
          await releasePoll.promise;
        }
        if (sampledDelay) {
          await nextDelaySample(delayHistogram.count);
          const beforeBlock = delayHistogram.count;
          if (scenario === 'sampled-event-loop-block') {
            const until = performance.now() + 1100;
            while (performance.now() < until) {
              /* Inject a synchronous Core block. */
            }
          }
          // A response callback can precede the delayed sample. Join its count explicitly.
          await nextDelaySample(beforeBlock);
        }
        coreClock = 850;
      }
    });
    app.use('/worker-control/harness/poll', async (context, next) => {
      if (scenario === 'sampled-event-loop-before-sample' && !injectedDelayedSample) {
        injectedDelayedSample = true;
        const bindings = context.env as {
          outgoing: import('node:http2').Http2ServerResponse;
        };
        const response = bindings.outgoing;
        const diagnosticResponse = Object.assign(new EventEmitter(), { writableFinished: true });
        // Keep native H2 completion intact; inject only the observer's terminal binding.
        bindings.outgoing = diagnosticResponse as import('node:http2').Http2ServerResponse;
        const end = response.end.bind(response);
        response.end = ((...args: Parameters<typeof response.end>) => {
          const count = delayHistogram.count;
          const until = performance.now() + 1125;
          while (performance.now() < until) {
            /* The response observer must run before Node can sample this block. */
          }
          expect(delayHistogram.count).toBe(count);
          diagnosticResponse.emit('finish');
          return end(...args);
        }) as typeof response.end;
      }
      pollIncoming = (context.env as { incoming: import('node:http2').Http2ServerRequest })
        .incoming;
      try {
        await next();
      } finally {
        restoreCancellation?.();
        restoreCancellation = undefined;
      }
      pollCompleted.resolve();
    });
    const committed = gate();
    const resultEntered = gate();
    const retried = gate();
    const responseFailed = gate();
    let operationId = '';
    let dispatchedCommand: NanoHostHarnessCommand | undefined;
    let resultAcceptedBeforeReset = false;
    let rawTokens: string[] = [];
    let dispatchCount = 0;
    registerNanoHostSessionSemanticRoutes({
      app,
      coreDb,
      dispatch,
      nanoHostConfig: target,
      harnessCommandDispatched: (command) => {
        dispatchCount += 1;
        dispatchedCommand = command;
        operationId = command.operationId;
        rawTokens = ['workerControlToken', 'inferenceToken', 'capabilityToken'].map(
          (name) => command.body[name] as string
        );
        committed.resolve();
        return command;
      },
    });
    const listener = getRequestListener(app.fetch);
    let admitted = false;
    let preDispatchCancelled = false;
    let holdCommand = shape !== 'withhold-result' && !sampledDelay;
    let baselineListeners: { finish: number; close: number; aborted: number } | undefined;
    let failedResponse: import('node:http2').Http2ServerResponse | undefined;
    let failedRequest: import('node:http2').Http2ServerRequest | undefined;
    const server = createServer((request, response) => {
      if (!admitted) {
        authority.admit({
          connectionGeneration: 1,
          identityId: target.identityId,
          physicalConnection: readNanoHostPhysicalConnectionContext(request)!,
        });
        admitted = true;
      }
      if (request.url === '/worker-control/harness/poll' && holdCommand) {
        holdCommand = false;
        if (shape === 'cancel-command') {
          // Hold actual native response completion after the dispatch transaction commits.
          response.end = (() => response) as typeof response.end;
        }
        failedResponse = response;
        failedRequest = request;
        response.once('close', responseFailed.resolve);
      }
      void listener(request, response);
      if (response === failedResponse) {
        // Preserve Hono's cleanup listeners; only the diagnostic observers must detach.
        baselineListeners = {
          finish: response.listenerCount('finish'),
          close: response.listenerCount('close') - 1,
          aborted: request.listenerCount('aborted'),
        };
      }
    });
    let client: ReturnType<typeof connect> | undefined;
    const stop = new AbortController();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing diagnostic test listener.');
      // A zero receive window leaves real end() pending after headers, exercising finish-on-reset.
      client = connect(`http://127.0.0.1:${address.port}`, {
        settings: { initialWindowSize: shape === 'cancel-ended-command' ? 0 : 65_535 },
      });
      /** Uses real H2 and cancels the physical exchange when the shim cancels its request. */
      const post = async (path: string, body: string, signal?: AbortSignal) => {
        const stream = client!.request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/json',
          'x-openkit-integration-binding': 'diag-integration',
        });
        const abort = () => stream.close(constants.NGHTTP2_CANCEL);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const headers = new Promise<[import('node:http2').IncomingHttpHeaders]>(
            (resolve, reject) => {
              stream.once('response', (headers) => resolve([headers]));
              stream.once('error', reject);
              stream.once('close', () => reject(new TypeError('Injected response reset.')));
            }
          );
          // Cancellation may reject headers while the server-side gate is still joining.
          void headers.catch(() => {});
          stream.end(body);
          if (shape === 'cancel-command' && path.endsWith('/poll') && dispatchCount === 0) {
            await Promise.race([
              committed.promise,
              headers.then(() => {
                throw new Error('Expected dispatch before command response.');
              }),
            ]);
            stream.close(constants.NGHTTP2_CANCEL);
          }
          if (
            shape === 'cancel-before-dispatch' &&
            path.endsWith('/poll') &&
            !preDispatchCancelled
          ) {
            preDispatchCancelled = true;
            await pollEntered.promise;
            stream.close(constants.NGHTTP2_CANCEL);
            await responseFailed.promise;
            releasePoll.resolve();
          }
          const [received] = await headers;
          if (
            shape === 'cancel-ended-command' &&
            path.endsWith('/poll') &&
            received[':status'] === 200 &&
            (scenario !== 'result-before-reset' || !resultAcceptedBeforeReset)
          ) {
            if (scenario === 'result-before-reset') {
              resultAcceptedBeforeReset = true;
              expect(dispatchedCommand).toBeDefined();
              expect(
                (
                  await post(
                    '/worker-control/harness/result',
                    JSON.stringify({
                      schemaVersion: 2,
                      harnessInstanceId: dispatchedCommand!.harnessInstanceId,
                      operationId: dispatchedCommand!.operationId,
                      sequence: dispatchedCommand!.sequence,
                      disposition: 'succeeded',
                      body: {
                        state: 'started',
                        nativeHandleState: 'pending',
                        nativeHandleDigest: null,
                      },
                    })
                  )
                ).status
              ).toBe(204);
              queueNanoHostHarnessOperation(coreDb, {
                harnessInstanceId: 'diag-harness',
                operation: 'session.inspect',
                timestamp: new Date().toISOString(),
                body: {
                  agentSessionId: 'diag-session',
                  agentSessionRuntimeBindingId: 'diag-session-binding',
                },
              });
            }
            coreClock = 1100;
            stream.close(constants.NGHTTP2_CANCEL);
          }
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          if (stream.rstCode) throw new TypeError('Injected response reset.');
          const text = Buffer.concat(chunks).toString();
          return {
            ok: received[':status'] < 400,
            status: received[':status'] as number,
            text: async () => text,
          };
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      };
      expect(
        (
          await post(
            '/api/nanohost/transport/session/readiness',
            JSON.stringify({ physicalEpoch: 'e'.repeat(64) })
          )
        ).status
      ).toBe(204);
      const now = new Date().toISOString();
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.160.0',
        harnessBindingRef: 'diag-harness-binding',
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId: 'diag-harness',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: 'e'.repeat(64),
        sandboxBindingRef: 'diag-sandbox-binding',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'diag-integration',
        sandboxRuntimeId: 'diag-sandbox',
        runtimeTargetId: target.identityId,
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: 'diag-session',
        agentSessionRuntimeBindingId: 'diag-session-binding',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'diag-harness',
        threadId: 'diag-thread',
        timestamp: now,
        workspaceId: 'diag-workspace',
      });
      ensureLocalUser(coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: 'diag-workspace',
        ownerUserId: 'user_local',
      });
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'diag-queue',
        requestId: 'diag-request',
        workspaceId: 'diag-workspace',
        threadId: 'diag-thread',
        turnId: 'diag-turn',
        turnInput: 'Exercise exact private Harness transport delivery',
        requestedAgentId: 'agent_diag',
        triggerActor: { kind: 'user', id: 'user_local' },
        now: () => now,
      });
      recordTestExecutionAttempt(coreDb, {
        entry,
        attemptId: 'diag-lease',
        agentSessionId: 'diag-session',
        inputRef: 'diag-package',
        bindingRef: 'diag-turn-binding',
        sessionCompatibilityKey: 'c'.repeat(64),
        operationId: 'diag-submit',
        now: () => now,
      });
      queueNanoHostHarnessOperation(coreDb, {
        harnessInstanceId: 'diag-harness',
        operation: 'turn.start',
        timestamp: now,
        body: {
          aepRef: '/openkit/package.json',
          agentSessionId: 'diag-session',
          agentSessionRuntimeBindingId: 'diag-session-binding',
          contextPackageId: 'ctxpkg_diag-turn',
          contextRef: '/openkit/context',
          deadline: '2099-01-01T00:00:00.000Z',
          leaseId: 'diag-lease',
          packageSnapshotId: 'diag-package',
          threadId: 'diag-thread',
          turnId: 'diag-turn',
          turnSequence: 0,
          workspaceId: 'diag-workspace',
        },
      });
      if (sampledDelay) {
        expect((await post('/worker-control/harness/poll', '{"schemaVersion":2}')).status).toBe(
          200
        );
        await vi.waitFor(() =>
          expect(
            log.mock.calls
              .map(([line]) => JSON.parse(String(line)))
              .some((line) => line.event === 'worker.harness.response')
          ).toBe(true)
        );
        const first = log.mock.calls
          .map(([line]) => JSON.parse(String(line)))
          .find((line) => line.event === 'worker.harness.response');
        expect(Number.isInteger(first.eventLoopDelayMaxMs)).toBe(true);
        expect(Number.isInteger(first.eventLoopDelayWindowMs)).toBe(true);
        if (scenario === 'sampled-event-loop-block') {
          expect(first.eventLoopDelayMaxMs).toBeGreaterThan(1000);
          expect(first.eventLoopDelayWindowMs).toBeGreaterThanOrEqual(1100);
        } else {
          expect(first.eventLoopDelayMaxMs).toBeLessThan(250);
        }
        // Settle and dispatch another operation: the old maximum must not survive the record.
        expect(
          (
            await post(
              '/worker-control/harness/result',
              JSON.stringify({
                schemaVersion: 2,
                harnessInstanceId: dispatchedCommand!.harnessInstanceId,
                operationId: dispatchedCommand!.operationId,
                sequence: dispatchedCommand!.sequence,
                disposition: 'succeeded',
                body: { state: 'started', nativeHandleState: 'pending', nativeHandleDigest: null },
              })
            )
          ).status
        ).toBe(204);
        queueNanoHostHarnessOperation(coreDb, {
          harnessInstanceId: 'diag-harness',
          operation: 'session.inspect',
          timestamp: new Date().toISOString(),
          body: {
            agentSessionId: 'diag-session',
            agentSessionRuntimeBindingId: 'diag-session-binding',
          },
        });
        await nextDelaySample(delayHistogram.count);
        expect((await post('/worker-control/harness/poll', '{"schemaVersion":2}')).status).toBe(
          200
        );
        await vi.waitFor(() =>
          expect(
            log.mock.calls
              .map(([line]) => JSON.parse(String(line)))
              .filter((line) => line.event === 'worker.harness.response')
          ).toHaveLength(2)
        );
        const second = log.mock.calls
          .map(([line]) => JSON.parse(String(line)))
          .filter((line) => line.event === 'worker.harness.response')[1];
        if (scenario === 'sampled-event-loop-before-sample') {
          expect(second.eventLoopDelayMaxMs).toBeGreaterThan(1000);
          expect(second.eventLoopDelayWindowMs).toBeGreaterThanOrEqual(1125);
          // An ordinary subsequent response must consume the carried maximum exactly once.
          const command = dispatchedCommand!;
          expect(
            (
              await post(
                '/worker-control/harness/result',
                JSON.stringify({
                  schemaVersion: 2,
                  harnessInstanceId: command.harnessInstanceId,
                  operationId: command.operationId,
                  sequence: command.sequence,
                  disposition: 'succeeded',
                  body: {
                    childState: 'running',
                    cleanupState: 'pending',
                    nativeHandleDigest: null,
                    nativeHandleState: 'pending',
                    state: 'active',
                  },
                })
              )
            ).status
          ).toBe(204);
          queueNanoHostHarnessOperation(coreDb, {
            harnessInstanceId: 'diag-harness',
            operation: 'session.inspect',
            timestamp: new Date().toISOString(),
            body: {
              agentSessionId: 'diag-session',
              agentSessionRuntimeBindingId: 'diag-session-binding',
            },
          });
          await nextDelaySample(delayHistogram.count);
          expect((await post('/worker-control/harness/poll', '{"schemaVersion":2}')).status).toBe(
            200
          );
          await vi.waitFor(() =>
            expect(
              log.mock.calls
                .map(([line]) => JSON.parse(String(line)))
                .filter((line) => line.event === 'worker.harness.response')
            ).toHaveLength(3)
          );
          const third = log.mock.calls
            .map(([line]) => JSON.parse(String(line)))
            .filter((line) => line.event === 'worker.harness.response')[2];
          expect(third.eventLoopDelayMaxMs).toBeLessThan(250);
        } else {
          expect(second.eventLoopDelayMaxMs).toBeLessThan(250);
        }
        return;
      }
      if (knownCancellation) {
        expect((await post('/worker-control/harness/poll', '{"schemaVersion":2}')).status).toBe(
          204
        );
        expect(dispatchCount).toBe(0);
        expect(
          coreDb.sqlite
            .prepare('SELECT operation_state, operation_id FROM harness_instance_records')
            .get()
        ).toEqual({ operation_state: 'queued', operation_id: null });
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT worker_control_token_hash, worker_inference_token_hash, worker_capability_token_hash FROM scheduler_execution_attempts'
            )
            .get()
        ).toEqual({
          worker_control_token_hash: null,
          worker_inference_token_hash: null,
          worker_capability_token_hash: null,
        });
        expect((await post('/worker-control/harness/poll', '{"schemaVersion":2}')).status).toBe(
          200
        );
        expect(dispatchCount).toBe(1);
        return;
      }
      if (shape === 'cancel-before-dispatch') {
        await expect(post('/worker-control/harness/poll', '{"schemaVersion":2}')).rejects.toThrow();
        await pollCompleted.promise;
        expect(failedRequest?.aborted).toBe(true);
        expect(failedRequest?.stream.destroyed).toBe(true);
        expect(failedRequest?.stream.rstCode).toBe(constants.NGHTTP2_CANCEL);
        expect(dispatchCount).toBe(0);
        expect(
          coreDb.sqlite
            .prepare('SELECT operation_state, operation_id FROM harness_instance_records')
            .get()
        ).toEqual({ operation_state: 'queued', operation_id: null });
        expect(
          coreDb.sqlite
            .prepare('SELECT worker_control_token_hash FROM scheduler_execution_attempts')
            .get()
        ).toEqual({ worker_control_token_hash: null });
        const next = await post('/worker-control/harness/poll', '{"schemaVersion":2}');
        expect(next.status).toBe(200);
        expect(JSON.parse(await next.text())).toMatchObject({
          operation: 'turn.start',
          sequence: 0,
        });
        expect(dispatchCount).toBe(1);
        return;
      }
      if (scenario === 'result-before-reset') {
        await expect(post('/worker-control/harness/poll', '{"schemaVersion":2}')).rejects.toThrow();
        await responseFailed.promise;
        expect(failedRequest?.stream.rstCode).toBe(constants.NGHTTP2_CANCEL);
        expect(failedResponse?.writableFinished).toBe(false);
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT operation_state, operation, next_sequence, drain_state FROM harness_instance_records'
            )
            .get()
        ).toEqual({
          operation_state: 'queued',
          operation: 'session.inspect',
          next_sequence: 1,
          drain_state: 'accepting',
        });
        // Release the deliberately zero DATA window before reading the successor's body.
        await new Promise<void>((resolve, reject) => {
          client!.settings({ initialWindowSize: 65_535 }, (error) =>
            error ? reject(error) : resolve()
          );
        });
        const next = await post('/worker-control/harness/poll', '{"schemaVersion":2}');
        expect(next.status).toBe(200);
        expect(JSON.parse(await next.text())).toMatchObject({
          operation: 'session.inspect',
          sequence: 1,
        });
        return;
      }
      transport.client = {
        ready: Promise.resolve(),
        close: async () => {},
        harnessControlFetch: async (path, init) => {
          if (shape === 'withhold-result' && path.endsWith('/result')) {
            resultEntered.resolve();
            return new Promise((_resolve, reject) =>
              init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              })
            );
          }
          const response = await post(path, init.body, init.signal);
          if (path.endsWith('/poll') && response.status === 204) {
            retried.resolve();
            stop.abort(new Error('Diagnostic gate complete.'));
          }
          return response;
        },
      } as SandboxIntegrationClient;
      const run = runWorkerHarness({ signal: stop.signal }).catch((error: unknown) => error);
      if (shape !== 'withhold-result') {
        await responseFailed.promise;
        await retried.promise;
      } else {
        await resultEntered.promise;
        stop.abort(new Error('Diagnostic gate complete.'));
      }
      if (shape === 'withhold-result') expect(await run).toBeInstanceOf(Error);
      else await run;
      expect(dispatchCount).toBe(1);
      expect(handle).toHaveBeenCalledTimes(shape === 'withhold-result' ? 1 : 0);
      const row = coreDb.sqlite
        .prepare('SELECT operation_state FROM harness_instance_records')
        .get();
      if (scenario !== 'timed-cancel-ended-command') {
        expect(row).toEqual({
          operation_state: shape === 'withhold-result' ? 'dispatched' : 'unknown',
        });
      }
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: 'worker.harness.dispatched',
          operationId,
          operation: 'turn.start',
        })
      );
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: 'worker.harness.response',
          operationId,
          outcome:
            shape === 'withhold-result' ? 'completed' : expect.stringMatching(/reset|aborted/),
        })
      );
      if (shape === 'cancel-ended-command') {
        if (scenario === 'timed-cancel-ended-command') {
          expect(lines.filter((line) => line.event === 'worker.harness.response')).toEqual([
            expect.objectContaining({ pollToDispatchMs: 750, pollToResponseMs: 1000 }),
          ]);
          expect(row).toEqual({ operation_state: 'unknown' });
        }
        expect(failedResponse?.writableEnded).toBe(true);
        expect(failedResponse?.writableFinished).toBe(false);
        expect(failedRequest?.stream.rstCode).toBe(constants.NGHTTP2_CANCEL);
        expect(lines.filter((line) => line.event === 'worker.harness.response')).toEqual([
          expect.objectContaining({
            outcome: expect.stringMatching(/reset|aborted/),
            resetCode: constants.NGHTTP2_CANCEL,
          }),
        ]);
        expect(failedResponse?.listenerCount('finish')).toBe(baselineListeners?.finish);
        expect(failedResponse?.listenerCount('close')).toBe(baselineListeners?.close);
        expect(failedRequest?.listenerCount('aborted')).toBe(baselineListeners?.aborted);
      }
      // A completed local write without a result still consumes the unchanged outage budget.
      if (shape === 'withhold-result') {
        markNanoHostHarnessOperationUnknown(coreDb, {
          harnessBindingRef: 'diag-harness-binding',
          operationId,
          timestamp: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      expect(
        coreDb.sqlite
          .prepare('SELECT operation_state, drain_state FROM harness_instance_records')
          .get()
      ).toEqual({ operation_state: 'unknown', drain_state: 'draining' });
      expect((await post('/worker-control/harness/poll', '{"schemaVersion":2}')).status).toBe(204);
      const values = log.mock.calls.map(([line]) => String(line)).join('\n');
      for (const token of rawTokens) expect(values).not.toContain(token);
      expect(rawTokens).toHaveLength(3);
    } finally {
      releasePoll.resolve();
      clock?.mockRestore();
      stop.abort();
      transport.client = null;
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
      handle.mockRestore();
      stdout.mockRestore();
      log.mockRestore();
    }
  });
});
