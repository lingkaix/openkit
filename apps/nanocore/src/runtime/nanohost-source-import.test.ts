import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { connect, constants, createServer } from 'node:http2';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthVariables } from '../auth/middleware.js';
import {
  type NanoHostSessionDispatch,
  registerNanoHostSessionEffectRoutes,
} from './nanohost-session-dispatch.js';
import type { NanoHostFileImportSource } from './worker-governance-backend.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Tests raw carriage below the separately tested authoritative dispatcher, using a real HTTP/2 connection and fixed route. */
async function carriage(source: NanoHostFileImportSource, byteLength: number, sha256: string, slot = 'context') {
  const poll = vi.fn().mockResolvedValue({
    source,
    byteLength,
    sha256,
    relativePath: 'session/context/original',
    requestId: 'a'.repeat(64),
    sandboxId: 'sandbox-source',
    slot,
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  registerNanoHostSessionEffectRoutes({
    app,
    dispatch: { poll } as unknown as NanoHostSessionDispatch,
  });
  const listener = getRequestListener(app.fetch);
  const server = createServer((request, response) => {
    void listener(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing source carriage address.');
  const client = connect(`http://127.0.0.1:${address.port}`);
  await once(client, 'connect');
  cleanups.push(async () => {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const open = async () => {
    const request = client.request({
      ':method': 'POST',
      ':path': '/api/nanohost/transport/effects/reference.import',
      'content-type': 'application/json',
    });
    // Stream failures are expected observations in the fail-closed cases.
    request.on('error', () => {});
    const headers = once(request, 'response');
    request.end('{}');
    return { request, headers: (await headers)[0] };
  };
  return { open, poll };
}

it('streams a large original through the fixed route without eager buffering and with its exact digest', async () => {
  const total = 20 * 1024 * 1024 + 3;
  const oracle = createHash('sha256');
  for (let offset = 0; offset < total; offset += 1024)
    oracle.update('x'.repeat(Math.min(1024, total - offset)));
  const expected = `sha256:${oracle.digest('hex')}`;
  let produced = 0;
  let closed = false;
  const source: NanoHostFileImportSource = {
    async *open(signal) {
      try {
        while (produced < total) {
          signal.throwIfAborted();
          const bytes = Buffer.alloc(Math.min(65_536, total - produced), 120);
          produced += bytes.length;
          yield bytes;
        }
      } finally {
        closed = true;
      }
    },
  };
  const port = await carriage(source, total, expected);
  expect(produced).toBe(0);
  const { request, headers } = await port.open();
  expect(headers[':status']).toBe(200);
  expect(headers['x-openkit-byte-length']).toBe(String(total));
  expect(headers['x-openkit-sha256']).toBe(expected);
  // The peer's H2 receive window prevents the producer from materializing the complete original.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(produced).toBeLessThan(total);
  const actual = createHash('sha256');
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    actual.update(chunk);
  }
  expect(received).toBe(total);
  expect(`sha256:${actual.digest('hex')}`).toBe(expected);
  expect(closed).toBe(true);
  expect(port.poll).toHaveBeenCalledOnce();
});

it.each([
  'short',
  'long',
  'digest',
  'chunk',
  'read',
] as const)('refuses %s source failure instead of completing exact carriage', async (kind) => {
  let closed = false;
  const source: NanoHostFileImportSource = {
    async *open() {
      try {
        if (kind === 'read') throw new Error('Private source failure.');
        yield Buffer.alloc(kind === 'chunk' ? 65_537 : kind === 'short' ? 2 : 4, 120);
      } finally {
        closed = true;
      }
    },
  };
  const expected = `sha256:${createHash('sha256').update('xxx').digest('hex')}`;
  const { open } = await carriage(source, kind === 'digest' ? 4 : 3, expected);
  await expect(
    (async () => {
      const { request } = await open();
      for await (const _chunk of request) {
        /* The content is never accepted without clean EOF. */
      }
    })()
  ).rejects.toThrow();
  expect(closed).toBe(true);
});

it.each([100_000_000, 4_000_000_000])('cancels a %i-byte context declaration and releases carriage after an actual H2 reset', async (total) => {
  let closed = false;
  let produced = 0;
  const source: NanoHostFileImportSource = {
    async *open(signal) {
      try {
        while (true) {
          signal.throwIfAborted();
          produced += 65_536;
          yield Buffer.alloc(65_536, 120);
        }
      } finally {
        closed = true;
      }
    },
  };
  const { open } = await carriage(source, total, `sha256:${'a'.repeat(64)}`);
  const { request } = await open();
  request.close(constants.NGHTTP2_CANCEL);
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(produced).toBeLessThan(total);
});

it.each([
  ['context', 4_000_000_001], ['artifact-input', 1_000_000_001],
  ['turn-inputs', 1_000_000_001], ['instructions', 268_435_457],
] as const)('refuses oversized %s import metadata before opening any source', async (slot, length) => {
  const source = { open: vi.fn(async function* () { yield Buffer.alloc(1); }) };
  const port = await carriage(source, length, `sha256:${'a'.repeat(64)}`, slot);
  const { request, headers } = await port.open();
  expect(headers[':status']).toBe(413);
  request.resume();
  await once(request, 'end');
  expect(source.open).not.toHaveBeenCalled();
});
