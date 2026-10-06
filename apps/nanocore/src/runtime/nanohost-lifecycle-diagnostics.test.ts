import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { connect, constants, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { runWorkerHarness, WorkerHarness } from '../../../../packages/worker-shim/src/harness.js';
import type { SandboxIntegrationClient } from '../../../../packages/worker-shim/src/integration-client.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createNanoHostHarnessRuntime,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';

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
    'cancel-command',
    'cancel-ended-command',
    'withhold-result',
  ] as const)('distinguishes %s without redelivery or invented result certainty', async (shape) => {
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
    const committed = gate();
    const resultEntered = gate();
    const retried = gate();
    const responseFailed = gate();
    let operationId = '';
    let rawTokens: string[] = [];
    let dispatchCount = 0;
    registerNanoHostSessionSemanticRoutes({
      app,
      coreDb,
      dispatch,
      nanoHostConfig: target,
      harnessCommandDispatched: (command) => {
        dispatchCount += 1;
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
    let holdCommand = shape !== 'withhold-result';
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
          const [received] = await headers;
          if (
            shape === 'cancel-ended-command' &&
            path.endsWith('/poll') &&
            received[':status'] === 200
          ) {
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
      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at, heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch, sandbox_binding_ref, backend_anchor_state) VALUES ('diag-lease', 'diag-plan', 'diag-workspace', 'diag-thread', 'diag-turn', 'diag-session', 'diag-package', 'diag-pool', 'diag', 'acquired', ?, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 0, 1, 'diag-turn-binding', 'anchored')`
        )
        .run(now);
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
      expect(row).toEqual({ operation_state: 'dispatched' });
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
      // Existing unknown/fence owner, invoked by the producer after its unchanged outage bound.
      markNanoHostHarnessOperationUnknown(coreDb, {
        harnessBindingRef: 'diag-harness-binding',
        operationId,
        timestamp: new Date(Date.now() + 300_000).toISOString(),
      });
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
