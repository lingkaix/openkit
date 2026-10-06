import { readFileSync } from 'node:fs';
import { request as requestHttp } from 'node:http';
import {
  createServer as createHttp2Server,
  constants as http2Constants,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from 'node:http2';
import { connect as connectSocket } from 'node:net';

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { WORKER_ADAPTERS } from './adapter-registry.js';
import {
  openSandboxIntegration,
  SANDBOX_INTEGRATION_ROUTE_NAMESPACES,
  SANDBOX_INTEGRATION_TARGET,
  SANDBOX_NATIVE_INFERENCE_TARGET,
} from './integration-client.js';

describe('Sandbox Integration', () => {
  it.each([
    'complete',
    'incomplete',
  ] as const)('rejects a post-header abort with a %s Harness body', async (bodyState) => {
    const bridge = createHttp2Server();
    let bridgeSession: ServerHttp2Session | undefined;
    bridge.on('session', (session) => {
      bridgeSession = session;
    });
    const commandBody = '{"schemaVersion":2,"operation":"harness.drain"}';
    bridge.on('stream', (stream) => {
      stream.on('error', () => undefined);
      stream.resume();
      stream.once('end', () => {
        stream.respond({ ':status': 200, 'content-length': Buffer.byteLength(commandBody) });
        if (bodyState === 'complete') stream.end(commandBody);
        else stream.write(commandBody.slice(0, 10));
      });
    });
    const integration = await openSandboxIntegration();
    const target = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
    const socket = connectSocket(Number(target.port), target.hostname);
    socket.on('error', () => undefined);
    bridge.emit('connection', socket);
    const abort = new AbortController();
    const request = integration.request.bind(integration);
    const injected = vi.spyOn(integration, 'request').mockImplementation(async (...args) => {
      const response = await request(...args);
      // Headers have arrived; inject at actual complete-body EOF or before collecting the incomplete body.
      if (bodyState === 'complete')
        response.body.once('end', () => abort.abort(new Error('abandoned exchange')));
      else abort.abort(new Error('abandoned exchange'));
      return response;
    });
    try {
      await integration.ready;
      await expect(
        integration.harnessControlFetch('/worker-control/harness/poll', {
          body: '{"schemaVersion":2}',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          signal: abort.signal,
        })
      ).rejects.toThrow();
      expect(abort.signal.aborted).toBe(true);
    } finally {
      injected.mockRestore();
      await integration.close();
      bridgeSession?.destroy();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });

  it.each([
    { mapped: true, compressed: false },
    { mapped: true, compressed: true },
    { mapped: false, compressed: false },
    { mapped: false, compressed: true },
  ])('normalizes only the bound adapter mapping: %j', async ({ mapped, compressed }) => {
    const canonical = JSON.stringify({
      request_kind: 'turn',
      session_id: 'native-session',
      thread_id: 'native-thread',
    });
    const nativeBody = {
      input: 'Hello',
      model: 'worker-model',
      prompt_cache_key: 'private-cache',
      client_metadata: {
        session_id: 'native-session',
        thread_id: 'native-thread',
        'x-codex-turn-metadata': canonical,
      },
      ...(!mapped
        ? {
            openkit_runtime_hint: {
              runtimeFamily: 'codex',
              nativeSessionId: 'forged',
              nativeThreadId: 'forged',
            },
          }
        : {}),
    };
    const expectedHint = {
      runtimeFamily: 'codex',
      nativeSessionId: 'native-session',
      nativeThreadId: 'native-thread',
      nativeCacheLineageId: 'private-cache',
    };
    const requests: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
    const bridge = createHttp2Server();
    let bridgeSession: ServerHttp2Session | undefined;
    bridge.on('session', (session) => {
      bridgeSession = session;
    });
    bridge.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const encoded = Buffer.concat(chunks);
        const decoded =
          headers['content-encoding'] === 'zstd' ? zstdDecompressSync(encoded) : encoded;
        requests.push({ headers, body: JSON.parse(decoded.toString('utf8')) });
        stream.respond({ ':status': 200 });
        stream.end('{}');
      });
    });
    const integration = await openSandboxIntegration();
    const supervisorSocket = connectSocket(17891, '127.0.0.1');
    bridge.emit('connection', supervisorSocket);
    try {
      await integration.ready;
      integration.registerSessionLoopback('as-mapping', {
        capabilityCredential: 'C'.repeat(43),
        inferenceCredential: 'I'.repeat(43),
        ...(mapped
          ? { inferenceRuntimeHintMapping: WORKER_ADAPTERS.codex?.inferenceRuntimeHintMapping }
          : {}),
      });
      integration.bindTurnRouteTokens('as-mapping', {
        capabilityToken: 'capability',
        controlToken: 'control',
        inferenceToken: 'inference',
      });
      const encoded = Buffer.from(JSON.stringify(nativeBody));
      const body = compressed ? zstdCompressSync(encoded) : encoded;
      const status = await new Promise<number>((resolve, reject) => {
        const request = requestHttp(
          {
            host: '127.0.0.1',
            port: 17892,
            method: 'POST',
            path: '/inference/v1/responses',
            headers: {
              authorization: `Bearer ${'I'.repeat(43)}`,
              'content-type': 'application/json',
              'content-length': String(body.length),
              ...(compressed ? { 'content-encoding': 'zstd' } : {}),
              'session-id': 'native-session',
              'thread-id': 'native-thread',
              'x-client-request-id': 'native-thread',
              'x-codex-turn-metadata': canonical,
            },
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          }
        );
        request.on('error', reject);
        request.end(body);
      });
      expect(status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe('Bearer inference');
      if (mapped) {
        expect(requests[0]?.body).toEqual({
          input: 'Hello',
          model: 'worker-model',
          openkit_runtime_hint: expectedHint,
        });
        for (const name of [
          'x-codex-turn-metadata',
          'session-id',
          'thread-id',
          'x-client-request-id',
        ]) {
          expect(requests[0]?.headers[name]).toBeUndefined();
        }
      } else {
        expect(requests[0]?.body.openkit_runtime_hint).toBeUndefined();
      }
    } finally {
      integration.close();
      bridgeSession?.destroy();
      supervisorSocket.destroy();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });

  it('applies backpressure to H2 request and native response bodies', () => {
    const production = readFileSync(new URL('./integration-client.ts', import.meta.url), 'utf8');
    const limits = production
      .split('const INTEGRATION_READY_TIMEOUT_MS')
      .at(1)
      ?.split('const FORBIDDEN_REQUEST_HEADERS')
      .at(0);
    expect(limits?.match(/const MAX_HTTP2_WRITE_BYTES = 64 \* 1024;/g)).toHaveLength(1);

    const responseOwner = production
      .split('async function responseForStream(')
      .at(1)
      ?.split('/** Writes one bounded H2 request')
      .at(0);
    expect(responseOwner).toBeDefined();
    const writeCall = responseOwner?.indexOf('await writeRequestBody(stream, body, signal)') ?? -1;
    const responseReturn = responseOwner?.indexOf('return await response') ?? -1;
    expect(writeCall).toBeGreaterThanOrEqual(0);
    expect(responseReturn).toBeGreaterThan(writeCall);
    expect(responseOwner?.match(/await writeRequestBody\(stream, body, signal\)/g)).toHaveLength(1);
    expect(responseOwner).not.toContain('stream.end(body)');

    const writeOwner = production
      .split('async function writeRequestBody(')
      .at(1)
      ?.split('/** Waits for H2 request capacity')
      .at(0);
    expect(writeOwner).toBeDefined();
    const fixedStep = writeOwner?.indexOf('offset += MAX_HTTP2_WRITE_BYTES') ?? -1;
    const fixedSlice =
      writeOwner?.indexOf('bytes.subarray(offset, offset + MAX_HTTP2_WRITE_BYTES)') ?? -1;
    const backpressure = writeOwner?.indexOf('if (!stream.write(bytes.subarray(') ?? -1;
    const drain = writeOwner?.indexOf('await waitForHttp2Drain(stream, signal)') ?? -1;
    expect(fixedStep).toBeGreaterThanOrEqual(0);
    expect(fixedSlice).toBeGreaterThan(fixedStep);
    expect(backpressure).toBeGreaterThanOrEqual(0);
    expect(drain).toBeGreaterThan(backpressure);
    expect(writeOwner?.match(/await waitForHttp2Drain\(stream, signal\)/g)).toHaveLength(1);
    expect(writeOwner).toContain('stream.end();');
    expect(writeOwner).not.toContain('stream.end(body)');

    const nativeResponseOwner = production
      .split('private async handleNativeRoute(')
      .at(1)
      ?.split('/** Closes both listeners')
      .at(0);
    expect(nativeResponseOwner).toBeDefined();
    const nativeWrite = nativeResponseOwner?.indexOf('if (!response.write(chunk))') ?? -1;
    const nativeDrain =
      nativeResponseOwner?.indexOf("await once(response, 'drain', { signal: abort.signal })") ?? -1;
    const nativeEnd = nativeResponseOwner?.indexOf('response.end()') ?? -1;
    expect(nativeWrite).toBeGreaterThanOrEqual(0);
    expect(nativeDrain).toBeGreaterThan(nativeWrite);
    expect(nativeEnd).toBeGreaterThan(nativeDrain);
    expect(nativeResponseOwner?.match(/if \(!response\.write\(chunk\)\)/g)).toHaveLength(1);
    expect(nativeResponseOwner?.match(/response\.write\(chunk\)/g)).toHaveLength(1);
    expect(
      nativeResponseOwner?.match(/await once\(response, 'drain', \{ signal: abort\.signal \}\)/g)
    ).toHaveLength(1);
    expect(nativeResponseOwner?.match(/once\(response, 'drain'/g)).toHaveLength(1);
  });

  it('owns one fixed loopback target and exactly three H2 route namespaces', () => {
    expect(SANDBOX_INTEGRATION_TARGET).toMatch(/^127[.]0[.]0[.]1:[1-9][0-9]*$/);
    expect(SANDBOX_INTEGRATION_ROUTE_NAMESPACES).toEqual([
      '/worker-control/',
      '/inference/',
      '/capabilities/',
    ]);
    expect(SANDBOX_NATIVE_INFERENCE_TARGET).toBe('127.0.0.1:17892');
    expect(openSandboxIntegration).toBeTypeOf('function');
  });

  it('carries only bounded credential-separated origin-form requests on one accepted H2 socket', async () => {
    const capabilityToken = 'capability-token';
    const controlToken = 'control-token';
    const inferenceToken = 'inference-token';
    const requests: Array<{ authorization: string | undefined; path: string }> = [];
    const bridge = createHttp2Server();
    let bridgeSession: ServerHttp2Session | undefined;
    let releaseAbort: (() => void) | undefined;
    const abortObserved = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    bridge.on('session', (session) => {
      bridgeSession = session;
    });
    bridge.on('stream', (stream: ServerHttp2Stream, headers) => {
      const path = String(headers[':path']);
      requests.push({ authorization: String(headers.authorization), path });
      stream.on('error', () => undefined);
      stream.resume();
      if (path === '/inference/slow') {
        stream.once('aborted', () => releaseAbort?.());
        stream.respond({ ':status': 200 });
        return;
      }
      stream.once('end', () => {
        if (path === '/worker-control/close-before-headers') {
          stream.close(http2Constants.NGHTTP2_NO_ERROR);
          return;
        }
        if (path === '/worker-control/reset') {
          stream.close(http2Constants.NGHTTP2_INTERNAL_ERROR);
          return;
        }
        if (path === '/worker-control/reset-after-headers') {
          stream.respond({ ':status': 200 });
          stream.write('partial');
          stream.close(http2Constants.NGHTTP2_INTERNAL_ERROR);
          return;
        }
        stream.respond({ ':status': 200 });
        stream.end(
          path === '/worker-control/oversized-response'
            ? Buffer.alloc(1024 * 1024 + 1)
            : Buffer.from(path)
        );
      });
    });

    const integration = await openSandboxIntegration();
    const target = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
    const socket = connectSocket(Number(target.port), target.hostname);
    socket.on('error', () => undefined);
    bridge.emit('connection', socket);

    try {
      await integration.ready;

      const harnessPoll = await integration.harnessControlFetch('/worker-control/harness/poll', {
        body: '{"schemaVersion":2,"nextExpectedSequence":0}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(await harnessPoll.text()).toBe('/worker-control/harness/poll');
      expect(requests.at(-1)).toEqual({
        authorization: 'undefined',
        path: '/worker-control/harness/poll',
      });
      await expect(
        integration.harnessControlFetch('/worker-control/heartbeat', {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).rejects.toThrow('private Harness route');
      await expect(
        integration.harnessControlFetch('/worker-control/harness/result', {
          body: '{}',
          headers: { authorization: 'Bearer forbidden' },
          method: 'POST',
        })
      ).rejects.toThrow('credential-free');
      integration.registerSessionLoopback('as_route', {
        capabilityCredential: 'c'.repeat(43),
        inferenceCredential: 'i'.repeat(43),
      });
      integration.bindTurnRouteTokens('as_route', {
        capabilityToken,
        controlToken,
        inferenceToken,
      });

      const control = await integration.workerControlFetch('/worker-control/heartbeat', {
        body: '{}',
        headers: { authorization: `Bearer ${controlToken}` },
        method: 'POST',
      });
      expect(await control.text()).toBe('/worker-control/heartbeat');
      const inference = await integration.request('/inference/v1/responses', {
        body: '{}',
        headers: { authorization: `Bearer ${inferenceToken}` },
        method: 'POST',
      });
      let inferenceBody = '';
      for await (const chunk of inference.body) {
        inferenceBody += Buffer.from(chunk).toString('utf8');
      }
      expect(inferenceBody).toBe('/inference/v1/responses');
      const capability = await integration.request('/capabilities/mcp/echo', {
        body: '{}',
        headers: { authorization: `Bearer ${capabilityToken}` },
        method: 'POST',
      });
      let capabilityBody = '';
      for await (const chunk of capability.body) {
        capabilityBody += Buffer.from(chunk).toString('utf8');
      }
      expect(capabilityBody).toBe('/capabilities/mcp/echo');
      const aggregateInference = await integration.request('/inference/v1/responses', {
        body: Buffer.alloc(2 * 1024 * 1024 + 1),
        headers: { authorization: `Bearer ${inferenceToken}` },
        method: 'POST',
      });
      let aggregateInferenceBody = '';
      for await (const chunk of aggregateInference.body) {
        aggregateInferenceBody += Buffer.from(chunk).toString('utf8');
      }
      expect(aggregateInferenceBody).toBe('/inference/v1/responses');
      expect(requests).toEqual([
        { authorization: 'undefined', path: '/worker-control/harness/poll' },
        { authorization: `Bearer ${controlToken}`, path: '/worker-control/heartbeat' },
        { authorization: `Bearer ${inferenceToken}`, path: '/inference/v1/responses' },
        { authorization: `Bearer ${capabilityToken}`, path: '/capabilities/mcp/echo' },
        { authorization: `Bearer ${inferenceToken}`, path: '/inference/v1/responses' },
      ]);

      integration.clearTurnRouteTokens('as_route');
      await expect(
        integration.workerControlFetch('/worker-control/heartbeat', {
          body: '{}',
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('not bound');
      integration.bindTurnRouteTokens('as_route', {
        capabilityToken,
        controlToken,
        inferenceToken,
      });

      const rejectedBeforeStream = requests.length;
      await expect(
        integration.request('/worker-control/heartbeat', {
          headers: { authorization: `Bearer ${inferenceToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('route token');
      await expect(
        integration.request('/inference/v1/responses', {
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('route token');
      await expect(
        integration.request('/capabilities/mcp/echo', {
          headers: { authorization: `Bearer ${inferenceToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('route token');
      for (const path of ['/fourth/route', 'https://nanocore.local/worker-control/heartbeat']) {
        await expect(
          integration.request(path, {
            headers: { authorization: `Bearer ${controlToken}` },
            method: 'POST',
          })
        ).rejects.toThrow();
      }
      await expect(
        integration.request('/worker-control/heartbeat', {
          body: Buffer.alloc(1024 * 1024 + 1),
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('byte bound');
      await expect(
        integration.request('/inference/v1/responses', {
          body: Buffer.alloc(16 * 1024 * 1024 + 1),
          headers: { authorization: `Bearer ${inferenceToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('byte bound');
      expect(requests).toHaveLength(rejectedBeforeStream);
      await expect(
        integration.workerControlFetch('/worker-control/oversized-response', {
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'GET',
        })
      ).rejects.toThrow('response exceeds');

      const abort = new AbortController();
      await integration.request('/inference/slow', {
        headers: { authorization: `Bearer ${inferenceToken}` },
        method: 'POST',
        signal: abort.signal,
      });
      abort.abort();
      await abortObserved;

      await expect(
        integration.workerControlFetch('/worker-control/reset', {
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
      ).rejects.toBeInstanceOf(TypeError);
      const closedBeforeHeaders = integration
        .workerControlFetch('/worker-control/close-before-headers', {
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
        .then(
          () => 'resolved',
          () => 'rejected'
        );
      await expect(
        Promise.race([
          closedBeforeHeaders,
          new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
        ])
      ).resolves.toBe('rejected');
      expect.soft(bridgeSession?.remoteSettings.initialWindowSize).toBe(256 * 1024);
      expect.soft(bridgeSession?.state.remoteWindowSize).toBe(5 * 1024 * 1024);
      await expect(
        integration.workerControlFetch('/worker-control/reset-after-headers', {
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      await integration.close();
      await socketClosed;
      bridgeSession?.destroy();
    }

    await expect(
      new Promise((resolve, reject) => {
        const rejected = connectSocket(Number(target.port), target.hostname);
        rejected.once('connect', () => {
          rejected.destroy();
          reject(new Error('closed Integration listener accepted another socket'));
        });
        rejected.once('error', resolve);
      })
    ).resolves.toBeDefined();
  });

  it('relays only bounded authenticated native inference and MCP over the ready H2 session', async () => {
    const capabilityToken = 'native-capability-token';
    const controlToken = 'native-control-token';
    const inferenceToken = 'native-inference-token';
    const capabilityCredential = 'C'.repeat(43);
    const inferenceCredential = 'I'.repeat(43);
    const requests: Array<{
      authorization: string | undefined;
      bodyBytes: number;
      contentEncoding: string | undefined;
      customHeader: string | undefined;
      path: string;
    }> = [];
    const h2DataChunkBytes: number[] = [];
    let cancelAborts = 0;
    let releaseSseEnd: (() => void) | undefined;
    const sseEndBarrier = new Promise<void>((resolve) => {
      releaseSseEnd = resolve;
    });
    let resolveCancel: ((rstCode: number) => void) | undefined;
    const cancelObserved = new Promise<number>((resolve) => {
      resolveCancel = resolve;
    });
    const bridge = createHttp2Server();
    let bridgeSession: ServerHttp2Session | undefined;
    let sessionCount = 0;
    bridge.on('session', (session) => {
      bridgeSession = session;
      sessionCount += 1;
    });
    bridge.on('stream', (stream: ServerHttp2Stream, headers) => {
      const path = String(headers[':path']);
      let bodyBytes = 0;
      stream.on('error', () => undefined);
      stream.on('data', (chunk: Uint8Array) => {
        bodyBytes += chunk.byteLength;
        h2DataChunkBytes.push(chunk.byteLength);
      });
      stream.once('aborted', () => {
        if (path === '/inference/v1/responses?cancel=1') {
          cancelAborts += 1;
        }
      });
      stream.once('end', () => {
        requests.push({
          authorization: String(headers.authorization),
          bodyBytes,
          contentEncoding: String(headers['content-encoding']),
          customHeader: String(headers['x-openkit-native']),
          path,
        });
        if (path === '/inference/v1/responses?stream=1') {
          stream.respond({
            ':status': 200,
            'content-encoding': 'identity',
            'content-type': 'text/event-stream',
            'x-openkit-relay': 'stream-canary',
          });
          stream.write('data: {"delta":"first"}\n\n');
          void sseEndBarrier.then(() => stream.end('data: {"done":true}\n\n'));
          return;
        }
        if (path === '/inference/v1/responses?cancel=1') {
          stream.once('close', () => resolveCancel?.(stream.rstCode));
          stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
          stream.write('data: {"delta":"cancel"}\n\n');
          return;
        }
        stream.respond({
          ':status': 202,
          'content-type': 'application/json',
          'x-openkit-relay': 'same-h2-session',
        });
        stream.write('{"accepted":');
        stream.end('true}');
      });
    });

    const integration = await openSandboxIntegration();
    const integrationTarget = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
    const nativeTarget = new URL('http://127.0.0.1:17892');
    let supervisorSocket: ReturnType<typeof connectSocket> | undefined;
    const nativeRequest = async (
      target: URL,
      input: {
        authorization: string;
        body?: string | Uint8Array;
        headers?: Record<string, string>;
        method: string;
        path: string;
      }
    ): Promise<{
      body: string;
      headers: NodeJS.Dict<string | string[]>;
      status: number;
    }> =>
      await new Promise((resolve, reject) => {
        let requestFinished = false;
        let responseResult:
          | {
              body: string;
              headers: NodeJS.Dict<string | string[]>;
              status: number;
            }
          | undefined;
        const settle = () => {
          if (requestFinished && responseResult) {
            resolve(responseResult);
          }
        };
        const request = requestHttp(
          {
            headers: {
              authorization: input.authorization,
              'content-type': 'application/json',
              ...input.headers,
            },
            host: target.hostname,
            method: input.method,
            path: input.path,
            port: Number(target.port),
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
            response.once('end', () => {
              responseResult = {
                body: Buffer.concat(chunks).toString('utf8'),
                headers: response.headers,
                status: response.statusCode ?? 0,
              };
              settle();
            });
          }
        );
        request.once('finish', () => {
          requestFinished = true;
          settle();
        });
        request.once('error', reject);
        request.end(input.body);
      });

    try {
      integration.registerSessionLoopback('as_native', {
        capabilityCredential,
        inferenceCredential,
      });
      integration.bindTurnRouteTokens('as_native', {
        capabilityToken,
        controlToken,
        inferenceToken,
      });
      const unavailable = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${inferenceCredential}`,
        body: Buffer.alloc(16 * 1024 * 1024),
        method: 'POST',
        path: '/inference/v1/responses',
      }).then(
        (response) => ({ response }),
        (error: unknown) => ({ error })
      );
      expect(requests).toEqual([]);
      expect(sessionCount).toBe(0);

      supervisorSocket = connectSocket(Number(integrationTarget.port), integrationTarget.hostname);
      supervisorSocket.on('error', () => undefined);
      bridge.emit('connection', supervisorSocket);
      await integration.ready;

      const exactLimit = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${inferenceCredential}`,
        body: Buffer.alloc(16 * 1024 * 1024),
        method: 'POST',
        path: '/inference/v1/responses',
      });
      expect(exactLimit.status).toBe(202);
      expect(requests.at(-1)?.bodyBytes).toBe(16 * 1024 * 1024);
      expect(requests.at(-1)?.authorization).toBe(`Bearer ${inferenceToken}`);
      const capability = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${capabilityCredential}`,
        body: '{}',
        method: 'POST',
        path: '/capabilities/mcp/echo',
      });
      expect(capability.status).toBe(202);
      expect(capability.body).toBe('{"accepted":true}');
      expect(requests.at(-1)).toMatchObject({
        authorization: `Bearer ${capabilityToken}`,
        path: '/capabilities/mcp/echo',
      });
      // The four-stream reservation does not widen a single native capability request.
      const exactCapabilityLimit = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${capabilityCredential}`,
        body: Buffer.alloc(512 * 1024),
        method: 'POST',
        path: '/capabilities/mcp/echo',
      });
      expect(exactCapabilityLimit.status).toBe(202);
      expect(requests.at(-1)?.bodyBytes).toBe(512 * 1024);
      const beforeCapabilityOverflow = requests.length;
      const oversizedCapability = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${capabilityCredential}`,
        body: Buffer.alloc(512 * 1024 + 1),
        method: 'POST',
        path: '/capabilities/mcp/echo',
      });
      expect(oversizedCapability.status).toBe(413);
      expect(requests).toHaveLength(beforeCapabilityOverflow);

      const beforeOversized = requests.length;
      const oversized = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${inferenceCredential}`,
        body: Buffer.alloc(16 * 1024 * 1024 + 1),
        method: 'POST',
        path: '/inference/v1/responses',
      });
      expect(oversized.status).toBeGreaterThanOrEqual(400);
      expect(oversized.status).toBeLessThan(500);
      expect(requests).toHaveLength(beforeOversized);

      let sseCompleted = false;
      const sse = await new Promise<{
        completion: Promise<string>;
        firstChunk: string;
        headers: NodeJS.Dict<string | string[]>;
        status: number;
      }>((resolve, reject) => {
        const request = requestHttp(
          {
            headers: {
              authorization: `Bearer ${inferenceCredential}`,
              'content-encoding': 'gzip',
              'content-type': 'application/json',
              'x-openkit-native': 'request-canary',
            },
            host: nativeTarget.hostname,
            method: 'POST',
            path: '/inference/v1/responses?stream=1',
            port: Number(nativeTarget.port),
          },
          (response) => {
            const chunks: Buffer[] = [];
            const completion = new Promise<string>((complete, fail) => {
              response.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
              response.once('end', () => complete(Buffer.concat(chunks).toString('utf8')));
              response.once('error', fail);
            });
            response.once('data', (chunk: Uint8Array) => {
              resolve({
                completion,
                firstChunk: Buffer.from(chunk).toString('utf8'),
                headers: response.headers,
                status: response.statusCode ?? 0,
              });
            });
          }
        );
        request.once('error', reject);
        request.end('{"stream":true}');
      });
      void sse.completion.then(() => {
        sseCompleted = true;
      });
      expect(sse.status).toBe(200);
      expect(sse.firstChunk).toBe('data: {"delta":"first"}\n\n');
      expect(sse.headers).toEqual(
        expect.objectContaining({
          'content-encoding': 'identity',
          'content-type': 'text/event-stream',
          'x-openkit-relay': 'stream-canary',
        })
      );
      expect(requests.at(-1)).toMatchObject({
        contentEncoding: 'gzip',
        customHeader: 'request-canary',
        path: '/inference/v1/responses?stream=1',
      });
      expect(sseCompleted).toBe(false);
      releaseSseEnd?.();
      expect(await sse.completion).toBe('data: {"delta":"first"}\n\ndata: {"done":true}\n\n');

      await new Promise<void>((resolve, reject) => {
        let cancelled = false;
        const request = requestHttp(
          {
            headers: { authorization: `Bearer ${inferenceCredential}` },
            host: nativeTarget.hostname,
            method: 'POST',
            path: '/inference/v1/responses?cancel=1',
            port: Number(nativeTarget.port),
          },
          (response) => {
            response.once('error', () => undefined);
            response.once('data', () => {
              cancelled = true;
              response.destroy();
              request.destroy();
              resolve();
            });
          }
        );
        request.once('error', (error) => {
          if (!cancelled) {
            reject(error);
          }
        });
        request.end('{}');
      });
      expect(await cancelObserved).toBe(http2Constants.NGHTTP2_CANCEL);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancelAborts).toBe(1);
      expect(
        requests.filter(({ path }) => path === '/inference/v1/responses?cancel=1')
      ).toHaveLength(1);

      const rejectedBeforeH2 = requests.length;
      await expect(
        nativeRequest(integrationTarget, {
          authorization: `Bearer ${inferenceCredential}`,
          method: 'POST',
          path: '/inference/v1/responses',
        })
      ).rejects.toThrow();
      expect(requests).toHaveLength(rejectedBeforeH2);
      for (const rejected of [
        {
          authorization: 'Bearer wrong-token',
          method: 'POST',
          path: '/inference/v1/responses',
        },
        {
          authorization: `Bearer ${controlToken}`,
          method: 'POST',
          path: '/worker-control/heartbeat',
        },
        {
          authorization: `Bearer ${inferenceCredential}`,
          method: 'POST',
          path: '/capabilities/call',
        },
        {
          authorization: `Bearer ${capabilityCredential}`,
          method: 'POST',
          path: '/inference/v1/responses',
        },
        {
          authorization: `Bearer ${inferenceCredential}`,
          method: 'GET',
          path: '/inference/v1/responses',
        },
        {
          authorization: `Bearer ${inferenceCredential}`,
          method: 'POST',
          path: '/undeclared/route',
        },
        // Raw upstream route tokens are never native credentials.
        {
          authorization: `Bearer ${inferenceToken}`,
          method: 'POST',
          path: '/inference/v1/responses',
        },
        {
          authorization: `Bearer ${capabilityToken}`,
          method: 'POST',
          path: '/capabilities/mcp/echo',
        },
      ]) {
        const response = await nativeRequest(nativeTarget, rejected);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(requests).toHaveLength(rejectedBeforeH2);
      }
      expect(sessionCount).toBe(1);
      expect(h2DataChunkBytes.length).toBeGreaterThan(0);
      expect(h2DataChunkBytes.every((bytes) => bytes <= 64 * 1024)).toBe(true);
      expect(unavailable).not.toHaveProperty('error');
      expect(unavailable).toMatchObject({ response: { status: 503 } });
    } finally {
      const socketClosed = supervisorSocket
        ? new Promise<void>((resolve) => supervisorSocket?.once('close', () => resolve()))
        : Promise.resolve();
      await integration.close();
      await socketClosed;
      bridgeSession?.destroy();
    }

    for (const closedTarget of [integrationTarget, nativeTarget]) {
      await expect(
        new Promise((resolve, reject) => {
          const rejected = connectSocket(Number(closedTarget.port), closedTarget.hostname);
          rejected.once('connect', () => {
            rejected.destroy();
            reject(new Error(`closed Integration listener accepted ${closedTarget.port}`));
          });
          rejected.once('error', resolve);
        })
      ).resolves.toBeDefined();
    }
  });

  it('attributes loopback requests to their AgentSession Turn, drains the barrier, and destroys at close', async () => {
    const tokens = (prefix: string) => ({
      capabilityToken: `${prefix}-capability-token`,
      controlToken: `${prefix}-control-token`,
      inferenceToken: `${prefix}-inference-token`,
    });
    const credentials = (letter: string) => ({
      capabilityCredential: letter.toLowerCase().repeat(43),
      inferenceCredential: letter.toUpperCase().repeat(43),
    });
    const a = credentials('a');
    const b = credentials('b');
    const upstream: Array<{ authorization: string; path: string }> = [];
    const held = new Set<ServerHttp2Stream>();
    const bridge = createHttp2Server();
    let bridgeSession: ServerHttp2Session | undefined;
    bridge.on('session', (session) => {
      bridgeSession = session;
    });
    bridge.on('stream', (stream: ServerHttp2Stream, headers) => {
      const path = String(headers[':path']);
      stream.on('error', () => undefined);
      stream.resume();
      stream.once('end', () => {
        upstream.push({ authorization: String(headers.authorization), path });
        if (path.endsWith('/hold')) {
          held.add(stream);
          stream.once('close', () => held.delete(stream));
          return;
        }
        stream.respond({ ':status': 200 });
        stream.end(String(headers.authorization));
      });
    });
    const integration = await openSandboxIntegration();
    const integrationTarget = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
    const nativeTarget = new URL(`http://${SANDBOX_NATIVE_INFERENCE_TARGET}`);
    const socket = connectSocket(Number(integrationTarget.port), integrationTarget.hostname);
    socket.on('error', () => undefined);
    bridge.emit('connection', socket);
    /** Sends one native request; resolves with its status and body, or `cut` when destroyed. */
    const native = (credential: string, path: string) =>
      new Promise<{ body: string; status: number } | 'cut'>((resolve) => {
        const request = requestHttp(
          {
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
            host: nativeTarget.hostname,
            method: 'POST',
            path,
            port: Number(nativeTarget.port),
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
            response.once('end', () =>
              resolve({
                body: Buffer.concat(chunks).toString('utf8'),
                status: response.statusCode ?? 0,
              })
            );
            response.once('error', () => resolve('cut'));
            response.once('aborted', () => resolve('cut'));
          }
        );
        request.once('error', () => resolve('cut'));
        request.end('{}');
      });

    /** Sends headers declaring 100 body bytes and only one; resolves `cut` once it is destroyed. */
    const uploading = (credential: string, path: string) =>
      new Promise<'cut' | 'answered'>((resolve) => {
        const request = requestHttp(
          {
            headers: {
              authorization: `Bearer ${credential}`,
              'content-length': '100',
              'content-type': 'application/json',
            },
            host: nativeTarget.hostname,
            method: 'POST',
            path,
            port: Number(nativeTarget.port),
          },
          () => resolve('answered')
        );
        request.once('error', () => resolve('cut'));
        request.once('close', () => resolve('cut'));
        request.write('{');
      });

    try {
      await integration.ready;
      expect(() =>
        integration.registerSessionLoopback('as_bad', {
          capabilityCredential: 'short',
          inferenceCredential: 'x'.repeat(43),
        })
      ).toThrow();
      expect(() =>
        integration.registerSessionLoopback('as_bad', {
          capabilityCredential: 'x'.repeat(43),
          inferenceCredential: 'x'.repeat(43),
        })
      ).toThrow();
      integration.registerSessionLoopback('as_a', a);
      expect(() => integration.registerSessionLoopback('as_a', b)).toThrow();
      expect(() =>
        integration.registerSessionLoopback('as_reuse', {
          capabilityCredential: a.inferenceCredential,
          inferenceCredential: 'z'.repeat(43),
        })
      ).toThrow();
      integration.registerSessionLoopback('as_b', b);

      // Idle supplies no authority; an unknown bearer is not a loopback credential.
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });
      expect(await native('q'.repeat(43), '/inference/v1/responses')).toMatchObject({
        status: 401,
      });
      expect(upstream).toEqual([]);

      integration.bindTurnRouteTokens('as_a', tokens('turn-a'));
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toEqual({
        body: 'Bearer turn-a-inference-token',
        status: 200,
      });
      expect(await native(a.capabilityCredential, '/capabilities/mcp/echo')).toEqual({
        body: 'Bearer turn-a-capability-token',
        status: 200,
      });
      // A sibling AgentSession without a bound Turn is refused, never routed to Turn A.
      expect(await native(b.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });
      integration.bindTurnRouteTokens('as_b', tokens('turn-b'));
      expect(await native(b.inferenceCredential, '/inference/v1/responses')).toEqual({
        body: 'Bearer turn-b-inference-token',
        status: 200,
      });

      // A request that completes inside the drain bound is not cut.
      expect(await integration.drainTurn('as_b')).toBe(0);
      expect(await native(b.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });
      integration.clearTurnRouteTokens('as_b');

      // The short window exercises incomplete drain: held requests are cut at the barrier.
      const inflight = native(a.inferenceCredential, '/inference/v1/hold');
      await vi.waitFor(() => expect(held.size).toBe(1));
      const drainStarted = Date.now();
      const drain = integration.drainTurn('as_a', 300);
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });
      expect(await drain).toBe(1);
      expect(Date.now() - drainStarted).toBeGreaterThanOrEqual(250);
      expect(await inflight).toBe('cut');
      await vi.waitFor(() => expect(held.size).toBe(0));
      integration.clearTurnRouteTokens('as_a');
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });

      // The short window exercises incomplete drain of an upload; none of it goes upstream.
      const openRequests = () =>
        (integration as unknown as { nativeRequests: Set<unknown> }).nativeRequests.size;
      integration.bindTurnRouteTokens('as_a', tokens('turn-a-upload'));
      const upstreamBefore = upstream.length;
      const uploadingAtBarrier = uploading(a.inferenceCredential, '/inference/v1/responses');
      await vi.waitFor(() => expect(openRequests()).toBe(1));
      expect(await integration.drainTurn('as_a', 20)).toBe(1);
      expect(await uploadingAtBarrier).toBe('cut');
      await vi.waitFor(() => expect(openRequests()).toBe(0));
      integration.clearTurnRouteTokens('as_a');

      // The production barrier bound is ten seconds.
      integration.bindTurnRouteTokens('as_a', tokens('turn-a-bound'));
      const uploadingAtDefault = uploading(a.inferenceCredential, '/inference/v1/responses');
      await vi.waitFor(() => expect(openRequests()).toBe(1));
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      let defaultCut: number | null = null;
      try {
        const drainAtDefault = integration.drainTurn('as_a').then((count) => {
          defaultCut = count;
        });
        await vi.advanceTimersByTimeAsync(9_900);
        expect(defaultCut).toBeNull();
        await vi.advanceTimersByTimeAsync(200);
        await drainAtDefault;
      } finally {
        vi.useRealTimers();
      }
      expect(defaultCut).toBe(1);
      expect(await uploadingAtDefault).toBe('cut');
      integration.clearTurnRouteTokens('as_a');

      // Destroying the credentials cuts a request still uploading its body.
      integration.bindTurnRouteTokens('as_a', tokens('turn-a-destroy'));
      const uploadingAtClose = uploading(a.capabilityCredential, '/capabilities/mcp/echo');
      await vi.waitFor(() => expect(openRequests()).toBe(1));
      integration.destroySessionLoopback('as_a');
      expect(await uploadingAtClose).toBe('cut');
      await vi.waitFor(() => expect(openRequests()).toBe(0));
      expect(upstream).toHaveLength(upstreamBefore);
      integration.registerSessionLoopback('as_a', a);

      // Close destroys the credentials and cuts what is still in flight.
      integration.bindTurnRouteTokens('as_a', tokens('turn-a2'));
      const beforeClose = native(a.capabilityCredential, '/capabilities/mcp/hold');
      await vi.waitFor(() => expect(held.size).toBe(1));
      integration.destroySessionLoopback('as_a');
      expect(await beforeClose).toBe('cut');
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 401,
      });
      expect(() => integration.bindTurnRouteTokens('as_a', tokens('turn-a3'))).toThrow();
      expect(upstream.map(({ authorization }) => authorization)).not.toContain(
        `Bearer ${a.inferenceCredential}`
      );
    } finally {
      const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      await integration.close();
      await socketClosed;
      bridgeSession?.destroy();
    }
  });
});
