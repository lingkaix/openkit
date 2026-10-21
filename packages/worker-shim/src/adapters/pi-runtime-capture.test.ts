import { appendFile, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { WorkerObservationDataEmissionSchema } from '@openkit/worker-protocol';
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

// RET Capture Coverage: source faults are named gaps; observed prefixes and independent safe sources survive.
it('RET E REVIEW R2 keeps a read Pi file prefix and names its later disappearance without crashing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-e-review-'));
  const path = join(directory, 'session.jsonl');
  const prefix = Buffer.from('{"native":"accepted-prefix"}\n');
  const fileRead = Promise.withResolvers<void>();
  const packageSnapshotId = 'e-review-pi-package';
  const turnId = 'e-review-file-turn';
  const sourceRef = runtimeRef('rts', packageSnapshotId, `pi-channel:${turnId}`);
  const barrierRef = runtimeRef('rtc', packageSnapshotId, `${turnId}:file-read-barrier`);
  const received: Array<{ record: RuntimeObservation; body?: Buffer }> = [];
  const capture = new PiRuntimeCapture(
    {
      packageSnapshotId,
      captureCoverage: { scope: 'task', value: 'on' },
      nativeLogMaxBytes: 16 * 1024 * 1024,
      authoredVersion: '1.0.2',
      credentialValues: ['ret-e-synthetic-credential'],
      emit: async (record, body) => {
        received.push({
          record: WorkerObservationDataEmissionSchema.parse(record),
          ...(body ? { body: Buffer.from(body) } : {}),
        });
        if (record.fact.callRef === barrierRef && body) fileRead.resolve();
      },
    },
    turnId
  );
  try {
    await writeFile(path, '');
    await capture.bindFile(path);
    await capture.start();
    await appendFile(path, prefix);
    // The existing tool emit follows pollFile, so it joins the read without a timer or private state.
    capture.observe(tool('file-read-barrier', 'ordinary tool output'));
    await fileRead.promise;
    await unlink(path);
    const failure = await capture.finalize('completed', null).then(
      () => null,
      (error: unknown) => error
    );
    expect.soft(failure).toBeNull();
    const native = received.filter(
      ({ record, body }) => record.fact.native?.format === 'pi-session-jsonl' && body
    );
    expect.soft(Buffer.concat(native.map(({ body }) => body!))).toEqual(prefix);
    expect.soft(native.every(({ record }) => record.fact.native?.sourceEnded === false)).toBe(true);
    expect
      .soft(
        received.some(
          ({ record }) =>
            (record.sourceRef === `${sourceRef}:file` || record.sourceRef === sourceRef) &&
            record.fact.coverage === 'unavailable' &&
            (record.fact.reason === 'source-missing' || record.fact.reason === 'collector-failed')
        )
      )
      .toBe(true);
    expect
      .soft(
        Buffer.concat(
          received.flatMap(({ record, body }) =>
            record.fact.native?.format === 'pi-sdk-event-json' && body ? [body] : []
          )
        )
      )
      .toEqual(Buffer.from(JSON.stringify(tool('file-read-barrier', 'ordinary tool output'))));
  } finally {
    capture.abandon();
    await rm(directory, { recursive: true, force: true });
  }
});

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

// RET Native Transcripts And Runtime Logs / Capture Safety: native events precede outward selection.
it.each([
  'completed',
  'interrupted',
  'failed',
] as const)('RET E7 retains ordered native SDK units and truthful omissions after %s', async (status) => {
  const received: Array<{ record: RuntimeObservation; body?: Buffer }> = [];
  const capture = new PiRuntimeCapture(
    {
      packageSnapshotId: 'e7-package',
      captureCoverage: { scope: 'task', value: 'on' },
      credentialValues: ['e7-known-secret'],
      ...{ nativeLogMaxBytes: 1, authoredVersion: '1.0.2' },
      emit: async (record, body) => {
        received.push({ record, ...(body ? { body: Buffer.from(body) } : {}) });
      },
    },
    'e7-turn'
  );
  const events = [
    {
      type: 'message_update',
      message: { role: 'assistant', opaque: { keep: null } },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' α ' },
    },
    {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"unfinished":' },
    },
    { type: 'future_native_event', opaque: ['keep order', 7, null] },
  ];
  await capture.start();
  for (const event of events) capture.observe(event);
  capture.omitted();
  await capture.finalize(status, null);
  const native = received.filter(
    ({ record, body }) => record.fact.kind === 'native-transcript' && body
  );
  // Compare the original SDK units as bytes before interpreting any retained JSON.
  expect(native.map(({ body }) => body)).toEqual(
    events.map((event) => Buffer.from(JSON.stringify(event)))
  );
  expect(
    native.every(
      ({ record }) =>
        record.content.state === 'expected' && record.content.boundary === 'native-content-v1'
    )
  ).toBe(true);
  expect(
    received.some(
      ({ record }) =>
        record.fact.coverage === 'unavailable' && record.fact.reason === 'limit-exceeded'
    )
  ).toBe(true);
  expect(
    received.some(({ record }) => record.fact.kind === 'origin' && record.fact.phase === status)
  ).toBe(true);
  expect(native.every(({ record }) => record.fact.native?.measuredVersion === null)).toBe(true);
});
