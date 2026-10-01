import { describe, expect, it, vi } from 'vitest';
import { planLogicalModel, prepareGatewayStream } from './gateway-execution.js';
import type { ResolvedLogicalModel } from './logical-models.js';

/** Two authored members; availability and routing are varied independently. */
const tier: ResolvedLogicalModel = {
  id: 'tier',
  displayName: 'Tier',
  capabilities: [],
  modelFamilyId: null,
  autoFailover: true,
  contextManagement: { type: 'compaction', compactThreshold: 8000 },
  routes: ['primary', 'backup'].map((id) => ({
    id,
    providerProfileId: id,
    providerModel: 'model',
    available: true,
    unavailableReason: null,
  })),
};

describe('request-local Gateway planning and commit', () => {
  it('keeps a disabled backup dormant and reports capability exclusions without an attempt', () => {
    const eligible = vi.fn((route) => route.id !== 'primary');
    expect(
      planLogicalModel({ ...tier, autoFailover: false }, ['reasoning'], eligible).map(
        ({ selected, reason }) => ({ selected, reason })
      )
    ).toEqual([
      { selected: false, reason: 'pinned_capability_unavailable' },
      { selected: false, reason: 'failover_disabled' },
    ]);
    expect(eligible).toHaveBeenCalledTimes(1);
  });

  it('does not release lifecycle bytes before a failed attempt', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    });
    upstream.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
    const failure = Object.assign(new Error('private failure'), {
      failure: { kind: 'rate_limited' },
    });
    const prepared = prepareGatewayStream(stream, new AbortController().signal, Date.now() + 60000);
    let released = false;
    void prepared.then(
      () => {
        released = true;
      },
      () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    upstream.error(failure);
    await expect(prepared).rejects.toBe(failure);
  });
});

import {
  executeGatewayPlan,
  GATEWAY_PRECOMMIT_BUFFER_BYTES,
  GATEWAY_PRECOMMIT_DEADLINE_MS,
  type GatewayClock,
} from './gateway-execution.js';
import type { PiAiFailure } from './pi-ai-failure.js';

/** Explicit clock injection records real executor timer decisions without real waits. */
function clockFixture() {
  const delays: number[] = [];
  const clock: GatewayClock = {
    now: () => Date.now(),
    setTimer(callback, delay) {
      delays.push(delay);
      return setTimeout(callback, delay);
    },
    clearTimer: (timer) => clearTimeout(timer),
  };
  return { clock, delays };
}
const selections = planLogicalModel(tier, [], () => true);
/** Boundary evidence, deliberately unrelated to the private diagnostic text. */
function failed(failure: PiAiFailure) {
  return Object.assign(new Error('private marker'), { failure });
}

