import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCanonicalEventRecord } from '@openkit/worker-protocol';
import { expect, it } from 'vitest';
import {
  emitRuntimeFact,
  ParentRuntimeCapture,
  RUNTIME_FRAME_MAX_BYTES,
  RuntimeJsonlReader,
  type RuntimeObservation,
  RuntimeSemanticCapture,
} from './runtime-capture.js';
import { WorkerTranscriptWriter } from './transcript.js';

it('keeps an admitted empty body as expected zero bytes with zero chunks', async () => {
  const records: RuntimeObservation[] = [];
  await emitRuntimeFact(
    {
      packageSnapshotId: 'aep_empty',
      captureCoverage: { scope: 'server', value: 'on' },
      credentialValues: [],
      emit: async (record, body) => {
        records.push(record);
        expect(body).toEqual(Buffer.alloc(0));
      },
    },
    { sourceRef: 'source', sourceSequence: 0 },
    {
      kind: 'assistant',
      runtimeOriginRef: null,
      phase: 'completed',
      messageRef: 'message',
      representation: 'snapshot',
    },
    { bytes: Buffer.alloc(0), mediaType: 'text/plain', boundary: 'runtime.assistant.text' }
  );
  expect(records[0]?.content).toMatchObject({ state: 'expected', bytes: 0, chunkCount: 0 });
});

it('reports the parser bound immediately without publishing a prefix as a complete frame', async () => {
  const frames: Array<{ bytes: Uint8Array | null; failure?: string }> = [];
  const reader = new RuntimeJsonlReader(async (bytes, _sequence, failure) => {
    frames.push({ bytes, ...(failure ? { failure } : {}) });
  });
  await reader.write(Buffer.alloc(RUNTIME_FRAME_MAX_BYTES + 1, 120));
  expect(frames).toEqual([{ bytes: null, failure: 'limit-exceeded' }]);
  await reader.write(Buffer.from('\n{"type":"next"}\n'));
  await reader.finish();
  expect(frames).toHaveLength(2);
  expect(Buffer.from(frames[1]!.bytes!).toString()).toBe('{"type":"next"}\n');
});

