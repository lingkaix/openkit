import { request as requestHttp } from 'node:http';
import {
  createServer as createHttp2Server,
  constants as http2Constants,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from 'node:http2';
import { connect as connectSocket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { WORKER_ADAPTERS } from './adapter-registry.js';
import { runWorkerHarness, WorkerHarness } from './harness.js';
import * as integrationModule from './integration-client.js';
import {
  openSandboxIntegration,
  SANDBOX_INTEGRATION_ROUTE_NAMESPACES,
  SANDBOX_INTEGRATION_TARGET,
  SANDBOX_NATIVE_INFERENCE_TARGET,
  SandboxIntegrationClient,
  WorkerShimPollCarrier,
} from './integration-client.js';
import { openEphemeralSandboxIntegration } from './test-support/ephemeral-integration.js';
import { FakeWorkerShim } from './test-support/worker-shim-fake.js';
import type {
  WorkerShimDesiredSet,
  WorkerShimInventory,
  WorkerShimSession,
  WorkerShimTurnInput,
} from './worker-shim-port.js';

describe('staged Worker Shim carrier', () => {
  const session = {
    sandboxIncarnationId: 'sbxi_00000000-0000-7b98-8803-ea4242ad797b',
    connectionGeneration: 1,
  };
  const otherIncarnationId = 'sbxi_00000000-0000-73c3-900f-8d310e4ba201';
  const successor = { ...session, connectionGeneration: 2 };
  const worker = {
    workerId: 'wkr_00000000-0000-7b98-8803-ea4242ad797b',
    agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
    adapterId: 'codex',
    workSlotRef: 'slot-1',
    resume: null,
  };
  const key = {
    workerId: worker.workerId,
    operationId: 'operation-1',
    payloadDigest: 'a'.repeat(64),
  };
  const target = {
    workerId: worker.workerId,
    turnId: 'tu_00000000-0000-7612-9335-5946291cc91e',
    attemptId: 'attempt_00000000-0000-7b98-8803-ea4242ad797b',
  };
  const input: WorkerShimTurnInput = {
    ...key,
    ...target,
    inputRef: 'input-1',
    routeGrant: 'grant-1',
  };
  const interrupt = { ...target, requestId: 'interrupt-1' };
  const inventory = (current: WorkerShimSession): WorkerShimInventory => ({
    session: current,
    workers: [],
    receipts: [],
    interrupts: [],
  });
  const desired = (
    current: WorkerShimSession,
    revision: number,
    work: Partial<WorkerShimDesiredSet> = {}
  ): WorkerShimDesiredSet => ({
    session: current,
    revision,
    workers: [],
    inputs: [],
    steers: [],
    interrupts: [],
    acknowledgedOperations: [],
    ...work,
  });
  const work = { workers: [{ state: 'run' as const, worker }], inputs: [input] };
  async function* body(value: unknown) {
    yield Buffer.from(JSON.stringify(value));
  }
  const peer = (value: unknown) => async () => body(value);
  const attach = (carrier = new WorkerShimPollCarrier(session.sandboxIncarnationId)) => {
    carrier.attach(session);
    return carrier;
  };
  const effects = () => {
    const start = vi.fn();
    const intake = vi.fn();
    const apply = (set: WorkerShimDesiredSet, begin: () => void) => {
      begin();
      for (const item of set.workers) if (item.state === 'run') start(item.worker);
      for (const item of set.inputs) intake(item);
    };
    return { start, intake, apply };
  };

  it.each([
    'before request',
    'during body',
    'older revision',
    'foreign incarnation',
    'cancelled at EOF',
  ] as const)('cuts stale work %s before starts or native intake', async (cut) => {
    const carrier = attach();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const abort = new AbortController();
    const { start, intake, apply } = effects();
    let current = session;
    const wrong = { ...session, sandboxIncarnationId: otherIncarnationId };
    if (cut === 'before request') {
      current = successor;
      carrier.attach(current);
    }
    const replySession =
      cut === 'foreign incarnation' ? wrong : cut === 'during body' ? successor : session;
    const reply = desired(replySession, 1, work);
    const send = vi.fn(async function* () {
      if (cut === 'during body' || cut === 'older revision') {
        const text = JSON.stringify(reply);
        yield Buffer.from(text.slice(0, 12));
        held.resolve();
        await release.promise;
        yield Buffer.from(text.slice(12));
      } else {
        yield Buffer.from(JSON.stringify(reply));
      }
      if (cut === 'cancelled at EOF') abort.abort();
    });
    const deliver = vi.fn(apply);
    const attempted = carrier.poll(inventory(session), async () => send(), deliver, abort.signal);
    const refused = attempted.then(
      () => null,
      (error: unknown) => error
    );
    if (cut === 'during body' || cut === 'older revision') {
      await held.promise;
      if (cut === 'during body') {
        current = successor;
        carrier.attach(current);
      } else {
        await carrier.poll(inventory(current), peer(desired(current, 2)), apply);
      }
      release.resolve();
    }
    const failure = await refused;
    expect(send).toHaveBeenCalledTimes(cut === 'before request' ? 0 : 1);
    expect(start).toHaveBeenCalledTimes(0);
    expect(intake).toHaveBeenCalledTimes(0);
    if (cut === 'cancelled at EOF') expect(deliver).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    const matching = desired(current, 3, work);
    await carrier.poll(inventory(current), peer(matching), apply);
    await expect(carrier.poll(inventory(current), peer(matching), apply)).rejects.toThrow();
    expect(start).toHaveBeenCalledExactlyOnceWith(worker);
    expect(intake).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('binds a held reply to the generation actually encoded even when the caller reuses its session', async () => {
    const reused = { ...session };
    const carrier = attach();
    const { apply, start, intake } = effects();
    const sent = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const held = carrier
      .poll(
        inventory(reused),
        async (text) => {
          sent.resolve(text);
          await release.promise;
          return body(desired(successor, 1, work));
        },
        apply
      )
      .catch((error: unknown) => error);

    const offered = await sent.promise;
    reused.connectionGeneration = successor.connectionGeneration;
    carrier.attach(reused);
    release.resolve();
    const result = await held;
    expect(JSON.parse(offered)).toEqual(inventory(session));
    expect(start).toHaveBeenCalledTimes(0);
    expect(intake).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({ message: expect.stringContaining('stale') });
    await carrier.poll(inventory(reused), peer(desired(reused, 1, work)), apply);
    expect(start).toHaveBeenCalledExactlyOnceWith(worker);
    expect(intake).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('caps streamed reply bytes before applying a complete valid set', async () => {
    const carrier = attach();
    const { start, intake, apply } = effects();
    const text = JSON.stringify(desired(session, 1, work));
    const padding = Buffer.alloc(1024 * 1024 - Buffer.byteLength(text), 0x20);
    const reply = (excess: boolean) =>
      async function* () {
        yield Buffer.from(text);
        yield padding;
        if (excess) yield Buffer.from(' ');
      };
    const over = await carrier
      .poll(inventory(session), async () => reply(true)(), apply)
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(start).toHaveBeenCalledTimes(0);
    expect(intake).toHaveBeenCalledTimes(0);
    expect(over).toBeInstanceOf(TypeError);
    expect((over as Error).message).toContain('byte bound');
    await carrier.poll(inventory(session), async () => reply(false)(), apply);
    expect(start).toHaveBeenCalledTimes(1);
    expect(intake).toHaveBeenCalledTimes(1);
  });

  it('keeps the original outage deadline during a same-incarnation reconnect', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const carrier = attach();
      const { apply, start, intake } = effects();
      const original = { kind: 'input' as const, key, disposition: 'accepted' as const };
      const retained = { ...inventory(session), receipts: [original] };
      await expect(
        carrier.poll(
          retained,
          async () => {
            throw new Error('outage');
          },
          apply
        )
      ).rejects.toThrow('outage');
      now = 299_999;
      carrier.attach(successor);
      const next = { ...retained, session: successor };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const exchange = vi.fn(async function* () {
        entered.resolve();
        await release.promise;
        yield Buffer.from(JSON.stringify(desired(successor, 0, work)));
      });
      const pending = carrier.poll(
        next,
        async (encoded) => {
          expect(JSON.parse(encoded)).toEqual(next);
          return exchange();
        },
        apply
      );
      const refused = pending.then(
        () => null,
        (error: unknown) => error
      );
      await entered.promise;
      now = 300_000;
      release.resolve();
      const failure = await refused;
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(0);
      expect(intake).toHaveBeenCalledTimes(0);
      expect((failure as Error).message).toContain('outage');
      expect(() => carrier.attach({ ...successor, connectionGeneration: 3 })).toThrow('outage');
    } finally {
      clock.mockRestore();
    }
  });

  it('does not give a held reply a new deadline when another exchange succeeds', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const carrier = attach();
      const { apply, start, intake } = effects();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const heldBody = async function* () {
        entered.resolve();
        await release.promise;
        yield Buffer.from(JSON.stringify(desired(session, 3, work)));
      };
      const pending = carrier.poll(inventory(session), async () => heldBody(), apply);
      const rejected = pending.then(
        () => null,
        (error: unknown) => error
      );
      await entered.promise;
      now = 299_999;
      await carrier.poll(inventory(session), peer(desired(session, 2)), apply);
      now = 300_000;
      release.resolve();
      const failure = await rejected;
      expect(start).toHaveBeenCalledTimes(0);
      expect(intake).toHaveBeenCalledTimes(0);
      expect((failure as Error).message).toContain('outage');
      carrier.attach(successor);
      await carrier.poll(inventory(successor), peer(desired(successor, 0, work)), apply);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('aborts a peer still waiting at the original outage deadline', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const carrier = attach();
      const { apply, start, intake } = effects();
      const exchange = vi.fn(
        async (_encoded: string, signal: AbortSignal) =>
          new Promise<AsyncIterable<Uint8Array>>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          })
      );
      const pending = carrier.poll(inventory(session), exchange, apply);
      const refused = expect(pending).rejects.toThrow('outage');
      await vi.advanceTimersByTimeAsync(299_999);
      const signal = exchange.mock.calls[0]?.[1];
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      await refused;
      expect(() => carrier.attach(successor)).toThrow('outage');
      expect(start).toHaveBeenCalledTimes(0);
      expect(intake).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a half-read reply at the original outage deadline without waiting for EOF', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const release = Promise.withResolvers<void>();
    let pending: Promise<void> | undefined;
    try {
      const carrier = attach();
      const { apply, start, intake } = effects();
      const held = Promise.withResolvers<AbortSignal>();
      const closed = Promise.withResolvers<void>();
      const text = JSON.stringify(desired(session, 1, work));
      let outcome: unknown;
      pending = carrier
        .poll(
          inventory(session),
          async (_encoded, signal) => {
            return (async function* () {
              try {
                yield Buffer.from(text.slice(0, 12));
                held.resolve(signal);
                await release.promise;
                yield Buffer.from(text.slice(12));
              } finally {
                closed.resolve();
              }
            })();
          },
          apply
        )
        .then(
          () => {
            outcome = 'applied';
          },
          (error: unknown) => {
            outcome = error;
          }
        );
      const signal = await held.promise;
      await vi.advanceTimersByTimeAsync(299_999);
      expect(outcome).toBeUndefined();
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(outcome).toMatchObject({ message: expect.stringContaining('outage') });
      release.resolve();
      await pending;
      await closed.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(start).toHaveBeenCalledTimes(0);
      expect(intake).toHaveBeenCalledTimes(0);
    } finally {
      release.resolve();
      await pending;
      vi.useRealTimers();
    }
  });

  it('retires the local entry after an unsupported first exchange and starts the next incarnation empty', async () => {
    const carrier = attach();
    const { apply, start, intake } = effects();
    await expect(
      carrier.poll(
        inventory(session),
        peer({ ...desired(session, 1, work), schemaVersion: 99 }),
        apply
      )
    ).rejects.toThrow('unsupported');
    expect(() => carrier.attach(successor)).toThrow();
    expect(start).toHaveBeenCalledTimes(0);
    expect(intake).toHaveBeenCalledTimes(0);
    const fresh = { sandboxIncarnationId: otherIncarnationId, connectionGeneration: 1 };
    const newCarrier = new WorkerShimPollCarrier(fresh.sandboxIncarnationId);
    newCarrier.attach(fresh);
    await newCarrier.poll(
      inventory(fresh),
      async (sent) => {
        expect(JSON.parse(sent)).toEqual(inventory(fresh));
        return body(desired(fresh, 1, work));
      },
      apply
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(intake).toHaveBeenCalledTimes(1);
  });

  it('cuts cancellation after Shim hand-off and before the first effect', async () => {
    const carrier = attach();
    const shim = new FakeWorkerShim(session.sandboxIncarnationId, { input: () => 'accepted' });
    const abort = new AbortController();
    const cancelled = new Error('cancelled before effects');
    const startWorker = shim.start.bind(shim);
    let beginEffects!: () => void;
    const start = vi.spyOn(shim, 'start').mockImplementation((request) => {
      beginEffects();
      return startWorker(request);
    });
    let atCut: { starts: number; inputs: number } | undefined;
    const outcome = await carrier
      .poll(
        inventory(session),
        peer(desired(session, 1, work)),
        (set, begin) => {
          beginEffects = begin;
          return shim.poll(set.session, async () => {
            queueMicrotask(() => {
              atCut = { starts: shim.started.length, inputs: shim.contacted.length };
              abort.abort(cancelled);
            });
            return set;
          });
        },
        abort.signal
      )
      .catch((error: unknown) => error);
    expect(atCut).toEqual({ starts: 0, inputs: 0 });
    expect(shim.started).toEqual([]);
    expect(shim.contacted).toEqual([]);
    expect(outcome).toBe(cancelled);
    start.mockRestore();
    await carrier.poll(inventory(session), peer(desired(session, 2, work)), (set, begin) => {
      begin();
      return shim.poll(set.session, async () => set);
    });
    expect(shim.started).toEqual([worker.workerId]);
    expect(shim.contacted).toEqual([input.operationId]);
  });

  it('rejects corrupt UTF-8 and preserves the valid original interrupt key byte for byte', async () => {
    const carrier = attach();
    const { apply, start, intake } = effects();
    const delivered = vi.fn(apply);
    await carrier.poll(inventory(session), peer(desired(session, 0)), delivered);
    delivered.mockClear();
    const requestId = 'interrupt-e\u0301-\u00e9-\u{1f642}';
    const original = Buffer.from(requestId);
    const valid = Buffer.from(
      JSON.stringify(
        desired(session, 1, {
          ...work,
          interrupts: [{ ...interrupt, requestId }],
        })
      )
    );
    const offset = valid.indexOf(original) + Buffer.byteLength('interrupt-e');
    const corrupted = Buffer.from(valid);
    corrupted[offset] = 0xff;
    const send = (bytes: Buffer) =>
      async function* () {
        yield bytes.subarray(0, offset + 1);
        yield bytes.subarray(offset + 1);
      };
    const result = await carrier
      .poll(inventory(session), async () => send(corrupted)(), delivered)
      .catch((error: unknown) => error);
    expect(delivered).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(0);
    expect(intake).toHaveBeenCalledTimes(0);
    expect(result).toBeInstanceOf(TypeError);
    await carrier.poll(inventory(session), async () => send(valid)(), delivered);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(Buffer.from(delivered.mock.calls[0]?.[0].interrupts[0]?.requestId ?? '')).toEqual(
      original
    );
    expect(start).toHaveBeenCalledExactlyOnceWith(worker);
    expect(intake).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('refuses unrecognized material before any Worker or input effect', async () => {
    const carrier = attach();
    const { apply, start, intake } = effects();
    await carrier.poll(inventory(session), peer(desired(session, 0)), apply);
    const rejected = await carrier
      .poll(
        inventory(session),
        peer({ ...desired(session, 1, work), unexpectedMaterial: { worker: worker.workerId } }),
        apply
      )
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(start).toHaveBeenCalledTimes(0);
    expect(intake).toHaveBeenCalledTimes(0);
    expect((rejected as Error).message).toContain('unsupported');
    await carrier.poll(inventory(session), peer(desired(session, 2, work)), apply);
    expect(start).toHaveBeenCalledTimes(1);
    expect(intake).toHaveBeenCalledTimes(1);
  });

  it('exchanges a full current inventory while original settlement is held and retains an exact receipt through lost ACK', async () => {
    const carrier = attach();
    const shim = new FakeWorkerShim(session.sandboxIncarnationId, { input: () => 'accepted' });
    const applicationEntered = Promise.withResolvers<void>();
    const settlement = Promise.withResolvers<void>();
    const lost = new Error('drop exchange before delivery');
    const report = async (current: WorkerShimSession) => {
      let full!: WorkerShimInventory;
      await expect(
        shim.poll(current, async (observed) => {
          full = observed;
          throw lost;
        })
      ).rejects.toBe(lost);
      return full;
    };
    const apply = (set: WorkerShimDesiredSet, begin: () => void) => {
      begin();
      return shim.poll(set.session, async () => set);
    };
    const held = carrier.poll(
      await report(session),
      peer(desired(session, 1, work)),
      async (set, begin) => {
        await apply(set, begin);
        applicationEntered.resolve();
        await settlement.promise;
      }
    );
    await applicationEntered.promise;
    const original = { kind: 'input', key, disposition: 'accepted' };
    const firstReport = await report(session);
    expect(firstReport.workers).toHaveLength(1);
    expect(firstReport.receipts).toEqual([original]);
    const recorded = new Set<string>();
    const commit = vi.fn();
    let next: Promise<'applied' | 'stale'> | undefined;
    try {
      next = carrier.poll(
        firstReport,
        async (encoded) => {
          expect(JSON.parse(encoded)).toEqual(firstReport);
          recorded.add(JSON.stringify((JSON.parse(encoded) as WorkerShimInventory).receipts[0]));
          commit();
          return body(desired(session, 2, { interrupts: [interrupt] }));
        },
        apply
      );
      await vi.waitFor(() => expect(shim.interrupted).toEqual([interrupt.requestId]), {
        timeout: 100,
      });
      await next;
      // The original result was observed, and the Core fixture loses the acknowledgement.
      await expect(
        carrier.poll(
          await report(session),
          async () => {
            throw lost;
          },
          apply
        )
      ).rejects.toBe(lost);
      carrier.attach(successor);
      const reconnect = await report(successor);
      expect(reconnect).toEqual({
        ...firstReport,
        session: successor,
        interrupts: [{ ...interrupt, disposition: 'unknown' }],
      });
      await carrier.poll(
        reconnect,
        async (encoded) => {
          expect(JSON.parse(encoded)).toEqual(reconnect);
          for (const item of (JSON.parse(encoded) as WorkerShimInventory).receipts) {
            if (!recorded.has(JSON.stringify(item))) commit();
          }
          return body(
            desired(successor, 1, {
              ...work,
              interrupts: [interrupt],
              acknowledgedOperations: [{ ...key, payloadDigest: 'b'.repeat(64) }],
            })
          );
        },
        apply
      );
      const pending = await report(successor);
      expect(pending.receipts).toEqual([original]);
      await carrier.poll(
        pending,
        peer(desired(successor, 2, { acknowledgedOperations: [key] })),
        apply
      );
      expect((await report(successor)).receipts).toEqual([]);
      expect(shim.started).toEqual([worker.workerId]);
      expect(shim.contacted).toEqual([input.operationId]);
      expect(shim.interrupted).toEqual([interrupt.requestId]);
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      settlement.resolve();
      await held;
      await next;
    }
  });
});

describe('Sandbox Integration', () => {
  it.each(['complete', 'incomplete'] as const)(
    'rejects a post-header abort with a %s Harness body',
    async (bodyState) => {
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
      const { integration, integrationTarget: target } = await openEphemeralSandboxIntegration();
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
    }
  );

  it.each(['poll', 'result'] as const)(
    'keeps the real Harness %s stream alive beyond one second after timely headers',
    async (phase) => {
      const bridge = createHttp2Server();
      const stop = new AbortController();
      let bridgeSession: ServerHttp2Session | undefined;
      let slowStream: ServerHttp2Stream | undefined;
      let pollCount = 0;
      let resultCount = 0;
      let markEntry!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntry = resolve;
      });
      let markHeaders!: () => void;
      const headersSeen = new Promise<void>((resolve) => {
        markHeaders = resolve;
      });
      const commandBody = JSON.stringify({
        schemaVersion: 2,
        harnessInstanceId: 'slow-harness',
        operationId: 'a'.repeat(64),
        sequence: 0,
        operation: phase === 'poll' ? 'turn.start' : 'harness.drain',
        body: {},
        // The envelope extension is inert; the real collector must retain and bound its bytes.
        note: 'x'.repeat(128 * 1024),
      });
      bridge.on('session', (session) => {
        bridgeSession = session;
      });
      bridge.on('stream', (stream, headers) => {
        stream.on('error', () => undefined);
        stream.resume();
        stream.once('end', () => {
          const poll = headers[':path'] === '/worker-control/harness/poll';
          if (poll && ++pollCount > 1) {
            stream.respond({ ':status': 404 });
            stream.end();
            return;
          }
          if (!poll) resultCount += 1;
          const slow =
            (phase === 'poll' && poll) || (phase === 'result' && !poll && resultCount === 1);
          stream.respond({ ':status': poll ? 200 : slow ? 503 : 204 });
          if (slow) {
            slowStream = stream;
            stream.write(poll ? commandBody.slice(0, 64) : 'retry');
          } else stream.end(poll ? commandBody : undefined);
        });
      });
      const nativeRequest = SandboxIntegrationClient.prototype.request;
      const request = vi
        .spyOn(SandboxIntegrationClient.prototype, 'request')
        .mockImplementation(async function (this: SandboxIntegrationClient, ...args) {
          const response = await nativeRequest.apply(this, args);
          if (args[0].endsWith(phase === 'poll' ? '/poll' : '/result')) markHeaders();
          return response;
        });
      const handle = vi.spyOn(WorkerHarness.prototype, 'handle');
      const write = process.stdout.write.bind(process.stdout);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array
      ) => {
        if (Buffer.from(chunk).toString() === 'OPENKIT_WORKER_SHIM_ENTRY_V1\n') {
          markEntry();
          return true;
        }
        return write(chunk);
      }) as typeof process.stdout.write);
      let integrationTarget!: URL;
      const open = vi
        .spyOn(integrationModule, 'openSandboxIntegration')
        .mockImplementation(async (options) => {
          const fixture = await openEphemeralSandboxIntegration(options);
          integrationTarget = fixture.integrationTarget;
          return fixture.integration;
        });
      const run = runWorkerHarness({ signal: stop.signal }).catch((error: unknown) => error);
      let socket: ReturnType<typeof connectSocket> | undefined;
      try {
        await entered;
        socket = connectSocket(Number(integrationTarget.port), integrationTarget.hostname);
        socket.on('error', () => undefined);
        bridge.emit('connection', socket);
        await headersSeen;
        await delay(1_250);
        expect(slowStream).toBeDefined();
        expect(
          slowStream!.rstCode,
          'real Integration must not cancel body collection at the header deadline'
        ).toBe(0);
        expect(pollCount).toBe(1);
        expect(resultCount).toBe(phase === 'poll' ? 0 : 1);
        slowStream!.end(phase === 'poll' ? commandBody.slice(64) : ' later');
        expect(await run).toBeInstanceOf(Error);
        expect(handle).toHaveBeenCalledTimes(1);
        expect(resultCount).toBe(phase === 'poll' ? 1 : 2);
      } finally {
        stop.abort(new Error('fixture-complete'));
        slowStream?.close();
        await run;
        open.mockRestore();
        request.mockRestore();
        handle.mockRestore();
        stdout.mockRestore();
        socket?.destroy();
        bridgeSession?.destroy();
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }
  );

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
      requestKind: 'turn',
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
    const { integration, integrationTarget, nativeTarget } =
      await openEphemeralSandboxIntegration();
    const supervisorSocket = connectSocket(
      Number(integrationTarget.port),
      integrationTarget.hostname
    );
    bridge.emit('connection', supervisorSocket);
    try {
      await integration.ready;
      integration.registerSessionLoopback('as_00000000-0000-7e21-a5ac-a39ca3d5f979', {
        capabilityCredential: 'C'.repeat(43),
        inferenceCredential: 'I'.repeat(43),
        ...(mapped
          ? { inferenceRuntimeHintMapping: WORKER_ADAPTERS.codex?.inferenceRuntimeHintMapping }
          : {}),
      });
      integration.bindTurnRouteTokens('as_00000000-0000-7e21-a5ac-a39ca3d5f979', {
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
            port: Number(nativeTarget.port),
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

  it('keeps overlapping Integration fixtures on distinct live loopback listeners', async () => {
    const first = await openEphemeralSandboxIntegration();
    void first.integration.ready.catch(() => undefined);
    let second: Awaited<ReturnType<typeof openEphemeralSandboxIntegration>> | undefined;
    try {
      second = await openEphemeralSandboxIntegration();
      void second.integration.ready.catch(() => undefined);
      expect(
        new Set([
          first.integrationTarget.port,
          first.nativeTarget.port,
          second.integrationTarget.port,
          second.nativeTarget.port,
        ]).size
      ).toBe(4);
      for (const fixture of [first, second]) {
        const response = await fetch(new URL('/inference/v1/responses', fixture.nativeTarget), {
          method: 'POST',
          body: '{}',
        });
        expect(response.status).toBe(503);
        await response.text();
      }
    } finally {
      await second?.integration.close();
      await first.integration.close();
    }
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

    const { integration, integrationTarget: target } = await openEphemeralSandboxIntegration();
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
      integration.registerSessionLoopback('as_00000000-0000-70f4-ad2c-38b33b7fd38c', {
        capabilityCredential: 'c'.repeat(43),
        inferenceCredential: 'i'.repeat(43),
      });
      integration.bindTurnRouteTokens('as_00000000-0000-70f4-ad2c-38b33b7fd38c', {
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

      integration.clearTurnRouteTokens('as_00000000-0000-70f4-ad2c-38b33b7fd38c');
      await expect(
        integration.workerControlFetch('/worker-control/heartbeat', {
          body: '{}',
          headers: { authorization: `Bearer ${controlToken}` },
          method: 'POST',
        })
      ).rejects.toThrow('not bound');
      integration.bindTurnRouteTokens('as_00000000-0000-70f4-ad2c-38b33b7fd38c', {
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

    const { integration, integrationTarget, nativeTarget } =
      await openEphemeralSandboxIntegration();
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
      integration.registerSessionLoopback('as_00000000-0000-7926-9f77-df66eb3f42ca', {
        capabilityCredential,
        inferenceCredential,
      });
      integration.bindTurnRouteTokens('as_00000000-0000-7926-9f77-df66eb3f42ca', {
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
    const { integration, integrationTarget, nativeTarget } =
      await openEphemeralSandboxIntegration();
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

    /** Starts a one-byte upload after a real HTTP continue response; observes only the client. */
    const uploading = (credential: string, path: string) => {
      let continued = false;
      const outcome = new Promise<'cut' | 'answered'>((resolve) => {
        const request = requestHttp(
          {
            headers: {
              authorization: `Bearer ${credential}`,
              'content-length': '100',
              'content-type': 'application/json',
              expect: '100-continue',
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
        request.once('continue', () => {
          request.write('{');
          continued = true;
        });
        request.flushHeaders();
      });
      return { continued: () => continued, outcome };
    };

    try {
      await integration.ready;
      expect(() =>
        integration.registerSessionLoopback('as_00000000-0000-7b98-96b8-96ffa0be3631', {
          capabilityCredential: 'short',
          inferenceCredential: 'x'.repeat(43),
        })
      ).toThrow();
      expect(() =>
        integration.registerSessionLoopback('as_00000000-0000-7b98-96b8-96ffa0be3631', {
          capabilityCredential: 'x'.repeat(43),
          inferenceCredential: 'x'.repeat(43),
        })
      ).toThrow();
      integration.registerSessionLoopback('as_00000000-0000-75c4-8f9b-15087ed5df6e', a);
      expect(() =>
        integration.registerSessionLoopback('as_00000000-0000-75c4-8f9b-15087ed5df6e', b)
      ).toThrow();
      expect(() =>
        integration.registerSessionLoopback('as_00000000-0000-731a-87e0-a001469aa2a0', {
          capabilityCredential: a.inferenceCredential,
          inferenceCredential: 'z'.repeat(43),
        })
      ).toThrow();
      integration.registerSessionLoopback('as_00000000-0000-7740-893b-01cca0bea5fd', b);

      // Idle supplies no authority; an unknown bearer is not a loopback credential.
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });
      expect(await native('q'.repeat(43), '/inference/v1/responses')).toMatchObject({
        status: 401,
      });
      expect(upstream).toEqual([]);

      integration.bindTurnRouteTokens('as_00000000-0000-75c4-8f9b-15087ed5df6e', tokens('turn-a'));
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
      integration.bindTurnRouteTokens('as_00000000-0000-7740-893b-01cca0bea5fd', tokens('turn-b'));
      expect(await native(b.inferenceCredential, '/inference/v1/responses')).toEqual({
        body: 'Bearer turn-b-inference-token',
        status: 200,
      });

      // A request that completes inside the drain bound is not cut.
      expect(await integration.drainTurn('as_00000000-0000-7740-893b-01cca0bea5fd')).toBe(0);
      expect(await native(b.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });
      integration.clearTurnRouteTokens('as_00000000-0000-7740-893b-01cca0bea5fd');

      // The short window exercises incomplete drain: held requests are cut at the barrier.
      const inflight = native(a.inferenceCredential, '/inference/v1/hold');
      await vi.waitFor(() => expect(held.size).toBe(1));
      const drainStarted = Date.now();
      const drain = integration.drainTurn('as_00000000-0000-75c4-8f9b-15087ed5df6e', 300);
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });
      expect(await drain).toBe(1);
      expect(Date.now() - drainStarted).toBeGreaterThanOrEqual(250);
      expect(await inflight).toBe('cut');
      await vi.waitFor(() => expect(held.size).toBe(0));
      integration.clearTurnRouteTokens('as_00000000-0000-75c4-8f9b-15087ed5df6e');
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 403,
      });

      // The short window exercises incomplete drain of an upload; none of it goes upstream.
      integration.bindTurnRouteTokens(
        'as_00000000-0000-75c4-8f9b-15087ed5df6e',
        tokens('turn-a-upload')
      );
      const upstreamBefore = upstream.length;
      const uploadingAtBarrier = uploading(a.inferenceCredential, '/inference/v1/responses');
      await vi.waitFor(() => expect(uploadingAtBarrier.continued()).toBe(true));
      expect(await integration.drainTurn('as_00000000-0000-75c4-8f9b-15087ed5df6e', 20)).toBe(1);
      expect(await uploadingAtBarrier.outcome).toBe('cut');
      integration.clearTurnRouteTokens('as_00000000-0000-75c4-8f9b-15087ed5df6e');

      // The production barrier bound is ten seconds.
      integration.bindTurnRouteTokens(
        'as_00000000-0000-75c4-8f9b-15087ed5df6e',
        tokens('turn-a-bound')
      );
      const uploadingAtDefault = uploading(a.inferenceCredential, '/inference/v1/responses');
      await vi.waitFor(() => expect(uploadingAtDefault.continued()).toBe(true));
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      let defaultCut: number | null = null;
      try {
        const drainAtDefault = integration
          .drainTurn('as_00000000-0000-75c4-8f9b-15087ed5df6e')
          .then((count) => {
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
      expect(await uploadingAtDefault.outcome).toBe('cut');
      integration.clearTurnRouteTokens('as_00000000-0000-75c4-8f9b-15087ed5df6e');

      // Destroying the credentials cuts a request still uploading its body.
      integration.bindTurnRouteTokens(
        'as_00000000-0000-75c4-8f9b-15087ed5df6e',
        tokens('turn-a-destroy')
      );
      const uploadingAtClose = uploading(a.capabilityCredential, '/capabilities/mcp/echo');
      await vi.waitFor(() => expect(uploadingAtClose.continued()).toBe(true));
      integration.destroySessionLoopback('as_00000000-0000-75c4-8f9b-15087ed5df6e');
      expect(await uploadingAtClose.outcome).toBe('cut');
      expect(upstream).toHaveLength(upstreamBefore);
      integration.registerSessionLoopback('as_00000000-0000-75c4-8f9b-15087ed5df6e', a);

      // Close destroys the credentials and cuts what is still in flight.
      integration.bindTurnRouteTokens('as_00000000-0000-75c4-8f9b-15087ed5df6e', tokens('turn-a2'));
      const beforeClose = native(a.capabilityCredential, '/capabilities/mcp/hold');
      await vi.waitFor(() => expect(held.size).toBe(1));
      integration.destroySessionLoopback('as_00000000-0000-75c4-8f9b-15087ed5df6e');
      expect(await beforeClose).toBe('cut');
      expect(await native(a.inferenceCredential, '/inference/v1/responses')).toMatchObject({
        status: 401,
      });
      expect(() =>
        integration.bindTurnRouteTokens(
          'as_00000000-0000-75c4-8f9b-15087ed5df6e',
          tokens('turn-a3')
        )
      ).toThrow();
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
