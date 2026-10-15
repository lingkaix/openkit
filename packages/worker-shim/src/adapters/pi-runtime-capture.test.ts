import { Session } from 'node:inspector/promises';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { type RuntimeObservation, runtimeRef } from '../runtime-capture.js';
import { PiRuntimeCapture } from './pi-runtime-capture.js';

/** Explicit sink entry and release keep pressure independent of execution speed. */
async function stalledCapture(value: 'off' | 'on') {
  const accepted: RuntimeObservation[] = [];
  const bodies: string[] = [];
  const entered = Promise.withResolvers<void>();
  const prefixAccepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  let blocked = false;
  const capture = new PiRuntimeCapture(
    {
      captureCoverage: { scope: 'server', value },
      packageSnapshotId: 'backlog-package',
      credentialValues: ['fixture-secret-value'],
      emit: async (record, body) => {
        if (hold && !blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        accepted.push(record);
        if (body) bodies.push(Buffer.from(body).toString());
        if (record.fact.kind === 'assistant' && (value === 'off' || body)) prefixAccepted.resolve();
      },
    },
    'backlog-turn'
  );
  await capture.start();
  capture.observe(assistant('  admitted prefix \n'));
  await prefixAccepted.promise;
  hold = true;
  capture.observe(tool('blocker', 'entered'));
  await entered.promise;
  return { accepted, bodies, capture, release: () => release.resolve() };
}

/** Completed native tool arguments are independently admissible semantic units. */
function tool(id: string, text: string) {
  return { type: 'tool_execution_start', toolCallId: id, toolName: 'echo', args: { text } };
}

/** Assistant snapshots preserve whitespace and exclude the separate reasoning carrier. */
function assistant(text: string) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [
        { type: 'thinking', thinking: 'private-reasoning' },
        { type: 'text', text },
      ],
    },
  };
}

/** Keeps test-local strong references outside the GC observation's stack. */
function enqueueTracked(capture: PiRuntimeCapture): WeakRef<object>[] {
  const refs: WeakRef<object>[] = [];
  for (let index = 0; index < 128; index += 1) {
    const event = tool(`abandoned-${index}`, `later-${'x'.repeat(16 * 1024)}`);
    refs.push(new WeakRef(event));
    capture.observe(event);
  }
  return refs;
}

describe('Pi capture backlog', () => {
  it.each([
    'off',
    'on',
  ] as const)('bounds many small events behind a stalled sink with content %s', async (value) => {
    const fixture = await stalledCapture(value);
    const before = fixture.accepted.slice();
    const offered = 4_096;
    try {
      for (let index = 0; index < offered; index += 1)
        fixture.capture.observe(tool(`small-${index}`, `value-${index}`));
      expect(fixture.accepted).toEqual(before);
    } finally {
      fixture.release();
    }
    await fixture.capture.finalize('completed', null).catch(() => undefined);
    expect(fixture.accepted.slice(0, before.length)).toEqual(before);
    const tools = new Set(
      fixture.accepted
        .filter((record) => record.fact.kind === 'tool')
        .map((record) => record.fact.callRef)
    );
    expect(tools.size).toBeGreaterThan(1);
    expect(tools.size).toBeLessThan(offered);
    expect([...tools]).toEqual(
      ['blocker', ...Array.from({ length: tools.size - 1 }, (_, index) => `small-${index}`)].map(
        (id) => runtimeRef('rtc', 'backlog-package', `backlog-turn:${id}`)
      )
    );
    expect(fixture.accepted.map((record) => record.fact)).toContainEqual(
      expect.objectContaining({
        kind: 'coverage',
        family: 'primary-content',
        coverage: 'unavailable',
        reason: 'limit-exceeded',
      })
    );
    expect(fixture.bodies[0]).toBe(value === 'on' ? '  admitted prefix \n' : undefined);
    if (value === 'off') expect(fixture.bodies).toEqual([]);
    const serialized = JSON.stringify(fixture.accepted) + fixture.bodies.join('');
    expect(serialized).not.toContain('private-reasoning');
    expect(serialized).not.toContain('fixture-secret-value');
  });

  it('bounds aggregate bytes before individually valid events exhaust the count envelope', async () => {
    const fixture = await stalledCapture('on');
    const offered = 256;
    const payloadBytes = 128 * 1024;
    try {
      for (let index = 0; index < offered; index += 1)
        fixture.capture.observe(tool(`large-${index}`, `${index}:${'x'.repeat(payloadBytes)}`));
    } finally {
      fixture.release();
    }
    await fixture.capture.finalize('completed', null).catch(() => undefined);
    const acceptedBytes = fixture.bodies.reduce(
      (total, body) => total + Buffer.byteLength(body),
      0
    );
    expect(acceptedBytes).toBeGreaterThan(payloadBytes);
    expect(acceptedBytes).toBeLessThan(offered * payloadBytes);
    expect(fixture.accepted.map((record) => record.fact)).toContainEqual(
      expect.objectContaining({ coverage: 'unavailable', reason: 'limit-exceeded' })
    );
    expect(fixture.bodies[0]).toBe('  admitted prefix \n');
  });

  it.each([
    'off',
    'on',
  ] as const)('abandons queued native envelopes before an entered sink returns with content %s', async (value) => {
    const fixture = await stalledCapture(value);
    const before = fixture.accepted.slice();
    const refs = enqueueTracked(fixture.capture);
    fixture.capture.abandon();
    fixture.capture.observe(assistant('must not be published'));
    const inspector = new Session();
    inspector.connect();
    try {
      // Return to the event loop before forced GC: WeakRef targets live through their current job.
      await setImmediate();
      await inspector.post('HeapProfiler.collectGarbage');
      expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
      expect(fixture.accepted).toEqual(before);
    } finally {
      inspector.disconnect();
      fixture.release();
    }
    await fixture.capture.finalize('completed', null);
    expect(fixture.accepted.slice(0, before.length)).toEqual(before);
    // The one sink effect already entered may finish; abandonment cannot recall it.
    expect(fixture.accepted.slice(before.length)).toHaveLength(1);
    expect(fixture.bodies.join('')).not.toContain('must not be published');
  });
});
