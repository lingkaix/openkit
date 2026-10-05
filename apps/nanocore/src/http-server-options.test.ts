import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createServer as createHttp2Server, createSecureServer } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { Worker } from 'node:worker_threads';
import { serve } from '@hono/node-server';
import { expect, it } from 'vitest';
import { NANOCORE_HTTP_SERVER_OPTIONS } from './http-server-options.js';

it('keeps HTTP and HTTPS idle close well beyond even clients following the advertised hint', () => {
  for (const create of [createServer, createHttpsServer]) {
    const server = create(NANOCORE_HTTP_SERVER_OPTIONS);
    // Direct Chromium connections can remain reusable for five minutes without following a hint.
    expect(
      server.keepAliveTimeout + server.keepAliveTimeoutBuffer - 300_000
    ).toBeGreaterThanOrEqual(30_000);
    expect(server.keepAliveTimeoutBuffer).toBeGreaterThanOrEqual(30_000);
    expect(server.headersTimeout).toBe(60_000);
    expect(server.requestTimeout).toBe(300_000);
    expect(server.timeout).toBe(0);
  }
});

it('keeps private cleartext and TLS HTTP/2 sessions free of idle-close timers', () => {
  for (const create of [createHttp2Server, createSecureServer]) {
    expect(create().timeout).toBe(0);
  }
});

it('responds on a reused socket written during a stall longer than the old idle margin', async () => {
  const blockState = new Int32Array(new SharedArrayBuffer(4));
  let requests = 0;
  let blockTimer: ReturnType<typeof setTimeout> | undefined;
  let blockImmediate: ReturnType<typeof setImmediate> | undefined;
  let blockedMs = 0;
  const server = serve({
    createServer,
    hostname: '127.0.0.1',
    port: 0,
    serverOptions: NANOCORE_HTTP_SERVER_OPTIONS,
    fetch: (_request, { outgoing }) => {
      requests += 1;
      if (requests === 1) {
        outgoing.once('finish', () => {
          // The check phase reproduces the expired idle timer winning over unread socket data.
          blockTimer = setTimeout(() => {
            blockImmediate = setImmediate(() => {
              const start = performance.now();
              Atomics.store(blockState, 0, 1);
              Atomics.wait(blockState, 0, 1, 3_000);
              blockedMs = performance.now() - start;
              Atomics.store(blockState, 0, 2);
            });
          }, 3_500);
        });
      }
      return new Response('ok');
    },
  }) as Server;
  let worker: Worker | undefined;
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a dynamic TCP listener.');
    }
    worker = new Worker(
      `
        import http from 'node:http';
        import { parentPort, workerData } from 'node:worker_threads';
        const blockState = new Int32Array(workerData.blockState);
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const responses = [];
        let advertisedKeepAlive;
        let writtenDuringBlock = false;
        function request(second) {
          const req = http.request({ host: '127.0.0.1', port: workerData.port, method: 'POST', agent }, res => {
            if (!second) advertisedKeepAlive = res.headers['keep-alive'];
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
              responses.push({ status: res.statusCode, body, reused: req.reusedSocket });
              if (second) finish();
              else setTimeout(() => request(true), 3_800);
            });
          });
          req.once('finish', () => {
            if (second) writtenDuringBlock = Atomics.load(blockState, 0) === 1;
          });
          req.once('error', error => {
            responses.push({ error: error.code, reused: req.reusedSocket });
            finish();
          });
          req.end();
        }
        function finish() {
          agent.destroy();
          parentPort.postMessage({ responses, writtenDuringBlock, advertisedKeepAlive });
          parentPort.close();
        }
        request(false);
      `,
      { eval: true, workerData: { blockState: blockState.buffer, port: address.port } }
    );
    const [result] = await once(worker, 'message');
    expect(result.writtenDuringBlock).toBe(true);
    expect(blockedMs).toBeGreaterThanOrEqual(3_000);
    expect(result.responses).toEqual([
      { status: 200, body: 'ok', reused: false },
      { status: 200, body: 'ok', reused: true },
    ]);
    expect(requests).toBe(2);
    expect(result.advertisedKeepAlive).toBe('timeout=300');
  } finally {
    clearTimeout(blockTimer);
    clearImmediate(blockImmediate);
    await worker?.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
