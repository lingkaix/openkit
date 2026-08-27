import { readFileSync } from 'node:fs';
import { request as requestHttp } from 'node:http';
import {
  createServer as createHttp2Server,
  constants as http2Constants,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from 'node:http2';
import { connect as connectSocket } from 'node:net';

import { describe, expect, it } from 'vitest';
import {
  openSandboxIntegration,
  SANDBOX_INTEGRATION_ROUTE_NAMESPACES,
  SANDBOX_INTEGRATION_TARGET,
  SANDBOX_NATIVE_INFERENCE_TARGET,
} from './integration-client.js';

describe('Sandbox Integration', () => {
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
      .split('private async handleNativeInference(')
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
        body: '{"schemaVersion":1,"nextExpectedSequence":0}',
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
      integration.bindTurnRouteTokens({ controlToken, inferenceToken });

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
        { authorization: `Bearer ${inferenceToken}`, path: '/inference/v1/responses' },
      ]);

      integration.clearTurnRouteTokens();
      await expect(
        integration.workerControlFetch('/worker-control/heartbeat', {
          body: '{}',
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('not bound');
      integration.bindTurnRouteTokens({ controlToken, inferenceToken });

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
      for (const path of [
        '/capabilities/call',
        '/fourth/route',
        'https://nanocore.local/worker-control/heartbeat',
      ]) {
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

  it('relays only bounded authenticated native inference over the ready H2 session', async () => {
    const controlToken = 'native-control-token';
    const inferenceToken = 'native-inference-token';
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
      integration.bindTurnRouteTokens({ controlToken, inferenceToken });
      const unavailable = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${inferenceToken}`,
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
        authorization: `Bearer ${inferenceToken}`,
        body: Buffer.alloc(16 * 1024 * 1024),
        method: 'POST',
        path: '/inference/v1/responses',
      });
      expect(exactLimit.status).toBe(202);
      expect(requests.at(-1)?.bodyBytes).toBe(16 * 1024 * 1024);
      const beforeOversized = requests.length;
      const oversized = await nativeRequest(nativeTarget, {
        authorization: `Bearer ${inferenceToken}`,
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
              authorization: `Bearer ${inferenceToken}`,
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
            headers: { authorization: `Bearer ${inferenceToken}` },
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
          authorization: `Bearer ${inferenceToken}`,
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
          authorization: `Bearer ${inferenceToken}`,
          method: 'POST',
          path: '/capabilities/call',
        },
        {
          authorization: `Bearer ${inferenceToken}`,
          method: 'GET',
          path: '/inference/v1/responses',
        },
        {
          authorization: `Bearer ${inferenceToken}`,
          method: 'POST',
          path: '/undeclared/route',
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
});