it('acknowledges metadata before exact content chunks without copying restricted bytes into events.jsonl', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'worker-observation-'));
  const accepted: WorkerCanonicalEventRecord[] = [];
  const body = Buffer.from(`  ${'💡 tool result\n'.repeat(9000)}  `);
  const writer = new WorkerTranscriptWriter({
    lineage: {
      workspaceId: 'ws_test',
      threadId: 'th_test',
      turnId: 'turn_test',
      agentSessionId: 'as_test',
      packageSnapshotId: 'aep_test',
    },
    sessionDir,
    appendEvent: async (record) => {
      if (record.event.type === 'observation.content.chunk') {
        expect(accepted[0]?.event.type).toBe('observation.recorded');
      }
      accepted.push(record);
    },
  });
  try {
    await writer.writeObservation(
      {
        observationId: 'obs_test',
        sourceRef: 'stream_0',
        sourceSequence: 0,
        observedAt: '2026-09-22T00:00:00.000Z',
        fact: {
          kind: 'assistant',
          runtimeOriginRef: `rto_${'a'.repeat(24)}`,
          messageRef: 'message_0',
          phase: 'completed',
          representation: 'snapshot',
        },
        content: {
          state: 'expected',
          mediaType: 'text/plain',
          boundary: 'runtime.assistant.text',
          bytes: body.length,
          sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
          chunkCount: Math.ceil(body.length / (48 * 1024)),
        },
      },
      body
    );
    const chunks = accepted.slice(1).map((record) => {
      const data = record.event.data as { data: string; byteOffset: number; chunkIndex: number };
      expect(data.byteOffset).toBe(data.chunkIndex * 48 * 1024);
      const decoded = Buffer.from(data.data, 'base64');
      expect(decoded.length).toBeLessThanOrEqual(48 * 1024);
      return decoded;
    });
    expect(Buffer.concat(chunks)).toEqual(body);
    expect(accepted.map((record) => record.sequence)).toEqual(accepted.map((_, index) => index));
    const local = await readFile(join(sessionDir, 'events.jsonl'), 'utf8');
    expect(local).toContain('observation.recorded');
    expect(local).not.toContain('observation.content.chunk');
    expect(local).not.toContain('tool result');
    expect(local.trim().split('\n')).toHaveLength(1);
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

/** Exercises the shared live parent collector with synthetic admitted assistant events. */
function streamingFixture(credentialValues: string[] = [], value: 'on' | 'off' = 'on') {
  const received: Array<{ record: RuntimeObservation; body?: Uint8Array }> = [];
  const capture = new ParentRuntimeCapture(
    {
      packageSnapshotId: 'aep_stream',
      captureCoverage: { scope: 'server', value },
      credentialValues,
      emit: async (record, body) => {
        received.push({ record, ...(body ? { body: Buffer.from(body) } : {}) });
      },
    },
    async (event, emit) => {
      for (const text of event.texts as string[])
        await emit(
          {
            kind: 'assistant',
            runtimeOriginRef: null,
            messageRef: 'message',
            phase: event.done ? 'completed' : 'updated',
            representation: event.done ? 'snapshot' : 'delta',
          },
          { bytes: Buffer.from(text), mediaType: 'text/plain', boundary: 'runtime.assistant.text' }
        );
    }
  );
  return {
    capture,
    received,
    write: (texts: string[], done = false) =>
      capture.writeStdout(Buffer.from(`${JSON.stringify({ texts, done })}\n`)),
  };
}

it('holds split credentials and sibling fields until the whole message can be rejected', async () => {
  for (const mode of ['deltas', 'siblings'] as const) {
    const f = streamingFixture(['known-secret-value']);
    if (mode === 'deltas') {
      await f.write(['known-']);
      expect(f.received.some(({ body }) => body)).toBe(false);
      expect(f.received.some(({ record }) => record.fact.kind === 'assistant')).toBe(true);
      await f.write(['secret-value']);
      await f.write(['known-secret-value'], true);
    } else await f.write(['known-', 'secret-value'], true);
    await f.capture.finalize();
    expect(f.received.some(({ body }) => body)).toBe(false);
    expect(
      f.received.some(
        ({ record }) =>
          record.content.state === 'unavailable' && record.content.reason === 'credential-excluded'
      )
    ).toBe(true);
  }
});

it('publishes exact original deltas and snapshot only after admission, with stable descriptors', async () => {
  const f = streamingFixture();
  const delta = '  💡\n';
  await f.write([delta]);
  expect(f.received.some(({ body }) => body)).toBe(false);
  const initial = f.received.find(({ record }) => record.fact.kind === 'assistant')!.record;
  await f.write([`${delta}done`], true);
  const published = f.received.filter(({ body }) => body);
  expect(published.map(({ body }) => Buffer.from(body!).toString())).toEqual([
    delta,
    `${delta}done`,
  ]);
  expect(published[0]!.record).toEqual(initial);
  await f.capture.finalize();
});

it('scans an interrupted prefix before publishing it and marks the interruption explicitly', async () => {
  const f = streamingFixture();
  await f.write(['unfinished 💡']);
  await f.capture.invalidate();
  expect(
    f.received.filter(({ body }) => body).map(({ body }) => Buffer.from(body!).toString())
  ).toEqual(['unfinished 💡']);
  expect(f.received.some(({ record }) => record.fact.phase === 'interrupted')).toBe(true);
  const rejected = streamingFixture(['known-secret-value']);
  await rejected.write(['known-']);
  await rejected.write(['secret-value']);
  await rejected.capture.invalidate();
  expect(rejected.received.some(({ body }) => body)).toBe(false);
  expect(
    rejected.received.some(
      ({ record, body }) =>
        record.fact.kind === 'assistant' &&
        record.fact.phase === 'interrupted' &&
        body === undefined
    )
  ).toBe(true);
});

it('keeps an interrupted outcome after early rejection drained the expected anchors', async () => {
  const f = streamingFixture(['known-secret-value']);
  await f.write(['safe prefix']);
  await f.write(['known-secret-value']);
  expect(
    f.received.some(
      ({ record }) =>
        record.content.state === 'unavailable' && record.content.expectedObservationId !== undefined
    )
  ).toBe(true);
  expect(f.received.some(({ body }) => body)).toBe(false);
  await f.capture.invalidate();
  expect(
    f.received.some(
      ({ record, body }) =>
        record.fact.kind === 'assistant' &&
        record.fact.phase === 'interrupted' &&
        body === undefined
    )
  ).toBe(true);
});

it('rejects decoded JSON credentials including escaped keys and sibling string values', async () => {
  for (const text of [
    '{"value":"known-\\u0073ecret-value"}',
    '{"a":"known-","b":"secret-value"}',
    '{"\\u0061pi_key":"value"}',
  ]) {
    const received: Array<{ record: RuntimeObservation; body?: Uint8Array }> = [];
    await emitRuntimeFact(
      {
        packageSnapshotId: 'aep_json',
        captureCoverage: { scope: 'server', value: 'on' },
        credentialValues: ['known-secret-value'],
        emit: async (record, body) => {
          received.push({ record, ...(body ? { body } : {}) });
        },
      },
      { sourceRef: 'source', sourceSequence: 0 },
      { kind: 'tool', runtimeOriginRef: null, callRef: 'call', phase: 'started' },
      {
        bytes: Buffer.from(text),
        mediaType: 'application/json',
        boundary: 'runtime.tool.arguments',
      }
    );
    expect(received[0]!.body).toBeUndefined();
    expect(received[0]!.record.content).toEqual({
      state: 'unavailable',
      reason: 'credential-excluded',
    });
  }
});

it('keeps capture off body-free and rejects a semantic unit over the existing ceiling', async () => {
  const off = streamingFixture([], 'off');
  await off.write(['first']);
  await off.write(['second'], true);
  await off.capture.finalize();
  expect(off.received.some(({ body }) => body)).toBe(false);
  expect(
    off.received
      .filter(({ record }) => record.fact.kind === 'assistant')
      .map(({ record }) => record.content.state)
  ).toEqual(['off', 'off']);
  const f = streamingFixture();
  await f.write(['x'.repeat(RUNTIME_FRAME_MAX_BYTES / 2)]);
  await f.write(['x'.repeat(RUNTIME_FRAME_MAX_BYTES / 2)]);
  await f.write(['overflow'], true);
  expect(f.received.some(({ body }) => body)).toBe(false);
  expect(f.received.some(({ record }) => record.fact.reason === 'limit-exceeded')).toBe(true);
  expect(
    f.received.some(
      ({ record }) =>
        record.content.state === 'unavailable' && record.content.reason === 'truncated'
    )
  ).toBe(true);
});

it('scans decoded tool result strings across partial events before any publication', async () => {
  const received: Array<{ record: RuntimeObservation; body?: Uint8Array }> = [];
  const capture = new RuntimeSemanticCapture({
    packageSnapshotId: 'aep_tool',
    captureCoverage: { scope: 'server', value: 'on' },
    credentialValues: ['known-secret-value'],
    emit: async (record, body) => {
      received.push({ record, ...(body ? { body } : {}) });
    },
  });
  for (const [index, text] of ['known-', 'secret-value'].entries()) {
    await capture.emit(
      'source',
      {
        kind: 'tool',
        runtimeOriginRef: null,
        callRef: 'call',
        phase: index ? 'completed' : 'updated',
      },
      {
        bytes: Buffer.from(JSON.stringify({ text })),
        mediaType: 'application/json',
        boundary: 'runtime.tool.result',
      }
    );
    await capture.flushCompleted();
  }
  expect(received.some(({ body }) => body)).toBe(false);
  expect(
    received.some(
      ({ record }) =>
        record.content.state === 'unavailable' && record.content.reason === 'credential-excluded'
    )
  ).toBe(true);
});

it('anchors every rejected tool observation to its exact expected boundary despite a shared call reference', async () => {
  const received: Array<{ record: RuntimeObservation; body?: Uint8Array }> = [];
  const capture = new RuntimeSemanticCapture({
    packageSnapshotId: 'aep_tool_anchor',
    captureCoverage: { scope: 'server', value: 'on' },
    credentialValues: ['known-secret-value'],
    emit: async (record, body) => {
      received.push({ record, ...(body ? { body } : {}) });
    },
  });
  for (const boundary of ['runtime.tool.arguments', 'runtime.tool.result'] as const) {
    for (const [index, text] of ['known-', 'secret-value'].entries()) {
      await capture.emit(
        'source',
        {
          kind: 'tool',
          runtimeOriginRef: null,
          callRef: 'same-call',
          phase: index ? 'completed' : 'updated',
        },
        {
          bytes: Buffer.from(JSON.stringify({ text })),
          mediaType: 'application/json',
          boundary,
        }
      );
    }
  }
  await capture.flushCompleted();
  expect(received.some(({ body }) => body)).toBe(false);
  const expected = received.filter(({ record }) => record.content.state === 'expected');
  expect(expected.map(({ record }) => record.content)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ boundary: 'runtime.tool.arguments' }),
      expect.objectContaining({ boundary: 'runtime.tool.result' }),
    ])
  );
  expect(expected).toHaveLength(4);
  const unavailable = received.filter(
    ({ record }) =>
      record.content.state === 'unavailable' && record.content.reason === 'credential-excluded'
  );
  expect(unavailable).toHaveLength(4);
  expect(
    unavailable
      .map(({ record }) =>
        record.content.state === 'unavailable'
          ? (record.content as { expectedObservationId?: string }).expectedObservationId
          : undefined
      )
      .sort()
  ).toEqual(expected.map(({ record }) => record.observationId).sort());
});

