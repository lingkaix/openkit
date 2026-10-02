import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createNanoHostHarnessRuntime,
  queueNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  NANO_HOST_EFFECT_OPERATIONS,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';

describe('authoritative NanoHost session dispatch', () => {
  it('keeps current-epoch result-only cleanup pending after a live connection completed a poll', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-live-cleanup-poll-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = { deploymentId: 'live-cleanup', identityId: 'live-cleanup' };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      targetId: target.identityId,
      observedAt: new Date().toISOString(),
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    registerNanoHostSessionSemanticRoutes({ app, coreDb, dispatch, nanoHostConfig: target });
    registerNanoHostSessionEffectRoutes({ app, dispatch });
    const listener = getRequestListener(app.fetch);
    let physicalConnection: object | undefined;
    const server = createHttp2Server((request, response) => {
      if (!physicalConnection) {
        physicalConnection = readNanoHostPhysicalConnectionContext(request)!;
        authority.admit({
          connectionGeneration: 1,
          identityId: target.identityId,
          physicalConnection,
        });
      }
      void listener(request, response);
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing live cleanup test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      const post = async (path: string, body: unknown) => {
        const stream = client!.request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/json',
        });
        const response = once(stream, 'response');
        stream.end(JSON.stringify(body));
        const [headers] = await response;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        return { status: headers[':status'], body: Buffer.concat(chunks).toString() };
      };
      const readinessPath = '/api/nanohost/transport/session/readiness';
      const epoch = 'a'.repeat(64);
      expect((await post(readinessPath, { physicalEpoch: epoch })).status).toBe(204);
      expect(await post('/api/nanohost/transport/effects/sandbox.create', {})).toEqual({
        status: 204,
        body: '',
      });
      const retained = dispatch.expectResultOnly!([
        { kind: 'bridge.close', originPhysicalEpoch: epoch, requestId: 'b'.repeat(64) },
        { kind: 'sandbox.delete', originPhysicalEpoch: epoch, requestId: 'c'.repeat(64) },
      ]);
      let settled = false;
      void retained.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      // Repeated readiness on the same connection must not invent another first poll.
      expect((await post(readinessPath, { physicalEpoch: epoch })).status).toBe(204);
      expect(await post('/api/nanohost/transport/effects/sandbox.create', {})).toEqual({
        status: 204,
        body: '',
      });
      expect(await post('/api/nanohost/transport/effects/bridge.close', {})).toEqual({
        status: 204,
        body: '',
      });
      expect(settled).toBe(false);
      expect(authority.mayCarryWork(physicalConnection!)).toBe(true);
      expect(
        await post('/api/nanohost/transport/effects/bridge.close/result', {
          requestId: 'b'.repeat(64),
          state: 'deleted',
        })
      ).toEqual({ status: 204, body: '' });
      await expect(retained).resolves.toEqual({
        kind: 'bridge.close',
        result: { state: 'deleted' },
      });
      expect(authority.mayCarryWork(physicalConnection!)).toBe(true);
    } finally {
      client?.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });

  it('pairs every Rust effect route with empty idle polls and admits additive baseline results', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-collection-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = { deploymentId: 'collection', identityId: 'collection' };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      targetId: target.identityId,
      observedAt: new Date().toISOString(),
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    registerNanoHostSessionSemanticRoutes({ app, coreDb, dispatch, nanoHostConfig: target });
    registerNanoHostSessionEffectRoutes({ app, dispatch });
    const listener = getRequestListener(app.fetch);
    let admitted = false;
    let physicalConnection: object;
    const server = createHttp2Server((request, response) => {
      if (!admitted) {
        physicalConnection = readNanoHostPhysicalConnectionContext(request)!;
        authority.admit({
          connectionGeneration: 1,
          identityId: target.identityId,
          physicalConnection: readNanoHostPhysicalConnectionContext(request)!,
        });
        admitted = true;
      }
      void listener(request, response);
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing collection test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      const post = async (
        path: string,
        body: unknown,
        extraHeaders: Record<string, string> = {}
      ) => {
        const stream = client!.request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/json',
          ...extraHeaders,
        });
        const headers = once(stream, 'response');
        stream.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
        const [responseHeaders] = await headers;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        return { status: responseHeaders[':status'], body: Buffer.concat(chunks).toString() };
      };
      expect(
        (await post('/api/nanohost/transport/session/readiness', { physicalEpoch: 'e'.repeat(64) }))
          .status
      ).toBe(204);
      const rustSource = readFileSync(
        new URL('../../../nanohost/src/nanocore_session.rs', import.meta.url),
        'utf8'
      );
      const effectPaths = rustSource.match(/const EFFECT_PATHS:[\s\S]*?= \[([\s\S]*?)\n\];/)![1]!;
      const rustPaths = [
        ...effectPaths.matchAll(/"(\/api\/nanohost\/transport\/effects\/[^"]+)"/g),
      ].map((match) => match[1]!);
      expect(
        app.routes
          .filter((route) => route.path.startsWith('/api/nanohost/transport/effects/'))
          .map((route) => `${route.method} ${route.path}`)
          .sort()
      ).toEqual(rustPaths.map((path) => `POST ${path}`).sort());
      for (const path of rustPaths.filter((path) => !path.endsWith('/result'))) {
        expect(await post(path, {}), path).toEqual({ status: 204, body: '' });
      }
      const requestId = 'a'.repeat(64);
      const effect = dispatch.effect({
        kind: 'workspace.collect' as never,
        requestId,
        input: {
          storageRef: 'wst_collection',
          scopeDigest: `sha256:${'b'.repeat(64)}`,
          attachmentGeneration: 1,
          sandboxId: 'sandbox-collection',
          workSlot: 'slot-collection',
          collectionId: 'baseline-collection',
          mode: 'baseline',
          acceptedBase: null,
          previousHead: null,
          checkValues: { runtimeEnv: [], loopbackDigests: ['c'.repeat(64), 'd'.repeat(64)] },
        },
      });
      const settled = effect.catch((error: unknown) => error);
      const path = '/api/nanohost/transport/effects/workspace.collect';
      expect((await post(path, {})).status).toBe(200);
      const head = { tree: '1'.repeat(40), manifest: '2'.repeat(40) };
      expect(
        (await post(`${path}/result`, { requestId, outcome: 'baseline', head, future: 'ignored' }))
          .status
      ).toBe(204);
      expect(await settled).toEqual({ outcome: 'baseline', head });
      const captureInput = {
        storageRef: 'wst_collection',
        scopeDigest: `sha256:${'b'.repeat(64)}`,
        attachmentGeneration: 1,
        sandboxId: 'sandbox-collection',
        workSlot: 'slot-collection',
        collectionId: 'capture',
        mode: 'capture',
        acceptedBase: head,
        previousHead: head,
        checkValues: {
          runtimeEnv: ['private-value'],
          loopbackDigests: ['c'.repeat(64), 'd'.repeat(64)],
        },
      };
      let serial = 0;
      const queue = async (input: Record<string, unknown> = captureInput) => {
        const id = (++serial).toString(16).padStart(64, '0');
        const result = dispatch
          .effect({ kind: 'workspace.collect' as never, requestId: id, input })
          .catch((error: unknown) => error);
        const command = await post(path, {});
        expect(command.status).toBe(200);
        expect(JSON.parse(command.body).requestId).toBe(id);
        return { id, result };
      };
      const oversized = dispatch
        .effect({
          kind: 'workspace.collect',
          requestId: 'e'.repeat(64),
          input: {
            ...captureInput,
            checkValues: {
              runtimeEnv: Array(128).fill('x'.repeat(65536)),
              loopbackDigests: captureInput.checkValues.loopbackDigests,
            },
          },
        })
        .catch((error: unknown) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await post(path, {})).status).toBe(204);
      expect(await oversized).toMatchObject({
        message: 'Workspace collection command is too large.',
      });
      const invalidBaseline = await queue({
        ...captureInput,
        mode: 'baseline',
        acceptedBase: null,
        previousHead: null,
      });
      expect(
        (
          await post(
            `${path}/result`,
            `{"requestId":"${invalidBaseline.id}","outcome":"baseline","head":{"tree":"${head.tree}","tree":"${head.tree}","manifest":"${head.manifest}"}}`
          )
        ).status
      ).not.toBe(204);
      expect(await invalidBaseline.result).toBeInstanceOf(Error);
      const abandoned = await queue();
      const oldDelivery = dispatch.beginWorkspaceCollectionDelivery!(physicalConnection!);
      oldDelivery.abandon();
      expect(await abandoned.result).toBeInstanceOf(Error);
      const independent = await queue();
      oldDelivery.abandon();
      expect(
        (
          await post(`${path}/result`, {
            requestId: independent.id,
            outcome: 'no_new_head',
            unstable: false,
          })
        ).status
      ).toBe(204);
      expect(await independent.result).toEqual({ outcome: 'no_new_head', unstable: false });
      for (const resultBody of [
        { outcome: 'no_new_head', unstable: false },
        { outcome: 'credential_hit' },
        { outcome: 'effect_failed' },
        ...[
          'accepted_base_unknown',
          'previous_head_mismatch',
          'snapshot_unavailable',
          'malformed_manifest',
          'unsafe_path',
          'metadata_unavailable',
          'tree_manifest_disagreement',
          'check_values_unavailable',
          'command_too_large',
          'baseline_unstable',
          'baseline_mismatch',
          'baseline_source_unavailable',
        ].map((cause) => ({ outcome: 'recovery_required', cause })),
      ]) {
        const queued = await queue();
        expect(
          (await post(`${path}/result`, { requestId: queued.id, ...resultBody, future: true }))
            .status
        ).toBe(204);
        expect(await queued.result).toEqual(resultBody);
      }
      const additive = await queue();
      expect(
        (
          await post(
            `${path}/result`,
            `{"requestId":"${additive.id}","outcome":"no_new_head","unstable":false,"future":${'['.repeat(300)}'{safe}'${']'.repeat(300)}}`.replace(
              "'{safe}'",
              '"safe"'
            )
          )
        ).status
      ).toBe(204);
      expect(await additive.result).toEqual({ outcome: 'no_new_head', unstable: false });
      for (const malformed of [
        () => 'null',
        () => '[]',
        () => Buffer.from([0xff]),
        (id: string) =>
          `{"requestId":"${id}","outcome":"no_new_head","unstable":false,"outco\\u006de":"credential_hit"}`,
        (id: string) =>
          `{"requestId":"${id}","outcome":"empty","head":{"tree":"${head.tree}","tree":"${head.tree}","manifest":"${head.manifest}"},"previousHead":${JSON.stringify(head)},"acceptedBase":${JSON.stringify(head)},"unstable":false}`,
        (id: string) =>
          `{"requestId":"${id}","outcome":"no_new_head","unstable":false,"outcome":"credential_hit"}`,
        (id: string) => JSON.stringify({ requestId: id, outcome: 'unknown' }),
        (id: string) =>
          JSON.stringify({ requestId: id, outcome: 'recovery_required', cause: 'unknown' }),
        (_id: string) =>
          JSON.stringify({ requestId: 'f'.repeat(64), outcome: 'no_new_head', unstable: false }),
        (id: string) =>
          JSON.stringify({
            requestId: id,
            outcome: 'no_new_head',
            unstable: false,
            future: 'x'.repeat(512 * 1024),
          }),
      ]) {
        const queued = await queue();
        expect((await post(`${path}/result`, malformed(queued.id))).status).not.toBe(204);
        expect(await queued.result).toBeInstanceOf(Error);
        expect((await post(path, {})).status).toBe(204);
      }
      for (const changedHeaders of [
        { 'x-openkit-request-id': 'f'.repeat(64) },
        { 'x-openkit-head': `${head.tree} ${head.manifest}` },
        { 'x-openkit-head': `${'a'.repeat(64)} ${head.manifest}` },
        { 'x-openkit-previous-head': `${'9'.repeat(40)} ${head.manifest}` },
        { 'x-openkit-accepted-base': `${'9'.repeat(40)} ${head.manifest}` },
        { 'x-openkit-unstable': 'maybe' },
        { 'x-openkit-byte-length': '0' },
        { 'x-openkit-byte-length': String(256 * 1024 * 1024 + 1) },
        { 'x-openkit-sha256': `sha256:${'0'.repeat(64)}` },
      ]) {
        const queued = await queue();
        const bytes = Buffer.from('candidate');
        expect(
          (
            await post(`${path}/result`, bytes, {
              'content-type': 'application/octet-stream',
              'content-length': String(bytes.length),
              'x-openkit-request-id': queued.id,
              'x-openkit-head': `${'3'.repeat(40)} ${'4'.repeat(40)}`,
              'x-openkit-previous-head': `${head.tree} ${head.manifest}`,
              'x-openkit-accepted-base': `${head.tree} ${head.manifest}`,
              'x-openkit-unstable': 'false',
              'x-openkit-byte-length': String(bytes.length),
              'x-openkit-sha256': `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              ...changedHeaders,
            })
          ).status
        ).not.toBe(204);
        expect(await queued.result).toBeInstanceOf(Error);
        expect((await post(path, {})).status).toBe(204);
      }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const phased = await queue();
        await vi.advanceTimersByTimeAsync(119000);
        const phasedDelivery = dispatch.beginWorkspaceCollectionDelivery(physicalConnection!);
        await vi.advanceTimersByTimeAsync(2000);
        expect(phasedDelivery.signal?.aborted).toBe(false);
        expect(
          (
            await post(`${path}/result`, {
              requestId: phased.id,
              outcome: 'no_new_head',
              unstable: false,
            })
          ).status
        ).toBe(204);
        expect(await phased.result).toEqual({ outcome: 'no_new_head', unstable: false });
        const lost = await queue();
        let lostSettled = false;
        void lost.result.then(() => {
          lostSettled = true;
        });
        await vi.advanceTimersByTimeAsync(240000);
        expect(lostSettled).toBe(true);
        expect(await lost.result).toBeInstanceOf(Error);
        expect((await post(path, {})).status).toBe(204);
        const absolute = await queue();
        const absoluteDelivery = dispatch.beginWorkspaceCollectionDelivery(physicalConnection!);
        await vi.advanceTimersByTimeAsync(119000);
        dispatch.beginWorkspaceCollectionDelivery(physicalConnection!);
        await vi.advanceTimersByTimeAsync(1000);
        expect(absoluteDelivery.signal?.aborted).toBe(true);
        expect(await absolute.result).toBeInstanceOf(Error);
        const interrupted = await queue();
        dispatch.beginWorkspaceCollectionDelivery(physicalConnection!);
        const cancel = vi.fn();
        let markReading!: () => void;
        const reading = new Promise<void>((resolve) => {
          markReading = resolve;
        });
        let partialController!: ReadableStreamDefaultController<Uint8Array>;
        const partial = new ReadableStream<Uint8Array>({
          start(controller) {
            partialController = controller;
            controller.enqueue(Buffer.from('partial'));
          },
          pull() {
            markReading();
          },
          cancel,
        });
        const delivery = dispatch
          .workspaceCollectResult(
            physicalConnection!,
            new Request('http://local/result', {
              method: 'POST',
              body: partial,
              duplex: 'half',
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': '100',
                'x-openkit-request-id': interrupted.id,
                'x-openkit-head': `${'3'.repeat(40)} ${'4'.repeat(40)}`,
                'x-openkit-previous-head': `${head.tree} ${head.manifest}`,
                'x-openkit-accepted-base': `${head.tree} ${head.manifest}`,
                'x-openkit-unstable': 'false',
                'x-openkit-byte-length': '100',
                'x-openkit-sha256': `sha256:${'a'.repeat(64)}`,
              },
            } as RequestInit)
          )
          .catch((error: unknown) => error);
        // Consumption of the queued partial chunk proves staging has acquired its reader.
        await reading;
        await vi.advanceTimersByTimeAsync(120000);
        expect(await interrupted.result).toBeInstanceOf(Error);
        try {
          expect(cancel).toHaveBeenCalledOnce();
        } finally {
          try {
            partialController.close();
          } catch {}
        }
        expect(await delivery).toBeInstanceOf(Error);
        expect((await post(path, {})).status).toBe(204);
        const retry = await queue();
        expect(retry.id).not.toBe(lost.id);
        expect(
          (
            await post(`${path}/result`, {
              requestId: retry.id,
              outcome: 'no_new_head',
              unstable: false,
            })
          ).status
        ).toBe(204);
        expect(await retry.result).toEqual({ outcome: 'no_new_head', unstable: false });
      } finally {
        vi.useRealTimers();
      }
      const queued = await queue();
      const bytes = Buffer.from('immutable binary candidate');
      const changed = { tree: '3'.repeat(40), manifest: '4'.repeat(40) };
      expect(
        (
          await post(`${path}/result`, bytes, {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'x-openkit-request-id': queued.id,
            'x-openkit-head': `${changed.tree} ${changed.manifest}`,
            'x-openkit-previous-head': `${head.tree} ${head.manifest}`,
            'x-openkit-accepted-base': `${head.tree} ${head.manifest}`,
            'x-openkit-unstable': 'true',
            'x-openkit-byte-length': String(bytes.length),
            'x-openkit-sha256': `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          })
        ).status
      ).toBe(204);
      const candidate = (await queued.result) as {
        stagingPath: string;
        outcome: string;
        head: unknown;
      };
      expect(candidate.outcome).toBe('candidate');
      expect(candidate.head).toEqual(changed);
      expect(readFileSync(candidate.stagingPath)).toEqual(bytes);
      rmSync(join(candidate.stagingPath, '..'), { force: true, recursive: true });
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

  it('acknowledges a prior Harness result without notifying the queued successor producer', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-result-ack-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = { deploymentId: 'deployment-ack', identityId: 'host-ack' };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      targetId: target.identityId,
      observedAt: new Date().toISOString(),
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    const notify = vi.fn(() => {
      queueNanoHostHarnessOperation(coreDb, {
        body: {},
        harnessInstanceId: 'harness-ack',
        operation: 'harness.drain',
        timestamp: '2098-08-21T00:00:01.000Z',
      });
    });
    registerNanoHostSessionSemanticRoutes({
      app,
      coreDb,
      dispatch,
      harnessResultSettled: notify,
      nanoHostConfig: target,
    });
    const listener = getRequestListener(app.fetch);
    let admitted = false;
    const server = createHttp2Server((request, response) => {
      if (!admitted) {
        authority.admit({
          connectionGeneration: 1,
          identityId: target.identityId,
          physicalConnection: readNanoHostPhysicalConnectionContext(request)!,
        });
        admitted = true;
      }
      void listener(request, response);
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      /** Sends the real private request over the admitted native HTTP/2 connection. */
      const post = async (path: string, body: unknown) => {
        const stream = client!.request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/json',
          'x-openkit-integration-binding': 'integration-ack',
        });
        const headers = once(stream, 'response');
        stream.end(JSON.stringify(body));
        const [responseHeaders] = await headers;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        return { status: responseHeaders[':status'], body: Buffer.concat(chunks).toString() };
      };
      expect(
        await post('/api/nanohost/transport/session/readiness', { physicalEpoch: 'e'.repeat(64) })
      ).toEqual({ status: 204, body: '' });
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-ack',
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId: 'harness-ack',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: 'e'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-ack',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-ack',
        sandboxRuntimeId: 'sandbox-runtime-ack',
        runtimeTargetId: target.identityId,
        timestamp: '2098-08-21T00:00:00.000Z',
      });
      notify();
      notify.mockClear();
      const dispatched = await post('/worker-control/harness/poll', { schemaVersion: 2 });
      expect(dispatched.status).toBe(200);
      const command = JSON.parse(dispatched.body);
      const result = {
        schemaVersion: 2,
        harnessInstanceId: command.harnessInstanceId,
        operationId: command.operationId,
        sequence: command.sequence,
        disposition: 'succeeded',
        body: { state: 'draining', activeTurns: 0, openSessions: 0 },
      };
      expect(await post('/worker-control/harness/result', result)).toEqual({
        status: 204,
        body: '',
      });
      const queued = coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get();
      expect(queued).toMatchObject({ operation_state: 'queued', operation_sequence: 1 });
      expect(await post('/worker-control/harness/result', result)).toEqual({
        status: 204,
        body: '',
      });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get()).toEqual(queued);
      expect(
        (
          await post('/worker-control/harness/result', {
            ...result,
            body: { ...result.body, activeTurns: 1 },
          })
        ).status
      ).toBe(409);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get()).toEqual(queued);
      const next = await post('/worker-control/harness/poll', { schemaVersion: 2 });
      expect(next.status).toBe(200);
      const nextCommand = JSON.parse(next.body);
      expect(nextCommand.sequence).toBe(1);
      const successor = coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get();
      expect(successor).toMatchObject({ result_json: null, result_fingerprint: null });
      expect((await post('/worker-control/harness/result', result)).status).toBe(409);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get()).toEqual(
        successor
      );
      expect(
        await post('/worker-control/harness/result', {
          ...result,
          operationId: nextCommand.operationId,
          sequence: nextCommand.sequence,
        })
      ).toEqual({ status: 204, body: '' });
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

  it('defers image settlement on storage failure and acknowledges only durable outcomes', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-image-settlement-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = {
      coreDb,
      deploymentId: 'deployment-settlement',
      identityId: 'host-settlement',
      targetId: 'host-settlement',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-08-10T00:00:00.000Z',
    });
    let accept!: (connection: object) => void;
    const physicalReady = new Promise<object>((resolve) => {
      accept = resolve;
    });
    const server = createHttp2Server((request, response) => {
      const physical = readNanoHostPhysicalConnectionContext(request);
      if (physical) accept(physical);
      response.writeHead(204).end();
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      client.request({ ':method': 'POST', ':path': '/' }).end();
      const physical = await physicalReady;
      authority.admit({
        connectionGeneration: 1,
        identityId: target.identityId,
        physicalConnection: physical,
      });
      await expect(dispatch.readiness!(physical, Buffer.from('{}'), target)).rejects.toThrow(
        /physicalEpoch/i
      );
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      await expect(
        dispatch.readiness!(
          physical,
          Buffer.from(JSON.stringify({ physicalEpoch: 'b'.repeat(64) })),
          target
        )
      ).rejects.toThrow(/physical Epoch changed/i);
      const requestId = 'e'.repeat(64);
      const imageSettlement = {
        authoredArtifactId: 'artifact_settlement',
        authoredArtifactVersion: 1,
        authoredContentDigest: `sha256:${'a'.repeat(64)}`,
        inputDigest: `sha256:${'b'.repeat(64)}`,
      };
      const pending = dispatch.effect({
        kind: 'image.acquire',
        requestId,
        input: { imageReference: 'openkit:test' },
        imageSettlement,
      });
      void pending.catch(() => undefined);
      await expect(dispatch.poll(physical, 'image.acquire')).resolves.toEqual({
        imageReference: 'openkit:test',
        requestId,
      });
      coreDb.sqlite.exec('PRAGMA query_only = ON');
      const result = { requestId, digest: `sha256:${'c'.repeat(64)}` };
      await expect(dispatch.result(physical, 'image.acquire', result)).rejects.toMatchObject({
        status: 503,
      });
      await expect(pending).rejects.toMatchObject({ code: 'recovery_required' });
      expect(authority.mayCarryWork(physical)).toBe(true);
      coreDb.sqlite.exec('PRAGMA query_only = OFF');
      await dispatch.result(physical, 'image.acquire', result);
      const restarted = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
      await expect(restarted.result(physical, 'image.acquire', result)).resolves.toBeUndefined();
      await restarted.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      const replay = restarted.effect({
        kind: 'image.acquire',
        requestId,
        input: { imageReference: 'openkit:test' },
        imageSettlement,
      });
      await expect(restarted.poll(physical, 'image.acquire')).resolves.toBeNull();
      await expect(replay).resolves.toEqual({ digest: result.digest });

      await expect(
        restarted.expectResultOnly!([{ kind: 'image.acquire', requestId, imageSettlement }])
      ).resolves.toEqual({ kind: 'image.acquire', result: { digest: result.digest } });
      expect(() =>
        restarted.expectResultOnly!([
          {
            kind: 'bridge.close',
            originPhysicalEpoch: 'pre-witness',
            requestId: 'f'.repeat(64),
          },
          { kind: 'image.acquire', requestId, imageSettlement },
        ])
      ).toThrow(/one image group|one cleanup origin group/i);
      await expect(restarted.poll(physical, 'bridge.close')).resolves.toBeNull();
      await expect(
        restarted.result(physical, 'image.acquire', {
          ...result,
          digest: `sha256:${'d'.repeat(64)}`,
        })
      ).rejects.toMatchObject({ status: 409 });
      coreDb.sqlite
        .prepare('UPDATE worker_image_settlements SET image_digest = ? WHERE request_id = ?')
        .run('malformed-digest', requestId);
      await expect(restarted.result(physical, 'image.acquire', result)).rejects.toMatchObject({
        status: 409,
      });

      // A new dispatcher models another Core restart; this recovery has not completed a poll.
      const unresolvedRestart = createNanoHostSessionDispatch({
        coreDb,
        sessionAuthority: authority,
      });
      await unresolvedRestart.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      const unknownImageOutcome = unresolvedRestart.expectResultOnly!([
        {
          kind: 'image.build',
          imageSettlement,
          requestId: 'f'.repeat(64),
        },
      ]).catch((error: unknown) => error);
      await expect(unresolvedRestart.poll(physical, 'image.inspect')).rejects.toMatchObject({
        status: 409,
      });
      expect(authority.mayCarryWork(physical)).toBe(false);
      const unknownImageError = await unknownImageOutcome;
      expect(unknownImageError).toBeInstanceOf(Error);
      expect((unknownImageError as Error).message).toMatch(/unknown/i);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

  it('rejects caller-created connection identities before route or effect dispatch', async () => {
    const authority = createNanoHostTransportSessionAuthority();
    const retiredHandle = authority.admit({
      connectionGeneration: 1,
      identityId: 'nanohost-dispatch',
      predecessorGeneration: null,
    });
    const routeHandler = vi.fn(async () => ({ status: 200 }));
    const effectHandler = vi.fn(async () => ({
      evidence: { resultingImageDigest: 'sha256:image' },
      status: 'succeeded',
    }));
    const dispatch = createNanoHostSessionDispatch({
      effectHandler,
      routeHandler,
      sessionAuthority: authority,
    });
    const readiness = dispatch as unknown as {
      readiness(physicalConnection: object, body: Uint8Array): Promise<void>;
    };

    await expect(
      readiness.readiness(
        retiredHandle,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) }))
      )
    ).rejects.toThrow(/native|connection|authoritative|fenc/i);

    await expect(
      dispatch.route(retiredHandle as never, {
        body: new Uint8Array(),
        credentialClass: 'worker-control',
        family: 'worker-control',
        path: '/worker-control/heartbeat',
      })
    ).rejects.toThrow(/connection|authoritative|fenc/i);

    await expect(
      dispatch.effect(retiredHandle as never, {
        input: {
          kind: 'build',
          packageSnapshotId: 'aepsnap-dispatch',
          reference: 'workspace://build-context',
        },
        kind: 'attempt-image.acquire',
      })
    ).rejects.toThrow(/connection|authoritative|fenc/i);
    expect(routeHandler).not.toHaveBeenCalled();
    expect(effectHandler).not.toHaveBeenCalled();

    const dispatchSource = readFileSync(
      new URL('./nanohost-session-dispatch.ts', import.meta.url),
      'utf8'
    );
    expect(dispatchSource).toContain('requestId');
    for (const operation of [
      'sandbox.create',
      'sandbox.delete',
      'bridge.open',
      'bridge.close',
      'image.acquire',
      'image.build',
      'image.inspect',
      'storage.inspect',
      'storage.purge',
      'file.export',
      'reference.import',
    ]) {
      expect(dispatchSource).toContain(`/api/nanohost/transport/effects/${operation}`);
      expect(dispatchSource).toContain(`/api/nanohost/transport/effects/${operation}/result`);
    }
    expect(dispatchSource).not.toContain('attempt-session.cleanup');
    for (const wireRule of [
      'application/octet-stream',
      'x-openkit-request-id',
      'x-openkit-slot',
      'x-openkit-relative-path',
      'x-openkit-sha256',
      'x-openkit-byte-length',
      '409',
      '413',
    ]) {
      expect(dispatchSource).toContain(wireRule);
    }
    expect(dispatchSource).toMatch(/268435456|256\s*\*\s*1024\s*\*\s*1024/);
    expect(dispatchSource).toMatch(/65536|64\s*\*\s*1024/);
    expect(dispatchSource).toContain("operation === 'reference.import'");
    expect(dispatchSource).toContain("operation === 'file.export'");
    const bridgeOpen = dispatchSource
      .split("operation === 'bridge.open'")[1]
      ?.split("operation === 'bridge.close'")[0];
    expect(bridgeOpen).toBeDefined();
    expect(bridgeOpen).toContain('requireBridgeOpenCommand');
    expect(dispatchSource).toContain('sandboxIntegrationBindingRef');
    expect(dispatchSource).not.toContain('workerControlToken');
    expect(dispatchSource).not.toContain('workerInferenceToken');
    expect(bridgeOpen).toContain('accepted');
    expect(bridgeOpen).toContain('unknown');
    expect(bridgeOpen).toMatch(/delete|discard/);
    expect(dispatchSource).toContain('physicalConnection');
    expect(dispatchSource).toContain('/api/nanohost/transport/session/readiness');
    expect(dispatchSource).toContain('/worker-control/harness/poll');
    expect(dispatchSource).toContain('/worker-control/harness/result');
    expect(dispatchSource).toContain('x-openkit-integration-binding');
    expect(dispatchSource).toContain('upsertNanoHostRuntimeTarget');
    expect(dispatchSource).toContain('connectionGeneration');
    expect(dispatchSource).toContain('mayCarryWork');
    expect(dispatchSource).not.toContain('/api/nanohost/transport/file-data');
    const appSource = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
    expect(appSource).toContain('createNanoHostSessionDispatch({');
  });

  it('rejects one exact ordinary typed failure and acknowledges only its identical successor resend', async () => {
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ sessionAuthority: authority });
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-typed-effect-failure-')));
    applyMigrations(coreDb);
    const target = {
      coreDb,
      deploymentId: 'deployment-typed-failure',
      identityId: 'nanohost-typed-failure',
      targetId: 'nanohost-typed-failure',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-08-10T00:00:00.000Z',
    });

    let acceptConnection: ((physicalConnection: object) => void) | undefined;
    const server = createHttp2Server((request, response) => {
      const physicalConnection = readNanoHostPhysicalConnectionContext(request);
      if (physicalConnection) {
        acceptConnection?.(physicalConnection);
      }
      response.writeHead(204).end();
    });
    let firstClient: ReturnType<typeof connectHttp2> | undefined;
    let successorClient: ReturnType<typeof connectHttp2> | undefined;
    let thirdClient: ReturnType<typeof connectHttp2> | undefined;
    let fourthClient: ReturnType<typeof connectHttp2> | undefined;

    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Typed-failure test server did not expose an address.');
      }
      const origin = `http://127.0.0.1:${address.port}`;

      const firstPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      firstClient = connectHttp2(origin);
      await once(firstClient, 'connect');
      firstClient.request({ ':method': 'POST', ':path': '/' }).end();
      const firstPhysical = await firstPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 1,
          identityId: target.identityId,
          physicalConnection: firstPhysical,
        }).role
      ).toBe('authoritative');
      await dispatch.readiness?.(
        firstPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      const requestId = 'a'.repeat(64);
      const pending = dispatch.effect({
        input: { imageReference: 'openkit/worker:test' },
        kind: 'image.acquire',
        requestId,
      });
      const rejected = expect(pending).rejects.toThrow(/effect_failed|effect failed/i);
      await expect(dispatch.poll(firstPhysical, 'image.acquire')).resolves.toMatchObject({
        imageReference: 'openkit/worker:test',
        requestId,
      });
      await expect(
        dispatch.result(firstPhysical, 'image.acquire', { failureCode: 'effect_failed', requestId })
      ).resolves.toBeUndefined();
      await rejected;

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-08-10T00:00:01.000Z',
      });
      const successorPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      successorClient = connectHttp2(origin);
      await once(successorClient, 'connect');
      successorClient.request({ ':method': 'POST', ':path': '/' }).end();
      const successorPhysical = await successorPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 2,
          identityId: target.identityId,
          physicalConnection: successorPhysical,
        }).role
      ).toBe('candidate');
      await expect(
        dispatch.result(successorPhysical, 'image.acquire', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).rejects.toThrow(/authoritative|connection|candidate/i);
      authority.fencePredecessor(target.identityId, 1);
      await dispatch.readiness?.(
        successorPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      await expect(
        dispatch.result(successorPhysical, 'image.acquire', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).resolves.toBeUndefined();
      await expect(
        dispatch.result(successorPhysical, 'image.acquire', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).rejects.toThrow(/duplicate|retry|settled|pending/i);

      for (const conflicting of [
        { failureCode: 'effect_failed', requestId: 'b'.repeat(64) },
        { failureCode: 'other', requestId },
        { extra: true, failureCode: 'effect_failed', requestId },
      ]) {
        await expect(
          dispatch.result(successorPhysical, 'image.acquire', conflicting)
        ).rejects.toThrow();
      }
      await expect(
        dispatch.result(successorPhysical, 'image.build', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).rejects.toThrow(/operation|pending|match/i);

      const dockerfile = 'é'.repeat(965_971);
      const dockerfileDigest = `sha256:${createHash('sha256').update(dockerfile).digest('hex')}`;
      const buildRequestId = 'f'.repeat(64);
      const buildPromise = dispatch.effect({
        input: {
          arguments: { NODE_VERSION: '24.16.0' },
          argumentsDigest: `sha256:${'1'.repeat(64)}`,
          contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          contextRef: 'build-context://empty/v1',
          dockerfile,
          dockerfileDigest,
          egress: [{ host: 'registry.npmjs.org', port: 443 }],
          layerLimit: 128,
          outputLimitBytes: 21_474_836_480,
          timeLimitSeconds: 1800,
        },
        kind: 'image.build',
        requestId: buildRequestId,
      });
      const buildMetadata = await dispatch.poll(successorPhysical, 'image.build');
      expect(Buffer.byteLength(dockerfile)).toBe(1_931_942);
      expect(buildMetadata).toMatchObject({
        dockerfileByteLength: 1_931_942,
        dockerfileDigest,
        requestId: buildRequestId,
      });
      expect(buildMetadata).not.toHaveProperty('dockerfile');
      expect(Buffer.byteLength(JSON.stringify(buildMetadata))).toBeLessThanOrEqual(512 * 1024);
      await dispatch.result(successorPhysical, 'image.build', {
        digest: `sha256:${'f'.repeat(64)}`,
        requestId: buildRequestId,
      });
      await expect(buildPromise).resolves.toEqual({ digest: `sha256:${'f'.repeat(64)}` });

      const bridgeRequestId = 'c'.repeat(64);
      const bridgePromise = dispatch.effect({
        input: { sandboxIntegrationBindingRef: 'harness-binding-special' },
        kind: 'bridge.open',
        requestId: bridgeRequestId,
      });
      await expect(dispatch.poll(successorPhysical, 'bridge.open')).resolves.toEqual({
        sandboxIntegrationBindingRef: 'harness-binding-special',
        requestId: bridgeRequestId,
      });
      await expect(
        dispatch.result(successorPhysical, 'bridge.open', {
          accepted: true,
          integrationReady: true,
          requestId: bridgeRequestId,
          state: 'open',
        })
      ).resolves.toBeUndefined();
      await expect(bridgePromise).resolves.toEqual({
        accepted: true,
        integrationReady: true,
        state: 'open',
      });

      const pollOrder = [
        'sandbox.create',
        'sandbox.delete',
        'bridge.open',
        'bridge.close',
        'image.acquire',
        'image.build',
        'image.inspect',
        'storage.inspect',
        'storage.purge',
        'file.export',
        'reference.import',
        'workspace.collect',
      ] as const;
      expect(NANO_HOST_EFFECT_OPERATIONS).toEqual(pollOrder);

      const ephemeralRequests = [
        {
          input: { imageDigest: `sha256:${'a'.repeat(64)}` },
          kind: 'image.inspect' as const,
          requestId: '1'.repeat(64),
        },
        {
          input: { attachmentGeneration: 1, storageRef: 'wst_inspect' },
          kind: 'storage.inspect' as const,
          requestId: '2'.repeat(64),
        },
        {
          input: { attachmentGeneration: 1, storageRef: 'wst_purge' },
          kind: 'storage.purge' as const,
          requestId: '3'.repeat(64),
        },
      ];
      const ephemeralOutcomes = ephemeralRequests.map((request) =>
        dispatch.effect(request).then(
          () => null,
          (error: unknown) => error
        )
      );
      for (const request of ephemeralRequests) {
        await expect(dispatch.poll(successorPhysical, request.kind)).resolves.toMatchObject({
          requestId: request.requestId,
        });
      }

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-08-10T00:00:02.000Z',
      });
      const thirdPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      thirdClient = connectHttp2(origin);
      await once(thirdClient, 'connect');
      thirdClient.request({ ':method': 'POST', ':path': '/' }).end();
      const thirdPhysical = await thirdPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 3,
          identityId: target.identityId,
          physicalConnection: thirdPhysical,
        }).role
      ).toBe('candidate');
      authority.fencePredecessor(target.identityId, 2);
      await dispatch.readiness?.(
        thirdPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      for (const request of ephemeralRequests) {
        await expect(dispatch.poll(thirdPhysical, request.kind)).resolves.toBeNull();
      }
      for (const outcome of ephemeralOutcomes) {
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/unknown|connection replacement/i);
      }
      expect(authority.mayCarryWork(thirdPhysical)).toBe(true);

      const freshInspectRequestId = '4'.repeat(64);
      const freshInspect = dispatch.effect({
        input: { imageDigest: `sha256:${'a'.repeat(64)}` },
        kind: 'image.inspect',
        requestId: freshInspectRequestId,
      });
      await expect(dispatch.poll(thirdPhysical, 'image.inspect')).resolves.toMatchObject({
        requestId: freshInspectRequestId,
      });
      await dispatch.result(thirdPhysical, 'image.inspect', {
        digest: `sha256:${'a'.repeat(64)}`,
        requestId: freshInspectRequestId,
      });
      await expect(freshInspect).resolves.toEqual({ digest: `sha256:${'a'.repeat(64)}` });

      const specialRequests = [
        {
          input: {
            body: new Uint8Array(),
            byteLength: 0,
            relativePath: 'package.json',
            sandboxId: 'sandbox-special',
            sha256: `sha256:${'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}`,
            slot: 'package-config',
          },
          kind: 'reference.import' as const,
          requestId: 'd'.repeat(64),
        },
        {
          input: {
            maxByteLength: 268435456,
            presence: 'required',
            relativePath: 'transcript.jsonl',
            sandboxId: 'sandbox-special',
            slot: 'outputs',
          },
          kind: 'file.export' as const,
          requestId: 'e'.repeat(64),
        },
      ];
      for (const request of specialRequests) {
        void dispatch.effect(request);
        await dispatch.poll(thirdPhysical, request.kind);
        await expect(
          dispatch.result(thirdPhysical, request.kind, {
            failureCode: 'effect_failed',
            requestId: request.requestId,
          })
        ).rejects.toThrow(/special|sensitive|raw|failure|result/i);
      }

      expect(() =>
        dispatch.expectResultOnly!([
          {
            kind: 'bridge.close',
            originPhysicalEpoch: 'pre-witness',
            requestId: '5'.repeat(64),
          },
          {
            kind: 'sandbox.delete',
            originPhysicalEpoch: 'a'.repeat(64),
            requestId: '6'.repeat(64),
          },
        ])
      ).toThrow(/one image group|one cleanup origin group/i);

      const replacedCleanupOutcome = dispatch.expectResultOnly!([
        {
          kind: 'bridge.close',
          originPhysicalEpoch: 'pre-witness',
          requestId: '7'.repeat(64),
        },
        {
          kind: 'sandbox.delete',
          originPhysicalEpoch: 'pre-witness',
          requestId: '8'.repeat(64),
        },
      ]).catch((error: unknown) => error);
      await expect(dispatch.poll(thirdPhysical, 'sandbox.create')).resolves.toBeNull();
      const replacedCleanupError = await replacedCleanupOutcome;
      expect(replacedCleanupError).toBeInstanceOf(Error);
      expect((replacedCleanupError as Error).message).toMatch(/physical Epoch/i);
      expect(authority.mayCarryWork(thirdPhysical)).toBe(true);

      const unknownRequestId = '9'.repeat(64);
      const unknownOutcome = dispatch.expectResultOnly!([
        {
          kind: 'sandbox.delete',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: unknownRequestId,
        },
      ]).then(
        () => null,
        (error: unknown) => error
      );
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-08-10T00:00:03.000Z',
      });
      const fourthPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      fourthClient = connectHttp2(origin);
      await once(fourthClient, 'connect');
      fourthClient.request({ ':method': 'POST', ':path': '/' }).end();
      const fourthPhysical = await fourthPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 4,
          identityId: target.identityId,
          physicalConnection: fourthPhysical,
        }).role
      ).toBe('candidate');
      authority.fencePredecessor(target.identityId, 3);
      await dispatch.readiness?.(
        fourthPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      await expect(dispatch.poll(fourthPhysical, pollOrder[0])).rejects.toThrow(/unknown|fenc/i);
      const unknownError = await unknownOutcome;
      expect(unknownError).toBeInstanceOf(Error);
      expect((unknownError as Error).message).toMatch(/unknown/i);
      expect(authority.mayCarryWork(fourthPhysical)).toBe(false);
      await expect(dispatch.poll(fourthPhysical, pollOrder[1])).rejects.toThrow(
        /authoritative|fenc/i
      );
    } finally {
      firstClient?.destroy();
      successorClient?.destroy();
      thirdClient?.destroy();
      fourthClient?.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });

  it('settles prior accepted uncertainty once and preserves unaccepted work', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-create-cleanup-order-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ sessionAuthority: authority });
    const target = {
      coreDb,
      deploymentId: 'deployment-create-cleanup-order',
      identityId: 'nanohost-create-cleanup-order',
      targetId: 'nanohost-create-cleanup-order',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-09-11T06:12:00.000Z',
    });

    let acceptConnection: ((physicalConnection: object) => void) | undefined;
    const server = createHttp2Server((request, response) => {
      const physicalConnection = readNanoHostPhysicalConnectionContext(request);
      if (physicalConnection) acceptConnection?.(physicalConnection);
      response.writeHead(204).end();
    });
    let firstClient: ReturnType<typeof connectHttp2> | undefined;
    let successorClient: ReturnType<typeof connectHttp2> | undefined;
    let freshClient: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Create-cleanup test server did not expose an address.');
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const firstPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      firstClient = connectHttp2(origin);
      await once(firstClient, 'connect');
      firstClient.request({ ':method': 'POST', ':path': '/' }).end();
      const firstPhysical = await firstPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 1,
          identityId: target.identityId,
          physicalConnection: firstPhysical,
        }).role
      ).toBe('authoritative');
      await dispatch.readiness?.(
        firstPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      const createRequestId = '6'.repeat(64);
      let createSettled = false;
      const createOutcome = dispatch
        .effect({
          input: {
            backendSessionId: 'backend-create-cleanup-order',
            imageDigest: `sha256:${'a'.repeat(64)}`,
            leaseId: 'lease-create-cleanup-order',
            packageSnapshotId: 'aepsnap-create-cleanup-order',
            sandboxId: 'sandbox-create-cleanup-order',
          },
          kind: 'sandbox.create',
          requestId: createRequestId,
        })
        .then(
          () => null,
          (error: unknown) => error
        )
        .finally(() => {
          createSettled = true;
        });
      await expect(dispatch.poll(firstPhysical, 'sandbox.create')).resolves.toMatchObject({
        requestId: createRequestId,
      });

      const cleanupOutcome = dispatch.expectResultOnly!([
        {
          kind: 'bridge.close',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: '7'.repeat(64),
        },
        {
          kind: 'sandbox.delete',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: '8'.repeat(64),
        },
      ]).catch((error: unknown) => error);
      const queuedRequestId = '9'.repeat(64);
      const queuedOutcome = dispatch.effect({
        input: { imageReference: `sha256:${'b'.repeat(64)}` },
        kind: 'image.acquire',
        requestId: queuedRequestId,
      });
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T06:38:00.000Z',
      });
      const successorPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      successorClient = connectHttp2(origin);
      await once(successorClient, 'connect');
      successorClient.request({ ':method': 'POST', ':path': '/' }).end();
      const successorPhysical = await successorPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 2,
          identityId: target.identityId,
          physicalConnection: successorPhysical,
        }).role
      ).toBe('candidate');
      authority.fencePredecessor(target.identityId, 1);
      await dispatch.readiness?.(
        successorPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      await expect(dispatch.poll(successorPhysical, 'image.acquire')).rejects.toThrow(
        /unknown|fenc/i
      );
      await Promise.resolve();
      expect(createSettled).toBe(true);
      const createError = await createOutcome;
      expect(createError).toBeInstanceOf(Error);
      expect((createError as Error).message).toMatch(/unknown|connection replacement/i);
      const cleanupError = await cleanupOutcome;
      expect(cleanupError).toBeInstanceOf(Error);
      expect((cleanupError as Error).message).toMatch(/unknown/i);

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T06:39:00.000Z',
      });
      const freshPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      freshClient = connectHttp2(origin);
      await once(freshClient, 'connect');
      freshClient.request({ ':method': 'POST', ':path': '/' }).end();
      const freshPhysical = await freshPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 3,
          identityId: target.identityId,
          physicalConnection: freshPhysical,
        }).role
      ).toBe('authoritative');
      await dispatch.readiness?.(
        freshPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      await expect(dispatch.poll(freshPhysical, 'image.acquire')).resolves.toMatchObject({
        requestId: queuedRequestId,
      });
      await dispatch.result(freshPhysical, 'image.acquire', {
        digest: `sha256:${'b'.repeat(64)}`,
        requestId: queuedRequestId,
      });
      await expect(queuedOutcome).resolves.toEqual({ digest: `sha256:${'b'.repeat(64)}` });
      expect(authority.mayCarryWork(freshPhysical)).toBe(true);
    } finally {
      firstClient?.destroy();
      successorClient?.destroy();
      freshClient?.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });

  it('never delivers a queued effect to a different physical Epoch', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-effect-epoch-origin-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = {
      coreDb,
      deploymentId: 'deployment-effect-epoch-origin',
      identityId: 'nanohost-effect-epoch-origin',
      targetId: 'nanohost-effect-epoch-origin',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-09-11T00:00:00.000Z',
    });

    let acceptConnection: ((physicalConnection: object) => void) | undefined;
    const server = createHttp2Server((request, response) => {
      const physicalConnection = readNanoHostPhysicalConnectionContext(request);
      if (physicalConnection) acceptConnection?.(physicalConnection);
      response.writeHead(204).end();
    });
    const clients: ReturnType<typeof connectHttp2>[] = [];
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Effect Epoch test server did not expose an address.');
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const connect = async (generation: number): Promise<object> => {
        const physicalPromise = new Promise<object>((resolve) => {
          acceptConnection = resolve;
        });
        const client = connectHttp2(origin);
        clients.push(client);
        await once(client, 'connect');
        client.request({ ':method': 'POST', ':path': '/' }).end();
        const physical = await physicalPromise;
        authority.admit({
          connectionGeneration: generation,
          identityId: target.identityId,
          physicalConnection: physical,
        });
        if (generation > 1) authority.fencePredecessor(target.identityId, generation - 1);
        return physical;
      };

      const firstPhysical = await connect(1);
      await dispatch.readiness?.(
        firstPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      const staleRequestId = '1'.repeat(64);
      const staleOutcome = dispatch.effect({
        input: { imageDigest: `sha256:${'1'.repeat(64)}` },
        kind: 'image.inspect',
        requestId: staleRequestId,
      });
      void staleOutcome.catch(() => undefined);

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T00:00:01.000Z',
      });
      await expect(dispatch.poll(firstPhysical, 'image.inspect')).rejects.toThrow(
        /current physical Epoch authority/i
      );
      const secondPhysical = await connect(2);
      await dispatch.readiness?.(
        secondPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'b'.repeat(64) })),
        target
      );
      await expect(dispatch.poll(secondPhysical, 'image.inspect')).resolves.toBeNull();
      await expect(staleOutcome).rejects.toThrow(/physical Epoch|origin/i);

      const reconnectRequestId = '2'.repeat(64);
      const reconnectOutcome = dispatch.effect({
        input: { imageDigest: `sha256:${'2'.repeat(64)}` },
        kind: 'image.inspect',
        requestId: reconnectRequestId,
      });
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T00:00:02.000Z',
      });
      const thirdPhysical = await connect(3);
      await dispatch.readiness?.(
        thirdPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'b'.repeat(64) })),
        target
      );
      await expect(dispatch.poll(thirdPhysical, 'image.inspect')).resolves.toMatchObject({
        requestId: reconnectRequestId,
      });
      await dispatch.result(thirdPhysical, 'image.inspect', {
        digest: `sha256:${'2'.repeat(64)}`,
        requestId: reconnectRequestId,
      });
      await expect(reconnectOutcome).resolves.toEqual({ digest: `sha256:${'2'.repeat(64)}` });
    } finally {
      for (const client of clients) client.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });
});
