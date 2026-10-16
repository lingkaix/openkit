/** The operator API uses the existing credential owner and never follows a changed origin. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOperatorApi } from './operator-api.mjs';

const origin = 'https://staging.example.test';
const credential = { token: 'synthetic-operator-value' };

test('explicit target and public operation selection precede credential use', async () => {
  let reads = 0;
  const resolve = () => { reads++; return credential; };
  for (const target of ['http://staging.example.test', origin + '/path', origin + '#x', 'https://a2']) {
    assert.throws(() => createOperatorApi(target, { resolve }));
  }
  const io = createOperatorApi(origin, { resolve });
  await assert.rejects(io.call('server-admin.issue', {}), /Operator API unavailable/);
  assert.equal(reads, 0);
});

test('request uses the exact endpoint, existing credential and no redirect or retry', async () => {
  const calls = [];
  const io = createOperatorApi(origin, {
    resolve: () => credential,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ready: false, identityId: 'synthetic-nanohost', deploymentId: 'synthetic-deployment',
        connectionGeneration: 1, observedAt: '2026-10-16T11:30:00.000Z', freshEmpty: false,
        predecessorFenced: false, physicalEpoch: null });
    },
  });
  const result = await io.call('nanohost.runtime-target', {});
  assert.equal(result.ready, false);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, origin);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(new Headers(calls[0].options.headers).get('authorization'),
    'Bearer ' + credential.token);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('authentication, transport and parser failures expose no remote text and never retry', async () => {
  for (const failure of ['credential', 'fetch', 'response', 'shape']) {
    let requests = 0;
    const io = createOperatorApi(origin, {
      resolve: () => { if (failure === 'credential') throw Error('PRIVATE_CREDENTIAL'); return credential; },
      fetch: async () => {
        requests++;
        if (failure === 'fetch') throw Error('PRIVATE_TRANSPORT');
        return failure === 'response'
          ? new Response('PRIVATE_PROVIDER', { status: 401 })
          : Response.json({ private: 'PRIVATE_SCHEMA' });
      },
    });
    await assert.rejects(io.call('nanohost.runtime-target', {}), (error) => {
      assert.equal(error.message, 'Operator API unavailable; inspect before any new effect.');
      return true;
    });
    assert.equal(requests, failure === 'credential' ? 0 : 1);
  }
});

test('stream output limit stops collection, cancels input and retains no partial JSON', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4_194_305)); },
    cancel() { cancelled = true; },
  });
  const io = createOperatorApi(origin, {
    resolve: () => credential,
    fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(io.call('nanohost.runtime-target', {}), /Operator API unavailable/);
  assert.equal(cancelled, true);
});

test('the request deadline includes a server that never completes its response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const io = createOperatorApi(origin, {
    resolve: () => credential,
    fetch: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const pending = io.call('nanohost.runtime-target', {});
  const rejection = assert.rejects(pending, /Operator API unavailable/);
  // Credential resolution precedes the request's own timer registration.
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await rejection;
  assert.equal(signal.aborted, true);
});

test('retained reads cannot call secret or effect operations through annotations', async () => {
  let fetched = false;
  const io = createOperatorApi(origin, {
    resolve: () => credential,
    fetch: async () => { fetched = true; throw Error(); },
  });
  await assert.rejects(io.call('provider-account.import', {}), /Operator API unavailable/);
  assert.equal(fetched, false);
});