it('carries expected-only metadata through the real transcript writer before a unit completes', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'worker-held-observation-'));
  const accepted: WorkerCanonicalEventRecord[] = [];
  const writer = new WorkerTranscriptWriter({
    lineage: {
      workspaceId: 'ws_test',
      threadId: 'th_test',
      turnId: 'turn_test',
      agentSessionId: 'as_test',
      packageSnapshotId: 'aep_test',
    },
    sessionDir,
    appendEvent: async (record) => {
      accepted.push(record);
    },
  });
  const capture = new RuntimeSemanticCapture({
    packageSnapshotId: 'aep_test',
    captureCoverage: { scope: 'server', value: 'on' },
    credentialValues: [],
    emit: (record, body) => writer.writeObservation(record, body),
  });
  try {
    const fact = {
      kind: 'assistant' as const,
      runtimeOriginRef: null,
      messageRef: 'message',
      representation: 'delta' as const,
    };
    await capture.emit(
      'source',
      { ...fact, phase: 'updated' },
      {
        bytes: Buffer.from('original 💡'),
        mediaType: 'text/plain',
        boundary: 'runtime.assistant.text',
      }
    );
    await capture.flushCompleted();
    expect(accepted.map((record) => record.event.type)).toEqual(['observation.recorded']);
    await capture.emit('source', { ...fact, phase: 'completed' });
    await capture.flushCompleted();
    expect(accepted.map((record) => record.sequence)).toEqual([0, 1, 2, 3]);
    const chunk = accepted[3]!.event.data as { data: string };
    expect(Buffer.from(chunk.data, 'base64').toString()).toBe('original 💡');
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});