async function timers<T>(operation: () => Promise<T>): Promise<T> {
  const pending = operation().then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  await vi.runAllTimersAsync();
  const outcome = await pending;
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

describe('Gateway executor deadline, replay certainty and retry waits', () => {
  it('performs precisely three exponential retries before backup and resets primary on the next request', async () => {
    vi.useFakeTimers();
    try {
      const { clock, delays } = clockFixture();
      const calls: [string, number, number][] = [];
      let recovered = false;
      const run = () =>
        executeGatewayPlan({
          selections,
          autoFailover: true,
          signal: new AbortController().signal,
          clock,
          attempt: async ({ route }, context) => {
            calls.push([route.id, context.retryIndex, context.attemptOrder]);
            if (route.id === 'primary' && !recovered)
              throw failed({ kind: 'provider_unavailable', settled: true });
            return route.id;
          },
        });
      expect(await timers(run)).toBe('backup');
      expect(calls).toEqual([
        ['primary', 0, 0],
        ['primary', 1, 1],
        ['primary', 2, 2],
        ['primary', 3, 3],
        ['backup', 0, 4],
      ]);
      expect(delays).toEqual([GATEWAY_PRECOMMIT_DEADLINE_MS, 1000, 2000, 4000]);
      recovered = true;
      expect(await timers(run)).toBe('primary');
      expect(calls.at(-1)).toEqual(['primary', 0, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['2', true],
    ['11', false],
  ])('honors complete short Retry-After %s, never shortens a long one', async (retryAfter, retry) => {
    vi.useFakeTimers();
    try {
      const { clock, delays } = clockFixture();
      let count = 0;
      const result = await timers(() =>
        executeGatewayPlan({
          selections,
          autoFailover: true,
          signal: new AbortController().signal,
          clock,
          attempt: async ({ route }) => {
            if (route.id === 'primary' && count++ === 0)
              throw failed({ kind: 'rate_limited', settled: true, retryAfter });
            return route.id;
          },
        })
      );
      expect(result).toBe(retry ? 'primary' : 'backup');
      expect(delays.slice(1)).toEqual(retry ? [2000] : []);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry or fail over an uncertain transport loss, preserving its kind', async () => {
    const attempt = vi.fn(async () => {
      throw failed({ kind: 'provider_unavailable', settled: false });
    });
    await expect(
      executeGatewayPlan({
        selections,
        autoFailover: true,
        signal: new AbortController().signal,
        attempt,
      })
    ).rejects.toMatchObject({ failure: { kind: 'provider_unavailable', settled: false } });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('records the terminating kind on exhaustion and no cause on empty selection', async () => {
    const outcome = executeGatewayPlan({
      selections,
      autoFailover: true,
      signal: new AbortController().signal,
      attempt: async ({ route }) => {
        throw failed({
          kind: route.id === 'primary' ? 'auth_rejected' : 'quota_exhausted',
          settled: true,
        });
      },
    });
    await expect(outcome).rejects.toMatchObject({
      code: 'gateway_logical_model_unavailable',
      cause: 'quota_exhausted',
    });
    await expect(
      executeGatewayPlan({
        selections: [],
        autoFailover: true,
        signal: new AbortController().signal,
        attempt: vi.fn(),
      })
    ).rejects.toMatchObject({ code: 'gateway_logical_model_unavailable' });
    try {
      await executeGatewayPlan({
        selections: [],
        autoFailover: true,
        signal: new AbortController().signal,
        attempt: vi.fn(),
      });
    } catch (error) {
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('does not cancel a live attempt at deadline, and cannot replay its later failure', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { clock } = clockFixture();
      let reject!: (error: unknown) => void;
      const attempt = vi.fn(
        async () =>
          new Promise((_, fail) => {
            reject = fail;
          })
      );
      const pending = executeGatewayPlan({
        selections,
        autoFailover: true,
        signal: controller.signal,
        clock,
        attempt,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(GATEWAY_PRECOMMIT_DEADLINE_MS);
      expect(controller.signal.aborted).toBe(false);
      reject(failed({ kind: 'provider_unavailable', settled: true }));
      expect(await pending).toMatchObject({ failure: { kind: 'provider_unavailable' } });
      expect(attempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a retry wait on cancellation', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { clock } = clockFixture();
      const attempt = vi.fn(async () => {
        throw failed({ kind: 'rate_limited', settled: true });
      });
      const pending = executeGatewayPlan({
        selections,
        autoFailover: true,
        signal: controller.signal,
        clock,
        attempt,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(500);
      controller.abort(new DOMException('stop', 'AbortError'));
      expect(await pending).toMatchObject({ failure: { kind: 'cancelled' } });
      expect(attempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repeat an already committed attempt', async () => {
    const attempt = vi.fn(async (_, context) => {
      context.commit();
      throw failed({ kind: 'rate_limited', settled: true });
    });
    await expect(
      executeGatewayPlan({
        selections,
        autoFailover: true,
        signal: new AbortController().signal,
        attempt,
      })
    ).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('Gateway private stream preparation', () => {
  it.each([
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.reasoning_text.delta', delta: 'thinking' },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'status', id: 'call' },
    },
    { choices: [{ delta: { content: 'hello' } }] },
    { choices: [{ delta: { reasoning_content: 'thinking' } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'call', function: { name: 'status' } }] } }] },
  ])('commits on admitted text, reasoning and tool output: %j', async (output) => {
    const lifecycle = 'data: {"type":"response.created"}\n\n';
    const bytes = `${lifecycle}data: ${JSON.stringify(output)}\n\ndata: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(bytes));
        c.close();
      },
    });
    const ready = await prepareGatewayStream(
      stream,
      new AbortController().signal,
      Date.now() + 120000
    );
    expect(await new Response(ready).text()).toBe(bytes);
  });

  it('commits a live stream on the byte cap and does not reclassify its later failure', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const bytes = new TextEncoder().encode(`: ${'x'.repeat(GATEWAY_PRECOMMIT_BUFFER_BYTES)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        upstream = c;
        c.enqueue(bytes);
      },
    });
    const ready = await prepareGatewayStream(
      stream,
      new AbortController().signal,
      Date.now() + 120000
    );
    const reader = ready.getReader();
    expect((await reader.read()).value).toEqual(bytes);
    const failure = failed({ kind: 'rate_limited', settled: true });
    upstream.error(failure);
    await expect(reader.read()).rejects.toBe(failure);
  });

  it('never flushes a complete held failure even when the byte cap is reached', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: {"type":"response.failed","error":{"message":"${'x'.repeat(GATEWAY_PRECOMMIT_BUFFER_BYTES)}"}}\n\n`
          )
        );
      },
    });
    await expect(
      prepareGatewayStream(stream, new AbortController().signal, Date.now() + 120000)
    ).rejects.toMatchObject({ failure: { kind: 'unknown' } });
  });

  it('commits at deadline without cutting the live stream or flushing a known failure as success', async () => {
    vi.useFakeTimers();
    try {
      const { clock } = clockFixture();
      let upstream!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          upstream = c;
          c.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
        },
      });
      const pending = prepareGatewayStream(
        stream,
        new AbortController().signal,
        Date.now() + GATEWAY_PRECOMMIT_DEADLINE_MS,
        clock
      );
      await vi.advanceTimersByTimeAsync(GATEWAY_PRECOMMIT_DEADLINE_MS);
      const ready = await pending;
      const reader = ready.getReader();
      expect((await reader.read()).done).toBe(false);
      upstream.enqueue(
        new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"late"}\n\n')
      );
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('late');
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Gateway absolute deadline and cancellation edges', () => {
  it('stops retry and failover when a settled attempt fails at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { clock, delays } = clockFixture();
      const attempt = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, GATEWAY_PRECOMMIT_DEADLINE_MS));
        throw failed({ kind: 'rate_limited', settled: true });
      });
      await expect(
        timers(() =>
          executeGatewayPlan({
            selections,
            autoFailover: true,
            signal: new AbortController().signal,
            clock,
            attempt,
          })
        )
      ).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([GATEWAY_PRECOMMIT_DEADLINE_MS]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never waits a Retry-After beyond the remaining deadline, but may advance before expiry', async () => {
    vi.useFakeTimers();
    try {
      const { clock, delays } = clockFixture();
      const calls: string[] = [];
      const pending = executeGatewayPlan({
        selections,
        autoFailover: true,
        signal: new AbortController().signal,
        clock,
        attempt: async ({ route }) => {
          calls.push(route.id);
          if (route.id === 'primary') {
            await new Promise((resolve) =>
              setTimeout(resolve, GATEWAY_PRECOMMIT_DEADLINE_MS - 500)
            );
            throw failed({ kind: 'rate_limited', settled: true, retryAfter: '2' });
          }
          return 'backup';
        },
      });
      expect(await timers(() => pending)).toBe('backup');
      expect(calls).toEqual(['primary', 'backup']);
      expect(delays).toEqual([GATEWAY_PRECOMMIT_DEADLINE_MS]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a short HTTP-date Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    try {
      const { clock, delays } = clockFixture();
      let calls = 0;
      await timers(() =>
        executeGatewayPlan({
          selections,
          autoFailover: false,
          signal: new AbortController().signal,
          clock,
          attempt: async () => {
            if (calls++ === 0)
              throw failed({
                kind: 'rate_limited',
                settled: true,
                retryAfter: 'Thu, 01 Oct 2026 00:00:03 GMT',
              });
            return 'primary';
          },
        })
      );
      expect(calls).toBe(2);
      expect(delays.slice(1)).toEqual([3000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates caller cancellation to the active adapter without replay', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(
      async (_, context) =>
        new Promise<never>((_, reject) =>
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          })
        )
    );
    const pending = executeGatewayPlan({
      selections,
      autoFailover: true,
      signal: controller.signal,
      attempt,
    });
    controller.abort(new DOMException('private cancellation', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ failure: { kind: 'cancelled' } });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('keeps empty text/reasoning items and role chunks private, then fails privately', async () => {
    const lifecycle = [
      { type: 'response.created' },
      { type: 'response.reasoning_text.delta', delta: '' },
      { type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } },
      { choices: [{ delta: { role: 'assistant' } }] },
    ];
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        upstream = c;
        for (const event of lifecycle)
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    });
    const pending = prepareGatewayStream(stream, new AbortController().signal, Date.now() + 120000);
    let released = false;
    void pending.then(
      () => {
        released = true;
      },
      () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    const error = failed({ kind: 'quota_exhausted', settled: true });
    upstream.error(error);
    await expect(pending).rejects.toBe(error);
  });

  it('does not turn a premature lifecycle-only EOF into success', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
        c.close();
      },
    });
    await expect(
      prepareGatewayStream(stream, new AbortController().signal, Date.now() + 120000)
    ).rejects.toMatchObject({ failure: { kind: 'unknown', settled: false } });
  });
});

describe('settled failure preserves its authority after caller disconnect', () => {
  it('returns the independently settled Provider kind and starts no replay after a late abort', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort(new DOMException('late disconnect', 'AbortError'));
      throw failed({ kind: 'quota_exhausted', settled: true });
    });
    await expect(
      executeGatewayPlan({ selections, autoFailover: true, signal: controller.signal, attempt })
    ).rejects.toMatchObject({ failure: { kind: 'quota_exhausted' } });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
